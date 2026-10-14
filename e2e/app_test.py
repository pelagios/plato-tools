"""Browser tests of the page itself, in Playwright's bundled Chromium with an on-disk profile.

    python3 e2e/app_test.py                 run every check against the built site
    python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   the deployed site
    python3 e2e/app_test.py --prove-it-fails run every check against a page with no tools on it;
                                            every check must fail, or the harness cannot fail
    --no-gl-flags   start Chora's browser without the software-GL switches, to measure whether the map
                    still draws without them (it did on this machine, Chromium 147, September 2026)
"""
import csv, json, os, pathlib, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request, zipfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLATO = pathlib.Path(os.environ.get('PLATO_REPO', ROOT.parent / 'place-attestation-ontology'))
# The checks read PLATO's examples from PLATO_REPO. A checkout ahead of (or behind) the pin fails
# checks for reasons that have nothing to do with the tools, or passes them for the wrong ones, so the
# run stops unless PLATO_REPO holds the pinned commit's files (see test/paths.js, which does the same).
def plato_at_pin():
    pin = json.loads((ROOT / 'package.json').read_text())['plato']['commit']
    if os.environ.get('PLATO_REPO_ANY'): return
    if (PLATO / '.git').exists():
        git = lambda *a: subprocess.run(['git', '-C', str(PLATO), *a], capture_output=True, text=True)
        if git('cat-file', '-e', pin + '^{commit}').returncode:
            sys.exit(f'PLATO_REPO ({PLATO}) does not have the pinned commit {pin[:7]}: fetch it, or set PLATO_REPO to a checkout of it')
        if git('diff', '--quiet', pin, '--', 'ontology.ttl', 'schemas', 'examples').returncode:
            head = git('rev-parse', '--short', 'HEAD').stdout.strip()
            sys.exit(f'PLATO_REPO ({PLATO}) is at {head}, whose schemas or examples differ from the pinned {pin[:7]}: '
                     f'set PLATO_REPO to a checkout of {pin[:7]} (or PLATO_REPO_ANY=1 to run anyway)')
        return
    vend = ROOT / 'public' / 'plato'
    for f in ('ontology.ttl', 'schemas/plato.schema.json', 'schemas/place-centric.schema.json',
              'schemas/attestation-centric.schema.json', 'schemas/plato.context.jsonld', 'schemas/tables/csv-metadata.json'):
        mine = vend / pathlib.Path(f).name
        if mine.exists() and (PLATO / f).read_bytes() != mine.read_bytes():
            sys.exit(f'PLATO_REPO ({PLATO}) has a {f} that differs from the vendored pinned copy {pin[:7]}: '
                     f'set PLATO_REPO to a checkout of {pin[:7]} (or PLATO_REPO_ANY=1 to run anyway)')
PROVE = '--prove-it-fails' in sys.argv
# --prove-it-fails, fast. Against the page with no tools (NOTOOLS, below: a data: URL with a title and a
# file input, and no script) every check must fail, and until October 2026 each did so by waiting out
# its timeouts in full, one after another: 60 s for a detection that could never come, 30 s for a
# button that was not there, over 300 checks, some 85 minutes. Nothing on that page can change while
# the harness waits, as it runs no script: what a wait asks of it is true at once or never. So, on that
# page and only there, every wait ends after FAST seconds: wait_state() here, and every Playwright call
# that takes a timeout (a wait for a function or a selector, an action on an element, an expected
# download), given or the default. A wait whose condition holds still ends at once, as it always did,
# and what each check then asserts is unchanged: only the waiting for what cannot come is cut short.
# The waits are as long as ever on any page other than the one with no tools (about:blank, a framing
# page, the real page a few checks open in this mode), and on that page once the harness may have put
# something into it that changes later: a script tag or new content (add_script_tag, set_content), an
# evaluate() whose script could act after it returns (ASYNC below: a timer, a promise, an async
# function), until the next navigation; and an init script that could (ASYNC again), for good, as it
# runs again on every navigation (on the context, for every page in it). Navigations and fixed pauses
# are never shortened. The limit, stated: ASYNC is a reading of the script's text, not of what it
# does. A script that changes the page later by a means it does not name (an event listener the page
# itself never fires, being script-free, is harmless; a MutationObserver fires only on a change, which
# only the harness makes) would still be cut short at FAST, and a check that passes only after such a
# change, more than FAST later, would be missed here and caught by PROVE_FULL_WAITS=1, which waits in
# full everywhere, as before. At the end of the run, no wait cut short at all fails the run: the
# shortener's own control, so that a change that made it inert (and the run slow) is not missed.
FAST = 1.0
SHORTENED = [0]                 # how many waits ended early, said at the end of the run
UNSHORTENED = {'goto', 'go_back', 'go_forward', 'reload', 'set_content', 'wait_for_load_state', 'wait_for_url', 'wait_for_timeout',
               'expect_navigation', 'expect_popup', 'expect_websocket', 'expect_worker', 'set_default_timeout',
               'set_default_navigation_timeout', 'screenshot', 'aria_snapshot'}
ASYNC = re.compile(r'setTimeout|setInterval|requestAnimationFrame|\bPromise\b|\basync\b|\.then\(')
def toolless(target):
    """Whether `target` (a page, a frame or a locator) shows the page with no tools as it was loaded, nothing put
    in it that could change it later."""
    if not PROVE or os.environ.get('PROVE_FULL_WAITS'): return False
    try:
        if hasattr(target, 'main_frame'): page, url = target, target.url          # a page
        elif hasattr(target, 'parent_frame'): page, url = target.page, target.url  # a frame: its own document
        else: page = target.page; url = page.url                                   # a locator: its page's
        return (url == NOTOOLS and not getattr(page, '_prove_scripted', False) and not getattr(page, '_prove_init_scripted', False)
                and not getattr(page.context, '_prove_init_scripted', False))
    except Exception: return False

def prove_fast():
    import functools, inspect
    from playwright.sync_api import Page, Frame, Locator, BrowserContext
    owner = lambda self: self if hasattr(self, 'main_frame') else self.page      # the page of a page, frame or locator
    def shorten(fn):
        @functools.wraps(fn)
        def wrapped(self, *a, **kw):
            if toolless(self) and (not kw.get('timeout') or kw['timeout'] > FAST * 1000):
                kw['timeout'] = FAST * 1000; SHORTENED[0] += 1
            return fn(self, *a, **kw)
        return wrapped
    def scripted(fn, flag):
        @functools.wraps(fn)
        def wrapped(self, *a, **kw):
            owner(self)._prove_scripted = flag
            return fn(self, *a, **kw)
        return wrapped
    def evaluated(fn):                      # an evaluate() whose script could act after it returns
        @functools.wraps(fn)
        def wrapped(self, *a, **kw):
            js = a[0] if a else kw.get('expression', '')
            if isinstance(js, str) and ASYNC.search(js): owner(self)._prove_scripted = True
            return fn(self, *a, **kw)
        return wrapped
    def init_scripted(fn):                  # an init script that could: for good, as it runs on every navigation
        @functools.wraps(fn)
        def wrapped(self, *a, **kw):
            js = a[0] if a else kw.get('script')
            if js is None or not isinstance(js, str) or ASYNC.search(js): self._prove_init_scripted = True
            return fn(self, *a, **kw)
        return wrapped
    for C in (Page, Frame, Locator):
        for name, fn in list(vars(C).items()):
            if name.startswith('_') or name in UNSHORTENED or not callable(fn): continue
            if 'timeout' in inspect.signature(fn).parameters: setattr(C, name, shorten(fn))
        for name in ('evaluate', 'evaluate_handle'): setattr(C, name, evaluated(getattr(C, name)))
    for C in (Page, Frame):
        for name in ('add_script_tag', 'set_content'): setattr(C, name, scripted(getattr(C, name), True))
    for name in ('goto', 'reload'): setattr(Page, name, scripted(getattr(Page, name), False))   # a fresh document
    for C in (Page, BrowserContext): C.add_init_script = init_scripted(C.add_init_script)
if PROVE: prove_fast()
# The preview server runs under npx, whose child (node vite preview) outlived a plain kill() and
# held the port for the next run: it gets a session of its own, and the whole group is stopped.
def stop(srv):
    if srv.args == ['true']: return                # the deployed site: no server was started
    try: os.killpg(srv.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    srv.wait(timeout=10)

# Another session's preview server on this port would be tested instead of this build, and pass:
# E2E_PORT chooses another, and a port in use stops the run (main()).
PORT = int(os.environ.get('E2E_PORT', '4174'))
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{('  -- ' + str(detail)[:300]) if detail and not cond else ''}", flush=True)

def wait_state(page, pred, timeout=120, what=''):
    """Poll the page's own state; on timeout return it, with the page's account of why."""
    t0 = time.time(); last = None
    if toolless(page) and timeout > FAST: timeout = FAST; SHORTENED[0] += 1    # the page with no tools: nothing can come
    while time.time() - t0 < timeout:
        try: last = page.evaluate('() => window.__plato ? JSON.parse(JSON.stringify(window.__plato)) : null')
        except Exception as e: last = {'phase': 'page-error', 'error': str(e)[:200]}
        if last and pred(last): return last
        time.sleep(0.25)
    return {**(last or {}), 'timedOut': what, 'summary': page.evaluate("() => document.getElementById('summary')?.textContent || document.title")}

def run_case(page, files, action, target=None, timeout=300):
    try:
        return _run_case(page, files, action, target, timeout)
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def _run_case(page, files, action, target=None, timeout=300):
    page.set_input_files('#picker', [str(f) for f in files])
    s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
    if s.get('phase') != 'detected': return s
    if action == 'convert': page.select_option('#target', target)
    page.click('#check' if action == 'check' else '#convert')
    return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), timeout, 'run')

def compare_case(page, later, earlier, timeout=120):
    """Choose the later version, then give the earlier one to the version check."""
    try:
        page.set_input_files('#picker', [str(later)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return s
        page.set_input_files('#earlier', [str(earlier)])
        return wait_state(page, lambda s: s.get('action') == 'compare' and s.get('phase') in ('done', 'error'), timeout, 'comparison')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def candidates_case(page, main, sets, timeout=120):
    """Choose a file, then give candidate sets to Check with candidate sets (Elenchos)."""
    try:
        page.set_input_files('#picker', [])   # the same file again: emptied first, or the page would not look at it
        page.set_input_files('#picker', [str(main)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return s
        page.set_input_files('#candidate-sets', [str(f) for f in sets])
        return wait_state(page, lambda s: s.get('action') == 'check' and s.get('phase') in ('done', 'error'), timeout, 'check with candidate sets')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

# Agora's text fields in Options, all set on every run (to '' when not given), so that no run
# inherits what an earlier one typed.
PUBLISH_FIELDS = ('release', 'repo', 'site-url', 'maintainers', 'concept-doi')

def publish_case(page, files, part, fields=None, previous=None, only=None, timeout=300):
    """Choose the dataset, fill in the Options for publishing, choose the part and press Prepare."""
    try:
        # The same files chosen twice running are no change, and the page would not look at them
        # again: the choice is emptied first (which the page ignores), so every run is a fresh one.
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(f) for f in files])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return s
        page.evaluate("() => { document.getElementById('options').open = true; }")
        for f in PUBLISH_FIELDS: page.fill('#' + f, (fields or {}).get(f, ''))
        page.set_input_files('#previous', [str(p) for p in (previous or [])])
        page.set_input_files('#only', [str(only)] if only else [])
        page.select_option('#part', part)
        page.click('#publish')
        return wait_state(page, lambda s: s.get('action') == 'publish' and s.get('phase') in ('done', 'error'), timeout, 'publishing')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def saved_zip(page, s, tmp, suffix):
    """Save the output whose name ends in `suffix` as the page would, and open it as a zip."""
    o = next((o for o in (s.get('outputs') or []) if o['name'].endswith(suffix)), None)
    return zipfile.ZipFile(download(page, o['name'], tmp / o['name'])) if o else None

def tables_copy(dest, **about):
    """PLATO's customs tables, copied into `dest` with the about sheet's columns changed as given."""
    dest.mkdir(parents=True, exist_ok=True)
    for f in (PLATO / 'schemas/tables/examples/customs').glob('*.csv'): shutil.copy(f, dest / f.name)
    with open(dest / 'about.csv', newline='', encoding='utf-8') as fh: rows = list(csv.reader(fh))
    for k, v in about.items(): rows[1][rows[0].index(k)] = v
    with open(dest / 'about.csv', 'w', newline='', encoding='utf-8') as fh: csv.writer(fh).writerows(rows)
    return sorted(dest.glob('*.csv'))

def table_case(page, file, choices=None, action=None, target=None, timeout=120):
    """Hermes: choose a table of places (CSV or plain GeoJSON), wait for the matching of its columns,
    make `choices` ({column: field}) through each column's labelled dropdown, then run `action`."""
    try:
        page.set_input_files('#picker', [str(file)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised') and (s.get('phase') == 'unrecognised' or s.get('columns')), 60, 'columns')
        if not s.get('columns') or not s['columns'].get('mapping'): return s
        for col, field in (choices or {}).items():
            page.get_by_label(f'Read the column \u201c{col}\u201d as', exact=True).select_option(field)
        if not action: return wait_state(page, lambda s: True, 5)
        if action == 'convert': page.select_option('#target', target)
        page.click('#check' if action == 'check' else '#convert')
        return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), timeout, 'run')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def match_case(page, subjects, others, timeout=120):
    """Krisis: choose the subjects, then give the other dataset to Match; wait for the review screen."""
    try:
        page.set_input_files('#picker', [str(subjects)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return s
        page.set_input_files('#others', [str(others)])
        return wait_state(page, lambda s: s.get('phase') in ('reviewing', 'error') or (s.get('action') == 'match' and s.get('phase') == 'done'), timeout, 'matching')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

# ---- Hermes: Reading options (one fieldset after the column table, src/app.js renderReading) -------
READING_DOM = """() => { const f = document.getElementById('reading'); if (!f) return null;
  return { hidden: f.hidden, shown: f.getClientRects().length > 0, legend: f.querySelector('legend')?.textContent || '',
    after: f.previousElementSibling?.id || null,
    boxes: [...f.querySelectorAll('input[data-reading]')].map((x) => ({ id: x.id, checked: x.checked, label: x.labels[0]?.textContent.trim() || '' })),
    keyRows: [...f.querySelectorAll('table.reading-keys tbody tr')].map((r) => ({ prefix: r.querySelector('th').textContent, pattern: r.querySelector('input[type=text]').value, use: r.querySelector('input[type=checkbox]').checked })),
    message: document.getElementById('reading-message')?.textContent || '',
    keysMessage: document.getElementById('reading-keys-message')?.textContent || '',
    titles: document.querySelectorAll('#action [title]').length }; }"""

def reading_case(page, file, keys=False, columns=False):
    """Choose a file and wait for its detection, and for a TEI file's keys or a table's columns to be answered."""
    try:
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(file)])
        return wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised') and (not keys or (s.get('reading') or {}).get('keys') is not None)
                          and (not columns or bool(s.get('columns'))), 60, 'reading options')
    except Exception as e:                       # a harness error is a failed check, never a crash
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def reading_run(page, target='plato-json', timeout=120):
    """Convert the file chosen, with the reading options as they are set, and wait for the result."""
    try:
        page.select_option('#target', target)
        page.click('#convert')
        return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), timeout, 'run')
    except Exception as e:
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}

def reading_doc(page, s, tmp, name):
    """The PLATO JSON document a run wrote, saved as the page saves it, or {}."""
    ok = s.get('phase') == 'done' and s.get('outputs')
    return json.loads(download(page, s['outputs'][0]['name'], tmp / name).read_text()) if ok else {}

def abouts(doc):
    return sorted(p['@id'] for p in doc.get('spatialEntities', []) for a in p.get('attestations', []))

def reading_checks(page, tmp):
    """Hermes: the Reading options area, for TEI and for a table of places. Every check pairs an absence
    with a presence found in the same call, and a converted result with a run without the option."""
    fx = ROOT / 'test/fixtures'
    # A format with no reading options shows none; TEI shows its three, all off, after the column table:
    # the list of places, and the two that convert the editors' words (marked plato:Editorial).
    s1 = reading_case(page, fx / 'lpf-readme-example.json')
    d1 = page.evaluate(READING_DOM) if s1.get('format') else None
    s2 = reading_case(page, fx / 'tei/isicily-ISic000934.xml', keys=True)
    d2 = page.evaluate(READING_DOM) if s2.get('format') else None
    check('Reading options: none for LPF; for a TEI edition three boxes, the list of places, header places and commentary places, all off, after the column table; no key table for a file with no keys; no title attributes',
          s1.get('format') == 'lpf' and d1 and d1['hidden'] and not d1['shown']
          and s2.get('format') == 'tei' and d2 and d2['shown'] and d2['legend'] == 'Reading options' and d2['after'] == 'columns'
          and [b['id'] for b in d2['boxes']] == ['reading-listPlaces', 'reading-headerPlaces', 'reading-commentaryPlaces'] and not any(b['checked'] for b in d2['boxes'])
          and 'list of places' in d2['boxes'][0]['label'] and "editors' words" in d2['boxes'][1]['label'] and "editors' words" in d2['boxes'][2]['label']
          and (s2.get('reading') or {}).get('keys') == [] and d2['keyRows'] == [] and d2['keysMessage'] == '' and d2['titles'] == 0, {'lpf': d1, 'tei': d2, 'state': s2.get('reading')})

    # A TEI file whose keys cannot be read (an entity it does not declare, past its head): the Reading
    # options say so in a short message, beside the box still shown; the file above, read, says nothing.
    broken = tmp / 'keys-unreadable.xml'
    broken.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title></titleStmt>'
                      '<publicationStmt><p>x</p></publicationStmt><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>'
                      '<text><body><p><placeName key="tgn,1">A</placeName>&nbsp;</p></body></text></TEI>\n', encoding='utf-8')
    s3 = reading_case(page, broken, keys=True)
    d3 = page.evaluate(READING_DOM) if s3.get('format') else None
    check('Reading options: a TEI file whose keys cannot be read says so in the Reading options, with the three boxes still shown; no key table, no title attributes',
          s3.get('format') == 'tei' and d3 and d3['shown'] and [b['id'] for b in d3['boxes']] == ['reading-listPlaces', 'reading-headerPlaces', 'reading-commentaryPlaces']
          and d3['keysMessage'].startswith('The keys could not be read: ') and 'entity' in d3['keysMessage'] and (s3.get('reading') or {}).get('keysMessage') == d3['keysMessage']
          and d3['keyRows'] == [] and d3['titles'] == 0, {'dom': d3, 'state': s3.get('reading') or s3})

    # A file with keys: the key table appears, each suggested pattern filled in and unticked. Converted
    # as it is, no key is made an address; with the tgn row ticked, its three keys are.
    keys = fx / 'tei/keys-constructed.xml'
    s = reading_case(page, keys, keys=True)
    d = page.evaluate(READING_DOM) if s.get('format') else None
    rows = {r['prefix']: r for r in (d or {}).get('keyRows', [])}
    check('Reading options: a TEI file with keys shows a row for each prefix, with the suggested pattern filled in and every row unticked',
          d and set(rows) >= {'tgn', 'pleiades', 'perseus'} and rows['tgn']['pattern'] == 'http://vocab.getty.edu/tgn/{id}'
          and rows['pleiades']['pattern'] == 'https://pleiades.stoa.org/places/{id}' and rows['perseus']['pattern'] == ''
          and not any(r['use'] for r in rows.values()) and not any(b['checked'] for b in d['boxes']), d)
    r0 = reading_run(page)
    doc0 = reading_doc(page, r0, tmp, 'keys-off.json')
    s = reading_case(page, keys, keys=True)
    try: page.get_by_label('Use the pattern for keys with the prefix “tgn”', exact=True).check(); ticked = True
    except Exception as e: ticked = str(e).split('\n')[0][:200]
    r1 = reading_run(page)
    doc1 = reading_doc(page, r1, tmp, 'keys-tgn.json')
    tgn = lambda doc: [a for a in abouts(doc) if a.startswith('http://vocab.getty.edu/tgn/')]
    check('Reading options: a confirmed key pattern makes addresses: none from tgn keys unticked (reported, with the pattern to try), three once ticked',
          ticked is True and abouts(doc0) and tgn(doc0) == [] and any(i['kind'] == 'tei-key-no-pattern' for i in r0['report']['items'])
          and tgn(doc1) == ['http://vocab.getty.edu/tgn/7001393', 'http://vocab.getty.edu/tgn/7010720', 'http://vocab.getty.edu/tgn/7011179'],
          {'ticked': ticked, 'off': abouts(doc0), 'on': abouts(doc1), 'r1': r1.get('report') or r1})

    # A table of places: one box, rows with the same id as one place. Unticked, the repeated id is
    # refused, naming the option; ticked, place a has an attestation from each of its two rows.
    dup = fx / 'generic/duplicate-ids.csv'
    s = reading_case(page, dup, columns=True)
    d = page.evaluate(READING_DOM) if s.get('columns') else None
    r0 = reading_run(page)
    refusal = ' '.join(e for i in (r0.get('report') or {}).get('items', []) if i['severity'] == 'error' for e in i['examples'])
    s = reading_case(page, dup, columns=True)
    try: page.get_by_label('Rows with the same id are one place', exact=True).check(); ticked = True
    except Exception as e: ticked = str(e).split('\n')[0][:200]
    r1 = reading_run(page)
    doc1 = reading_doc(page, r1, tmp, 'same-id.json')
    a = next((p for p in doc1.get('spatialEntities', []) if p['@id'].endswith('/a')), None)
    check('Reading options: a CSV shows only "rows with the same id are one place", off; unticked the repeated id is refused naming it, ticked place a has two attestations',
          d and [(b['id'], b['checked']) for b in d['boxes']] == [('reading-sameId', False)] and 'Reading options, or --same-id' in refusal
          and ticked is True and r1.get('phase') == 'done' and a is not None and len(a['attestations']) == 2, {'dom': d, 'refusal': refusal[-200:], 'ticked': ticked, 'a': a, 'r1': r1.get('report') or r1})
    # With no id column, ticking it is refused in plain words and the box does not stay ticked.
    s = reading_case(page, fx / 'generic/no-ids.csv', columns=True)
    try: page.get_by_label('Rows with the same id are one place', exact=True).click(); clicked = True
    except Exception as e: clicked = str(e).split('\n')[0][:200]
    d = page.evaluate(READING_DOM) if s.get('columns') else None
    check('Reading options: "rows with the same id are one place" with no id column is refused with a message, and stays unticked',
          clicked is True and d and [(b['id'], b['checked']) for b in d['boxes']] == [('reading-sameId', False)] and 'when a column is read as the place id' in d['message'], {'clicked': clicked, 'dom': d})

    # A column of a gazetteer's ids: its row offers the suggested pattern, unticked, and the warning
    # points at it. Converted as it is, no Pleiades address; ticked, the ids are made into addresses,
    # and the matching saved holds the pattern in its object form.
    gaz = fx / 'generic/gazetteer-ids.csv'
    pattern = 'https://pleiades.stoa.org/places/{id}'
    s = reading_case(page, gaz, columns=True)
    box = page.evaluate("""() => { const b = document.querySelector('#columns input[data-pattern-column]'); if (!b) return null;
        const row = b.closest('tr'); return { column: row.querySelector('th').textContent, checked: b.checked, label: b.labels[0]?.textContent.trim() || '',
        select: row.querySelector('select').value, warnings: document.getElementById('columns-warnings').textContent }; }""") if s.get('columns') else None
    r0 = reading_run(page)
    doc0 = reading_doc(page, r0, tmp, 'gaz-off.json')
    s = reading_case(page, gaz, columns=True)
    try: page.locator('#columns input[data-pattern-column]').check(); ticked = True
    except Exception as e: ticked = str(e).split('\n')[0][:200]
    st = wait_state(page, lambda s: True, 5)
    try:
        with page.expect_download(timeout=30_000) as dl: page.click('#columns-save')
        dl.value.save_as(tmp / 'gaz-matching.json'); saved = json.loads((tmp / 'gaz-matching.json').read_text())
    except Exception as e: saved = {'error': str(e)[:200]}
    r1 = reading_run(page)
    doc1 = reading_doc(page, r1, tmp, 'gaz-on.json')
    pleiades = lambda doc: [x for x in abouts(doc) if x.startswith('https://pleiades.stoa.org/')]
    check('column table: a suggested gazetteer pattern is offered unticked with a warning naming it; unticked no Pleiades address is made, ticked the ids become addresses and the saved matching has the object form',
          box and box['column'] == 'pleiades_id' and not box['checked'] and pattern in box['label'] and box['select'] == 'note' and pattern in box['warnings']
          and len(doc0.get('spatialEntities', [])) == 6 and pleiades(doc0) == []
          and ticked is True and (st.get('columns') or {}).get('patterns') == {'pleiades_id': pattern} and (st.get('columns') or {}).get('mapping', {}).get('pleiades_id') == 'address'
          and saved.get('pleiades_id') == {'field': 'address', 'pattern': pattern} and saved.get('name') == 'name'
          and 'https://pleiades.stoa.org/places/579885' in pleiades(doc1), {'box': box, 'off': abouts(doc0), 'on': abouts(doc1), 'saved': saved, 'state': st.get('columns')})


# ---- Hermes: the regions a place lies in, and a pasted list (src/app.js extraControls, the paste box) ----
WITHIN_DOM = """() => { const rows = [...document.querySelectorAll('#columns table.columns-table tbody tr')];
  return { rows: rows.map((r) => ({ column: r.querySelector('th').textContent, field: r.querySelector('select[data-column]')?.value,
      level: r.querySelector('select[data-level-column]')?.value ?? null, levelLabel: r.querySelector('select[data-level-column]')?.getAttribute('aria-label') ?? null,
      split: r.querySelector('.column-split') ? { separator: r.querySelector('[data-split=separator]').value, levels: r.querySelector('[data-split=levels]').value,
        name: r.querySelector('[data-split=firstIsName]').checked, nameLabel: r.querySelector('[data-split=firstIsName]').labels[0]?.textContent.trim() || '' } : null })),
    titles: document.querySelectorAll('#files [title], #columns [title]').length }; }"""

def within_checks(page, tmp):
    """Hermes: a region's level beside its choice, the split into levels, and the pasted list. Each
    check pairs an absence with a presence found in the same call, and a result with its control."""
    base = 'https://example.org/within/'
    regions = tmp / 'regions.csv'
    regions.write_text('id,Name,Parish,County,Country\n1,Mill,Rotherhithe,Surrey,England\n', encoding='utf-8')
    s = reading_case(page, regions, columns=True)
    d0 = page.evaluate(WITHIN_DOM) if s.get('columns') else None
    st0 = (s.get('columns') or {})
    # Choosing level 1 for the parish swaps it with the country's.
    try: page.get_by_label('The level of the region in the column “Parish”: 1 is the widest', exact=True).select_option('1'); chose = True
    except Exception as e: chose = str(e).split('\n')[0][:200]
    st1 = wait_state(page, lambda s: (s.get('columns') or {}).get('levels', {}).get('Parish') == 1, 10, 'level').get('columns') or {}
    try:
        with page.expect_download(timeout=30_000) as dl: page.click('#columns-save')
        dl.value.save_as(tmp / 'within-matching.json'); saved = json.loads((tmp / 'within-matching.json').read_text())
    except Exception as e: saved = {'error': str(e)[:200]}
    row = lambda d, c: next((r for r in (d or {}).get('rows', []) if r['column'] == c), {})
    check('column table: regions are guessed widest first, each with a level beside it (none beside the name); choosing a level another has swaps the two, and the saved matching keeps the levels',
          d0 and row(d0, 'Parish').get('level') == '3' and row(d0, 'Country').get('level') == '1' and row(d0, 'County').get('field') == 'within'
          and row(d0, 'Name').get('field') == 'name' and row(d0, 'Name').get('level') is None and d0['titles'] == 0
          and st0.get('levels') == {'Country': 1, 'County': 2, 'Parish': 3}
          and chose is True and st1.get('levels') == {'Country': 3, 'County': 2, 'Parish': 1}
          and saved.get('Parish') == {'field': 'within', 'level': 1} and saved.get('Country') == {'field': 'within', 'level': 3} and saved.get('Name') == 'name',
          {'dom': d0, 'first': st0.get('levels'), 'chose': chose, 'after': st1.get('levels'), 'saved': saved})
    # Converted under a base address, each level is a ContainedIn attestation; the chain is no key of the output.
    page.evaluate(f"() => {{ const b = document.getElementById('base'); if (b) b.value = {json.dumps(base)}; }}")
    r = reading_run(page)
    page.evaluate("() => { const b = document.getElementById('base'); if (b) b.value = ''; }")
    doc = reading_doc(page, r, tmp, 'within.json')
    text = json.dumps(doc)
    mill = next((p for p in doc.get('spatialEntities', []) if p['@id'] == base + 'place/1'), {})
    label_of = {p['@id']: p.get('label') for p in doc.get('spatialEntities', [])}
    contained = [label_of.get(a['relations'][0].get('relatesTo')) for a in mill.get('attestations', []) if a.get('relations')]
    no_label = all('relatedLabel' not in a['relations'][0] for p in doc.get('spatialEntities', []) for a in p.get('attestations', []) if a.get('relations'))
    region_labels = sorted(p['label'] for p in doc.get('spatialEntities', []) if '/place/region-' in p['@id'])
    check('column table: converted under a base address, the place is ContainedIn its narrowest region (the parish, now level 3: England), each region minted once; no "within" key is written',
          r.get('phase') == 'done' and contained == ['England (Surrey, Rotherhithe)'] and no_label and region_labels == ['England (Surrey, Rotherhithe)', 'Rotherhithe', 'Surrey (Rotherhithe)']
          and '"within"' not in text and 'https://w3id.org/plato#ContainedIn' in text, {'phase': r.get('phase'), 'contained': contained, 'no_label': no_label, 'regions': region_labels})

    # A loaded mapping with gapped levels, {1, 3, 6}: every level selector reaches the highest, 6.
    LEVEL_OPTIONS = """() => Object.fromEntries([...document.querySelectorAll('#columns select[data-level-column]')].map((s) => [s.getAttribute('aria-label'), [...s.options].map((o) => o.value)]))"""
    lab = lambda c: f'The level of the region in the column “{c}”: 1 is the widest'
    gapped = tmp / 'gapped-levels.json'
    gapped.write_text(json.dumps({'id': 'id', 'Name': 'name', 'Parish': {'field': 'within', 'level': 6}, 'County': {'field': 'within', 'level': 3}, 'Country': {'field': 'within', 'level': 1}}), encoding='utf-8')
    s = reading_case(page, regions, columns=True)
    opts0 = page.evaluate(LEVEL_OPTIONS) if s.get('columns') else {}
    try:
        page.set_input_files('#columns-file', [str(gapped)])
        stg = wait_state(page, lambda s: (s.get('columns') or {}).get('levels', {}).get('Parish') == 6, 10, 'gapped levels').get('columns') or {}
        opts1 = page.evaluate(LEVEL_OPTIONS)
        page.get_by_label(lab('Country'), exact=True).select_option('6'); chose6 = True
        st6 = wait_state(page, lambda s: (s.get('columns') or {}).get('levels', {}).get('Country') == 6, 10, 'level 6').get('columns') or {}
    except Exception as e: stg = st6 = {}; opts1 = {}; chose6 = str(e).split('\n')[0][:200]
    check('column table: with a loaded mapping of gapped levels (1, 3, 6), each level selector reaches 6, and choosing 6 for the country swaps it with the parish; guessed levels 1-3 offer only 1-3 (control)',
          opts0.get(lab('Country')) == ['1', '2', '3']
          and stg.get('levels') == {'Country': 1, 'County': 3, 'Parish': 6} and opts1.get(lab('Country')) == ['1', '2', '3', '4', '5', '6'] and opts1.get(lab('County')) == ['1', '2', '3', '4', '5', '6']
          and chose6 is True and st6.get('levels') == {'Country': 6, 'County': 3, 'Parish': 1},
          {'guessed': opts0, 'loaded': stg.get('levels'), 'options': opts1, 'chose': chose6, 'after': st6.get('levels')})

    # A column of several regions in one cell: no split controls until it is chosen; then a separator,
    # levels guessed from the examples, and "the first part is the place's name", unticked.
    places = tmp / 'split.csv'
    places.write_text('Place\n"Rotherhithe, Surrey, England"\n', encoding='utf-8')
    s = reading_case(page, places, columns=True)
    d1 = page.evaluate(WITHIN_DOM) if s.get('columns') else None
    try:
        page.get_by_label('Read the column “Place” as', exact=True).select_option('split')
        d2 = page.evaluate(WITHIN_DOM)
        page.get_by_label("The first part is the place's name", exact=True).check()
        page.get_by_label('The levels the parts of the column “Place” go to, narrowest first', exact=True).fill('2, 1')
        page.get_by_label('The levels the parts of the column “Place” go to, narrowest first', exact=True).press('Tab')
        done = True
    except Exception as e: d2 = None; done = str(e).split('\n')[0][:200]
    st = wait_state(page, lambda s: ((s.get('columns') or {}).get('splits', {}).get('Place') or {}).get('levels') == [2, 1], 10, 'split').get('columns') or {}
    r = reading_run(page)
    doc = reading_doc(page, r, tmp, 'split.json')
    p0 = (doc.get('spatialEntities') or [{}])[0]
    check('column table: "split into levels" shows its controls only once chosen; with the first part the name and levels 2, 1 the place is Rotherhithe within England > Surrey',
          d1 and row(d1, 'Place').get('split') is None and row(d1, 'Place').get('field') == 'note'
          and d2 and row(d2, 'Place').get('split') == {'separator': ', ', 'levels': '3, 2, 1', 'name': False, 'nameLabel': "The first part is the place's name"}
          and done is True and st.get('splits', {}).get('Place') == {'separator': ', ', 'levels': [2, 1], 'firstIsName': True}
          and r.get('phase') == 'done' and p0.get('label') == 'Rotherhithe'
          and (p0.get('attestations') or [{}])[0].get('notes') == 'Within (as the source gives it): England > Surrey > Rotherhithe',
          {'before': d1, 'after': d2, 'done': done, 'state': st.get('splits'), 'place': p0})

    # A pasted list: nothing to use says so and chooses nothing; a list becomes a one-column table, "name".
    try:
        page.set_input_files('#picker', [])
        if not page.locator('#paste').evaluate('(d) => d.open'): page.click('#paste summary')
        page.get_by_label('Paste a list of names, one per line', exact=True).fill('  \n')
        page.click('#paste-use')
        empty = page.inner_text('#paste-message')
        phase_empty = wait_state(page, lambda s: True, 2).get('phase')
        page.get_by_label('Paste a list of names, one per line', exact=True).fill('Rotherhithe\nNewport, Isle of Wight\n')
        page.click('#paste-use')
        st = wait_state(page, lambda s: s.get('phase') == 'detected' and (s.get('columns') or {}).get('headers') == ['name'], 60, 'pasted list')
        chosen = page.inner_text('#chosen'); message = page.inner_text('#paste-message'); ok = True
    except Exception as e: st = {}; chosen = empty = message = ''; phase_empty = None; ok = str(e).split('\n')[0][:200]
    ex = ((st.get('columns') or {}).get('examples') or {}).get('name')
    check('pasted list: an empty list is refused with a message and nothing chosen; a list is read as a table of places of one column, "name", read as the name',
          ok is True and 'paste one name on each line' in empty and phase_empty != 'detected'
          and st.get('format') == 'csv' and (st.get('columns') or {}).get('mapping') == {'name': 'name'} and ex == ['Rotherhithe', 'Newport, Isle of Wight']
          and 'pasted-list.csv' in chosen and message == '', {'ok': ok, 'empty': empty, 'phase': phase_empty, 'state': st.get('columns'), 'chosen': chosen[:200]})


SPELLINGS_CSV = 'id,name,lat,lon\n1,Rotherhithe,51.5,-0.05\n2,ROTHERHITHE.,51.5,-0.05\n3,Rotherhithe,51.5,-0.05\n4,Bermondsey,51.49,-0.07\n5,Deptford,51.48,-0.03\n'
SPELLINGS_DOM = """() => { const b = document.getElementById('spellings'); if (!b) return null;
    return { hidden: b.hidden, open: !!document.getElementById('spellings-open'), tip: document.getElementById('spellings-open')?.dataset.tip || '',
      after: b.previousElementSibling?.id || '', boxes: [...b.querySelectorAll('input[data-spellings-use]')].map((x) => x.checked),
      chosen: [...b.querySelectorAll('input[data-spellings-chosen]')].map((x) => x.value), rows: [...b.querySelectorAll('tbody tr')].map((r) => r.querySelector('ul').textContent),
      titles: document.querySelectorAll('#action [title]').length }; }"""

def spellings_find(page, file, column='name'):
    """Choose a table, open "Group similar spellings…", and find the groups in a column: the page's state once they are shown."""
    s = reading_case(page, file, columns=True)
    if not s.get('columns'): return s
    try:
        page.click('#spellings-open')
        page.select_option('#spellings-column', column)
        page.click('#spellings-find')
    except Exception as e:
        return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    return wait_state(page, lambda x: (x.get('spellings') or {}).get('rows') and not x['spellings'].get('waiting'), 60, 'spelling groups')

def grouped_notes(doc):
    return [a.get('notes', '') for p in doc.get('spatialEntities', []) for a in p.get('attestations', []) if 'Grouped for lookup' in a.get('notes', '')]

def spellings_checks(page, tmp):
    """Hermes: "Group similar spellings…" for a table of places (Methodos #28). Groups are proposed
    unticked; converted unticked, no row is grouped (with the five rows read as the presence); ticked,
    the grouped rows carry the note and keep the source's names; the matching saved holds the groups
    beside the mapping, and loaded again they apply as before."""
    f = tmp / 'spellings.csv'
    f.write_text(SPELLINGS_CSV, encoding='utf-8')
    before = reading_case(page, f, columns=True)
    d0 = page.evaluate(SPELLINGS_DOM) if before.get('columns') else None
    s = spellings_find(page, f)
    d = page.evaluate(SPELLINGS_DOM) if (s.get('spellings') or {}).get('rows') else None
    sp = s.get('spellings') or {}
    check('spellings: a table of places offers "Group similar spellings…" (a data-tip, no title), after the Reading options; found, the group is shown unticked with its counts and the most frequent spelling to look up by',
          d0 and not d0['hidden'] and d0['open'] and 'tick' in d0['tip'] and 'source' in d0['tip'] and d0['after'] == 'reading' and d0['titles'] == 0
          and d and d['boxes'] == [False] and d['chosen'] == ['Rotherhithe'] and 'Rotherhithe (2)' in d['rows'][0] and 'ROTHERHITHE. (1)' in d['rows'][0]
          and sp.get('ticked') == 0 and sp.get('confirmed') == {} and d['titles'] == 0, {'before': d0, 'after': d, 'state': sp})
    r0 = reading_run(page)
    doc0 = reading_doc(page, r0, tmp, 'spellings-off.json')
    s = spellings_find(page, f)
    try: page.get_by_label('Use the group looked up as “Rotherhithe”', exact=True).check(); ticked = True
    except Exception as e: ticked = str(e).split('\n')[0][:200]
    st = wait_state(page, lambda x: (x.get('spellings') or {}).get('ticked') == 1, 10, 'ticked')
    try:
        with page.expect_download(timeout=30_000) as dl: page.click('#columns-save')
        dl.value.save_as(tmp / 'spellings-matching.json'); saved = json.loads((tmp / 'spellings-matching.json').read_text())
    except Exception as e: saved = {'error': str(e)[:200]}
    r1 = reading_run(page)
    doc1 = reading_doc(page, r1, tmp, 'spellings-on.json')
    labels = lambda doc: [p.get('label') for p in doc.get('spatialEntities', [])]
    check('spellings: unticked, no row is grouped; ticked, the three rows of the group carry "Grouped for lookup with" and keep the source\'s names',
          len(doc0.get('spatialEntities', [])) == 5 and grouped_notes(doc0) == []
          and ticked is True and len(grouped_notes(doc1)) == 3 and all('(spelling chosen: Rotherhithe)' in n for n in grouped_notes(doc1))
          and labels(doc1) == ['Rotherhithe', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey', 'Deptford'],
          {'off': grouped_notes(doc0), 'on': grouped_notes(doc1), 'labels': labels(doc1), 'ticked': ticked, 'state': st.get('spellings')})
    # Saved: the mapping under "columns", the ticked group under "clusters". Loaded with the file chosen
    # afresh (nothing ticked), the group is ticked again, and the run groups the same three rows.
    s = reading_case(page, f, columns=True)
    fresh = (s.get('spellings') or {}).get('ticked')
    try:
        page.set_input_files('#columns-file', str(tmp / 'spellings-matching.json')); loaded = True
    except Exception as e: loaded = str(e).split('\n')[0][:200]
    st2 = wait_state(page, lambda x: (x.get('spellings') or {}).get('ticked') == 1 and x.get('columns') and 'using the matching' in ' '.join((x.get('columns') or {}).get('messages', [])).lower(), 30, 'loaded')
    r2 = reading_run(page)
    doc2 = reading_doc(page, r2, tmp, 'spellings-loaded.json')
    check('spellings: the matching saved holds the groups beside the mapping ({columns, clusters}); loaded again, the group is ticked and applies as before',
          saved.get('columns', {}).get('name') == 'name' and saved.get('clusters', {}).get('name', {}).get('groups') == [{'chosen': 'Rotherhithe', 'members': ['Rotherhithe', 'ROTHERHITHE.']}]
          and fresh == 0 and loaded is True and (st2.get('spellings') or {}).get('ticked') == 1 and grouped_notes(doc2) == grouped_notes(doc1) and len(grouped_notes(doc2)) == 3,
          {'saved': saved, 'fresh': fresh, 'loaded': loaded, 'state': st2.get('spellings'), 'notes': grouped_notes(doc2)})


def krisis_place(iri, label, lon, lat, *also):
    return {'@id': iri, 'label': label, 'attestations': [{'names': [{'toponym': n} for n in (label, *also)],
            'geometries': [{'geojson': {'type': 'Point', 'coordinates': [lon, lat]}}], 'sources': [{'title': 'A survey'}]}]}

def krisis_case(page, tmp):
    """Krisis, match review: match two small files, decide with the keyboard, save the review, finish, resume."""
    a, b = 'https://example.org/a/', 'https://example.org/b/'
    subjects = tmp / 'krisis-subjects.json'; others = tmp / 'krisis-others.json'
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': a, 'title': 'Our places'}, 'spatialEntities': [
        krisis_place(a + 'bristol', 'Bristol', -2.5879, 51.4545, 'Bristow'), krisis_place(a + 'bath', 'Bath', -2.3590, 51.3811),
        krisis_place(a + 'wells', 'Wells', -2.6474, 51.2094), krisis_place(a + 'zennor', 'Zennor', -5.5680, 50.1910)]}))
    others.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': b, 'title': 'Their places'}, 'spatialEntities': [
        krisis_place(b + 'bristoll', 'Bristoll', -2.5900, 51.4500), krisis_place(b + 'bathe', 'Bathe', -2.3600, 51.3800),
        krisis_place(b + 'bath-maine', 'Bath', -69.8203, 43.9109), krisis_place(b + 'welles', 'Welles', -2.6500, 51.2100)]}))
    # The base address in the options (for spreadsheet tables) goes to matching, and is kept in the work file.
    page.evaluate("() => { const b = document.getElementById('base'); if (b) b.value = 'https://example.org/a/'; }")
    # And the other dataset's title, which each attestation cites, given in the options.
    page.evaluate("() => { const t = document.getElementById('others-title'); if (t) t.value = 'Their places, as given'; }")
    s = match_case(page, subjects, others)
    page.evaluate("() => { const b = document.getElementById('base'); if (b) b.value = ''; }")
    work = s.get('work') or {}
    cands = {(c['candidate_source'].rsplit('/', 1)[-1], c['candidate_candidate'].rsplit('/', 1)[-1]) for c in work.get('candidates', [])}
    check('match review: two files matched, the review screen shows the first place with its candidates',
          s.get('phase') == 'reviewing' and ('bristol', 'bristoll') in cands and ('bath', 'bathe') in cands and ('wells', 'welles') in cands
          and page.is_visible('#review') and 'Bristol' in page.inner_text('#review-place') and 'Bristoll' in page.inner_text('#review-place'), s.get('review') or s.get('report') or s)
    # Bath in Maine has Bath's own name but is thousands of kilometres away: not suggested, beside the Bath that is.
    check('match review: a namesake too far away is not suggested, one near by is',
          s.get('phase') == 'reviewing' and ('bath', 'bathe') in cands and ('bath', 'bath-maine') not in cands, sorted(cands))
    check('match review: the base address in the options is passed to matching and kept in the work file',
          (work.get('match_parameters') or {}).get('base') == 'https://example.org/a/', work.get('match_parameters') or s)
    # The lists of qualifiers: a checkbox each in the options, the measured one checked, and the work file says which were used.
    try: boxes = page.evaluate("() => [...document.querySelectorAll('#qualifier-lists input[name=qualifiers]')].map((b) => [b.value, b.checked, b.parentElement.textContent.trim()])")
    except Exception as e: boxes = [['error', str(e).split('\n')[0][:200], '']]
    check('match review: the options show a checkbox for each list of qualifiers, "unmeasured" where so; the measured list is used by default and kept in the work file',
          [b[:2] for b in boxes] == [['en-cy-la', True], ['fr', False], ['de', False]] and boxes[1][2] == 'French (unmeasured)' and boxes[0][2] == 'English, Welsh and Latin'
          and ((work.get('match_parameters') or {}).get('qualifiers') or {}).get('lists') == ['en-cy-la'], boxes)
    check('match review: the other dataset\'s title in the options replaces the one it gives, is kept in the work file, and is what the suggestions cite',
          (work.get('others') or {}).get('title') == 'Their places, as given' and (work.get('others') or {}).get('titleFrom') == 'given'
          and bool(work.get('candidates')) and all(c['other']['source']['title'] == 'Their places, as given' for c in work['candidates']), work.get('others') or s)
    ok = s.get('phase') == 'reviewing'; asked = False; focused = None
    try:
        if ok:
            # The name is asked once, in the page, and remembered by the browser; while it is asked, it has the focus.
            asked = page.is_visible('#review-name')
            focused = page.evaluate("() => document.activeElement && document.activeElement.id")
            page.fill('#review-name', 'Ada Reviewer'); page.press('#review-name', 'Enter')
            asked = asked and not page.is_visible('#review-name')
            page.keyboard.press('a')                  # Bristol: same place as its first candidate
            page.keyboard.press('d')                  # Bath: different places, with a basis typed in the field
            page.keyboard.type('Bathe is a farm; and so near by, just a namesake')   # holds a, n, d, s, j, k: none may act
            page.keyboard.press('Enter')
            page.keyboard.press('n')                  # Wells: not this one
    except Exception as e:
        ok = False; s = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    s = wait_state(page, lambda s: s.get('phase') == 'reviewing' and s.get('review', {}).get('reviewed') == 3, 10, 'decisions') if ok else s
    dec = {c['candidate_source'].rsplit('/', 1)[-1] + '>' + c['candidate_candidate'].rsplit('/', 1)[-1]: c.get('decision') for c in (s.get('work') or {}).get('candidates', [])}
    kinds = {k: (v or {}).get('kind') for k, v in dec.items()}
    remembered = page.evaluate("() => { try { return localStorage.getItem('plato-tools.reviewer'); } catch { return null; } }") if ok else None
    check('match review: keys decide (same place, different places with its basis, not this one), and none acts while typing the basis',
          s.get('phase') == 'reviewing' and kinds.get('bristol>bristoll') == 'match' and kinds.get('wells>welles') == 'not-this'
          and kinds.get('bath>bathe') == 'distinct' and dec['bath>bathe'].get('basis') == 'Bathe is a farm; and so near by, just a namesake'
          and sum(1 for v in kinds.values() if v) == 3 and '3 of 3 places reviewed' in page.inner_text('#review-progress'), s.get('review') or s)
    check('match review: the reviewer\'s name is asked in the page, then put away, and remembered by the browser', ok and asked and 'Ada Reviewer' in (remembered or ''), {'asked then hidden': asked, 'remembered': remembered})
    check('match review: while the name is asked, the name field has the focus', focused == 'review-name', focused)
    # An ORCID that is not one (a digit group short) is refused before anything is saved, and not remembered.
    orcid = {}
    if s.get('phase') == 'reviewing':
        try:
            page.evaluate("() => { const o = document.getElementById('orcid'); o.value = '0000-0002-1825'; o.dispatchEvent(new Event('change')); }")
            page.click('#save-review')
            page.wait_for_selector('#review-warning:not([hidden])', timeout=10_000)
            orcid = {'warning': page.inner_text('#review-warning'), 'saved': page.evaluate("() => window.__plato.reviewSaved || null"),
                     'remembered': page.evaluate("() => { try { return localStorage.getItem('plato-tools.reviewer'); } catch { return null; } }")}
            page.evaluate("() => { const o = document.getElementById('orcid'); o.value = ''; o.dispatchEvent(new Event('change')); }")
        except Exception as e: orcid = {'error': str(e).split('\n')[0][:200]}
    check('match review: an ORCID that is not one is refused in the page, in plain words, and neither saved nor remembered',
          'ORCID is not written as one' in orcid.get('warning', '') and orcid.get('saved') is None
          and 'Ada Reviewer' in (orcid.get('remembered') or '') and '1825' not in (orcid.get('remembered') or ''), orcid)
    saved = {}
    if s.get('phase') == 'reviewing':
        try:
            with page.expect_download(timeout=30_000) as d: page.click('#save-review')
            d.value.save_as(tmp / 'saved.krisis.json'); saved = json.loads((tmp / 'saved.krisis.json').read_text())
        except Exception as e: saved = {'error': str(e)[:200]}
    skinds = {c['candidate_source'].rsplit('/', 1)[-1]: (c.get('decision') or {}).get('kind') for c in saved.get('candidates', []) if c.get('decision')}
    check('match review: Save the review writes the work file with the decisions and the reviewer',
          saved.get('krisis') == 3 and skinds == {'bristol': 'match', 'bath': 'distinct', 'wells': 'not-this'} and (saved.get('reviewer') or {}).get('name') == 'Ada Reviewer', saved.get('error') or {'krisis': saved.get('krisis'), 'decisions': skinds})
    # Finish with the default: the dataset, with the new attestations added, checked with the version check.
    ds, default, summ, left = {}, None, '', None
    if s.get('phase') == 'reviewing':
        try:
            default = page.evaluate("() => { const r = document.querySelector('input[name=\"review-output\"]:checked'); return r && !r.disabled ? r.value : null; }")
            # The title given for matching is kept in the field, to match again with; one typed in now is
            # not cited, as the review's other dataset already has a title (given), not a file's name.
            left = page.evaluate("() => document.getElementById('others-title').value")
            page.evaluate("() => { document.getElementById('others-title').value = 'A title left from before'; }")   # in the closed Options
            page.click('#finish')
            s = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, 'finish')
            summ = page.inner_text('#summary')
            if s.get('phase') == 'done' and s.get('outputs'):
                ds = json.loads(download(page, s['outputs'][0]['name'], tmp / 'krisis-dataset.json').read_text())
        except Exception as e: s = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    places = {p.get('@id', '').rsplit('/', 1)[-1]: p.get('attestations', []) for p in ds.get('spatialEntities', [])} if isinstance(ds, dict) else {}
    added = {k: v[1:] for k, v in places.items()}
    rel = lambda a: [(i.get('subject', '').rsplit('/', 1)[-1], i.get('object', '').rsplit('/', 1)[-1]) for i in a.get('identities', [])]
    check('match review: Finish by default writes your dataset with the match on Bristol, the denial on Bath, and nothing new on Wells or Zennor',
          default == 'dataset' and s.get('phase') == 'done' and ds.get('profile') == 'place-centric' and sorted(places) == ['bath', 'bristol', 'wells', 'zennor']
          and [rel(a) for a in added['bristol']] == [[('bristol', 'bristoll')]] and not added['bristol'][0].get('negated')
          and [rel(a) for a in added['bath']] == [[('bath', 'bathe')]] and added['bath'][0].get('negated') is True
          and added['wells'] == [] and added['zennor'] == [] and all(len(v) >= 1 and v[0].get('names') for v in places.values()),
          {'default': default, 'summary': summ, 'added': {k: [rel(a) for a in v] for k, v in added.items()}} if places else (s.get('report') or s))
    check('match review: the dataset written was passed by the version check, and the page says so', 'the version check found nothing deleted or changed' in summ
          and ((s.get('report') or {}).get('counts') or {}).get('versionCheck', {}).get('added') == 2, summ or s)
    # And the alternative: only the new attestations.
    out = {}
    if s.get('phase') == 'done' and page.is_visible('#finish'):
        try:
            page.check('input[name="review-output"][value="attestations"]')
            page.click('#finish')
            s = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error') and (s.get('phase') == 'error' or str((s.get('outputs') or [{}])[0].get('name', '')).endswith('.krisis-attestations.json')), 120, 'finish, attestations only')
            if s.get('phase') == 'done' and s.get('outputs'):
                out = json.loads(download(page, s['outputs'][0]['name'], tmp / 'krisis-attestations.json').read_text())
        except Exception as e: s = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    atts = out.get('attestations', []) if isinstance(out, dict) else []
    same = [a for a in atts if not a.get('negated') and rel(a) == [('bristol', 'bristoll')]]
    distinct = [a for a in atts if a.get('negated') and rel(a) == [('bath', 'bathe')]]
    check('match review: Finish (attestations only) saves one attestation of the match, one negated for the different places, none for "not this one"',
          s.get('phase') == 'done' and len(atts) == 2 and len(same) == 1 and len(distinct) == 1
          and not any(('wells', 'welles') in rel(a) for a in atts) and 'Ada Reviewer' in json.dumps(same[0].get('contributor')), s.get('report') or s if not atts else atts)
    cites = sorted({c.get('source', {}).get('title') for a in atts for c in a.get('citations', [])})
    check('match review: the title typed for matching is kept after the match, to match again with, and a title left in the options does not replace the one the review records',
          left == 'Their places, as given' and cites == ['Their places, as given'], {'field after matching': left, 'cited': cites})
    # A title left in the field is not a resumed review's: resuming clears it (checked below).
    page.evaluate("() => { const t = document.getElementById('others-title'); if (t) t.value = 'A title for another review'; }")
    # Krisis gives each answer the address Agora's minting would (withdraw.js), so that a changed decision can withdraw it.
    check('match review: the file made is the new attestations only, in PLATO JSON, each with an address in Agora\'s form (<place>#a-<hash>)', bool(atts) and out.get('profile') == 'attestation-centric'
          and all(re.fullmatch(re.escape(a.get('about', '')) + r'#a-[0-9a-f]{8}', a.get('@id', '')) for a in atts), {k: v for k, v in out.items() if k != 'attestations'} if isinstance(out, dict) else out)
    # Krisis: the suggestions exported as a candidate set on the review screen, and Finish then pointing at it.
    cset, out2, status = {}, {}, ''
    if s.get('phase') == 'done' and page.is_visible('#export-candidates'):
        try:
            with page.expect_download(timeout=30_000) as d: page.click('#export-candidates')
            d.value.save_as(tmp / 'krisis.candidates.json'); cset = json.loads((tmp / 'krisis.candidates.json').read_text())
            status = page.inner_text('#candidates-status')
            page.check('input[name="review-output"][value="attestations"]')
            page.click('#finish')
            s = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, 'finish after the export')
            if s.get('phase') == 'done' and s.get('outputs'):
                out2 = json.loads(download(page, s['outputs'][0]['name'], tmp / 'krisis-attestations-2.json').read_text())
        except Exception as e: s = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    set_id = (cset.get('candidateSet') or {}).get('@id', '') if isinstance(cset, dict) else ''
    ids = {c.get('@id') for c in cset.get('candidates', [])} if isinstance(cset, dict) else set()
    check('match review: Export the suggestions writes a candidate set of every suggestion, each under the set\'s address and suggested, and says to save the review',
          cset.get('profile') == 'candidate-set' and set_id.startswith(a + 'candidates/') and len(ids) == len(work.get('candidates', [])) > 0
          and all(i.startswith(set_id + '#c-') for i in ids) and all(c.get('status') == 'suggested' for c in cset.get('candidates', []))
          and cset['candidateSet'].get('candidatesFor') == a and 'Save the review as well' in status, {'status': status, 'set': cset} if cset else s)
    pf = {rel(x)[0]: [i.get('promotedFrom') for i in x.get('identities', [])] for x in (out2.get('attestations', []) if isinstance(out2, dict) else []) if rel(x)}
    check('match review: Finish after the export points each answer at its candidate (promotedFrom), the denial too, and lists the candidate set',
          s.get('phase') == 'done' and sorted(pf) == [('bath', 'bathe'), ('bristol', 'bristoll')] and all(len(v) == 1 and v[0] in ids for v in pf.values())
          and (out2.get('gazetteer') or {}).get('candidateSets') == [set_id], {'promotedFrom': pf, 'gazetteer': out2.get('gazetteer') if isinstance(out2, dict) else None} if out2 else (s.get('report') or s))
    # Resuming: the saved review, opened again, is back where it was, decisions and all.
    r = {}
    if saved.get('krisis') == 3:
        try:
            page.set_input_files('#workfile', [str(tmp / 'saved.krisis.json')])
            r = wait_state(page, lambda s: s.get('phase') == 'reviewing', 20, 'resume')
        except Exception as e: r = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    check('match review: a saved review resumes with its decisions', r.get('phase') == 'reviewing' and (r.get('review') or {}).get('reviewed') == 3
          and not page.is_visible('#review-warning'), r.get('review') or r)
    kept_title = page.evaluate("() => document.getElementById('others-title').value") if r.get('phase') == 'reviewing' else None
    check('match review: resuming a review clears a title left in the options from before', kept_title == '', kept_title)
    # And with another dataset chosen than the one it was made from, it still opens, and says so: the control for the absence above.
    w = ''
    if r.get('phase') == 'reviewing':
        try:
            page.set_input_files('#picker', [str(others)])
            wait_state(page, lambda s: s.get('phase') == 'detected', 30, 'detection')
            page.set_input_files('#workfile', [str(tmp / 'saved.krisis.json')])
            page.wait_for_selector('#review-warning:not([hidden])', timeout=20_000); w = page.inner_text('#review-warning')
        except Exception as e: w = 'harness-error: ' + str(e).split('\n')[0][:200]
    check('match review: a review resumed against other files than it was made from says so', 'other files than the ones chosen' in w and 'krisis-others.json' in w, w)
    # Checking the file chosen puts the review away, and its keys with it.
    put = {}
    if 'other files than the ones chosen' in w:
        try:
            decisions = "() => JSON.stringify((window.__plato.work || {}).candidates.map((c) => c.decision && c.decision.kind))"
            put = {'shown before': page.is_visible('#review'), 'before': page.evaluate(decisions)}
            page.click('#check')
            wait_state(page, lambda s: s.get('action') == 'check' and s.get('phase') in ('done', 'error'), 60, 'check')
            page.keyboard.press('a'); page.keyboard.press('n'); page.keyboard.press('k'); page.keyboard.press('n')
            put.update({'shown after': page.is_visible('#review'), 'after': page.evaluate(decisions)})
        except Exception as e: put = {'error': str(e).split('\n')[0][:200]}
    check('match review: Check puts the review away, and its keys then decide nothing',
          put.get('shown before') is True and put.get('shown after') is False and put.get('before') == put.get('after') and 'match' in (put.get('before') or ''), put)
    # A threshold matching would refuse is said plainly, before the other dataset is asked for; the one before was taken (above).
    bad = {}
    if put.get('shown after') is False:
        try:
            page.evaluate("() => { document.getElementById('threshold').value = '0'; }")   # in the closed Options, as a user would have left it
            page.click('#match')
            wait_state(page, lambda s: s.get('phase') == 'error', 10, 'refused')
            bad = {'summary': page.inner_text('#summary'), 'phase': page.evaluate("() => window.__plato.phase"), 'action': page.evaluate("() => window.__plato.action")}
            page.evaluate("() => { document.getElementById('threshold').value = '0.85'; }")
        except Exception as e: bad = {'error': str(e).split('\n')[0][:200]}
    check('match review: a threshold of 0 is refused in plain words, not as something gone wrong, and nothing is matched',
          'threshold must be above 0 and at most 1' in bad.get('summary', '') and 'Something went wrong' not in bad.get('summary', '') and bad.get('action') == 'check', bad)
    # Resuming with no dataset chosen says so, not that every file differs; with one chosen, the files are compared (above).
    nodata = ''
    if saved.get('krisis') == 3 and 'other files than the ones chosen' in w:
        try:
            page.reload()
            wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            page.set_input_files('#workfile', [str(tmp / 'saved.krisis.json')])
            page.wait_for_selector('#review-warning:not([hidden])', timeout=20_000); nodata = page.inner_text('#review-warning')
        except Exception as e: nodata = 'harness-error: ' + str(e).split('\n')[0][:200]
    check('match review: a review resumed with no dataset chosen says that none is chosen, not that the files differ',
          'No dataset is chosen yet' in nodata and 'other files than' not in nodata, nodata)
    # With files chosen that are not data these tools read, it says that, not that none is chosen.
    unrec = ''
    if 'No dataset is chosen yet' in nodata:
        try:
            junk = tmp / 'not-data.txt'; junk.write_text('Just some words, not a dataset.')
            page.set_input_files('#picker', [str(junk)])
            wait_state(page, lambda s: s.get('phase') in ('unrecognised', 'detected'), 30, 'detection')
            page.set_input_files('#workfile', [str(tmp / 'saved.krisis.json')])
            page.wait_for_selector('#review-warning:not([hidden])', timeout=20_000); unrec = page.inner_text('#review-warning')
        except Exception as e: unrec = 'harness-error: ' + str(e).split('\n')[0][:200]
    check('match review: a review resumed with files chosen that are not recognised says so, not that none is chosen',
          'not recognised' in unrec and 'No dataset is chosen' not in unrec, unrec)
    # Finish pressed then says so in words that fit Finish: the reviewer is in the review, not about to resume it.
    atfinish = ''
    if 'not recognised' in unrec:
        try:
            page.evaluate("() => { document.getElementById('review-warning').textContent = ''; }")
            page.click('#finish')
            page.wait_for_function("() => document.getElementById('review-warning').textContent.length > 0", timeout=10_000); atfinish = page.inner_text('#review-warning')
        except Exception as e: atfinish = 'harness-error: ' + str(e).split('\n')[0][:200]
    check('match review: Finish with files chosen that are not recognised says so in words for Finish, not "resume the review again"',
          'not recognised' in atfinish and 'cannot be finished with them' in atfinish and 'resume the review again' not in atfinish, atfinish)
    # The same with a IIIF Georeference Annotation chosen, which is recognised and refused with its
    # reason (input.js, readable()): it says that, where it went on to compare the files.
    geounrec = ''
    if 'not recognised' in unrec:
        try:
            page.set_input_files('#picker', [str(GEOREF)])
            wait_state(page, lambda s: s.get('phase') in ('unrecognised', 'detected'), 30, 'detection')
            page.set_input_files('#workfile', [str(tmp / 'saved.krisis.json')])
            page.wait_for_selector('#review-warning:not([hidden])', timeout=20_000); geounrec = page.inner_text('#review-warning')
        except Exception as e: geounrec = 'harness-error: ' + str(e).split('\n')[0][:200]
    check('match review: a review resumed with a IIIF Georeference Annotation chosen says it is not recognised, not that the files differ',
          'not recognised' in geounrec and 'other files than' not in geounrec, geounrec)
    krisis_seams(page, tmp, subjects)

GEOREF = ROOT / 'test/fixtures/hermes-detect/loc-chesapeake-annotationpage.json'

def krisis_withdraw_draft_case(page, tmp):
    """Krisis: in a dataset not yet published, the review may choose in the Finish area to replace an earlier answer
    rather than withdraw it. Chosen, the changed decision's earlier answer is taken out, nothing retracts it, the version
    check finds no answer both ways, and the choice is kept in the review saved. The default is withdraw (checked here,
    and by krisis_withdraw_case, whose Finish leaves it)."""
    a, b = 'https://example.org/da/', 'https://example.org/db/'
    subjects = tmp / 'draft-subjects.json'; others = tmp / 'draft-others.json'
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': a, 'title': 'Our draft', 'status': 'draft'},
                                    'spatialEntities': [krisis_place(a + 'newton', 'Newton', -1.0, 52.0)]}))
    others.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': b, 'title': 'Their places'},
                                  'spatialEntities': [krisis_place(b + 'newton', 'Newton', -1.01, 52.01)]}))
    saved, saved2, v1p, v2p = tmp / 'draft.krisis.json', tmp / 'draft-after.krisis.json', tmp / 'draft-v1.json', tmp / 'draft-v2.json'
    def finish(what):
        page.check('input[name="review-output"][value="dataset"]')
        page.click('#finish')
        return wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, what)
    got = {}
    try:
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
        s = match_case(page, subjects, others)
        if s.get('phase') == 'reviewing':
            if page.is_visible('#review-name'): page.fill('#review-name', 'Ada Reviewer'); page.press('#review-name', 'Enter')
            got['default'] = page.evaluate("() => document.querySelector('input[name=\"draft-answers\"]:checked')?.value || null")
            page.keyboard.press('a')
            wait_state(page, lambda s: (s.get('review') or {}).get('reviewed') == 1, 10, 'decision')
            with page.expect_download(timeout=30_000) as d: page.click('#save-review')
            d.value.save_as(saved)
            s = finish('finish')
            if s.get('phase') == 'done' and s.get('outputs'):
                download(page, s['outputs'][0]['name'], v1p)
                page.set_input_files('#picker', [str(v1p)])
                wait_state(page, lambda s: s.get('phase') == 'detected', 30, 'detection')
                page.set_input_files('#workfile', [str(saved)])
                wait_state(page, lambda s: s.get('phase') == 'reviewing', 20, 'resume')
                page.keyboard.press('d'); page.keyboard.type('The mill, not the village'); page.keyboard.press('Enter')
                wait_state(page, lambda s: any((c.get('decision') or {}).get('kind') == 'distinct' for c in (s.get('work') or {}).get('candidates', [])), 10, 'changed')
                page.check('input[name="draft-answers"][value="replace"]')   # after the keys: a radio with the focus takes them
                s2 = finish('finish again')
                got['report'] = {i['kind']: i.get('count') for i in (s2.get('report') or {}).get('items', [])}
                got['counts'] = (s2.get('report') or {}).get('counts')
                got['says'] = 'save the review again' in (page.inner_text('#summary') if s2.get('phase') == 'done' else '')
                if s2.get('phase') == 'done' and s2.get('outputs'):
                    v2 = json.loads(download(page, s2['outputs'][0]['name'], v2p).read_text())
                    atts = next((p['attestations'] for p in v2['spatialEntities'] if p['@id'] == a + 'newton'), [])
                    got['answers'] = sorted(('not ' if x.get('negated') else '') + x['identities'][0]['object'].rsplit('/', 1)[-1] for x in atts if x.get('identities'))
                    got['metas'] = [x for x in atts if x.get('meta')]
                    with page.expect_download(timeout=30_000) as d: page.click('#save-review')
                    d.value.save_as(saved2); w = json.loads(saved2.read_text())
                    got['kept'] = {'draft_answers': w.get('draft_answers'), 'finished': len(w.get('finished') or [])}
    except Exception as e: got['error'] = str(e).split('\n')[0][:200]
    check('withdraw, draft: the Finish area offers withdraw (keep the history) by default; chosen, replace takes the earlier answer out of the draft, writes the denial, and retracts nothing',
          got.get('default') == 'withdraw' and got.get('answers') == ['not newton'] and got.get('metas') == [] and (got.get('report') or {}).get('answers-replaced') == 1
          and ((got.get('counts') or {}).get('versionCheck') or {}).get('replaced') == 1, got)
    check('withdraw, draft: the choice to replace is kept in the review saved after Finish, with the Finish recorded, and the result says to save the review again',
          got.get('says') is True and (got.get('kept') or {}).get('draft_answers') == 'replace' and (got.get('kept') or {}).get('finished') == 1, got.get('kept') or got)
    m = compare_case(page, v2p, v1p) if got.get('answers') else {}
    items = (m.get('report') or {}).get('items', [])
    check('withdraw, draft: the version check finds no answer both ways once the earlier one is replaced, and says, as a warning, what went from the draft',
          m.get('phase') == 'done' and (m.get('report') or {}).get('errors') == 0 and not any(i['kind'] == 'answered-both-ways' for i in items)
          and any(i['kind'] == 'attestation-removed' and i['severity'] == 'warning' for i in items), m.get('report') or m)

def krisis_withdraw_case(page, tmp):
    """Krisis: a decision changed after Finish withdraws the earlier answer. Review, Finish into the dataset, resume the
    review on the dataset written, change the decision, Finish again: the dataset has exactly one current answer and the
    retraction, and the version check passes it. The control: the same without the change writes nothing new. And the
    version check on the page finds the change without its retraction (answered both ways)."""
    a, b = 'https://example.org/wa/', 'https://example.org/wb/'
    subjects = tmp / 'withdraw-subjects.json'; others = tmp / 'withdraw-others.json'
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': a, 'title': 'Our places', 'status': 'published', 'version': '1'},
                                    'spatialEntities': [krisis_place(a + 'newton', 'Newton', -1.0, 52.0)]}))
    others.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': b, 'title': 'Their places'},
                                  'spatialEntities': [krisis_place(b + 'newton', 'Newton', -1.01, 52.01)]}))
    saved, v1p, v2p = tmp / 'withdraw.krisis.json', tmp / 'withdraw-v1.json', tmp / 'withdraw-v2.json'
    def finish(what):
        page.check('input[name="review-output"][value="dataset"]')
        page.click('#finish')
        return wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, what)
    def first():
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
        s = match_case(page, subjects, others)
        if s.get('phase') != 'reviewing': return False, s
        if page.is_visible('#review-name'): page.fill('#review-name', 'Ada Reviewer'); page.press('#review-name', 'Enter')
        page.keyboard.press('a')
        s = wait_state(page, lambda s: s.get('phase') == 'reviewing' and (s.get('review') or {}).get('reviewed') == 1, 10, 'decision')
        with page.expect_download(timeout=30_000) as d: page.click('#save-review')
        d.value.save_as(saved)
        s = finish('finish')
        if s.get('phase') != 'done' or not s.get('outputs'): return False, s.get('report') or s
        download(page, s['outputs'][0]['name'], v1p)
        return True, s
    ok, s1 = False, {}
    try: ok, s1 = first()
    except Exception as e: s1 = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    newton = lambda doc: next((p.get('attestations', []) for p in doc.get('spatialEntities', []) if p.get('@id') == a + 'newton'), [])
    def current(doc):
        atts = newton(doc)
        gone = {x['meta']['targetAttestation'] for x in atts if (x.get('meta') or {}).get('metaType', '').endswith(('#Retracts', '#Supersedes'))}
        return sorted(('not ' if x.get('negated') else '') + ' '.join(r.get('object', '').rsplit('/', 1)[-1] for r in x['identities']) for x in atts if x.get('identities') and x.get('@id') not in gone)
    v1 = json.loads(v1p.read_text()) if ok else {}
    answer = next((x for x in newton(v1) if x.get('identities')), {})
    check('withdraw: the first Finish writes one answer, with an address in Agora\'s form', ok and current(v1) == ['newton']
          and re.fullmatch(re.escape(a + 'newton') + r'#a-[0-9a-f]{8}', answer.get('@id', '')), s1 if not ok else newton(v1))
    def again(change):
        page.set_input_files('#picker', [str(v1p)])
        wait_state(page, lambda s: s.get('phase') == 'detected', 30, 'detection')
        page.set_input_files('#workfile', [str(saved)])
        s = wait_state(page, lambda s: s.get('phase') == 'reviewing', 20, 'resume')
        if s.get('phase') != 'reviewing': return s, None
        if change:
            page.keyboard.press('d'); page.keyboard.type('The mill, not the village'); page.keyboard.press('Enter')
            s = wait_state(page, lambda s: any((c.get('decision') or {}).get('kind') == 'distinct' for c in (s.get('work') or {}).get('candidates', [])), 10, 'changed')
        s = finish('finish again')
        doc = json.loads(download(page, s['outputs'][0]['name'], v2p).read_text()) if s.get('phase') == 'done' and s.get('outputs') else None
        return s, doc
    # The control first: resumed on the dataset written and finished again with no change, nothing new is written.
    c = {}
    if ok:
        try: c, cdoc = again(False); c = {'phase': c.get('phase'), 'outputs': c.get('outputs'), 'items': {i['kind']: i.get('count') for i in (c.get('report') or {}).get('items', [])}}
        except Exception as e: c = {'error': str(e).split('\n')[0][:200]}
    check('withdraw (control): finished again on the dataset written, with no decision changed, nothing new is written, and the page says so',
          c.get('phase') == 'done' and not c.get('outputs') and 'nothing-new' in (c.get('items') or {}) and (c.get('items') or {}).get('already-answered') == 1
          and 'is in the dataset already' in (page.inner_text('#report') if c.get('phase') == 'done' else ''), c)
    s2, v2 = {}, None
    if ok:
        try: s2, v2 = again(True)
        except Exception as e: s2 = {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    v2 = v2 or {}
    retractions = [x for x in newton(v2) if (x.get('meta') or {}).get('metaType') == 'https://w3id.org/plato#Retracts']
    summ = page.inner_text('#summary') if s2.get('phase') == 'done' else ''
    check('withdraw: the decision changed and finished again, the dataset has exactly one current answer (the denial) and the retraction of the first, which it keeps',
          s2.get('phase') == 'done' and current(v2) == ['not newton'] and len(retractions) == 1 and retractions[0]['meta']['targetAttestation'] == answer.get('@id')
          and any(x.get('@id') == answer.get('@id') and x.get('identities') == answer.get('identities') for x in newton(v2))
          and ((s2.get('report') or {}).get('counts') or {}).get('versionCheck', {}).get('retracted') == 1 and 'withdrawing an earlier answer' in summ,
          {'current': current(v2), 'summary': summ, 'report': (s2.get('report') or {}).get('items')} if v2 else s2)
    # The version check on the page, as a user would run it on the two versions: it passes, and counts the retraction.
    m = compare_case(page, v2p, v1p) if v2 else {}
    check('withdraw: the version check passes the dataset written against the first, counting one answer retracted',
          m.get('phase') == 'done' and (m.get('report') or {}).get('errors') == 0 and ((m.get('report') or {}).get('counts') or {}).get('retracted') == 1
          and not any(i['kind'] == 'answered-both-ways' for i in (m.get('report') or {}).get('items', [])), m.get('report') or m)
    # And without the retraction, the same change is answered both ways: the check can find it.
    bad = {}
    if v2:
        badp = tmp / 'withdraw-v2-unretracted.json'
        d = json.loads(v2p.read_text())
        for p in d['spatialEntities']:
            p['attestations'] = [x for x in p.get('attestations', []) if not (x.get('meta') or {}).get('metaType', '').endswith('#Retracts')]
        badp.write_text(json.dumps(d))
        bad = compare_case(page, badp, v1p)
    found = next((i for i in (bad.get('report') or {}).get('items', []) if i['kind'] == 'answered-both-ways'), None)
    check('withdraw: the version check finds the change without its retraction answered both ways, and names the reviewer and the places',
          found is not None and found['severity'] == 'error' and any('Ada Reviewer' in x and a + 'newton' in x and b + 'newton' in x for x in found.get('examples', [])), bad.get('report') or bad)

def krisis_pattern_match(page, tmp):
    """Krisis with a Hermes column pattern: a CSV column of Pleiades ids, its suggested pattern ticked,
    is matched by the same column options a Hermes run is given, so the review's places are the
    pattern-built Pleiades addresses; unticked (the control), they are not."""
    table = tmp / 'krisis-pleiades.csv'; others = tmp / 'krisis-pleiades-others.json'
    table.write_text('id,name,pleiades_id,lat,lon\n1,Athenae,579885,37.97,23.72\n2,Roma,423025,41.89,12.49\n')
    b = 'https://example.org/b/'
    others.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': b, 'title': 'Their places'}, 'spatialEntities': [
        krisis_place(b + 'athens', 'Athenae', 23.72, 37.97), krisis_place(b + 'rome', 'Roma', 12.49, 41.89)]}))
    def matched(tick):
        try:
            page.reload(); r = wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            if r.get('phase') != 'ready': return {'ready': r.get('phase')}
            page.evaluate("() => { document.getElementById('base').value = 'https://example.org/a/'; }")
            page.set_input_files('#picker', [str(table)])
            s = wait_state(page, lambda s: (s.get('columns') or {}).get('mapping'), 60, 'columns')
            if not (s.get('columns') or {}).get('mapping'): return {'columns': None}
            if tick: page.locator('#columns input[data-pattern-column]').check()
            page.wait_for_function("() => !document.getElementById('match').disabled", timeout=30_000)
            page.set_input_files('#others', [str(others)])
            s = wait_state(page, lambda s: s.get('phase') in ('reviewing', 'error'), 120, 'matching')
            w = s.get('work') or {}
            return {'phase': s.get('phase'), 'sources': sorted(c['candidate_source'] for c in w.get('candidates', [])),
                    'columns': (w.get('match_parameters') or {}).get('columns')}
        except Exception as e: return {'error': str(e).split('\n')[0][:200]}
    on, off = matched(True), matched(False)
    pattern = 'https://pleiades.stoa.org/places/{id}'
    check('match review: a CSV column with a confirmed Pleiades pattern is matched by the pattern-built addresses, kept in the work file; unconfirmed, it is not',
          on.get('phase') == 'reviewing' and on.get('sources') == ['https://pleiades.stoa.org/places/423025', 'https://pleiades.stoa.org/places/579885']
          and (on.get('columns') or {}).get('pleiades_id') == {'field': 'address', 'pattern': pattern}
          and off.get('phase') == 'reviewing' and len(off.get('sources') or []) == 2 and not any('pleiades' in x for x in off['sources'])
          and (off.get('columns') or {}).get('pleiades_id') == 'note', {'on': on, 'off': off})

def krisis_seams(page, tmp, subjects):
    """Where Hermes's readers meet Krisis: a refused file as the other dataset, and a table's columns as chosen."""
    # A IIIF Georeference Annotation as the other dataset is refused with its reason, as a finding,
    # not as a fault in the tools; the match of two PLATO files (krisis_case) is the control.
    geo = {}
    try:
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
        s = match_case(page, subjects, GEOREF)
        said = [i for i in (s.get('report') or {}).get('items', []) if i.get('kind') == 'not-recognised']
        geo = {'phase': s.get('phase'), 'action': s.get('action'), 'shown': page.inner_text('#result'), 'reason': (said[0].get('examples') or [''])[0] if said else ''}
    except Exception as e: geo = {'error': str(e).split('\n')[0][:200]}
    shown = geo.get('shown', '')
    check('match review: a IIIF Georeference Annotation as the other dataset is refused with its reason, not as something gone wrong',
          geo.get('action') == 'match' and geo.get('phase') == 'done' and 'The other dataset was not recognised' in shown
          and 'IIIF Georeference Annotation' in geo.get('reason', '') and 'Something went wrong' not in shown, geo)
    # A table of places is matched by its columns as chosen on the page: the guess takes "label" for
    # the name, and only with "town" chosen as the name are the places matched.
    table = tmp / 'krisis-roman.csv'
    table.write_text('id,label,town,lat,lon\nbristol,Port,Bristoll,51.4500,-2.5900\nbath,Spa Site,Bathe,51.3800,-2.3600\n')
    def table_match(choices):
        try:
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            page.evaluate("() => { document.getElementById('base').value = 'https://example.org/t/'; }")
            s = table_case(page, table, choices)
            if not (s.get('columns') or {}).get('mapping'): return s
            page.set_input_files('#others', [str(subjects)])
            return wait_state(page, lambda s: s.get('phase') in ('reviewing', 'error') or (s.get('action') == 'match' and s.get('phase') == 'done'), 120, 'matching')
        except Exception as e: return {'phase': 'harness-error', 'error': str(e).split('\n')[0][:200]}
    guessed = table_match(None)
    chosen = table_match({'town': 'name', 'label': 'note'})
    pairs = lambda s: sorted((c['candidate_source'].rsplit('/', 1)[-1], c['candidate_candidate'].rsplit('/', 1)[-1]) for c in (s.get('work') or {}).get('candidates', []))
    params = (chosen.get('work') or {}).get('match_parameters') or {}
    check('match review: a table of places is matched by its columns as chosen on the page, not as guessed, and the work file keeps the matching',
          guessed.get('phase') == 'reviewing' and 'candidates' in (guessed.get('work') or {}) and pairs(guessed) == []
          and chosen.get('phase') == 'reviewing' and pairs(chosen) == [('bath', 'bath'), ('bristol', 'bristol')]
          and (params.get('columns') or {}).get('town') == 'name' and (params.get('columns') or {}).get('label') == 'note',
          {'guessed': pairs(guessed), 'chosen': pairs(chosen), 'columns': params.get('columns'), 'state': chosen if not pairs(chosen) else ''})
    krisis_table_review(page, tmp, table, subjects, chosen)

def krisis_table_review(page, tmp, table, subjects, chosen):
    """A table of places in a review: Match waits for the matching of its columns, and a resumed review
    shows, locks and finishes by the matching it was made with."""
    # Match waits for the worker's answer about the columns: at the moment the table is seen, Match is
    # not to be pressed (it would read the table by the guess), and once the answer is in, it may be.
    gate = {}
    try:
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
        page.evaluate("""() => { const st = window.__plato; let ph = st.phase; window.__matchAtDetected = [];
            Object.defineProperty(st, 'phase', { configurable: true, enumerable: true, get() { return ph; },
              set(v) { ph = v; if (v === 'detected') window.__matchAtDetected.push(document.getElementById('match').disabled); } }); }""")
        page.set_input_files('#picker', [str(table)])
        s = wait_state(page, lambda s: (s.get('columns') or {}).get('mapping'), 60, 'columns')
        gate = {'at detected': page.evaluate('() => window.__matchAtDetected'), 'after columns': page.evaluate("() => document.getElementById('match').disabled"), 'columns': bool((s.get('columns') or {}).get('mapping'))}
    except Exception as e: gate = {'error': str(e).split('\n')[0][:200]}
    check('match review: Match waits for the matching of a table\'s columns, and may be pressed once it is shown',
          gate.get('at detected') == [True] and gate.get('after columns') is False and gate.get('columns'), gate)
    # A review of the table matched by the columns as chosen ("town" the name), resumed with the table
    # chosen again (whose guess is "label" the name): the page shows the review's matching, locked.
    work = chosen.get('work') or {}
    res = {}
    if work.get('candidates'):
        try:
            c = work['candidates'][0]
            c.update({'candidate_status': 'confirmed', 'decision': {'kind': 'match', 'identityType': 'exactMatch', 'decided_at': '2026-10-01T09:00:00Z'}})
            work['reviewer'] = {'name': 'Ada Reviewer'}
            (tmp / 'table.krisis.json').write_text(json.dumps(work))
            (tmp / 'other-columns.json').write_text(json.dumps({'id': 'id', 'label': 'name', 'town': 'note', 'lat': 'latitude', 'lon': 'longitude'}))
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            page.evaluate("() => { document.getElementById('base').value = 'https://example.org/t/'; }")
            page.set_input_files('#picker', [str(table)])
            wait_state(page, lambda s: (s.get('columns') or {}).get('mapping'), 60, 'columns')
            guess = page.evaluate("() => ({ ...window.__plato.columns.mapping })")
            locks = {'before': page.evaluate(LOCK_NOTE)}
            page.set_input_files('#workfile', [str(tmp / 'table.krisis.json')])
            s = wait_state(page, lambda s: s.get('phase') == 'reviewing' and s.get('reviewColumns') and not s.get('columnsPending'), 60, 'resume')
            shown = page.evaluate("() => Object.fromEntries([...document.querySelectorAll('#columns select[data-column]')].map((x) => [x.closest('tr').querySelector('code').textContent, [x.value, x.disabled]]))")
            locks['review'] = page.evaluate(LOCK_NOTE)
            page.click('#finish')
            f = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, 'finish')
            locks['finished'] = page.evaluate(LOCK_NOTE)
            same = [i.get('kind') for i in (f.get('report') or {}).get('items', [])]
            # The control: another matching loaded after all is sent with Finish, and said to differ.
            page.set_input_files('#columns-file', [str(tmp / 'other-columns.json')])
            wait_state(page, lambda s: any('other-columns.json' in m for m in (s.get('columns') or {}).get('messages', [])), 30, 'load')
            page.click('#finish')
            g = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error') and s.get('report') is not None, 120, 'finish again')
            res = {'guess': guess, 'shown': shown, 'locks': locks, 'phase': f.get('phase'), 'same': same, 'other phase': g.get('phase'), 'other': [i.get('kind') for i in (g.get('report') or {}).get('items', [])]}
        except Exception as e: res = {'error': str(e).split('\n')[0][:200]}
    shown = res.get('shown') or {}
    check('match review: a resumed review of a table shows the matching of columns it was made with, not the guess, and the choices are locked',
          (res.get('guess') or {}).get('label') == 'name' and shown.get('town') == ['name', True] and shown.get('label') == ['note', True], res)
    check('match review: Finish reads the table as the review did, and says nothing of the columns; another matching loaded is said to differ',
          res.get('phase') == 'done' and 'columns-differ' not in res.get('same', ['x']) and res.get('other phase') == 'done' and 'columns-differ' in res.get('other', []), res)
    # The locked choices say why, beside them, while the review is open and after Finish; before the
    # review, with the choices open, the note is not shown (the control).
    locks = res.get('locks') or {}
    said = lambda k: (locks.get(k) or {}).get('note') or ''
    check('match review: the column choices say why they are locked exactly while a review is open, after Finish too',
          (locks.get('before') or {}).get('open') is True and (locks.get('before') or {}).get('note') is None
          and all((locks.get(k) or {}).get('locked') is True and said(k).startswith('Locked while a review is open') for k in ('review', 'finished')), locks)
    # Cancel while the matching of a resumed review's columns is still being worked out: the worker is
    # held at that request and at Check's run (as a large table would hold it), then Cancel ends it (and the
    # new worker's 'ready' follows 'cancelled').
    # The answer is asked for again, by the review's matching, so Match and Finish do not wait for ever.
    cancel = {}
    if work.get('candidates'):
        try:
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            page.evaluate("() => { document.getElementById('base').value = 'https://example.org/t/'; }")
            page.set_input_files('#picker', [str(table)])
            wait_state(page, lambda s: (s.get('columns') or {}).get('mapping'), 60, 'columns')
            page.evaluate("""() => { const send = Worker.prototype.postMessage, hold = new Set(['columns', 'run']); window.__held = [];
                Worker.prototype.postMessage = function (m, ...rest) { if (m && hold.has(m.cmd)) { hold.delete(m.cmd); window.__held.push(m.cmd); return; } return send.call(this, m, ...rest); }; }""")
            page.set_input_files('#workfile', [str(tmp / 'table.krisis.json')])
            p = wait_state(page, lambda s: s.get('phase') == 'reviewing' and s.get('columnsPending'), 30, 'resume')
            page.click('#check')
            r = wait_state(page, lambda s: s.get('phase') == 'running', 30, 'check')
            page.click('#cancel')
            s = wait_state(page, lambda s: s.get('phase') in ('cancelled', 'ready') and s.get('reviewColumns') and not s.get('columnsPending'), 30, 'columns after cancel')
            cancel = {'pending at resume': p.get('columnsPending'), 'running': r.get('phase'), 'held': page.evaluate('() => window.__held'),
                      'phase': s.get('phase'), 'pending': s.get('columnsPending'), 'review columns': s.get('reviewColumns'),
                      'buttons': page.evaluate("() => ['match', 'finish'].map((id) => document.getElementById(id).disabled)"),
                      'looking': 'Reading the columns' in page.inner_text('#columns')}
        except Exception as e: cancel = {'error': str(e).split('\n')[0][:200]}
    check('match review: Cancel while a resumed review\'s columns are still being read asks for them again, by the review\'s matching, and Match and Finish are free',
          cancel.get('pending at resume') is True and cancel.get('running') == 'running' and cancel.get('held') == ['columns', 'run']
          and cancel.get('phase') in ('cancelled', 'ready') and cancel.get('pending') is False and (cancel.get('review columns') or {}).get('town') == 'name'
          and cancel.get('buttons') == [False, False] and cancel.get('looking') is False, cancel)

# Krisis: the note beside a table's column choices, as shown (None when hidden), and whether every choice is locked, or every one open.
LOCK_NOTE = """() => { const n = document.getElementById('columns-locked'), sels = [...document.querySelectorAll('#columns select[data-column]')];
    return { note: n && !n.hidden && n.offsetParent !== null ? n.textContent : null, locked: sels.length > 0 && sels.every((x) => x.disabled), open: sels.length > 0 && sels.every((x) => !x.disabled) }; }"""

# Krisis: gazetteer lookup. WHG is never called: page.route answers for it, as a fake reconciliation
# service (the answers are shaped as src/engine/gazetteer/whg.js says WHG's are), and records each request.
LOOKUP_TOKEN = 'e2e-SECRET-whg-token-7f3a91c0'
LOOKUP_ATTRIBUTION = {'whg': {'license': 'CC-BY-4.0'}, 'sources': {
    'gn': {'license': {'spdx_id': 'CC-BY-4.0', 'permits_commercial': True, 'no_derivatives': False}, 'redistributable': True},
    'nc': {'license': {'spdx_id': 'CC-BY-NC-4.0', 'permits_commercial': False, 'no_derivatives': False}, 'redistributable': True}}}
LOOKUP_ANSWERS = {
    # WHG's own order puts Australia first, and all three score 100: its score is relative within one answer.
    'Newcastle': [
        {'id': 'place:osm:2155472', 'name': 'Newcastle', 'score': 100, 'match': True, 'description': 'Country: AU', 'ccodes': ['AU'], 'repr_point': [151.7765, -32.9272], 'namespace': 'osm', 'alt_names': []},
        {'id': 'place:nc:3354071', 'name': 'Newcastle', 'score': 100, 'match': True, 'description': 'Country: NA', 'ccodes': ['NA'], 'repr_point': [17.0833, -22.5667], 'namespace': 'nc', 'alt_names': []},
        {'id': 'place:gn:2641673', 'name': 'Newcastle upon Tyne', 'score': 100, 'match': False, 'description': 'Country: GB', 'ccodes': ['GB'], 'repr_point': [-1.6132, 54.9733], 'namespace': 'gn', 'alt_names': ['Newcastle'], 'confidence': 92}],
    'York': [{'id': 'place:gn:2633352', 'name': 'York', 'score': 100, 'match': True, 'ccodes': ['GB'], 'repr_point': [-1.0827, 53.9576], 'namespace': 'gn'}],
    'Zennor Churchtown': [{'id': 'place:gn:2633485', 'name': 'Zennor', 'score': 100, 'match': False, 'ccodes': ['GB'], 'repr_point': [-5.566, 50.191], 'namespace': 'gn'}],
}

def krisis_lookup_case(page, tmp, url):
    """Krisis, gazetteer lookup: not allowed, one line to the Permissions panel and nothing sent; allowed, the panel,
    the preview, a quota stop and Resume, the review screen's additions, one place looked up, Finish citing WHG;
    a permission withdrawn and a redirect refused; and the token nowhere but the Authorization header."""
    import re
    from collections import Counter
    a = 'https://example.org/l/'
    subjects = tmp / 'krisis-lookup.json'
    places = [krisis_place(a + 'newcastle', 'Newcastle', -1.6178, 54.9783), krisis_place(a + 'atlantis', 'Atlantis', -20.0, 35.0),
              krisis_place(a + 'zennor', 'Zennor', -5.5680, 50.1910, 'Senara'), krisis_place(a + 'york', 'York', -1.0819, 53.9590)]
    places += [krisis_place(a + f'filler-{i:02}', f'Filler {i:02}', -3.0 + i / 100, 52.0) for i in range(26)]   # 30 places: two requests of 25
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': a, 'title': 'Places to look up'}, 'spatialEntities': places}))
    calls, consoled, quota_on = [], [], {'n': 2}
    held = {'on': False, 'routes': []}   # while on, requests are held, to be answered by the test (answer_whg)
    redirect = {'on': False}   # while on, WHG answers by sending the request elsewhere (302)
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    vocab = []   # the review's anonymous GET of WHG's labels for kinds of place (#20): no lookup, so not among the calls
    def fake_whg(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        if req.method == 'GET' and req.url.endswith('/types/vocab/'):
            vocab.append({'url': req.url, 'headers': req.all_headers()})
            return route.fulfill(status=404, headers={**cors, 'Content-Type': 'application/json'}, body='{"detail": "Not found"}')
        calls.append({'url': req.url, 'headers': req.all_headers(), 'body': req.post_data or ''})
        if redirect['on']: return route.fulfill(status=302, headers={**cors, 'Location': 'https://elsewhere.example/reconcile'}, body='')
        if held['on']: held['routes'].append(route); return
        answer_whg(route)
    def answer_whg(route, status=200):
        req = route.request
        if status != 200:
            return route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps({'detail': 'Invalid token.'}))
        if len(calls) == quota_on['n']:
            return route.fulfill(status=401, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps({'detail': 'Daily API limit exceeded'}))
        out = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in json.loads(req.post_data)['queries'].items():
            # Atlantis: the gateway did not answer, which is not "no match".
            out[k] = {'result': [], 'gateway': 'timeout'} if q['query'] == 'Atlantis' else {'result': LOOKUP_ANSWERS.get(q['query'], [])}
        route.fulfill(status=200, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(out))
    page.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), fake_whg)
    page.on('console', lambda m: consoled.append(m.text))
    asked = []   # every request the page made to WHG, whether or not it reached the route (the policy may stop it first)
    page.on('request', lambda r: asked.append(r.url) if 'whgazetteer.org' in r.url else None)
    has = lambda hay: LOOKUP_TOKEN in (hay if isinstance(hay, str) else json.dumps(hay))
    lk = lambda s: s.get('lookup') or {}
    def step(fn, default):
        try: return fn()
        except Exception as e: return {**(default if isinstance(default, dict) else {}), 'error': str(e).split('\n')[0][:200]}

    # Not allowed: from a clean slate (no permission, no token, a page loaded with neither), the panel
    # shows the preview (what would be sent is information), ONE line to the Permissions panel in place
    # of Send, no privacy paragraph of its own, and nothing is sent, even if Send is clicked by script.
    PERM = '#lookup-permission'
    def choose():
        page.set_input_files('#picker', [str(subjects)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return s
        page.evaluate("() => { const r = document.getElementById('reviewer'); if (!r.value) { r.value = 'Lu Reviewer'; r.dispatchEvent(new Event('change')); } }")
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        return s
    def not_allowed():
        page.goto(NOTOOLS if PROVE else url)
        page.evaluate("() => { localStorage.removeItem('plato-tools.permissions'); sessionStorage.clear(); }")
        page.goto(NOTOOLS if PROVE else url)
        r = wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('canary') in ('enforced', 'not-enforced'), T(30), 'ready')
        if choose().get('phase') != 'detected': return {'phase': 'not detected', 'canary': r.get('canary')}
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        page.wait_for_function("() => /Would look up 30 places/.test(document.getElementById('lookup-preview').textContent)", timeout=60_000)
        page.wait_for_function("() => !document.getElementById('lookup-permission').hidden", timeout=10_000)
        before, said_before = len(calls) + len(asked), len(consoled)
        page.evaluate("() => document.getElementById('lookup-send').click()")   # hidden: a script's click, which must send nothing either
        page.wait_for_timeout(1500)
        # A request the policy stopped would not reach page.on('request') either, so "nothing asked" alone cannot
        # tell the page's own gate from the policy: the policy says "Refused to connect" in the console when it stops one.
        refused_during = [m for m in consoled[said_before:] if 'Refused to connect' in m]
        # The control: a request to a site not in the policy (routed, so it could go nowhere even if let through) IS
        # reported so in the console captured, so the absence above is evidence.
        page.route('https://refused.example/**', lambda route: route.abort())
        page.evaluate("() => { fetch('https://refused.example/x').catch(() => {}); }")
        page.wait_for_timeout(1000)
        page.unroute('https://refused.example/**')
        refused_control = [m for m in consoled[said_before:] if 'Refused to connect' in m and 'refused.example' in m]
        out = {'phase': 'shown', 'canary': r.get('canary'), 'policy': page.evaluate('() => (window.__platoCsp || {}).origins || null'),
               'line': page.inner_text(PERM), 'lines': page.eval_on_selector_all('#lookup .needs-permission', 'els => els.filter((e) => !e.hidden).length'),
               'send shown': page.is_visible('#lookup-send'), 'preview': page.inner_text('#lookup-preview'),
               'first': page.eval_on_selector_all('.lookup-queries code', 'els => els.map((e) => e.textContent)'),
               'privacy': page.eval_on_selector_all('#lookup .lookup-privacy', 'els => els.length'), 'panel text': page.inner_text('#lookup'),
               'sent': len(calls) + len(asked) - before, 'refused during': refused_during, 'refused control': len(refused_control), 'focus after send': page.evaluate('() => document.activeElement && document.activeElement.closest("#lookup-permission") ? "line" : null')}
        # The line's button opens the Permissions panel at WHG's entry, where the token's scope is stated.
        page.click(PERM + ' button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        out['opened'] = page.evaluate(PANEL_STATE)
        out['permissions panel'] = page.inner_text('#permissions-panel')
        return out
    na = step(not_allowed, {})
    vocab_not_allowed = len(vocab)   # the review's labels for kinds are asked for only once WHG is allowed
    nfirst = [json.loads(x) for x in na.get('first', [])]
    check('lookup, not allowed: the page loaded with no gazetteer allowed shows ONE line, "Needs permission: World Historical Gazetteer", in place of Send',
          na.get('canary') == 'enforced' and na.get('policy') == [] and na.get('line', '').startswith('Needs permission: World Historical Gazetteer')
          and 'Permissions' in na.get('line', '') and na.get('lines') == 1 and na.get('send shown') is False, na)
    check('lookup, not allowed: the preview of exactly what would be sent is still shown (information, not consent)',
          'Would look up 30 places in World Historical Gazetteer' in na.get('preview', '') and len(nfirst) == 20 and nfirst[0] == {'query': 'Newcastle', 'type': 'Place', 'limit': 10}, na)
    check('lookup, not allowed: Send pressed by script sends nothing (no request to WHG made, routed or not), and the line takes the focus',
          na.get('phase') == 'shown' and na.get('sent') == 0 and not calls and not asked and na.get('focus after send') == 'line', {k: na.get(k) for k in ('phase', 'sent', 'focus after send', 'error')})
    check('lookup, not allowed: it is the page that sent nothing, not the policy that stopped it: no "Refused to connect" in the console then (the control: a request the policy stops IS reported there)',
          na.get('phase') == 'shown' and na.get('refused during') == [] and na.get('refused control', 0) >= 1, {k: na.get(k) for k in ('phase', 'refused during', 'refused control', 'error')})
    check("lookup: no privacy paragraph or consent of its own in the lookup panel (the panel's own text is there, the control)",
          na.get('privacy') == 0 and 'Which places' in na.get('panel text', '') and 'Your WHG token' in na.get('panel text', '')
          and 'optional and goes online' not in na.get('panel text', '') and 'forgotten when the tab is closed' not in na.get('panel text', '') and 'No token is sent' not in na.get('panel text', ''), na.get('panel text', na))
    check("lookup, not allowed: the line's button opens the Permissions panel at the World Historical Gazetteer's entry",
          (na.get('opened') or {}).get('open') is True and (na.get('opened') or {}).get('focusKey') == 'gazetteer:whg', na.get('opened') or na)
    pt = na.get('permissions panel', '')
    check("lookup: the token's scope is stated in the Permissions panel (kept for the tab unless remembered, what remembering means), not in the lookup panel",
          'World Historical Gazetteer token' in pt and 'A token is held' in pt and 'Remember my token in this browser' in pt
          and 'forgotten when the tab is closed' in pt and 'any Pelagios site' in pt and 'forgotten when' not in na.get('panel text', 'forgotten when'), pt[:600])

    # Allowed in the panel: a permission allowed since the page loaded is used from the next load, so the
    # panel offers the reload (asking first, as the files chosen would be lost); the token is kept for the tab.
    def allow():
        page.check('#permissions-panel fieldset.perm[data-key="gazetteer:whg"] input[value="allowed"]')
        page.click('#permissions-panel [data-reload]')
        confirm = page.is_visible('#permissions-panel [data-reload-confirmed]')
        with page.expect_navigation(timeout=30_000): page.click('#permissions-panel [data-reload-confirmed]')
        s = wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('canary') in ('enforced', 'not-enforced'), T(30), 'ready')
        return {'confirm': confirm, 'canary': s.get('canary'), 'policy': page.evaluate('() => (window.__platoCsp || {}).origins || null'),
                'kept token': page.evaluate("() => !!sessionStorage.getItem('plato-tools.whg-token')"), 'sent': len(calls) + len(asked)}
    al = step(allow, {}) if na.get('opened') else {}
    check('lookup: allowed in the panel, and the page reloaded (asked first, the files chosen being lost), WHG is in its policy; still nothing sent',
          al.get('confirm') is True and al.get('canary') == 'enforced' and 'https://whgazetteer.org' in (al.get('policy') or []) and al.get('kept token') is True and al.get('sent') == 0, al)

    # The panel, the token, the preview, once allowed.
    def open_panel():
        s = choose()
        if s.get('phase') != 'detected': return {'phase': s.get('phase')}
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        page.wait_for_function("() => /^Send 30 queries to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", timeout=60_000)
        return {'phase': 'open', 'line hidden': page.evaluate("() => document.getElementById('lookup-permission').hidden"), 'send shown': page.is_visible('#lookup-send'),
                'field': page.input_value('#whg-token'),
                'session': page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token')"),
                'local': page.evaluate("() => localStorage.getItem('plato-tools.whg-token')"), 'tokenState': page.inner_text('#whg-token-state'),
                'preview': page.inner_text('#lookup-preview'), 'first': page.eval_on_selector_all('.lookup-queries code', 'els => els.map((e) => e.textContent)'),
                'send': page.inner_text('#lookup-send'), 'filters': page.evaluate("() => ['lookup-countries', 'lookup-near', 'lookup-all-names'].map((id) => document.getElementById(id).checked)")}
    o = step(open_panel, {}) if al.get('canary') == 'enforced' else {}
    check('lookup, allowed: Send is offered and the line is gone', o.get('phase') == 'open' and o.get('line hidden') is True and o.get('send shown') is True, o)
    check('lookup: the token is kept for the tab (sessionStorage), not in the field and not in localStorage unless remembered',
          o.get('session') == LOOKUP_TOKEN and o.get('local') is None and o.get('field') == '' and o.get('tokenState', '') == 'Token kept for this tab only', {k: v for k, v in o.items() if k in ('field', 'local', 'tokenState', 'error')})
    first = [json.loads(x) for x in o.get('first', [])]
    check('lookup: the preview gives places, queries, requests and the share of the allowance, filters off, and the first 20 queries exactly',
          'Would look up 30 places in World Historical Gazetteer: 30 queries in 2 requests' in o.get('preview', '') and "under 1% of WHG's allowance of 5,000 requests a day" in o.get('preview', '')
          and 'label only' in o.get('preview', '') and o.get('filters') == [False, False, False] and len(first) == 20
          and first[0] == {'query': 'Newcastle', 'type': 'Place', 'limit': 10} and o.get('send') == 'Send 30 queries to WHG', o)

    # Sending: the second request finds the day's allowance spent.
    def send():
        page.click('#lookup-send')
        s = wait_state(page, lambda s: lk(s).get('running') is False, 60, 'lookup')
        return {**s, 'progress': page.inner_text('#lookup-progress'), 'resume': page.inner_text('#lookup-resume') if page.is_visible('#lookup-resume') else None}
    s = step(send, {}) if o.get('phase') == 'open' else {}
    q1 = ((s.get('work') or {}).get('lookups') or [{}])[0].get('queries', {})
    states = dict(Counter(v['state'] for v in q1.values()))
    check('lookup, allowed: the request IS sent (the positive control for "nothing sent" above)', o.get('phase') == 'open' and len(calls) >= 1 and len(asked) >= 1 and na.get('sent') == 0, {'calls': len(calls), 'asked': len(asked)})
    check('lookup: the first 20 queries in the preview are those WHG received', bool(calls) and bool(first) and list(json.loads(calls[0]['body'])['queries'].values())[:20] == first, calls[:1])
    check('lookup: a quota stop keeps what was answered, says so in words, and offers Resume',
          lk(s).get('stopped') == 'quota' and states == {'answered': 24, 'unanswered': 1, 'stopped': 5} and "WHG's daily limit for this token is reached; it resets tomorrow" in s.get('progress', '')
          and s.get('resume') == 'Resume: send 6 queries' and s.get('phase') == 'reviewing', {'lookup': lk(s), 'states': states, 'progress': s.get('progress'), 'resume': s.get('resume')})

    # The review screen: Newcastle, its candidates from WHG in the lookup's order, not WHG's and not by name.
    def newcastle():
        return {'subject': page.inner_text('#review-subject'), 'iris': page.eval_on_selector_all('#review-place li.candidate .iri', 'els => els.map((e) => e.textContent)'),
                'groups': page.eval_on_selector_all('#review-place h4.source', 'els => els.map((e) => e.textContent)'),
                'cands': page.eval_on_selector_all('#review-place li.candidate', 'els => els.map((e) => ({ text: e.innerText, far: !!e.querySelector(".far"), warn: !!e.querySelector(".licence.warn") }))')}
    n = step(newcastle, {}) if s.get('phase') == 'reviewing' else {}
    W3 = 'https://w3id.org/whg/id/'
    cs = n.get('cands') or [{}, {}, {}]
    check('lookup: three Newcastles grouped "From World Historical Gazetteer", ranked by distance (Tyne first; WHG gave Australia first), the far ones shown and marked',
          n.get('subject') == 'Newcastle' and n.get('groups') == ['From World Historical Gazetteer'] and n.get('iris') == [W3 + 'place:gn:2641673', W3 + 'place:nc:3354071', W3 + 'place:osm:2155472']
          and [c.get('far') for c in cs] == [False, True, True] and 'Far: further than 50 km' in cs[1].get('text', ''), n)
    check("lookup: WHG's own figures are shown as WHG's (relative to the best in this search; confidence of the name only)",
          len(cs) == 3 and "WHG's own figures: score 100 (relative to the best in this search), confidence 92 (name only)" in cs[0].get('text', '')
          and 'relative to the best in this search' in cs[2].get('text', '') and 'confidence' not in cs[2].get('text', ''), cs)
    check('lookup: each candidate shows its licence: a warning for non-commercial, "licence unknown" never shown as fine, a free licence without a warning',
          len(cs) == 3 and 'CC-BY-4.0.' in cs[0].get('text', '') and not cs[0].get('warn') and 'CC-BY-NC-4.0, non-commercial' in cs[1].get('text', '') and cs[1].get('warn')
          and 'licence unknown' in cs[2].get('text', '') and cs[2].get('warn'), cs)

    # Resume: the places stopped, and the one not answered, are looked up again.
    def resume():
        page.click('#lookup-resume')
        return wait_state(page, lambda s: lk(s).get('running') is False and len((s.get('work') or {}).get('lookups') or []) == 2, 60, 'resume')
    r = step(resume, {}) if s.get('resume') else {}
    q2 = ((r.get('work') or {}).get('lookups') or [{}, {}])[1].get('queries', {})
    check('lookup: Resume looks up what the stop left, and the lookup finishes', lk(r).get('stopped') is None and dict(Counter(v['state'] for v in q2.values())) == {'answered': 5, 'unanswered': 1}
          and len(calls) == 3, {'lookup': lk(r), 'calls': len(calls)})

    # A place the gateway did not answer is "look it up again", not "no match"; beside it, one answered with nothing.
    def unanswered():
        page.select_option('#review-filter', 'all'); page.click('#review-next')
        at = {'subject': page.inner_text('#review-subject'), 'text': page.inner_text('#review-place')}
        page.click('#review-next')
        return {'atlantis': at, 'zennor': {'subject': page.inner_text('#review-subject'), 'text': page.inner_text('#review-place')}}
    u = step(unanswered, {}) if r.get('phase') == 'reviewing' else {}
    at, zn = u.get('atlantis') or {}, u.get('zennor') or {}
    check('lookup: a place WHG did not answer says "look it up again", not "no match"; one answered with nothing says "no candidates (label only)"',
          at.get('subject') == 'Atlantis' and 'not a finding that it has no match' in at.get('text', '') and 'Look it up again' in at.get('text', '') and 'No candidates' not in at.get('text', '')
          and zn.get('subject') == 'Zennor' and 'No candidates (label only)' in zn.get('text', '') and 'Not found? Try its other names (2 queries)' in zn.get('text', ''), u)

    # One place, from the review screen: the query as typed, one query sent, the focus on the new candidate.
    def single():
        page.click('#review-place button[data-look="find"]')
        page.fill('#find-query', 'Zennor Churchtown'); page.press('#find-query', 'Enter')
        s = wait_state(page, lambda s: lk(s).get('running') is False and lk(s).get('single') is True, 60, 'single lookup')
        focused = page.evaluate("() => { const li = document.activeElement && document.activeElement.closest('li.candidate'); return li ? li.dataset.id : null; }")
        return {**s, 'focused': focused}
    g = step(single, {}) if zn.get('subject') == 'Zennor' else {}
    new = [c for c in (g.get('work') or {}).get('candidates', []) if c['candidate_source'] == a + 'zennor']
    check('lookup: one place looked up from the review screen sends one query, as typed, and the focus moves to its new candidate',
          len(calls) == 4 and list(json.loads(calls[3]['body'])['queries'].values()) == [{'query': 'Zennor Churchtown', 'type': 'Place', 'limit': 10}]
          and len(new) == 1 and new[0]['candidate_candidate'] == W3 + 'place:gn:2633485' and g.get('focused') == new[0]['id'], {'calls': len(calls), 'new': new, 'focused': g.get('focused'), 'error': g.get('error')})

    # Deciding on it, saving, and finishing: one attestation citing WHG.
    def finish():
        page.keyboard.press('a')
        s = wait_state(page, lambda s: any(c.get('decision') for c in (s.get('work') or {}).get('candidates', [])), 10, 'decision')
        cites = page.inner_text('#finish-cites')
        with page.expect_download(timeout=30_000) as d: page.click('#save-review')
        d.value.save_as(tmp / 'lookup.krisis.json'); saved = (tmp / 'lookup.krisis.json').read_text()
        page.check('input[name="review-output"][value="attestations"]'); page.click('#finish')
        s = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, 'finish')
        out = json.loads(download(page, s['outputs'][0]['name'], tmp / 'lookup-attestations.json').read_text()) if s.get('phase') == 'done' and s.get('outputs') else {}
        return {'cites': cites, 'saved': saved, 'out': out, 'phase': s.get('phase'), 'report': s.get('report')}
    f = step(finish, {}) if g.get('focused') else {}
    atts = (f.get('out') or {}).get('attestations', [])
    cited = lambda x: x.get('sources', []) + [c.get('source') or {} for c in x.get('citations', [])]
    whg = [x for x in atts if any(src.get('title') == 'World Historical Gazetteer' and src.get('@id') == 'https://whgazetteer.org/' for src in cited(x))
           and [(i.get('subject'), i.get('object')) for i in x.get('identities', [])] == [(a + 'zennor', W3 + 'place:gn:2633485')]]
    check('lookup: the page says what Finish will cite, and Finish makes one attestation citing WHG, for the match accepted',
          'World Historical Gazetteer (https://whgazetteer.org/)' in f.get('cites', '') and len(atts) == 1 and len(whg) == 1, {k: f.get(k) for k in ('cites', 'phase', 'report', 'error')} if not atts else atts)

    # The token: in the Authorization header of every request (the control: the search finds it there), and nowhere else.
    def where():
        return {'plato': page.evaluate('() => JSON.stringify(window.__plato)'), 'text': page.evaluate('() => document.body.innerText'),
                'html': page.evaluate('() => document.documentElement.outerHTML'), 'url': page.url}
    wh = step(where, {})
    headers = [c['headers'].get('authorization') for c in calls]
    check('lookup: the token goes in the Authorization header of every request to WHG (the control for the absences below)',
          len(calls) == 4 and all(h == 'Bearer ' + LOOKUP_TOKEN for h in headers) and all(has(h) for h in headers), headers)
    check('lookup: the token is not in any address or request body, window.__plato, the page, the console, or the saved work file',
          bool(calls) and bool(wh.get('plato')) and bool(f.get('saved')) and '"lookups"' in f.get('saved', '') and 'World Historical Gazetteer' in f.get('saved', '')
          and not any(has(c['url']) or has(c['body']) for c in calls) and not has(wh.get('plato', LOOKUP_TOKEN)) and not has(wh.get('text', LOOKUP_TOKEN))
          and not has(wh.get('html', LOOKUP_TOKEN)) and not has(wh.get('url', LOOKUP_TOKEN)) and not has(consoled) and not has(f.get('saved', LOOKUP_TOKEN)),
          {'in': [k for k, v in {**wh, 'console': consoled, 'saved': f.get('saved', '')}.items() if has(v)], 'error': wh.get('error')})

    # Withdrawn in the panel ("Not decided"): at once, the review screen's place offers no button that
    # would send, only the module's line; allowed again (it is still in this load's policy), Find is back.
    def set_to(v):
        page.click('#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.check(f'#permissions-panel fieldset.perm[data-key="gazetteer:whg"] input[value="{v}"]')
        page.keyboard.press('Escape')
        until(page, '() => !document.getElementById("permissions-panel").open', 10)
    def withdraw():
        before = len(calls)
        set_to('undecided')
        page.wait_for_function("() => !!document.querySelector('#review-place .find .needs-permission:not([hidden])')", timeout=10_000)
        off = {'line': page.inner_text('#review-place .find .needs-permission'), 'buttons': page.eval_on_selector_all('#review-place button[data-look]', 'bs => bs.length'),
               'send hidden': page.evaluate("() => document.getElementById('lookup-send').hidden")}
        set_to('allowed')
        page.wait_for_function("() => !!document.querySelector('#review-place button[data-look=\"find\"]')", timeout=10_000)
        on = {'lines': page.eval_on_selector_all('#review-place .needs-permission:not([hidden])', 'els => els.length'),
              'buttons': page.eval_on_selector_all('#review-place button[data-look]', 'bs => bs.length'), 'send hidden': page.evaluate("() => document.getElementById('lookup-send').hidden")}
        return {'off': off, 'on': on, 'sent': len(calls) - before}
    wd = step(withdraw, {}) if f.get('saved') else {}
    off, on = wd.get('off') or {}, wd.get('on') or {}
    check('lookup: a permission withdrawn in the panel takes the review screen\'s lookup buttons away at once, for the one line; allowed again, they are back',
          off.get('line', '').startswith('Needs permission: World Historical Gazetteer') and off.get('buttons') == 0 and off.get('send hidden') is True
          and on.get('lines') == 0 and (on.get('buttons') or 0) >= 1 and on.get('send hidden') is False and wd.get('sent') == 0, wd)

    # A redirect is refused by the permissions module (never followed), and stops the lookup in words.
    def redirected():
        before = len(calls)
        redirect['on'] = True
        try:
            page.click('#review-place button[data-look="find"]')
            page.fill('#find-query', 'Zennor'); page.press('#find-query', 'Enter')
            s = wait_state(page, lambda s: lk(s).get('running') is False and lk(s).get('single') is True and lk(s).get('stopped'), 30, 'redirect')
        finally:
            redirect['on'] = False
        return {'stopped': lk(s).get('stopped'), 'refused': ((s.get('work') or {}).get('lookups') or [{}])[-1].get('stopped'), 'said': page.inner_text('#lookup-progress'), 'sent': len(calls) - before}
    rd = step(redirected, {}) if on.get('buttons') else {}
    check('lookup: WHG answering with a redirect is refused, not followed, and stops the lookup in words, once (not retried)',
          rd.get('stopped') == 'permission' and (rd.get('refused') or {}).get('refused') == 'moved' and 'sent the request on elsewhere' in rd.get('said', '') and rd.get('sent') == 1, rd)

    # A lookup running: the actions that would take the review away are disabled; a batch redrawing the
    # place keeps what is being typed in the find form; a refused token opens the closed panel to focus its
    # field; and "Save the review" saves through a link with rel="noopener".
    def held_route(n):
        for _ in range(100):
            if len(held['routes']) >= n: return held['routes'][n - 1]
            page.wait_for_timeout(100)
        raise TimeoutError(f'request {n} never came')
    def running():
        page.click('#lookup > summary') if not page.evaluate("() => document.getElementById('lookup').open") else None
        page.select_option('#lookup-places', 'all')
        page.wait_for_function("() => /^Send 30 queries to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", timeout=30_000)
        held['on'] = True
        page.click('#lookup-send')
        first = held_route(1)
        ids = ['check', 'convert', 'compare', 'match', 'resume', 'finish']
        during = page.evaluate(f"() => {json.dumps(ids)}.map((id) => document.getElementById(id).disabled)")
        page.click('#review-place button[data-look="find"]')
        page.fill('#find-query', ''); page.type('#find-query', 'Half typ')
        page.click('#lookup > summary')   # the panel closed: a refused token must open it to focus its field
        page.focus('#find-query')
        answer_whg(first)
        wait_state(page, lambda s: lk(s).get('done') == 25, 30, 'first batch')
        kept = {'value': page.input_value('#find-query'), 'focus': page.evaluate('() => document.activeElement && document.activeElement.id')}
        answer_whg(held_route(2), status=401)
        held['on'] = False
        s = wait_state(page, lambda s: lk(s).get('running') is False, 30, 'auth stop')
        after = {'open': page.evaluate("() => document.getElementById('lookup').open"), 'focus': page.evaluate('() => document.activeElement && document.activeElement.id'),
                 'stopped': lk(s).get('stopped'), 'enabled': page.evaluate(f"() => {json.dumps(ids)}.map((id) => !document.getElementById(id).disabled)")}
        page.evaluate("() => { window.__e2eRel = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__e2eRel.push(this.rel); return click.call(this); }; }")
        with page.expect_download(timeout=30_000): page.click('#save-review')
        return {'during': during, 'kept': kept, **after, 'rel': page.evaluate('() => window.__e2eRel')}
    rn = step(running, {}) if f.get('saved') else {}
    check('lookup: while a lookup runs, Check, Convert, Compare, Match, Resume and Finish are disabled, and enabled again after it',
          rn.get('during') == [True] * 6 and rn.get('enabled') == [True] * 6, rn)
    check("lookup: a batch redrawing the place keeps what is typed in the find form, and its focus",
          (rn.get('kept') or {}) == {'value': 'Half typ', 'focus': 'find-query'}, rn)
    check('lookup: after a refused token, the closed panel is opened and the focus is in the token field',
          rn.get('stopped') == 'auth' and rn.get('open') is True and rn.get('focus') == 'whg-token', rn)
    check('lookup: "Save the review" saves through a link with rel="noopener"', rn.get('rel') == ['noopener'], rn)

    # Set to Never in the panel (after the refused token, Resume is offered): the lookup panel and the
    # review screen each show ONE line, "Not allowed: … is set to Never in Permissions.", with a button
    # to the panel at WHG's entry; nothing is sent, Resume is hidden (and pressed by script, it shows the
    # line rather than doing nothing). Allowed again, Send and Resume are back, and Resume IS sent.
    NEVER = 'Not allowed: World Historical Gazetteer is set to Never in Permissions.'
    def never():
        before = len(calls) + len(asked)
        page.click('#lookup > summary') if not page.evaluate("() => document.getElementById('lookup').open") else None
        resume_before = page.is_visible('#lookup-resume')
        set_to('never')
        page.wait_for_function("() => !!document.querySelector('#review-place .find .needs-permission:not([hidden])') && !document.getElementById('lookup-permission').hidden", timeout=10_000)
        # The review drawn again while Never (a place's candidates, each with its kind): no GET of WHG's labels.
        vocab_at = len(vocab)
        pair = ('#review-next', '#review-prev') if not page.is_disabled('#review-next') else ('#review-prev', '#review-next')
        if not page.is_disabled(pair[0]): page.click(pair[0]); page.click(pair[1])   # away and back: the same place after
        page.wait_for_timeout(1000)
        vocab_never = len(vocab) - vocab_at
        out = {'resume before': resume_before,
               'review line': page.inner_text('#review-place .find .needs-permission'), 'review buttons': page.eval_on_selector_all('#review-place button[data-look]', 'bs => bs.length'),
               'review line button': page.eval_on_selector_all('#review-place .find .needs-permission button', 'bs => bs.length'),
               'line': page.inner_text(PERM), 'lines': page.eval_on_selector_all('#lookup .needs-permission', 'els => els.filter((e) => !e.hidden).length'),
               'send hidden': page.evaluate("() => document.getElementById('lookup-send').hidden"), 'resume hidden': page.evaluate("() => document.getElementById('lookup-resume').hidden")}
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.evaluate("() => document.getElementById('lookup-send').click()")
        page.wait_for_timeout(1000)
        out['focus after send'] = page.evaluate("() => { const a = document.activeElement; return a && a.tagName === 'BUTTON' && a.closest('#lookup-permission') ? 'line button' : (a && (a.id || a.tagName)); }")
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.evaluate("() => document.getElementById('lookup-resume').click()")
        page.wait_for_timeout(1000)
        out['focus after resume'] = page.evaluate("() => { const a = document.activeElement; return a && a.tagName === 'BUTTON' && a.closest('#lookup-permission') ? 'line button' : (a && (a.id || a.tagName)); }")
        out['line after resume'] = page.inner_text(PERM)
        out['sent'] = len(calls) + len(asked) - before
        page.click(PERM + ' button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        out['opened'] = page.evaluate(PANEL_STATE)
        page.check('#permissions-panel fieldset.perm[data-key="gazetteer:whg"] input[value="allowed"]')
        page.keyboard.press('Escape')
        until(page, '() => !document.getElementById("permissions-panel").open', 10)
        page.wait_for_function("() => !document.getElementById('lookup-send').hidden && !document.getElementById('lookup-resume').hidden", timeout=10_000)
        out['allowed'] = {'send hidden': page.evaluate("() => document.getElementById('lookup-send').hidden"), 'line hidden': page.evaluate("() => document.getElementById('lookup-permission').hidden"),
                          'find': page.eval_on_selector_all('#review-place button[data-look="find"]', 'bs => bs.length'), 'resume': page.inner_text('#lookup-resume')}
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        at = len(calls)
        page.click('#lookup-resume')
        s = wait_state(page, lambda s: lk(s).get('running') is False and len(calls) > at, 60, 'resume after Never')
        out['resumed sent'] = len(calls) - at
        out['resumed stopped'] = lk(s).get('stopped')
        out['vocab while never'] = vocab_never
        return out
    nv = step(never, {}) if rn.get('rel') else {}
    check('lookup, Never: the lookup panel and the review screen each show ONE line, "Not allowed: World Historical Gazetteer is set to Never in Permissions.", with a button; Send and Find are gone',
          nv.get('line', '').startswith(NEVER) and nv.get('lines') == 1 and nv.get('review line', '').startswith(NEVER) and nv.get('review line button') == 1
          and nv.get('review buttons') == 0 and nv.get('send hidden') is True, nv)
    check('lookup, Never: Send pressed by script sends nothing and the line\'s button takes the focus; the button opens the Permissions panel at WHG\'s entry',
          nv.get('sent') == 0 and nv.get('focus after send') == 'line button' and (nv.get('opened') or {}).get('open') is True and (nv.get('opened') or {}).get('focusKey') == 'gazetteer:whg', nv)
    check('lookup, Never: Resume, offered before, is hidden, and pressed by script it shows the line and focuses its button rather than doing nothing',
          nv.get('resume before') is True and nv.get('resume hidden') is True and nv.get('focus after resume') == 'line button' and nv.get('line after resume', '').startswith(NEVER), nv)
    check('lookup, Never then Allow (the positive control): Send, Find and Resume are back without a reload, the line is gone, and Resume IS sent',
          (nv.get('allowed') or {}).get('send hidden') is False and (nv.get('allowed') or {}).get('line hidden') is True and (nv.get('allowed') or {}).get('find', 0) >= 1
          and (nv.get('allowed') or {}).get('resume', '').startswith('Resume: send') and nv.get('resumed sent', 0) >= 1, nv)

    # The review's GET of WHG's labels for kinds of place (#20): anonymous (no Authorization header, so no token),
    # and made only while WHG is allowed: none before it was, none while it was Never, beside those made once it was.
    check('lookup: the review asks WHG for its labels of kinds of place without the token, and only while WHG is allowed (none before, none while Never; some once allowed)',
          vocab_not_allowed == 0 and nv.get('vocab while never') == 0 and len(vocab) >= 1 and all('authorization' not in v['headers'] for v in vocab),
          {'before allowed': vocab_not_allowed, 'while never': nv.get('vocab while never'), 'made': len(vocab), 'with authorization': sum(1 for v in vocab if 'authorization' in v['headers'])})

    # Every lookup of WHG in this page session is given the one fetch (gazetteerFetch): the shared lookup
    # warns, naming fetch, when a later call gives another. The presence: several lookups were made in it.
    later = [m for m in consoled if 'createLookup: a later call' in m]
    check('lookup: the lookups of WHG in one page session (panel, Resume, one place, and again) all gave createLookup the same fetch: no "a later call … gave fetch" warning',
          len(calls) >= 6 and nv.get('resumed sent', 0) >= 1 and later == [], {'calls': len(calls), 'warnings': later})

    # Forget: gone from the tab, and nothing is sent without it.
    def forget():
        before = len(calls)
        page.click('#lookup > summary') if not page.evaluate("() => document.getElementById('lookup').open") else None
        page.click('#whg-forget')
        gone = page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token')")
        page.click('#lookup-send', force=True)
        page.wait_for_function("() => /token first/.test(document.getElementById('lookup-progress').textContent)", timeout=10_000)
        return {'gone': gone, 'sent': len(calls) - before, 'said': page.inner_text('#lookup-progress'), 'focus': page.evaluate('() => document.activeElement && document.activeElement.id')}
    fg = step(forget, {}) if calls else {}
    check('lookup: Forget clears the token from the tab, and nothing is sent without one (the page asks for it)',
          'gone' in fg and fg.get('gone') is None and fg.get('sent') == 0 and 'Give your WHG token first' in fg.get('said', '') and fg.get('focus') == 'whg-token', fg)

    # At phone width, the panel and the review fit the screen.
    def phone():
        page.set_viewport_size({'width': 375, 'height': 800})
        wide = page.evaluate("() => ({ page: document.documentElement.scrollWidth, panel: document.getElementById('lookup').open && document.getElementById('lookup').getBoundingClientRect().width, review: !document.getElementById('review').hidden })")
        page.set_viewport_size({'width': 1280, 'height': 720})
        return wide
    ph = step(phone, {})
    check('lookup: at 375 px wide, the panel and the review fit without scrolling sideways', ph.get('panel') and ph.get('review') and ph.get('page', 999) <= 375, ph)

    # Step 2 narrowed to one tool (#tool=…): the lookup panel is Krisis's, so it goes with Match and is
    # hidden for the other tools, as Match itself is. The control: it is back for Match and for "Show every action".
    def follows_tool():
        vis = lambda: page.evaluate("() => ['lookup', 'match', 'check'].map((id) => { const e = document.getElementById(id); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); })")
        page.click('#toolbox .tool-link[href="#tool=check"]'); for_check = vis()
        page.click('#toolbox .tool-link[href="#tool=match"]'); for_match = vis()
        page.click('#every-action'); every = vis()
        return {'for check (lookup, match, check)': for_check, 'for match': for_match, 'every action': every}
    ft = step(follows_tool, {})
    check('lookup: the panel goes with Match when step 2 is narrowed to one tool: hidden for Check (as Match is), shown for Match and for "Show every action"',
          ft.get('for check (lookup, match, check)') == [False, False, True] and ft.get('for match') == [True, True, False] and ft.get('every action') == [True, True, True], ft)
    page.unroute(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'))

# Krisis: the lookup panel's token and language fields (Issue #33, Stephen's points 6 and 7). Nothing is sent:
# no gazetteer is asked here (the token is given, remembered and forgotten; no Send).
LOOKUP_PANEL = """() => { const $ = (id) => document.getElementById(id), shown = (el) => !!el && !el.hidden && el.offsetParent !== null && el.getClientRects().length > 0;
  return { tokenBox: shown($('lookup-token')), field: shown($('whg-token')), endpoint: shown($('lookup-endpoint')),
    remember: shown($('whg-remember')), forget: shown($('whg-forget')), forgetInDom: !!$('whg-forget'),
    value: $('whg-token')?.value ?? null, type: $('whg-token')?.type ?? null, placeholder: $('whg-token')?.placeholder ?? null,
    state: $('whg-token-state')?.textContent ?? null, progress: $('lookup-progress')?.textContent ?? null,
    help: $('whg-token-help')?.textContent ?? null, panel: $('lookup')?.innerText ?? '',
    focus: document.activeElement && document.activeElement.id,
    ...(() => { try { return { session: sessionStorage.getItem('plato-tools.whg-token'), local: localStorage.getItem('plato-tools.whg-token') }; }
      catch { return { session: 'no storage', local: 'no storage' }; } })() }; }"""
PANEL_TOKEN = 'e2e-SECRET-panel-token-41d2'

def lookup_panel_case(page, tmp, url):
    """The lookup panel's token (shown only for WHG; Remember, then the masked field and Forget, never the token in
    the page; Forget back to the empty state with no message) and its language field (a typeahead by code and by
    name; the codes shown as code)."""
    a = 'https://example.org/p/'
    subjects = tmp / 'lookup-panel.json'
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': a, 'title': 'Places for the panel'},
                                    'spatialEntities': [krisis_place(a + 'york', 'York', -1.0819, 53.9590)]}))
    def step(fn):
        try: return fn()
        except Exception as e: return {'error': str(e).split('\n')[0][:200]}
    def setup():
        page.goto(NOTOOLS if PROVE else url)
        page.evaluate("() => { try { sessionStorage.removeItem('plato-tools.whg-token'); localStorage.removeItem('plato-tools.whg-token'); localStorage.removeItem('plato-tools.whg-token.remember'); } catch { /* no storage here */ } }")
        page.goto(NOTOOLS if PROVE else url)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        page.set_input_files('#picker', [str(subjects)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        if s.get('phase') != 'detected': return {'phase': s.get('phase')}
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        return {'phase': 'open'}
    # Each step below is tried whatever the setup gave, so that each check fails, or passes, on what it looks at.
    su = step(setup)

    # Only with WHG: another service chosen hides the token (its own address field shown: the control that the
    # panel is drawn); WHG chosen shows it.
    def services():
        page.check('input[name="lookup-service"][value="other"]')
        other = page.evaluate(LOOKUP_PANEL)
        page.check('input[name="lookup-service"][value="whg"]')
        return {'other': other, 'whg': page.evaluate(LOOKUP_PANEL)}
    sv = {**step(services), 'setup': su}
    o, w = sv.get('other') or {}, sv.get('whg') or {}
    check('lookup panel: the token field is hidden while another service is chosen (its address field shown), and shown while WHG is',
          o.get('endpoint') is True and o.get('tokenBox') is False and o.get('field') is False
          and w.get('tokenBox') is True and w.get('field') is True and w.get('endpoint') is False, sv)

    # No token yet: an empty password field saying where the token comes from, Remember, and no Forget (which is
    # in the page, hidden: the absence is of a button that exists).
    check('lookup panel, no token yet: an empty password field with a placeholder saying where to get it, "Remember my token" shown, "Forget the token" not shown',
          w.get('type') == 'password' and w.get('value') == '' and 'whgazetteer.org' in (w.get('placeholder') or '')
          and w.get('remember') is True and w.get('forgetInDom') is True and w.get('forget') is False and w.get('state') == '', w)

    # Given and remembered: the field empty, its placeholder masked, where it is kept said beside it, Forget shown,
    # and the token nowhere in the page; the control: it IS kept (in this browser), so it was given.
    def remember():
        page.fill('#whg-token', PANEL_TOKEN)
        typed = PANEL_TOKEN in page.evaluate("() => document.getElementById('whg-token').value")   # the control for "not in the DOM"
        page.click('#whg-remember')
        page.wait_for_function("() => !document.getElementById('whg-forget').hidden", timeout=T(10) * 1000)
        out = page.evaluate(LOOKUP_PANEL)
        out['typed'] = typed
        out['in page'] = page.evaluate("""(t) => document.documentElement.outerHTML.includes(t) || [...document.querySelectorAll('input, textarea')].some((x) => x.value.includes(t))
          || JSON.stringify(window.__plato || {}).includes(t)""", PANEL_TOKEN)
        return out
    rm = step(remember)
    check('lookup panel, token remembered: the field empty with a masked placeholder, "Token remembered in this browser" beside it, "Forget the token" shown and "Remember my token" not',
          rm.get('value') == '' and rm.get('placeholder') == '••••••••' and rm.get('state') == 'Token remembered in this browser'
          and rm.get('forget') is True and rm.get('remember') is False and rm.get('focus') == 'whg-token', {k: v for k, v in rm.items() if k not in ('panel', 'session', 'local')})
    check('lookup panel: the token given is nowhere in the page (DOM, fields, window.__plato), and is kept in this browser (the control: it was given, and was in the field as typed)',
          rm.get('typed') is True and rm.get('in page') is False and rm.get('local') == PANEL_TOKEN and rm.get('session') == PANEL_TOKEN,
          {'typed': rm.get('typed'), 'in page': rm.get('in page'), 'kept': rm.get('local') == PANEL_TOKEN, 'error': rm.get('error')})

    # Forget: back to the empty state, Remember again, the focus in the field, the token gone, and no message:
    # the progress line says nothing of it (the control: the revoking advice is in the panel's static help).
    def forget():
        page.click('#whg-forget')
        page.wait_for_function("() => document.getElementById('whg-forget').hidden", timeout=T(10) * 1000)
        return page.evaluate(LOOKUP_PANEL)
    fg = step(forget)
    panel_words = fg.get('panel', '')
    check('lookup panel, Forget: back to the empty field, its placeholder where to get the token, "Remember my token" again, no Forget, the focus in the field, the token gone',
          fg.get('value') == '' and 'whgazetteer.org' in (fg.get('placeholder') or '') and fg.get('remember') is True and fg.get('forget') is False
          and fg.get('state') == '' and fg.get('focus') == 'whg-token' and fg.get('session') is None and fg.get('local') is None, {k: v for k, v in fg.items() if k != 'panel'})
    check('lookup panel, Forget: no message of it ("The token is forgotten…"), the advice on revoking it being in the static help (the control)',
          'regenerating it' in (fg.get('help') or '') and (fg.get('progress') or '') == '' and 'is forgotten' not in panel_words
          and 'that is the only way to revoke it' not in panel_words and 'Your WHG token' in panel_words, {'progress': fg.get('progress'), 'help': fg.get('help'), 'error': fg.get('error')})

    # Enter gives the token for the tab, said beside the field; a value the browser puts in the field (an autofill:
    # an input event with no inputType, or no event at all) is emptied and never given. The control for both
    # absences: the same token typed, then Enter, is given.
    def enter_and_autofill():
        out = {}
        page.evaluate("""(t) => { const f = document.getElementById('whg-token'); f.focus(); f.value = t; f.dispatchEvent(new Event('input', { bubbles: true })); }""", PANEL_TOKEN)
        out['filled value'] = page.input_value('#whg-token')
        page.press('#whg-token', 'Enter')
        out['filled'] = page.evaluate(LOOKUP_PANEL)
        page.evaluate("(t) => { document.getElementById('whg-token').value = t; }", PANEL_TOKEN)
        page.press('#whg-token', 'Enter')
        out['silent'] = page.evaluate(LOOKUP_PANEL)
        page.fill('#whg-token', PANEL_TOKEN); page.press('#whg-token', 'Enter')
        page.wait_for_function("() => !document.getElementById('whg-forget').hidden", timeout=T(10) * 1000)
        out['typed'] = page.evaluate(LOOKUP_PANEL)
        page.click('#whg-forget')
        page.wait_for_function("() => document.getElementById('whg-forget').hidden", timeout=T(10) * 1000)
        return out
    ea = step(enter_and_autofill)
    ty, fi, si = ea.get('typed') or {}, ea.get('filled') or {}, ea.get('silent') or {}
    check('lookup panel: Enter in the token field gives it for this tab, "Token kept for this tab only" beside it (kept for the tab, not in this browser), the field empty and masked',
          ty.get('state') == 'Token kept for this tab only' and ty.get('session') == PANEL_TOKEN and ty.get('local') is None and ty.get('value') == ''
          and ty.get('placeholder') == '••••••••' and ty.get('remember') is True and ty.get('forget') is True, {k: v for k, v in ty.items() if k not in ('panel', 'session', 'local')} or ea)
    check('lookup panel: a value the browser fills into the token field (no typing or pasting) is emptied and never given, with or without an input event (the control: the same typed is given)',
          ea.get('filled value') == '' and fi.get('session') is None and fi.get('state') == '' and si.get('session') is None and si.get('value') == ''
          and si.get('state') == '' and ty.get('session') == PANEL_TOKEN, {'filled value': ea.get('filled value'), 'filled': fi.get('session'), 'silent': si.get('session'), 'typed': ty.get('session') == PANEL_TOKEN, 'error': ea.get('error')})

    # The language field's typeahead: "ang" and "Old Eng" each offer ang, shown as "ang · Old English", its code as
    # code; a text that names no language offers nothing (beside the two that do); the keyboard chooses.
    OPTIONS = """() => { const l = document.getElementById('lookup-lang-options'), f = document.getElementById('lookup-lang');
      return { shown: !!l && !l.hidden && l.getClientRects().length > 0, expanded: f.getAttribute('aria-expanded'), role: f.getAttribute('role'),
        options: l ? [...l.querySelectorAll('[role=option]')].map((o) => ({ code: o.dataset.code, text: o.textContent, chip: o.querySelector('code.code-chip')?.textContent ?? null })) : [],
        value: f.value, problem: !document.getElementById('lookup-lang-problem').hidden, active: f.getAttribute('aria-activedescendant'),
        ids: l ? [...l.querySelectorAll('[role=option]')].map((o) => o.id) : [], offered: document.getElementById('lookup-lang-offered')?.textContent ?? null,
        live: document.getElementById('lookup-lang-offered')?.getAttribute('aria-live') ?? null }; }"""
    def typeahead():
        out = {}
        for q in ('ang', 'Old Eng', 'qqzz'):
            page.fill('#lookup-lang', '')
            page.type('#lookup-lang', q)
            out[q] = page.evaluate(OPTIONS)
        # A name typed and left unchosen: the refusal is shown once the field is left.
        page.fill('#lookup-lang', '')
        page.type('#lookup-lang', 'old eng')
        out['typing'] = page.evaluate(OPTIONS)
        page.press('#lookup-lang', 'Tab')
        out['left'] = page.evaluate(OPTIONS)
        # A value that holds codes of its own, refused: only the words' example codes are chips, never what was typed.
        page.fill('#lookup-lang', 'en, la or ang'); page.press('#lookup-lang', 'Tab')
        page.wait_for_function("() => !document.getElementById('lookup-lang-problem').hidden", timeout=T(10) * 1000)
        out['chips'] = page.evaluate("""() => { const p = document.getElementById('lookup-lang-problem');
          return { text: p.textContent, codes: [...p.querySelectorAll('code')].map((c) => c.textContent), quoted: [...p.childNodes][0]?.nodeType === 3 ? p.childNodes[0].textContent : null }; }""")
        # The keys and the pointer: End and Home, the pointer over the third, then Escape twice.
        page.fill('#lookup-lang', '')
        page.type('#lookup-lang', 'an')
        out['an'] = page.evaluate(OPTIONS)
        page.keyboard.press('ArrowDown'); page.keyboard.press('End'); out['end'] = page.evaluate(OPTIONS)
        page.keyboard.press('Home'); out['home'] = page.evaluate(OPTIONS)
        page.hover('#lookup-lang-options [role=option]:nth-child(3)'); out['hover'] = page.evaluate(OPTIONS)
        page.keyboard.press('Escape'); out['escape'] = page.evaluate(OPTIONS)
        page.keyboard.press('Escape'); out['escape again'] = page.evaluate(OPTIONS)
        page.fill('#lookup-lang', '')
        page.type('#lookup-lang', 'old eng')
        page.keyboard.press('ArrowDown'); page.keyboard.press('Enter')
        out['chosen'] = page.evaluate(OPTIONS)
        page.wait_for_function("() => document.getElementById('lookup-lang-problem').hidden", timeout=T(10) * 1000)
        out['problem hidden'] = True
        page.fill('#lookup-lang', '')
        return out
    ta = step(typeahead)
    ang = lambda r: next((x for x in (r or {}).get('options', []) if x.get('code') == 'ang'), None)
    check('lookup panel: the language field\'s typeahead finds ang by its code ("ang") and by its name ("Old Eng"), shown as "ang · Old English"',
          (ta.get('ang') or {}).get('shown') is True and (ta.get('ang') or {}).get('expanded') == 'true' and (ta.get('ang') or {}).get('role') == 'combobox'
          and (ang(ta.get('ang')) or {}).get('text') == 'ang · Old English' and (ta.get('Old Eng') or {}).get('shown') is True
          and (ang(ta.get('Old Eng')) or {}).get('text') == 'ang · Old English', {k: ta.get(k) for k in ('ang', 'Old Eng', 'error')})
    check('lookup panel: a text naming no language offers nothing (beside those that do), and Down then Enter puts the code chosen in the field',
          (ta.get('qqzz') or {}).get('shown') is False and (ta.get('qqzz') or {}).get('options') == [] and bool(ang(ta.get('ang')))
          and (ta.get('chosen') or {}).get('value') == 'ang' and (ta.get('chosen') or {}).get('shown') is False and ta.get('problem hidden') is True,
          {k: ta.get(k) for k in ('qqzz', 'chosen', 'error')})
    pick = lambda r, *ks: {k: (r or {}).get(k) for k in ks}
    check('lookup panel: the line refusing a code is held back while "Old Eng" is typed and languages are offered, shown for "qqzz" (nothing offered), and shown when the field is left with a name unchosen',
          (ta.get('Old Eng') or {}).get('shown') is True and (ta.get('Old Eng') or {}).get('problem') is False
          and (ta.get('qqzz') or {}).get('problem') is True and (ta.get('typing') or {}).get('problem') is False
          and (ta.get('left') or {}).get('shown') is False and (ta.get('left') or {}).get('problem') is True and (ta.get('left') or {}).get('value') == 'old eng',
          {k: pick(ta.get(k), 'shown', 'problem', 'value') for k in ('Old Eng', 'qqzz', 'typing', 'left')} | {'error': ta.get('error')})
    ch = ta.get('chips') or {}
    check('lookup panel: in the line refusing a value, only the words\' own example codes are chips, never the value typed, even when it holds the same codes',
          ch.get('text', '').startswith('"en, la or ang" is not a language code such as en, la or ang') and ch.get('codes') == ['en', 'la', 'ang']
          and ch.get('quoted', '').startswith('"en, la or ang" is not a language code such as '), ch or ta.get('error'))
    an, en, ho, hv = (ta.get(k) or {} for k in ('an', 'end', 'home', 'hover'))
    ids = an.get('ids') or []
    check('lookup panel: the typeahead says politely how many it offers, Home and End go to the first and the last, the pointer moves the active one, and Escape closes the list, then empties the field',
          len(ids) >= 3 and an.get('live') == 'polite' and an.get('offered') == f'{len(ids)} languages suggested; Up and Down to choose.'
          and en.get('active') == ids[-1] and ho.get('active') == ids[0] and hv.get('active') == ids[2]
          and (ta.get('escape') or {}).get('shown') is False and (ta.get('escape') or {}).get('value') == 'an' and (ta.get('escape again') or {}).get('value') == '',
          {k: pick(ta.get(k), 'shown', 'active', 'value', 'offered', 'live') for k in ('an', 'end', 'home', 'hover', 'escape', 'escape again')} | {'ids': ids, 'error': ta.get('error')})

    # The codes as code: the field's help names en, la and ang each in a chip (styled, not plain text), and the
    # typeahead's options too; the control: the help's words around them are there as text.
    CODES = """() => { const l = document.querySelector('label[for="lookup-lang"]'), cs = l ? [...l.querySelectorAll('code')] : [];
      const st = cs[0] ? getComputedStyle(cs[0]) : null;
      return { text: l ? l.textContent : '', codes: cs.map((c) => c.textContent), chips: cs.length > 0 && cs.every((c) => c.classList.contains('code-chip')),
        mono: st ? /mono|consol|menlo|courier/i.test(st.fontFamily) : false, border: st ? parseFloat(st.borderTopWidth) > 0 && parseFloat(st.borderTopLeftRadius) > 0 : false }; }"""
    cd = step(lambda: page.evaluate(CODES))
    check('lookup panel: the language codes in the help ("en, la or ang") are <code> chips (monospace, bordered), as in the typeahead\'s options',
          'a code such as en, la or ang' in (cd.get('text') or '') and cd.get('codes') == ['en', 'la', 'ang'] and cd.get('chips') is True
          and cd.get('mono') is True and cd.get('border') is True and (ang(ta.get('ang')) or {}).get('chip') == 'ang', cd)


def krisis_lookup_pattern(page, tmp, url):
    """Krisis, gazetteer lookup of a table with a Hermes column pattern (after krisis_lookup_case, which
    leaves WHG allowed): a CSV column of Pleiades ids, its suggested pattern ticked, is read for the lookup
    by the same column options Match is given, so the places looked up are the pattern-built Pleiades
    addresses that krisis_pattern_match finds Match uses; unticked (the control), they are not. WHG is a
    fake (page.route), as in krisis_lookup_case: nothing goes online."""
    import re
    table = tmp / 'krisis-lookup-pleiades.csv'
    table.write_text('id,name,pleiades_id,lat,lon\n1,Athenae,579885,37.97,23.72\n2,Roma,423025,41.89,12.49\n')
    calls = []
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    def fake_whg(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        calls.append(req.post_data or '')
        out = {'attribution': LOOKUP_ATTRIBUTION, **{k: {'result': []} for k in json.loads(req.post_data)['queries']}}
        route.fulfill(status=200, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(out))
    whg = re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/')
    page.route(whg, fake_whg)
    def looked_up(tick):
        try:
            at = len(calls)
            page.goto(NOTOOLS if PROVE else url)
            r = wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            if r.get('phase') != 'ready': return {'ready': r.get('phase')}
            page.evaluate("() => { document.getElementById('base').value = 'https://example.org/p/'; }")
            page.set_input_files('#picker', [str(table)])
            s = wait_state(page, lambda s: (s.get('columns') or {}).get('mapping'), 60, 'columns')
            if not (s.get('columns') or {}).get('mapping'): return {'columns': None}
            if tick: page.locator('#columns input[data-pattern-column]').check()
            page.evaluate("() => { const r = document.getElementById('reviewer'); if (!r.value) { r.value = 'Lu Reviewer'; r.dispatchEvent(new Event('change')); } }")
            if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
            page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
            page.select_option('#lookup-places', 'all')
            page.wait_for_function("() => /^Send 2 queries to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", timeout=60_000)
            page.click('#lookup-send')
            s = wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and (s.get('work') or {}).get('lookups'), 60, 'lookup')
            looks = (s.get('work') or {}).get('lookups') or [{}]
            return {'places': sorted(looks[-1].get('queries', {})), 'sent': len(calls) - at,
                    'columns': (s.get('columns') or {}).get('mapping', {}).get('pleiades_id'), 'stopped': (s.get('lookup') or {}).get('stopped')}
        except Exception as e: return {'error': str(e).split('\n')[0][:200]}
    try: on, off = looked_up(True), looked_up(False)
    finally: page.unroute(whg)
    check('lookup: a CSV column with a confirmed Pleiades pattern is looked up by the pattern-built addresses, as Match reads it; unconfirmed (the control), by the table\'s own',
          on.get('sent') == 1 and on.get('places') == ['https://pleiades.stoa.org/places/423025', 'https://pleiades.stoa.org/places/579885']
          and off.get('sent') == 1 and len(off.get('places') or []) == 2 and not any('pleiades' in x for x in off['places']), {'on': on, 'off': off})

# Krisis: region review (Methodos #28, stages 3 and 4). WHG is never called: page.route answers for it
# (as WHG answers a filtered query: `scope`, and for Hoxne within Suffolk a filter it could not apply,
# which it answers with nothing: failed closed; and, asked for areas only (area_only), as WHG's place#323 does:
# without the records that have no outline), and records each request's body.
def region_answer(id, name, has_geom=True):
    return {'id': id, 'name': name, 'score': 100, 'match': True, 'description': 'Country: GB', 'ccodes': ['GB'], 'repr_point': [1.0, 52.3], 'namespace': id.split(':')[1], 'alt_names': [], 'has_geom': has_geom}
# A point-only England (a farm of that name, say): never offered for a region, which is asked for areas only.
REGION_POINT_ONLY = 'place:gn:9100001'
REGION_ANSWERS = {
    'England': [region_answer('place:gn:6269131', 'England'), region_answer('place:wd:Q21', 'England'), region_answer(REGION_POINT_ONLY, 'England', has_geom=False)],
    'Suffolk': [region_answer('place:gn:2636561', 'Suffolk')], 'Norfolk': [region_answer('place:gn:2641455', 'Norfolk')],
    'Hoxne': [region_answer('place:gn:2646340', 'Hoxne')], 'Eye': [region_answer('place:gn:2649660', 'Eye')], 'Diss': [region_answer('place:gn:2651188', 'Diss')],
}

def krisis_regions_case(page, tmp, url):
    """Krisis, region review: a table's Country, County and Parish columns read as Hermes's "within" levels; level 1
    looked up and settled, level 2 looked up within its match (contained_in, the bare id), a failed-closed answer
    said in words and asked again relaxed, a change to level 1 asked on the page, clearing level 2, and undone; and
    Finish writing the claim about the minted region into the dataset, which passes the version check. Run after
    krisis_lookup_case, whose page has WHG allowed."""
    import re
    base = 'https://example.org/suffolk/'
    W3 = 'https://w3id.org/whg/id/'
    table = tmp / 'regions-review.csv'
    table.write_text('id,Name,Parish,County,Country\n1,Mill,Hoxne,Suffolk,England\n2,Farm,Eye,Suffolk,England\n3,Barn,Diss,Norfolk,England\n', encoding='utf-8')
    calls, dialogs = [], []
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    def fake_whg(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        body = json.loads(req.post_data or '{}')
        calls.append(body)
        out = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in (body.get('queries') or {}).items():
            filtered = isinstance(q.get('contained_in'), list)
            found = [c for c in REGION_ANSWERS.get(q['query'], []) if c.get('has_geom') or not q.get('area_only')]
            if filtered and q['query'] == 'Hoxne': out[k] = {'result': [], 'scope': {'applied': False}}
            else: out[k] = {'result': found, **({'scope': {'applied': True}} if filtered else {})}
        route.fulfill(status=200, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(out))
    WHG = re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/')
    page.route(WHG, fake_whg)
    page.on('dialog', lambda d: (dialogs.append(d.type), d.dismiss()))
    def step(fn):
        try: return fn()
        except Exception as e: return {'error': str(e).split('\n')[0][:200]}
    rs = lambda s: s.get('regions') or {}
    def key(s, name): return next((k for k, r in ((s.get('work') or {}).get('regions') or {}).items() if r['names'][0] == name), None)
    art = lambda k: f'#regions-level article[data-rkey="{k}"]'
    def choose_candidate(k, rid, act='match'):
        page.locator(art(k) + ' li.candidate').filter(has_text=W3 + rid).locator(f'button[data-ract="{act}"]').click()
    def run_level(level_button):
        n = len(calls)
        page.click(level_button)
        return wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(calls) > n, 60, 'region lookup'), n

    # The table, its columns read as levels, the base address its regions are minted under; the review begun from the lookup panel.
    def setup():
        page.evaluate(f"() => {{ document.getElementById('base').value = {json.dumps(base)}; const r = document.getElementById('reviewer'); r.value = 'Re Gion'; r.dispatchEvent(new Event('change')); }}")
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(table)])
        s = wait_state(page, lambda s: s.get('phase') == 'detected' and ((s.get('columns') or {}).get('levels') or {}), 60, 'columns')
        if s.get('phase') != 'detected': return {'phase': s.get('phase')}
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        # The dataset's language: its names give none of their own, so each is sent with this one. First one that
        # is not a code (und), refused beside the field and in the preview, with Send disabled; then en, taken.
        lang = {}
        page.fill('#lookup-lang', 'und')
        page.wait_for_function("() => !document.getElementById('lookup-lang-problem').hidden && document.getElementById('lookup-preview').textContent.includes('is not a language code')", timeout=30_000)
        lang['bad'] = page.evaluate("() => ({ problem: document.getElementById('lookup-lang-problem').textContent, preview: document.getElementById('lookup-preview').textContent, "
                                    "send: document.getElementById('lookup-send').disabled, invalid: document.getElementById('lookup-lang').getAttribute('aria-invalid') })")
        page.fill('#lookup-lang', 'en')
        page.wait_for_function("() => document.getElementById('lookup-lang-problem').hidden && document.getElementById('lookup-preview').textContent.includes('is sent as en')", timeout=30_000)
        lang['good'] = page.evaluate("() => ({ preview: document.getElementById('lookup-preview').textContent, invalid: document.getElementById('lookup-lang').getAttribute('aria-invalid') })")
        page.wait_for_function("() => !document.getElementById('regions-offer').hidden", timeout=60_000)
        offer = page.inner_text('#regions-offer')
        # The start button is disabled while the page is busy (reading the dataset's places); the click waits for it.
        page.click('#regions-start', timeout=60_000)
        s = wait_state(page, lambda s: rs(s).get('nav') and len((s.get('work') or {}).get('regions') or {}) == 6, 120, 'regions')
        if s.get('timedOut'): return {'timedOut': s['timedOut'], 'offer': offer, 'offer shown': page.evaluate("() => !document.getElementById('regions-offer').hidden"), 'summary': s.get('summary')}
        page.wait_for_selector('#regions-level button[data-rgo="level"]', timeout=30_000)
        return {'lang': lang, 'levels': (s.get('columns') or {}).get('levels'), 'offer': offer, 'nav': rs(s).get('nav'), 'level': rs(s).get('level'),
                'keys': sorted((s.get('work') or {}).get('regions', {}).keys()), 'button': page.inner_text('#regions-level button[data-rgo="level"]')}
    su = step(setup)
    check('regions: a table\'s Country, County and Parish columns are read as "within" levels 1-3; the lookup panel offers the review, which shows each level by its heading, Country first',
          su.get('levels') == {'Country': 1, 'County': 2, 'Parish': 3} and 'Your places lie in 6 regions at 3 levels' in su.get('offer', '')
          and su.get('nav') == ['Country 0/1', 'County locked', 'Parish locked', 'Places 0/3'] and su.get('level') == 1
          and len(su.get('keys') or []) == 6 and all(k.startswith(base + 'place/region-') for k in su.get('keys') or []), su)
    check('regions: the level\'s button says what it would send', su.get('button') == 'Look up the ready region of Country (1 query in 1 request)', su)
    bad, good = (su.get('lang') or {}).get('bad') or {}, (su.get('lang') or {}).get('good') or {}
    check('regions: a dataset language that is not a code (und) is refused beside the field and in the preview, with Send disabled, and the preview never says none is set; en is taken, and said',
          (bad.get('problem') or '').startswith('"und" is not a language code') and 'is not a language code' in (bad.get('preview') or '') and bad.get('send') is True
          and bad.get('invalid') == 'true' and 'no language is set' not in (bad.get('preview') or '')
          and 'A name with no language of its own is sent as en' in (good.get('preview') or '') and good.get('invalid') == 'false' and 'no language is set' not in (good.get('preview') or ''),
          su.get('lang') or su)

    # Level 1, then settled; level 2 is asked within its match.
    def levels_1_2():
        s, n1 = run_level('#regions-level button[data-rgo="level"]')
        eng = key(s, 'England')
        out = {'first': list(calls[n1]['queries'].values()) if len(calls) > n1 else None, 'england': page.inner_text(art(eng)),
               'england notes': page.eval_on_selector_all(art(eng) + ' .region-note', 'els => els.map((e) => e.dataset.note)')}
        choose_candidate(eng, 'place:gn:6269131')
        s = wait_state(page, lambda s: ((s.get('work') or {}).get('regions', {}).get(eng) or {}).get('outcome') == 'matched', 10, 'England settled')
        out['nav after 1'] = rs(s).get('nav')
        page.click('#regions-nav button[data-rlevel="2"]')
        s, n2 = run_level('#regions-level button[data-rgo="level"]')
        suf, nor = key(s, 'Suffolk'), key(s, 'Norfolk')
        out['second'] = list(calls[n2]['queries'].values()) if len(calls) > n2 else None
        out['suffolk line'] = page.inner_text(art(suf) + ' .region-constraint')
        out['suffolk where'] = page.inner_text(art(suf) + ' .region-where')
        out['suffolk notes'] = page.eval_on_selector_all(art(suf) + ' .region-note', 'els => els.map((e) => e.dataset.note)')
        out['certainty options'] = page.eval_on_selector_all('#region-certainty option', 'os => os.map((o) => [o.value, o.selected])')
        page.select_option('#region-certainty', 'less-certain')
        choose_candidate(suf, 'place:gn:2636561')
        s = wait_state(page, lambda s: ((s.get('work') or {}).get('regions', {}).get(suf) or {}).get('outcome') == 'matched', 10, 'Suffolk settled')
        out['suffolk certainty'] = next((c['decision'].get('certainty') for c in (s.get('work') or {}).get('candidates', []) if c['candidate_source'] == suf and (c.get('decision') or {}).get('kind') == 'match'), None)
        page.select_option('#region-certainty', 'certain')
        page.click(art(nor) + ' button[data-ract="none"]')
        s = wait_state(page, lambda s: ((s.get('work') or {}).get('regions', {}).get(nor) or {}).get('outcome') == 'no-match', 10, 'Norfolk settled')
        out['nav after 2'] = rs(s).get('nav')
        out['keys'] = {'eng': eng, 'suf': suf, 'nor': nor}
        return out
    l2 = step(levels_1_2) if su.get('nav') else {}
    first, second = l2.get('first') or [], l2.get('second') or []
    check('regions: level 1 is sent with no constraint (the control for the next), for areas only and in the dataset\'s language; settling it unlocks level 2',
          first == [{'area_only': True, 'lang': 'en', 'query': 'England', 'type': 'Place', 'limit': 10}] and 'Looked up with no constraint' in l2.get('england', '')
          and "WHG's own figures" in l2.get('england', '') and 'Licence of its source' in l2.get('england', '')
          and l2.get('nav after 1') == ['Country 1/1 settled', 'County 0/2', 'Parish locked', 'Places 0/3'], {k: l2.get(k) for k in ('first', 'nav after 1', 'error')})
    check('regions: asked for areas only, England is offered the records with an outline, never the point-only one the gazetteer also holds',
          W3 + 'place:gn:6269131' in l2.get('england', '') and W3 + 'place:wd:Q21' in l2.get('england', '') and W3 + REGION_POINT_ONLY not in l2.get('england', ''),
          {k: l2.get(k) for k in ('england', 'error')})
    check("regions: the level 2 request carries contained_in, a list of the level 1 match's bare id, and its countries, for each region",
          len(second) == 2 and sorted(q['query'] for q in second) == ['Norfolk', 'Suffolk']
          and all(q.get('contained_in') == ['gn:6269131'] and q.get('countries') == ['GB'] and 'lat' not in q for q in second), second)
    check('regions: each region says where it lies and what it was looked up within, in words, with the note on a country filter (not on England, which had none)',
          l2.get('suffolk line') == 'Looked up within England (gn:6269131) and in GB.' and l2.get('suffolk where', '').startswith('in England · 2 places')
          and l2.get('suffolk notes') == ['uncoded'] and l2.get('england notes') == [],
          {k: l2.get(k) for k in ('suffolk line', 'suffolk where', 'suffolk notes', 'england notes', 'error')})
    check("regions: the certainty select offers PLATO's three levels, certain by default; a match decided with 'less certain' is recorded so",
          l2.get('certainty options') == [['certain', True], ['less-certain', False], ['uncertain', False]] and l2.get('suffolk certainty') == 'less-certain',
          {k: l2.get(k) for k in ('certainty options', 'suffolk certainty', 'error')})
    check('regions: This one and None of these settle level 2', l2.get('nav after 2') == ['Country 1/1 settled', 'County 2/2 settled', 'Parish 0/3', 'Places 0/3'], l2)

    # Level 3: Hoxne's filter could not be applied (failed closed); relaxed, it is asked again without it.
    FC = "WHG could not narrow this search to Suffolk, so it returned nothing. That is not 'no match': look it up again with the constraint relaxed."
    def level_3():
        ks = l2['keys']
        page.click('#regions-nav button[data-rlevel="3"]')
        s, n3 = run_level('#regions-level button[data-rgo="level"]')
        hox, eye, diss = key(s, 'Hoxne'), key(s, 'Eye'), key(s, 'Diss')
        sent = {q['query']: q for q in calls[n3]['queries'].values()} if len(calls) > n3 else {}
        out = {'sent': sent, 'hoxne notes': page.eval_on_selector_all(art(hox) + ' .region-note[data-note="failed-closed"]', 'els => els.map((e) => e.textContent)'),
               'eye notes': page.eval_on_selector_all(art(eye) + ' .region-note[data-note="failed-closed"]', 'els => els.length'),
               'eye candidates': page.eval_on_selector_all(art(eye) + ' li.candidate', 'els => els.length'),
               'hoxne state': (((s.get('work') or {}).get('lookups') or [{}])[-1].get('queries') or {}).get(hox),
               'relax': page.eval_on_selector_all(art(hox) + ' button[data-rrelax]', 'bs => bs.map((b) => b.textContent)')}
        n4 = len(calls)
        page.click(art(hox) + ' button[data-rrelax="all"]')
        s = wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(calls) > n4, 60, 'relaxed')
        out['relaxed'] = list(calls[n4]['queries'].values()) if len(calls) > n4 else None
        out['hoxne after'] = page.eval_on_selector_all(art(hox) + ' .region-note[data-note="failed-closed"]', 'els => els.length')
        out['hoxne candidates'] = page.eval_on_selector_all(art(hox) + ' li.candidate', 'els => els.length')
        out['hoxne line'] = page.inner_text(art(hox) + ' .region-constraint')
        choose_candidate(eye, 'place:gn:2649660')
        wait_state(page, lambda s: ((s.get('work') or {}).get('regions', {}).get(eye) or {}).get('outcome') == 'matched', 10, 'Eye settled')
        ks.update({'hox': hox, 'eye': eye, 'diss': diss})
        return out
    l3 = step(level_3) if l2.get('nav after 2') else {}
    sent = l3.get('sent') or {}
    check('regions: level 3 is asked within each parish\'s nearest matched region: Suffolk for Hoxne and Eye, England for Diss (Norfolk has none)',
          (sent.get('Hoxne') or {}).get('contained_in') == ['gn:2636561'] and (sent.get('Eye') or {}).get('contained_in') == ['gn:2636561']
          and (sent.get('Diss') or {}).get('contained_in') == ['gn:6269131'], sent)
    check("regions: a failed-closed answer shows the notice in plain words, and is not \"no match\" (Eye, answered, shows none and has its candidate)",
          l3.get('hoxne notes') == [FC] and l3.get('eye notes') == 0 and l3.get('eye candidates') == 1
          and (l3.get('hoxne state') or {}).get('failedClosed') is True and (l3.get('hoxne state') or {}).get('state') == 'unanswered', {k: l3.get(k) for k in ('hoxne notes', 'eye notes', 'eye candidates', 'hoxne state', 'error')})
    check('regions: the relax buttons name each step and its cost; "With no constraint" asks again without the constraint, and the notice goes',
          l3.get('relax') == ['Again without the countries (1 query in 1 request)', 'Within the area instead (1 query in 1 request, and 1 record fetched for an area)', 'Within England instead (1 query in 1 request)', 'With no constraint (1 query in 1 request)']
          and l3.get('relaxed') == [{'area_only': True, 'lang': 'en', 'query': 'Hoxne', 'type': 'Place', 'limit': 10}] and l3.get('hoxne after') == 0 and l3.get('hoxne candidates') == 1
          and l3.get('hoxne line') == 'Looked up with no constraint. Relaxed: no constraint.', {k: l3.get(k) for k in ('relax', 'relaxed', 'hoxne after', 'hoxne candidates', 'hoxne line', 'error')})

    # Changing level 1 asks on the page first (never window.confirm), then clears level 2 and below; Undo puts it all back.
    def change():
        ks = l2['keys']
        s0 = wait_state(page, lambda s: True, 5)
        w0 = s0.get('work') or {}
        below = {k for k in w0.get('regions', {}) if k != ks['eng']} | set(w0.get('places', {}))
        expect = {'decisions': sum(1 for c in w0['candidates'] if c['candidate_source'] in below and c.get('decision')),
                  'candidates': sum(1 for c in w0['candidates'] if c['candidate_source'] in below and c.get('lookup'))}
        page.click('#regions-nav button[data-rlevel="1"]')
        choose_candidate(ks['eng'], 'place:wd:Q21')
        page.wait_for_function("() => !document.getElementById('regions-confirm').hidden", timeout=10_000)
        s1 = wait_state(page, lambda s: rs(s).get('confirm'), 5)
        out = {'expect': expect, 'confirm': rs(s1).get('confirm'), 'suffolk while asked': ((s1.get('work') or {}).get('regions', {}).get(ks['suf']) or {}).get('outcome'),
               'q21 while asked': next((c.get('decision') for c in (s1.get('work') or {}).get('candidates', []) if c['candidate_candidate'] == W3 + 'place:wd:Q21'), 'none')}
        page.click('#regions-confirm button[data-rconfirm="yes"]')
        s2 = wait_state(page, lambda s: rs(s).get('undo'), 10, 'cleared')
        w2 = s2.get('work') or {}
        out.update({'status': rs(s2).get('status'), 'suffolk after': (w2.get('regions', {}).get(ks['suf']) or {}).get('outcome'),
                    'suffolk candidates after': sum(1 for c in w2.get('candidates', []) if c['candidate_source'] == ks['suf']),
                    'union': page.eval_on_selector_all(art(ks['eng']) + ' .region-note[data-note="union"]', 'els => els.map((e) => e.textContent)'),
                    'nav after': rs(s2).get('nav')})
        page.click('#regions-status button[data-rundo]')
        s3 = wait_state(page, lambda s: rs(s).get('nav') and not rs(s).get('undo') and (rs(s).get('status') or '').startswith('Put back'), 10, 'undone')
        w3 = s3.get('work') or {}
        strip = lambda w: json.dumps({'candidates': w.get('candidates'), 'regions': w.get('regions')}, sort_keys=True)
        out.update({'undone': rs(s3).get('status'), 'same as before': strip(w3) == strip(w0) and bool(w0.get('candidates')),
                    'union after undo': page.eval_on_selector_all(art(ks['eng']) + ' .region-note[data-note="union"]', 'els => els.length'),
                    'nav undone': rs(s3).get('nav'), 'nav before': rs(s0).get('nav')})
        return out
    ch = step(change) if l3.get('hoxne candidates') else {}
    ex = ch.get('expect') or {}
    check('regions: changing a settled level 1 is asked on the page, saying what it clears, and clears nothing until confirmed (no browser dialog)',
          ex.get('decisions') == 2 and ex.get('candidates') == 5 and ch.get('confirm') == f"This clears {ex.get('decisions')} decisions and {ex.get('candidates')} candidates below England."
          and ch.get('suffolk while asked') == 'matched' and ch.get('q21 while asked') is None and dialogs == [], {**{k: ch.get(k) for k in ('expect', 'confirm', 'suffolk while asked', 'q21 while asked', 'error')}, 'dialogs': dialogs})
    check('regions: confirmed, level 2 is cleared (its decisions and candidates), England says it uses the union of its two records, and a status line offers Undo',
          ch.get('suffolk after') is None and ch.get('suffolk candidates after') == 0 and ch.get('status') == f"Cleared {ex.get('decisions')} decisions and {ex.get('candidates')} candidates below England."
          and len(ch.get('union') or []) == 1 and 'union of their areas' in (ch.get('union') or [''])[0] and (ch.get('nav after') or [None, ''])[1] == 'County 0/2', ch)
    check('regions: Undo restores level 2 and everything below, and England as it was (the union note gone)',
          ch.get('same as before') is True and ch.get('union after undo') == 0 and ch.get('undone') == 'Put back what was cleared below England, and England as it was.'
          and ch.get('nav undone') == ch.get('nav before') and bool(ch.get('nav before')), {k: ch.get(k) for k in ('same as before', 'union after undo', 'undone', 'nav undone', 'nav before', 'error')})

    # The places within: those whose regions are settled are offered, those waiting listed with the region they wait for.
    def places():
        page.click('#regions-nav button[data-rlevel="places"]')
        return {'button': page.inner_text('#regions-level button[data-rgo="places"]'), 'locked': page.eval_on_selector_all('#regions-level .region-locked li', 'els => els.map((e) => e.textContent)'),
                'unconstrained': page.eval_on_selector_all('#regions-level button[data-runc]', 'bs => bs.length')}
    pl = step(places) if ch.get('same as before') else {}
    check('regions: the places within: the one in a settled parish is offered, the two waiting are listed with the region they wait for, each with "Look up without the regions"',
          pl.get('button') == 'Look up the place in settled regions (1 query in 1 request)' and pl.get('unconstrained') == 2
          and any(t.startswith('Mill: waiting for Hoxne (Parish) to be settled') for t in pl.get('locked') or []) and any(t.startswith('Barn: waiting for Diss (Parish) to be settled') for t in pl.get('locked') or []), pl)

    # Finishing writes the region claim: an attestation about the minted region, bundling the identity; the dataset passes the version check.
    def finish():
        ks = l2['keys']
        page.check('input[name="review-output"][value="dataset"]')
        page.click('#finish')
        s = wait_state(page, lambda s: s.get('action') == 'apply' and s.get('phase') in ('done', 'error'), 120, 'finish')
        name = next((o['name'] for o in s.get('outputs') or [] if o['name'].endswith('.json')), None)
        doc = json.loads(download(page, name, tmp / name).read_text()) if name else {}
        ents = {e['@id']: e for e in doc.get('spatialEntities', [])}
        claims = lambda k: [a for a in (ents.get(k) or {}).get('attestations', []) if a.get('identities')]
        contained = [a['relations'][0].get('relatesTo') for a in (ents.get(base + 'place/1') or {}).get('attestations', []) if a.get('relations')]
        return {'phase': s.get('phase'), 'errors': (s.get('report') or {}).get('errors'), 'version check': ((s.get('report') or {}).get('counts') or {}).get('versionCheck'),
                'england': claims(ks['eng']), 'suffolk': claims(ks['suf']), 'norfolk': claims(ks['nor']), 'contained': contained, 'hox': ks['hox'],
                'items': [i.get('kind') for i in (s.get('report') or {}).get('items', [])]}
    fi = step(finish) if l2.get('keys') else {}
    eng_claim = (fi.get('england') or [{}])[0]
    ident = (eng_claim.get('identities') or [{}])[0]
    check('regions: Finish writes the claim about the minted region: an attestation bundling its identity with the WHG record, with a certainty, citing WHG; the settled-with-none region gets none (Suffolk, matched, does)',
          len(fi.get('england') or []) == 1 and ident.get('subject') == l2.get('keys', {}).get('eng') and ident.get('object') == W3 + 'place:gn:6269131' and ident.get('identityType') == 'closeMatch'
          and bool(eng_claim.get('certaintyLevel')) and any(src.get('title') == 'World Historical Gazetteer' for src in eng_claim.get('sources', []))
          and len(fi.get('suffolk') or []) == 1 and fi.get('norfolk') == [], {k: fi.get(k) for k in ('england', 'suffolk', 'norfolk', 'error')})
    check('regions: the dataset written passes the version check, and the place is still ContainedIn its region made from the data, not the gazetteer\'s',
          fi.get('phase') == 'done' and fi.get('errors') == 0 and (fi.get('version check') or {}).get('lost') == 0 and (fi.get('version check') or {}).get('later', 0) > 0 and fi.get('contained') == [fi.get('hox')] and bool(fi.get('hox')),
          {k: fi.get(k) for k in ('phase', 'errors', 'version check', 'items', 'contained', 'hox', 'error')})
    page.unroute(WHG)

def download(page, name, dest):
    with page.expect_download(timeout=600_000) as d:
        page.evaluate(f'window.__plato_save({json.dumps(name)})')
    d.value.save_as(dest); return pathlib.Path(dest)

def many_places(tmp, copies):
    """PLATO's Antonine example, its places `copies` times over, each copy under an address of its own: a
    run long enough to be stopped part-way (1,000 copies: 11,000 places, 40 MB)."""
    path = tmp / f'many-{copies}.json'
    if not path.exists():
        d = json.loads((PLATO / 'schemas/examples/place-centric-antonine.json').read_text())
        places = json.dumps(d['spatialEntities'])
        d['spatialEntities'] = [p for i in range(copies) for p in json.loads(places.replace('https://whgazetteer.org/example/antonine/', f'https://whgazetteer.org/example/antonine/c{i}/'))]
        path.write_text(json.dumps(d))
    return path

# The names of the files in the main page's outputs folder in the browser's storage (OPFS): [] only when there
# is no such folder. Any other failure to read it is given as ['error: <name>'], never as an empty folder,
# so that "nothing left" cannot pass on a listing that failed; a listing is tried three times.
OUTPUTS_LIST = '''async () => { let last;
  for (let i = 0; i < 3; i++) {
    try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('outputs'); const n = []; for await (const [k] of d.entries()) n.push(k); return n.sort(); }
    catch (e) { if (e?.name === 'NotFoundError') return []; last = e; await new Promise((r) => setTimeout(r, 50)); }
  }
  return ['error: ' + (last?.name || last)]; }'''

def gzip_case(page, tmp, plain_text, plain_outputs):
    """The conversion just made with "Gzip the converted file" unticked (plain_text, plain_outputs: the
    control), made again ticked: .gz added, the same text once gunzipped; and the tables, a zip already."""
    import gzip
    const = PLATO / 'schemas/examples/place-centric-constantinople.json'
    page.evaluate("() => { document.getElementById('options').open = true; }")
    page.check('#gzip')
    try:
        s = run_case(page, [const], 'convert', 'ntriples')
        names = [o['name'] for o in s.get('outputs') or []]
        z = download(page, names[0], tmp / names[0]).read_bytes() if s.get('phase') == 'done' and names else b''
        t = run_case(page, [const], 'convert', 'tables')
        tables = [o['name'] for o in t.get('outputs') or []]
    finally:
        page.uncheck('#gzip')
    got = {'plain': [o['name'] for o in plain_outputs or []], 'gzipped': names, 'gzip bytes': len(z), 'tables': tables,
           'tables warned': [i['kind'] for i in (t.get('report') or {}).get('items', []) if i['kind'] == 'gzip-zip']}
    same = z[:2] == b'\x1f\x8b' and gzip.decompress(z).decode('utf-8') == plain_text
    ok = (got['plain'] == ['place-centric-constantinople.nt'] and plain_text.count(' .\n') > 50 and names == ['place-centric-constantinople.nt.gz']
          and same and len(z) < len(plain_text.encode('utf-8')) and tables == ['place-centric-constantinople-tables.zip'] and got['tables warned'] == ['gzip-zip'])
    return ok, {**got, 'the same text once gunzipped': same}

def begun_output(page, name, timeout):
    """Wait until the run under way has begun `name` in the outputs folder and read a place, and is still
    running: (the listing, the places read) as they were seen together. Polled from here: OUTPUTS_LIST is
    async, and wait_for_function (until()) takes the promise an async predicate returns for true at once,
    so a wait made that way did not wait at all (a live run of 12 October 2026 pressed Cancel at once)."""
    t0 = time.time()
    if toolless(page) and timeout > FAST: timeout = FAST; SHORTENED[0] += 1    # the page with no tools: nothing can come
    last = None
    while time.time() - t0 < T(timeout):
        listing = page.evaluate(OUTPUTS_LIST)
        s = page.evaluate('() => ({ places: window.__plato?.progress?.places || 0, phase: window.__plato?.phase })')
        last = (listing, s)
        if name in listing and s['places'] > 0 and s['phase'] == 'running': return listing, s['places']
        time.sleep(0.05)
    raise RuntimeError(f'waited {time.time() - t0:.0f}s for {name} to be begun and a place read: {last}')

def cancel_case(page, tmp):
    """A conversion cancelled while it writes, then the same conversion let finish (the presence)."""
    big = many_places(tmp, 1000)
    name = big.name.replace('.json', '.nt')
    page.set_input_files('#picker', [str(big)])
    s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
    if s.get('phase') != 'detected': return False, s
    page.select_option('#target', 'ntriples')
    page.click('#convert')
    # Under way: its output begun in the browser's storage, and places read; not done. Cancel is pressed
    # only once both are seen, by the listing kept here (begun_output), so the presence cannot be missed.
    during, read = begun_output(page, name, 120)
    got = {'during': during, 'places read': read}
    page.click('#cancel')
    after = wait_state(page, lambda s: s.get('phase') == 'ready', 60, 'ready after Cancel')
    got.update({'after Cancel': after.get('phase'), 'left': page.evaluate(OUTPUTS_LIST), 'offered': after.get('outputs'),
                'result shown': page.evaluate("() => !document.getElementById('result').hidden")})
    page.click('#convert')
    done = wait_state(page, lambda s: s.get('phase') in ('done', 'error'), 600, 'run')
    got.update({'let finish': done.get('phase'), 'error': done.get('error'), 'places': (done.get('report') or {}).get('counts', {}).get('places'),
                'its outputs': [o['name'] for o in done.get('outputs') or []], 'kept': page.evaluate(OUTPUTS_LIST)})
    ok = (name in got['during'] and 0 < got['places read'] < 11000 and got['after Cancel'] == 'ready' and got['left'] == [] and not got['offered']
          and not got['result shown'] and got['let finish'] == 'done' and got['places'] == 11000 and got['its outputs'] == [name] and got['kept'] == [name])
    return ok, got

def agora_checks(page, tmp):
    """Agora, the page's publishing action (the part chosen in #part, then Prepare): one check per part,
    each on a dataset of its own, each finding its output by opening what the page saves."""
    customs = sorted((PLATO / 'schemas/tables/examples/customs').glob('*.csv'))
    w3id = 'https://w3id.org/plato-e2e/customs/'

    # The report: the FAIR summary on the page, and the deposit files, in a zip, as the page saves it.
    s = publish_case(page, customs, 'report')
    try:
        shown = page.inner_text('#summary') if s.get('phase') == 'done' else ''
        buttons = page.eval_on_selector_all('#saves button', 'bs => bs.map((b) => b.textContent)') if shown else []
        z = saved_zip(page, s, tmp, '-deposit.zip')
        names = [n.rsplit('/', 1)[-1] for n in z.namelist()] if z else []
        zenodo = json.loads(z.read(next(n for n in z.namelist() if n.endswith('.zenodo.json')))) if '.zenodo.json' in names else {}
        check('publish report: the FAIR summary, a Save button for the deposit zip, and .zenodo.json, CITATION.cff and datacite.json in it',
              ' of 18 FAIR checks pass' in shown and any('-deposit.zip' in b for b in buttons)
              and {'.zenodo.json', 'CITATION.cff', 'datacite.json'} <= set(names) and zenodo.get('metadata', zenodo).get('upload_type') == 'dataset',
              {'summary': shown, 'buttons': buttons, 'zip': names, 'state': s.get('phase'), 'error': s.get('error')})
    except Exception as e: check('publish report: the FAIR summary, a Save button for the deposit zip, and .zenodo.json, CITATION.cff and datacite.json in it', False, e)

    # Licences that travel with a contribution (Issue #24): a CC BY dataset holding Chora's adoptions
    # (test/fixtures/agora/licences.json, which test/agora-licence.test.js holds to what Chora makes),
    # among them one from a CC BY-NC source (tynemouth) and one from a CC BY source (newcastle), in the
    # same run. The NC one is flagged on the page, with its attestation; the CC BY one is read and
    # counted (6 with a licence of their own) and is in no finding: the absence beside a presence.
    name = 'publish report: an NC adoption in a CC BY dataset is flagged, with its attestation, and a CC BY adoption in the same run is not'
    s = publish_case(page, [ROOT / 'test/fixtures/agora/licences.json'], 'report')
    try:
        done = s.get('phase') == 'done'
        # The report's text whole: a finding's examples are in its <details>, closed until opened.
        shown, summary = (page.text_content('#report') or '', page.inner_text('#summary')) if done else ('', '')
        check(name, 'non-commercial use only (NC)' in shown and 'place/tynemouth#a-2: CC-BY-NC-4.0, World Historical Gazetteer' in shown
              and '6 attestations cite a source with a licence of its own; 5 of them may not agree' in summary
              and 'place/newcastle' not in shown and 'not legal advice' in shown,
              {'summary': summary, 'report': shown[:1500], 'state': s.get('phase'), 'error': s.get('error')})
        # A draft (this dataset is one) is public once its site is uploaded, noindex or not (Issue #26).
        check('publish report: a draft is said to be public once its site is uploaded, though not indexed',
              done and 'A draft is public once its site is uploaded: anyone with the address can read its pages' in summary and '(noindex)' in summary
              and 'GitHub Pages serves a site from a private repository to everyone too' in summary,
              {'summary': summary, 'state': s.get('phase'), 'error': s.get('error')})
    except Exception as e:
        check(name, False, e)
        check('publish report: a draft is said to be public once its site is uploaded, though not indexed', False, e)
    # The same words are not said of a published dataset: its report is read (the FAIR summary is the presence).
    src = tables_copy(tmp / 'published-src' / 'customs', base_uri=w3id, dataset_uri=w3id, status='published')
    s = publish_case(page, src, 'report')
    try:
        summary = page.inner_text('#summary') if s.get('phase') == 'done' else ''
        check('publish report: a published dataset is reported on, and not said to be a draft that is public',
              ' FAIR checks pass' in summary and 'A draft is public' not in summary, {'summary': summary, 'state': s.get('phase'), 'error': s.get('error')})
    except Exception as e: check('publish report: a published dataset is reported on, and not said to be a draft that is public', False, e)

    # Minting: every attestation of the tables gets an address under its place's, '#a-' and a digest.
    # The count is the presence control: an output with no attestations would pass the 'all' alone.
    s = publish_case(page, customs, 'mint')
    try:
        o = next((o for o in (s.get('outputs') or []) if o['name'].endswith('-with-ids.jsonl')), None)
        lines = download(page, o['name'], tmp / o['name']).read_text().strip().split('\n') if o else []
        places = [json.loads(l) for l in lines[1:]]
        ids = [(p['@id'], a.get('@id', '')) for p in places for a in p.get('attestations', [])]
        check('publish mint: a -with-ids.jsonl in which all four attestations have an address <place>#a-…',
              s.get('phase') == 'done' and s['report']['errors'] == 0 and len(ids) == 4 and all(a.startswith(p + '#a-') for p, a in ids), ids or s)
    except Exception as e: check('publish mint: a -with-ids.jsonl in which all four attestations have an address <place>#a-…', False, e)

    # The site, for a draft with a w3id base. A site is made only from a dataset whose attestations
    # have addresses, so the fixture is the tables minted by the command line (not by the check above,
    # whose outcome this one must not inherit).
    src = tables_copy(tmp / 'site-src' / 'customs', base_uri=w3id, dataset_uri=w3id, status='draft')
    subprocess.run(['node', str(ROOT / 'bin/plato-tools.mjs'), 'publish', 'mint', '--out', str(tmp / 'site-in'), str(src[0].parent)], check=True, capture_output=True)
    s = publish_case(page, [tmp / 'site-in' / 'customs-with-ids.jsonl'], 'site', {'repo': 'someone/customs'})
    try:
        z = saved_zip(page, s, tmp, '-site.zip')
        names = set(z.namelist()) if z else set()
        home = z.read('index.html').decode() if 'index.html' in names else ''
        check('publish site: a zip with index.html, place/bristol/index.html and place/bristol.jsonld, and the draft banner on the home page',
              {'index.html', 'place/bristol/index.html', 'place/bristol.jsonld', 'place/deptford-strand.jsonld'} <= names
              and 'DRAFT, not citable' in home and 'noindex' in home, {'zip': sorted(names)[:30], 'state': s.get('phase'), 'report': s.get('report'), 'error': s.get('error')})
    except Exception as e: check('publish site: a zip with index.html, place/bristol/index.html and place/bristol.jsonld, and the draft banner on the home page', False, e)
    # And the site step says a draft site is public once uploaded (Issue #26), beside what it made.
    try:
        summary = page.inner_text('#summary') if s.get('phase') == 'done' else ''
        check('publish site: a draft site is said to be public once uploaded, beside the count of what it made',
              'A site of 2 places' in summary and 'A draft is public once its site is uploaded: anyone with the address can read its pages' in summary,
              {'summary': summary, 'state': s.get('phase'), 'error': s.get('error')})
    except Exception as e: check('publish site: a draft site is said to be public once uploaded, beside the count of what it made', False, e)

    # A subset of the places ("Only these places"): a file naming bristol has bristol's page and not
    # deptford-strand's, which the full site above has. bristol's page is the presence control: a zip
    # with no places at all would pass the absence alone. The file has a blank line and padding, as
    # the command line's --only file may.
    (tmp / 'only.txt').write_text('  bristol  \n\n')
    s = publish_case(page, [tmp / 'site-in' / 'customs-with-ids.jsonl'], 'site', {'repo': 'someone/customs'}, only=tmp / 'only.txt')
    try:
        z = saved_zip(page, s, tmp, '-site.zip')
        names = set(z.namelist()) if z else set()
        check('publish site with only bristol: place/bristol/index.html is in the zip, place/deptford-strand/index.html is not',
              {'index.html', 'place/bristol/index.html', 'place/bristol.jsonld'} <= names
              and not {'place/deptford-strand/index.html', 'place/deptford-strand.jsonld'} & names,
              {'zip': sorted(names)[:30], 'state': s.get('phase'), 'report': s.get('report'), 'error': s.get('error')})
    except Exception as e: check('publish site with only bristol: place/bristol/index.html is in the zip, place/deptford-strand/index.html is not', False, e)

    # The w3id folder, for a published dataset under a w3id base, with its maintainer and repository.
    src = tables_copy(tmp / 'w3id-src' / 'customs', base_uri=w3id, dataset_uri=w3id, status='published')
    s = publish_case(page, src, 'w3id', {'repo': 'someone/customs', 'maintainers': 'someone'})
    try:
        z = saved_zip(page, s, tmp, '.zip')
        names = set(z.namelist()) if z else set()
        rules = z.read('ids/plato-e2e/customs/.htaccess').decode() if 'ids/plato-e2e/customs/.htaccess' in names else ''
        check('publish w3id: a zip with ids/plato-e2e/customs/.htaccess, whose rules send to the repository\'s site',
              'RewriteRule' in rules and 'someone.github.io/customs' in rules, {'zip': sorted(names), 'state': s.get('phase'), 'report': s.get('report'), 'error': s.get('error')})
    except Exception as e: check('publish w3id: a zip with ids/plato-e2e/customs/.htaccess, whose rules send to the repository\'s site', False, e)

    # A previous release chosen for one dataset is not the next one's: choosing a new dataset clears it.
    # It is seen to be chosen first, or its absence afterwards would prove nothing.
    try:
        count = "() => document.getElementById('previous').files.length"
        page.set_input_files('#picker', [str(f) for f in customs])
        wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        page.set_input_files('#previous', [str(PLATO / 'schemas/examples/place-centric-judgements.json')])
        page.set_input_files('#only', [str(tmp / 'only.txt')])
        before = page.evaluate(count)
        only_before = page.evaluate("() => document.getElementById('only').files.length")
        page.set_input_files('#picker', [str(PLATO / 'schemas/examples/place-centric-judgements.json')])
        after_ = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        after = page.evaluate(count)
        only_after = page.evaluate("() => document.getElementById('only').files.length")
        check('choosing a new dataset clears the previous release chosen for the last one', before == 1 and after == 0 and after_.get('phase') == 'detected', {'before': before, 'after': after})
        check('choosing a new dataset clears the list of places to include chosen for the last one', only_before == 1 and only_after == 0 and after_.get('phase') == 'detected', {'before': only_before, 'after': only_after})
    except Exception as e:
        check('choosing a new dataset clears the previous release chosen for the last one', False, str(e).split('\n')[0][:200])
        check('choosing a new dataset clears the list of places to include chosen for the last one', False, str(e).split('\n')[0][:200])

# ---- Tooltips (src/lib/tooltip.js), on the page, Chora's included ---------------------------------
# Each check waits on the tooltip element itself; each absence (no tooltip after Esc, no title left)
# is asserted beside a presence in the same check (a tooltip shown first, the tooltips' texts found),
# so that a page with no tooltips at all fails every one.
SHOWN = """() => [...document.querySelectorAll('[role=tooltip]')].filter((t) => !t.hidden && t.getBoundingClientRect().width > 0).map((t) => {
  const r = t.getBoundingClientRect(); return { id: t.id, role: t.getAttribute('role'), text: t.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
  vw: document.documentElement.clientWidth, vh: window.innerHeight }; })"""
NO_TITLES = """() => ({ titled: [...document.querySelectorAll('body [title], svg title')].map((e) => e.outerHTML.slice(0, 120)),
  tips: [...document.querySelectorAll('[data-tip]')].map((e) => e.dataset.tip),
  templated: [...document.querySelectorAll('[data-tip-template]')].map((e) => document.getElementById(e.dataset.tipTemplate)?.content.textContent || '') })"""

def shown_tips(page, text, timeout=5):
    """The tooltips showing once one holding `text` is shown (or [] if none is, in time)."""
    try: page.wait_for_function('t => [...document.querySelectorAll("[role=tooltip]")].some((x) => !x.hidden && x.textContent.includes(t))', arg=text, timeout=timeout * 1000)
    except Exception: pass
    return page.evaluate(SHOWN)

def tab_to(page, selector, limit=200):
    """Press Tab, as a keyboard user does, until `selector` has focus."""
    for _ in range(limit):
        page.keyboard.press('Tab')
        if page.evaluate('s => document.activeElement?.matches(s)', selector): return True
    raise RuntimeError(f'Tab never reached {selector}')

def tooltip_checks(page, where, hover, focus, edge):
    """hover, focus, edge: (selector, text the tooltip holds); edge's element is so near an edge of the
    window that its tooltip, centred on it, would cross that edge."""
    page.mouse.move(1, 1)
    def on_hover():
        page.hover(hover[0], timeout=10_000); tips = shown_tips(page, hover[1])
        return len(tips) == 1 and hover[1] in tips[0]['text'] and tips[0]['role'] == 'tooltip', tips
    attempt(f'{where}: a tooltip appears on hover, the site\'s own (role tooltip), with the text the title had', on_hover)
    def on_focus():
        page.mouse.move(1, 1); page.wait_for_timeout(300)
        tab_to(page, focus[0]); tips = shown_tips(page, focus[1])
        described = (page.evaluate('() => document.activeElement.getAttribute("aria-describedby")') or '').split()
        return len(tips) == 1 and focus[1] in tips[0]['text'] and tips[0]['role'] == 'tooltip' and tips[0]['id'] in described, {'tips': tips, 'described by': described}
    attempt(f'{where}: a tooltip appears on keyboard focus, and the element focused names it in aria-describedby', on_focus)
    def on_escape():
        before = shown_tips(page, focus[1], 1)
        page.keyboard.press('Escape'); page.wait_for_timeout(200)
        after, still = page.evaluate(SHOWN), page.evaluate('s => document.activeElement?.matches(s)', focus[0])
        return len(before) == 1 and after == [] and still, {'before': before, 'after': after, 'focus kept': still}
    attempt(f'{where}: Esc closes the tooltip, and focus stays where it was', on_escape)
    def esc_passes():
        # The page's own Esc (Terra Draw cancels a drawing with it; the match review closes its form)
        # must still be heard while a tooltip shown by hover is open: Esc closes the tooltip and goes on.
        page.evaluate('() => document.activeElement?.blur()'); page.mouse.move(1, 1); page.wait_for_timeout(300)
        page.evaluate('''() => { window.__escHeard = []; document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') window.__escHeard.push({ prevented: e.defaultPrevented }); }, { once: true }); }''')
        page.hover(hover[0], timeout=10_000); before = shown_tips(page, hover[1])
        page.keyboard.press('Escape'); page.wait_for_timeout(200)
        after, heard = page.evaluate(SHOWN), page.evaluate('() => window.__escHeard')
        return len(before) == 1 and after == [] and heard == [{'prevented': False}], {'before': before, 'after': after, 'page heard Esc': heard}
    attempt(f'{where}: Esc closes a tooltip shown by hover, and the page\'s own Esc handler still hears it', esc_passes)
    def at_edge():
        page.evaluate('() => document.activeElement?.blur()'); page.mouse.move(1, 1); page.wait_for_timeout(300)
        page.hover(edge[0], timeout=10_000); tips = shown_tips(page, edge[1])
        box = lambda sel: page.eval_on_selector(sel, 'e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }')
        a = box(edge[0]); t = tips[0] if len(tips) == 1 else {}
        # It is near the edge: within 60 pixels of it, or so near that its tooltip, centred on it, would cross it.
        mid, half, vw = (a['left'] + a['right']) / 2, (t.get('right', 0) - t.get('left', 0)) / 2, t.get('vw', 1e9)
        near = {'left': a['left'] < 60 or mid - half < 8, 'right': a['right'] > vw - 60 or mid + half > vw - 8}[edge[2]]
        inside = bool(t) and t['left'] >= 0 and t['right'] <= vw and t['top'] >= 0 and t['bottom'] <= t['vh']
        # And it covers neither its own element nor, if one is named, the control beside it (the next zoom button).
        overlaps = lambda b: bool(t) and b['left'] < t['right'] and t['left'] < b['right'] and b['top'] < t['bottom'] and t['top'] < b['bottom']
        covered = [sel for sel in [edge[0]] + list(edge[3:]) if overlaps(box(sel))]
        return edge[1] in t.get('text', '') and near and inside and not covered, {'tooltip': t, 'element': a, 'near': near, 'covers': covered}
    attempt(f'{where}: a tooltip by the window\'s {edge[2]} edge stays within the window' + (', and covers no control beside it' if edge[3:] else ''), at_edge)
    page.mouse.move(1, 1)

def tooltip_upkeep(page, where):
    """What the tooltips do as the page changes around them, on the main page's toolbox: a focused
    container, a hover over a focused element's tooltip, a data-tip removed, and one changed. The
    cards are in groups (one list each), so a card is found by its tool, not by its place in a list."""
    why = lambda n: f"#toolbox .tool-link[data-tool='{('check', 'convert', 'figures', 'versions')[n - 1]}'] .why"
    def reset():
        page.evaluate('() => document.activeElement?.blur()'); page.mouse.move(1, 1); page.wait_for_timeout(300)
    def container():
        # A focused section opens no tooltip of the names inside it; the presence: Tab to its first
        # name (Methodos's, in its card's link), and its own tooltip shows.
        reset(); page.keyboard.press('Shift')        # keyboard last, so the focus that follows is visible focus
        page.evaluate('() => { const s = document.getElementById("toolbox"); s.tabIndex = -1; s.focus(); }')
        page.wait_for_timeout(300)
        on_section = page.evaluate(SHOWN) if page.evaluate('() => document.activeElement?.id') == 'toolbox' else None
        page.keyboard.press('Tab'); link = shown_tips(page, 'μέθοδος')
        page.evaluate('() => document.getElementById("toolbox").removeAttribute("tabindex")')
        return on_section == [] and len(link) == 1 and 'μέθοδος' in link[0]['text'], {'focused section shows': on_section, 'its first name shows': link}
    attempt(f'{where}: a focused container opens none of the tooltips inside it, and its first name, focused, opens its own', container)
    def restored():
        # The link focused shows its tooltip; one shown by hovering another name replaces it; when
        # the pointer leaves, the focused link's is back.
        reset(); tab_to(page, '#toolbox .tool-link[data-tool="check"]'); focused = shown_tips(page, 'ἔλεγχος')
        page.hover(why(2), timeout=10_000); hovered = shown_tips(page, 'μετάφρασις')
        page.mouse.move(1, 1); back = shown_tips(page, 'ἔλεγχος')
        texts = lambda ts: [t['text'][:10] for t in ts]
        return (len(focused) == 1 and 'ἔλεγχος' in focused[0]['text'] and len(hovered) == 1 and 'μετάφρασις' in hovered[0]['text']
                and len(back) == 1 and 'ἔλεγχος' in back[0]['text']), {'focused': texts(focused), 'hovered': texts(hovered), 'after the pointer left': texts(back)}
    attempt(f'{where}: a focused link\'s tooltip, replaced by one shown on hover, comes back when the pointer leaves', restored)
    def dropped():
        # A name's data-tip removed: its tooltip element goes, and its link's aria-describedby no longer
        # names it. The presence: both were there before, and every other tooltip is still there.
        reset(); page.hover(why(3), timeout=10_000); before = shown_tips(page, 'ἀριθμός')
        q = f'(() => {{ const w = document.querySelector("{why(3)}"), a = w?.closest("a"); return {{ tip: w?.dataset.tip, described: a?.getAttribute("aria-describedby"), nodes: document.querySelectorAll("[role=tooltip]").length }}; }})()'
        was = page.evaluate(q); tid = before[0]['id'] if before else None
        page.evaluate(f'() => document.querySelector("{why(3)}").removeAttribute("data-tip")'); page.wait_for_timeout(200)
        now = page.evaluate(q); gone = page.evaluate('id => !!id && !document.getElementById(id)', tid); shown = page.evaluate(SHOWN)
        page.evaluate(f't => document.querySelector("{why(3)}").setAttribute("data-tip", t)', was.get('tip') or '')   # put back, for the checks after
        return (bool(tid) and tid in (was['described'] or '').split() and gone and not (now['described'] or '').split().count(tid)
                and now['nodes'] == was['nodes'] - 1 and shown == []), {'tooltip': tid, 'before': was, 'after': now, 'its element gone': gone, 'shown after': shown}
    attempt(f'{where}: a data-tip removed takes its tooltip element and its aria-describedby id with it, and leaves the others', dropped)
    def refilled():
        # A tooltip's text changed while it shows: placed again, centred on its element, within the window.
        reset(); page.hover(why(4), timeout=10_000); before = shown_tips(page, 'μνήμη')
        old = page.evaluate(f'() => document.querySelector("{why(4)}").dataset.tip')
        page.evaluate(f'() => {{ document.querySelector("{why(4)}").dataset.tip = "Short"; }}'); page.wait_for_timeout(200)
        after = page.evaluate(SHOWN)
        a = page.eval_on_selector(why(4), 'e => { const r = e.getBoundingClientRect(); return (r.left + r.right) / 2; }')
        page.evaluate(f't => {{ document.querySelector("{why(4)}").dataset.tip = t; }}', old)
        t = after[0] if len(after) == 1 else {}
        centred = bool(t) and abs((t['left'] + t['right']) / 2 - a) <= 1.5 and t['left'] >= 0 and t['right'] <= t['vw']
        return len(before) == 1 and t.get('text') == 'Short' and (t['right'] - t['left']) < (before[0]['right'] - before[0]['left']) and centred, {
            'before': before, 'after': after, 'element centre': a}
    attempt(f'{where}: a tooltip whose text changes while it shows is placed again, centred on its element', refilled)
    reset()

def no_titles(page, where, expected):
    def check_it():
        r = page.evaluate(NO_TITLES); said = r['tips'] + r['templated']
        missing = [t for t in expected if not any(t in x for x in said)]
        return not r['titled'] and not missing, {'title attributes': r['titled'], 'tooltip texts missing': missing}
    attempt(f'{where}: no element has a title attribute (the browser\'s own tooltip), and the tooltips\' texts are there instead', check_it)

REMOTE = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--url=')), None)
# "--url <address>", with a space, was once read as no --url at all, and a run that tested this
# build was taken for a check of the deployed site. Refuse it rather than guess.
if '--url' in sys.argv: sys.exit('Give the deployed site as --url=<address>, with an equals sign.')

def main():
    plato_at_pin()
    if REMOTE:                                    # the deployed site: a green local run is not a green deploy
        srv = subprocess.Popen(['true']); url = REMOTE
    else:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', PORT)) == 0:
                sys.exit(f'Port {PORT} is in use, so the page there is not this build: set E2E_PORT to a free port.')
        subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
        # On 127.0.0.1, named: vite's own "localhost" was ::1 alone on GitHub's runners, where the checks
        # that read the page at 127.0.0.1 (another origin than localhost) found nothing there.
        srv = subprocess.Popen(['npx', 'vite', 'preview', '--host', '127.0.0.1', '--port', str(PORT), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
        url = f'http://localhost:{PORT}/'
    for _ in range(60):
        try: urllib.request.urlopen(url, timeout=1); break
        except Exception: time.sleep(0.5)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='plato-tools-e2e-'))
    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(str(tmp / 'profile'), headless=True, accept_downloads=True)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            main_requests = []
            ctx.on('request', lambda r: main_requests.append(r.url))
            page.add_init_script('window.__plato_forceDownload = true;')
            page.goto(NOTOOLS if PROVE else url)
            if PROVE and page.url != NOTOOLS: sys.exit(f'--prove-it-fails: the page with no tools reports its address as {page.url!r}, not NOTOOLS: no wait would be cut short')
            ready = wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            check('page is ready and names the PLATO commit it checks against', ready.get('phase') == 'ready' and len(ready.get('platoCommit') or '') == 40, ready)
            # The commit shown is the one served, and a draft pin (a PLATO branch, not a release) says so.
            served = json.loads(urllib.request.urlopen(url.rstrip('/') + '/plato/VERSION.json', timeout=10).read())
            footer = page.evaluate("() => document.getElementById('plato-version')?.textContent || ''")
            check('the footer shows the commit served, and says DRAFT exactly when the pin is a draft',
                  ready.get('phase') == 'ready' and ready.get('platoCommit') == served['commit'] and served['commit'][:7] in footer
                  and ('DRAFT' in footer) == bool(served.get('draft')), {'footer': footer, 'served': served})
            # The tooltips and the "Experimental" badge's, at a phone's width, where the badge's
            # tooltip is wider than the room on one side of the badge: the badge sits beside the name,
            # by the window's right edge, or wrapped below it, by the left, as the fonts fall; the
            # check is made at whichever edge it is by. (Chora's zoom buttons are by the right, below.)
            page.set_viewport_size({'width': 390, 'height': 844})
            side = 'left'
            try: side = 'right' if page.eval_on_selector('.dev-badge', 'e => e.getBoundingClientRect().right > innerWidth - 60') else 'left'
            except Exception: pass
            tooltip_checks(page, 'tooltips', ('#toolbox .tool-link[data-tool="convert"] .why', 'μετάφρασις'), ('.dev-badge', 'is experimental'),
                           ('.dev-badge', 'is experimental', side))
            no_titles(page, 'tooltips', ['μέθοδος', 'ἔλεγχος', 'μετάφρασις', 'ἀριθμός', 'μνήμη', 'Ἑρμῆς', 'ἀγορά', 'χώρα', 'κρίσις', 'περιπλέω', 'checked against PLATO at the commit'])
            tooltip_upkeep(page, 'tooltips')
            page.set_viewport_size({'width': 1280, 'height': 720})

            ex = PLATO / 'schemas/tables/examples'
            # Every text the progress line shows, as the page shows it, for the check of the tables below.
            page.evaluate('''() => { window.__phases = []; const el = document.getElementById('phase');
              if (el) new MutationObserver(() => window.__phases.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); }''')
            s = run_case(page, sorted((ex / 'customs').glob('*.csv')), 'check')
            check('customs tables: detected as tables and checked with no problems', s.get('format') == 'tables' and s.get('phase') == 'done' and s['report']['errors'] == 0, s.get('report') or s)
            shown = page.evaluate('() => window.__phases || []')
            check('the page says when the tables are being checked, between their loading and indexing',
                  any(t.startswith('Checking the tables') for t in shown) and any(t.startswith('Indexing') for t in shown), shown)
            s = run_case(page, sorted((ex / 'survey').glob('*.csv')), 'check')
            errs = [i for i in (s.get('report') or {}).get('items', []) if i['severity'] == 'error']
            check('survey tables: checked with no problems (a label-only type and an evidence-less place are valid PLATO)', s.get('phase') == 'done' and not errs and (s.get('report') or {}).get('counts', {}).get('places') == 3, errs or s)
            s = run_case(page, sorted((ex / 'customs').glob('*.csv')), 'convert', 'plato-jsonl')
            ok = s.get('phase') == 'done' and s.get('outputs')
            out = download(page, s['outputs'][0]['name'], tmp / 'customs.jsonl') if ok else None
            lines = out.read_text().strip().split('\n') if out else []
            check('customs tables -> JSON Lines: saved, a header and two places', ok and len(lines) == 3 and json.loads(lines[0]).get('profile') == 'place-centric', s if not ok else len(lines))
            s = run_case(page, [ROOT / 'test/fixtures/lpf-readme-example.json'], 'convert', 'plato-json')
            ok = s.get('phase') == 'done' and s.get('outputs')
            doc = json.loads(download(page, s['outputs'][0]['name'], tmp / 'abingdon.json').read_text()) if ok else {}
            check('LPF README example -> PLATO JSON: one place, its losses reported', ok and len(doc.get('spatialEntities', [])) == 1 and any(i['kind'] == 'lpf-duration' for i in s['report']['items']), s if not ok else doc.keys())
            # Recogito's web annotations: the confirmed links become attestations, and the link
            # software suggested and nobody confirmed (Lechaeum) is reported, not converted.
            s = run_case(page, [ROOT / 'test/fixtures/annotations/recogito-v1-constructed.jsonld'], 'convert', 'plato-json')
            ok = s.get('phase') == 'done' and s.get('outputs')
            doc = json.loads(download(page, s['outputs'][0]['name'], tmp / 'annotations.json').read_text()) if ok else {}
            names = [n['toponym'] for p in doc.get('spatialEntities', []) for a in p['attestations'] for n in a.get('names', [])]
            check('Recogito annotations -> PLATO JSON: linked places converted, the unconfirmed link reported',
                  ok and s.get('format') == 'w3c-annotations' and 'Corinthus' in names and 'Lechaeum' not in names and any(i['kind'] == 'annotation-unverified' for i in s['report']['items']), s if not ok else names)
            s = run_case(page, [PLATO / 'schemas/examples/place-centric-constantinople.json'], 'convert', 'ntriples')
            ok = s.get('phase') == 'done' and s.get('outputs')
            nt = download(page, s['outputs'][0]['name'], tmp / 'c.nt').read_text() if ok else ''
            check('Constantinople JSON -> N-Triples: triples written and saved', ok and nt.count(' .\n') > 50 and 'attests_about' in nt, s if not ok else nt[:200])
            attempt('"Gzip the converted file": the N-Triples above, gzipped as written, named .nt.gz, the same text once gunzipped; the tables are a zip already, not gzipped, and say so',
                    lambda: gzip_case(page, tmp, nt, s.get('outputs') if ok else None))
            attempt('Cancel during a conversion: the run stops, and the half-written file it had begun in the browser\'s storage is removed, not offered; let finish, the same conversion\'s file is there and offered',
                    lambda: cancel_case(page, tmp))
            # A source's denial (plato:negated) must never reach LPF as an assertion: Littleworth
            # had no market, so its feature must carry no market, and the page must say why.
            s = run_case(page, [PLATO / 'schemas/examples/place-centric-judgements.json'], 'convert', 'lpf')
            ok = s.get('phase') == 'done' and s.get('outputs')
            fc = json.loads(download(page, s['outputs'][0]['name'], tmp / 'judgements.geojson').read_text()) if ok else {}
            lw = next((f for f in fc.get('features', []) if f.get('@id', '').endswith('/littleworth')), None)
            # Kingsbury's markets are asserted, with a source stance (reported, doubted), so they are rightly
            # written: the search for the denied market leaves them out, and they are the control that it can see one.
            kb = next((f for f in fc.get('features', []) if f.get('@id', '').endswith('/kingsbury')), None)
            facets = json.dumps([[f.get(k) for k in ('names', 'types', 'relations', 'geometry', 'descriptions', 'links')] for f in fc.get('features', []) if f is not kb])
            shown = page.inner_text('#report') if ok else ''
            check('a denial -> LPF: the place is written, the denied market is not, and the page says so',
                  ok and lw is not None and 'types' not in lw and '"market"' not in facets and len(fc['features']) == 6
                  and kb is not None and [x.get('label') for x in kb.get('types', [])] == ['market', 'market']
                  and any(i['kind'] == 'denial' for i in s['report']['items']) and 'would assert what its source denies' in shown, s.get('report') or s)
            bad = tmp / 'bad.nt'; bad.write_text('<https://x.org/a> <https://w3id.org/plato#notes> "fine" .\n<https://x.org/a> <https://w3id.org/plato#notes "broken .\n')
            s = run_case(page, [bad], 'check')
            check('broken N-Triples: the bad line is reported by number', s.get('phase') == 'done' and any(i['kind'] == 'rdf-syntax' and 'line 2' in ' '.join(i['examples']) for i in s['report']['items']), s.get('report') or s)
            nul = tmp / 'null-coordinate.json'
            nul.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 't'}, 'spatialEntities': [
                {'@id': 'https://example.org/p/1', 'label': 'Ranny', 'attestations': [{'geometries': [{'reprPoint': [130.6, None]}], 'sources': [{'title': 's'}]}]}]}))
            s = run_case(page, [nul], 'check')
            check('a null coordinate: the check finishes and reports it (it used to stop the check)', s.get('phase') == 'done' and any(i['kind'] == 'null-value' for i in (s.get('report') or {}).get('items', [])), s.get('report') or s)
            cut = tmp / 'cut-short.json'
            cut.write_text((PLATO / 'schemas/examples/place-centric-constantinople.json').read_text()[:1500])
            s = run_case(page, [cut], 'check')
            shown = page.inner_text('#summary') if s.get('phase') == 'done' else ''
            check('a JSON file cut short: reported as a problem in the report, not "Something went wrong"', s.get('phase') == 'done' and any(i['kind'] == 'unreadable' for i in (s.get('report') or {}).get('items', [])) and 'Something went wrong' not in shown, s.get('report') or s)
            latin = tmp / 'latin-1.json'
            latin.write_bytes((PLATO / 'schemas/examples/place-centric-constantinople.json').read_text().replace('"label": "', '"label": "K\u00f6ln ', 1).encode('latin-1', 'replace'))
            s = run_case(page, [latin], 'check')
            shown = page.inner_text('#summary') if s.get('phase') == 'done' else ''
            check('a file not in UTF-8: reported as unreadable in the report, saying so, not "Something went wrong"', s.get('phase') == 'done' and any(i['kind'] == 'unreadable' and 'not encoded as UTF-8' in ' '.join(i['examples']) for i in (s.get('report') or {}).get('items', [])) and 'Something went wrong' not in shown, s.get('report') or s)
            png = tmp / 'picture.png'; png.write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 64)
            s = run_case(page, [png], 'check')
            check('an image is not mistaken for data', s.get('phase') == 'unrecognised', s)
            # The version check: the file chosen is the later version, and the earlier one is asked for.
            # The same example against itself must compare clean AND say how many attestations it
            # compared; with one name respelt, that attestation must be named as changed.
            judgements = PLATO / 'schemas/examples/place-centric-judgements.json'
            s = compare_case(page, judgements, judgements)
            shown = page.inner_text('#summary') if s.get('phase') == 'done' else ''
            check('version check: the example against itself has nothing deleted or changed, all ten attestations compared',
                  s.get('phase') == 'done' and s['report']['errors'] == 0 and s['report']['counts'].get('unchanged') == 10 and 'Nothing was deleted or changed' in shown, s.get('report') or s)
            d = json.loads(judgements.read_text()); d['spatialEntities'][1]['attestations'][0]['names'][0]['toponym'] = 'Newton, respelt'
            edited = tmp / 'judgements-v2.json'; edited.write_text(json.dumps(d))
            s = compare_case(page, edited, judgements)
            # text_content, not inner_text: the address is an example, inside a closed <details>.
            shown = page.text_content('#report') if s.get('phase') == 'done' else ''
            changed = next((i for i in (s.get('report') or {}).get('items', []) if i['kind'] == 'attestation-changed'), None)
            check('version check: a respelt name is reported as a changed attestation, by its address, as a breach of the append-only rule',
                  s.get('phase') == 'done' and s['report']['errors'] == 1 and changed and changed['examples'] == ['https://whgazetteer.org/example/attestation/newton-a']
                  and 'append-only rule' in shown and 'attestation/newton-a' in shown, s.get('report') or s)
            check('version check: the page shows what changed in it, the old spelling and the new',
                  'Only in the earlier version: plato:attests_name [plato:toponym "Neuton"]' in shown
                  and 'Only in the later version: plato:attests_name [plato:toponym "Newton, respelt"]' in shown, shown[-600:])
            # Elenchos: a dataset checked with its candidate set reads the set and finds nothing; with a set
            # made for another dataset, the two ends of the link disagree, and the page says so.
            ac = PLATO / 'schemas/examples/attestation-centric-judgements.json'
            cs = PLATO / 'schemas/examples/candidate-set-judgements.json'
            s = candidates_case(page, ac, [cs])
            items = (s.get('report') or {}).get('items', [])
            check('candidate sets: the dataset with its own set has no problems, and the set is read',
                  s.get('phase') == 'done' and s['report']['errors'] == 0 and s['report']['counts'].get('candidates given') == 2
                  and not any(i['kind'].startswith('promoted-from') for i in items), s.get('report') or s)
            d = json.loads(cs.read_text()); d['candidateSet']['candidatesFor'] = 'https://whgazetteer.org/example/gazetteer/elsewhere'
            elsewhere = tmp / 'elsewhere-set.json'; elsewhere.write_text(json.dumps(d))
            s = candidates_case(page, ac, [elsewhere])
            shown = page.text_content('#report') if s.get('phase') == 'done' else ''
            check('candidate sets: a listed set made for another dataset is a problem, shown in words',
                  s.get('phase') == 'done' and [i['kind'] for i in s['report']['items'] if i['severity'] == 'error'] == ['ends-disagree']
                  and 'says it is for another dataset' in shown, s.get('report') or s)
            agora_checks(page, tmp)

            # ---- Hermes: TEI editions, and any CSV or GeoJSON read through a matching of its columns.
            # These checks need the pipeline hook for the 'tei', 'csv' and 'geojson' inputs in
            # src/engine/pipeline.js (the dispatch to teiSource and genericSource); without it, they fail.
            s = run_case(page, [ROOT / 'test/fixtures/tei/isicily-ISic000934.xml'], 'convert', 'plato-json')
            ok = s.get('phase') == 'done' and s.get('outputs')
            said = page.inner_text('#chosen') if s.get('format') else ''
            doc = json.loads(download(page, s['outputs'][0]['name'], tmp / 'isicily.json').read_text()) if ok else {}
            atts = [a for p in doc.get('spatialEntities', []) for a in p.get('attestations', [])]
            # The name in the English commentary is the editors' words (the file has a div type="edition"),
            # reported and not converted unless the commentary-places option is chosen; the inscription's is converted.
            editorial = next((i for i in (s.get('report') or {}).get('items', []) if i['kind'] == 'tei-place-editorial'), None)
            check('TEI edition -> PLATO JSON: the page says it is TEI; the place name in the inscription becomes an attestation about Pleiades 678374, the one in the commentary is reported as the editors\' words',
                  ok and s.get('format') == 'tei' and 'a TEI XML edition' in said and len(atts) == 1
                  and [p['@id'] for p in doc['spatialEntities']] == ['https://pleiades.stoa.org/places/678374']
                  and editorial is not None and any(e.startswith('commentary: Sarepta') for e in editorial['examples']), s.get('report') or s)

            # A CSV file with odd headings: the matching is shown as a table, one labelled dropdown for
            # each column, the guess and its reason in words, three examples of each.
            odd = ROOT / 'test/fixtures/generic/odd-headers.csv'
            guess = {'Place Name': 'name', 'LAT': 'latitude', 'Long': 'longitude', 'wikidata': 'address', 'Feature Type': 'type', 'Alt. names': 'alternativeNames', 'Source': 'source', 'Remarks': 'note'}
            s = table_case(page, odd)
            cols = s.get('columns') or {}
            shown = page.inner_text('#columns') if cols else ''
            a11y = page.evaluate("""() => { const t = document.querySelector('#columns table'); if (!t) return null;
                const sels = [...t.querySelectorAll('select')];
                return { caption: t.caption?.textContent || '', selects: sels.length, labelled: sels.filter((x) => x.labels.length === 1 && x.labels[0].textContent.includes('Read the column')).length,
                         options: [...(sels[0]?.options || [])].map((o) => o.value) }; }""") if cols else None
            check('odd-headed CSV: the matching table shows the right guess for every column, with its reason and examples, a caption and a label for each dropdown',
                  s.get('format') == 'csv' and cols.get('mapping') == guess and a11y and a11y['selects'] == 8 and a11y['labelled'] == 8
                  and 'odd-headers.csv' in a11y['caption'] and 'properties' not in a11y['options'] and 'skip' in a11y['options'] and 'note' in a11y['options']
                  and 'the heading "LAT" reads as latitude' in shown and 'the heading is not one these tools recognise' in shown
                  and 'Roma' in shown and 'Athenae' in shown and 'Lutetia' in shown and 'Aquae Sulis' not in shown and cols.get('warnings') == [], {'state': cols, 'a11y': a11y})
            # The warnings, each seen appearing where it was absent: an address column, then no id and no
            # address; a latitude with its longitude, then without.
            noids = 'These places will have no web addresses'
            before = page.inner_text('#columns-warnings') if cols else None
            s = table_case(page, odd, {'wikidata': 'note', 'Long': 'note'})
            after = page.inner_text('#columns-warnings') if s.get('columns') else ''
            check('odd-headed CSV: with no address or id column, and a latitude without a longitude, the page warns of both, and that the wikidata column is not the address',
                  before == '' and noids in after and 'read as latitude but none as longitude' in after and 'The column \u201cwikidata\u201d is named for a gazetteer' in after
                  and len((s.get('columns') or {}).get('warnings', [])) == 3, {'before': before, 'after': after})

            # Changing a dropdown changes the output: first the guess, as the control (the types are
            # carried and the remark kept in the notes), then with Feature Type kept as a note and
            # Remarks not carried over.
            def roma(s, name):
                ok = s.get('phase') == 'done' and s.get('outputs')
                doc = json.loads(download(page, s['outputs'][0]['name'], tmp / name).read_text()) if ok else {}
                # Roma's attestation, with the address of the place it is about beside it.
                return next(({**a, 'place': p.get('@id')} for p in doc.get('spatialEntities', []) for a in p.get('attestations', []) if any(n.get('toponym') == 'Roma' for n in a.get('names', []))), None)
            s = table_case(page, odd, {}, 'convert', 'plato-json')
            r1 = roma(s, 'odd-guess.json')
            check('odd-headed CSV -> PLATO JSON with the guess: Roma is about Wikidata Q220 (its entity address, rule wikidata-page), typed "city", with the remark in its notes, and no column reported as not carried',
                  r1 is not None and r1['place'] == 'http://www.wikidata.org/entity/Q220' and [t.get('label') for t in r1.get('types', [])] == ['city']
                  and 'Remarks: the capital' in r1.get('notes', '') and not any(i['kind'] == 'generic-column-skipped' for i in s['report']['items']), (s.get('report') or s) if r1 is None else r1)
            s = table_case(page, odd, {'Feature Type': 'note', 'Remarks': 'skip'}, 'convert', 'plato-json')
            r2 = roma(s, 'odd-chosen.json')
            skipped = next((i for i in (s.get('report') or {}).get('items', []) if i['kind'] == 'generic-column-skipped'), None)
            shown = page.text_content('#report') if r2 else ''
            check('odd-headed CSV with two dropdowns changed: the type is now a note, and Remarks is not carried and is reported by name as not carried over',
                  r2 is not None and 'types' not in r2 and 'Feature Type: city' in r2.get('notes', '') and 'Remarks' not in r2.get('notes', '')
                  and skipped and skipped['severity'] == 'loss' and skipped['examples'] == ['Remarks'] and 'Not carried over' in shown and 'Remarks' in shown, (s.get('report') or s) if r2 is None else r2)
            # Save this matching, then use it again on a fresh choice of the file: the dropdowns come back as saved.
            try:
                with page.expect_download(timeout=30_000) as d: page.click('#columns-save')
                d.value.save_as(tmp / 'matching.json'); saved = json.loads((tmp / 'matching.json').read_text())
            except Exception as e: saved = {'error': str(e)[:200]}
            s = table_case(page, odd)
            fresh = (s.get('columns') or {}).get('mapping')
            try:
                page.set_input_files('#columns-file', [str(tmp / 'matching.json')])
                s = wait_state(page, lambda s: any('Using the matching saved' in m for m in (s.get('columns') or {}).get('messages', [])), 30, 'load')
            except Exception as e: s = {'error': str(e)[:200]}
            back = (s.get('columns') or {}).get('mapping')
            values = page.evaluate("() => [...document.querySelectorAll('#columns select')].map((x) => x.value)") if back else []
            check('save this matching, then use it again: the JSON saved is the matching chosen, and loading it sets the dropdowns back from the guess',
                  saved == {**guess, 'Feature Type': 'note', 'Remarks': 'skip'} and fresh == guess and back == saved and values == list(saved.values()), {'saved': saved, 'fresh': fresh, 'back': back})

            # Plain GeoJSON is read as a table of its features' properties; LPF is still LPF.
            s1 = table_case(page, ROOT / 'test/fixtures/generic/plain.geojson')
            said1 = page.inner_text('#chosen') if s1.get('format') else ''
            table1 = page.is_visible('#columns table') if s1.get('columns') else False
            s2 = run_case(page, [ROOT / 'test/fixtures/lpf-readme-example.json'], 'check')
            table2 = page.is_visible('#columns') if s2.get('format') else True
            check('plain GeoJSON is detected as GeoJSON and shows its properties to match, while the LPF example is still LPF and shows none',
                  s1.get('format') == 'geojson' and 'plain GeoJSON' in said1 and table1 and (s1.get('columns') or {}).get('mapping', {}).get('NAME') == 'name'
                  and s2.get('format') == 'lpf' and s2.get('phase') == 'done' and table2 is False, {'geojson': s1.get('format'), 'lpf': s2.get('format'), 'table1': table1, 'table2': table2})

            # A IIIF Georeference Annotation (Allmaps) is recognised and refused with the reason, as a
            # file that is not recognised is, where it used to be read as place-less annotations; the
            # Recogito export beside it, the control, is still annotations.
            s1 = run_case(page, [ROOT / 'test/fixtures/hermes-detect/loc-chesapeake-annotationpage.json'], 'check')
            said1 = page.inner_text('#chosen') if s1.get('phase') == 'unrecognised' else ''
            acts1 = page.is_visible('#action') if s1.get('phase') == 'unrecognised' else True
            s2 = run_case(page, [ROOT / 'test/fixtures/annotations/recogito-v1-islandia-map.jsonld'], 'check')
            check('a IIIF Georeference Annotation is refused on the page with the reason, and offers no check; a Recogito export is still read',
                  s1.get('phase') == 'unrecognised' and 'IIIF Georeference Annotation' in said1 and 'drop it together with the Recogito export' in said1 and acts1 is False
                  and s2.get('format') == 'w3c-annotations' and s2.get('phase') == 'done', {'georef': s1, 'shown': said1, 'actions': acts1, 'recogito': s2.get('format')})

            # Georeferenced regions: the constructed Recogito Studio export dropped together with the
            # Rocque map's georeference and manifest gives label-anchor points; the same export alone,
            # the control, gives no geometry at all, and the same places.
            regions = ROOT / 'test/fixtures/annotations/recogito-studio-regions-constructed.json'
            geo = ROOT / 'test/fixtures/georef'
            s1 = run_case(page, [regions, geo / 'bpl-rocque-annotation.json', geo / 'bpl-rocque-manifest.json'], 'convert', 'plato-json')
            said1 = page.inner_text('#chosen') if s1.get('phase') == 'done' else ''
            ok1 = s1.get('phase') == 'done' and bool(s1.get('outputs'))
            doc1 = json.loads(download(page, s1['outputs'][0]['name'], tmp / 'regions-placed.json').read_text()) if ok1 else {}
            geoms1 = [g for p in doc1.get('spatialEntities', []) for a in p['attestations'] for g in a.get('geometries', [])]
            s2 = run_case(page, [regions], 'convert', 'plato-json')
            ok2 = s2.get('phase') == 'done' and bool(s2.get('outputs'))
            doc2 = json.loads(download(page, s2['outputs'][0]['name'], tmp / 'regions-alone.json').read_text()) if ok2 else {}
            geoms2 = [g for p in doc2.get('spatialEntities', []) for a in p['attestations'] for g in a.get('geometries', [])]
            anchors = [g for g in geoms1 if g.get('role') == 'https://w3id.org/plato#LabelAnchor' and g.get('geojson', {}).get('type') == 'Point' and g.get('precisionKm')]
            check('a Recogito export dropped with a georeference and its manifest gives LabelAnchor points; the export alone gives none',
                  ok1 and s1.get('format') == 'w3c-annotations' and 'with 1 georeference and 1 IIIF manifest' in said1 and len(anchors) == 5
                  and any(i['kind'] == 'annotation-region-shape' for i in s1['report']['items'])
                  and ok2 and not geoms2 and len(doc2.get('spatialEntities', [])) == len(doc1.get('spatialEntities', [])) > 0,
                  {'placed': s1.get('phase'), 'shown': said1, 'anchors': len(anchors), 'alone': s2.get('phase'), 'geoms alone': len(geoms2)})
            reading_checks(page, tmp)
            within_checks(page, tmp)
            spellings_checks(page, tmp)
            krisis_case(page, tmp)
            krisis_pattern_match(page, tmp)
            krisis_withdraw_case(page, tmp)
            krisis_withdraw_draft_case(page, tmp)

            # The storage warning (src/app.js, storageCheck): shown when the browser's quota is below
            # what the tables need, and hidden, the control, with the same tables and the real quota.
            # Each page counts its calls of navigator.storage.estimate, so that the hidden warning is
            # read after the page has asked, not before; one page is told its quota is 1,000 bytes.
            def storage_warning(quota):
                p = ctx.new_page()
                try:
                    p.add_init_script('''(() => { const real = navigator.storage.estimate.bind(navigator.storage); window.__estimates = 0;
                      navigator.storage.estimate = async () => { const e = await real(); window.__estimates++; return %s; }; })()''' % ('{ ...e, quota: %d }' % quota if quota else 'e'))
                    p.goto(NOTOOLS if PROVE else url)
                    if wait_state(p, lambda s: s.get('phase') == 'ready', 30, 'ready').get('phase') != 'ready': return None
                    p.set_input_files('#picker', [str(f) for f in sorted((ex / 'customs').glob('*.csv'))])
                    if wait_state(p, lambda s: s.get('phase') == 'detected', 60, 'detection').get('phase') != 'detected': return None
                    p.wait_for_function('() => window.__estimates > 0', timeout=10_000)   # a function: the page's policy refuses eval; p.wait_for_timeout(300)
                    return {'visible': p.is_visible('#storage-warning'), 'text': p.inner_text('#storage-warning')}
                except Exception as e:
                    return {'error': str(e).split('\n')[0][:200]}
                finally:
                    p.close()
            low, normal = storage_warning(1000), storage_warning(None)
            check('the storage warning shows when the quota is below what the tables need, naming the quota, and not with the real quota',
                  (low or {}).get('visible') is True and 'allows the page only 1000 bytes of storage' in low.get('text', '')
                  and (normal or {}).get('visible') is False, {'low': low, 'normal': normal})

            # Two tabs of the main page: the working files are one tab's at a time while it runs. A run
            # in a second tab while the first runs is told so in words, not in the browser's own
            # (createSyncAccessHandle); the control, the same run alone, before and after, says nothing of it.
            POOL_BUSY = 'Another tab of PLATO tools in this browser is working on a file. Wait for it to finish, or close it, then try again.'
            def two_mains():
                big = tables_copy(tmp / 'busy-tables')
                with open(tmp / 'busy-tables' / 'places.csv', 'a', encoding='utf-8') as fh:
                    fh.writelines(f'busy-{i},Busy place {i},GB\n' for i in range(200_000))
                small = sorted((ex / 'customs').glob('*.csv'))
                two = ctx.new_page()
                try:
                    two.goto(NOTOOLS if PROVE else url)
                    if wait_state(two, lambda s: s.get('phase') == 'ready', 30, 'ready').get('phase') != 'ready': return None
                    said = lambda p: p.evaluate("() => document.getElementById('summary')?.textContent || ''")
                    alone = run_case(two, small, 'check')
                    r = {'alone': alone.get('phase'), 'alone said': said(two)}
                    page.set_input_files('#picker', [str(f) for f in big])
                    if wait_state(page, lambda s: s.get('phase') == 'detected', 60, 'detection').get('phase') != 'detected': return {**r, 'first': 'not detected'}
                    two.set_input_files('#picker', [])
                    two.set_input_files('#picker', [str(f) for f in small])
                    if wait_state(two, lambda s: s.get('phase') == 'detected', 60, 'detection').get('phase') != 'detected': return {**r, 'second': 'not detected'}
                    # The first holds the working files once its run reports progress (which comes from the run, after
                    # they are taken up), not when the page says it is running: its worker may not have begun.
                    page.evaluate('() => { window.__plato.progress = null; }')
                    page.click('#check')
                    r['first running'] = wait_state(page, lambda s: s.get('phase') == 'running' and s.get('progress'), 60, 'running').get('phase')
                    two.click('#check')
                    during = wait_state(two, lambda s: s.get('phase') in ('done', 'error'), 60, 'run')
                    r.update({'during': during.get('phase'), 'during said': said(two), 'during state': during.get('said'),
                              'first still running': page.evaluate('() => window.__plato.phase')})
                    first = wait_state(page, lambda s: s.get('phase') in ('done', 'error'), 300, 'run')
                    r['first'] = first.get('phase'); r['first error'] = first.get('error')
                    two.set_input_files('#picker', [])   # the same files again: emptied first, or the page would not look at them
                    after = run_case(two, small, 'check')
                    r.update({'after': after.get('phase'), 'after said': said(two)})
                    return r
                except Exception as e:
                    return {'error': str(e).split('\n')[0][:200]}
                finally:
                    two.close()
            busy = two_mains() or {}
            check('a run in a second tab of the main page while the first runs says another tab is working, in words',
                  busy.get('first running') == 'running' and busy.get('first still running') == 'running'
                  and busy.get('during') == 'error' and busy.get('during state') == POOL_BUSY and busy.get('during said') == POOL_BUSY
                  and 'Something went wrong' not in busy.get('during said', '') and busy.get('first') == 'done', busy)
            check('the same run in the second tab alone, before and after, says nothing of another tab',
                  busy.get('alone') == 'done' and busy.get('after') == 'done'
                  and busy.get('alone said', '') and POOL_BUSY not in busy.get('alone said', '') + busy.get('after said', 'x'), busy)

            # Half taken: a tab whose take-up of the working files is refused part-way (another holds
            # some of them, not all) is granted the rest, and must let them go, or every later run in
            # it fails ("no such vfs") and the files it holds keep other tabs out. Here a page holds two
            # of the pool's files itself (createSyncAccessHandle, in a worker of its own), the main page
            # is refused, and, those two let go, it runs again. Refused once more, it must let go at once,
            # not at its next run, so that a second tab can run while it waits.
            HOLDER = """async (n) => {
              const src = `let held = []; onmessage = async ({ data }) => {
                if (data === 'release') { for (const h of held) h.close(); held = []; postMessage(0); return; }
                const o = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('.opfs-sahpool')).getDirectoryHandle('.opaque');
                for await (const [, h] of o) if (h.kind === 'file' && held.length < data) held.push(await h.createSyncAccessHandle());
                postMessage(held.length); };`;
              window.holder = window.holder || new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
              return new Promise((res) => { holder.onmessage = (e) => res(e.data); holder.postMessage(n); });
            }"""
            def half_taken():
                small = sorted((ex / 'customs').glob('*.csv'))
                said = lambda p: p.evaluate("() => document.getElementById('summary')?.textContent || ''")
                def choose(p):
                    p.set_input_files('#picker', [])   # the same files again: emptied first, or the page would not look at them
                    p.set_input_files('#picker', [str(f) for f in small])
                    return wait_state(p, lambda s: s.get('phase') == 'detected', 60, 'detection').get('phase') == 'detected'
                def ran(p):
                    s = wait_state(p, lambda s: s.get('phase') in ('done', 'error'), 60, 'run')
                    return {'phase': s.get('phase'), 'said': said(p), 'state said': s.get('said')}
                holder, two = ctx.new_page(), ctx.new_page()
                r = {}
                try:
                    for p in (holder, two):
                        p.goto(NOTOOLS if PROVE else url)
                        if wait_state(p, lambda s: s.get('phase') == 'ready', 30, 'ready').get('phase') != 'ready': return None
                    # Both main pages have their pool, let go between runs, so the holder can take some of it.
                    r['first alone'] = run_case(page, small, 'check').get('phase')
                    r['second alone'] = run_case(two, small, 'check').get('phase')
                    r['held'] = holder.evaluate(HOLDER, 2)
                    if not choose(page): return {**r, 'first': 'not detected'}
                    page.click('#check'); r['refused'] = ran(page)
                    r['released'] = holder.evaluate(HOLDER, 'release')
                    if not choose(page): return {**r, 'first': 'not detected'}
                    page.click('#check'); r['again'] = ran(page)
                    # Refused again, the tab must hold none of the files while it waits (not until its own next
                    # run): another tab runs meanwhile, and then it runs too. Were it to keep what it was
                    # granted, the other would be refused on those, and keep some itself, each tab then
                    # keeping the other out each time either tried again.
                    r['held again'] = holder.evaluate(HOLDER, 2)
                    if not choose(page): return {**r, 'first': 'not detected'}
                    page.click('#check'); r['refused again'] = ran(page)
                    r['released again'] = holder.evaluate(HOLDER, 'release')
                    # Past the refused tab's mends at 0.1 and 1 s, so that a grant still in flight at the
                    # refusal has been let go: the second tab's run then tests the mend, not the timing.
                    two.wait_for_timeout(1200)
                    for k, p in (('second meanwhile', two), ('first after', page)):
                        if not choose(p): return {**r, k: 'not detected'}
                        p.click('#check'); r[k] = ran(p)
                    return r
                except Exception as e:
                    return {**r, 'error': str(e).split('\n')[0][:200]}
                finally:
                    holder.close(); two.close()
            half = half_taken() or {}
            refused = lambda x: (x or {}).get('phase') == 'error' and (x or {}).get('said') == POOL_BUSY
            # A run after a refusal is not left marked as refused (window.__plato.said, reset at each run).
            done = lambda x: (x or {}).get('phase') == 'done' and POOL_BUSY not in (x or {}).get('said', POOL_BUSY) and (x or {}).get('state said', 'x') is None
            check('a tab refused part of the working files (another holds two) says so, and runs once they are let go',
                  half.get('first alone') == 'done' and half.get('second alone') == 'done' and half.get('held') == 2
                  and refused(half.get('refused')) and done(half.get('again')), half)
            check('a tab refused part of the working files holds none of them while it waits: another tab runs meanwhile, and then it runs',
                  half.get('held again') == 2 and refused(half.get('refused again'))
                  and done(half.get('second meanwhile')) and done(half.get('first after')), half)
            main_permissions(ctx, page, url, main_requests)
            # After main_permissions, whose first check is that nothing above asked another site: the
            # lookup asks (a fake) WHG once it is allowed.
            krisis_lookup_case(page, tmp, url)
            krisis_lookup_pattern(page, tmp, url)
            # Then the region review, on the same page, WHG allowed (a fake WHG again: never the real one).
            krisis_regions_case(page, tmp, url)
            # The lookup panel's token and language fields (Issue #33, points 6 and 7); nothing is sent.
            lookup_panel_case(page, tmp, url)
            ctx.close()
            front = pw.chromium.launch(headless=True)
            try: front_page_checks(front, url); card_chosen_checks(front, url, pw); theme_checks(front, url); methodos_page_checks(front, url); layout_checks(front, url)
            finally: front.close()
            methodos_checks(pw, url, tmp)
            chora_layout_checks(pw, url)
            chora_checks(pw, url, tmp)
            chora_adopt_checks(pw, url, tmp)
            map_your_data_checks(pw, url, tmp)
            recipes_checks(pw, url, tmp)
            match_two_checks(pw, url, tmp)
            project_checks(pw, url, tmp)
            whg_checks(pw, url, tmp)
            scope_checks(pw, url, tmp)
            quality_checks(pw, url, tmp)
            chora_seams_checks(pw, url, tmp)
            iiif_checks(pw, url, tmp)
    finally:
        stop(srv)
        stop_fixtures()
        # The profile and the saved outputs are this run's alone: remove them (they were left in
        # /tmp by every run until now, some 2.7 MB each).
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    if PROVE:
        print(f'{len(results)} checks; {SHORTENED[0]} waits on the page with no tools ended after {FAST:g} s'
              + (' (none: PROVE_FULL_WAITS)' if os.environ.get('PROVE_FULL_WAITS') else ''))
        if not os.environ.get('PROVE_FULL_WAITS') and SHORTENED[0] == 0:
            # The shortener's own control: it found the page with no tools nowhere, so it is not doing what it says.
            print('PROVE-IT-FAILS: no wait on the page with no tools was cut short: the shortener (toolless()) no longer recognises it')
            sys.exit(1)
        print('PROVE-IT-FAILS:', 'every check failed, as it must' if len(failed) == len(results) else f'{len(results) - len(failed)} check(s) passed against a page with no tools: they cannot fail')
        sys.exit(0 if len(failed) == len(results) else 1)
    print('RESULT:', 'ALL PASS' if not failed else f'{len(failed)} FAILED'); sys.exit(1 if failed else 0)

# ---- Methodos: saving and resuming (phase 2) ----------------------------------------------------------
# The page has no Methodos panel yet (phase 3), so these drive the record and its store through a test
# hook (e2e/methodos-hook.js), bundled from src/ here and served through Playwright's routing alone: it
# is not in the build, and no visitor can load it. It runs in the page's origin, with the page's own
# IndexedDB, sessionStorage and "keep working data" choice, and does nothing on a page with no tools.
HOOK_PATH = '__e2e/methodos-hook.js'
def methodos_checks(pw, url, tmp):
    hook = tmp / 'methodos-hook.js'
    built = subprocess.run(['node', str(ROOT / 'e2e/methodos-hook.mjs'), str(hook)], cwd=ROOT, capture_output=True, text=True)
    base = url.rstrip('/') + '/'
    browser = pw.chromium.launch(headless=True)
    try:
        ctx = browser.new_context()
        if built.returncode == 0:
            ctx.route(base + HOOK_PATH, lambda r: r.fulfill(path=str(hook), content_type='text/javascript'))
        def tab(p=None):
            p = p or ctx.new_page()
            if p.url in ('', 'about:blank'): p.goto(NOTOOLS if PROVE else base)
            wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            if built.returncode != 0: raise RuntimeError('the hook did not bundle: ' + built.stderr[-240:])
            p.add_script_tag(url=base + HOOK_PATH)
            p.wait_for_function('() => !!window.__methodos_e2e', timeout=T(10) * 1000)
            return p
        call = lambda p, js, *a: p.evaluate(f'(a) => window.__methodos_e2e.{js}(...a)', list(a))
        DATA, OTHER = '{"places": ["Abingdon"]}', '{"places": ["Abingdon", "Oxford"]}'
        r = {}
        def saved_and_reloaded():
            a = tab(); r['a'] = a
            r['begun'] = call(a, 'begin', DATA, 'Abingdon')
            a.reload(); tab(a)
            r['resumed'] = call(a, 'resume', r['begun']['id'])
            b, e = r['begun'], r['resumed']
            return (b['kept'] == 'browser' and b['at'] == 'report' and b['status'] == 'stopped' and e['action'] == 'continue'
                    and e['at'] == b['at'] and e['status'] == b['status'] and e['states'] == b['states']), r
        attempt('Methodos: a workflow saved mid-way is found at the same step after a reload', saved_and_reloaded)
        def files_checked():
            a, id_ = r['a'], r['begun']['id']
            got = {'same': call(a, 'chosen', id_, DATA), 'other': call(a, 'chosen', id_, OTHER)}
            return got['same'] == 'ok' and 'not the files this workflow was begun with' in got['other'] and 'p.json' in got['other'], got
        attempt('Methodos: a record naming a different file is refused (filesDiffer); the same file is accepted', files_checked)
        def nothing_left():
            a, id_ = r['a'], r['begun']['id']
            # Kept: the record outlives its tab (the presence beside the absence below).
            c = tab(); got = {'kept, a new tab': call(c, 'list'), 'kept, in IndexedDB': call(c, 'keys')}; c.close()
            a.evaluate("() => localStorage.setItem('plato-tools.keep-working-data', 'no')")
            try:
                gone = call(a, 'begin', DATA, 'Not kept')
                # Read before anything else uses the store, which, with working data not kept, clears it.
                got['not kept, in IndexedDB at once'] = call(a, 'keys')
                a.reload(); tab(a)
                got.update({'not kept, saved': gone['kept'], 'not kept, same tab': call(a, 'resume', gone['id']).get('at')})
                a.close()
                d = tab(); got.update({'not kept, a new tab': call(d, 'list'), 'not kept, in IndexedDB': call(d, 'keys')})
                d.evaluate("() => localStorage.removeItem('plato-tools.keep-working-data')"); d.close()
            finally:
                if not a.is_closed(): a.evaluate("() => localStorage.removeItem('plato-tools.keep-working-data')")
            return (got['kept, a new tab'] == [id_] and got['kept, in IndexedDB'] == [id_] and got['not kept, saved'] == 'tab'
                    and got['not kept, in IndexedDB at once'] == [] and got['not kept, same tab'] == 'report' and got['not kept, a new tab'] == [] and got['not kept, in IndexedDB'] == []), got
        attempt('Methodos: with "keep working data" off nothing is left after the tab closes (with it on, the record outlives the tab)', nothing_left)
        methodos_join_checks(browser, base, hook if built.returncode == 0 else None, tmp)
    finally:
        browser.close()

# ---- Methodos joined to the tools' runs (src/methodos/page.js, the tracker) -------------------------------
# A workflow followed on the page advances when the run of its step's tool finishes, on the step's file;
# it is kept at every step boundary in phase 2's store, and taken up again after a reload. Read through
# the tracker's own words and states, and the store through the hook (as above).
JOIN_STATE = '''() => { const t = document.getElementById('methodos-tracker'), v = (e) => !!e && !e.hidden && !e.closest('[hidden]');
  return { shown: v(t), status: t.dataset.status || null,
    steps: Object.fromEntries([...t.querySelectorAll('li.track-step')].map((li) => [li.dataset.step, li.dataset.state + (li.dataset.run ? ':' + li.dataset.run : '')])),
    run: t.querySelector('li.is-current .track-run')?.textContent || null, message: document.getElementById('methodos-message').textContent,
    where: document.getElementById('methodos-tracker-where').textContent, done: v(document.getElementById('methodos-done')),
    use: v(document.getElementById('methodos-use')) ? document.getElementById('methodos-use').textContent : null,
    pick: v(document.getElementById('methodos-pick')) ? document.getElementById('methodos-pick').textContent : null,
    kept: v(document.getElementById('methodos-kept')) ? document.getElementById('methodos-kept').textContent : null,
    leave: document.getElementById('methodos-leave').textContent, keptAs: t.dataset.kept || null }; }'''
METHODOS_HOLDER = '''async (n) => {
  const src = `let held = []; onmessage = async ({ data }) => {
    if (data === 'release') { for (const h of held) h.close(); held = []; postMessage(0); return; }
    const o = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('.opfs-sahpool')).getDirectoryHandle('.opaque');
    for await (const [, h] of o) if (h.kind === 'file' && held.length < data) held.push(await h.createSyncAccessHandle());
    postMessage(held.length); };`;
  window.holder = window.holder || new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return new Promise((res) => { holder.onmessage = (e) => res(e.data); holder.postMessage(n); });
}'''
OUTPUTS_KEPT = '''async () => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('methodos-outputs'); const n = []; for await (const [k] of d.entries()) n.push(k); return n.sort(); } catch { return null; } }'''
def methodos_join_checks(browser, base, hook, tmp):
    customs = sorted((PLATO / 'schemas/tables/examples/customs').glob('*.csv'))
    def fresh():
        ctx = browser.new_context(accept_downloads=True)
        ctx.add_init_script('window.__plato_forceDownload = true;')
        if hook: ctx.route(base + HOOK_PATH, lambda r: r.fulfill(path=str(hook), content_type='text/javascript'))
        return ctx
    def ready(p):
        if p.url in ('', 'about:blank'): p.goto(NOTOOLS if PROVE else base)
        if wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return p
    def hooked(p):
        if not hook: raise RuntimeError('the hook did not bundle')
        p.add_script_tag(url=base + HOOK_PATH); p.wait_for_function('() => !!window.__methodos_e2e', timeout=T(10) * 1000)
        return p
    js = lambda p: p.evaluate(JOIN_STATE)
    def follow_publish(p):
        p.click('#methodos-ask'); until(p, "!document.getElementById('methodos').hidden", 5)
        p.check('input[name="methodos-have"][value="plato"]'); p.check('input[name="methodos-want"][value="publish"]')
        p.click('#methodos-start'); until(p, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
    def choose(p, fs):
        p.set_input_files('#picker', [])
        p.set_input_files('#picker', [str(f) for f in fs])
        return wait_state(p, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection').get('phase') == 'detected'
    def step_is(p, step, state, timeout=60):
        until(p, f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
    def run(p, button, part=None):
        if part: p.select_option('#part', part)
        p.click(button)
        return wait_state(p, lambda s: s.get('phase') in ('done', 'error'), T(120), 'run')
    r = {}

    def advances():
        # Publish a dataset on the customs tables: the check, minting and the FAIR report, each run with its
        # own button, each step done by the run (no "This step is done": an absence, beside each step done).
        ctx = fresh(); r['ctx'] = ctx
        p = ready(ctx.new_page()); r['page'] = p
        follow_publish(p)
        got = {'pending': js(p)}
        if not choose(p, customs): return False, {**got, 'detected': False}
        until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        got['begun'] = js(p)
        got['check run'] = run(p, '#check').get('phase'); step_is(p, 'check', 'done'); got['checked'] = js(p)
        got['mint run'] = run(p, '#publish', 'mint').get('phase'); step_is(p, 'mint', 'done'); got['minted'] = js(p)
        s = wait_state(p, lambda s: s.get('phase') == 'done', 5)
        minted = next((o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('-with-ids.jsonl')), None)
        if minted: (tmp / 'methodos-minted').mkdir(exist_ok=True); r['minted'] = download(p, minted, tmp / 'methodos-minted' / minted)
        # The minted dataset is handed on: the tracker offers it, and a run on it is the report's.
        p.click('#methodos-use'); wait_state(p, lambda s: s.get('phase') == 'detected', T(60), 'detection')
        until(p, "() => /the file this step takes/.test(document.getElementById('methodos-message').textContent)", 30)
        got['report run'] = run(p, '#publish', 'report').get('phase'); step_is(p, 'report', 'done'); got['reported'] = js(p)
        b, c, m, e = got['begun'], got['checked'], got['minted'], got['reported']
        ok = (got['pending']['shown'] and got['pending']['steps'].get('check') == 'current' and not got['pending']['done']
              and b['status'] == 'idle' and b['steps']['check'] == 'current' and not b['done']
              and c['steps']['check'] == 'done' and c['steps']['mint'] == 'current' and not c['done'] and c['keptAs'] == 'browser'
              and m['steps']['mint'] == 'done' and m['steps']['report'] == 'current' and (m['use'] or '').startswith('Use ') and minted and minted in m['use']
              and e['steps']['report'] == 'done' and e['steps']['site'] == 'current' and e['where'].startswith('Step 4 of 5') and not e['done'] and r.get('minted'))
        return ok, got
    attempt('Methodos: a "Publish a dataset" workflow advances by itself as its tools\' runs finish (check, minting, then the FAIR report on the minted dataset it hands on), with no "This step is done"', advances)

    def resumed():
        p = r['page']
        before = js(p)
        # The page is ready, and then at once given the kept file (so 'ready' may be seen, or already passed).
        p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready')
        until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 15)
        # The minted dataset, kept in this browser by the step that made it, is chosen for the next step: no re-choosing.
        s_ = wait_state(p, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        until(p, "() => /the file this step takes/.test(document.getElementById('methodos-message').textContent) || /chosen in step 1 for you/.test(document.getElementById('methodos-message').textContent)", 15)
        after = js(p)
        chosen_ = p.evaluate("() => [...document.querySelectorAll('#chosen .name')].map((e) => e.textContent)")
        ok = (before['steps']['site'] == 'current' and after['shown'] and after['steps'] == before['steps'] and after['where'] == before['where']
              and s_.get('phase') == 'detected' and chosen_ == [r['minted'].name] and after['kept'] and 'files the steps made' in after['kept'] and 'your ' in after['kept'] and 'Nothing leaves this computer' in after['kept'])
        return ok, {'before': before, 'after': after, 'chosen for the step': chosen_, 'phase': s_.get('phase'), 'minted': r['minted'].name}
    attempt('Methodos: a reload mid-workflow takes it up at the same step, every step as it was, with the dataset the minting made kept in this browser and chosen for the next step, and says what is kept (the user\'s files and the steps\')', resumed)

    def refused():
        p = r['page']
        choose(p, customs)
        until(p, "() => /These are not the files/.test(document.getElementById('methodos-message').textContent)", 30)
        no = js(p)
        site = run(p, '#publish', 'site').get('phase')
        # The tracker hears the page in order: once it has said the right file is chosen, the run on the
        # other file has been heard too, so the step's state then is the run's verdict, not a guess in time.
        choose(p, [r['minted']])
        until(p, "() => /the file this step takes/.test(document.getElementById('methodos-message').textContent)", 30)
        yes = still = js(p)
        # And a run on the right file is what completes it (the presence beside the absence).
        done = run(p, '#publish', 'site').get('phase'); step_is(p, 'site', 'done'); after = js(p)
        ok = ('These are not the files' in no['message'] and r['minted'].name in no['message'] and site in ('done', 'error')
              and still['steps']['site'] == 'current' and 'not the files' not in yes['message'] and r['minted'].name in yes['message']
              and done == 'done' and after['steps']['site'] == 'done' and after['steps']['w3id'] == 'current')
        return ok, {'other file': no, 'its run': site, 'the right file chosen': yes, 'run on the right file': after}
    attempt('Methodos: after a reload, a different file is refused in words and a run on it is not counted; the file the step takes is accepted', refused)

    def cleared():
        # What is kept (the presence: the minted dataset's SHA-256 in OPFS, said in the tracker) goes with "Clear them".
        p = r['page']
        try:
            got = {'before': p.evaluate(OUTPUTS_KEPT), 'said before': js(p)['kept']}
            p.click('#methodos-clear-kept')
            until(p, "() => document.getElementById('methodos-kept').hidden", 10)
            got.update({'after': p.evaluate(OUTPUTS_KEPT), 'said after': js(p)['kept'], 'message': js(p)['message']})
            ok = (got['before'] and len(got['before']) >= 1 and got['said before'] and got['after'] is None and got['said after'] is None and 'cleared from this browser' in got['message'])
            return ok, got
        finally: r['ctx'].close()
    attempt('Methodos: the files the steps made are kept in OPFS by SHA-256 and said in the tracker, and "Clear them" clears them', cleared)

    def not_started():
        # Chosen before any file, the workflow is kept, shown as not started after a reload, and discarded in one click.
        ctx = fresh()
        try:
            p = hooked(ready(ctx.new_page()))
            follow_publish(p)
            got = {'kept': p.evaluate('() => window.__methodos_e2e.pendings()')}
            p.reload(); ready(p); hooked(p)
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'pending'", 15)
            got['after a reload'] = js(p)
            p.click('#methodos-leave'); until(p, "() => document.getElementById('methodos-tracker').hidden", 10)
            got['discarded'] = p.evaluate('() => window.__methodos_e2e.pendings()')
            p.reload(); ready(p); p.wait_for_timeout(500)
            got['after another reload'] = js(p)['shown']
            a = got['after a reload']
            ok = (len(got['kept']) == 1 and a['shown'] and 'Not started' in a['message'] and a['leave'] == 'Discard this workflow' and a['steps'].get('check') == 'current'
                  and got['discarded'] == [] and got['after another reload'] is False)
            return ok, got
        finally: ctx.close()
    attempt('Methodos: a workflow chosen before any file is kept, shown as not started after a reload, and discarded in one click', not_started)

    def dropped():
        # A file dropped gives its handle where the browser does (here a real handle, to a copy in OPFS, given
        # as getAsFileSystemHandle would): after a reload, "Open … again" chooses it in one click. Control: a
        # drop whose handle is a folder's still chooses the file, and resume asks for it to be chosen.
        ex = sorted(EX.glob('place-centric-*.json'))[0]
        text = ex.read_text()
        DROP = '''async ([text, name, kind]) => {
          const root = await navigator.storage.getDirectory();
          const h = kind === 'file' ? await root.getFileHandle(name, { create: true }) : await root.getDirectoryHandle('a-folder', { create: true });
          if (kind === 'file') { const w = await h.createWritable(); await w.write(text); await w.close(); }
          DataTransferItem.prototype.getAsFileSystemHandle = async function () { return h; };
          const dt = new DataTransfer(); dt.items.add(new File([text], name, { type: 'application/json' }));
          document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        }'''
        out = {}
        for kind in ('file', 'folder'):
            ctx = fresh()
            try:
                p = ready(ctx.new_page())
                follow_publish(p)
                p.evaluate(DROP, [text, ex.name, kind])
                until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
                got = {'detected': wait_state(p, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection').get('phase')}
                # The file is kept in this browser too (12 October 2026), and would be chosen again by itself:
                # cleared, so that what the reload has is the handle (or, for the folder, nothing).
                until(p, "document.getElementById('methodos-tracker').dataset.keptOwn === 'true'", 30)
                p.click('#methodos-clear-kept'); until(p, "() => document.getElementById('methodos-kept').hidden", 10)
                p.reload(); ready(p)
                until(p, "() => !document.getElementById('methodos-pick').hidden", 15)
                got['pick'] = js(p)['pick']
                if kind == 'file':
                    p.click('#methodos-pick')
                    until(p, "() => /the file this step takes/.test(document.getElementById('methodos-message').textContent)", 15)
                    got['opened'] = p.evaluate("() => [...document.querySelectorAll('#chosen .name')].map((e) => e.textContent)")
                out[kind] = got
            finally: ctx.close()
        ok = (out['file']['detected'] == 'detected' and out['file']['pick'] == f'Open {ex.name} again' and out['file']['opened'] == [ex.name]
              and out['folder']['detected'] == 'detected' and out['folder']['pick'] == 'Choose the file')
        return ok, out
    attempt('Methodos: a dropped file keeps its handle where the browser gives one, so that resume opens it in one click; a folder\'s handle is not kept, and the drop still works', dropped)

    def nothing_kept():
        # Kept (the presence): a workflow begun is in IndexedDB. Turned off in the Permissions panel, it is
        # gone from there at once, the tracker carries on in the tab, and after the tab nothing is left.
        ctx = fresh()
        try:
            p = hooked(ready(ctx.new_page()))
            follow_publish(p); choose(p, customs)
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            run(p, '#check'); step_is(p, 'check', 'done'); run(p, '#publish', 'mint'); step_is(p, 'mint', 'done')
            got = {'kept': p.evaluate('() => window.__methodos_e2e.keys()'), 'kept as': js(p)['keptAs'], 'outputs kept': p.evaluate(OUTPUTS_KEPT)}
            p.click('#permissions-button'); until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            p.uncheck('#perm-keep-work')
            until(p, "() => document.getElementById('methodos-tracker').dataset.kept === 'tab'", 10)
            got['off, at once'] = p.evaluate('() => window.__methodos_e2e.keys()')
            # Said, rather than hidden (12 October 2026): nothing of the user's is kept.
            until(p, "() => /Nothing of yours is kept/.test(document.getElementById('methodos-kept').textContent)", 10)
            got['off, outputs at once'] = p.evaluate(OUTPUTS_KEPT)
            got['off, tracker'] = js(p)
            got['panel says'] = p.evaluate("() => document.getElementById('perm-keep-note')?.textContent || ''")
            p.close()
            q = hooked(ready(ctx.new_page())); q.wait_for_timeout(500)
            got['next tab'] = {'list': q.evaluate('() => window.__methodos_e2e.list()'), 'keys': q.evaluate('() => window.__methodos_e2e.keys()'), 'tracker': js(q)['shown'], 'outputs': q.evaluate(OUTPUTS_KEPT)}
            q.evaluate("() => localStorage.removeItem('plato-tools.keep-working-data')")
            ok = (len(got['kept']) == 1 and got['kept as'] == 'browser' and got['off, at once'] == [] and got['off, tracker']['shown']
                  and got['outputs kept'] and len(got['outputs kept']) >= 1 and got['off, outputs at once'] is None
                  and got['off, tracker']['steps'].get('report') == 'current' and (got['off, tracker']['use'] or '').startswith('Use ')
                  and 'Nothing of yours is kept' in (got['off, tracker']['kept'] or '')
                  and 'the files its steps made' in got['panel says']
                  and got['next tab'] == {'list': [], 'keys': [], 'tracker': False, 'outputs': None})
            return ok, got
        finally: ctx.close()
    attempt('Methodos: turned off in the Permissions panel, "keep working data" clears the workflow from IndexedDB and the steps\' files from OPFS at once (where they were, the presence), the tab carries on, the panel says so, and nothing is left after the tab', nothing_kept)

    def failed():
        # The check is refused the working files (another worker holds them): the step fails, and says so;
        # let go, the same step run again is done (the presence beside the failure).
        ctx = fresh()
        try:
            p = ready(ctx.new_page()); holder = ready(ctx.new_page())
            if not choose(p, customs): return False, 'not detected'
            run(p, '#check')   # the pool is made, and let go between runs
            follow_publish(p)
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            got = {'held': holder.evaluate(METHODOS_HOLDER, 99)}
            got['run'] = run(p, '#check').get('phase')
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'failed'", 15)
            got['failed'] = js(p)
            got['released'] = holder.evaluate(METHODOS_HOLDER, 'release')
            got['again'] = run(p, '#check').get('phase'); step_is(p, 'check', 'done')
            got['done'] = js(p)
            f = got['failed']
            ok = (got['held'] > 0 and got['run'] == 'error' and f['steps']['check'] == 'current:failed' and (f['run'] or '').startswith('Failed: ')
                  and 'run this step again' in f['run'] and got['done']['steps']['check'] == 'done' and got['done']['steps']['mint'] == 'current')
            return ok, got
        finally: ctx.close()
    attempt('Methodos: a step whose run fails says so in the tracker ("Failed: …, run this step again"), and run again it is done', failed)

    def cancelled():
        # The check, a step of the workflow, cancelled with the page's Cancel part-way through a long file:
        # the run ends there (no more progress, nothing reported), and the tracker says the step was stopped
        # by the user, the step after it still to come; run again and let finish, the same step is done.
        ctx = fresh()
        try:
            p = ready(ctx.new_page())
            big = many_places(tmp, 1000)
            follow_publish(p)
            if not choose(p, [big]): return False, 'not detected'
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            p.click('#check')
            until(p, "() => (window.__plato.progress?.places || 0) > 0 && window.__plato.phase === 'running'", 120)
            got = {'places read': p.evaluate('() => window.__plato.progress?.places')}
            p.click('#cancel')
            got['progress at Cancel'] = p.evaluate('() => window.__plato.progress?.places')
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'cancelled'", 15)
            got['cancelled'] = js(p)
            s = wait_state(p, lambda s: s.get('phase') == 'ready', 60, 'ready after Cancel')
            p.wait_for_timeout(1000)   # a run not stopped would report, or move on, in this time
            got['after'] = {'phase': s.get('phase'), 'report': s.get('report'), 'progress': p.evaluate('() => window.__plato.progress?.places'), 'tracker': js(p)}
            got['again'] = run(p, '#check').get('phase'); step_is(p, 'check', 'done')
            got['done'] = js(p); got['places'] = (wait_state(p, lambda s: s.get('phase') == 'done', 5).get('report') or {}).get('counts', {}).get('places')
            c, a = got['cancelled'], got['after']
            ok = (0 < got['places read'] < 11000 and c['status'] == 'cancelled' and 'cancelled' in c['steps']['check'] and (c['run'] or '').startswith('Stopped by you')
                  and c['steps']['mint'] not in ('done', 'current') and a['phase'] == 'ready' and a['report'] is None and a['progress'] == got['progress at Cancel']
                  and a['tracker']['steps'] == c['steps'] and got['again'] == 'done' and got['places'] == 11000
                  and got['done']['steps']['check'] == 'done' and got['done']['steps']['mint'] == 'current')
            return ok, got
        finally: ctx.close()
    attempt('Methodos: a step\'s run cancelled part-way (the page\'s Cancel) ends there, the tracker says "Stopped by you" and nothing more is done; run again and let finish, the step is done', cancelled)

# ---- Chora's seams with the page (Stephen, 12 October 2026, Issue #33 point 5; 13 October 2026: Chora in the page) ---
# Chora is in the main page, at #chora: the file chosen in step 1 is shown in it at once, with no reload;
# leaving it, by "Leave the map" or the browser's Back, gives the steps back with the file still chosen; in
# a workflow, "Open Chora" shows the step's dataset beside the tracker, and a save in Chora chooses the
# file it wrote; the workflow keeps the user's own file for its lifetime (under "Keep my working data")
# and chooses it again after a reload, in any browser (no file handle used: Playwright's set_input_files
# gives none); and with working data off nothing of the user's is kept, and the tracker says so. Each
# check finds the presence it needs before it trusts an absence.
SEAM_OVERVIEW = '''() => { const m = window.__chora_map; return ['chora-overview-clusters', 'chora-overview-points'].reduce((n, l) => n + (m.getLayer(l) ? m.queryRenderedFeatures({ layers: [l] }).length : 0), 0); }'''
SEAM_CHOSEN = "() => [...document.querySelectorAll('#chosen .name')].map((e) => e.textContent)"
# The file kept from the main page (src/lib/kept-file.js): the names in the newest whole kept-file-* folder's about.json, in OPFS, or null when none is kept.
SEAM_KEPT = '''async () => { try { const r = await navigator.storage.getDirectory(), names = [];
  for await (const [n, h] of r.entries()) if (h.kind === 'directory' && n.startsWith('kept-file-')) names.push(n);
  for (const n of names.sort().reverse()) { try { const d = await r.getDirectoryHandle(n);
    return JSON.parse(await (await (await d.getFileHandle('about.json')).getFile()).text()).files.map((f) => f.name); } catch { /* not whole */ } }
  return null; } catch { return null; } }'''
# The offer under "Choose your data": its words if shown, else null.
SEAM_SHOWN = "() => { const e = document.getElementById('kept-file'); return !!e && !e.hidden; }"
SEAM_OFFER = "() => { const e = document.getElementById('kept-file'); return e && !e.hidden ? e.textContent.replace(/\\s+/g, ' ').trim() : null; }"
def chora_seams_checks(pw, url, tmp):
    base = url.rstrip('/') + '/'
    hook = tmp / 'methodos-hook-seams.js'
    built = subprocess.run(['node', str(ROOT / 'e2e/methodos-hook.mjs'), str(hook)], cwd=ROOT, capture_output=True, text=True)
    browser = pw.chromium.launch(headless=True, args=GL)
    # A browser that keeps no page in its memory (the back-forward cache turned off): its Back always starts the page afresh.
    nocache = pw.chromium.launch(headless=True, args=GL + ['--disable-features=BackForwardCache'])
    ant = EX / 'place-centric-antonine.json'; ant_places = len(json.loads(ant.read_text())['spatialEntities'])
    customs = sorted((PLATO / 'schemas/tables/examples/customs').glob('*.csv'))
    d = tmp / 'seams'; d.mkdir(exist_ok=True)
    def fresh(b=None):
        ctx = (b or browser).new_context(accept_downloads=True, viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
        ctx.add_init_script('window.__plato_forceDownload = true;')
        if built.returncode == 0: ctx.route(base + HOOK_PATH, lambda r: r.fulfill(path=str(hook), content_type='text/javascript'))
        return ctx
    def main_ready(p, at=''):
        p.goto(NOTOOLS if PROVE else base + at)
        if wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return p
    def hooked(p):
        if built.returncode != 0: raise RuntimeError('the hook did not bundle: ' + built.stderr[-240:])
        p.add_script_tag(url=base + HOOK_PATH); p.wait_for_function('() => !!window.__methodos_e2e', timeout=T(10) * 1000)
        return p
    def choose(p, fs):
        p.set_input_files('#picker', [str(f) for f in fs])
        return wait_state(p, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection').get('phase') == 'detected'
    def chora_loaded(p):
        # Opened with no click: the page loads what it was handed, and its places are drawn on the map.
        until(p, '() => window.__chora && ["loaded", "error", "unrecognised"].includes(window.__chora.phase) && window.__chora.mapReadyCount >= 1', 90)
        p.evaluate(SETTLE)
        return cstate(p), p.evaluate(SEAM_OVERVIEW)
    def detected_again(p, names):
        # The main page back, its dataset chosen again (by the page, or kept as it was by the browser).
        return soon(p, '(n) => JSON.stringify([...document.querySelectorAll("#chosen .name")].map((e) => e.textContent)) === JSON.stringify(n) && !!window.__plato && ["detected", "done"].includes(window.__plato.phase)', 60, names)
    def kept_is(p, names, timeout=15):
        # The kept file's names, as its store holds them, once they are `names` (a write is asynchronous).
        t0 = time.time()
        while time.time() - t0 < T(timeout):
            if p.evaluate(SEAM_KEPT) == names: return True
            time.sleep(0.25)
        return False
    r = {}
    def chora_shown(p):
        return p.evaluate('() => !document.getElementById("chora").hidden && document.body.hasAttribute("data-chora")')
    def perm_reload(p):
        """WHG allowed in the Permissions panel, and the reload it offers asked for: what the panel says the reload
        would lose, shown first ('' when there is nothing, and the page reloads at once)."""
        p.click('#permissions-button'); until(p, '() => document.getElementById("permissions-panel")?.open', 10)
        p.check('#permissions-panel fieldset.perm[data-key="gazetteer:whg"] input[value="allowed"]')
        p.evaluate('() => { window.__beforePermReload = true; }')
        p.click('#permissions-panel [data-reload]')
        t0 = time.time()
        while time.time() - t0 < T(20):
            try:
                if p.is_visible('#permissions-panel .perm-confirm'): return p.inner_text('#permissions-panel .perm-confirm')
                if not p.evaluate('() => window.__beforePermReload === true'): return ''
            except Exception: pass                              # the page going: reloaded
            time.sleep(0.2)
        raise RuntimeError('the panel neither asked nor reloaded')
    CAMERA = '() => { const m = window.__chora_map, c = m.getCenter(); return [c.lng, c.lat, m.getZoom()]; }'

    def opened_at_once():
        ctx = fresh(); r['plain'] = ctx
        p = main_ready(ctx.new_page()); r['p'] = p
        f = d / 'antonine-seams.json'; shutil.copyfile(ant, f); r['f'] = f
        if not choose(p, [f]): return False, 'not detected'
        p.evaluate('() => { window.__samePage = true; }')
        p.click('#to-chora')
        s, drawn = chora_loaded(p)
        same = p.evaluate('() => window.__samePage === true')
        return (s['phase'] == 'loaded' and s['places'] == ant_places and drawn > 0 and same and chora_shown(p) and p.url == base + '#chora'
                and p.evaluate(SEAM_CHOSEN) == [f.name]), {
                    'state': {k: s.get(k) for k in ('phase', 'places')}, 'features drawn': drawn, 'same page': same, 'url': p.url, 'chosen': p.evaluate(SEAM_CHOSEN)}
    attempt('Chora\'s seams: a file chosen in step 1 opens in Chora at once, in the same page (no reload), its places drawn on the map, and it is still the file chosen in step 1', opened_at_once)

    def plain_back():
        p, f = r['p'], r['f']
        got = {}
        # "Leave the map": the steps again, the file still chosen, the page the same.
        p.click('#chora-leave')
        got['by Leave'] = {'shown': chora_shown(p), 'chosen': p.evaluate(SEAM_CHOSEN), 'same page': p.evaluate('() => window.__samePage === true'), 'url': p.url,
                           'step 2': p.is_visible('#action-h')}
        # The browser's Back, from Chora opened again by step 2's link: the steps again, as they were.
        p.click('#to-chora'); until(p, '() => !document.getElementById("chora").hidden', 10)
        reopened = chora_shown(p) and cstate(p)['phase'] == 'loaded'
        p.go_back()
        until(p, '() => document.getElementById("chora").hidden', 10)
        got['by Back'] = {'shown': chora_shown(p), 'chosen': p.evaluate(SEAM_CHOSEN), 'same page': p.evaluate('() => window.__samePage === true'), 'url': p.url,
                          'step 2': p.is_visible('#action-h'), 'kept': p.evaluate(SEAM_KEPT)}
        l, b = got['by Leave'], got['by Back']
        return (reopened and not l['shown'] and l['chosen'] == [f.name] and l['same page'] and '#chora' not in l['url'] and l['step 2']
                and not b['shown'] and b['chosen'] == [f.name] and b['same page'] and '#chora' not in b['url'] and b['step 2'] and b['kept'] == [f.name]), got
    attempt('Chora\'s seams: leaving the map, by "Leave the map" or the browser\'s Back, gives the steps back in the same page with the file still chosen (and still kept)', plain_back)

    def hide_stops():
        # A line begun (one vertex: still being drawn), then "Leave the map": the drawing is stopped, no tool pressed.
        p = r['p']
        p.click('#to-chora'); until(p, '() => !document.getElementById("chora").hidden && window.__chora.phase === "loaded"', 30)
        chora_pick(p, 'londinium')
        x, y = map_centre(p); draw(p, 'linestring', [(x + 40, y + 20)])
        DRAWING = '() => ({ mode: window.__chora_draw.getMode(), drawing: window.__chora_draw.getSnapshot().some((f) => f.properties?.currentlyDrawing), pressed: [...document.querySelectorAll("#chora-draw-tools button[aria-pressed=true]")].map((b) => b.dataset.mode || b.dataset.trace) })'
        before = p.evaluate(DRAWING)
        p.click('#chora-leave'); until(p, '() => document.getElementById("chora").hidden', 10)
        after = p.evaluate(DRAWING)
        return (before['mode'] == 'linestring' and before['drawing'] and after['mode'] == 'static' and not after['drawing'] and after['pressed'] == []), {'while drawing': before, 'after leaving': after}
    attempt('Chora\'s seams: leaving the map while a line is being drawn stops the drawing (the tool back to none, no button pressed)', hide_stops)

    def workflow_open():
        # In the browser that keeps no page in its memory, as before: a reload starts the page afresh.
        r['plain'].close()
        ctx = fresh(nocache); r['wctx'] = ctx
        p = hooked(main_ready(ctx.new_page())); r['wp'] = p
        wid = p.evaluate('([t, a]) => window.__methodos_e2e.placeAtKept("Seams", "name,lat,lon\\nAbingdon,51.67,-1.28\\n", t, a)', [ant.read_text(), 'applied.json'])
        r['wid'] = wid
        p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready')
        # Taken up at Chora's step, its dataset (a step's, kept in this browser) chosen in step 1 by the page.
        before = detected_again(p, ['applied.json'])
        until(p, '() => !!document.querySelector(\'#for-tool a[href="#chora"]\')', 15)
        link = p.get_attribute('#for-tool a[href="#chora"]', 'href')
        in_tracker = p.is_visible('#methodos-chora') and p.get_attribute('#methodos-chora', 'href') == '#chora'
        p.evaluate('() => { window.__samePage = true; }')
        step_link = p.is_visible('#for-tool a[href="#chora"]')
        p.click('#methodos-chora')
        s, drawn = chora_loaded(p)
        t = p.evaluate(JOIN_STATE)
        step_link_after = p.is_visible('#for-tool a[href="#chora"]')
        return (before and link == '#chora' and in_tracker and s['phase'] == 'loaded' and drawn > 0 and p.evaluate('() => window.__samePage === true')
                and t['steps'].get('place') == 'current' and 'Step 7 of 10' in t['where'] and p.is_visible('#methodos-tracker') and not p.is_visible('#methodos-chora')
                and step_link and not step_link_after), {'step\'s link before': step_link, 'step\'s link while shown': step_link_after,
                    'chosen before': before, 'link': link, 'in the tracker': in_tracker, 'state': {k: s.get(k) for k in ('phase', 'places')}, 'drawn': drawn,
                    'tracker': {k: t.get(k) for k in ('steps', 'where')}, 'tracker\'s Open Chora after': p.is_visible('#methodos-chora')}
    attempt('Chora\'s seams, in a workflow: "Open Chora", under the step\'s title and in the tracker, opens the workflow\'s dataset in the page at once, drawn on the map, with the tracker beside it at "Step 7 of 10" (its "Open Chora", and the step\'s under the title, gone while the map is shown)', workflow_open)

    def workflow_back_unsaved():
        p = r['wp']
        p.click('#chora-leave')
        ok = detected_again(p, ['applied.json'])
        t = p.evaluate(JOIN_STATE)
        link = p.is_visible('#for-tool a[href="#chora"]')
        return (ok and not chora_shown(p) and t['steps'].get('place') == 'current' and p.evaluate(SEAM_CHOSEN) == ['applied.json'] and link), {'tracker': {k: t[k] for k in ('steps', 'message')}, 'chosen': p.evaluate(SEAM_CHOSEN), 'step\'s Open Chora': link}
    attempt('Chora\'s seams, in a workflow: leaving the map without saving, the workflow is at the same step with its dataset still chosen (its "Open Chora" back under the title), and nothing is done', workflow_back_unsaved)

    def workflow_browser_back():
        # Chora opened from the tracker's link, then the browser's Back: the steps, the workflow at its step.
        p = r['wp']
        until(p, '() => !!document.querySelector(\'#for-tool a[href="#chora"]\')', 15)
        p.click('#for-tool a[href="#chora"]'); chora_loaded(p)
        p.go_back()
        until(p, '() => document.getElementById("chora").hidden', 10)
        t = p.evaluate(JOIN_STATE)
        return (not chora_shown(p) and p.evaluate(SEAM_CHOSEN) == ['applied.json'] and t['steps'].get('place') == 'current' and '#chora' not in p.url), {
            'tracker': t['steps'], 'chosen': p.evaluate(SEAM_CHOSEN), 'url': p.url}
    attempt('Chora\'s seams, in a workflow: the browser\'s Back from Chora gives the steps back, the workflow at its step with its dataset chosen', workflow_browser_back)

    def workflow_reloaded():
        # #chora reloaded in a workflow: the page takes the workflow up and chooses its dataset (from what it
        # keeps), and Chora, open again at once, shows it.
        p = r['wp']
        p.goto('about:blank'); p.goto(NOTOOLS if PROVE else base + '#chora')
        s, drawn = chora_loaded(p)
        until(p, "() => document.querySelector('#methodos-track li[data-step=\"place\"]')?.dataset.state === 'current'", 15)
        return (s['phase'] == 'loaded' and drawn > 0 and chora_shown(p) and p.evaluate(SEAM_CHOSEN) == ['applied.json']), {
            'state': {k: s.get(k) for k in ('phase', 'places')}, 'drawn': drawn, 'chosen': p.evaluate(SEAM_CHOSEN)}
    attempt('Chora\'s seams, in a workflow: the page loaded at #chora takes the workflow up, chooses its dataset from what it keeps, and Chora shows it', workflow_reloaded)

    def workflow_other_file():
        # At the step "place", another dataset chosen in step 1 (as Chora is shown, it opens it), drawn on and
        # saved: the save is handed to the page, but the step is not done with it, and both the tracker and the
        # save say why. (The presence, the step done by a save from the step's dataset, is the check after this.)
        ctx = fresh(nocache)
        try:
            p = hooked(main_ready(ctx.new_page()))
            p.evaluate('([t, a]) => window.__methodos_e2e.placeAtKept("Other", "name,lat,lon\\nAbingdon,51.67,-1.28\\n", t, a)', [ant.read_text(), 'applied.json'])
            p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready')
            detected_again(p, ['applied.json'])
            until(p, '() => !document.getElementById("methodos-chora").hidden', 15)
            p.click('#methodos-chora'); chora_loaded(p)
            other = d / 'antonine-other.json'; other.write_text(ant.read_text() + '\n')
            p.evaluate('() => { window.__chora.phase = "e2e-waiting"; }')
            p.set_input_files('#picker', [str(other)])
            until(p, '() => window.__chora.phase === "loaded"', 60)
            chora_pick(p, 'londinium')
            p.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
            x, y = map_centre(p); draw(p, 'point', [(x + 50, y + 25)]); p.click('#chora-draw-tools button[data-mode="static"]')
            until(p, '() => window.__chora.pendingCount === 1', 10)
            p.click('#chora-save'); until(p, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
            if not (cstate(p)['lastSave'] or {}).get('passed'): raise RuntimeError('the save did not pass')
            until(p, '() => !!window.__chora.handedOver', 30)
            t = p.evaluate(JOIN_STATE); said = p.inner_text('#chora-handed') if p.is_visible('#chora-handed') else ''
            return (t['steps'].get('place') == 'current' and 'not done' in said and other.name in said and 'applied.json' in said
                    and 'not done' in (t.get('message') or '') and p.evaluate(SEAM_CHOSEN) == ['antonine-other.chora.json']), {
                        'steps': t['steps'], 'said under the save': said, 'tracker': t.get('message'), 'chosen': p.evaluate(SEAM_CHOSEN)}
        finally: ctx.close()
    attempt('Chora\'s seams, in a workflow: a save in Chora from another dataset than the step\'s does not do the step "place": the file is chosen in step 1, and the tracker and the save say why', workflow_other_file)

    def workflow_saved():
        # A save in Chora does the workflow's step "place" by itself (no "This step is done"), with the very
        # file it wrote: the record names it by the size and SHA-256 of the file downloaded. Before the save
        # (the presence), the step is the current one.
        p = r['wp']
        try:
            chora_pick(p, 'londinium')
            before = p.evaluate(JOIN_STATE)['steps'].get('place')
            p.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
            x, y = map_centre(p); draw(p, 'point', [(x + 50, y + 25)]); p.click('#chora-draw-tools button[data-mode="static"]')
            until(p, '() => window.__chora.pendingCount === 1', 10)
            p.click('#chora-save'); until(p, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
            if not (cstate(p)['lastSave'] or {}).get('passed'): raise RuntimeError('the save did not pass')
            until(p, '() => !!window.__chora.handedOver', 30)
            until(p, "() => document.querySelector('#methodos-track li[data-step=\"place\"]')?.dataset.state === 'done'", 30)
            t = p.evaluate(JOIN_STATE); h = cstate(p)['handedOver']
            with p.expect_download(timeout=T(60) * 1000) as dl: p.click('#chora-save-result button.primary')
            body = pathlib.Path(dl.value.path()).read_bytes()
            rec = p.evaluate('''async (id) => { const q = indexedDB.open('plato-tools-methodos', 1);
              const db = await new Promise((r, j) => { q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
              const v = await new Promise((r) => { const g = db.transaction('workflows').objectStore('workflows').get(id); g.onsuccess = () => r(g.result); g.onerror = () => r(null); });
              db.close(); const s = (typeof v === 'string' ? JSON.parse(v) : v)?.steps?.find((x) => x.id === 'place'); return s ? s.outputs : null; }''', r['wid'])
            said = p.inner_text('#chora-handed') if p.is_visible('#chora-handed') else ''
            want = [{'type': 'dataset', 'name': 'applied.chora.json', 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}]
            got = [{k: x.get(k) for k in ('type', 'name', 'size', 'sha256')} for x in ((rec or {}).get('dataset') or [])]
            return (before == 'current' and h['name'] == 'applied.chora.json' and t['steps'].get('place') == 'done' and t['steps'].get('again') == 'current'
                    and got == want and 'is done with it' in said and p.evaluate(SEAM_CHOSEN) == ['applied.chora.json'] and chora_shown(p)), {
                        'before': before, 'handed over': h, 'steps': t['steps'], 'recorded': got, 'downloaded': want, 'said': said}
        except Exception: r['wctx'].close(); raise
    attempt('Chora\'s seams, in a workflow: a save in Chora does the step "place" by itself, with the file it wrote (the record names it by the size and SHA-256 of the file downloaded), chosen in step 1, and says so under the save', workflow_saved)

    def workflow_saved_reloaded():
        # Then a reload for a permission: nothing is said lost (Chora has the page's file, the one it saved), and
        # after it step 1 still has the file saved, as Chora does, not the dataset that went to the step.
        p = r['wp']
        try:
            asked = perm_reload(p)
            until(p, '() => window.__chora && window.__chora.resumed && ["loaded", "place"].includes(window.__chora.phase)', 90)
            soon(p, '(n) => JSON.stringify([...document.querySelectorAll("#chosen .name")].map((e) => e.textContent)) === JSON.stringify(n)', 30, ['applied.chora.json'])
            s = cstate(p)
            return (asked == '' and p.evaluate(SEAM_CHOSEN) == ['applied.chora.json'] and (s.get('resumed') or {}).get('files') == ['applied.chora.json']), {
                'asked': asked, 'chosen': p.evaluate(SEAM_CHOSEN), 'resumed': s.get('resumed')}
        finally: r['wctx'].close()
    attempt('Chora\'s seams, in a workflow: after a save, a reload for a permission says nothing is lost, and step 1 and Chora have the file saved after it', workflow_saved_reloaded)

    def reload_while_starting():
        # A reload for a permission while Chora is still starting (its engine held back): the page's file is said
        # to be lost, as Chora has not opened it; once Chora has it open, nothing is said lost, and after the
        # reload the file, the place and the view are back.
        ctx = fresh()
        try:
            p = main_ready(ctx.new_page())
            f = d / 'antonine-starting.json'; shutil.copyfile(ant, f)
            if not choose(p, [f]): return False, 'not detected'
            held = []; pat = re.compile(r'/assets/worker-[\w-]+\.js(\?.*)?$')
            ctx.route(pat, lambda rt: held.append(rt))
            p.click('#to-chora'); until(p, '() => !!window.__chora', 30)
            p.wait_for_timeout(500)
            starting = cstate(p)['phase']
            asked = perm_reload(p)
            p.click('#permissions-panel [data-reload-cancel]'); p.keyboard.press('Escape')
            ctx.unroute(pat)
            for rt in held: rt.continue_()
            until(p, '() => window.__chora.phase === "loaded" && window.__chora.mapReadyCount >= 1', 90)
            pid = chora_pick(p, 'londinium')
            p.evaluate('() => window.__chora_map.jumpTo({ center: [-0.42, 51.31], zoom: 7.25 })'); p.evaluate(SETTLE)
            asked_open = perm_reload(p)
            until(p, '() => window.__chora && window.__chora.resumed && window.__chora.phase === "place"', 90)
            p.evaluate(SETTLE)
            s = cstate(p); cam = p.evaluate(CAMERA)
            back = {'chosen': p.evaluate(SEAM_CHOSEN), 'place': s.get('placeId'), 'camera': cam, 'resumed': s.get('resumed')}
            return (starting in ('loading', 'ready') and len(held) >= 1 and f.name in asked and asked_open == ''
                    and back['chosen'] == [f.name] and back['place'] == pid and abs(cam[0] + 0.42) < 0.01 and abs(cam[1] - 51.31) < 0.01 and abs(cam[2] - 7.25) < 0.01), {
                        'phase when asked': starting, 'held': len(held), 'said while starting': asked, 'said once open': asked_open, 'after the reload': back}
        finally: ctx.close()
    attempt('Chora\'s seams: a reload for a permission while Chora is starting says the file chosen would be lost; with it open in Chora nothing is, and the reload brings back the file, the place and the view', reload_while_starting)

    def follow_publish(p):
        p.click('#methodos-ask'); until(p, "!document.getElementById('methodos').hidden", 5)
        p.check('input[name="methodos-have"][value="plato"]'); p.check('input[name="methodos-want"][value="publish"]')
        p.click('#methodos-start'); until(p, "document.getElementById('methodos-tracker').dataset.status === 'pending'", 10)

    def own_kept():
        # The user's own files, chosen in step 1, are kept for the workflow and chosen again after a reload
        # (no file handle: set_input_files gives none), and the tracker says so; Leave lets them go.
        ctx = fresh()
        try:
            p = main_ready(ctx.new_page())
            follow_publish(p)
            if not choose(p, customs): return False, 'not detected'
            until(p, "document.getElementById('methodos-tracker').dataset.keptOwn === 'true'", 30)
            got = {'said': p.evaluate(JOIN_STATE)['kept'], 'kept': p.evaluate(OUTPUTS_KEPT), 'main page\'s copy too': p.evaluate(SEAM_KEPT)}
            p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready')
            names = sorted(f.name for f in customs)
            got['chosen again'] = soon(p, '(n) => JSON.stringify([...document.querySelectorAll("#chosen .name")].map((e) => e.textContent).sort()) === JSON.stringify(n) && window.__plato.phase === "detected"', 60, names)
            until(p, "() => /chosen in step 1 for you|the files this step takes/.test(document.getElementById('methodos-message').textContent)", 15)
            t = p.evaluate(JOIN_STATE); got['after'] = {k: t[k] for k in ('message', 'kept', 'pick', 'steps')}
            p.click('#methodos-leave'); until(p, "() => document.getElementById('methodos-tracker').hidden", 10)
            got['left'] = p.evaluate(OUTPUTS_KEPT)
            # Let go, the workflow hands its user's files over as the main page's kept file: one copy, once.
            got['handed over'] = kept_is(p, [f.name for f in customs]); got['kept after Leave'] = p.evaluate(SEAM_KEPT)
            ok = (got['said'] and got['said'].startswith(f'Kept in this browser for the next steps: your {len(customs)} files') and 'Nothing leaves this computer' in got['said']
                  and got['kept'] and len(got['kept']) == len(customs) and got['main page\'s copy too'] is None and got['chosen again'] and t['steps'].get('check') == 'current'
                  and t['pick'] is None and got['left'] in (None, []) and got['handed over'])
            return ok, got
        finally: ctx.close()
    attempt('Chora\'s seams: the user\'s own files are kept for the workflow alone (the tracker says so; no second copy as the main page\'s kept file), chosen again after a reload with no file handle, and handed over as the kept file when the workflow is left', own_kept)

    def nothing_of_yours():
        # "Keep my working data" off: nothing of the user's is kept, the tracker says so, a reload asks for
        # the file again, and a visit to Chora keeps nothing in the browser (the file stays chosen in the
        # page). Each absence beside its presence, in this same check: the same steps first with it on, where each is kept.
        ctx = fresh()
        def run(p, f):
            g = {}
            follow_publish(p)
            if not choose(p, customs): raise RuntimeError('not detected')
            until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            until(p, "() => /Nothing of yours is kept|your \\d+ files/.test(document.getElementById('methodos-kept').textContent) && !document.getElementById('methodos-kept').hidden", 15)
            g['said'] = p.evaluate(JOIN_STATE)['kept']; g['kept'] = p.evaluate(OUTPUTS_KEPT); g['clear offered'] = p.is_visible('#methodos-clear-kept')
            p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready')
            until(p, "() => !document.getElementById('methodos-pick').hidden || document.querySelectorAll('#chosen .name').length > 0", 15); p.wait_for_timeout(1000)
            g['after a reload'] = {'chosen': sorted(p.evaluate(SEAM_CHOSEN)), 'pick': p.evaluate(JOIN_STATE)['pick']}
            p.click('#methodos-leave'); until(p, "() => document.getElementById('methodos-tracker').hidden", 10)
            # Outside a workflow: a visit to Chora, in the page.
            p.set_input_files('#picker', [])
            choose(p, [f]); p.click('#to-chora'); chora_loaded(p)
            g['kept file'] = p.evaluate(SEAM_KEPT)
            p.click('#chora-leave'); p.wait_for_timeout(500)
            g['back'] = p.evaluate(SEAM_CHOSEN)
            # A reload, outside a workflow: offered with it on, nothing with it off.
            p.reload(); wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready'); soon(p, SEAM_SHOWN, 10)
            g['offered after a reload'] = p.evaluate(SEAM_OFFER)
            return g
        try:
            p = ctx.new_page(); main_ready(p)
            f = d / 'antonine-kept-or-not.json'; shutil.copyfile(ant, f)
            names = sorted(x.name for x in customs)
            on = run(p, f)
            p.evaluate("() => localStorage.setItem('plato-tools.keep-working-data', 'no')")
            main_ready(p)
            off = run(p, f)
            got = {'on': on, 'off': off}
            ok = (on['said'] and on['said'].startswith('Kept in this browser') and on['kept'] and len(on['kept']) == len(customs) and on['clear offered']
                  and on['after a reload']['chosen'] == names and on['kept file'] == [f.name] and on['back'] == [f.name]
                  and f.name in (on['offered after a reload'] or '') and off['offered after a reload'] is None
                  and off['said'] and 'Nothing of yours is kept in this browser' in off['said'] and off['kept'] is None and not off['clear offered']
                  and off['after a reload']['chosen'] == [] and off['after a reload']['pick'] == 'Choose the file'
                  and off['kept file'] is None and off['back'] == [f.name])
            return ok, got
        finally: ctx.close()
    attempt('Chora\'s seams: with "Keep my working data" off nothing of the user\'s is kept or offered, the tracker says so, and after a reload the file is chosen again by hand, while a visit to Chora keeps it chosen (with it on, the same steps keep each, choose it again, and offer it)', nothing_of_yours)

    def as_it_went():
        # "This step is done" at Chora's step, with the very dataset that went to Chora chosen again (as it
        # is on return): not taken as the result silently. Said, with two ways on, each tried here: "Nothing
        # to draw: go on with this dataset", which completes the step with it; or another file chosen (as
        # the file saved in Chora would be), which completes it with that one.
        ctx = fresh()
        got = {}
        try:
            p = hooked(main_ready(ctx.new_page()))
            for way in ('nothing to draw', 'another file'):
                p.evaluate('([t, a]) => window.__methodos_e2e.placeAtKept("As it went", "name,lat,lon\\nAbingdon,51.67,-1.28\\n", t, a)', [ant.read_text(), 'applied.json'])
                p.reload(); wait_state(p, lambda s: s.get('phase') in ('ready', 'detecting', 'detected'), T(30), 'ready'); hooked(p)
                if not detected_again(p, ['applied.json']): return False, {**got, way: 'not chosen again'}
                until(p, "() => document.querySelector('#methodos-track li[data-step=\"place\"]')?.dataset.state === 'current'", 15)
                p.click('#methodos-done')
                until(p, "() => /is the dataset that went to Chora/.test(document.getElementById('methodos-message').textContent)", 15)
                g = {'refused': p.evaluate(JOIN_STATE), 'offered': p.is_visible('#methodos-as-is')}
                if way == 'nothing to draw':
                    p.click('#methodos-as-is')
                else:
                    other = d / 'drawn-elsewhere.json'; other.write_text(ant.read_text() + '\n')
                    p.set_input_files('#picker', []); choose(p, [other])
                    p.click('#methodos-done')
                until(p, "() => document.querySelector('#methodos-track li[data-step=\"place\"]')?.dataset.state === 'done'", 15)
                g['after'] = p.evaluate(JOIN_STATE); g['offered after'] = p.is_visible('#methodos-as-is')
                got[way] = g
            n, a = got['nothing to draw'], got['another file']
            ok = all(g['refused']['steps'].get('place') == 'current' and 'Nothing to draw: go on with this dataset' in g['refused']['message'] and g['offered']
                     and g['after']['steps'].get('place') == 'done' and g['after']['steps'].get('again') == 'current' and not g['offered after'] for g in (n, a))
            ok = ok and 'goes on with applied.json' in n['after']['message'] and 'goes on with' not in a['after']['message']
            return ok, {k: {'refused': g['refused']['message'][:240], 'after': g['after']['message'][:200], 'steps': g['after']['steps']} for k, g in got.items()}
        finally: ctx.close()
    attempt('Chora\'s seams: "This step is done" at Chora\'s step with the dataset that went there unchanged is not taken silently: it says so, and "Nothing to draw" or another file chosen each completes the step', as_it_went)

    def off_in_chora():
        # "Keep my working data" turned off while Chora is shown: the kept file and Methodos's kept files
        # (the presence first: both there) go at once, as the panel promises.
        ctx = fresh()
        try:
            p = hooked(main_ready(ctx.new_page()))
            p.evaluate('([t, a]) => window.__methodos_e2e.placeAtKept("Kept", "name,lat,lon\\nAbingdon,51.67,-1.28\\n", t, a)', [ant.read_text(), 'applied.json'])
            f = d / 'antonine-off-in-chora.json'; shutil.copyfile(ant, f)
            if not choose(p, [f]): return False, 'not detected'
            p.click('#to-chora'); chora_loaded(p)
            got = {'kept file': p.evaluate(SEAM_KEPT), 'kept': p.evaluate(OUTPUTS_KEPT), 'Chora shown': chora_shown(p)}
            p.click('#permissions-button'); until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            p.uncheck('#perm-keep-work')
            until(p, '''async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) if (n.startsWith('kept-file-') || n === 'methodos-outputs') return false; return true; }''', 10)
            got.update({'kept file after': p.evaluate(SEAM_KEPT), 'kept after': p.evaluate(OUTPUTS_KEPT)})
            p.evaluate("() => localStorage.removeItem('plato-tools.keep-working-data')")
            ok = (got['Chora shown'] and got['kept file'] == [f.name] and got['kept'] and len(got['kept']) == 2 and got['kept file after'] is None and got['kept after'] is None)
            return ok, got
        finally: ctx.close()
    attempt('Chora\'s seams: "Keep my working data" turned off while Chora is shown lets the kept file and Methodos\'s kept files (the user\'s own copy among them) go at once', off_in_chora)

    def kept_offered():
        # A new visit or a reload, outside a workflow: the kept file is offered, not chosen ("Kept from last
        # time: … Use it / Forget it", announced politely); "Use it" chooses it as if just dropped.
        ctx = fresh()
        try:
            p = main_ready(ctx.new_page())
            f = d / 'parishes-kept.json'; shutil.copyfile(ant, f)
            if not choose(p, [f]): return False, 'not detected'
            if not kept_is(p, [f.name]): return False, {'kept': p.evaluate(SEAM_KEPT)}
            p.reload(); wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            soon(p, SEAM_SHOWN, 15); p.wait_for_timeout(1000)
            got = {'offered': p.evaluate(SEAM_OFFER), 'chosen before Use it': p.evaluate(SEAM_CHOSEN), 'phase': p.evaluate('() => window.__plato.phase'),
                   'role': p.get_attribute('#kept-file', 'role')}
            # Keyboard: Use it is reached by Tab from Forget it's neighbour, and pressed with Enter.
            p.focus('#kept-use'); p.keyboard.press('Enter')
            got['used'] = detected_again(p, [f.name]); got['offer after'] = p.evaluate(SEAM_OFFER); got['still kept'] = p.evaluate(SEAM_KEPT)
            ok = (got['offered'] and got['offered'].startswith(f'Kept from last time: {f.name} (') and ', chosen ' in got['offered'] and 'Use it' in got['offered'] and 'Forget it' in got['offered']
                  and got['chosen before Use it'] == [] and got['phase'] == 'ready' and got['role'] == 'status'
                  and got['used'] and got['offer after'] is None and got['still kept'] == [f.name])
            return ok, got
        finally: ctx.close()
    attempt('The kept file: after a reload outside a workflow it is offered under "Choose your data", not chosen, until "Use it" chooses it', kept_offered)

    def kept_replaced_and_forgotten():
        # A new choice replaces the kept file; "Forget it" (under "Choose your data", and in the Permissions
        # panel) lets it go, and a reload offers nothing.
        ctx = fresh()
        try:
            p = main_ready(ctx.new_page())
            a, b = d / 'first-choice.json', d / 'second-choice.json'; shutil.copyfile(ant, a); b.write_text(ant.read_text() + '\n')
            choose(p, [a])
            if not kept_is(p, [a.name]): return False, {'first not kept': p.evaluate(SEAM_KEPT)}
            p.set_input_files('#picker', []); choose(p, [b])
            if not kept_is(p, [b.name]): return False, {'second not kept': p.evaluate(SEAM_KEPT)}
            got = {'kept after the second': p.evaluate(SEAM_KEPT)}
            p.reload(); wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready'); soon(p, SEAM_SHOWN, 15)
            got['offered'] = p.evaluate(SEAM_OFFER)
            # The Permissions panel lists it, with its own way to forget it.
            p.click('#permissions-button'); until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            until(p, "() => /second-choice/.test(document.getElementById('perm-kept-file')?.textContent || '')", 10)
            got['panel'] = p.inner_text('#perm-kept-file')
            p.keyboard.press('Escape')
            p.click('#kept-forget')
            until(p, "() => document.getElementById('kept-file').hidden", 10)
            got['after Forget it'] = {'kept': p.evaluate(SEAM_KEPT), 'offered': p.evaluate(SEAM_OFFER)}
            p.reload(); wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready'); p.wait_for_timeout(1500)
            got['after a reload'] = {'kept': p.evaluate(SEAM_KEPT), 'offered': p.evaluate(SEAM_OFFER), 'chosen': p.evaluate(SEAM_CHOSEN)}
            # And forgotten from the panel: kept again (the presence), then let go there.
            choose(p, [a])
            if not kept_is(p, [a.name]): return False, {**got, 'kept again': p.evaluate(SEAM_KEPT)}
            p.click('#permissions-button'); until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            until(p, "() => !!document.querySelector('#perm-kept-file button[data-kept-forget]')", 10)
            p.click('#perm-kept-file button[data-kept-forget]')
            until(p, "() => /No file of yours is kept/.test(document.getElementById('perm-kept-file').textContent)", 10)
            got['panel forgot'] = p.evaluate(SEAM_KEPT)
            ok = (got['kept after the second'] == [b.name] and got['offered'] and b.name in got['offered'] and a.name not in got['offered']
                  and b.name in got['panel'] and 'Forget it' in got['panel']
                  and got['after Forget it'] == {'kept': None, 'offered': None} and got['after a reload'] == {'kept': None, 'offered': None, 'chosen': []}
                  and got['panel forgot'] is None)
            return ok, got
        finally: ctx.close()
    attempt('The kept file: a new choice replaces it; "Forget it" (under "Choose your data", or in the Permissions panel, which lists it) clears it from the browser, and after a reload nothing is offered', kept_replaced_and_forgotten)
    browser.close(); nocache.close()

# ---- Methodos, Map your data end to end (docs/plans/methodos.md, section 9, phase 4) ------------------
# A ten-row CSV with county and parish columns walked through Methodos's "Map your data" on the page, as
# a person would: the interview, the tracker, Hermes's columns (the "within" levels), the check, the
# conversion under a base address, Krisis's region review level by level, the places looked up within
# their regions and accepted, the decisions recorded with the region each place is in (the candidates
# exported first), a place's location adopted from its gazetteer match in Chora and handed back, the
# check again, the comparison, and PLATO JSON written. WHG is never called: the context routes it to a
# stub, as the Krisis and Chora adoption checks do. Every request the two pages make is kept: none may go
# to a site that was not allowed, beside the lookups that did go to the stub.
MYDATA_W3 = 'https://w3id.org/whg/id/'
MYDATA_BASE = 'https://example.org/parishes/'
MYDATA_CSV = ROOT / 'test/fixtures/methodos/parishes.csv'
def mydata_answer(id, name, point):
    return {'id': id, 'name': name, 'score': 100, 'match': True, 'description': 'Country: GB', 'ccodes': ['GB'], 'repr_point': point,
            'namespace': id.split(':')[1], 'alt_names': [], 'has_geom': True, 'confidence': 100}
MYDATA_ANSWERS = {
    'Cheshire': [mydata_answer('place:gn:2653941', 'Cheshire', [-2.5, 53.2])], 'Lancashire': [mydata_answer('place:gn:2644974', 'Lancashire', [-2.6, 53.8])],
    'Newton': [mydata_answer('place:gn:2641434', 'Newton', [-2.4, 53.3])], 'Barton': [mydata_answer('place:gn:2656167', 'Barton', [-2.3, 53.1])],
    'Ashby': [mydata_answer('place:gn:2657441', 'Ashby', [-2.7, 53.9])],
    **{n: [mydata_answer(f'place:gn:90000{i:02d}', n, [-2.4 - i / 100, 53.3])] for i, n in enumerate(
        ['Mill Farm', 'Church Barn', 'Hall Green', 'Low Mill', 'Moss Side', 'Brook End', 'High Cross', 'Old Hall', 'Wood Lane'], 1)},
}
# Wood Lane has a second place of its name in its parish, scoring under the first, so WHG's own tie lets the
# first through: the bulk accept leaves it to the reviewer all the same (#31, "skip ties").
MYDATA_ANSWERS['Wood Lane'] = MYDATA_ANSWERS['Wood Lane'] + [{**mydata_answer('place:gn:9000011', 'Wood Lane', [-2.6, 53.36]), 'score': 95, 'match': False, 'confidence': 90}]
# Kirk House has no candidate in the lookup: it is the place whose location (and identity) is adopted in Chora.
MYDATA_KIRK = mydata_answer('place:gn:9000010', 'Kirk House', [-2.31, 53.12])
MYDATA_KIRK_FEATURE = {'@id': 'https://whgazetteer.org/entity/place:gn:9000010/api', 'type': 'Feature', 'properties': {'title': 'Kirk House', 'ccodes': ['GB']},
                       'geometry': {'type': 'Point', 'coordinates': [-2.3105, 53.1207]}, 'names': [{'toponym': 'Kirk House', 'lang': 'en'}]}

def mydata_ends(doc):
    """What the end of Map your data must hold, read from the PLATO JSON written: every place ContainedIn a region
    minted from its row, every identity to a record of the stub, citing WHG, each region's (and each place's from
    the review) promotedFrom a candidate of the set exported, and a geometry adopted from the stub's record."""
    ents = doc.get('spatialEntities') or []
    regions = {e['@id'] for e in ents if '/place/region-' in (e.get('@id') or '')}
    places = [e for e in ents if e.get('@id') not in regions]
    def cites_whg(a): return any('whgazetteer.org' in json.dumps(x) or 'World Historical Gazetteer' in json.dumps(x) for x in (a.get('sources') or []) + (a.get('citations') or []))
    contained = [e['@id'] for e in places if any(r.get('relationType') == 'https://w3id.org/plato#ContainedIn' and r.get('relatesTo') in regions
                                                 for a in e.get('attestations') or [] for r in a.get('relations') or [])]
    ids = [(i, a) for e in ents for a in e.get('attestations') or [] for i in a.get('identities') or []]
    region_ids = [i for i, a in ids if i.get('subject') in regions]
    geoms = [(e['@id'], a) for e in places for a in e.get('attestations') or [] if a.get('geometries')]
    return {'places': len(places), 'regions': len(regions), 'contained': len(contained),
            'identities': len(ids), 'stub': bool(ids) and all(i.get('object', '').startswith(MYDATA_W3) and cites_whg(a) for i, a in ids),
            'region identities': len(region_ids), 'regions promoted': bool(region_ids) and all((i.get('promotedFrom') or '').startswith(MYDATA_BASE + 'candidates/') for i in region_ids),
            'places promoted': sum(1 for i, a in ids if i.get('subject') not in regions and (i.get('promotedFrom') or '').startswith(MYDATA_BASE + 'candidates/')),
            'geometries from the stub': sorted(pid.rsplit('/', 1)[-1] for pid, a in geoms if cites_whg(a)),
            'candidate sets': (doc.get('gazetteer') or {}).get('candidateSets') or []}
def mydata_complete(e):
    return (e.get('places') == 10 and e.get('regions') == 6 and e.get('contained') == 10 and e.get('stub') is True
            and e.get('region identities') == 6 and e.get('regions promoted') is True and e.get('places promoted') == 8
            and e.get('geometries from the stub') == ['4'] and len(e.get('candidate sets') or []) == 1)

def map_your_data_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    origin = re.match(r'^https?://[^/]+', base).group(0)
    out = tmp / 'mydata'; out.mkdir(exist_ok=True)
    browser = pw.chromium.launch(headless=True, args=GL)
    ctx = browser.new_context(accept_downloads=True, viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    posts, gets, asked, consoled = [], [], [], []
    def stub(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        reply = lambda body, status=200: route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
        if req.method == 'GET':
            gets.append(req.url)
            return reply(MYDATA_KIRK_FEATURE) if '/entity/place:gn:9000010/api' in req.url else reply({'detail': 'Not found'}, 404)
        body = json.loads(req.post_data or '{}'); posts.append(body)
        res = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in (body.get('queries') or {}).items():
            # The lookup finds no candidate for Kirk House; Chora's own search, by its words, finds the record to adopt.
            found = [MYDATA_KIRK] if q.get('query') == 'Kirk House adopt' else MYDATA_ANSWERS.get(q.get('query'), [])
            # As WHG's place#323: asked for areas only, a record with no outline is left out.
            if q.get('area_only'): found = [c for c in found if c.get('has_geom')]
            res[k] = {'result': found, **({'scope': {'applied': True}} if isinstance(q.get('contained_in'), list) else {})}
        reply(res)
    ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub)
    # Every request the page makes, Chora's included, wherever it was going (a request the policy stops never reaches this; the console says so).
    ctx.on('request', lambda r: asked.append(r.url))
    page = ctx.new_page()
    page.on('console', lambda m: consoled.append(m.text))
    r = {}
    track = lambda: page.evaluate(JOIN_STATE)
    def step_is(step, state, timeout=60):
        until(page, f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
    def choose(fs):
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(f) for f in fs])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
        return s
    def run(button, timeout=180):
        page.click(button)
        return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), T(timeout), 'run')
    def saved(s, ending, name=None):
        n = name or next((o['name'] for o in (s.get('outputs') or []) if o['name'].endswith(ending)), None)
        if not n: raise RuntimeError(f'no output ending {ending}: {[o["name"] for o in s.get("outputs") or []]}')
        return download(page, n, out / n)
    def need(*keys):
        missing = [k for k in keys if not r.get(k)]
        if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')

    def begin():
        # WHG allowed (the grant, as the Permissions panel writes it), the reviewer named; then the interview.
        page.goto(NOTOOLS if PROVE else base)
        page.evaluate("() => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-10-04T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Map Reviewer' })); localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Map Reviewer' })); }")
        page.goto(NOTOOLS if PROVE else base)
        s = wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('canary') in ('enforced', 'not-enforced'), T(30), 'ready')
        r['policy'] = page.evaluate('() => (window.__platoCsp || {}).origins || null'); r['canary'] = s.get('canary')
        page.evaluate("() => { const b = document.getElementById('base'); b.value = %s; b.dispatchEvent(new Event('change')); const v = document.getElementById('reviewer'); v.value = 'Map Reviewer'; v.dispatchEvent(new Event('change')); }" % json.dumps(MYDATA_BASE))
        page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'yes'), ('will-draw', 'yes'), ('will-publish', 'no')): page.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        r['base shown'] = page.input_value('#methodos-base')   # pre-filled from Options
        planned = page.eval_on_selector_all('#methodos-plan li', 'ls => ls.map((l) => l.textContent)')
        page.click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        s = choose([MYDATA_CSV])
        until(page, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        s = wait_state(page, lambda s: ((s.get('columns') or {}).get('levels') or {}), T(30), 'columns')
        r['columns'] = (s.get('columns') or {}).get('levels')
        t = track(); r['begun'] = t
        ok = (r['canary'] == 'enforced' and r['policy'] and all(re.match(r'^https://([a-z]+\.)?whgazetteer\.org$', o) for o in r['policy']) and t['steps'].get('columns') == 'current'
              and [k for k in t['steps']] == ['columns', 'check', 'dataset', 'regions', 'lookup', 'review', 'relate', 'place', 'again', 'compare', 'out']
              and not any('not identified' in x or 'Not yet available' in x for x in planned) and r['columns'] == {'county': 1, 'parish': 2}
              and r['base shown'] == MYDATA_BASE)
        return ok, {'base shown': r['base shown'], 'levels': r['columns'], 'planned': planned[:12], 'policy': r['policy'], 'canary': r['canary'], 'steps': t['steps']}
    attempt('Map your data: the interview (a table, places on a map, with regions, drawing, no publishing) gives the eleven steps, the regions step and the step recording them available, the base address shown from Options, with WHG alone in the page\'s policy', begin)

    def through_convert():
        need('begun')
        page.click('#methodos-done'); step_is('columns', 'done', 15)
        r['check'] = run('#check').get('phase'); step_is('check', 'done')
        page.select_option('#target', 'plato-json')
        s = run('#convert'); step_is('dataset', 'done')
        r['converted'] = saved(s, '.json')
        t = track()
        return (r['check'] == 'done' and t['steps'].get('regions') == 'current' and r['converted'] is not None), {'check': r['check'], 'steps': t['steps'], 'message': t['message'][:200]}
    attempt('Map your data: the columns matched (county and parish as levels), the table checked and converted under the base address, each step done by its run, and the workflow then waits at the regions', through_convert)

    W = lambda: (wait_state(page, lambda s: True, 5).get('work') or {})
    art = lambda k: f'#regions-level article[data-rkey="{k}"]'
    def regions():
        need('converted')
        choose([r['converted']])
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        page.wait_for_function("() => !document.getElementById('regions-offer').hidden", timeout=T(60) * 1000)
        page.click('#regions-start')
        wait_state(page, lambda s: len(((s.get('work') or {}).get('regions') or {})) == 6, T(60), 'regions')
        early = None
        for level in (1, 2):
            page.click(f'#regions-nav button[data-rlevel="{level}"]')
            n = len(posts)
            page.click('#regions-level button[data-rgo="level"]')
            wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(posts) > n, T(60), f'level {level}')
            if level == 1:   # the step is not done while a level is open: said, and still waiting
                page.click('#methodos-done')
                soon(page, "() => /not settled yet/.test(document.getElementById('methodos-message').textContent)", 10)
                early = track()
            keys = [k for k, g in (W().get('regions') or {}).items() if g['level'] == level]
            for k in keys:
                page.click(art(k) + ' li.candidate button[data-ract="match"]')
                wait_state(page, lambda s: (((s.get('work') or {}).get('regions') or {}).get(k) or {}).get('outcome') == 'matched', T(10), 'settled')
        r['level 2 sent'] = sorted(json.dumps(q.get('contained_in')) for q in posts[-1]['queries'].values()) if posts else []
        page.click('#methodos-done'); step_is('regions', 'done', 15)
        t = track(); r['regions done'] = True
        return (early['steps'].get('regions') == 'current' and 'not settled yet' in early['message']
                and r['level 2 sent'] == ['["gn:2644974"]', '["gn:2644974"]', '["gn:2653941"]', '["gn:2653941"]'] and t['steps'].get('lookup') == 'current'), \
            {'early': {'step': early['steps'].get('regions'), 'message': early['message'][:200]}, 'level 2 sent': r['level 2 sent'], 'steps': t['steps']}
    attempt('Map your data: the regions reviewed level by level on the dataset (level 2 sent within the county matched); "This step is done" is refused while a level is open, and taken once every region is settled', regions)

    def places_and_review():
        need('regions done')
        page.click('#regions-nav button[data-rlevel="places"]')
        n = len(posts)
        page.click('#regions-level button[data-rgo="places"]')
        step_is('lookup', 'done', 90)
        within = {q['query']: q.get('contained_in') for q in posts[n]['queries'].values()} if len(posts) > n else {}
        until(page, "() => !document.getElementById('bulk-accept').disabled", 30)
        page.click('#bulk-accept')
        wait_state(page, lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match' and '/region-' not in c['candidate_source']) == 8, T(15), 'accepted')
        said = page.evaluate("() => document.getElementById('bulk-result').textContent")
        wood = [c for c in W().get('candidates', []) if (c.get('other') or {}).get('label') == 'Wood Lane']
        for _ in range(12):   # Wood Lane's own screen, and the badge that says why it was left
            if 'Wood Lane' in page.inner_text('#review-subject'): break
            page.click('#review-next')
        badge = page.eval_on_selector_all('#review-place .badge.namesakes', 'els => els.map((e) => e.textContent)')
        page.click('#methodos-done'); step_is('review', 'done', 15)
        r['reviewed'] = True
        return (within.get('Mill Farm') == ['gn:2641434'] and within.get('Wood Lane') == ['gn:2657441'] and len(within) == 10
                and '1 place has 2 candidates of its name where it was looked for' in said and len(wood) == 2 and all(c.get('decision') is None for c in wood)
                and badge == ['2 places of this name in Ashby (Lancashire): left for you, not accepted in bulk.']
                and track()['steps'].get('relate') == 'current'), {'said': said[:300], 'badge': badge, 'at': page.inner_text('#review-subject')[:80], 'within': within, 'Wood Lane': [(c['gazetteer']['id'], c.get('decision')) for c in wood], 'steps': track()['steps']}
    attempt('Map your data: the places looked up within their parishes as the lookup step, the eight that pass WHG\'s guards accepted in bulk, Wood Lane (two places of its name in its parish) left to the reviewer and said so, and the review step done', places_and_review)

    def relate():
        need('reviewed')
        page.check('input[name="review-output"][value="dataset"]')
        n = len(consoled)
        s = run('#finish')
        soon(page, "() => /export the suggestions first/.test(document.getElementById('methodos-message').textContent)", 10)
        unexported = track()
        page.click('#export-candidates')
        until(page, "() => !!window.__plato.candidates && !!window.__plato.candidates.setIri", 15)
        s = run('#finish'); step_is('relate', 'done', 30)
        r['related'] = saved(s, '.krisis-dataset.json')
        e = mydata_ends(json.loads(r['related'].read_text()))
        return (unexported['steps'].get('relate') == 'current' and 'export the suggestions first' in unexported['message']
                and e['contained'] == 10 and e['region identities'] == 6 and e['regions promoted'] and track()['steps'].get('place') == 'current'), \
            {'before export': unexported['message'][:220], 'ends': e, 'steps': track()['steps']}
    attempt('Map your data: Finish before the candidates are exported is not counted as recording the regions (said why); after, the dataset has each place ContainedIn its parish and each region\'s identity promotedFrom its candidate', relate)

    def adopt_in_chora():
        need('related')
        choose([r['related']])
        page.click('#for-tool a[href="#chora"]')
        # The dataset chosen in step 1 is shown in Chora at once, in the page.
        until(page, 'window.__chora && window.__chora.mapReadyCount >= 1 && ["loaded", "error", "unrecognised"].includes(window.__chora.phase)', 90)
        if cstate(page).get('phase') != 'loaded': raise RuntimeError(f'not opened: {cstate(page).get("phase")}')
        chora_pick(page, 'kirk house')
        page.click('#adopt-find'); until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10)
        if not page.is_visible('#adopt-token-forget'): page.fill('#adopt-token', LOOKUP_TOKEN); page.press('#adopt-token', 'Enter')
        page.fill('#adopt-q', 'Kirk House adopt'); page.click('#adopt-send')
        until(page, '() => ["answered", "problem"].includes(window.__chora.adopt.phase)', 30)
        page.click('#adopt-candidates li[data-cand="place:gn:9000010"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        page.click('#adopt-go'); until(page, '() => window.__chora.adopt.phase === "adopted"', 10)
        until(page, '() => window.__chora.draftWrites === 0', 10)
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        name = (ls.get('outputs') or [{}])[0].get('name')
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        r['drawn'] = out / name; d.value.save_as(r['drawn'])
        # The file saved is chosen in step 1, and the step is done with it, by the save itself.
        until(page, '() => !!window.__chora.handedOver && window.__plato.phase === "detected"', 60)
        step_is('place', 'done', 15)
        page.click('#chora-leave')
        return (ls.get('passed') is True and ls.get('added') == 2 and track()['steps'].get('again') == 'current'), {'save': {k: ls.get(k) for k in ('passed', 'added')}, 'steps': track()['steps']}
    def base_changed():
        need('related')
        page.evaluate("() => { const b = document.getElementById('base'); b.value = 'https://example.org/moved/'; b.dispatchEvent(new Event('change')); }")
        s = run('#finish')
        warned = page.inner_text('#review-warning') if page.is_visible('#review-warning') else ''
        page.evaluate("() => { const b = document.getElementById('base'); b.value = %s; b.dispatchEvent(new Event('change')); }" % json.dumps(MYDATA_BASE))
        s2 = run('#finish')
        quiet = page.is_visible('#review-warning')
        return (s.get('phase') == 'done' and 'is not the one this review was saved with (' + MYDATA_BASE + ')' in warned and s2.get('phase') == 'done' and quiet is False), \
            {'phase': s.get('phase'), 'warned': warned[:240], 'shown with the same address': quiet}
    attempt('Map your data: Finish with another base address in Options says it is not the review\'s saved address, and still writes (not blocked); with the same address, nothing is said', base_changed)

    attempt('Map your data: in Chora, opened from the tracker, Kirk House\'s location and identity adopted from the stub\'s record, saved (the version check passed), and the place step done by the save with that file, chosen in step 1', adopt_in_chora)

    def to_the_end():
        need('drawn', 'converted')
        r['again'] = run('#check').get('phase'); step_is('again', 'done')
        page.set_input_files('#earlier', [str(r['converted'])])
        s = wait_state(page, lambda s: s.get('action') == 'compare' and s.get('phase') in ('done', 'error'), T(120), 'compare')
        step_is('compare', 'done')
        # The tracker narrows step 2 to the step's tool (Metaphrasis) once it comes to it.
        until(page, "() => { const t = document.getElementById('target'); return !!t && !!t.offsetParent; }", 30)
        # The dataset handed back is PLATO JSON already, the format the workflow writes: the step is ready to
        # download it as it is (the page offers no conversion of a format into itself), and is done once downloaded.
        until(page, "() => !document.getElementById('methodos-download').hidden", 30)
        offered = page.eval_on_selector_all('#target option', 'os => os.map((o) => o.value)')
        ready = {'row': page.inner_text('#methodos-track li[data-step="out"]'), 'message': track()['message'], 'button': page.inner_text('#methodos-download')}
        with page.expect_download(timeout=T(30) * 1000) as d: page.click('#methodos-download')
        r['final'] = out / ('final-' + d.value.suggested_filename); d.value.save_as(r['final'])
        step_is('out', 'done', 15)
        until(page, "document.getElementById('methodos-tracker').dataset.status === 'completed' || !document.querySelector('#methodos-track li.is-current')", 15)
        r['doc'] = json.loads(r['final'].read_text())
        e = mydata_ends(r['doc']); r['ends'] = e
        same = r['final'].read_bytes() == r['drawn'].read_bytes()
        return (r['again'] == 'done' and 'plato-json' not in offered and bool(offered) and 'Ready to download' in ready['row'] and 'Ready to download' in ready['message'] and ready['button'] == f"Download {r['drawn'].name}"
                and same and mydata_complete(e)), {'again': r['again'], 'offered': offered, 'ready': ready, 'same file': same, 'ends': e, 'steps': track()['steps']}
    attempt('Map your data: checked again, compared with the dataset converted from the table, and, already PLATO JSON, ready to download and downloaded as it is (the step then done), with its ten places ContainedIn their parishes, its identities and adopted geometry citing the stub, and its identities naming their candidates', to_the_end)

    def can_fail():
        need('final', 'doc')
        doc = r['doc']
        # The same check on the same file as a step that skipped writing ContainedIn would have left it: it must fail.
        mutated = {**doc, 'spatialEntities': [{**e, 'attestations': [a for a in e.get('attestations') or []
                   if not any(x.get('relationType') == 'https://w3id.org/plato#ContainedIn' for x in a.get('relations') or [])]} for e in doc['spatialEntities']]}
        m = mydata_ends(mutated)
        return mydata_complete(r['ends']) and not mydata_complete(m) and m['contained'] == 0, {'as written': mydata_complete(r['ends']), 'without ContainedIn': m}
    attempt('Map your data: the end check fails on the same file with ContainedIn left out, as a step that skipped writing it would leave it (and passes as written)', can_fail)

    def only_allowed():
        need('final')
        other = sorted({re.match(r'^[a-z]+:(//[^/]*)?', u).group(0) for u in asked
                        if not (u.startswith(origin + '/') or u.startswith('data:') or u.startswith('blob:') or re.match(r'^https://([^/]*\.)?whgazetteer\.org/', u))})
        refused = [m for m in consoled if 'Refused to connect' in m]
        reconciled = [u for u in asked if re.match(r'^https://whgazetteer\.org/.*reconcile', u)]
        return (not other and not refused and len(posts) >= 4 and len(reconciled) >= 4 and any('/entity/place:gn:9000010/api' in u for u in gets)), \
            {'other sites': other, 'refused': refused[:3], 'lookups to the stub': len(posts), 'entity fetched': gets[-1:] if gets else []}
    attempt('Map your data: every request the page made (Chora\'s too) went to this site or to WHG, which the permissions module allowed (the regions, the places and Chora\'s search went to the stub, and the record was fetched from it), and none to another site, nor any stopped by the policy', only_allowed)
    try: browser.close()
    except Exception: pass

# ---- Methodos: Places from an edition (TEI) and Places from Recogito (#28 phase 5; plan #34, item 2) ----------
# Each workflow walked through on the page as a visitor follows it, from the interview to the dataset downloaded at
# its end, against a stub of WHG (never the real one), which answers every name it is sent and records each request:
# Hermes's reader makes the dataset (the TEI edition; the Recogito export with the map's IIIF georeference and
# manifest, dropped together), Krisis looks the places up and the reviewer accepts in bulk, the decisions are
# recorded, the result checked again, compared with the dataset read, and, already PLATO JSON, downloaded as it is.
# The end check reads the file downloaded; each is shown failing on the same file as a step that skipped its work
# would leave it. RECIPE_SHOTS=<dir> saves screenshots of the tracker at 1440 x 900.
RECIPES_TEI = ROOT / 'test/fixtures/tei/prose-constructed.xml'
RECIPES_REC = [ROOT / 'test/fixtures/annotations/recogito-studio-regions-constructed.json', ROOT / 'test/fixtures/georef/bpl-rocque-annotation.json',
               ROOT / 'test/fixtures/georef/bpl-rocque-manifest.json']
RECIPES_PLEIADES = ['https://pleiades.stoa.org/places/570106', 'https://pleiades.stoa.org/places/570182', 'https://pleiades.stoa.org/places/570536',
                    'https://pleiades.stoa.org/places/570642', 'https://pleiades.stoa.org/places/570700']
RECIPES_NONE = {'Phlious'}   # a name the stub finds nothing for
def recipes_ends(doc):
    """What the end of either workflow holds, read from the PLATO JSON downloaded: the places' own addresses (the refs or
    Recogito's links, kept), the identities to the stub's records citing WHG, and the places placed (a geometry)."""
    ents = doc.get('spatialEntities') or []
    def cites_whg(a): return any('World Historical Gazetteer' in json.dumps(x) for x in (a.get('sources') or []) + (a.get('citations') or []))
    ids = [(i, a) for e in ents for a in e.get('attestations') or [] for i in a.get('identities') or []]
    stub = [(i, a) for i, a in ids if (i.get('object') or '').startswith(MYDATA_W3)]
    return {'places': len(ents), 'addresses': sorted(e.get('@id') for e in ents), 'stub': len(stub), 'cites WHG': bool(stub) and all(cites_whg(a) for i, a in stub),
            'others': sorted([i.get('subject'), i.get('object')] for i, a in ids if not (i.get('object') or '').startswith(MYDATA_W3)),
            'placed': sum(1 for e in ents if any(a.get('geometries') for a in e.get('attestations') or [])),
            'georef cited': sum(1 for e in ents for a in e.get('attestations') or [] if a.get('geometries') and 'annotations.allmaps.org' in json.dumps(a.get('citations') or []))}

def recipes_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    origin = re.match(r'^https?://[^/]+', base).group(0)
    shots = os.environ.get('RECIPE_SHOTS')
    browser = pw.chromium.launch(headless=True, args=GL)
    def walk(key, have, files, steps, expect):
        out = tmp / f'recipes-{key}'; out.mkdir(exist_ok=True)
        ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        ctx.add_init_script('window.__plato_forceDownload = true;')
        cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
        posts, asked, consoled, ids = [], [], [], {}
        def stub(route):
            req = route.request
            if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
            reply = lambda body, status=200: route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
            if req.method == 'GET': return reply({'detail': 'Not found'}, 404)
            body = json.loads(req.post_data or '{}'); posts.append(body)
            res = {'attribution': LOOKUP_ATTRIBUTION}
            for k, q in (body.get('queries') or {}).items():
                name = q.get('query')
                # Each name found as one record of its own (a GeoNames id the stub makes up, the same for the same name), but those it does not know.
                if name not in ids: ids[name] = f'place:gn:{9200000 + len(ids)}'
                own = (expect.get('answers') or {}).get(name)
                res[k] = {'result': own if own is not None else [] if name in RECIPES_NONE else [{'id': ids[name], 'name': name, 'score': 100, 'match': True, 'description': 'Country: US', 'ccodes': ['US'],
                                                                     'namespace': 'gn', 'alt_names': [], 'has_geom': True, 'confidence': 100}]}
            reply(res)
        ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub)
        ctx.on('request', lambda r: asked.append(r.url))
        page = ctx.new_page()
        page.on('console', lambda m: consoled.append(m.text))
        r = {}
        track = lambda: page.evaluate(JOIN_STATE)
        def shot(name):
            if shots and not PROVE:
                pathlib.Path(shots).mkdir(parents=True, exist_ok=True)
                page.mouse.move(1, 1)   # no tooltip over the picture
                page.screenshot(path=str(pathlib.Path(shots) / f'{key}-{name}.png'), full_page=False)
        def step_is(step, state, timeout=60):
            until(page, f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
        def choose(fs):
            page.set_input_files('#picker', [])
            page.set_input_files('#picker', [str(f) for f in fs])
            s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
            if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
            return s
        def run(button, timeout=180):
            page.click(button)
            return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), T(timeout), 'run')
        def saved(s, ending):
            n = next((o['name'] for o in (s.get('outputs') or []) if o['name'].endswith(ending)), None)
            if not n: raise RuntimeError(f'no output ending {ending}: {[o["name"] for o in s.get("outputs") or []]}')
            return download(page, n, out / n)
        def need(*keys):
            missing = [k for k in keys if not r.get(k)]
            if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')
        title = expect['title']

        def begin():
            page.goto(NOTOOLS if PROVE else base)
            page.evaluate("() => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-10-12T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Recipe Reviewer' })); }")
            page.goto(NOTOOLS if PROVE else base)
            s = wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('canary') in ('enforced', 'not-enforced'), T(30), 'ready')
            r['canary'] = s.get('canary')
            page.evaluate("() => { const v = document.getElementById('reviewer'); v.value = 'Recipe Reviewer'; v.dispatchEvent(new Event('change')); }")
            page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
            # The presence beside the absence, in one call: a table names nothing it cannot carry; the edition or the export does.
            page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="map"]')
            for k in ('has-regions', 'will-draw', 'will-publish'): page.check(f'input[name="methodos-ask-{k}"][value="no"]')
            table = page.eval_on_selector_all('#methodos-plan .track-cannot li', 'ls => ls.length')
            page.check(f'input[name="methodos-have"][value="{have}"]')
            asked_now = page.eval_on_selector_all('#mq-more fieldset[data-ask]', 'fs => fs.map((f) => f.dataset.ask)')
            for k in ('will-draw', 'will-publish'): page.check(f'input[name="methodos-ask-{k}"][value="no"]')
            planned = page.eval_on_selector_all('#methodos-plan li.track-step', 'ls => ls.map((l) => l.dataset.step)')
            cannot = page.eval_on_selector_all('#methodos-plan .track-cannot li', 'ls => ls.map((l) => l.textContent)')
            recipe = page.evaluate("() => document.getElementById('methodos').dataset.recipe || null")
            if shots and not PROVE: page.locator('#methodos-plan').scroll_into_view_if_needed(); shot('0-interview')
            page.click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
            choose(files)
            until(page, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            t = track(); r['begun'] = t
            folded = page.eval_on_selector_all('#methodos-cannot:not([hidden]) li', 'ls => ls.map((l) => l.textContent)')
            ok = (r['canary'] == 'enforced' and table == 0 and recipe == expect['recipe'] and asked_now == ['will-draw', 'will-publish'] and planned == steps
                  and len(cannot) == expect['cannot'] and cannot[0].startswith(expect['cannot first']) and folded == cannot
                  and [k for k in t['steps']] == steps and t['steps'].get('check') == 'current' and t['status'] == 'idle')
            return ok, {'recipe': recipe, 'asked': asked_now, 'planned': planned, 'cannot': [c[:60] for c in cannot], 'table cannot': table, 'tracker cannot': len(folded), 'steps': t['steps']}
        attempt(f'{title}: the interview ({expect["have words"]}, places on a map, no drawing, no publishing) gives its {len(steps)} steps, asks drawing and publishing but not regions, and says what it cannot carry, in the plan and folded in the tracker (a table says nothing)', begin)

        def read():
            need('begun')
            r['check'] = run('#check').get('phase'); step_is('check', 'done')
            page.select_option('#target', 'plato-json')
            s = run('#convert'); step_is('dataset', 'done')
            r['converted'] = saved(s, '.json')
            d = recipes_ends(json.loads(r['converted'].read_text())); r['read'] = d
            said = page.inner_text('#summary')
            return (r['check'] == 'done' and track()['steps'].get('lookup') == 'current' and d['places'] == expect['places'] and d['placed'] == expect['placed']
                    and d['stub'] == 0 and (expect['said'] in said)), {'check': r['check'], 'read': {k: d[k] for k in ('places', 'placed', 'stub')}, 'summary': said[:300], 'steps': track()['steps']}
        attempt(f'{title}: checked, and read by Hermes into a PLATO dataset ({expect["places"]} places, {expect["placed"]} placed, none yet identified in WHG; the summary says "{expect["said"]}"), each step done by its run', read)

        def rail():
            need('converted')   # at the lookup step, whose message is short: the tracker as it mostly stands
            closed = page.evaluate(SCOPE_RAIL)
            page.click('#methodos-cannot > summary')
            until(page, "() => document.getElementById('methodos-cannot').open", 5)
            opened = page.evaluate(SCOPE_RAIL); shot('1-cannot-open')
            box = page.evaluate("() => { const d = document.getElementById('methodos-cannot'); return { h: d.getBoundingClientRect().height, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), items: d.querySelectorAll('li').length, shown: !!d.offsetHeight, reach: (() => { const r = document.querySelector('.workflow-rail'); return r.scrollHeight > r.clientHeight || d.getBoundingClientRect().bottom <= innerHeight; })() }; }")
            page.click('#methodos-cannot > summary')
            return (opened['steps'] == len(steps) and opened['inView'] >= 8 and box['shown'] and box['items'] == expect['cannot'] and box['h'] <= 11 * box['rem'] + 1
                    and box['reach']), {'closed': closed, 'opened': opened, 'cannot box': box}
        attempt(f'{title}: at 1440 x 900, with "What this workflow cannot carry" open, its list scrolls within its own cap and at least 8 of the steps stay in view', rail)

        def look_and_review():
            need('converted')
            choose([r['converted']])
            if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
            page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
            until(page, "() => /^Send \\d+ quer/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", 60)
            n_places = len(expect['sent'])
            soon(page, f"() => document.getElementById('lookup-preview').textContent.includes('Would look up {n_places} places')", 15)
            every = {'preview': page.inner_text('#lookup-preview')[:120], 'choice': page.input_value('#lookup-places')}
            # Only places without a gazetteer link, in one click: every place here has one (a ref, a link), so none is taken.
            page.click('#lookup-only-unlinked')
            soon(page, "() => document.getElementById('lookup-preview').textContent.includes('No places to look up with this choice')", 15)
            only = {'preview': page.inner_text('#lookup-preview')[:200], 'choice': page.input_value('#lookup-places'), 'send off': page.evaluate("() => document.getElementById('lookup-send').disabled")}
            page.select_option('#lookup-places', every['choice'])
            until(page, f"() => document.getElementById('lookup-preview').textContent.includes('Would look up {n_places} places') && !document.getElementById('lookup-send').disabled", 30)
            sends = page.inner_text('#lookup-send')
            page.click('#lookup-send')
            step_is('lookup', 'done', 90)
            sent = sorted(q['query'] for b in posts for q in (b.get('queries') or {}).values())
            batches = [len(b.get('queries') or {}) for b in posts]
            shot('2-review')
            until(page, "() => !document.getElementById('bulk-accept').disabled", 30)
            page.click('#bulk-accept')
            n = expect['accepted']
            wait_state(page, lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match') == n, T(15), 'accepted')
            said = page.evaluate("() => document.getElementById('bulk-result').textContent")
            # A place flagged (its own link far from WHG's best candidate) is shown with both, and left by the bulk accept.
            flagged = {}
            for name in expect.get('flagged') or []:
                for _ in range(12):
                    if name in page.inner_text('#review-place'): break
                    page.click('#review-next')
                flagged[name] = {'ref': page.evaluate("() => { const p = document.querySelector('#review-place .ref-check'); const b = p?.getBoundingClientRect(), box = document.getElementById('review-place').getBoundingClientRect(); return p ? { state: p.dataset.ref, text: p.textContent, inFlow: getComputedStyle(p).position === 'static' && b.height > 0 && b.left >= box.left && b.right <= box.right + 1 } : null; }"),
                                 'decided': page.evaluate('(iri) => (window.__plato.work?.candidates || []).filter((c) => c.candidate_source === iri && c.decision).length', name)}
                shot('2b-flagged')
            page.click('#methodos-done'); step_is('review', 'done', 15)
            r['reviewed'] = True
            flag_ok = all(f['ref'] and f['ref']['state'] == 'disagrees' and f['ref']['inFlow'] is True and 'more than 25 km' in f['ref']['text'] and 'place:pl:' in f['ref']['text'] and not f['decided'] for f in flagged.values()) \
                and len(flagged) == len(expect.get('flagged') or []) and (not flagged or 'far from WHG\'s best candidate, and is left to you' in said)
            return (sent == expect['sent'] and sends == f"Send {n_places} queries to WHG" and batches == [n_places] and track()['steps'].get('apply') == 'current'
                    and every['choice'] != 'nolink' and only['choice'] == 'nolink' and only['send off'] is True and flag_ok), \
                {'button': sends, 'sent': sent, 'queries a POST': batches, 'every place': every, 'only without a link': only, 'bulk': said[:300], 'flagged': flagged, 'steps': track()['steps']}
        flag_words = ", the flagged place shown with its link and WHG's best candidate and left to the reviewer" if expect.get('flagged') else ''
        attempt(f'{title}: the count of places said before sending, none taken by "Only places without a gazetteer link" (each has one); the named places looked up in the stub of WHG in one batched POST ({len(expect["sent"])} queries), accepted in bulk{flag_words}, and the review step done', look_and_review)

        def record():
            need('reviewed')
            page.check('input[name="review-output"][value="dataset"]')
            s = run('#finish'); step_is('apply', 'done', 30)
            r['applied'] = saved(s, '.krisis-dataset.json')
            return track()['steps'].get('again') == 'current', {'phase': s.get('phase'), 'steps': track()['steps']}
        attempt(f'{title}: the decisions recorded in the dataset (Krisis\'s Finish, as the dataset) as the step that records them', record)

        def to_the_end():
            need('applied', 'converted')
            choose([r['applied']])
            r['again'] = run('#check').get('phase'); step_is('again', 'done')
            page.set_input_files('#earlier', [str(r['converted'])])
            s = wait_state(page, lambda s: s.get('action') == 'compare' and s.get('phase') in ('done', 'error'), T(120), 'compare')
            r['compared'] = (s.get('report') or {}).get('errors')
            step_is('compare', 'done')
            until(page, "() => !document.getElementById('methodos-download').hidden", 30)
            with page.expect_download(timeout=T(30) * 1000) as d: page.click('#methodos-download')
            r['final'] = out / ('final-' + d.value.suggested_filename); d.value.save_as(r['final'])
            step_is('out', 'done', 15)
            until(page, "document.getElementById('methodos-tracker').dataset.status === 'completed' || !document.querySelector('#methodos-track li.is-current')", 15)
            shot('3-done')
            r['doc'] = json.loads(r['final'].read_text())
            e = recipes_ends(r['doc']); r['ends'] = e
            same = r['final'].read_bytes() == r['applied'].read_bytes()
            return (r['again'] == 'done' and r['compared'] == 0 and same and expect['complete'](e) and all(v.startswith('done') for v in track()['steps'].values())), \
                {'again': r['again'], 'compare errors': r['compared'], 'same file': same, 'ends': {k: v for k, v in e.items() if k != 'addresses'}, 'steps': track()['steps']}
        attempt(f'{title}: checked again, compared with the dataset read (nothing taken away), and downloaded as it is, every step done; {expect["holds"]}', to_the_end)

        def can_fail():
            need('doc')
            doc = r['doc']
            mutated = {**doc, 'spatialEntities': [{**e, 'attestations': [{k: v for k, v in a.items() if k not in expect['strip']} for a in e.get('attestations') or []]} for e in doc['spatialEntities']]}
            m = recipes_ends(mutated)
            return expect['complete'](r['ends']) and not expect['complete'](m), {'as written': expect['complete'](r['ends']), f'without {", ".join(expect["strip"])}': {k: v for k, v in m.items() if k != 'addresses'}}
        attempt(f'{title}: the end check fails on the same file with its {" and ".join(expect["strip"])} left out, as a step that skipped them would leave it (and passes as written)', can_fail)

        def only_allowed():
            need('final')
            other = sorted({re.match(r'^[a-z]+:(//[^/]*)?', u).group(0) for u in asked
                            if not (u.startswith(origin + '/') or u.startswith('data:') or u.startswith('blob:') or re.match(r'^https://([^/]*\.)?whgazetteer\.org/', u))})
            refused = [m for m in consoled if 'Refused to connect' in m]
            reconciled = [u for u in asked if re.match(r'^https://whgazetteer\.org/.*reconcile', u)]
            return (not other and not refused and len(posts) >= 1 and len(reconciled) >= 1), {'other sites': other, 'refused': refused[:3], 'lookups to the stub': len(posts)}
        attempt(f'{title}: every request the page made went to this site or to WHG (the stub, which the permissions module allowed, was asked), and none to another site, nor any stopped by the policy', only_allowed)
        try: ctx.close()
        except Exception: pass

    tei_steps = ['check', 'dataset', 'lookup', 'review', 'apply', 'again', 'compare', 'out']
    walk('tei', 'tei', [RECIPES_TEI], tei_steps, {
        'title': 'Places from an edition (TEI)', 'recipe': 'places-from-tei', 'have words': 'an edition in TEI', 'cannot': 4, 'cannot first': 'A place name with no ref, or a ref it cannot follow',
        'places': 5, 'placed': 0, 'sent': ['Argos', 'Corinth', 'Kenchreai', 'Phlious', 'Sikyon'], 'accepted': 3, 'strip': ['identities'], 'said': 'Read 6 place names, 5 places',
        'answers': {'Argos': [{'id': 'place:gn:9300001', 'name': 'Argos', 'score': 100, 'match': True, 'description': 'Country: US', 'ccodes': ['US'], 'repr_point': [-86.2453, 41.2373], 'namespace': 'gn', 'alt_names': [], 'has_geom': True, 'confidence': 100},
                              {'id': 'place:pl:570106', 'name': 'Argos', 'score': 90, 'match': True, 'description': 'Country: GR', 'ccodes': ['GR'], 'repr_point': [22.7278, 37.6331], 'namespace': 'pl', 'alt_names': [], 'has_geom': True, 'confidence': 100}]},
        'flagged': ['https://pleiades.stoa.org/places/570106'],
        'holds': 'its five places keep the Pleiades addresses their refs gave (and Kenchreai its GeoNames ref), three identified in the stub\'s records, citing WHG, and Argos (flagged) not',
        'complete': lambda e: (e['addresses'] == RECIPES_PLEIADES and e['stub'] == 3 and e['cites WHG'] is True
                               and e['others'] == [['https://pleiades.stoa.org/places/570536', 'https://sws.geonames.org/257880/']])})
    walk('recogito', 'recogito', RECIPES_REC, tei_steps, {
        'title': 'Places from Recogito', 'recipe': 'places-from-recogito', 'have words': 'annotations from Recogito, with the map\'s georeference', 'cannot': 4,
        'cannot first': 'A mention marked as a place but never linked', 'places': 13, 'placed': 7, 'said': '7 of 16 regions on images placed on a map',
        'sent': sorted(['120', '45', 'Boston', 'GULF OF MEXICO', 'LAKE ERIE', 'LAKE HURON', 'LAKE ONTARIO', 'Nantucket I.', 'St Georges Bank']), 'accepted': 9, 'strip': ['geometries'],
        'holds': 'its 13 places keep the Wikidata items Recogito linked them to, seven placed through the map\'s georeference and citing it, nine identified in the stub\'s records, citing WHG',
        'complete': lambda e: (e['places'] == 13 and all(a.startswith('http://www.wikidata.org/entity/Q') for a in e['addresses']) and e['placed'] == 7 and e['georef cited'] == 7
                               and e['stub'] == 9 and e['cites WHG'] is True)})
    try: browser.close()
    except Exception: pass

# ---- Match two datasets (src/engine/methodos/recipes/match-two-datasets.js; Stephen's decisions of 14 October 2026) --
# The workflow followed as a visitor follows it, on two small constructed files: the table (test/fixtures/methodos/
# match-mine.csv) read as Map your data reads it, the other dataset (match-other.json, with one timespan that is not a
# list, which its check finds) chosen at the match in Krisis, refused when another is given there, checked with its
# problem reported but not stopping the workflow, the review opened again after that check, saved, the page reloaded
# and the review resumed, the decisions recorded in the dataset (a Finish of the attestations alone refused), checked
# again, compared and downloaded. Nothing goes to WHG or any other site. Each absence is read beside a presence.
MATCH_CSV = ROOT / 'test/fixtures/methodos/match-mine.csv'
MATCH_BASE = 'https://w3id.org/match-test/'
def match_two_files(tmp):
    """The other dataset as the browser gets it: Kingsbury's link made to the table's Kingsbury under MATCH_BASE, and the
    first place's timespan not a list (the check's one problem); and another file of it, Newton left out."""
    d = json.loads((ROOT / 'test/fixtures/methodos/match-other.json').read_text().replace('https://example.org/mine/', MATCH_BASE))
    d['spatialEntities'][0]['attestations'][0]['timespans'] = 'never'
    b = tmp / 'match-other.json'; b.write_text(json.dumps(d))
    d2 = {**d, 'spatialEntities': d['spatialEntities'][1:]}
    b2 = tmp / 'match-other-2.json'; b2.write_text(json.dumps(d2))
    return b, b2

def match_two_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    origin = re.match(r'^https?://[^/]+', base).group(0)
    out = tmp / 'match-two'; out.mkdir(exist_ok=True)
    B, B2 = match_two_files(out)
    browser = pw.chromium.launch(headless=True, args=GL)
    ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    asked, consoled, whg = [], [], []
    # WHG is never asked by this workflow: anything sent there is answered with nothing, and counted.
    ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), lambda route: (whg.append(route.request.url), route.fulfill(status=404, body='{}')))
    ctx.on('request', lambda r: asked.append(r.url))
    page = ctx.new_page()
    page.on('console', lambda m: consoled.append(m.text))
    r = {}
    track = lambda: page.evaluate(JOIN_STATE)
    late = lambda: page.evaluate("() => { const e = document.getElementById('methodos-late'); return e && !e.hidden ? [...e.querySelectorAll('p.track-late')].map((p) => p.textContent) : []; }")
    def click(sel):
        try: page.click(sel, timeout=T(15) * 1000)
        except Exception as e:
            shown = page.evaluate("() => [...document.querySelectorAll('#methodos-tracker button')].filter((b) => !b.hidden && b.offsetParent).map((b) => b.id || b.textContent)")
            review = page.evaluate("() => !document.getElementById('review').hidden")
            t = track()
            raise RuntimeError(f'{sel} could not be clicked: buttons shown {shown}; review shown {review}; subject {page.evaluate("() => document.getElementById(`review-subject`)?.textContent || null")}; message {t["message"][:150]}; steps {t["steps"]}')
    def step_is(step, state, timeout=60):
        until(page, f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
    def choose(fs):
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(f) for f in fs])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
        return s
    def run(button, timeout=180):
        click(button)
        return wait_state(page, lambda s: s.get('phase') in ('done', 'error'), T(timeout), 'run')
    def saved(s, ending):
        n = next((o['name'] for o in (s.get('outputs') or []) if o['name'].endswith(ending)), None)
        if not n: raise RuntimeError(f'no output ending {ending}: {[o["name"] for o in s.get("outputs") or []]}')
        return download(page, n, out / n)
    def need(*keys):
        missing = [k for k in keys if not r.get(k)]
        if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')
    def matched(others):
        page.set_input_files('#others', [str(others)])
        return wait_state(page, lambda s: s.get('phase') in ('reviewing', 'error') or (s.get('action') == 'match' and s.get('phase') == 'done'), T(120), 'matching')
    # The review open, by the files it records it was made of: its own dataset's and the other dataset's names.
    REVIEW_OF = "() => { const w = window.__plato?.work; return w && !document.getElementById('review').hidden ? { subjects: (w.subjects?.files || []).map((f) => f.name), others: (w.others?.files || []).map((f) => f.name) } : null; }"
    def open_review(others):
        # "Open the review" from the tracker, then a wait for the review it opens: one whose other dataset is `others`.
        # Waiting only for a review to be shown passed at once when another review (Krisis's match on another file)
        # was already on the page, and the next click then landed in it, while it was being replaced (the live run of
        # 4a09869). So the review shown before is read first, and must change to the match's own.
        before = page.evaluate(REVIEW_OF)
        click('#methodos-open-review')
        until(page, f"() => {{ const r = ({REVIEW_OF})(); return !!r && JSON.stringify(r.others) === {json.dumps(json.dumps([others]))}; }}", 30)
        return before, page.evaluate(REVIEW_OF)
    def goto_place(label):
        # To the first place, then on to `label` (a review opened again may be anywhere in its order).
        for _ in range(8):
            if page.evaluate("() => document.getElementById('review-prev').disabled"): break
            click('#review-prev'); page.wait_for_timeout(100)
        for _ in range(8):
            if page.inner_text('#review-subject').strip() == label: return True
            if page.evaluate("() => document.getElementById('review-next').disabled"): break
            click('#review-next'); page.wait_for_timeout(100)
        if page.inner_text('#review-subject').strip() != label:
            raise RuntimeError(f'the place {label} is not in the review open ({page.evaluate(REVIEW_OF)}), at {page.inner_text("#review-subject")!r}')
        return True
    steps = ['columns', 'check', 'dataset', 'match', 'check-other', 'review', 'apply', 'again', 'compare', 'out']

    def begin():
        page.goto(NOTOOLS if PROVE else base)
        page.evaluate("() => { localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Match Reviewer' })); }")
        page.goto(NOTOOLS if PROVE else base)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        page.evaluate("() => { const b = document.getElementById('base'); b.value = %s; b.dispatchEvent(new Event('change')); const v = document.getElementById('reviewer'); v.value = 'Match Reviewer'; v.dispatchEvent(new Event('change')); }" % json.dumps(MATCH_BASE))
        click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="match"]')
        asked_now = page.eval_on_selector_all('#mq-more fieldset[data-ask]', 'fs => fs.map((f) => f.dataset.ask)')
        # The question of where the decisions go: in its own words, the dataset chosen until another is.
        into = page.evaluate("""() => { const f = document.querySelector('#mq-more fieldset[data-ask="into-dataset"]'); return f ? { legend: f.querySelector('legend').textContent,
          labels: [...f.querySelectorAll('label')].map((l) => l.textContent.trim()), checked: f.querySelector('input:checked')?.value || null } : null; }""")
        before = page.evaluate("() => document.getElementById('methodos-start').hidden")   # publishing not yet answered: no plan
        page.check('input[name="methodos-ask-will-publish"][value="no"]')
        planned = page.eval_on_selector_all('#methodos-plan li.track-step', 'ls => ls.map((l) => l.dataset.step)')
        click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        pending = late()
        choose([MATCH_CSV])
        until(page, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        until(page, "() => window.__plato?.columns?.headers && !document.getElementById('methodos-done').hidden", 30)
        t = track(); r['begun'] = t; begun = late()
        ok = (asked_now == ['into-dataset', 'will-publish'] and into == {'legend': 'Add the decisions to your dataset, or keep them in a file of their own about it?',
              'labels': ['Add them to my dataset', 'Keep them in a file of their own'], 'checked': 'yes'} and before is True and planned == steps
              and list(t['steps']) == steps and t['steps'].get('columns') == 'current'
              and len(pending) == 1 and pending[0].startswith('The other dataset: not yet chosen. It is chosen at the step') and "Krisis's “Match with another dataset…”" in pending[0]
              and begun == pending)
        return ok, {'asked': asked_now, 'into': into, 'plan hidden before': before, 'planned': planned, 'late before the file': pending, 'late begun': begun, 'steps': t['steps']}
    attempt('Match two datasets: the interview (a table, a match of two datasets) asks where the decisions go, in its own words, the dataset chosen, and publishing; plans its ten steps; and the tracker names the other dataset, not yet chosen, from the start', begin)

    def through_convert():
        need('begun')
        click('#methodos-done'); step_is('columns', 'done', 15)
        r['check'] = run('#check').get('phase'); step_is('check', 'done')
        page.select_option('#target', 'plato-json')
        s = run('#convert'); step_is('dataset', 'done')
        r['converted'] = saved(s, '.json')
        t = track()
        return (r['check'] == 'done' and t['steps'].get('match') == 'current'), {'check': r['check'], 'steps': t['steps']}
    attempt('Match two datasets: the table\'s columns matched, checked and made a PLATO dataset under the base address, each step done by its run; the workflow is then at the match', through_convert)

    def match_step():
        need('converted')
        choose([r['converted']])
        s = matched(B)
        step_is('match', 'done', 30)
        t = track(); chosen = late()
        work = (wait_state(page, lambda s: True, 5).get('work') or {})
        pairs = sorted([c['candidate_source'].rsplit('/', 1)[1], c['candidate_candidate'].rsplit('/', 1)[1]] for c in work.get('candidates') or [])
        # In the review: Windermere's town before its lake (a lake for a village is ranked down, and says so).
        at = goto_place('Windermere')
        cands = page.evaluate("""() => [...document.querySelectorAll('#review-place li.candidate')].map((li) => ({ iri: li.querySelector('.iri')?.textContent || '',
          kind: li.querySelector('.kind-why')?.textContent || null }))""")
        r['matched'] = True
        order = [c['iri'].rsplit('/', 1)[1] for c in cands]
        return (s.get('phase') in ('reviewing', 'done') and t['steps'].get('check-other') == 'current' and chosen == ['The other dataset: match-other.json.']
                and pairs == [['neuton', 'newton'], ['newton', 'newton'], ['windermere', 'windermere'], ['windermere', 'windermere-lake']]
                and at and order == ['windermere', 'windermere-lake'] and cands[0]['kind'] is None and (cands[1]['kind'] or '').startswith('Ranked down: lake, where yours is village')), \
            {'phase': s.get('phase'), 'late': chosen, 'pairs': pairs, 'Windermere': cands, 'steps': t['steps']}
    attempt('Match two datasets: matched in Krisis with the other dataset, chosen there and named in the tracker; Kingsbury, which the other already links, not suggested; the lake ranked after the town of Windermere, and marked', match_step)

    def refuse_other():
        need('matched')
        click('#methodos-back'); step_is('match', 'current', 15)
        forget = page.evaluate("() => { const b = document.querySelector('#methodos-late button.methodos-forget'); return b && !b.closest('[hidden]') ? b.textContent : null; }")
        matched(B2)
        soon(page, "() => /This run is not counted as the step/.test(document.getElementById('methodos-message').textContent)", 20)
        refused = track()
        matched(B)
        step_is('match', 'done', 30)
        again = track()
        return (forget == 'Forget match-other.json' and refused['steps'].get('match') == 'current'
                and 'match-other-2.json is not match-other.json, the other dataset this workflow recorded' in refused['message'] and late() == ['The other dataset: match-other.json.']
                and again['steps'].get('check-other') == 'current'), {'forget': forget, 'refused': refused['message'][:300], 'steps then': refused['steps'], 'steps after': again['steps']}
    attempt('Match two datasets: back at the match, a match with another file than the other dataset recorded is not counted, and said so (a way to forget it shown); with the same file again it is', refuse_other)

    def check_other():
        need('matched')
        # Another file checked at this step is not the step's, and the words say to choose the recorded one in step 1 (not to match).
        choose([B2]); run('#check')
        soon(page, "() => /This run is not counted as the step/.test(document.getElementById('methodos-message').textContent)", 15)
        wrong = track()
        t0 = track()
        click('#methodos-use')
        wait_state(page, lambda s: s.get('phase') == 'detected' and [f['name'] for f in s.get('files') or []] == ['match-other.json'], T(30), 'the other chosen')
        s = run('#check')
        step_is('check-other', 'done', 30)
        row = page.evaluate("() => document.querySelector('#methodos-track li[data-step=\"check-other\"] .track-findings')?.textContent || null")
        t = track()
        r['checked other'] = True
        return (wrong['steps'].get('check-other') == 'current' and 'match-other-2.json is not match-other.json' in wrong['message']
                and 'Choose match-other.json in step 1, as it was, and run it again.' in wrong['message'] and 'Match with' not in wrong['message']
                and t0['use'] == 'Use match-other.json' and (s.get('report') or {}).get('errors') == 1 and t['steps'].get('review') == 'current'
                and (row or '').startswith('Done, with a report:') and 'timespans must be array' in row and row.endswith('(1 problem). This does not stop the workflow.')), \
            {'another file': wrong['message'][:300], 'use': t0['use'], 'errors': (s.get('report') or {}).get('errors'), 'row': row, 'steps': t['steps']}
    attempt('Match two datasets: another file checked at that step is not counted, and the words say to choose the other dataset recorded; chosen again from the tracker, it is checked: its problem shown with the step, done with a report, and the workflow goes on to the review', check_other)

    def other_review():
        need('checked other')
        # Krisis run again at the review, with another file as the other dataset: its review is open, and is not the step's.
        choose([r['converted']])
        matched(B2)
        click('#methodos-done')
        soon(page, "() => /made with match-other-2\\.json as the other dataset, not match-other\\.json/.test(document.getElementById('methodos-message').textContent)", 15)
        t = track()
        offer = page.evaluate("() => { const b = document.getElementById('methodos-open-review'); return b && !b.hidden ? b.textContent : null; }")
        r['other review'] = True
        return (t['steps'].get('review') == 'current' and 'Open the review the match made' in t['message'] and offer == 'Open the review (match-mine.krisis.json)'), \
            {'message': t['message'][:400], 'offer': offer, 'steps': t['steps']}
    attempt('Match two datasets: at the review, a review Krisis made again with another file as the other dataset is not taken as the step\'s, and said so, with the match\'s own review offered', other_review)

    def review_and_resume():
        need('checked other')
        offer = page.evaluate("() => { const b = document.getElementById('methodos-open-review'); return b && !b.hidden ? b.textContent : null; }")
        r['review before'], r['review opened'] = open_review('match-other.json')
        goto_place('Newton')
        newton = page.evaluate("() => document.querySelector('#review-place li.candidate')?.dataset.id")
        click(f'#review-place li.candidate[data-id="{newton}"] button[data-act="match"]')
        wait_state(page, lambda s: any((c.get('decision') or {}).get('kind') == 'match' for c in (s.get('work') or {}).get('candidates', [])), T(10), 'decided')
        page.select_option('#review-filter', 'all')
        goto_place('Neuton')
        twice = page.evaluate("() => document.querySelector('#review-place li.candidate .accepted-for')?.textContent || null")
        goto_place('Windermere')
        town = page.evaluate("() => document.querySelector('#review-place li.candidate')?.dataset.id")
        click(f'#review-place li.candidate[data-id="{town}"] button[data-act="match"]')
        wait_state(page, lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match') == 2, T(10), 'decided')
        with page.expect_download(timeout=T(30) * 1000) as d: click('#save-review')
        r['review file'] = out / d.value.suggested_filename; d.value.save_as(r['review file'])
        # Reloaded mid-review: the workflow is taken up at the review; the review saved is resumed on the dataset, its decisions with it.
        page.reload()
        wait_state(page, lambda s: s.get('phase') in ('ready', 'detected'), T(30), 'ready')
        until(page, "() => document.querySelector('#methodos-track li[data-step=\"review\"]')?.dataset.state === 'current'", 30)
        back = track(); still = late()
        choose([r['converted']])
        page.set_input_files('#workfile', [str(r['review file'])])
        until(page, "() => !document.getElementById('review').hidden", 30)
        n = wait_state(page, lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match') == 2, T(15), 'resumed')
        click('#methodos-done'); step_is('review', 'done', 15)
        r['reviewed'] = True
        return (offer == f'Open the review (match-mine.krisis.json)' and twice == 'Already accepted for Newton.' and back['steps'].get('review') == 'current'
                and still == ['The other dataset: match-other.json.'] and track()['steps'].get('apply') == 'current'
                # The review shown before the click was Krisis's other match, and the one opened is the match's own, on your dataset.
                and (r['review before'] or {}).get('others') == ['match-other-2.json'] and r['review opened'] == {'subjects': ['match-mine.json'], 'others': ['match-other.json']}), \
            {'review before': r['review before'], 'review opened': r['review opened'], 'offer': offer, 'Neuton': twice, 'after the reload': back['steps'], 'late': still, 'steps': track()['steps']}
    attempt('Match two datasets: the review opened again from the tracker after the check, a place of the other dataset accepted twice said so (never refused), saved, the page reloaded and the review resumed, and the step done', review_and_resume)

    def record():
        need('reviewed')
        page.check('input[name="review-output"][value="attestations"]')
        run('#finish')
        soon(page, "() => /This run is not counted as the step/.test(document.getElementById('methodos-message').textContent)", 20)
        refused = track()
        page.check('input[name="review-output"][value="dataset"]')
        s = run('#finish'); step_is('apply', 'done', 30)
        r['applied'] = saved(s, '.krisis-dataset.json')
        return (refused['steps'].get('apply') == 'current' and 'this workflow adds the decisions to your dataset' in refused['message']
                and track()['steps'].get('again') == 'current'), {'refused': refused['message'][:300], 'steps': track()['steps']}
    attempt('Match two datasets: a Finish of the attestations alone is not counted (the workflow adds them to the dataset), and said so; the Finish into the dataset is the step', record)

    def to_the_end():
        need('applied', 'converted')
        choose([r['applied']])
        r['again'] = run('#check').get('phase'); step_is('again', 'done')
        page.set_input_files('#earlier', [str(r['converted'])])
        s = wait_state(page, lambda s: s.get('action') == 'compare' and s.get('phase') in ('done', 'error'), T(120), 'compare')
        counts = (s.get('report') or {}).get('counts') or {}
        step_is('compare', 'done')
        until(page, "() => !document.getElementById('methodos-download').hidden", 30)
        with page.expect_download(timeout=T(30) * 1000) as d: click('#methodos-download')
        r['final'] = out / ('final-' + d.value.suggested_filename); d.value.save_as(r['final'])
        step_is('out', 'done', 15)
        doc = json.loads(r['final'].read_text()); r['doc'] = doc
        ids = sorted([i['subject'].rsplit('/', 1)[1], i['object'].rsplit('/', 1)[1]] for e in doc['spatialEntities'] for a in e.get('attestations') or [] for i in a.get('identities') or [])
        r['ids'] = ids
        return (r['again'] == 'done' and [counts.get(k) for k in ('changed', 'lost', 'added')] == [0, 0, 2] and ids == [['newton', 'newton'], ['windermere', 'windermere']]
                and all(v.startswith('done') for v in track()['steps'].values())), {'again': r['again'], 'compare': counts, 'identities': ids, 'steps': track()['steps']}
    attempt('Match two datasets: checked again, compared with the dataset made from the table (only added to: two answers), and downloaded as it is, every step done; Newton and Windermere (the town) identified with the other dataset\'s', to_the_end)

    def can_fail():
        need('doc')
        stripped = [i for e in r['doc']['spatialEntities'] for a in e.get('attestations') or [] for i in {k: v for k, v in a.items() if k != 'identities'}.get('identities') or []]
        return bool(r['ids']) and stripped == [], {'as written': r['ids'], 'without identities': stripped}
    attempt('Match two datasets: the end check fails on the same file with its identities left out, as a step that skipped them would leave it (and passes as written)', can_fail)

    def only_here():
        need('final')
        other = sorted({re.match(r'^[a-z]+:(//[^/]*)?', u).group(0) for u in asked if not (u.startswith(origin + '/') or u.startswith('data:') or u.startswith('blob:'))})
        refused = [m for m in consoled if 'Refused to connect' in m]
        mine = [u for u in asked if u.startswith(origin + '/')]
        return (not other and not refused and not whg and len(mine) > 0), {'other sites': other, 'refused': refused[:3], 'to WHG': whg[:3], 'to this site': len(mine)}
    attempt('Match two datasets: every request the page made went to this site (the presence: it did), none to WHG or another site, nor any stopped by the policy', only_here)

    def leave():
        need('final')
        click('#methodos-leave')
        until(page, "() => document.getElementById('methodos-tracker').hidden", 15)
        page.reload()
        s = wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('keptOffer'), T(30), 'kept offer')
        return s.get('keptOffer') == ['match-mine.csv'], {'kept offer after Leave and a reload': s.get('keptOffer')}
    attempt('Match two datasets: left, the workflow hands the main page the table it began with alone, kept as its own choice (not the other dataset with it)', leave)

    def from_plato():
        # Your dataset already in a PLATO format (the one the table was made into above): checked and matched as it is.
        need('converted')
        page.goto(NOTOOLS if PROVE else base)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        # A workflow still followed (the one above, had it not finished) is left first.
        if page.evaluate("() => !document.getElementById('methodos-tracker').hidden"):
            click('#methodos-leave'); until(page, "() => document.getElementById('methodos-tracker').hidden", 15)
        click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="plato"]'); page.check('input[name="methodos-want"][value="match"]')
        asked_now = page.eval_on_selector_all('#mq-more fieldset[data-ask]', 'fs => fs.map((f) => f.dataset.ask)')
        page.check('input[name="methodos-ask-will-publish"][value="no"]')
        planned = page.eval_on_selector_all('#methodos-plan li.track-step', 'ls => ls.map((l) => l.dataset.step)')
        click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        choose([r['converted']])
        until(page, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        run('#check'); step_is('check-a', 'done')
        matched(B); step_is('match', 'done', 30)
        click('#methodos-use')
        wait_state(page, lambda s: s.get('phase') == 'detected' and [f['name'] for f in s.get('files') or []] == ['match-other.json'], T(30), 'the other chosen')
        run('#check'); step_is('check-other', 'done', 30)
        open_review('match-other.json')
        goto_place('Newton')
        newton = page.evaluate("() => document.querySelector('#review-place li.candidate')?.dataset.id")
        click(f'#review-place li.candidate[data-id="{newton}"] button[data-act="match"]')
        wait_state(page, lambda s: any((c.get('decision') or {}).get('kind') == 'match' for c in (s.get('work') or {}).get('candidates', [])), T(10), 'decided')
        click('#methodos-done'); step_is('review', 'done', 15)
        page.check('input[name="review-output"][value="dataset"]')
        s = run('#finish'); step_is('apply', 'done', 30)
        applied = saved(s, '.krisis-dataset.json')
        choose([applied]); run('#check'); step_is('again', 'done')
        page.set_input_files('#earlier', [str(r['converted'])])
        s = wait_state(page, lambda s: s.get('action') == 'compare' and s.get('phase') in ('done', 'error'), T(120), 'compare')
        counts = (s.get('report') or {}).get('counts') or {}
        step_is('compare', 'done')
        t = track()
        return (asked_now == ['into-dataset', 'will-publish'] and planned == ['check-a', 'match', 'check-other', 'review', 'apply', 'again', 'compare', 'out']
                and list(t['steps']) == planned and [counts.get(k) for k in ('changed', 'lost', 'added')] == [0, 0, 1] and t['steps'].get('out') == 'current'), \
            {'asked': asked_now, 'planned': planned, 'compare': counts, 'steps': t['steps']}
    attempt('Match two datasets from a dataset already in a PLATO format: the same two questions, no columns or conversion but a check of it, matched as it is, reviewed, recorded and compared with it (one answer added)', from_plato)
    try: ctx.close(); browser.close()
    except Exception: pass

# ---- The project file (plan #34, item A2; src/engine/methodos/project.js) ------------------------------------
# Map your data saved mid-review as a .platoproj in one browser, then opened in another with a fresh profile (a new
# context: no storage, no OPFS), refused first when tampered with, and carried on to the end with the same decisions.
# Against the same stub of WHG as Map your data. Each check is paired so that it can fail: the token absent from the
# project beside the user's data present in it; the tampered copy refused beside the same copy untouched opened; the
# fresh browser holding nothing beside the first holding the workflow's files; the question before replacing a
# workflow beside the workflow left as it was. PROJECT_SHOTS=<dir> saves screenshots at 1440 x 900.
def project_checks(pw, url, tmp):
    import re, zipfile
    base = url.rstrip('/') + '/'
    out = tmp / 'project'; out.mkdir(exist_ok=True)
    shots = os.environ.get('PROJECT_SHOTS')
    if shots: pathlib.Path(shots).mkdir(parents=True, exist_ok=True)
    def shot(page, name):
        if shots and not PROVE:
            try: page.screenshot(path=str(pathlib.Path(shots) / name))
            except Exception: pass
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    posts = []
    def stub(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        reply = lambda body, status=200: route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
        if req.method == 'GET': return reply({'detail': 'Not found'}, 404)
        body = json.loads(req.post_data or '{}'); posts.append(body)
        res = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in (body.get('queries') or {}).items():
            found = MYDATA_ANSWERS.get(q.get('query'), [])
            if q.get('area_only'): found = [c for c in found if c.get('has_geom')]
            res[k] = {'result': found, **({'scope': {'applied': True}} if isinstance(q.get('contained_in'), list) else {})}
        reply(res)
    def context(browser):
        ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        ctx.add_init_script('window.__plato_forceDownload = true;')
        ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub)
        return ctx
    browser = pw.chromium.launch(headless=True, args=GL)
    one, two = context(browser), context(browser)
    page = one.new_page()
    r = {}
    track = lambda p: p.evaluate(JOIN_STATE)
    def step_is(p, step, state, timeout=60):
        until(p, f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
    def choose(fs):
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(f) for f in fs])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
    def run(p, button, timeout=180):
        p.click(button)
        return wait_state(p, lambda s: s.get('phase') in ('done', 'error'), T(timeout), 'run')
    def need(*keys):
        missing = [k for k in keys if not r.get(k)]
        if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')
    W = lambda p: (wait_state(p, lambda s: True, 5).get('work') or {})
    decisions = lambda w: {c['id']: (c.get('decision') or {}).get('kind') for c in (w.get('candidates') or [])}

    def mid_review():
        # As Map your data begins: WHG allowed, the reviewer named, the interview answered, the table chosen.
        page.goto(NOTOOLS if PROVE else base)
        page.evaluate("() => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-10-04T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Remembered Reviewer' })); }")
        page.goto(NOTOOLS if PROVE else base)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        page.evaluate("() => { const b = document.getElementById('base'); b.value = %s; b.dispatchEvent(new Event('change')); }" % json.dumps(MYDATA_BASE))
        page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'yes'), ('will-draw', 'yes'), ('will-publish', 'no')): page.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        page.click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        choose([MYDATA_CSV])
        wait_state(page, lambda s: ((s.get('columns') or {}).get('levels') or {}), T(30), 'columns')
        page.click('#methodos-done'); step_is(page, 'columns', 'done', 15)
        run(page, '#check'); step_is(page, 'check', 'done')
        page.select_option('#target', 'plato-json')
        s = run(page, '#convert'); step_is(page, 'dataset', 'done')
        n = next(o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('.json'))
        r['converted'] = download(page, n, out / n)
        choose([r['converted']])
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        page.wait_for_function("() => !document.getElementById('regions-offer').hidden", timeout=T(60) * 1000)
        page.click('#regions-start')
        wait_state(page, lambda s: len(((s.get('work') or {}).get('regions') or {})) == 6, T(60), 'regions')
        for level in (1, 2):
            page.click(f'#regions-nav button[data-rlevel="{level}"]')
            k0 = len(posts)
            page.click('#regions-level button[data-rgo="level"]')
            wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(posts) > k0, T(60), f'level {level}')
            for k in [k for k, g in (W(page).get('regions') or {}).items() if g['level'] == level]:
                page.click(f'#regions-level article[data-rkey="{k}"] li.candidate button[data-ract="match"]')
                wait_state(page, lambda s: (((s.get('work') or {}).get('regions') or {}).get(k) or {}).get('outcome') == 'matched', T(10), 'settled')
        page.click('#methodos-done'); step_is(page, 'regions', 'done', 15)
        page.click('#regions-nav button[data-rlevel="places"]')
        page.click('#regions-level button[data-rgo="places"]')
        step_is(page, 'lookup', 'done', 90)
        until(page, "() => !document.getElementById('bulk-accept').disabled", 30)
        page.click('#bulk-accept')
        wait_state(page, lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match' and '/region-' not in c['candidate_source']) == 8, T(15), 'accepted')
        r['decisions'] = decisions(W(page))
        t = track(page)
        r['mid'] = t['steps'].get('review') == 'current' and sum(1 for v in r['decisions'].values() if v == 'match') == 14
        # Where Methodos keeps the workflow's files in this browser: the control for the fresh browser holding none.
        r['kept here'] = opfs_names(page, 'methodos-outputs')
        return r['mid'] and len(r['kept here']) >= 4, {'review': t['steps'].get('review'), 'matches': sum(1 for v in r['decisions'].values() if v == 'match'), 'kept': len(r['kept here'])}
    attempt('Project file: Map your data reaches the review mid-way (regions settled, places looked up, eight accepted in bulk, Wood Lane left), its files kept in this browser', mid_review)

    def save():
        need('mid')
        page.click('#methodos-project > summary')
        until(page, "() => document.getElementById('methodos-project').open && !!document.getElementById('methodos-project-what').textContent", 10)
        said = page.inner_text('#methodos-project-what'); own = page.inner_text('#methodos-project-own-words')
        shot(page, 'save-project.png')
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#methodos-save-project')
        r['project'] = out / d.value.suggested_filename; d.value.save_as(r['project'])
        until(page, "() => /^Saved .*\\.platoproj/.test(document.getElementById('methodos-message').textContent)", 15)
        r['saved said'] = track(page)['message']
        return (r['project'].name.endswith('.platoproj') and 'your own data' in said and 'parishes.csv' in said and 'the review open' in said
                and 'Never in it: your WHG token' in said and 'only where the review records who decided' in said and 'parishes.csv' in own and 'Saved' in r['saved said']), \
            {'file': r['project'].name, 'what': said[:300], 'own': own, 'said': r['saved said'][:200]}
    attempt('Project file: "Save the project" says beside it what goes in (the workflow, the user\'s file, the steps\' files, the review open) and what never does, and downloads a .platoproj', save)

    def contents():
        need('project')
        with zipfile.ZipFile(r['project']) as z:
            names = z.namelist()
            manifest = json.loads(z.read('manifest.json'))
            text = '\n'.join(z.read(n).decode('utf-8', 'replace') for n in names)
            record = z.read('workflow.json').decode() + z.read('manifest.json').decode()
            review = z.read('review.krisis.json').decode()
        roles = sorted(p['role'] for p in manifest['parts'])
        # The presence: the same search finds the user's data and the decisions; the absence: the token and the keys
        # of this browser's storage. The reviewer's name is in the review, which records who decided (as "Save the
        # review" saves it), and nowhere else: not in the workflow's record or the manifest.
        present = all(x in text for x in ('Mill Farm,Newton,Cheshire', '"kind": "match"', MYDATA_BASE)) and 'Remembered Reviewer' in review
        absent = [x for x in (LOOKUP_TOKEN, 'plato-tools.permissions', 'plato-tools.whg-token', 'plato-tools.reviewer') if x in text] + (['reviewer in the record'] if 'Remembered Reviewer' in record else [])
        # Read by the command line too: the browser's zip, checked by the Node reader.
        info = subprocess.run(['node', str(ROOT / 'bin/plato-tools.mjs'), 'project', 'info', str(r['project'])], capture_output=True, text=True)
        r['manifest'] = manifest
        return (names[0] == 'manifest.json' and manifest['format'] == 'plato-tools-project' and manifest['version'] == 1 and manifest['workflow']['at'] == 'review'
                and roles.count('record') == 1 and roles.count('review') == 1 and roles.count('file') >= 4 and any(p.get('own') for p in manifest['parts'])
                and present and not absent and info.returncode == 0 and 'Parts (each size and SHA-256 checked)' in info.stdout), \
            {'first': names[:2], 'roles': roles, 'at': manifest['workflow']['at'], 'present': present, 'absent': absent, 'info': (info.stdout or info.stderr)[:200]}
    attempt('Project file: the zip holds its manifest first, the record at the review, the review open, the user\'s own file and the steps\' files; the user\'s data is in it, the reviewer\'s name only in the review, and the WHG token and this browser\'s storage keys not at all; plato-tools project info reads it', contents)

    p2 = two.new_page()
    def fresh_and_tampered():
        need('project', 'manifest')
        p2.goto(NOTOOLS if PROVE else base)
        wait_state(p2, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        empty = {'tracker': track(p2)['shown'], 'kept': opfs_names(p2, 'methodos-outputs'), 'banner': p2.is_visible('#methodos-open-banner')}
        # One byte of the dataset's part changed, the manifest kept: re-zipped, the manifest first.
        bad = out / 'tampered.platoproj'
        dataset = next(p['path'] for p in r['manifest']['parts'] if p['role'] == 'file' and p['name'] == r['converted'].name)
        with zipfile.ZipFile(r['project']) as z, zipfile.ZipFile(bad, 'w', zipfile.ZIP_DEFLATED) as w:
            for n in z.namelist():
                b = bytearray(z.read(n))
                if n == dataset: b[10] ^= 1
                w.writestr(n, bytes(b))
        p2.set_input_files('#methodos-project-file', str(bad))
        until(p2, "() => !document.getElementById('methodos-project-said').hidden && /not opened/.test(document.getElementById('methodos-project-said').textContent)", 30)
        said = p2.inner_text('#methodos-project-said')
        shot(p2, 'tampered-refused.png')
        after = {'tracker': track(p2)['shown'], 'kept': opfs_names(p2, 'methodos-outputs')}
        r['refused'] = True
        return (empty['tracker'] is False and empty['kept'] == [] and empty['banner'] is True and len(r['kept here']) >= 4
                and 'is not the file its manifest names' in said and r['converted'].name in said and after['tracker'] is False and after['kept'] == []), \
            {'fresh': empty, 'said': said[:300], 'after': after}
    attempt('Project file: a fresh browser holds no workflow and no kept files (the first browser holds them); there, the project with one byte of the dataset changed is refused in words naming the file, and leaves nothing behind', fresh_and_tampered)

    def opened():
        need('refused')
        p2.set_input_files('#methodos-project-file', str(r['project']))
        until(p2, "() => !document.getElementById('methodos-tracker').hidden && document.querySelector('#methodos-track li[data-step=\"review\"]')?.dataset.state === 'current'", 60)
        until(p2, "() => /Opened the project/.test(document.getElementById('methodos-message').textContent)", 15)
        until(p2, "() => !document.getElementById('review').hidden", 60)
        wait_state(p2, lambda s: (s.get('work') or {}).get('candidates'), T(30), 'review open')
        t = track(p2); got = decisions(W(p2))
        base_now = p2.input_value('#base')
        kept = opfs_names(p2, 'methodos-outputs')
        shot(p2, 'project-opened.png')
        r['opened'] = got == r['decisions']
        return (r['opened'] and t['steps'].get('review') == 'current' and all(t['steps'].get(k) == 'done' for k in ('columns', 'check', 'dataset', 'regions', 'lookup'))
                and 'Opened the project' in t['message'] and base_now == MYDATA_BASE and len(kept) >= 4), \
            {'steps': t['steps'], 'message': t['message'][:240], 'same decisions': got == r['decisions'], 'decided': sum(1 for v in got.values() if v), 'base': base_now, 'kept': len(kept)}
    attempt('Project file: opened in the fresh browser, the workflow is at the review with the five steps before it done, the review open with the very decisions made before saving, the base address in Options from the workflow, and its files kept here', opened)

    def finish():
        need('opened')
        p2.evaluate("() => { const v = document.getElementById('reviewer'); v.value = 'Map Reviewer'; v.dispatchEvent(new Event('change')); }")
        p2.click('#methodos-done'); step_is(p2, 'review', 'done', 15)
        p2.check('input[name="review-output"][value="dataset"]')
        p2.click('#export-candidates')
        until(p2, "() => !!window.__plato.candidates && !!window.__plato.candidates.setIri", 15)
        s = run(p2, '#finish'); step_is(p2, 'relate', 'done', 30)
        n = next(o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('.krisis-dataset.json'))
        e = mydata_ends(json.loads(download(p2, n, out / n).read_text()))
        r['finished'] = True
        return (e['contained'] == 10 and e['region identities'] == 6 and e['regions promoted'] and e['places promoted'] == 8 and track(p2)['steps'].get('place') == 'current'), \
            {'ends': e, 'steps': track(p2)['steps']}
    attempt('Project file: carried on in the fresh browser, the review done and the decisions recorded give every place ContainedIn its parish, the six regions\' identities and the eight places accepted before saving, and the workflow goes on to Chora\'s step', finish)

    def replace_asked():
        need('finished')
        before = track(p2)['steps']
        p2.set_input_files('#methodos-project-file', [])   # as "Open a project" clears it: the same file chosen again is a change
        p2.set_input_files('#methodos-project-file', str(r['project']))
        until(p2, "() => !document.getElementById('methodos-replace').hidden", 15)
        words = p2.inner_text('#methodos-replace-words'); focus = p2.evaluate('() => document.activeElement?.id')
        shot(p2, 'replace-asked.png')
        p2.click('#methodos-replace-no')
        until(p2, "() => document.getElementById('methodos-replace').hidden", 10)
        after = track(p2)
        return ('is open. Open' in words and focus == 'methodos-replace-no' and after['steps'] == before and before.get('place') == 'current' and 'was not opened' in after['message']), \
            {'words': words[:200], 'focus': focus, 'steps after': after['steps'], 'message': after['message'][:160]}
    attempt('Project file: choosing a project while a workflow is open asks first (the safe answer focused); "Keep this workflow" leaves it exactly as it was', replace_asked)

    # A workbook as the user's own file: a zip inside the project's zip, whose bytes hold PK\x03\x04 (a reader that
    # scanned for signatures refused every such project). Begun with it, saved, and opened in another fresh profile.
    three = context(browser)
    def workbook():
        import hashlib
        xlsx = out / 'parishes.xlsx'
        subprocess.run(['node', '--input-type=module', '-e', "import * as XLSX from 'xlsx'; import { readFileSync, writeFileSync } from 'node:fs'; "
                        "const wb = XLSX.read(readFileSync(process.argv[1], 'utf8'), { type: 'string' }); writeFileSync(process.argv[2], XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));", str(MYDATA_CSV), str(xlsx)],
                       cwd=ROOT, check=True, capture_output=True)
        raw = xlsx.read_bytes(); sha = hashlib.sha256(raw).hexdigest()
        p3 = three.new_page()
        p3.goto(NOTOOLS if PROVE else base)
        wait_state(p3, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        p3.click('#methodos-ask'); until(p3, "!document.getElementById('methodos').hidden", 5)
        p3.check('input[name="methodos-have"][value="table"]'); p3.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'no'), ('will-draw', 'no'), ('will-publish', 'no')): p3.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        p3.click('#methodos-start'); until(p3, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        p3.set_input_files('#picker', [str(xlsx)])
        wait_state(p3, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        until(p3, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        p3.click('#methodos-project > summary')
        with p3.expect_download(timeout=T(60) * 1000) as d: p3.click('#methodos-save-project')
        saved = out / ('workbook-' + d.value.suggested_filename); d.value.save_as(saved)
        with zipfile.ZipFile(saved) as z:
            own = z.read(f'files/{sha}') if f'files/{sha}' in z.namelist() else b''
        p4 = context(browser).new_page()   # another fresh profile
        p4.goto(NOTOOLS if PROVE else base)
        wait_state(p4, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        p4.set_input_files('#methodos-project-file', str(saved))
        until(p4, "() => /Opened the project/.test(document.getElementById('methodos-message').textContent)", 60)
        s = wait_state(p4, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'chosen again')
        chosen = p4.evaluate("() => [...document.querySelectorAll('#chosen .name')].map((e) => e.textContent)")
        kept = opfs_names(p4, 'methodos-outputs')
        t = track(p4)
        shot(p4, 'workbook-opened.png')
        p4.context.close()
        return (own == raw and raw[:4] == b'PK\x03\x04' and raw.count(b'PK\x03\x04') > 1 and t['steps'].get('columns') == 'current'
                and chosen == ['parishes.xlsx'] and s.get('phase') == 'detected' and sha in kept), \
            {'in the project whole': own == raw, 'signatures in it': raw.count(b'PK\x03\x04'), 'steps': t['steps'], 'chosen': chosen, 'phase': s.get('phase'), 'kept': sha in kept, 'message': t['message'][:200]}
    attempt('Project file: a workflow begun with a workbook (.xlsx, itself a zip) is saved with the workbook whole in it, and opened in a fresh profile at the columns step with the workbook kept and chosen again', workbook)
    try: browser.close()
    except Exception: pass

# ---- The project in WHG's Workbench (plan #34, item A1; src/methodos/whg.js, src/engine/workbench.js) ------------------
# Against the fake of WHG (test/workbench-fake.js, which copies WHG's own code: CORS for an allow-list, the token in the
# Authorization header only, its budget, its beta, its 2 MiB cap, an opaque 409, sharing), run as a server and reached
# through Playwright's routing: never the real WHG. Each check reads what the fake RECEIVED and holds, never only what
# the page says. Each absence beside its presence: nothing sent without a token (beside what is sent once it is given),
# the token in no address (beside the token in every request's header), no share token kept (beside the origin kept).
# A1_SHOTS=<dir> saves screenshots of the panel and of the read-only view, at 1440 x 900 and 600 px, light and dark.
WHG_E2E_TOKEN = 'e2e-SECRET-workbench-token-5b2d91'
WHG_E2E_OTHER = 'e2e-SECRET-not-enrolled-token-77a1'
WHG_LINKS_JS = '''async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('plato-tools-methodos-links', 1); r.onupgradeneeded = () => r.result.createObjectStore('workflows'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try { return await new Promise((res) => { const t = db.transaction('workflows'), s = t.objectStore('workflows'), out = {}; const q = s.openCursor(); q.onsuccess = () => { const c = q.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; }); } finally { db.close(); } }'''
WHG_STORAGE_JS = '''async () => { const all = []; for (const name of ['plato-tools-methodos', 'plato-tools-methodos-links']) { const db = await new Promise((res) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('workflows'); r.onsuccess = () => res(r.result); });
  try { all.push(JSON.stringify(await new Promise((res) => { const q = db.transaction('workflows').objectStore('workflows').getAll(); q.onsuccess = () => res(q.result); }))); } finally { db.close(); } }
  const own = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'plato-tools.whg-token'));   // the token's one keeper holds it, by design
  return all.join('\\n') + '\\n' + JSON.stringify(own({ ...localStorage })) + '\\n' + JSON.stringify(own({ ...sessionStorage })); }'''
WHG_VIEW = '''() => { const v = (e) => !!e && !e.hidden && !e.closest('[hidden]') && !!e.getClientRects().length, $ = (id) => document.getElementById(id), t = (id) => $(id)?.textContent || '';
  return { status: $('methodos-tracker').dataset.status || null, tracker: v($('methodos-tracker')), state: t('whg-state'), said: v($('whg-said')) ? t('whg-said') : '', leaves: v($('whg-leaves')) ? t('whg-leaves') : '',
    needs: v($('whg-needs')) ? t('whg-needs') : '', token: v($('whgp-token-box')), focus: document.activeElement?.id || '', choice: v($('whg-choice')) ? t('whg-choice-words') : '',
    choices: [...document.querySelectorAll('#whg-choice button')].filter(v).map((b) => b.textContent), link: v($('whg-link')) ? $('whg-link-url').value : '', linkWords: t('whg-link-words'),
    message: t('methodos-message'), projectSaid: v($('methodos-project-said')) ? t('methodos-project-said') : '', unshare: v($('whg-unshare')),
    shared: v($('methodos-shared')) ? t('methodos-shared-words') : '', sharedButtons: [...document.querySelectorAll('#methodos-shared button')].filter(v).map((b) => b.textContent),
    buttons: [...document.querySelectorAll('#methodos-tracker .methodos-buttons button, #methodos-tracker a.button')].filter((b) => v(b) && !b.closest('#methodos-shared')).map((b) => b.textContent),
    project: v($('methodos-project')), ask: v($('whg-shared-ask')) ? t('whg-shared-ask') : '', list: v($('whg-projects')) ? [...document.querySelectorAll('#whg-projects-list li')].map((li) => li.textContent) : null,
    listSaid: t('whg-projects-said'), hash: location.hash, href: location.href, replace: v($('methodos-replace')) ? t('methodos-replace-words') : '' }; }'''

def whg_checks(pw, url, tmp):
    import base64, io, re, zipfile, urllib.request, urllib.error, urllib.parse
    base = url.rstrip('/') + '/'
    origin = re.match(r'^(https?://[^/]+)', base).group(1)
    shots = os.environ.get('A1_SHOTS')
    if shots: pathlib.Path(shots).mkdir(parents=True, exist_ok=True)
    out = tmp / 'whg'; out.mkdir(exist_ok=True)
    port = free_port()
    srv = subprocess.Popen(['node', str(ROOT / 'test/workbench-fake.js'), 'serve', '--port', str(port), '--origin', origin], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    srv.stdout.readline()   # "listening <port>"
    FAKE = f'http://127.0.0.1:{port}'
    def fake(what, body=None):
        req = urllib.request.Request(f'{FAKE}/__fake/{what}', data=json.dumps(body or {}).encode(), method='POST', headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as r: return json.loads(r.read())
    def forward(route):
        req = route.request
        u = urllib.parse.urlsplit(req.url)
        if not u.path.startswith('/reconciliation/'): return route.fulfill(status=404, body='not the Workbench')
        heads = {k: v for k, v in req.all_headers().items() if not k.startswith(':') and k.lower() not in ('host', 'content-length', 'accept-encoding', 'connection')}
        fr = urllib.request.Request(FAKE + u.path + (('?' + u.query) if u.query else ''), data=req.post_data_buffer, method=req.method, headers=heads)
        try:
            with urllib.request.urlopen(fr, timeout=20) as r: status, rh, body = r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e: status, rh, body = e.code, dict(e.headers), e.read()
        answered.append({'method': req.method, 'status': status, 'headers': {k.lower(): v for k, v in rh.items()}, 'origin': req.headers.get('origin')})
        route.fulfill(status=status, headers={k: v for k, v in rh.items() if k.lower() not in ('content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date')}, body=body)
    answered = []   # every answer the fake gave a page, with its headers (CORS)
    fake('user', {'token': WHG_E2E_TOKEN, 'name': 'e2e'})
    fake('user', {'token': WHG_E2E_OTHER, 'beta': False})
    browser = pw.chromium.launch(headless=True)
    seen = []   # every address any page of these checks asked, for the token in none of them
    dialogs = []
    def context(grant=True, token=None, viewport=None, scheme='light'):
        ctx = browser.new_context(accept_downloads=True, viewport=viewport or {'width': 1440, 'height': 900}, reduced_motion='reduce', color_scheme=scheme)
        ctx.add_init_script('window.__plato_forceDownload = true;')
        ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), forward)
        ctx.on('request', lambda r: seen.append(r.url))
        ctx.on('page', lambda p: p.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss())))
        p = ctx.new_page()
        p.goto(NOTOOLS if PROVE else base)
        js = []
        if grant: js.append("localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'collaborate:whg': { state: 'allowed', at: '2026-10-14T10:00:00Z' } } }));")
        if token: js.append(f"sessionStorage.setItem('plato-tools.whg-token', {json.dumps(token)});")
        if js: p.evaluate('() => { ' + ' '.join(js) + ' }')
        p.goto(NOTOOLS if PROVE else base)
        wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        return p
    view = lambda p: p.evaluate(WHG_VIEW)
    def shot(p, name):
        if shots and not PROVE:
            try: p.mouse.move(1, 1); p.screenshot(path=str(pathlib.Path(shots) / name), full_page=False)   # no tooltip left where a click was
            except Exception: pass
    def begin(p, csv=MYDATA_CSV):
        """Table to map, no regions, no drawing, no publishing: begun with the table, at its columns step (a step boundary)."""
        p.click('#methodos-ask'); until(p, "!document.getElementById('methodos').hidden", 5)
        p.check('input[name="methodos-have"][value="table"]'); p.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'no'), ('will-draw', 'no'), ('will-publish', 'no')): p.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        p.click('#methodos-start'); until(p, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        p.set_input_files('#picker', [str(csv)])
        wait_state(p, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        until(p, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
    def panel(p):
        if not p.evaluate("() => document.getElementById('methodos-project').open"): p.click('#methodos-project > summary')
        until(p, "() => document.getElementById('methodos-project').open && !!document.getElementById('whg-state').textContent", 10)
    def log(clear=False): return fake('log', {'clear': clear})
    def projects(): return fake('projects')
    def unzip_snapshot(snap):
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(snap['project'])))
        return z, json.loads(z.read('manifest.json'))
    def said(p, js, timeout=20):
        try: until(p, js, timeout)
        except Exception as e:
            v = view(p)
            raise RuntimeError(f"{str(e)[:120]} | WHG part said: {v['said'][:200]!r} | message: {v['message'][:200]!r} | under the banner: {v['projectSaid'][:160]!r}")
    def saved(p, version, timeout=30):
        said(p, f"() => /^Saved to WHG.*\\(version {version},/.test(document.getElementById('whg-said').textContent)", timeout)
    def wid(p): return p.evaluate("async () => (await new Promise((res) => { const r = indexedDB.open('plato-tools-methodos', 1); r.onupgradeneeded = () => r.result.createObjectStore('workflows'); r.onsuccess = () => { const q = r.result.transaction('workflows').objectStore('workflows').getAllKeys(); q.onsuccess = () => { res(q.result.filter((k) => !String(k).startsWith('pending:'))); r.result.close(); }; }; }))")
    r = {}
    def need(*keys):
        missing = [k for k in keys if not r.get(k)]
        if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')

    a = None
    def no_token_then_token():
        nonlocal a
        log(clear=True)
        a = context(grant=True)
        begin(a)
        panel(a)
        before = view(a)
        shot(a, 'whg-panel-no-token-1440-light.png')
        a.click('#whg-save')
        until(a, "() => /Your WHG token is needed first/.test(document.getElementById('whg-said').textContent)", 10)
        none = view(a); sent_none = log()
        # The presence: the same button, the token typed in the section's own field, sends.
        a.fill('#whgp-token', WHG_E2E_TOKEN); a.press('#whgp-token', 'Enter')
        a.click('#whg-save')
        saved(a, 1)
        sent = log()
        after = view(a)
        r['a'] = True
        posts = [e for e in sent if e['method'] == 'POST' and e['path'] == '/reconciliation/projects/']
        return (before['token'] and before['needs'] == '' and none['focus'] == 'whgp-token' and 'Nothing was sent' in none['said'] and sent_none == []
                and len(posts) == 1 and all(e['headers'].get('authorization') == f'Bearer {WHG_E2E_TOKEN}' for e in sent) and all('cookie' not in e['headers'] for e in sent)
                and all(e['headers'].get('origin') == origin for e in sent) and 'as a new project in your workbench' in after['said']), \
            {'before': {k: before[k] for k in ('token', 'needs', 'state')}, 'no token': none['said'][:120], 'focus': none['focus'], 'sent without': len(sent_none), 'sent': [(e['method'], e['path'], e['status']) for e in sent], 'after': after['said'][:160]}
    attempt('WHG: with no token, "Save to WHG" sends nothing, says so and opens the section\'s token field; the token typed there, the same button creates the project in WHG, the token in the Authorization header of every request, no cookie, from the page\'s origin', no_token_then_token)

    def what_is_kept():
        need('a')
        [p] = [x for x in projects() if x['doc_type'] == 'plato']
        z, m = unzip_snapshot(p['snapshot'])
        links = a.evaluate(WHG_LINKS_JS)
        ids = wid(a)
        link = links.get(ids[0], {}) if ids else {}
        r['pid'] = p['id']; r['wid'] = ids[0] if ids else None
        own = [x for x in m['parts'] if x.get('own')]
        state = view(a)['state']
        stored = a.evaluate(WHG_STORAGE_JS)
        return p['title'] == 'parishes.csv' and p['version'] == 1 and m['workflow']['id'] == r['wid'] and m['minor'] == 1 and len(own) == 1 and own[0]['name'] == 'parishes.csv' \
            and set(p['snapshot']) == {'plato', 'format', 'workflow', 'formatVersion', 'project', 'size', 'sha256'} and p['snapshot']['workflow']['id'] == r['wid'] \
            and link.get('projectId') == p['id'] and link.get('version') == 1 and link.get('sha256') == p['snapshot']['sha256'] and WHG_E2E_TOKEN not in stored and p['id'] in stored \
            and 'Saved to WHG on' in state and 'as version 1' in state, \
            {'title': p['title'], 'version': p['version'], 'manifest': (m['workflow'], m['minor']), 'own': own, 'link': link, 'state': state}
    attempt('WHG: the project kept there is the workflow\'s project file in its envelope (format 1.1, the user\'s own file in it), titled as the workflow; the link beside the record holds its id, version and SHA-256 and no token; the panel says it is saved, as version 1', what_is_kept)

    def push_again():
        need('pid')
        log(clear=True)
        a.click('#whg-save'); saved(a, 2)
        sent = log()
        puts = [e for e in sent if e['method'] == 'PUT' and e['path'] == f"/reconciliation/projects/{r['pid']}/"]
        p = next(x for x in projects() if x['id'] == r['pid'])
        r['v2'] = p['version'] == 2
        # A PUT on the version WHG holds is the only one it takes (a stale one is a 409: the next check): 200 is the proof of base_version 1.
        return (len(puts) == 1 and not [e for e in sent if e['method'] == 'POST'] and puts[0]['status'] == 200
                and p['version'] == 2 and len(projects()) == 1 and 'as version 2' in view(a)['state']), {'sent': [(e['method'], e['path'], e['status']) for e in sent], 'version': p['version'], 'state': view(a)['state'][:120]}
    attempt('WHG: saved again, it is an update of the same project on the version last saved (PUT, base_version 1), now version 2; no second project', push_again)

    def conflict_then_new():
        need('v2')
        p = next(x for x in projects() if x['id'] == r['pid'])
        fake('push', {'id': r['pid'], 'snapshot': p['snapshot']})   # another browser's save: version 3
        log(clear=True)
        a.click('#whg-save')
        until(a, "() => !document.getElementById('whg-choice').hidden", 20)
        v = view(a); shot(a, 'whg-conflict-1440-light.png')
        held = next(x for x in projects() if x['id'] == r['pid'])
        a.click('#whg-choice button[data-choice="1"]')   # Save mine as a new WHG project
        saved(a, 1)
        after = projects()
        links = a.evaluate(WHG_LINKS_JS)
        new = [x for x in after if x['id'] != r['pid']]
        r['second'] = new[0]['id'] if new else None
        return ('newer save of this workflow (version 3)' in v['choice'] and v['choices'] == ['Open the copy on WHG', 'Save mine as a new WHG project'] and not any('overwrite' in c.lower() or 'replace' in c.lower() for c in v['choices'])
                and held['version'] == 3 and [e['status'] for e in log() if e['method'] == 'PUT'][:1] == [409] and len(after) == 2 and links.get(r['wid'], {}).get('projectId') == r['second']), \
            {'choice': v['choice'][:200], 'choices': v['choices'], 'held': held['version'], 'projects': len(after), 'link': links.get(r['wid'])}
    attempt('WHG: a newer save in WHG (another browser\'s) is never saved over: the page offers "Open the copy on WHG" or "Save mine as a new WHG project", no overwrite; WHG still holds version 3; saved as new, there are two, and the workflow is linked to the new one', conflict_then_new)

    def open_the_copy():
        need('second')
        p = next(x for x in projects() if x['id'] == r['second'])
        fake('push', {'id': r['second'], 'snapshot': p['snapshot']})   # version 2 there, from elsewhere
        a.click('#whg-save')
        until(a, "() => !document.getElementById('whg-choice').hidden", 20)
        a.click('#whg-choice button[data-choice="0"]')   # Open the copy on WHG
        until(a, "() => !document.getElementById('methodos-replace').hidden", 15)
        asked = view(a)
        a.click('#methodos-replace-yes')
        until(a, "() => /from WHG \\(version 2\\)/.test(document.getElementById('methodos-message').textContent)", 30)
        links = a.evaluate(WHG_LINKS_JS)
        ids = wid(a)
        return ("WHG's copy (version 2)" in asked['replace'] and ids == [r['wid']] and links.get(r['wid'], {}).get('version') == 2 and links.get(r['wid'], {}).get('projectId') == r['second']
                and view(a)['status'] == 'idle'), {'asked': asked['replace'][:160], 'ids': ids, 'link': links.get(r['wid']), 'message': view(a)['message'][:200]}
    attempt('WHG: "Open the copy on WHG" asks first (the workflow open would be let go), then opens WHG\'s newer save in its place, linked at its version', open_the_copy)

    b = None
    def fresh_browser_open_and_delete():
        nonlocal b
        need('second')
        b = context(grant=True, token=WHG_E2E_TOKEN)
        empty = {'banner': b.is_visible('#whg-open-banner'), 'ids': wid(b)}
        b.click('#whg-open-banner')
        until(b, "() => document.querySelectorAll('#whg-projects-list li').length === 2", 20)
        listed = view(b)
        shot(b, 'whg-list-1440-light.png')
        # Delete, asked in the page (no browser dialogue); "Keep it" keeps it.
        b.click(f'#whg-projects-list li[data-project="{r["pid"]}"] .whg-delete')
        until(b, "() => !!document.querySelector('#whg-projects-list .whg-confirm')", 5)
        focus = b.evaluate("() => document.activeElement?.className")
        b.click('#whg-projects-list .whg-delete-no')
        kept = len(projects())
        b.click(f'#whg-projects-list li[data-project="{r["pid"]}"] .whg-delete')
        b.click('#whg-projects-list .whg-delete-yes')
        until(b, "() => /^Deleted/.test(document.getElementById('whg-projects-said').textContent)", 15)
        gone = [x['id'] for x in projects()]
        b.click(f'#whg-projects-list li[data-project="{r["second"]}"] .whg-open-one')
        until(b, "() => /from WHG \\(version 2\\)/.test(document.getElementById('methodos-message').textContent)", 30)
        opened = view(b)
        links = b.evaluate(WHG_LINKS_JS)
        r['b'] = True
        return (empty['banner'] and empty['ids'] == [] and len(listed['list']) == 2 and all('Yours' in x for x in listed['list']) and focus == 'whg-delete-no' and kept == 2
                and gone == [r['second']] and dialogs == [] and opened['status'] == 'idle' and wid(b) == [r['wid']] and links.get(r['wid'], {}).get('projectId') == r['second']), \
            {'empty': empty, 'list': listed['list'], 'focus': focus, 'kept': kept, 'after delete': gone, 'dialogs': dialogs, 'opened': opened['message'][:160], 'link': links.get(r['wid'])}
    attempt('WHG: in a fresh browser, "one kept in WHG" lists the projects there (title, role, when saved); Delete asks in the page, "Keep it" focused, keeps it, then deletes it; another opens as the same workflow, linked at its version', fresh_browser_open_and_delete)

    def list_without_token():
        need('second')
        # No workflow open, no token: "one kept in WHG" asks for the token where the list is (no tracker is shown), and sends nothing;
        # the token given there, the same link lists the projects.
        n = context(grant=True)
        log(clear=True)
        n.click('#whg-open-banner')
        until(n, "() => /Your WHG token is needed first/.test(document.getElementById('whg-projects-said').textContent)", 15)
        asked = n.evaluate('''() => { const b = document.getElementById('whgp-token-box'); return { inList: !!b.closest('#whg-projects'), shown: !b.hidden && !!b.getClientRects().length,
          focus: document.activeElement?.id, tracker: !document.getElementById('methodos-tracker').hidden }; }''')
        sent = log()
        n.fill('#whgp-token', WHG_E2E_TOKEN); n.press('#whgp-token', 'Enter')
        n.click('#whg-open-banner')
        until(n, "() => document.querySelectorAll('#whg-projects-list li').length >= 1", 20)
        listed = len(n.evaluate("() => [...document.querySelectorAll('#whg-projects-list li')]"))
        after = [(e['method'], e['path']) for e in log()]
        n.context.close()
        return (asked == {'inList': True, 'shown': True, 'focus': 'whgp-token', 'tracker': False} and sent == [] and listed >= 1 and ('GET', '/reconciliation/projects/?doc_type=plato') in after), \
            {'asked': asked, 'sent before': len(sent), 'listed': listed, 'after': after}
    attempt('WHG: with no workflow open and no token, "one kept in WHG" shows the token field beside the list, focused, and sends nothing; the token given there, it lists the projects', list_without_token)

    def matched():
        need('b', 'second')
        # The workflow as a project file from the first browser, opened in a third: no link there, but WHG holds it.
        panel(a)
        with a.expect_download(timeout=T(60) * 1000) as d: a.click('#methodos-save-project')
        f = out / d.value.suggested_filename; d.value.save_as(f)
        c = context(grant=True, token=WHG_E2E_TOKEN)
        c.set_input_files('#methodos-project-file', str(f))
        until(c, "() => /Opened the project/.test(document.getElementById('methodos-message').textContent)", 30)
        panel(c)
        before = c.evaluate(WHG_LINKS_JS)
        fake('share', {'id': r['second']})   # shared already, from the first browser: the link made here must say so
        n = len(projects()); log(clear=True)
        c.click('#whg-save')
        until(c, "() => !document.getElementById('whg-choice').hidden", 20)
        v = view(c)
        c.click('#whg-choice button[data-choice="0"]')   # Save to it
        until(c, "() => /^Saved to WHG \\(version 3,/.test(document.getElementById('whg-said').textContent)", 20)
        sent = [(e['method'], e['path']) for e in log()]
        linked = c.evaluate(WHG_LINKS_JS).get(r['wid'], {})
        shared_now = view(c)
        c.context.close()
        return (before == {} and 'hold this workflow already' in v['choice'] and v['choices'] == ['Save to it', 'Save as a new WHG project'] and len(projects()) == n
                and ('PUT', f"/reconciliation/projects/{r['second']}/") in sent and not [s for s in sent if s[0] == 'POST']
                and linked.get('shared') is True and shared_now['unshare'] and 'Shared: anyone with its link can read it' in shared_now['state']), \
            {'before': before, 'choice': v['choice'][:160], 'sent': sent, 'link': linked, 'unshare': shared_now['unshare'], 'state': shared_now['state'][:160]}
    attempt('WHG: a workflow with no link here that WHG already holds (opened from its file in a third browser) is offered "Save to it" or as new; "Save to it" updates that project, no second one, and, it being shared, says so and offers "Stop sharing"', matched)

    def share_and_stop():
        need('a', 'second')
        panel(a)
        log(clear=True)
        a.click('#whg-share')
        until(a, "() => !document.getElementById('whg-link').hidden", 20)
        v = view(a)
        held = next(x for x in projects() if x['id'] == r['second'])
        shot(a, 'whg-shared-1440-light.png')
        for w, h, scheme, name in ((600, 900, 'light', 'whg-shared-600-light.png'), (600, 900, 'dark', 'whg-shared-600-dark.png'), (1440, 900, 'dark', 'whg-shared-1440-dark.png')):
            if shots and not PROVE:
                a.set_viewport_size({'width': w, 'height': h}); a.emulate_media(color_scheme=scheme)
                if w < 960 and not a.evaluate("() => document.getElementById('methodos-tracker').classList.contains('open')"): a.click('#methodos-strip')
                a.evaluate("() => document.getElementById('whg-link').scrollIntoView({ block: 'center' })")
                shot(a, name)
                if w < 960: a.click('#methodos-strip')
        a.set_viewport_size({'width': 1440, 'height': 900}); a.emulate_media(color_scheme='light')
        token = held.get('token') or ''
        r['token'] = token
        ok_link = v['link'] == f"{base}#whg-shared={token}" and len(token) == 36
        a.click('#whg-unshare')
        until(a, "() => /Sharing stopped/.test(document.getElementById('whg-said').textContent)", 15)
        stopped = next(x for x in projects() if x['id'] == r['second'])
        a.click('#whg-share'); until(a, "() => !document.getElementById('whg-link').hidden", 20)
        again = next(x for x in projects() if x['id'] == r['second'])
        r['token'] = again.get('token')
        r['shared'] = True
        return (ok_link and 'Anyone with this link can read' in v['linkWords'] and "reviewer’s name" in v['linkWords'] and 'newest save' in v['linkWords'] and v['unshare']
                and stopped['token'] is None and again['token'] and again['token'] != token and view(a)['link'].endswith(again['token'])), \
            {'link': v['link'], 'token': token, 'words': v['linkWords'][:200], 'stopped': stopped['token'], 'again': again['token']}
    attempt('WHG: "Share a read-only link" gives the page\'s own address with #whg-shared=<the token WHG minted>, and says who can read what (the reviewer\'s name, the newest save); "Stop sharing" withdraws it in WHG; shared again, a new token', share_and_stop)

    rc = None
    def recipient_asked():
        nonlocal rc
        need('shared')
        log(clear=True)
        ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), forward)
        ctx.on('request', lambda q: seen.append(q.url))
        rc = ctx.new_page()
        rc.goto(NOTOOLS if PROVE else f"{base}#whg-shared={r['token']}")
        until(rc, "() => !document.getElementById('whg-shared-ask').hidden", 20)
        v = view(rc)
        held = rc.evaluate("() => sessionStorage.getItem('plato-tools.whg-shared')")
        shot(rc, 'whg-recipient-asked-1440-light.png')
        asked = log()
        # Allowed (as the line's Permissions… would), and the page reloaded, as the line then offers: the token held across it.
        rc.evaluate("() => localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'collaborate:whg': { state: 'allowed', at: '2026-10-14T10:00:00Z' } } }))")
        rc.reload()
        until(rc, "() => document.getElementById('methodos-tracker').dataset.status === 'shared'", 30)
        after = view(rc)
        sent = log()
        gets = [e for e in sent if e['path'] == f"/reconciliation/shared/{r['token']}/"]
        r['viewed'] = True
        return (v['hash'] == '' and r['token'] not in v['href'] and 'shared with you through the World Historical Gazetteer' in v['ask'] and 'Needs permission: World Historical Gazetteer Workbench' in v['ask']
                and held == r['token'] and asked == [] and len(gets) == 1 and 'authorization' not in gets[0]['headers'] and gets[0]['method'] == 'GET'
                and rc.evaluate("() => sessionStorage.getItem('plato-tools.whg-shared')") is None and r['token'] not in rc.url), \
            {'hash': v['hash'], 'ask': v['ask'][:200], 'held': held == r['token'], 'asked before': len(asked), 'gets': [(e['method'], e['path'], sorted(e['headers'])) for e in gets], 'url': rc.url}
    attempt('WHG, a share link opened: the token leaves the address at once; with the permission not given, the page says what the link is and asks, sending nothing; allowed and reloaded, the token held for the reload only, the shared project is read with no Authorization header', recipient_asked)

    def recipient_view():
        need('viewed')
        v = view(rc)
        shot(rc, 'whg-recipient-1440-light.png')
        for w, scheme, name in ((600, 'light', 'whg-recipient-600-light.png'), (600, 'dark', 'whg-recipient-600-dark.png'), (1440, 'dark', 'whg-recipient-1440-dark.png')):
            if shots and not PROVE:
                rc.set_viewport_size({'width': w, 'height': 900}); rc.emulate_media(color_scheme=scheme); rc.evaluate('() => window.scrollTo(0, 0)'); shot(rc, name)
        rc.set_viewport_size({'width': 1440, 'height': 900}); rc.emulate_media(color_scheme='light')
        with rc.expect_download(timeout=T(30) * 1000) as d: rc.click('#methodos-shared-download')
        f = out / ('shared-' + d.value.suggested_filename); d.value.save_as(f)
        with zipfile.ZipFile(f) as z: m = json.loads(z.read('manifest.json'))
        steps = rc.evaluate(JOIN_STATE)['steps']
        return ('Read-only' in v['shared'] and v['sharedButtons'] == ['Make my own copy', 'Download .platoproj', 'Close'] and v['buttons'] == [] and not v['project']
                and steps.get('columns') == 'current' and m['workflow']['id'] == r['wid'] and wid(rc) == []), \
            {'shared': v['shared'][:200], 'buttons': v['buttons'], 'shared buttons': v['sharedButtons'], 'project panel': v['project'], 'steps': steps, 'manifest': m['workflow'], 'kept': wid(rc)}
    attempt('WHG, a share link: the workflow is shown read-only (its steps, where it is), every action off but "Make my own copy", "Download .platoproj" and "Close"; the download is the project; nothing is kept in this browser', recipient_view)

    def recipient_copy():
        need('viewed')
        rc.click('#methodos-shared-copy')
        until(rc, "() => /Your own copy of/.test(document.getElementById('methodos-message').textContent)", 30)
        until(rc, WHG_LINKS_JS.replace('async () => {', 'async () => { const got = await (async () => {', 1) + ")(); return Object.values(got).some((l) => !!l.origin); }", 15)
        v = view(rc)
        ids = wid(rc)
        links = rc.evaluate(WHG_LINKS_JS)
        stored = rc.evaluate(WHG_STORAGE_JS)
        link = links.get(ids[0], {}) if ids else {}
        # Visited again: the newest save, read-only, and no second copy.
        rc.goto(NOTOOLS if PROVE else f"{base}#whg-shared={r['token']}")
        until(rc, "() => document.getElementById('methodos-tracker').dataset.status === 'shared'", 30)
        again = wid(rc)
        return (v['status'] == 'idle' and len(ids) == 1 and ids[0] != r['wid'] and link.get('origin', {}).get('workflowId') == r['wid'] and isinstance(link.get('origin', {}).get('version'), int)
                and 'projectId' not in link and r['token'] not in stored and r['wid'] in stored and again == ids), \
            {'status': v['status'], 'ids': ids, 'original': r['wid'], 'link': link, 'token stored': r['token'] in stored, 'again': again}
    attempt('WHG, a share link: "Make my own copy" makes a workflow of this browser with an id of its own, not linked to WHG, its origin (the workflow and the version) kept and never the share token; the link opened again shows the newest save read-only, not a second copy', recipient_copy)

    def recipient_refused():
        need('viewed')
        # Another kind of project (Map your data's), shared: refused in words; a link withdrawn: refused in words.
        other = fake('create', {'token': WHG_E2E_TOKEN, 'title': 'MyD', 'snapshot': {'rows': []}, 'doc_type': 'reconciliation'})
        t = fake('share', {'id': other['id']})['token']
        rc.goto(NOTOOLS if PROVE else f"{base}#whg-shared={t}")
        until(rc, "() => /another kind/.test(document.getElementById('methodos-message').textContent + document.getElementById('methodos-project-said').textContent)", 20)
        wrong = view(rc)
        fake('unshare', {'id': other['id']})
        rc.goto(NOTOOLS if PROVE else f"{base}#whg-shared={t}")
        until(rc, "() => /no longer opens anything/.test(document.getElementById('methodos-message').textContent + document.getElementById('methodos-project-said').textContent)", 20)
        gone = view(rc)
        return wrong['status'] != 'shared' and gone['status'] != 'shared', {'wrong': (wrong['message'] + wrong['projectSaid'])[:200], 'gone': (gone['message'] + gone['projectSaid'])[:200]}
    attempt('WHG, a share link: one to another kind of WHG project is refused in words, and one withdrawn says it opens nothing; neither is shown', recipient_refused)

    def recipient_retry():
        need('viewed')
        # WHG down for a moment as the link is read: the token, already out of the address, is held in memory, "Try again" offered.
        fake('config', {'fail': 1}); log(clear=True)
        try:
            rc.goto(NOTOOLS if PROVE else f"{base}#whg-shared={r['token']}")
            until(rc, "() => !document.getElementById('whg-shared-retry').hidden && !document.getElementById('whg-shared-ask').hidden", 20)
            v = view(rc)
            held = rc.evaluate("() => sessionStorage.getItem('plato-tools.whg-shared')")
            first = [e['status'] for e in log() if '/reconciliation/shared/' in e['path']]
            rc.click('#whg-shared-retry')
            until(rc, "() => document.getElementById('methodos-tracker').dataset.status === 'shared'", 20)
            after = [e['status'] for e in log() if '/reconciliation/shared/' in e['path']]
        finally: fake('config', {'fail': 0})
        return (v['hash'] == '' and 'paste the link again' in v['ask'] and held is None and first == [503] and after == [503, 200] and view(rc)['ask'] == ''), \
            {'hash': v['hash'], 'ask': v['ask'][:240], 'held in storage': held, 'first': first, 'after': after}
    attempt('WHG, a share link read while WHG is down for a moment: the link is out of the address, so it is held in this tab\'s memory with "Try again", and a reload is said to need it pasted again; tried again, it opens', recipient_retry)

    def recipient_never():
        need('shared')
        # Held in sessionStorage while the permission is asked; set to Never (in another tab of the same browser), it is let go at once.
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
        ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), forward)
        p1 = ctx.new_page()
        p1.goto(NOTOOLS if PROVE else f"{base}#whg-shared={r['token']}")
        until(p1, "() => !document.getElementById('whg-shared-ask').hidden", 20)
        before = p1.evaluate("() => sessionStorage.getItem('plato-tools.whg-shared')")
        p2 = ctx.new_page(); p2.goto(NOTOOLS if PROVE else base)
        p2.evaluate("() => localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'collaborate:whg': { state: 'never', at: '2026-10-14T10:00:00Z' } } }))")
        try: until(p1, "() => sessionStorage.getItem('plato-tools.whg-shared') === null", 10)
        except Exception: pass
        after = p1.evaluate("() => sessionStorage.getItem('plato-tools.whg-shared')")
        said = view(p1)['ask']
        ctx.close()
        return (before == r['token'] and after is None and 'set to Never' in said), {'held before': before == r['token'], 'held after': after, 'said': said[:240]}
    attempt('WHG, a share link waiting for its permission: the token held across a reload is let go from sessionStorage as soon as the permission is set to Never, and the page says so', recipient_never)

    def refusals():
        need('a')
        out_ = {}
        # 403 beta_required: an account not enrolled; WHG's page named, nothing to join here.
        e = context(grant=True, token=WHG_E2E_OTHER)
        begin(e); panel(e); e.click('#whg-save')
        until(e, "() => /not enrolled/.test(document.getElementById('whg-said').textContent)", 20)
        out_['beta'] = e.evaluate("() => [document.getElementById('whg-said').textContent, document.querySelector('#whg-said a')?.href]")
        # 401: a token WHG does not know: the token field opened, focused.
        e.evaluate("() => sessionStorage.setItem('plato-tools.whg-token', 'e2e-SECRET-unknown-token-0000')")
        e.reload(); wait_state(e, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        until(e, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        panel(e); e.click('#whg-save')
        until(e, "() => /did not accept your token/.test(document.getElementById('whg-said').textContent)", 20)
        out_['401'] = view(e)
        e.context.close()
        # 429 twice: waited once, counted down, then stopped in words.
        fake('config', {'rate': 1, 'retryAfter': 2, 'holdMinute': True}); fake('newMinute')   # the minute held: a wall-clock minute turning during the countdown would give the retry a fresh budget
        fake('create', {'token': WHG_E2E_TOKEN, 'title': 'spends the minute', 'snapshot': {'plato': 1}})   # the minute's one request spent elsewhere
        log(clear=True)
        panel(a); a.click('#whg-save')
        until(a, "() => /trying again in/.test(document.getElementById('whg-said').textContent)", 20)
        out_['countdown'] = view(a)['said']
        until(a, "() => /still asking for a pause/.test(document.getElementById('whg-said').textContent)", 20)
        out_['429'] = view(a)['said']
        fake('config', {'rate': 120, 'retryAfter': None, 'holdMinute': False}); fake('newMinute')
        # 413 from WHG (a lower cap than these tools fit to): said, nothing lost.
        fake('config', {'bodyMax': 1000})
        a.click('#whg-save')
        until(a, "() => /Too large for WHG/.test(document.getElementById('whg-said').textContent)", 20)
        out_['413'] = view(a)['said']
        fake('config', {'bodyMax': 2 * 1024 * 1024})
        # 404: the project deleted elsewhere: said, and the link let go.
        linked = a.evaluate(WHG_LINKS_JS).get(r['wid'], {}).get('projectId')
        fake('remove', {'id': linked})
        a.click('#whg-save')
        until(a, "() => /no longer has this project/.test(document.getElementById('whg-said').textContent)", 20)
        out_['404'] = view(a)['said']; out_['link after 404'] = a.evaluate(WHG_LINKS_JS).get(r['wid'])
        # An origin WHG does not allow: refused by WHG itself (403 origin_not_allowed, its second line of defence after the
        # browser's CORS check, which Playwright's routing does not apply to a fulfilled answer: see whg_cors below).
        # Allowed: only an origin no page under test can have (the live check runs AT pelagios.org, so allowing that
        # one alone tested nothing there).
        fake('config', {'origins': ['https://not-this-page.example']})
        try:
            a.click('#whg-save')
            said(a, "() => /only from the tools at pelagios\\.org/.test(document.getElementById('whg-said').textContent)", 20)
            out_['origin'] = view(a)['said']
        finally: fake('config', {'origins': [origin]})
        ok = ('not enrolled' in out_['beta'][0] and (out_['beta'][1] or '').startswith('https://whgazetteer.org/development')
              and out_['401']['token'] and out_['401']['focus'] == 'whgp-token'
              and re.search(r'trying again in \d seconds?', out_['countdown']) and out_['429'].startswith('Not saved to WHG. Your work is kept in this browser. WHG is still asking for a pause')
              and 'Too large for WHG: the request came to' in out_['413'] and 'no longer linked here' in out_['404'] and out_['link after 404'] is None and 'WHG does not accept projects from this copy' in out_['origin'])
        return ok, {k: (v if not isinstance(v, dict) else {'said': v['said'][:120], 'token': v['token'], 'focus': v['focus']}) for k, v in out_.items()}
    def refusals_restored():
        try: return refusals()
        finally: fake('config', {'origins': [origin], 'rate': 120, 'retryAfter': None, 'bodyMax': 2 * 1024 * 1024, 'holdMinute': False}); fake('newMinute')
    attempt('WHG: each refusal said in words, nothing lost: not enrolled (WHG\'s page linked), a token refused (the field opened and focused), a pause asked twice (counted down, then stopped), too large for WHG (413), deleted there (404, unlinked), and an origin WHG does not allow (403)', refusals_restored)

    def too_large():
        need('a')
        # The user's own file over WHG's cap with everything else (random text, which DEFLATE cannot make much smaller).
        import secrets
        big = out / 'big-parishes.csv'
        big.write_text('id,name,parish,county\n' + ''.join(f'{i},{secrets.token_urlsafe(48)},Newton,Cheshire\n' for i in range(40000)))
        g = context(grant=True, token=WHG_E2E_TOKEN)
        begin(g, big)
        panel(g)
        until(g, "() => !document.getElementById('whg-leaves').hidden", 60)
        said = view(g)['leaves']
        shot(g, 'whg-too-large-1440-light.png')
        log(clear=True)
        g.click('#whg-save'); saved(g, 1, 90)
        done = view(g)['said']
        sent = [e for e in log() if e['method'] == 'POST']
        p = [x for x in projects() if x['doc_type'] == 'plato' and x['snapshot'].get('workflow', {}).get('id') in wid(g)]
        _, m = unzip_snapshot(p[0]['snapshot']) if p else (None, {})
        g.context.close()
        return ('big-parishes.csv will not go to WHG' in said and 'Not in it, as too large for WHG: big-parishes.csv' in done and len(sent) == 1 and sent[0]['size'] <= 2 * 1024 * 1024
                and [x['why'] for x in m.get('left', [])] == ['too-large'] and not any(x.get('own') for x in m.get('parts', []))), \
            {'said before': said[:200], 'said after': done[:200], 'size': [e['size'] for e in sent], 'left': m.get('left')}
    attempt('WHG: a project over WHG\'s 2 MB is said before saving to leave the user\'s own file out; saved, the request is under the cap, and the file is listed in the project as left out, too large', too_large)

    def token_nowhere():
        need('a')
        # The share token is in one kind of address by WHG's design (shared/<token>/, the capability), and in the page's own
        # address only as the fragment, which no request carries: anywhere else it is a leak.
        hits = [u for u in seen if WHG_E2E_TOKEN in u or WHG_E2E_OTHER in u or 'unknown-token' in u]
        shared = [u for u in seen if r.get('token') and r['token'] in u and '/reconciliation/shared/' not in u]
        whg = [u for u in seen if 'whgazetteer.org' in u]
        return (len(whg) >= 10 and hits == [] and shared == []), {'requests to WHG': len(whg), 'with a token in the address': hits[:3], 'share token elsewhere': shared[:3]}
    attempt('WHG: of every request these checks\' pages made (the presence: many to WHG), none has the WHG token or a share token in its address', token_nowhere)

    def whg_cors():
        # What the page relies on of WHG's CORS, as the fake answered it. Playwright's routing does not make the browser
        # apply CORS to a fulfilled answer, and answers the preflights itself (none reached the route, measured 14 October
        # 2026), so the answers' headers are read here; the preflight is test/workbench.test.js's, and the live test's.
        mine = [x for x in answered if x['origin'] == origin and x['method'] != 'OPTIONS' and x['status'] != 403]
        cred = [x for x in answered if 'access-control-allow-credentials' in x['headers']]
        return (len(mine) >= 10 and all(x['headers'].get('access-control-allow-origin') == origin for x in mine) and cred == []
                and all('Retry-After' in x['headers'].get('access-control-expose-headers', '') for x in mine)), \
            {'answers': len(mine), 'with credentials': len(cred), 'odd': [x['headers'].get('access-control-allow-origin') for x in mine if x['headers'].get('access-control-allow-origin') != origin][:3]}
    attempt('WHG: every answer the page read named its origin in Access-Control-Allow-Origin and exposed Retry-After, and none allowed credentials', whg_cors)

    try: browser.close()
    except Exception: pass
    try: os.killpg(srv.pid, signal.SIGTERM)
    except ProcessLookupError: pass

# ---- Scope (Issue #33, points 2 and 8; src/scope-page.js, src/engine/krisis/scope.js) ---------------------------
# What every WHG lookup is confined to. Against a stub of WHG (never the real one), which answers the reconciliation
# queries, its tree of AAT place types, a type's expansion and its sources, and records every request it is sent:
# each check reads what the stub RECEIVED, never only what the page says it would send. Each absence has its presence
# in the same check (no map before the drawn area is opened, beside the main page's own code asked for; no Scope
# field after "without Scope", beside the same place's earlier query carrying them).
SCOPE_TREE_ROOTS = [{'id': 'aat:300008347', 'aat_id': 300008347, 'text': 'inhabited places', 'fclasses': ['A', 'P'], 'guide': False, 'children': True},
                    {'id': 'aat:300132294', 'aat_id': 300132294, 'text': 'natural landscapes', 'fclasses': [], 'guide': False, 'children': True}]
SCOPE_TREE_KIDS = {'300008347': [{'id': 'aat:300008407', 'aat_id': 300008407, 'text': 'by function', 'fclasses': ['A', 'P'], 'guide': True, 'children': True}],
                   '300008407': [{'id': 'aat:300008419', 'aat_id': 300008419, 'text': 'parish seats', 'fclasses': ['A', 'P'], 'guide': False, 'children': False}]}
SCOPE_FOUND = [{'aat_id': 300008419, 'text': 'parish seats', 'ancestors': [300264550, 300008347, 300008407, 300008419]}]
SCOPE_NARROWER = 'aat:399000001'   # the stub's own narrower type: in a request, it can only have come from the stub's expansion
SCOPE_SOURCES = {'sources': [{'namespace': 'gn', 'name': 'GeoNames', 'record_count': 13454817, 'core': True},
                             {'namespace': 'stubns', 'name': 'Stub Gazetteer', 'record_count': 12, 'core': False},
                             {'namespace': 'whg', 'name': 'Specialist Gazetteers', 'record_count': 0, 'core': False}]}
SCOPE_ENGLAND = {'id': 'place:wd:Q21', 'name': 'England', 'score': 100, 'match': True, 'description': 'Country: GB', 'ccodes': ['GB'], 'repr_point': [-1.5, 52.6],
                 'namespace': 'wd', 'alt_names': [], 'has_geom': True}
SCOPE_STATE = '''() => { const r = document.getElementById('scope'), v = (e) => !!e && !e.hidden && !e.closest('[hidden]') && !!e.getClientRects().length;
  return { rail: v(r), line: r?.querySelector('.scope-line-text')?.textContent || null, chips: [...(r?.querySelectorAll('.scope-chip') || [])].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
    undated: !!r?.querySelector('[data-mark="undated"]') && v(r), offer: v(document.getElementById('scope-offer')),
    editor: v(document.getElementById('scope-editor')), files: v(document.getElementById('files')),
    tracker: v(document.getElementById('methodos-tracker')), focus: document.activeElement ? document.activeElement.id || document.activeElement.className || document.activeElement.tagName : null,
    state: window.__plato && window.__plato.scope ? JSON.parse(JSON.stringify(window.__plato.scope)) : null }; }'''
# The tracker in a 1440 x 900 window: "This step is done" in view, and how many of its steps are wholly in view.
SCOPE_RAIL = '''() => { const v = (e) => { const r = e.getBoundingClientRect(), l = document.getElementById('methodos-track').getBoundingClientRect();
    return r.height > 0 && r.top >= Math.max(0, l.top) - 1 && r.bottom <= Math.min(innerHeight, l.bottom) + 1; };
  const done = document.getElementById('methodos-done').getBoundingClientRect();
  return { steps: document.querySelectorAll('#methodos-track li.track-step').length, inView: [...document.querySelectorAll('#methodos-track li.track-step')].filter(v).length,
    done: done.height > 0 && done.top >= 0 && done.bottom <= innerHeight, line: !!document.querySelector('#methodos-tracker #scope .scope-line-text'),
    card: !!document.querySelector('#workflow-rail > #scope') }; }'''

# ---- Krisis: the quality of what a lookup suggests (Issue #34, item 1: #20, #21, #22) ------------------------
# Against a stub of WHG that answers as it was probed on 12 October 2026 (whg.js A7: the kind in place_types,
# the protocol's Place in type), and its /types/vocab/. Each check is paired so that it can fail: a kind shown
# beside "type unknown", a candidate ranked up beside one ranked down, a place left out of the bulk accept for
# its kind beside one accepted, a placeholder counted beside a real place kept, a daily cap with a time beside
# the one without (krisis_lookup_case). QUALITY_SHOTS=<dir> saves screenshots of the review at 1440 x 900.
QUALITY_BASE = 'https://example.org/q/'
QUALITY_PROTOCOL = [{'id': 'https://whgazetteer.org/static/whg_schema.jsonld#Place', 'name': 'Place'}]
def quality_answer(id, name, point, place_types, score=100, match=True, rest=None):
    return {'id': id, 'name': name, 'score': score, 'match': match, 'description': 'Country: GB', 'ccodes': ['GB'], 'repr_point': point,
            'namespace': id.split(':')[1], 'alt_names': (rest or {}).get('alt_names', []), 'type': QUALITY_PROTOCOL, 'place_types': place_types, 'confidence': 100 if match else 80}
QUALITY_ANSWERS = {
    # A town: WHG's top is the lake (it passes WHG's guard), the town second. The review puts the town first, the lake
    # last, and the bulk accept leaves Windermere for the reviewer (#20; WHG place#273).
    'Windermere': [quality_answer('place:gn:2634000', 'Windermere', [-2.94, 54.35], [{'identifier': 'LK', 'label': 'H'}]),
                   quality_answer('place:osm:r1', 'Windermere', [-2.906, 54.38], [{'identifier': 'town', 'label': 'osm'}], 95, False)],
    # A parish: WHG's top is a GeoNames populated place, nearer; the parish (kain_par) is ranked first, as yours is a parish.
    'Ashby': [quality_answer('place:gn:2657000', 'Ashby', [-1.47, 52.75], [{'identifier': 'PPL', 'label': 'P'}]),
              quality_answer('place:kain_par:100', 'Ashby', [-1.49, 52.76], [{'identifier': 'parish', 'label': 'kain_par'}], 95, False)],
    # No kind of its own: a TGN record of a kind only WHG's vocabulary names, and a Wikidata record with no type.
    'Kendal': [quality_answer('place:tgn:7011000', 'Kendal', [-2.746, 54.328], [{'identifier': 'aat:300008416', 'label': 'tgn'}]),
               quality_answer('place:wd:Q1000', 'Kendal', [-2.75, 54.33], [], 90, False)],
    # Placeholders (#21): the Oknoname record left out, the real Lanach kept; Nowhere answered by a placeholder alone.
    'Barony Lanach': [quality_answer('place:gn:4500000', 'Oknoname 037068 Dam', [-97.1, 35.2], [{'identifier': 'DAM', 'label': 'S'}], rest={'alt_names': ['Oknoname Dam']}),
                      quality_answer('place:gn:2645000', 'Lanach', [-3.51, 55.61], [{'identifier': 'PPL', 'label': 'P'}], 80, False)],
    'Nowhere': [quality_answer('place:osm:w1', 'Unnamed', [0.0, 51.0], [{'identifier': 'water', 'label': 'osm'}])],
}
QUALITY_VOCAB = {'byId': {'aat:300008416': {'label': 'county seats', 'desc': 'Seats of a county.'}, 'aat:300008347': {'label': 'inhabited places', 'desc': ''}}}

def quality_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    shots = os.environ.get('QUALITY_SHOTS')
    browser = pw.chromium.launch(headless=True, args=GL)
    # In London's time, so that the daily cap's reset (midnight UTC) is said in the reader's own: 01:00 BST.
    ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce', timezone_id='Europe/London')
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    posts, gets, mode = [], [], {'daily': False}
    def stub(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        reply = lambda body, status=200: route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
        if req.method == 'GET':
            gets.append(req.url)
            return reply(QUALITY_VOCAB) if req.url.endswith('/types/vocab/') else reply({'detail': 'Not found'}, 404)
        body = json.loads(req.post_data or '{}'); posts.append(body)
        # WHG's daily cap as it has been asked to send it (whg.js A15): a 429 with its code and when it resets.
        if mode['daily']: return route.fulfill(status=429, headers={**cors, 'Content-Type': 'application/json', 'Retry-After': '41234', 'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Retry-After'}, body=json.dumps({'code': 'daily_limit_exceeded', 'detail': 'Daily API limit (5000 calls) exceeded', 'limit': 5000, 'resets_at': '2026-10-13T00:00:00Z'}))
        res = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in (body.get('queries') or {}).items(): res[k] = {'result': QUALITY_ANSWERS.get(q.get('query'), [])}
        reply(res)
    ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub)
    page = ctx.new_page()
    subjects = tmp / 'quality.json'
    def typed(p, t): p['attestations'][0]['types'] = [t]; return p
    places = [typed(krisis_place(QUALITY_BASE + 'windermere', 'Windermere', -2.905, 54.38), {'label': 'town'}),
              typed(krisis_place(QUALITY_BASE + 'ashby', 'Ashby', -1.47, 52.75), {'identifier': 'http://vocab.getty.edu/aat/300387092', 'label': 'parish'}),
              krisis_place(QUALITY_BASE + 'kendal', 'Kendal', -2.745, 54.33), krisis_place(QUALITY_BASE + 'lanach', 'Barony Lanach', -3.5, 55.6),
              krisis_place(QUALITY_BASE + 'nowhere', 'Nowhere', 0.0, 51.0)]
    subjects.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': QUALITY_BASE, 'title': 'Places of several kinds'}, 'spatialEntities': places}))
    r = {}
    W = lambda: (wait_state(page, lambda s: True, 5).get('work') or {})
    def to_subject(name):
        # Every place (Nowhere has no candidate, and the default filter skips it), from the first.
        if page.input_value('#review-filter') != 'all': page.select_option('#review-filter', 'all')
        for _ in range(8):
            if page.is_disabled('#review-prev'): break
            page.click('#review-prev')
        for _ in range(8):
            if page.inner_text('#review-subject').strip() == name: return True
            if page.is_disabled('#review-next'): break
            page.click('#review-next')
        if page.inner_text('#review-subject').strip() != name: raise RuntimeError(f'{name} not found in the review')
        return True
    def rows():
        return page.eval_on_selector_all('#review-place li.candidate', '''els => els.map((e) => ({ iri: e.querySelector('.iri')?.textContent,
            kind: e.querySelector('p.kind')?.textContent || null, fit: e.querySelector('p.kind')?.dataset.fit || null,
            chips: [...e.querySelectorAll('p.kind code.code-chip')].map((c) => c.textContent),
            why: e.querySelector('p.kind-why')?.textContent || null, decision: e.querySelector('.decision')?.textContent }))''')
    def shot(name):
        if shots and not PROVE:
            pathlib.Path(shots).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(pathlib.Path(shots) / name), full_page=False)

    def looked_up():
        page.goto(NOTOOLS if PROVE else base)
        page.evaluate("() => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-10-12T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Quality Reviewer' })); }")
        page.goto(NOTOOLS if PROVE else base)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        page.set_input_files('#picker', [str(subjects)])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        until(page, "() => /^Send 5 queries to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", 60)
        page.click('#lookup-send')
        s = wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and s.get('phase') == 'reviewing', T(60), 'lookup')
        r['summary'] = page.inner_text('#lookup-progress'); r['looked'] = True
        r['counts'] = ((s.get('work') or {}).get('lookups') or [{}])[0].get('counts') or {}
        # WHG's labels for AAT kinds come once WHG is allowed (scope-page.js aatLabels): wait for the redraw that uses them.
        soon(page, "() => (window.__plato.kindLabels || {}).from === 'whg'", 15)
        r['labels'] = page.evaluate('() => window.__plato.kindLabels || null')
        return (len(posts) == 1 and r['counts'].get('added') == 7), {'posts': len(posts), 'counts': r['counts'], 'summary': r['summary'][:300]}
    attempt('lookup quality: five places looked up in the stub of WHG, seven candidates added', looked_up)

    def kinds_shown():
        if not r.get('looked'): raise RuntimeError('the lookup did not run')
        to_subject('Kendal'); k = rows(); shot('review-kendal-kinds.png')
        r['kendal'] = k
        tgn = next((x for x in k if (x['iri'] or '').endswith('place:tgn:7011000')), {})
        wd = next((x for x in k if (x['iri'] or '').endswith('place:wd:Q1000')), {})
        return (tgn.get('kind') == 'Kind of place: county seats aat:300008416' and tgn.get('chips') == ['aat:300008416']
                and (r.get('labels') or {}).get('from') == 'whg' and any('/types/vocab/' in g for g in gets)
                and wd.get('kind') == 'Kind of place: type unknown' and wd.get('chips') == []
                and not any('Place' in (x.get('kind') or '') for x in k)), {'rows': k, 'labels': r.get('labels'), 'gets': gets[:3]}
    attempt("lookup quality: a candidate's kind is shown, an AAT id by WHG's own label (from /types/vocab/, never the protocol's Place), and a candidate with none says \"type unknown\"", kinds_shown)

    def codes_shown():
        if not r.get('looked'): raise RuntimeError('the lookup did not run')
        to_subject('Windermere'); k = rows(); shot('review-windermere-ranked.png'); r['windermere'] = k
        return ([x['chips'] for x in k] == [['osm:town'], ['gn:H.LK']] and all((x['kind'] or '').startswith('Kind of place: ') for x in k)), k
    attempt("lookup quality: a source's bare code is shown as a code (osm:town, gn:H.LK), with no label made up for it", codes_shown)

    def preferred():
        k = r.get('windermere') or []
        if not k: raise RuntimeError('Windermere was not reviewed')
        to_subject('Ashby'); a = rows(); shot('review-ashby-parish.png'); r['ashby'] = a
        return ([x['iri'].rsplit('/', 1)[-1] for x in k] == ['place:osm:r1', 'place:gn:2634000'] and [x['fit'] for x in k] == ['match', 'conflict']
                and k[0]['why'] == 'osm:town is the kind of place yours is (town), or a narrower kind: it comes first among records of one place (within 2 km of each other).'
                and k[1]['why'] == 'Ranked down: gn:H.LK, where yours is town; after the other candidates as near. Never accepted in bulk; decide on it yourself.'
                and [x['iri'].rsplit('/', 1)[-1] for x in a] == ['place:kain_par:100', 'place:gn:2657000'] and [x['fit'] for x in a] == ['match', 'other']
                and a[0]['why'] == 'kain_par:parish is the kind of place yours is (parish), or a narrower kind: it comes first among records of one place (within 2 km of each other).' and a[1]['why'] is None), {'windermere': k, 'ashby': a}
    attempt("lookup quality: among records of one place (within 2 km), the one of the place's own kind comes first though WHG put it second and it is a little further (Ashby's parish); a lake for a town goes last; the review says why of each, and nothing of a kind that goes together", preferred)

    def placeholders():
        if not r.get('looked'): raise RuntimeError('the lookup did not run')
        to_subject('Barony Lanach'); lan = rows()
        to_subject('Nowhere'); said = page.inner_text('#review-place')
        cands = W().get('candidates', [])
        return (r['counts'].get('skipped', {}).get('placeholder') == 2
                and 'Not suggested: 2 records whose only name is a placeholder (such as "Oknoname 037068 Dam")' in r['summary']
                and [x['iri'].rsplit('/', 1)[-1] for x in lan] == ['place:gn:2645000'] and cands and not any('Oknoname' in json.dumps(c) for c in cands)
                and '1 record whose only name is a placeholder (such as "Oknoname 037068 Dam") was left out.' in said), {'counts': r['counts'], 'summary': r['summary'][:400], 'lanach': lan, 'nowhere': said[:300]}
    attempt("lookup quality: WHG's placeholder records (Oknoname, Unnamed) are left out and counted in the summary and on the place, the real Lanach beside them kept", placeholders)

    def bulk():
        if not r.get('looked'): raise RuntimeError('the lookup did not run')
        until(page, "() => !document.getElementById('bulk-accept').disabled", 15)
        page.click('#bulk-accept')
        wait_state(page, lambda s: any((c.get('decision') or {}).get('kind') == 'match' for c in (s.get('work') or {}).get('candidates', [])), T(15), 'accepted')
        said = page.inner_text('#bulk-result'); shot('review-bulk-refused.png')
        cands = W().get('candidates', [])
        dec = {c['gazetteer']['id']: (c.get('decision') or {}).get('kind') for c in cands}
        return (dec.get('place:gn:2634000') is None and dec.get('place:osm:r1') is None and dec.get('place:tgn:7011000') == 'match' and dec.get('place:gn:2657000') == 'match'
                and "1 of another kind of place than the place's own" in said and '2 accepted as yours.' in said), {'said': said[:300], 'decisions': dec}
    attempt("lookup quality: the bulk accept leaves Windermere (its passing candidate a lake, the place a town) for the reviewer and says so, and accepts Kendal and Ashby", bulk)

    def daily():
        if not r.get('looked'): raise RuntimeError('the lookup did not run')
        mode['daily'] = True
        page.select_option('#lookup-places', 'all')
        until(page, "() => /^Send 5 queries to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", 30)
        n = len(posts)
        page.click('#lookup-send')
        s = wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and (s.get('lookup') or {}).get('stopped'), T(60), 'daily cap')
        out = {'stopped': (s.get('lookup') or {}).get('stopped'), 'said': page.inner_text('#lookup-progress'), 'sent': len(posts) - n,
               'token state': page.inner_text('#whg-token-state'), 'session': page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token') !== null"),
               'focus': page.evaluate("() => document.activeElement?.id || null"),
               'kept': sum(1 for c in (s.get('work') or {}).get('candidates', []) if c.get('lookup'))}
        shot('lookup-daily-cap.png')
        return (out['stopped'] == 'quota' and "WHG's daily limit for this token is reached; it resets at 01:00 BST on 13 October 2026" in out['said']
                and out['sent'] == 1 and out['token state'] == 'Token kept for this tab only' and out['session'] is True and out['focus'] != 'whg-token' and out['kept'] == 7), out
    attempt("lookup quality: WHG's daily cap (a 429 with code daily_limit_exceeded) stops the lookup at once, saying when it resets in the reader's own time; what was answered is kept, and the token is kept, not asked for again", daily)
    browser.close()

def scope_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    origin = re.match(r'^https?://[^/]+', base).group(0)
    browser = pw.chromium.launch(headless=True, args=GL)
    ctx = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    posts, gets, asked = [], [], []
    empty_types = {'on': False}   # while on, every query sent types is answered with nothing (WHG says no scope for types)
    def stub(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        reply = lambda body, status=200: route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
        if req.method == 'GET':
            gets.append(req.url)
            path = re.sub(r'^https?://[^/]+', '', req.url)
            if path == '/types/tree/': return reply(SCOPE_TREE_ROOTS)
            m = re.match(r'^/types/tree/(\d+)/$', path)
            if m: return reply(SCOPE_TREE_KIDS.get(m.group(1), []))
            if path.startswith('/types/tree/search/'): return reply(SCOPE_FOUND)
            m = re.match(r'^/types/expand/\?ids=(aat(?::|%3A)\d+)$', path)
            if m: return reply({'ids': [m.group(1).replace('%3A', ':'), SCOPE_NARROWER]})
            if path == '/api/sources/': return reply(SCOPE_SOURCES)
            return reply({'detail': 'Not found'}, 404)
        body = json.loads(req.post_data or '{}'); posts.append(body)
        res = {'attribution': LOOKUP_ATTRIBUTION}
        for k, q in (body.get('queries') or {}).items():
            spatial = any(x in q for x in ('contained_in', 'bounds', 'countries'))
            if empty_types['on'] and q.get('types'): res[k] = {'result': []}; continue
            if q.get('query') == 'England' and q.get('area_only'): found = [SCOPE_ENGLAND, {**SCOPE_ENGLAND, 'id': 'place:gn:9100001', 'has_geom': False}]
            # Mill Farm has nothing of its kind within the Scope: WHG answers the scoped query with nothing, the filter applied.
            elif q.get('query') == 'Mill Farm' and q.get('types'): res[k] = {'result': [], 'scope': {'applied': True}}; continue
            # Low Mill: WHG could not apply the Scope's Where (no outline to look within): nothing, applied false, fail-closed.
            elif q.get('query') == 'Low Mill' and q.get('contained_in'): res[k] = {'result': [], 'scope': {'applied': False}}; continue
            else: found = MYDATA_ANSWERS.get(q.get('query'), [])
            if q.get('area_only'): found = [c for c in found if c.get('has_geom') is not False] if q.get('query') != 'England' else found
            res[k] = {'result': found, **({'scope': {'applied': True}} if spatial else {})}
        reply(res)
    ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub)
    ctx.on('request', lambda r: asked.append(r.url))
    page = ctx.new_page()
    S = lambda: page.evaluate(SCOPE_STATE)
    focus = lambda: page.evaluate('() => document.activeElement && document.activeElement.id')
    r = {}
    def need(*keys):
        missing = [k for k in keys if not r.get(k)]
        if missing: raise RuntimeError(f'an earlier step did not finish ({", ".join(missing)})')
    def choose(fs):
        page.set_input_files('#picker', [])
        page.set_input_files('#picker', [str(f) for f in fs])
        s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
        if s.get('phase') != 'detected': raise RuntimeError(f'not detected: {s.get("phase")}')
    def edit():
        page.click('#scope .scope-edit' if S()['rail'] else '#lookup-scope .scope-edit')
        until(page, "() => !document.getElementById('scope-editor').hidden", 10)
    def done():
        page.click('#scope-done'); until(page, "() => document.getElementById('scope-editor').hidden", 10)
    map_chunk = lambda: [u for u in asked if re.search(r'/assets/map-[\w-]+\.js$', u)]
    def to_place(name):
        page.select_option('#review-filter', 'all')   # a place with no candidate is among all places, not those still to decide
        for way in ('#review-prev', '#review-next'):   # wherever the review opened, the place is reached one way or the other
            for _ in range(12):
                if name in page.inner_text('#review-subject') or not page.is_enabled(way): break
                page.click(way)
        return name in page.inner_text('#review-subject')

    def begin():
        page.goto(NOTOOLS if PROVE else base)
        page.evaluate("() => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-10-12T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Scope Reviewer' })); }")
        page.goto(NOTOOLS if PROVE else base)
        wait_state(page, lambda s: s.get('phase') == 'ready' and s.get('canary') in ('enforced', 'not-enforced'), T(30), 'ready')
        # This tab has a Scope of its own (Ireland) before the workflow begins: the workflow offers to take it in, never silently.
        page.evaluate("() => sessionStorage.setItem('plato-tools.scope', JSON.stringify({ where: { mode: 'countries', countries: ['IE'] } }))")
        # The base address the regions are minted under (the workflow asks for one), as Options holds it.
        page.evaluate("() => { const b = document.getElementById('base'); b.value = %s; b.dispatchEvent(new Event('change')); }" % json.dumps(MYDATA_BASE))
        page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'yes'), ('will-draw', 'yes'), ('will-publish', 'no')): page.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        page.click('#methodos-start'); until(page, "['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        choose([MYDATA_CSV])
        until(page, "document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
        offered = S()
        page.click('#scope-offer-no')
        until(page, "() => !document.getElementById('scope-offer')", 10)
        s = S(); r['begun'] = s
        return (offered['offer'] and offered['state']['scope']['where']['mode'] == 'anywhere' and not s['offer']
                and s['rail'] and s['tracker'] and s['line'] == 'Scope: none' and s['chips'] == ['Where anywhere', 'What every kind of place', 'When any time', 'Sources all sources']
                and (s['state'] or {}).get('whose') == 'workflow' and not s['undated']), {'offered': offered['offer'], 'after': s}
    attempt('Scope: a workflow followed shows its Scope as one line in the tracker ("Scope: none" at first), which opens to four chips; begun while the tab had a Scope of its own, it offers to take it in, and declined, keeps none', begin)

    def rail_layout():
        need('begun')
        lay = page.evaluate(SCOPE_RAIL)
        return (lay['steps'] == 11 and lay['inView'] >= 8 and lay['done'] and lay['line'] and not lay['card']), lay
    attempt('Scope: at 1440 x 900 the Scope is folded into the tracker (no card of its own in the rail): "This step is done" is in view, and at least 8 of the 11 steps listed', rail_layout)

    def editor_in_centre():
        need('begun')
        edit()
        s = S()
        width = page.evaluate("() => document.getElementById('scope-editor').getBoundingClientRect().width")
        page.check('#scope-where-countries')
        page.fill('#scope-country-filter', 'United Kingdom')
        page.check('#scope-c-GB')
        # In a workflow, the editor shows at once what was ticked (it draws from the Scope just made, not the one before).
        one = page.evaluate("() => ({ gb: document.getElementById('scope-c-GB')?.checked, chosen: document.querySelector('#scope-countries .scope-chosen')?.textContent })")
        page.fill('#scope-country-filter', 'Ireland'); page.check('#scope-c-IE')
        two = page.evaluate("() => ({ ie: document.getElementById('scope-c-IE')?.checked, chosen: document.querySelector('#scope-countries .scope-chosen')?.textContent })")
        page.fill('#scope-country-filter', '')
        page.fill('#scope-start', '1500'); page.press('#scope-start', 'Tab')
        page.fill('#scope-end', '1600'); page.press('#scope-end', 'Tab')
        page.check('#scope-t-aat\\:300008372')   # Villages, sent with its narrower types
        until(page, "() => (window.__plato.scope.scope.types[0] || {}).narrower", 15)
        until(page, "() => !!document.getElementById('scope-s-stubns')", 15)
        sources = page.eval_on_selector_all('#scope-source-list label', 'ls => ls.map((l) => l.textContent.replace(/\\s+/g, " ").trim())')
        page.check('#scope-s-gn')
        undated = page.evaluate("() => { const b = document.getElementById('scope-undated'), d = document.getElementById(b.getAttribute('aria-describedby')); return { disabled: b.disabled, checked: b.checked, describedBy: b.getAttribute('aria-describedby'), note: d ? d.textContent : null, warn: !!document.getElementById('scope-undated-warn') }; }")
        done()
        after = S()
        r['chips'] = after['chips']; r['undated'] = undated; r['sources'] = sources
        ok = (s['editor'] and not s['files'] and width > 600 and one == {'gb': True, 'chosen': 'United Kingdom (GB)'} and two == {'ie': True, 'chosen': 'United Kingdom (GB), Ireland (IE)'}
              and after['chips'] == ['Where United Kingdom (GB), Ireland (IE)', 'What Villages (and 1 narrower type)', 'When 1500 to 1600', 'Sources GeoNames (gn)']
              and after['line'] == 'Scope: GB, IE · Villages · 1500 to 1600 · gn' and after['undated'] and not r['begun']['undated'] and not after['editor'] and after['files'])
        return ok, {'opened': {k: s[k] for k in ('editor', 'files')}, 'width': width, 'one ticked': one, 'two ticked': two, 'chips': after['chips'], 'line': after['line'], 'undated mark': after['undated']}
    attempt('Scope: in a workflow, Edit opens the editor in the centre (the steps hidden); a country ticked shows ticked at once, and a second beside it; Done returns, and the tracker\'s line and chips say the countries, the type with its narrower ones, the years and the source by name, with the mark that undated places are left out', editor_in_centre)

    def undated_and_sources():
        need('chips')
        u, src = r.get('undated') or {}, r.get('sources') or []
        return (u.get('disabled') is False and u.get('checked') is False and u.get('warn') is False and u.get('describedBy') == 'scope-undated-note' and 'left out whenever years are given' in (u.get('note') or '')
                and S()['state']['scope']['when']['undated'] is False and S()['state']['sources'] == 'whg'
                and any('Stub Gazetteer (stubns)' in x for x in src) and any(x.startswith('Contributed datasets (whg)') for x in src)), {'tick': u, 'sources': src, 'from': S()['state'].get('sources')}
    attempt('Scope: "Include places with no dates" can be ticked (WHG takes undated), unticked at first and described by what it does, with no warning that WHG leaves them out; the sources offered are WHG\'s (from the stub), with the contributed datasets (whg) added', undated_and_sources)

    def keyboard():
        need('chips')
        edit()
        out = {}
        # Arrows through the Where's modes: the focus stays on the mode chosen, which is drawn with its own part.
        page.focus('#scope-where-countries'); page.keyboard.press('ArrowRight')
        until(page, "() => document.getElementById('scope-where-place')?.checked", 10)
        out['arrow'] = focus()
        # Back to the countries: the countries chosen before come back (each mode's last value is kept).
        page.keyboard.press('ArrowLeft')
        until(page, "() => document.getElementById('scope-where-countries')?.checked", 10)
        out['arrow back'] = focus(); out['restored'] = S()['state']['scope']['where']
        # Space on a box: the focus stays on it.
        page.fill('#scope-country-filter', 'France'); page.focus('#scope-c-FR'); page.keyboard.press('Space')
        until(page, "() => window.__plato.scope.scope.where.countries.includes('FR')", 10)
        out['space'] = focus()
        page.keyboard.press('Space')
        until(page, "() => !window.__plato.scope.scope.where.countries.includes('FR')", 10)
        page.fill('#scope-country-filter', '')
        # Tab out of a year: the focus goes on to the next field, and stays there once the change is drawn.
        page.focus('#scope-start'); page.keyboard.press('Control+A'); page.keyboard.type('1510'); page.keyboard.press('Tab')
        until(page, "() => window.__plato.scope.scope.when.start === 1510", 10)
        out['tab'] = focus()
        page.focus('#scope-start'); page.keyboard.press('Control+A'); page.keyboard.type('1500'); page.keyboard.press('Tab')
        until(page, "() => window.__plato.scope.scope.when.start === 1500", 10)
        # Done: the focus goes back to the Edit control that opened the editor (in the tracker), found again.
        done()
        out['closed'] = page.evaluate("() => !!document.activeElement && document.activeElement.matches('#scope .scope-edit')")
        out['label'] = page.get_attribute('#scope .scope-edit', 'aria-label')
        return (out['arrow'] == 'scope-where-place' and out['arrow back'] == 'scope-where-countries' and (out['restored'].get('countries') == ['GB', 'IE'])
                and out['space'] == 'scope-c-FR' and out['tab'] == 'scope-end' and out['closed'] is True and out['label'] == 'Edit the Scope'), out
    attempt('Scope: the keyboard keeps its place through every redraw: arrows through the Where\'s modes (and back, the countries chosen before restored), Space on a country, Tab out of a year; Done gives the focus back to the tracker\'s Edit control (labelled "Edit the Scope")', keyboard)

    def survives_reload():
        need('chips')
        page.reload()
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        until(page, "() => !document.getElementById('scope').hidden && document.querySelectorAll('#scope .scope-chip').length === 4", 30)
        s = S()
        return s['chips'] == r['chips'] and s['state']['whose'] == 'workflow' and s['undated'], s
    attempt('Scope: the workflow\'s Scope survives a reload, taken up with the workflow (the same chips, and the mark)', survives_reload)

    def tree():
        need('chips')
        edit()
        page.click('#scope-more-types')
        until(page, "() => !!document.querySelector('#scope-tree li[data-aat=\"aat:300008347\"]')", 15)
        page.click('#scope-tree li[data-aat="aat:300008347"] > .scope-twist')
        until(page, "() => !!document.querySelector('#scope-tree li[data-aat=\"aat:300008407\"] em')", 15)
        page.click('#scope-tree li[data-aat="aat:300008407"] > .scope-twist')
        until(page, "() => !!document.querySelector('#scope-tree li[data-aat=\"aat:300008419\"] input')", 15)
        guide_box = page.evaluate("() => !!document.querySelector('#scope-tree li[data-aat=\"aat:300008407\"] > label input')")
        roles = page.evaluate("() => document.querySelectorAll('#scope-editor [role=tree], #scope-editor [role=radiogroup], #scope-editor [role=group]').length")
        page.check('#scope-tree li[data-aat="aat:300008419"] input')
        until(page, "() => window.__plato.scope.scope.types.some((t) => t.id === 'aat:300008419')", 15)
        label = page.inner_text('#scope-tree li[data-aat="aat:300008419"] label')
        page.fill('#scope-type-search', 'parish'); page.press('#scope-type-search', 'Enter')
        until(page, "() => !!document.querySelector('#scope-type-found li[data-aat=\"aat:300008419\"]')", 15)
        said = page.inner_text('#scope-live')
        searched = any('/types/tree/search/?q=parish' in u for u in gets)
        expanded = any('/types/expand/?ids=aat%3A300008419' in u or '/types/expand/?ids=aat:300008419' in u for u in gets)
        done()
        r['tree'] = True
        return (not guide_box and roles == 0 and label.strip() == 'parish seats (and 1 narrower type)' and searched and expanded and said == '1 type found.'
                and any(u.endswith('/types/tree/300008347/') for u in gets)), {'label': label, 'guide selectable': guide_box, 'roles': roles, 'live': said, 'gets': [re.sub(r'^https?://[^/]+', '', u) for u in gets][-8:]}
    attempt('Scope: "More types…" opens WHG\'s tree of AAT place types (roots, then a node\'s children, a guide heading not choosable, no tree role it does not keep), searches it (said in the one live region), and a type chosen is expanded by WHG and labelled with its narrower types', tree)

    def leave_goes():
        need('chips')
        page.click('#methodos-leave'); until(page, "() => document.getElementById('methodos-tracker').hidden", 10)
        s = S()
        return (not s['rail'] and s['state']['whose'] == 'tab' and s['state']['scope']['where'] == {'mode': 'countries', 'countries': ['IE']} and not s['state']['scope']['types']
                and r['begun']['rail']), s
    attempt('Scope: leaving the workflow, its Scope goes with it: the tracker\'s line goes, and the lookup panel has this tab\'s own again (Ireland, as it was, never taken in)', leave_goes)

    # Outside a workflow, the lookup panel uses this tab's Scope. The table again, with a base address, so its regions are minted.
    def look(which='all'):
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.select_option('#lookup-places', which)
        n = len(posts)
        page.click('#lookup-send', timeout=T(30) * 1000)
        wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(posts) > n, T(60), 'lookup')
        return [q for b in posts[n:] for q in (b.get('queries') or {}).values()]
    def tab_scope():
        page.evaluate(f"() => {{ const b = document.getElementById('base'); b.value = {json.dumps(MYDATA_BASE)}; b.dispatchEvent(new Event('change')); }}")
        choose([MYDATA_CSV])
        wait_state(page, lambda s: ((s.get('columns') or {}).get('levels') or {}), T(30), 'columns')
        if not page.evaluate("() => document.getElementById('lookup').open"): page.click('#lookup > summary')
        page.fill('#whg-token', LOOKUP_TOKEN); page.press('#whg-token', 'Tab')
        edit()
        page.check('#scope-where-countries')   # Ireland, the tab's, comes back with the mode
        page.uncheck('#scope-c-IE'); page.check('#scope-c-GB')
        page.check('#scope-t-aat\\:300008369')   # Hamlets
        until(page, "() => (window.__plato.scope.scope.types[0] || {}).from === 'whg'", 15)
        page.fill('#scope-start', '1500'); page.press('#scope-start', 'Tab'); page.fill('#scope-end', '1600'); page.press('#scope-end', 'Tab')
        until(page, "() => !!document.getElementById('scope-s-gn')", 15)
        page.check('#scope-s-gn')
        done()
        # The preview is drawn again after each change of the Scope, asynchronously (it reads the places from the worker
        # first): read it once the page says it is the preview of this Scope, not the one drawn before the last box was
        # ticked (the live run of 12 October 2026 read it a moment too soon, once).
        keys = ['countries', 'types', 'start', 'end', 'temporal', 'namespaces']
        drawn = soon(page, "(keys) => JSON.stringify(((window.__plato.lookup || {}).preview || {}).scope || []) === JSON.stringify(keys)", 30, keys)
        preview = page.inner_text('#lookup-preview')
        sent = look()
        r['plain'] = sent
        conditions = {
            'ten queries sent (one per place)': len(sent) == 10,
            'each query carries the Scope as WHG received it': bool(sent) and all(q.get('countries') == ['GB'] and q.get('types') == ['aat:300008369', SCOPE_NARROWER] and q.get('start') == 1500
                and q.get('end') == 1600 and q.get('temporal') is True and q.get('namespaces') == ['gn'] and 'undated' not in q and 'area_only' not in q for q in sent),
            'the preview was drawn for this Scope': drawn,
            'the preview says what is sent': 'The Scope is sent as countries, types, start, end, temporal, namespaces' in preview,
        }
        return all(conditions.values()), {'failed': [k for k, v in conditions.items() if not v], 'n': len(sent), 'sent': sent[:2],
                                          'preview scope': page.evaluate("() => ((window.__plato.lookup || {}).preview || {}).scope || null"), 'preview tail': preview[-300:]}
    attempt('Scope: outside a workflow the tab\'s Scope is sent by the lookup panel, read from what WHG received: countries, types (the type with its narrower one), start, end and temporal, and namespaces; no undated, and the preview says it', tab_scope)

    def empty_row():
        need('plain')
        reached = to_place('Mill Farm')
        said = page.inner_text('#review-place .lookup-state') if page.is_visible('#review-place .lookup-state') else ''
        offered = page.is_visible('#review-place button[data-look="unscoped"]')
        n = len(posts)
        page.click('#review-place button[data-look="unscoped"]')
        wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(posts) > n, T(30), 'unscoped')
        again = [q for b in posts[n:] for q in (b.get('queries') or {}).values()]
        before = next((q for q in r['plain'] if q.get('query') == 'Mill Farm'), {})
        cands = page.eval_on_selector_all('#review-place li.candidate', 'ls => ls.length')
        return (reached and "Nothing within the Scope among WHG's best name matches" in said and offered and before.get('types')
                and len(again) == 1 and again[0].get('query') == 'Mill Farm' and not any(k in again[0] for k in ('types', 'countries', 'start', 'end', 'temporal', 'namespaces'))
                and cands >= 1), {'said': said, 'offered': offered, 'before': before, 'again': again, 'candidates': cands}
    attempt('Scope: a place a scoped lookup found nothing for says so, with the likely cause, and offers "Look it up again without Scope", which sends the place with nothing of the Scope (and finds it)', empty_row)

    def undated_tick():
        need('plain')
        marked = lambda: page.evaluate("() => !!document.querySelector('#lookup-scope [data-mark=\"undated\"]')")
        before = marked()   # years set, the box unticked: undated places left out, and marked (the control)
        edit(); page.check('#scope-undated')
        until(page, "() => window.__plato.scope.scope.when.undated === true", 10)
        done()
        after = marked()
        ticked = look()
        # Ticked, with no years: nothing of When is sent, undated neither (the control for "beside a year").
        edit(); page.fill('#scope-start', ''); page.press('#scope-start', 'Tab'); page.fill('#scope-end', ''); page.press('#scope-end', 'Tab')
        until(page, "() => window.__plato.scope.scope.when.start === null && window.__plato.scope.scope.when.end === null", 10)
        done()
        yearless = look()
        edit(); page.fill('#scope-start', '1500'); page.press('#scope-start', 'Tab'); page.fill('#scope-end', '1600'); page.press('#scope-end', 'Tab')
        until(page, "() => window.__plato.scope.scope.when.end === 1600", 10)
        done()
        unticked = r['plain']
        return (before is True and after is False and len(ticked) == 10 and all(q.get('undated') is True and q.get('start') == 1500 and q.get('end') == 1600 and q.get('temporal') is True for q in ticked)
                and all('undated' not in q for q in unticked) and len(yearless) == 10 and all(not any(k in q for k in ('undated', 'start', 'end', 'temporal')) for q in yearless)), \
            {'marked before': before, 'marked after': after, 'ticked': ticked[:1], 'yearless': yearless[:1]}
    attempt('Scope: "Include places with no dates" ticked sends undated: true beside the years and temporal (unticked, none was sent, and the panel marked them left out; ticked, the mark goes); ticked with no years, nothing of When is sent', undated_tick)

    def types_only():
        need('plain')
        # A Scope of types (and years and sources) alone, and WHG answering the whole first batch with nothing: not a stop.
        edit(); page.check('#scope-where-anywhere'); done()
        empty_types['on'] = True
        try: sent = look()
        finally: empty_types['on'] = False
        s = wait_state(page, lambda s: True, 5)
        lk = s.get('lookup') or {}
        reached = to_place('Hall Green')
        said = page.inner_text('#review-place .lookup-state') if page.is_visible('#review-place .lookup-state') else ''
        return (len(sent) == 10 and all(q.get('types') and 'countries' not in q for q in sent) and lk.get('stopped') is None
                and reached and "Nothing within the Scope among WHG's best name matches" in said and page.is_visible('#review-place button[data-look="unscoped"]')), \
            {'stopped': lk.get('stopped'), 'summary': (lk.get('summary') or '')[:200], 'said': said, 'n': len(sent)}
    attempt('Scope: a Scope of kinds of place, years and sources alone whose first batch WHG answers with nothing is not taken for a filter not applied (no stop): each place says it found nothing within the Scope, and offers the lookup without it', types_only)

    def where_place():
        need('plain')
        edit()
        page.check('#scope-where-place')
        n = len(posts)
        page.fill('#scope-place-q', 'England'); page.click('#scope-place-find')
        until(page, "() => !!document.querySelector('#scope-place-found button')", 15)
        searched = [q for b in posts[n:] for q in (b.get('queries') or {}).values()]
        offered = page.eval_on_selector_all('#scope-place-found li', 'ls => ls.map((l) => l.dataset.id)')
        page.click('#scope-place-found li[data-id="wd:Q21"] button')
        until(page, "() => (window.__plato.scope.scope.where.place || {}).id === 'wd:Q21'", 10)
        done()
        sent = look()
        # Low Mill: WHG could not apply the Where (applied false, nothing): fail-closed, said so, and the lookup without Scope offered.
        reached = to_place('Low Mill')
        said = page.inner_text('#review-place .lookup-state') if page.is_visible('#review-place .lookup-state') else ''
        unscoped = page.is_visible('#review-place button[data-look="unscoped"]')
        return (searched == [{'area_only': True, 'query': 'England', 'type': 'Place', 'limit': 10}] and offered == ['wd:Q21'] and len(sent) == 10
                and all(q.get('contained_in') == ['wd:Q21'] and 'countries' not in q for q in sent)
                and reached and "WHG could not apply the Scope's Where to this place" in said and unscoped), {'searched': searched, 'offered': offered, 'sent': sent[:2], 'Low Mill': said, 'unscoped': unscoped}
    attempt('Scope: Where as a WHG place, found by name for areas only (area_only; a point WHG still offers is not), reaches every query as contained_in, its bare id in a list (wd:Q21); a place WHG could not apply it to (applied false) says so, and offers the lookup without Scope', where_place)

    def where_area():
        need('plain')
        edit()
        before = {'map chunk': map_chunk(), 'map shown': page.evaluate("() => !!document.querySelector('.maplibregl-map')"),
                  'maplibre global': page.evaluate("() => typeof window.maplibregl !== 'undefined'"),
                  'main code': any(re.search(r'/assets/main-[\w-]+\.js$', u) for u in asked)}
        page.check('#scope-where-area')
        until(page, "() => window.__plato.scope.map === 'ready' && !!document.querySelector('#scope-map .maplibregl-canvas')", 60)
        until(page, "() => window.__scope_map && window.__scope_map.isStyleLoaded()", 60)
        page.wait_for_timeout(500)
        box = page.query_selector('#scope-map').bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        # Drawn clockwise: taken counter-clockwise (RFC 7946).
        for px, py in ((x - 120, y - 80), (x + 120, y - 80), (x + 120, y + 80), (x - 120, y + 80), (x - 120, y - 80)): tap(page, px, py)
        until(page, "() => window.__plato.scope.scope.where.mode === 'area'", 15)
        after = {'map chunk': map_chunk(), 'map shown': page.evaluate("() => !!document.querySelector('.maplibregl-map')"),
                 'other sites': sorted({re.match(r'^[a-z]+:(//[^/]*)?', u).group(0) for u in asked
                 if not (u.startswith(origin + '/') or u.startswith('data:') or u.startswith('blob:') or re.match(r'^https://([^/]*\.)?whgazetteer\.org/', u))})}
        done()
        sent = look()
        rings = [((q.get('bounds') or {}).get('coordinates') or [[]])[0] for q in sent]
        ccw = lambda ring: sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) > 0
        r['area'] = True
        return (before['main code'] and not before['map chunk'] and not before['map shown'] and not before['maplibre global'] and after['map chunk'] and after['map shown'] and not after['other sites']
                and len(sent) == 10 and all((q.get('bounds') or {}).get('type') == 'Polygon' and len(ring) == 5 and ring[0] == ring[-1] and ccw(ring) and 'contained_in' not in q for q, ring in zip(sent, rings))), \
            {'before': before, 'after': after, 'bounds': sent[0].get('bounds') if sent else None}
    attempt('Scope: the drawn area\'s map is not loaded until that mode is opened (no map code, no map, no MapLibre global, while the page\'s own code was); opened, Chora\'s map draws on Natural Earth asking no other site, and the area drawn clockwise reaches every query as bounds, a closed counter-clockwise polygon', where_area)

    def area_refused():
        need('area')
        edit()
        until(page, "() => window.__scope_map && window.__scope_map.isStyleLoaded()", 60)
        page.click('#scope-area-draw'); page.wait_for_timeout(300)
        box = page.query_selector('#scope-map').bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        was = S()['state']['scope']['where']
        # A bow tie: its fourth corner would cross the first side; Terra Draw's check refuses it, and that is said.
        for px, py in ((x - 100, y - 60), (x + 100, y + 60), (x + 100, y - 60), (x - 100, y + 60)): tap(page, px, py)
        refused = soon(page, "() => /crosses itself/.test(document.getElementById('scope-live').textContent)", 10)
        said = page.inner_text('#scope-area-say') if page.is_visible('#scope-area-say') else ''
        now = S()['state']['scope']['where']
        page.keyboard.press('Escape'); done()
        return refused and 'crosses itself' in said and now == was and was.get('mode') == 'area', {'said': said, 'live': page.inner_text('#scope-live'), 'where kept': now == was}
    attempt('Scope: an area drawn that crosses itself is refused as it is drawn, said in words beside the map and in the live region, and the area in force is kept', area_refused)

    def regions_override():
        need('plain')
        edit()
        page.check('#scope-where-countries')
        page.fill('#scope-country-filter', 'France'); page.check('#scope-c-FR'); page.fill('#scope-country-filter', '')
        until(page, "() => window.__plato.scope.scope.where.mode === 'countries'", 10)
        done()
        scope_now = S()['state']['scope']
        page.wait_for_function("() => !document.getElementById('regions-offer').hidden", timeout=T(60) * 1000)
        page.click('#regions-start', timeout=T(60) * 1000)
        wait_state(page, lambda s: len(((s.get('work') or {}).get('regions') or {})) == 6, T(60), 'regions')
        art = lambda k: f'#regions-level article[data-rkey="{k}"]'
        sent = {}
        for level in (1, 2):
            page.click(f'#regions-nav button[data-rlevel="{level}"]')
            n = len(posts)
            page.click('#regions-level button[data-rgo="level"]')
            wait_state(page, lambda s: (s.get('lookup') or {}).get('running') is False and len(posts) > n, T(60), f'level {level}')
            sent[level] = [q for b in posts[n:] for q in (b.get('queries') or {}).values()]
            if level == 1:
                w = wait_state(page, lambda s: True, 5).get('work') or {}
                for k, g in (w.get('regions') or {}).items():
                    if g['level'] == 1:
                        page.click(art(k) + ' li.candidate button[data-ract="match"]')
                        wait_state(page, lambda s: (((s.get('work') or {}).get('regions') or {}).get(k) or {}).get('outcome') == 'matched', T(10), 'settled')
        one, two = sent.get(1) or [], sent.get(2) or []
        # The Scope has types, years and sources too (the control that a region is sent none of them because it is a region).
        return (bool(scope_now['types']) and scope_now['when']['start'] == 1500 and scope_now['sources'] == ['gn'] and scope_now['where']['countries'] == ['FR']
                and len(one) == 2 and all(q.get('countries') == ['FR'] and q.get('area_only') is True and 'types' not in q and 'start' not in q and 'namespaces' not in q for q in one)
                and len(two) == 4 and all(q.get('contained_in') in (['gn:2653941'], ['gn:2644974']) and q.get('countries') == ['GB'] and 'types' not in q for q in two)), \
            {'scope': scope_now, 'level 1': one, 'level 2': two}
    attempt('Scope: the table\'s region columns win over Where: with a Scope of countries (FR), kinds of place, years and sources, the widest regions (counties) are sent the countries alone, and the parishes within their county\'s match (contained_in) and its countries, never FR', regions_override)
    try: browser.close()
    except Exception: pass

# ---- Permissions (src/lib/permissions.js) on the main page ------------------------------------------
# The page runs under the Content Security Policy written from the permissions allowed (none, here),
# and every check above ran under it. The panel is the page's, Chora's included; Chora's checks below allow,
# reload, withdraw and forge permissions.
PANEL_STATE = '''() => { const d = document.getElementById('permissions-panel'), a = document.activeElement;
  return { open: !!d && d.open, focus: a ? (a.id || a.name || a.tagName) : null, focusValue: a && a.value || null,
           focusKey: a && a.closest && a.closest('fieldset.perm') ? a.closest('fieldset.perm').dataset.key : null }; }'''

def panel_cycle(page):
    """Open the panel from the header's button, then close it with Esc: where the focus was at each step."""
    page.focus('#permissions-button'); page.keyboard.press('Enter')
    until(page, '() => { const d = document.getElementById("permissions-panel"); return !!d && d.open; }', 10)
    opened = page.evaluate(PANEL_STATE)
    text = page.inner_text('#permissions-panel')
    page.keyboard.press('Escape')
    until(page, '() => !document.getElementById("permissions-panel").open', 10)
    return opened, page.evaluate(PANEL_STATE), text

def strip_head(route):
    """The page as served, without the first script of its <head>: the one that writes its policy."""
    r = route.fetch(); body = r.text()
    a = body.find('<script>\n(function () {'); b = body.find('</script>', a)
    route.fulfill(response=r, body=body[:a] + body[b + len('</script>'):] if a >= 0 and b > a else body)

def main_permissions(ctx, page, url, requests):
    here = urlparse(url).netloc
    def nothing_else():
        foreign = sorted({urlparse(u).netloc for u in requests if urlparse(u).scheme in ('http', 'https') and urlparse(u).netloc != here})
        mine = [u for u in requests if urlparse(u).netloc == here]
        return not foreign and any('/plato/' in u for u in mine), {'foreign': foreign, 'requests here': len(mine)}
    attempt('main page: with nothing allowed, across every check above no request went to any other site (and PLATO\'s files were fetched from this one)', nothing_else)
    def enforced():
        s = wait_state(page, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
        csp = page.evaluate('() => window.__platoCsp || null')
        meta = page.evaluate('() => document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content || null')
        return (s.get('canary') == 'enforced' and csp and csp['origins'] == [] and meta == csp['policy'] and "connect-src 'self' blob:;" in meta), {'canary': s.get('canary'), 'why': s.get('canaryWhy'), 'csp': csp, 'meta': meta}
    attempt('main page: its policy, written first in its <head>, allows no other site, and the canary shows it enforced', enforced)
    def panel():
        opened, closed, text = panel_cycle(page)
        promise = 'Your files stay on your computer, and nothing is sent to any other site unless you allow it.'
        top = page.inner_text('header.top')
        return (opened['open'] and opened['focus'] == 'permissions-h' and not closed['open'] and closed['focus'] == 'permissions-button'
                and promise in text and 'any Pelagios site' in text and top.count(promise) == 1
                and 'sends nothing anywhere' not in page.inner_text('#action')), {'opened': opened, 'closed': closed, 'header': top[:300]}
    attempt('main page: the Permissions panel opens from the header with the focus on its heading, Esc closes it and the focus returns; the promise is said once at the top', panel)
    def no_policy():
        target = NOTOOLS if PROVE else url
        ctx.route(url, strip_head)
        try:
            page.goto(target)
            s = wait_state(page, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
            meta = page.evaluate('() => !!document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')')
        finally:
            ctx.unroute(url, strip_head)
        page.goto(target)
        back = wait_state(page, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
        return s.get('canary') == 'not-enforced' and not meta and back.get('canary') == 'enforced', {'without': s.get('canary'), 'why': s.get('canaryWhy'), 'meta': meta, 'with it again': back.get('canary')}
    attempt('main page: served without the script that writes its policy, the canary says it is not enforced (and with it again, enforced)', no_policy)
    def canary_said():
        # The browser reports the data: request the canary's worker makes, and no page can silence it:
        # the page says, once, that it was the test, and that it was blocked as it should be. Without
        # the policy, the control, it says instead that the page is not protected.
        def heard(route_head):
            p = ctx.new_page(); lines = []
            p.on('console', lambda m: lines.append((m.type, m.text)))
            if route_head: ctx.route(url, strip_head)
            try:
                p.goto(NOTOOLS if PROVE else url)
                s = wait_state(p, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
                p.wait_for_timeout(1000)
                return s.get('canary'), [(t, x) for t, x in lines if x.startswith('PLATO tools:')]
            finally:
                if route_head: ctx.unroute(url, strip_head)
                p.close()
        on, said_on = heard(False); off, said_off = heard(True)
        return (on == 'enforced' and len(said_on) == 1 and said_on[0][0] == 'info' and 'data:text/plain,canary' in said_on[0][1] and 'deliberate test' in said_on[0][1]
                and off == 'not-enforced' and len(said_off) == 1 and said_off[0][0] == 'warning' and 'no policy was written' in said_off[0][1]), {
            'with the policy': (on, said_on), 'without': (off, said_off)}
    attempt('main page: once the canary finds the policy enforced, the page says once, in the console, that the blocked data: request was its test; without the policy it warns instead', canary_said)
    # A policy that is written, and enforced, but is not the one the permissions make: the canary's worker
    # finds data: fetched where it lists data:, and its check of the policy finds one widened to every site.
    def altered(variant):
        def handler(route):
            r = route.fetch(); body = r.text()
            route.fulfill(response=r, body=body.replace('"connect-src \'self\' blob:" + sites', '"connect-src \'self\' blob: ' + variant + '" + sites'))
        return handler
    def wrong_policy():
        target = NOTOOLS if PROVE else url; seen = {}
        for name, variant in (('data', 'data:'), ('wildcard', '*')):
            h = altered(variant); ctx.route(url, h)
            try:
                page.goto(target)
                s = wait_state(page, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
                meta = page.evaluate('() => document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content || ""')
                seen[name] = {'canary': s.get('canary'), 'why': s.get('canaryWhy'), 'altered': ('blob: ' + variant) in meta}
            finally:
                ctx.unroute(url, h)
        page.goto(target)
        back = wait_state(page, lambda s: s.get('canary') in ('enforced', 'not-enforced'), T(15), 'canary')
        d, w = seen.get('data', {}), seen.get('wildcard', {})
        return (d.get('altered') and d.get('canary') == 'not-enforced' and d.get('why') == 'the test request was not stopped'
                and w.get('altered') and w.get('canary') == 'not-enforced' and 'not the one written' in (w.get('why') or '')
                and back.get('canary') == 'enforced'), {**seen, 'as served': back.get('canary')}
    attempt('main page: a policy that lists data:, or one widened to every site, is found not enforced by the canary (its worker, then its check of the policy); as served, enforced', wrong_policy)
    def reload_asks():
        page.goto(NOTOOLS if PROVE else url)
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        page.set_input_files('#picker', [str(PLATO / 'schemas/examples/place-centric-judgements.json')])
        wait_state(page, lambda s: s.get('phase') == 'detected', T(30), 'detected')
        page.evaluate('() => { window.__plato_kept_marker = true; }')   # gone only if the page reloads
        page.click('#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.check('#permissions-panel fieldset.perm[data-key="gazetteer:whg"] input[value="allowed"]')
        page.click('#permissions-panel [data-reload]')
        asked = page.inner_text('#permissions-panel .perm-confirm') if page.is_visible('#permissions-panel .perm-confirm') else ''
        focus = page.evaluate('() => document.activeElement && document.activeElement.hasAttribute("data-reload-cancel")')
        page.click('#permissions-panel [data-reload-cancel]')
        page.wait_for_timeout(500)
        kept = page.evaluate('() => window.__plato.phase') == 'detected' and page.evaluate('() => window.__plato_kept_marker === true')
        page.click('#permissions-panel [data-reload]')
        with page.expect_navigation(timeout=30_000): page.click('#permissions-panel [data-reload-confirmed]')
        s = wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        csp = page.evaluate('() => window.__platoCsp')
        reloaded = page.evaluate('() => !window.__plato_kept_marker')
        page.evaluate("() => localStorage.removeItem('plato-tools.permissions')")
        return ('place-centric-judgements.json' in asked and focus and kept and reloaded and 'https://whgazetteer.org' in csp['origins']), {
            'asked': asked, 'cancel focused': focus, 'kept after cancel': kept, 'reloaded': reloaded, 'policy': csp['origins']}
    attempt('main page: a reload for a permission that would lose the files chosen says so in the panel first; Cancel keeps the page, Reload anyway reloads it with the site in its policy', reload_asks)
    def persist():
        # navigator.storage.persist is counted, and answers no, so that the answer shown is the one given.
        counter = "(() => { window.__persists = 0; if (navigator.storage) navigator.storage.persist = async () => { window.__persists++; return false; }; })()"
        p = ctx.new_page()
        try:
            p.add_init_script(counter)
            p.goto(NOTOOLS if PROVE else url)
            wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            p.evaluate("() => localStorage.removeItem('plato-tools.persist')")
            asked_on_load = p.evaluate('() => window.__persists')
            p.click('#permissions-button')
            until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            p.check('#perm-persist')
            until(p, '() => (document.getElementById("perm-persist-result")?.textContent || "").length > 0', 10)
            said = p.inner_text('#perm-persist-result'); kept = p.evaluate("() => JSON.parse(localStorage.getItem('plato-tools.persist'))")
            p.keyboard.press('Escape'); p.reload()
            wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            p.click('#permissions-button')
            until(p, '() => document.getElementById("permissions-panel")?.open', 10)
            again = {'asked': p.evaluate('() => window.__persists'), 'ticked': p.is_checked('#perm-persist'), 'said': p.inner_text('#perm-persist-result')}
            p.uncheck('#perm-persist'); p.keyboard.press('Escape')
            gone = p.evaluate("() => localStorage.getItem('plato-tools.persist')")
            return (asked_on_load == 0 and 'did not agree' in said and kept and kept.get('granted') is False
                    and again['asked'] == 0 and again['ticked'] and 'did not agree' in again['said'] and gone is None), {
                'asked on load': asked_on_load, 'said': said, 'kept': kept, 'next visit': again, 'after unticking': gone}
        finally:
            p.close()
    attempt('main page: "Keep large datasets\' working files" asks the browser only when ticked, shows and remembers its answer, and is not asked again on the next visit', persist)

# ---- Chora, the map, in the main page (#chora) ------------------------------------------------------
# Chora has a browser profile of its own, so that its storage (the drawings kept, the contributor
# remembered, its SQLite pool) is this run's alone and nothing the main page's checks did is in it.
# The map is WebGL: the software-GL switches are kept as insurance (with none, the map still drew on
# this machine), and --no-gl-flags measures that again. Waits are on the page's own state
# (window.__chora) and on the map instance, never on a fixed sleep.
import csv, math, re, unicodedata
from urllib.parse import urlparse
GL = [] if '--no-gl-flags' in sys.argv else ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
NOTOOLS = 'data:text/html,<title>no tools here</title><input id=picker type=file multiple>'
EX = PLATO / 'schemas/examples'
# Every wait in seconds, in one place. Against the page with no tools every wait fails: sooner. Against
# the deployed site (--url=) the page fetches its chunks (the map's renderer, ink.js) over the network
# from GitHub Pages, where locally they come from this computer: three times as long.
T = (lambda s: min(s, 6)) if PROVE else (lambda s: s * 3) if REMOTE else (lambda s: s)
SPELT = {'œ': 'oe', 'æ': 'ae', 'þ': 'th', 'ð': 'th', 'ß': 'ss', 'ς': 'σ', '\ufffe': '\ufffd', '\uffff': '\ufffd'}
def chora_fold(t):
    """A label or name as Chora's search compares it (fold in src/engine/chora/fold.js): NFKD, marks (every category M)
    and U+0000 and U+0001 dropped, lower case, œ æ þ ð ß ς spelt out."""
    t = ''.join(c for c in unicodedata.normalize('NFKD', t) if not unicodedata.category(c).startswith('M') and c not in '\x00\x01').lower()
    return ''.join(SPELT.get(c, c) for c in t)

def attempt(name, fn):
    """A check made of steps, any of which may raise: a harness error is a failed check, never a crash."""
    try: ok, detail = fn()
    except Exception as e: ok, detail = False, 'harness error: ' + str(e).split('\n')[0][:240]
    check(name, ok, detail)

DIAG = '''() => { const m = window.__chora_map; return { hidden: document.hidden, phase: window.__chora?.phase, mapReadyCount: window.__chora?.mapReadyCount,
  styleLoaded: m ? m.isStyleLoaded() : null, loaded: m ? m.loaded() : null, says: document.getElementById('phase')?.textContent || document.title }; }'''

ASYNC_PREDICATE = re.compile(r'^\s*async\b|\.then\(|\bawait\b')
def until(page, js, timeout=60, arg=None):
    """Wait for `js` to hold; a timeout says what the page was doing (a hidden tab never draws a map, and
    looks exactly like a map that cannot), in the words the page itself shows.

    wait_for_function takes a promise for true at once, so an async predicate (one that reads OPFS, say)
    given to it never waited: three of Chora's maps checks passed that way, and a cancel check pressed
    Cancel at once (October 2026). An async predicate is therefore polled from here, with evaluate(),
    which awaits it; and a predicate given to wait_for_function that returns a promise anyway is
    refused, in the page, rather than taken for true."""
    t0 = time.time()
    # The pages run under a Content Security Policy without 'unsafe-eval', and Playwright evaluates a
    # bare expression with eval(): an expression is given as a function, which it calls instead.
    if not re.match(r'\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>', js): js = f'() => ({js})'
    if ASYNC_PREDICATE.search(js): return poll(page, js, timeout, arg, t0)
    guarded = f'(a) => {{ const r = ({js})(a); if (r && typeof r.then === "function") throw new Error("this wait\'s predicate returned a promise"); return r; }}'
    try: page.wait_for_function(guarded, arg=arg, timeout=T(timeout) * 1000)
    except Exception as e:
        try: d = page.evaluate(DIAG)
        except Exception as e2: d = str(e2).split('\n')[0][:100]
        raise RuntimeError(f'waited {time.time() - t0:.0f}s for {js[:90]!r}: {d} ({str(e).splitlines()[0][:120]})') from e

def poll(page, js, timeout, arg, t0):
    """until() for an async predicate: evaluated again every 50 ms, each answer awaited, until it is truthy."""
    if toolless(page) and timeout > FAST: timeout = FAST; SHORTENED[0] += 1    # the page with no tools: nothing can come
    last = None
    while time.time() - t0 < T(timeout):
        try:
            last = page.evaluate(js, arg)
            if last: return last
        except Exception as e: last = 'error: ' + str(e).split('\n')[0][:120]
        time.sleep(0.05)
    try: d = page.evaluate(DIAG)
    except Exception as e2: d = str(e2).split('\n')[0][:100]
    raise RuntimeError(f'waited {time.time() - t0:.0f}s for {js[:90]!r} (last {last!r}): {d}')

def soon(page, js, timeout=15, arg=None):
    """As until(), but a timeout is an answer (False), for a check that reports what it found instead."""
    try: until(page, js, timeout, arg); return True
    except Exception: return False

def cstate(page):
    return page.evaluate('() => window.__chora ? JSON.parse(JSON.stringify(window.__chora)) : null')

def fixture(src, name, tmp):
    """A copy of a fixture under a name of its own. Drawings are kept per file (its name, size and last
    change), so each check that draws opens a file no other check has drawn on."""
    d = tmp / 'chora-files'; d.mkdir(exist_ok=True)
    shutil.copyfile(src, d / name); return d / name

def chora_boot(page, base, files=None):
    """Open Chora in the main page (#chora) afresh (a navigation, from another page: nothing is carried over in
    memory, and a change of fragment alone would not load the page again), and the files if any."""
    page.bring_to_front(); page.goto('about:blank'); page.goto(NOTOOLS if PROVE else base + '#chora')
    until(page, 'window.__chora && window.__chora.phase === "ready" && window.__chora.mapReadyCount >= 1')
    if files:
        # Chosen in the page's step 1, which Chora shows.
        page.set_input_files('#picker', [str(f) for f in files])
        until(page, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)')
    return cstate(page)

SETTLE = '''() => new Promise((r) => { const m = window.__chora_map, t = setTimeout(() => r(false), 20000);
  const done = () => { clearTimeout(t); r(true); };
  if (!m.isMoving() && m.loaded()) requestAnimationFrame(() => requestAnimationFrame(done)); else m.once('idle', done); })'''

def chora_pick(page, text):
    """Find `text` in the place list and choose the first place found, as a user does; its id."""
    page.fill('#chora-q', text)
    until(page, 't => { const b = [...document.querySelectorAll("#chora-list button[data-id]")]; return b.length && b.every((x) => x.textContent.toLowerCase().includes(t)); }', 20, text.lower())
    pid = page.get_attribute('#chora-list button[data-id]', 'data-id')
    drawn = page.evaluate('window.__chora.mapReadyCount')   # before the change: the place is drawn once it moves
    page.click('#chora-list button[data-id]')
    until(page, 'id => window.__chora.phase === "place" && window.__chora.placeId === id', 30, pid)
    until(page, 'n => window.__chora.mapReadyCount > n', 30, drawn)
    page.evaluate(SETTLE)
    return pid

def rendered(page, layers):
    """Features drawn on the map now, by layer id (a count per name, not one count for all)."""
    return page.evaluate('ls => Object.fromEntries(ls.map((l) => [l, window.__chora_map.getLayer(l) ? window.__chora_map.queryRenderedFeatures({ layers: [l] }).length : -1]))', layers)

def kept(page, name):
    """The drawings kept on the origin private file system for the file called `name`: what a reload finds."""
    # The page may be rewriting a drafts file while it is read (the file listed, then gone): read
    # again, a few times, rather than fail a check on the harness's own timing.
    return page.evaluate('''async (name) => { let d; try { d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts'); } catch { return []; }
      for (let tries = 0; ; tries++) {
        try { for await (const h of d.values()) { const x = JSON.parse(await (await h.getFile()).text()); if (x.fingerprint.split('|')[0] === name) return x.drafts; } return []; }
        catch (e) { if (tries >= 5 || !['NotFoundError', 'SyntaxError'].includes(e.name)) throw e; await new Promise((r) => setTimeout(r, 100)); } } }''', name)

def opfs_names(page, directory):
    return page.evaluate('''async (dir) => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir); const n = [];
      for await (const k of d.keys()) n.push(k); return n; } catch { return []; } }''', directory)

def chora_saved_names(page):
    """The files Chora's saves handed to the page, each in a folder of its own under chora-saved/ (src/chora/app.js, keepSaved)."""
    return page.evaluate('''async () => { const n = []; try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-saved');
      for await (const [, h] of d.entries()) if (h.kind === 'directory') for await (const k of h.keys()) n.push(k); } catch {} return n; }''')

def map_centre(page):
    page.query_selector('#chora-map').scroll_into_view_if_needed()
    b = page.query_selector('#chora-map').bounding_box(); return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

def tap(page, x, y):
    # Terra Draw reads pointer events on the canvas; a mouse arrives at a point before pressing on it.
    page.mouse.move(x - 3, y - 3); page.mouse.move(x, y); page.mouse.down(); page.mouse.up(); page.wait_for_timeout(150)

def draw(page, mode, points):
    page.click(f'#chora-draw-tools button[data-mode="{mode}"]')
    for x, y in points: tap(page, x, y)

def kinds(page):
    return sorted(page.eval_on_selector_all('ul.pending li[data-draft] .kind', 'ks => ks.map((k) => k.textContent)'))

def main_page(ctx, base):
    p = ctx.new_page(); p.bring_to_front(); p.goto(NOTOOLS if PROVE else base)
    if wait_state(p, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
    return p

# ---- The front page: the introduction, the tools chosen first or not at all ---------------------
# Each check finds what it looks for before it trusts an absence, and was seen to fail on the page as
# it was before (no introduction button, the tools in a panel of their own, no Chora row in step 2).
FRONT_FILE = ROOT / 'test/fixtures/lpf-readme-example.json'
VISIBLE = '''(ids) => Object.fromEntries(ids.map((id) => { const e = document.getElementById(id);
  return [id, !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)]; }))'''
ACTIONS = ['check', 'convert', 'compare', 'publish', 'match', 'to-chora']
# Storage refused, as in a private window with site data blocked: every use of localStorage throws.
REFUSE_STORAGE = '''Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });'''
# Whether the introduction was already hidden when it was first parsed, before any paint: an observer
# set before the page's own scripts notes the <html> class at the moment #intro is added.
AT_PARSE = '''window.__introAtParse = null;
new MutationObserver((ms, o) => { const i = document.getElementById('intro'); if (!i) return;
  window.__introAtParse = { htmlHidden: document.documentElement.classList.contains('intro-hidden'), modulesRun: !!window.__plato }; o.disconnect(); })
  .observe(document, { childList: true, subtree: true });'''

# Every report of a violation of the page's Content Security Policy, from before its first script.
CSP_WATCH = "window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));"

def front_page_checks(browser, url):
    def fresh(width=1280, init=(), hash=''):
        ctx = browser.new_context(viewport={'width': width, 'height': 900})
        for s in init: ctx.add_init_script(s)
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        page.goto(NOTOOLS if PROVE else url + hash)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return ctx, page
    def intro_state(page):
        return page.evaluate('''() => { const i = document.getElementById('intro'), b = document.getElementById('intro-toggle');
          const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight);
          return { button: b ? b.innerText.trim() : null, expanded: b?.getAttribute('aria-expanded'), controls: b?.getAttribute('aria-controls'),
                   lede: vis(i?.querySelector('.lede')), drawing: vis(i?.querySelector('.plato-mark')), title: vis(document.querySelector('h1')),
                   stored: (() => { try { return localStorage.getItem('plato-tools.intro'); } catch { return 'refused'; } })() }; }''')

    def settled(page):
        # The introduction folds away and opens with a short animation: wait for it to end (a function,
        # not a string, since the page's policy refuses eval) before reading where it stands.
        page.wait_for_function('() => !(document.getElementById("intro")?.getAnimations?.() || []).length', timeout=T(5) * 1000)
        return intro_state(page)

    def animates():
        ctx, page = fresh()
        try:
            page.click('#intro-toggle')
            mid = page.evaluate('() => ({ running: (document.getElementById("intro").getAnimations() || []).length, expanded: document.getElementById("intro-toggle").getAttribute("aria-expanded") })')
            end = settled(page)
            page.emulate_media(reduced_motion='reduce')
            page.click('#intro-toggle')
            still = page.evaluate('() => (document.getElementById("intro").getAnimations() || []).length')
            shown = intro_state(page)
            return (mid['running'] >= 1 and mid['expanded'] == 'false' and not end['lede'] and still == 0 and shown['lede']), \
                   {'just after the click': mid, 'when it ends': end, 'running with reduced motion': still, 'shown at once': shown}
        finally: ctx.close()
    attempt('front page: hiding the introduction folds it away over a moment (the button says so at once), and with reduced motion asked for it changes at once', animates)

    def toggle_persists():
        ctx, page = fresh()
        try:
            first = intro_state(page)
            page.focus('#intro-toggle'); page.keyboard.press('Enter'); hidden = settled(page)
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30)); after = intro_state(page)
            page.click('#intro-toggle'); shown = settled(page)
            ok = (first['button'] == 'Hide introduction' and first['expanded'] == 'true' and first['controls'] == 'intro' and first['lede'] and first['drawing']
                  and hidden['button'] == 'Show introduction' and hidden['expanded'] == 'false' and not hidden['lede'] and not hidden['drawing'] and hidden['title'] and hidden['stored'] == 'hidden'
                  and after['button'] == 'Show introduction' and after['expanded'] == 'false' and not after['lede'] and after['title']
                  and shown['lede'] and shown['drawing'] and shown['expanded'] == 'true' and shown['stored'] is None)
            return ok, {'first': first, 'hidden': hidden, 'after reload': after, 'shown again': shown}
        finally: ctx.close()
    attempt('front page: "Hide introduction" hides the paragraph and the drawing, not the title, and they stay hidden after a reload until shown again', toggle_persists)

    def before_paint():
        # Under the page's Content Security Policy (script-src 'self', written by the one inline script,
        # the first in <head>): the introduction's own script is a file from the site, and the browser
        # reports no violation of the policy.
        ctx, page = fresh(init=[AT_PARSE, CSP_WATCH, "try { localStorage.setItem('plato-tools.intro', 'hidden'); } catch {}"])
        try:
            at = page.evaluate('() => window.__introAtParse')
            heads = page.evaluate('''() => { const inline = [...document.querySelectorAll('script:not([src])')].filter((s) => s.textContent.trim());
              const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
              return { classic: [...document.head.querySelectorAll('script[src]')].filter((s) => !s.type || s.type === 'text/javascript').map((s) => new URL(s.src).pathname),
                inline: inline.length, inlineIsPolicyWriter: inline.length === 1 && inline[0] === document.head.querySelector('script'),
                scriptSrc: (meta.match(/script-src[^;]*/) || [''])[0], violations: window.__cspViolations || null }; }''')
            same_origin = [p.rsplit('/', 1)[-1] for p in heads['classic']] == ['theme.js', 'intro.js']
            policy_ok = "'self'" in heads['scriptSrc'] and 'unsafe-inline' not in heads['scriptSrc'] and 'unsafe-eval' not in heads['scriptSrc']
            return (bool(at) and at['htmlHidden'] is True and at['modulesRun'] is False and same_origin and heads['inlineIsPolicyWriter']
                    and policy_ok and heads['violations'] == []), {'when #intro was parsed': at, 'scripts': heads}
        finally: ctx.close()
    attempt('front page: a hidden introduction is hidden as the page is parsed, before its modules run, by a script file of its own (beside the theme\'s) that the page\'s policy allows (no violation)', before_paint)

    def refused():
        ctx, page = fresh(init=[REFUSE_STORAGE])
        try:
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
            first = intro_state(page); page.click('#intro-toggle'); hidden = settled(page)
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30)); after = intro_state(page)
            return (first['stored'] == 'refused' and first['lede'] and hidden['button'] == 'Show introduction' and not hidden['lede'] and hidden['expanded'] == 'false'
                    and after['lede'] and after['button'] == 'Hide introduction' and not errors), {'first': first, 'hidden': hidden, 'after reload': after, 'errors': errors}
        finally: ctx.close()
    attempt('front page: with storage refused, the introduction is shown, still hides when asked, is shown again after a reload, and nothing fails', refused)

    def all_actions():
        ctx, page = fresh()
        try:
            text = FRONT_FILE.read_text()
            page.evaluate('''(text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
              document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }''', text)
            s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
            vis = page.evaluate(VISIBLE, ACTIONS + ['for-tool'])
            chora = page.evaluate("() => { const a = document.getElementById('to-chora'); return a ? [a.getAttribute('href'), a.textContent.trim()] : null; }")
            current = page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.length')
            return (s.get('phase') == 'detected' and all(vis[a] for a in ACTIONS) and not vis['for-tool'] and current == 0
                    and chora and chora[0] == '#chora' and 'Show on the map (Chora)' in chora[1]), {'state': s.get('phase'), 'visible': vis, 'chora': chora, 'cards marked': current}
        finally: ctx.close()
    attempt('front page: a file dropped with no tool chosen offers every action, Chora\'s map included, and marks no tool', all_actions)

    def narrowed():
        ctx, page = fresh()
        try:
            page.set_input_files('#picker', str(FRONT_FILE))
            wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
            seen, n0 = {}, page.evaluate('() => history.length')
            for key, shown in (('check', ['check']), ('convert', ['convert']), ('figures', ['convert']), ('versions', ['compare']), ('publish', ['publish']), ('match', ['match'])):
                page.click(f'#toolbox .tool-link[href="#tool={key}"]')
                vis = page.evaluate(VISIBLE, ACTIONS)
                seen[key] = {'shown': [a for a in ACTIONS if vis[a]], 'hash': page.evaluate('() => location.hash'), 'focus': page.evaluate('() => document.activeElement?.id'),
                             'current': page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.map((e) => e.getAttribute("href"))'),
                             'note': page.inner_text('#for-tool'), 'target': page.input_value('#target'), 'cube': page.is_checked('#cube')}
                seen[key]['ok'] = seen[key]['shown'] == shown and seen[key]['hash'] == f'#tool={key}' and seen[key]['current'] == [f'#tool={key}']
            fig = seen['figures']; fig['ok'] = fig['ok'] and fig['target'] == 'ntriples' and fig['cube'] and 'Arithmos' in fig['note']
            # Leaving Arithmos undoes its preset: the format chosen before it, and no Data Cube option.
            left = seen['versions']; left['ok'] = left['ok'] and left['target'] == seen['convert']['target'] != 'ntriples' and not left['cube']
            # And so does "Show every action", straight from Arithmos.
            page.click('#toolbox .tool-link[href="#tool=figures"]'); again = (page.input_value('#target'), page.is_checked('#cube'))
            page.click('#every-action'); back = page.evaluate(VISIBLE, ACTIONS); hash_after = page.evaluate('() => location.hash')
            after_all = (page.input_value('#target'), page.is_checked('#cube'))
            return (all(v['ok'] for v in seen.values()) and all(back.values()) and hash_after == '' and page.evaluate('() => history.length') == n0
                    and again == ('ntriples', True) and after_all == (seen['convert']['target'], False)), {'per tool': seen, 'every action again': back, 'hash': hash_after, 'Arithmos again': again, 'after every action': after_all}
        finally: ctx.close()
    attempt('front page: choosing a tool\'s card narrows step 2 to that tool (Arithmos: N-Triples with the Data Cube option, undone on leaving it), and "Show every action" undoes it', narrowed)

    def figures_on_ntriples():
        # Arithmos with a file that is already N-Triples: the step offers the check and says why, rather
        # than a heading about converting over a list without N-Triples in it.
        ctx, page = fresh(hash='#tool=figures')
        try:
            nt = '<https://example.org/p/a> <http://www.w3.org/2000/01/rdf-schema#label> "A" .\n'
            page.evaluate('''(text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'figures.nt', { type: 'application/n-triples' }));
              document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }''', nt)
            s = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection')
            vis = page.evaluate(VISIBLE, ACTIONS); heading = page.inner_text('#action-h')
            return (s.get('format') == 'ntriples' and vis['check'] and not vis['convert'] and 'already N-Triples' in heading
                    and not any(vis[a] for a in ACTIONS if a != 'check')), {'state': s.get('format'), 'visible': vis, 'heading': heading}
        finally: ctx.close()
    attempt('front page: Arithmos with a file already in N-Triples offers the check, and says it is already N-Triples', figures_on_ntriples)

    def touch():
        # On a touch screen a first tap on a card's name shows its tooltip and chooses nothing (and Chora's
        # opens no map); a second tap chooses (and opens it).
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        try:
            page.goto(NOTOOLS if PROVE else url)
            if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
            name = '#toolbox .tool-link[href="#tool=check"] .why'
            page.tap(name); page.wait_for_timeout(300)
            first = {'tip': shown_tips(page, 'ἔλεγχος', 3), 'hash': page.evaluate('() => location.hash'), 'tool': page.evaluate('() => window.__plato.tool ?? null')}
            page.tap(name); page.wait_for_timeout(300)
            second = {'hash': page.evaluate('() => location.hash'), 'tool': page.evaluate('() => window.__plato.tool ?? null')}
            card = '#toolbox .tool-link[href="#chora"] .why'
            page.tap(card); page.wait_for_timeout(500)
            chora = {'tip': shown_tips(page, 'χώρα', 3), 'hash': page.evaluate('() => location.hash'), 'shown': page.evaluate('() => !document.getElementById("chora").hidden')}
            page.tap(card); page.wait_for_timeout(500)
            chora2 = {'hash': page.evaluate('() => location.hash'), 'shown': page.evaluate('() => !document.getElementById("chora").hidden')}
            return (len(first['tip']) == 1 and first['hash'] == '' and first['tool'] is None and second['hash'] == '#tool=check' and second['tool'] == 'check'
                    and len(chora['tip']) == 1 and chora['hash'] == '#tool=check' and not chora['shown'] and chora2 == {'hash': '#chora', 'shown': True}), {
                'first tap': first, 'second tap': second, 'Chora first tap': chora, 'Chora second tap': chora2}
        finally: ctx.close()
    attempt('front page on a touch screen: a first tap on a card\'s name shows its tooltip and chooses nothing; a second tap chooses', touch)

    def focus_step1():
        ctx, page = fresh()
        try:
            page.focus('#toolbox .tool-link[href="#tool=check"]'); page.keyboard.press('Enter')
            # The scroll to step 1 is smooth, and Elenchos is now a group further down than it was, so
            # the heading is measured once the scroll has settled (or after 3 s, as it then is).
            try: page.wait_for_function('() => { const t = document.activeElement?.getBoundingClientRect().top; return t >= 0 && t < 900; }', timeout=3000)
            except Exception: pass
            el = page.evaluate('''() => { const a = document.activeElement; return { id: a?.id, tabindex: a?.getAttribute('tabindex'), text: a?.textContent.trim(),
              top: Math.round(a?.getBoundingClientRect().top ?? -1) }; }''')
            hermes = None
            page.click('#toolbox .tool-link[data-tool="read"]')
            hermes = {'focus': page.evaluate('() => document.activeElement?.id'), 'hash': page.evaluate('() => location.hash'), 'current': page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.map((e) => e.dataset.tool ?? e.id)')}
            return (el['id'] == 'files-h' and el['tabindex'] == '-1' and 'Choose your data' in el['text'] and 0 <= el['top'] < 900
                    and hermes['focus'] == 'picker' and hermes['hash'] == '' and hermes['current'] == ['read']), {'after a card': el, 'after Hermes': hermes}
        finally: ctx.close()
    attempt('front page: a card chosen by keyboard moves focus to step 1\'s heading, in view; Hermes\'s card goes to the drop zone, is marked chosen, and keeps no #tool=', focus_step1)

    def by_address():
        ctx, page = fresh(hash='#tool=publish')
        try:
            page.set_input_files('#picker', str(FRONT_FILE))
            wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
            vis = page.evaluate(VISIBLE, ACTIONS)
            heading = page.inner_text('#action-h')
            page.evaluate("() => { location.hash = '#tool=nonsense'; }"); page.wait_for_timeout(200)
            unknown = page.evaluate(VISIBLE, ACTIONS)
            return (vis['publish'] and not any(vis[a] for a in ACTIONS if a != 'publish') and 'publishing' in heading and all(unknown.values())), {'#tool=publish': vis, 'heading': heading, '#tool=nonsense': unknown}
        finally: ctx.close()
    attempt('front page: the address #tool=publish narrows step 2 to publishing when the page opens, and an unknown tool narrows nothing', by_address)

    def phone():
        out = {}
        for state in ('shown', 'hidden'):
            ctx, page = fresh(390, init=[] if state == 'shown' else ["try { localStorage.setItem('plato-tools.intro', 'hidden'); } catch {}"])
            try:
                page.set_input_files('#picker', str(FRONT_FILE)); wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
                out[state] = page.evaluate('''() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth,
                  cards: [...document.querySelectorAll('#toolbox .tool')].map((t) => Math.round(t.getBoundingClientRect().left)),
                  drawing: !!document.querySelector('#intro .plato-mark')?.offsetWidth, chora: !!document.getElementById('to-chora')?.offsetWidth })''')
            finally: ctx.close()
        s, h = out.get('shown', {}), out.get('hidden', {})
        return (s and h and s['scroll'] <= 390 and h['scroll'] <= 390 and len(s['cards']) == 10 and len(set(s['cards'])) == 1
                and s['drawing'] and not h['drawing'] and s['chora']), out
    attempt('front page at 390 px: one column of the ten cards, step 2 with Chora\'s row, and no sideways scroll, with the introduction shown or hidden', phone)

    def planned():
        # Peripleo is planned, not here: its card says so, links nowhere (bar its More), and choosing it
        # changes nothing. Methodos's card, once planned too, is a link now (methodos_checks).
        out = {}
        for name, label in (('Peripleo', 'Visualisation'),):
            ctx, page = fresh()
            try:
                page.set_input_files('#picker', str(FRONT_FILE))
                wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
                before = page.evaluate(VISIBLE, ACTIONS)
                card = page.evaluate("""(name) => { const c = [...document.querySelectorAll('#toolbox .tool')].find((t) => t.querySelector('h4')?.textContent.trim() === name);
                  return c && { badge: c.querySelector('.badge')?.textContent.trim(), label: c.querySelector('.label')?.textContent.trim(), coming: c.classList.contains('coming'),
                    links: [...c.querySelectorAll('a, button')].filter((e) => !e.closest('details')).length, choose: /Choose/.test(c.textContent), visible: !!c.offsetWidth }; }""", name)
                page.click(f'#toolbox .tool.coming h4:has-text("{name}")')
                after = page.evaluate(VISIBLE, ACTIONS)
                hash, tool, current = page.evaluate('() => location.hash'), page.evaluate('() => window.__plato.tool ?? null'), page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.length')
                out[name] = (bool(card) and card['visible'] and card['coming'] and card['badge'] == 'Planned' and card['label'] == label and card['links'] == 0 and not card['choose']
                             and all(before.values()) and after == before and hash == '' and tool is None and current == 0), {'card': card, 'before': before, 'after': after, 'hash': hash, 'tool': tool}
            finally: ctx.close()
        return len(out) == 1 and all(v[0] for v in out.values()), {k: v[1] for k, v in out.items()}
    attempt('front page: Peripleo\'s card says it is planned, is not a link and offers no Choose, and choosing it leaves step 2 as it was', planned)

    def grouped():
        # The cards are grouped under plain headings, in the order decided (docs/plans/methodos.md, 11.2):
        # each group a list labelled by the heading just before it, Methodos first of all the cards and
        # Peripleo last. The control that can fail: the names are compared in full and in order, and a
        # real card (Elenchos) chosen from its group still sets #tool=check and aria-current.
        ctx, page = fresh()
        try:
            got = page.evaluate("""() => [...document.querySelectorAll('#toolbox h3.tool-group')].map((h) => { const ul = h.nextElementSibling;
              return { heading: h.textContent.trim(), visible: !!h.offsetWidth, list: ul?.matches('ul.tools.choose') && ul.getAttribute('aria-labelledby') === h.id,
                       cards: ul ? [...ul.children].map((li) => li.tagName === 'LI' ? li.querySelector('h4')?.textContent.trim() : '!' + li.tagName) : [] }; })""")
            first = page.evaluate("() => { const c = document.querySelector('#toolbox .tool'); return c && { name: c.querySelector('h4')?.textContent.trim(), coming: c.classList.contains('coming'), link: !!c.querySelector('.tool-link') }; }")
            every = page.eval_on_selector_all('#toolbox .tool', 'es => es.length')
            # The groups flow (Stephen, 2 October) where the cards are a grid below the steps (from 60rem to
            # 78rem, here 1200 px: three columns): a group of one shares a row with the next, so Start here
            # sits beside Bring your data in, and Publish and keep beside Explore; the groups of three and two
            # that follow each other start rows of their own. Tops of the headings, by group. From 78rem (1280
            # px) the tools are a rail of one column left of the steps (Issue #33): one left edge, each group below the last.
            heads = """() => Object.fromEntries([...document.querySelectorAll('#toolbox h3.tool-group')].map((h) => [h.id.slice(3), [Math.round(h.getBoundingClientRect().top), Math.round(h.getBoundingClientRect().left)]]))"""
            page.set_viewport_size({'width': 1280, 'height': 900}); page.wait_for_timeout(100)
            rail = page.evaluate(heads)
            page.set_viewport_size({'width': 1200, 'height': 900})
            rows = {k: v[0] for k, v in page.evaluate(heads).items()}
            vw = page.evaluate('() => innerWidth')
            page.set_viewport_size({'width': 1280, 'height': 900})
            order = ['start', 'in', 'check', 'locate', 'publish', 'explore']
            one_column = len(rail) == 6 and len({v[1] for v in rail.values()}) == 1 and all(rail[a][0] < rail[b][0] for a, b in zip(order, order[1:]))
            page.click('#toolbox ul[aria-labelledby="tg-check"] .tool-link[data-tool="check"]')
            chose = {'hash': page.evaluate('() => location.hash'), 'tool': page.evaluate('() => window.__plato.tool ?? null'),
                     'current': page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.map((e) => e.dataset.tool)')}
            want = [('Guided workflows', ['Methodos']), ('Bring your data in', ['Hermes']), ('Check and convert', ['Elenchos', 'Metaphrasis', 'Arithmos']),
                    ('Identify and locate', ['Krisis', 'Chora']), ('Publish and keep', ['Agora', 'Mneme']), ('Explore', ['Peripleo'])]
            return ([(g['heading'], g['cards']) for g in got] == want and all(g['visible'] and g['list'] for g in got) and every == 10
                    and first == {'name': 'Methodos', 'coming': False, 'link': True}
                    and chose == {'hash': '#tool=check', 'tool': 'check', 'current': ['check']}
                    and vw == 1200 and rows.get('start') == rows.get('in') and rows.get('publish') == rows.get('explore')
                    and rows['in'] < rows['check'] < rows['locate'] < rows['publish'] and one_column), {'groups': got, 'first card': first, 'cards': every, 'Elenchos chosen': chose, 'heading tops at 1200 px': rows, 'width': vw, 'the rail at 1280 px (top, left)': rail}
        finally: ctx.close()
    attempt('front page: the ten cards are in six groups under plain headings, in the order decided, Methodos (a link to its interview) first, the groups of one sharing a row as cards below the steps and in one column as the tools rail, and a card in a group is still chosen', grouped)

    def guide_links():
        # The masthead's Guide and step 1's temPlato link go where the guide has them: the presence is
        # each visible with its exact address, and the control that can fail is the pinned PLATO's own
        # docs, which must hold the guide's tools page and the "Get temPlato" heading the anchor names.
        ctx, page = fresh()
        try:
            got = page.evaluate("""() => Object.fromEntries([['guide', '.masthead-side a#guide-link'], ['templato', '#drop a#get-templato']].map(([k, q]) => {
              const a = document.querySelector(q); return [k, a && { href: a.getAttribute('href'), text: a.textContent.trim(), visible: !!a.offsetWidth }]; }))""")
        finally: ctx.close()
        g = 'https://pelagios.org/place-attestation-ontology/guide/'
        docs = {'tools.md': (PLATO / 'docs/tools.md').is_file(),
                'Get temPlato': any(l.strip() == '## Get temPlato' for l in (PLATO / 'docs/spreadsheets/index.md').read_text().splitlines()) if (PLATO / 'docs/spreadsheets/index.md').is_file() else False}
        return (got.get('guide') == {'href': g + 'tools.html', 'text': 'Guide', 'visible': True}
                and got.get('templato') == {'href': g + 'spreadsheets/index.html#get-templato', 'text': 'temPlato', 'visible': True} and all(docs.values())), {'links': got, 'in the pinned guide': docs}
    attempt('front page: the masthead links to the guide, and step 1 to the guide\'s "Get temPlato", both found in the pinned PLATO docs', guide_links)

    def example_files():
        # Step 1 offers example files to try, and the zip is served from the site.
        ctx, page = fresh()
        try:
            href = page.evaluate("() => { const a = document.querySelector('#drop a#try-files'); return a && a.offsetWidth ? a.getAttribute('href') : null; }")
            got = page.evaluate("""async (h) => { const r = await fetch(h); const b = new Uint8Array(await r.arrayBuffer());
              return { status: r.status, magic: String.fromCharCode(b[0], b[1]), size: b.length }; }""", href) if href else None
            return (href == './try/plato-tools-try-files.zip' and got and got['status'] == 200 and got['magic'] == 'PK' and got['size'] > 100_000), {'link': href, 'served': got}
        finally: ctx.close()
    attempt('front page: step 1 links to the example files, and the zip is served (200, a zip)', example_files)

    def card_details():
        # Each card has a "More" section, closed: opened, it shows its text and reads "Less", and leaves
        # the tool chosen (#tool=check here) and step 2 as they were. Chora's speaks of tracing from a
        # historical map, and Krisis's of looking places up in the World Historical Gazetteer, as things
        # they do now, with nothing coming next.
        # Krisis's WHG sentence (the lookup landed with Krisis change 2): the control for "nothing coming next"
        # is that the sentence IS there, in the body, and names what is sent nowhere but where allowed.
        KRISIS_NOW = 'look your places up in the World Historical Gazetteer, or another reconciliation service, online and only if you allow it'
        ctx, page = fresh(hash='#tool=check')
        try:
            page.set_input_files('#picker', str(FRONT_FILE))
            wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
            before = {'shown': page.evaluate(VISIBLE, ACTIONS), 'hash': page.evaluate('() => location.hash'), 'url': page.url}
            STATE = """() => [...document.querySelectorAll('#toolbox .tools > li')].map((li) => {
              const d = li.querySelector(':scope > details.more'), s = d?.querySelector('summary'), body = d?.querySelector('.more-body');
              const coming = [...(body?.querySelectorAll('.coming-next') || [])].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());
              const rest = body ? (() => { const c = body.cloneNode(true); c.querySelectorAll('.coming-next').forEach((e) => e.remove()); return c.textContent; })() : '';
              const links = [...(body?.querySelectorAll('a[href]') || [])].map((a) => a.href);
              return { name: li.querySelector('h4')?.textContent.trim(), has: !!d, open: !!d?.open, said: s ? [...s.querySelectorAll('span:not(.visually-hidden)')].filter((e) => e.getClientRects().length).map((e) => e.textContent).join('').trim() : null,
                       named: !!s && s.textContent.includes(li.querySelector('h4')?.textContent.trim() || '?'),
                       body: body && body.offsetHeight > 0 ? body.innerText.trim().length : 0, coming, rest: rest.replace(/\\s+/g, ' '), links,
                       insideLink: !!d?.closest('a') }; })"""
            closed = page.evaluate(STATE)
            opened, kept = [], True
            for n in range(1, len(closed) + 1):
                page.locator('#toolbox .tools > li').nth(n - 1).locator(':scope > details.more > summary').click()
                page.wait_for_timeout(100)
                now = {'shown': page.evaluate(VISIBLE, ACTIONS), 'hash': page.evaluate('() => location.hash'), 'url': page.url}
                kept = kept and now == before and page.evaluate('() => window.__plato.tool ?? null') == 'check'
                opened.append(page.evaluate(STATE)[n - 1])
            # By keyboard: Enter on a focused summary closes it again, and it reads "More".
            page.locator('#toolbox .tools > li').nth(0).locator(':scope > details.more > summary').focus(); page.keyboard.press('Enter'); page.wait_for_timeout(100)
            again = page.evaluate(STATE)[0]
            guide = 'https://pelagios.org/place-attestation-ontology/guide/'
            by = {c['name']: c for c in opened}
            chora, krisis, peripleo, methodos = by.get('Chora', {}), by.get('Krisis', {}), by.get('Peripleo', {}), by.get('Methodos', {})
            ok = (len(closed) == 10 and all(c['has'] and not c['open'] and c['said'] == 'More' and c['body'] == 0 and c['named'] and not c['insideLink'] for c in closed)
                  and all(c['open'] and c['said'] == 'Less' and c['body'] > 60 for c in opened) and kept
                  and all(c['links'] and c['links'][-1].startswith(guide) for c in opened if c['name'] not in ('Peripleo', 'Methodos')) and peripleo.get('links') == []
                  and methodos.get('links') == ['https://github.com/pelagios/plato-tools/issues']
                  and chora.get('coming') == [] and 'and trace places from it by hand or with assistance from its ink: what you trace cites the map' in chora.get('rest', '')
                  and krisis.get('coming') == [] and KRISIS_NOW in krisis.get('rest', '')
                  and not again['open'] and again['said'] == 'More')
            return ok, {'closed': closed, 'opened': opened, 'step 2 and #tool kept': kept, 'before': before, 'first, closed by Enter': again}
        finally: ctx.close()
    attempt('front page: each of the ten cards has a closed "More"; opened, it shows its text and reads "Less", and leaves #tool= and step 2 as they were; Chora\'s tracing and Krisis\'s WHG lookup are in the present tense, with nothing "coming next"', card_details)

    def card_details_phone():
        # At a phone's width, with every card's More open, the cards stay one column, with no sideways scroll.
        ctx, page = fresh(390)
        try:
            page.evaluate("() => document.querySelectorAll('#toolbox details.more').forEach((d) => { d.open = true; })")
            r = page.evaluate('''() => ({ scroll: document.documentElement.scrollWidth, open: document.querySelectorAll('#toolbox details.more[open]').length,
              cards: [...document.querySelectorAll('#toolbox .tool')].map((t) => [Math.round(t.getBoundingClientRect().left), Math.round(t.getBoundingClientRect().right)]) })''')
            return r['open'] == 10 and r['scroll'] <= 390 and len(r['cards']) == 10 and len(set(map(tuple, r['cards']))) == 1 and r['cards'][0][1] <= 390, r
        finally: ctx.close()
    attempt('front page at 390 px: with every card\'s More open, one column of ten cards and no sideways scroll', card_details_phone)

    # The acknowledgement of ISHI ends the footer: a rebase once dropped it unseen. The map's credits are
    # there too, since Chora came into the page (13 October 2026).
    ISHI ='Development has been supported by the Institute for Spatial History Innovation (ISHI) at the University of Pittsburgh.'
    def acknowledged():
        ctx = browser.new_context(); page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        try:
            page.goto(NOTOOLS if PROVE else url)
            found = page.evaluate("""() => { const f = document.querySelector('footer'), a = f?.querySelector('a[href="https://www.ishi.pitt.edu/"]');
              return { text: (f?.textContent || '').replace(/\\s+/g, ' '), link: a ? a.textContent.trim() : null,
                map: ['https://www.naturalearthdata.com/', 'https://maplibre.org/', 'https://allmaps.org/', 'https://terradraw.io/'].filter((h) => f?.querySelector(`a[href="${h}"]`)).length }; }""")
        finally: ctx.close()
        return (ISHI in found['text'] and found['text'].rstrip().endswith(ISHI) and found['link'] == 'Institute for Spatial History Innovation (ISHI)' and found['map'] == 4), found
    attempt('the page: the footer credits the map (Natural Earth, MapLibre GL JS, Allmaps, Terra Draw), and ends acknowledging ISHI, with its link', acknowledged)

# ---- The colour theme (public/theme.js): Auto, Light or Dark, on the page and on Chora in it ---------------
# The browser is told which scheme the device prefers (color_scheme), and the page's colours are
# measured, not only its attributes read: the page's background, a panel's, and on the main page the
# band of a tool's card (cobalt in light, light blue in dark) and the drawing's inversion. Each check
# sees both schemes, so a page that never changes cannot pass one, and the switch must be there to be used.
THEME_STATE = """() => { const lum = (c) => { const m = c && c.match(/[\\d.]+/g); if (!m) return null; const [r, g, b] = m.map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? 'light' : 'dark'; };
  const css = (e, p) => e ? getComputedStyle(e)[p] : null, root = document.documentElement, group = document.getElementById('theme-switch');
  const checked = group ? [...group.querySelectorAll('input[name="plato-theme"]')].filter((i) => i.checked).map((i) => i.value) : null;
  return { page: lum(css(document.body, 'backgroundColor')), body: css(document.body, 'backgroundColor'), panel: lum(css(document.getElementById('files') || document.getElementById('chora-files'), 'backgroundColor')),
    band: css(document.querySelector('#toolbox .tool:not(.coming) .icon'), 'stroke'), mark: css(document.querySelector('#intro .plato-mark'), 'filter'),
    colorScheme: css(root, 'colorScheme'), attr: root.getAttribute('data-theme'), checked, group: !!group && !!group.offsetWidth,
    stored: (() => { try { return localStorage.getItem('plato-tools.theme'); } catch { return 'refused'; } })(),
    violations: window.__cspViolations || null, atParse: window.__themeAtParse }; }"""
# The theme on <html> at the moment <body> is parsed, before any paint and before the page's modules run.
THEME_AT_PARSE = """window.__themeAtParse = null;
new MutationObserver((ms, o) => { if (!document.body) return; window.__themeAtParse = { attr: document.documentElement.getAttribute('data-theme'), modulesRun: !!(window.__plato || window.__chora) }; o.disconnect(); })
  .observe(document, { childList: true, subtree: true });"""
THEME_PAGES = (('index', ''), ('chora', '#chora'))   # the page, and the page with Chora shown
COBALT, IRIS = 'rgb(31, 69, 184)', 'rgb(124, 196, 242)'

def theme_checks(browser, url):
    def opened(scheme, name, init=(), ctx=None):
        ctx = ctx or browser.new_context(viewport={'width': 1280, 'height': 900}, color_scheme=scheme)
        for s in (CSP_WATCH, THEME_AT_PARSE, *init): ctx.add_init_script(s)
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)[:160]))
        page.goto(NOTOOLS if PROVE else url + name)
        return ctx, page, errors
    def state(page):
        # At #chora (after a reload too), Chora shown with its panel first, so that what is measured is the page with the map in it.
        if '#chora' in page.url: page.wait_for_function('() => !!window.__chora && !document.getElementById("chora").hidden && !!document.getElementById("chora-panel")', timeout=T(30) * 1000)
        return page.evaluate(THEME_STATE)
    def choose(page, theme): page.click(f'#theme-switch label:has(input[value="{theme}"])')
    def clean(*ss): return all(s['violations'] == [] for s in ss)
    def each_page(fn):
        out = {}
        for key, name in THEME_PAGES:
            ok, detail = fn(key, name); out[key] = detail
            if not ok: return False, out
        return True, out

    def light_under_dark(key, name):
        ctx, page, errors = opened('dark', name)
        try:
            a = state(page); choose(page, 'light'); b = state(page)
            page.reload(); c = state(page)
            choose(page, 'auto'); d = state(page)
            main = key != 'index' or (a['band'] == IRIS and a['mark'] == 'invert(1)' and b['band'] == COBALT and b['mark'] == 'none' and c['band'] == COBALT)
            return (a['group'] and a['checked'] == ['auto'] and a['page'] == 'dark' and a['panel'] == 'dark' and a['attr'] is None and a['colorScheme'] == 'dark'
                    and b['checked'] == ['light'] and b['page'] == 'light' and b['panel'] == 'light' and b['attr'] == 'light' and b['colorScheme'] == 'light' and b['stored'] == 'light'
                    and c['checked'] == ['light'] and c['page'] == 'light' and c['atParse'] == {'attr': 'light', 'modulesRun': False}
                    and d['checked'] == ['auto'] and d['page'] == 'dark' and d['attr'] is None and d['stored'] is None
                    and main and clean(a, b, c, d) and not errors), {'auto': a, 'light': b, 'after reload': c, 'auto again': d, 'errors': errors}
        finally: ctx.close()
    attempt('theme, the page and Chora in it: under a device set to dark, Light chosen gives light colours (page, panels, tool bands, drawing, native controls), set before the page is painted after a reload, and Auto gives dark again', lambda: each_page(light_under_dark))

    def auto_follows(key, name):
        ctx, page, errors = opened('light', name)
        try:
            a = state(page); page.emulate_media(color_scheme='dark'); b = state(page); page.emulate_media(color_scheme='light'); c = state(page)
            return (a['group'] and a['checked'] == ['auto'] and a['page'] == 'light' and a['colorScheme'] == 'light' and b['page'] == 'dark' and b['panel'] == 'dark' and b['colorScheme'] == 'dark'
                    and c['page'] == 'light' and a['attr'] is None and b['attr'] is None and clean(a, b, c) and not errors), {'light': a, 'dark': b, 'light again': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, the page and Chora in it: Auto follows the device\'s setting both ways, light to dark and back, with no reload', lambda: each_page(auto_follows))

    def dark_under_light(key, name):
        ctx, page, errors = opened('light', name)
        try:
            a = state(page); choose(page, 'dark'); b = state(page); page.reload(); c = state(page)
            return (a['group'] and a['page'] == 'light' and b['checked'] == ['dark'] and b['page'] == 'dark' and b['panel'] == 'dark' and b['colorScheme'] == 'dark' and b['attr'] == 'dark'
                    and b['stored'] == 'dark' and c['page'] == 'dark' and c['checked'] == ['dark'] and c['atParse'] == {'attr': 'dark', 'modulesRun': False}
                    and (key != 'index' or (a['band'] == COBALT and b['band'] == IRIS)) and clean(a, b, c) and not errors), {'light': a, 'dark': b, 'after reload': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, the page and Chora in it: under a device set to light, Dark chosen gives dark colours, and is kept after a reload', lambda: each_page(dark_under_light))

    def refused(key, name):
        ctx, page, errors = opened('dark', name, init=[REFUSE_STORAGE])
        try:
            a = state(page); choose(page, 'light'); b = state(page); page.reload(); c = state(page)
            return (a['stored'] == 'refused' and a['group'] and a['page'] == 'dark' and b['page'] == 'light' and b['checked'] == ['light']
                    and c['page'] == 'dark' and c['checked'] == ['auto'] and clean(a, b, c) and not errors), {'first': a, 'light': b, 'after reload': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, the page and Chora in it: with storage refused, Light chosen still applies to the page, nothing fails, and a reload is back to Auto', lambda: each_page(refused))

    def accessible(key, name):
        ctx, page, errors = opened('dark', name)
        try:
            group = page.get_by_role('radiogroup', name='Colour theme')
            radios = [(r.get_attribute('value'), r.is_checked()) for r in group.get_by_role('radio').all()] if group.count() == 1 else []
            group.get_by_role('radio', name='Auto').focus(); page.keyboard.press('ArrowRight'); after = state(page)
            ring = page.evaluate("() => { const l = document.querySelector('#theme-switch label:has(input:focus-visible)'); return l ? getComputedStyle(l).outlineStyle : null; }")
            return (radios == [('auto', True), ('light', False), ('dark', False)] and after['checked'] == ['light'] and after['page'] == 'light' and ring == 'solid'
                    and not errors), {'radios': radios, 'after the arrow key': after, 'focus ring': ring}
        finally: ctx.close()
    attempt('theme, the page and Chora in it: the switch is a radio group named "Colour theme" (Auto, Light, Dark; Auto chosen), worked by the arrow keys, with a focus ring', lambda: each_page(accessible))

    def other_tabs():
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, color_scheme='dark')
        try:
            _, one, _ = opened('dark', '', ctx=ctx); _, two, _ = opened('dark', '#chora', ctx=ctx)
            a = state(two); choose(one, 'light')
            moved = soon(two, "() => document.documentElement.getAttribute('data-theme') === 'light'", 5); b = state(two)
            choose(one, 'auto'); back = soon(two, "() => !document.documentElement.hasAttribute('data-theme')", 5); c = state(two)
            return (a['page'] == 'dark' and moved and b['page'] == 'light' and b['checked'] == ['light'] and back and c['page'] == 'dark' and c['checked'] == ['auto']), {'before': a, 'after Light in the other tab': b, 'after Auto': c}
        finally: ctx.close()
    attempt('theme: a theme chosen in one tab is taken up at once by Chora shown in another, and Auto too', other_tabs)

# ---- Chora: how well a location is known (Issue #16) ---------------------------------------------
# A mark per spatialPrecision, the circle of precisionKm drawn on the ground, the key, and the card's
# words, on test/fixtures/chora/place-centric-vagueness.json. Each absence beside a presence in the same
# check: a precise point has no circle while its own point and mark are drawn, and another place's circle is.
VAGUE = ROOT / 'test/fixtures/chora/place-centric-vagueness.json'
EARTH_KM = 6371.0088
# The edge of what a layer draws, along one direction from a point on the screen: found by halving,
# between a distance where the layer is there and one where it is not (both asserted first, so that the
# measure is never taken of nothing).
EDGE = '''([lon, lat, dx, dy, lo, hi, layer]) => { const m = window.__chora_map, c = m.project([lon, lat]);
  const at = (r) => m.queryRenderedFeatures([c.x + dx * r, c.y + dy * r], { layers: [layer] }).length > 0;
  const ends = { inside: at(lo), outside: !at(hi) };
  if (!ends.inside || !ends.outside) return ends;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (at(mid)) lo = mid; else hi = mid; }
  return { ...ends, r: (lo + hi) / 2 }; }'''
# What an image or a canvas holds: a hash of its pixels, and how many are not transparent.
PIXELS = '''const sum = (d) => { let h = 0, ink = 0; for (let k = 0; k < d.length; k += 4) { h = (h * 31 + d[k] + 7 * d[k + 3]) >>> 0; if (d[k + 3] > 0) ink++; } return { h, ink }; };'''

def map_pixel(page, xy):
    """The colour of the map's canvas at a point given in the map's own pixels: the mean of a 3 × 3 patch of a screenshot."""
    from PIL import Image
    import io
    box = page.evaluate('() => { const b = window.__chora_map.getCanvas().getBoundingClientRect(); return [b.left, b.top]; }')
    png = page.screenshot(clip={'x': box[0] + xy[0] - 1, 'y': box[1] + xy[1] - 1, 'width': 3, 'height': 3})
    px = list(Image.open(io.BytesIO(png)).convert('RGB').getdata())
    return [sum(p[i] for p in px) / len(px) for i in range(3)]

def pixel_change(page, lon, lat, r, layer):
    """How far a pixel inside a circle of radius r (map pixels, about lon, lat) and one outside it change, in the
    largest of their channels, when `layer` is hidden: inside at 0.6 r and outside at 1.4 r, to the north-east
    (clear of the mark, the drawing tools, the basemaps and the key)."""
    c = page.evaluate('(ll) => { const p = window.__chora_map.project(ll); return [p.x, p.y]; }', [lon, lat])
    at = lambda f: [c[0] + f * r * 0.7071, c[1] - f * r * 0.7071]
    before = [map_pixel(page, at(0.6)), map_pixel(page, at(1.4))]
    page.evaluate('(l) => window.__chora_map.setLayoutProperty(l, "visibility", "none")', layer); page.evaluate(SETTLE)
    try: after = [map_pixel(page, at(0.6)), map_pixel(page, at(1.4))]
    finally: page.evaluate('(l) => window.__chora_map.setLayoutProperty(l, "visibility", "visible")', layer); page.evaluate(SETTLE)
    moved = lambda a, b: round(max(abs(x - y) for x, y in zip(a, b)), 1)
    return {'inside moved': moved(before[0], after[0]), 'outside moved': moved(before[1], after[1]), 'inside': before[0], 'inside hidden': after[0]}

def chora_vague_checks(page, base, tmp):
    places = {p['label']: p for p in json.loads(VAGUE.read_text())['spatialEntities']}
    geom = lambda label: places[label]['attestations'][0]['geometries'][0]
    # The values PLATO defines, from the pinned schema, not typed here.
    def enum(o):
        if isinstance(o, dict):
            if isinstance(o.get('spatialPrecision'), dict): return o['spatialPrecision']['items']['enum']
            return next((x for x in map(enum, o.values()) if x), None)
        if isinstance(o, list): return next((x for x in map(enum, o) if x), None)
        return None
    values = enum(json.loads((PLATO / 'schemas/plato.schema.json').read_text())) or []
    marks = lambda: page.evaluate('() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-vague-marks"] }).map((f) => f.properties.precision)')

    def circle_to_scale():
        chora_boot(page, base, [fixture(VAGUE, 'vague-circle.json', tmp)]); chora_pick(page, 'roughly north')
        g = geom('Roughly North'); (lon, lat), km = g['geojson']['coordinates'], g['precisionKm'][0]
        # As the place is chosen, before the view is moved: the map is fitted to the circle too, so its
        # edge is on the canvas, with the circle inside it and the map beyond, every way from the point.
        room = page.evaluate('() => { const c = window.__chora_map.getCanvas(); return Math.min(c.clientWidth, c.clientHeight) / 2 - 2; }')
        fitted = {name: page.evaluate(EDGE, [lon, lat, dx, dy, 22, room, 'chora-vague-circle']) for name, (dx, dy) in
                  (('east', (1, 0)), ('north', (0, -1)), ('west', (-1, 0)), ('south', (0, 1)))}
        # And it is drawn, not only there to be queried: a pixel inside it changes when its fill is hidden, and
        # one outside it does not (the control: hiding the fill changes nothing else).
        r = fitted['east'].get('r') or 0
        drawn = pixel_change(page, lon, lat, r, 'chora-vague-circle') if r else {}
        got = {'as chosen': fitted, 'pixels': drawn}
        for z in (6, 8):
            page.evaluate('([c, z]) => window.__chora_map.jumpTo({ center: c, zoom: z })', [[lon, lat], z]); page.evaluate(SETTLE)
            # km / R radians of latitude, which Web Mercator draws sec(latitude) times larger, in a world 512 × 2^z pixels round.
            want = km / EARTH_KM / math.cos(math.radians(lat)) * 512 * 2 ** z / (2 * math.pi)
            for name, (dx, dy) in (('east', (1, 0)), ('north', (0, -1))):
                e = page.evaluate(EDGE, [lon, lat, dx, dy, want * 0.5, want * 1.5, 'chora-vague-circle'])
                got[f'z{z} {name}'] = {**e, 'want': round(want, 1)}
        ok = all(v.get('r') and abs(v['r'] / v['want'] - 1) < 0.03 for k, v in got.items() if k.startswith('z'))
        # A circle of fixed pixels would be the same at both zooms: drawn on the ground, it is four times as large two zooms up.
        grow = got['z8 east'].get('r', 0) / max(got['z6 east'].get('r', 0), 1e-9)
        whole = all(v.get('inside') and v.get('outside') for v in fitted.values())
        return (ok and abs(grow - 4) < 0.15 and whole and drawn.get('inside moved', 0) >= 6 and drawn.get('outside moved', 99) <= 2), {**got, 'z8/z6': round(grow, 3)}
    attempt('Chora: a point with precisionKm has a circle seen whole as the place is chosen, drawn (its pixels), and its rendered radius is its km on the ground at zoom 6 and at 8 (59.9° north; east and north)', circle_to_scale)

    def precise_no_circle():
        chora_boot(page, base, [fixture(VAGUE, 'vague-precise.json', tmp)])
        layers = ['chora-place-points', 'chora-vague-marks', 'chora-vague-circle']
        chora_pick(page, 'surveyed cross'); exact = rendered(page, layers); exact_marks = marks()
        chora_pick(page, 'unsaid well'); unsaid = rendered(page, layers)
        # The control, in the same run: a point with a radius has its circle.
        chora_pick(page, 'old ford'); ford = rendered(page, layers)
        return (exact['chora-place-points'] > 0 and exact_marks == ['exact'] and exact['chora-vague-circle'] == 0
                and unsaid['chora-place-points'] > 0 and unsaid['chora-vague-marks'] == 0 and unsaid['chora-vague-circle'] == 0
                and ford['chora-place-points'] > 0 and ford['chora-vague-circle'] > 0), {'exact': exact, 'exact marks': exact_marks, 'not said': unsaid, 'control (2 km)': ford}
    attempt('Chora: a precise point (exact, no precisionKm) is drawn with its mark and no circle; one with no precision has neither; one with a radius has its circle', precise_no_circle)

    def each_drawn():
        chora_boot(page, base, [fixture(VAGUE, 'vague-marks.json', tmp)])
        seen = {}
        for label in places:
            want = (geom(label).get('spatialPrecision') or [None])[0]
            if want: chora_pick(page, label.lower()); seen[label] = [want, marks()]
        # Each value's image on the map (drawn by the key's own function): there, inked, and no two alike.
        images = page.evaluate('(vs) => { ' + PIXELS + ' return vs.map((v) => { const i = window.__chora_map.style.getImage("chora-precision-" + v); return i ? sum(i.data.data) : null; }); }', values)
        # A line has no mark: its own outline is cased in its precision's pattern, and in no other.
        casings = ['chora-vague-casing-white', *[f'chora-vague-casing-{v}' for v in values]]
        line_marks = seen.pop('Vague Road', [None, None])[1]
        chora_pick(page, 'vague road'); road = rendered(page, casings); road_marks = marks()
        others = {k: n for k, n in road.items() if k not in ('chora-vague-casing-white', 'chora-vague-casing-approximate')}
        # The control: a point's location has no casing.
        chora_pick(page, 'surveyed cross'); point = rendered(page, casings)
        return (len(values) >= 4 and sorted({w for w, _ in seen.values()}) == sorted(values) and all(got == [w] for w, got in seen.values())
                and all(i and i['ink'] > 50 for i in images) and len({i['h'] for i in images if i}) == len(values)
                and line_marks == [] and road_marks == [] and road['chora-vague-casing-white'] > 0 and road['chora-vague-casing-approximate'] > 0
                and all(n == 0 for n in others.values()) and all(n == 0 for n in point.values())), {
                    'PLATO values': values, 'drawn': seen, 'images': images, 'line marks': line_marks, 'line casings': road, 'point casings': point}
    attempt("Chora: each spatialPrecision PLATO defines is drawn on the map in a mark of its own around a point, and a line is cased in its precision's pattern with no mark", each_drawn)

    def key_entries():
        chora_boot(page, base, [fixture(VAGUE, 'vague-key.json', tmp)])
        hidden_before = page.evaluate('() => document.getElementById("chora-map-key")?.hidden')
        chora_pick(page, 'old ford')
        # Closed at first, so that it covers none of the map; a click on its line opens it.
        closed = page.evaluate('() => !document.getElementById("chora-map-key").open')
        page.click('#chora-map-key summary')
        rows = page.evaluate('() => { ' + PIXELS + ''' const of = (c) => (c ? sum(c.getContext('2d').getImageData(0, 0, c.width, c.height).data) : { ink: 0, h: null });
          return [...document.querySelectorAll('#chora-map-key li[data-key]')].map((li) => { const r = li.getBoundingClientRect();
          return { key: li.dataset.key, text: li.textContent.replace(/\\s+/g, ' ').trim(), shown: r.width > 0 && r.height > 0, svg: !!li.querySelector('svg'),
            ...of(li.querySelector('canvas[data-sym="point"]')), line: of(li.querySelector('canvas[data-sym="line"]')) }; }); }''')
        by = {r['key']: r for r in rows}
        ok = (hidden_before is True and closed and len(values) >= 4
              and all(v in by and by[v]['shown'] and by[v]['ink'] > 50 and v.replace('_', ' ') in by[v]['text'].lower() for v in values)
              and len({by[v]['h'] for v in values if v in by}) == len(values)
              and all(by[v]['line']['ink'] > 50 for v in values if v in by) and len({by[v]['line']['h'] for v in values if v in by}) == len(values)
              and 'lines' in by and 'line or an area outline drawn like this' in by['lines']['text'] and 'points only' in by.get('circle', {}).get('text', '')
              and 'circle' in by and by['circle']['svg'] and by['circle']['shown'] and 'none' in by)
        return ok, {'PLATO values': values, 'rows': rows, 'hidden before a place': hidden_before, 'closed at first': closed}
    attempt("Chora: the map's key has an entry for each spatialPrecision PLATO defines, a point's mark and a line's casing each drawn and none alike, and one for the circle (points only), shown once a place is, and opened by a click", key_entries)

    def card_words():
        chora_boot(page, base, [fixture(VAGUE, 'vague-card.json', tmp)]); chora_pick(page, 'roughly north')
        LOC = '() => [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling?.textContent'
        loc = page.evaluate(LOC)
        chora_pick(page, 'unsaid well'); ctl = page.evaluate(LOC)
        return loc == 'Point, approximate (estimated from maps or descriptions), to within 25 km' and ctl == 'Point', {'Roughly North': loc, 'Unsaid Well': ctl}
    attempt("Chora: the place card names a location's precision in words, with PLATO's gloss, and how far out it may be", card_words)

def chora_checks(pw, url, tmp):
    base = url.rstrip('/') + '/'; here = urlparse(base).netloc
    ctx = pw.chromium.launch_persistent_context(str(tmp / 'chora-profile'), headless=True, accept_downloads=True, args=GL,
                                                viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    # The storage the browser says it allows, when a check asks for an answer of its own (storage_short).
    ctx.add_init_script('''(() => { try { const s = localStorage.getItem('e2e-storage-estimate');
      if (s && navigator.storage) Object.defineProperty(navigator.storage, 'estimate', { value: async () => JSON.parse(s), configurable: true }); } catch {} })();''')
    # Any call of navigator.storage.persist() or persisted() is recorded, and answered without asking the browser.
    ctx.add_init_script('''(() => { try { window.__e2e_persistCalls = []; for (const k of ['persist', 'persisted'])
      Object.defineProperty(navigator.storage, k, { value: async () => { window.__e2e_persistCalls.push(k); return false; }, configurable: true }); } catch {} })();''')
    requests, errors, loads = [], [], []
    ctx.on('request', lambda r: requests.append(r.url))
    ctx.on('page', lambda p: p.on('pageerror', lambda e: errors.append(str(e)[:200])))
    said = []                                                   # what the pages Chora was in wrote to the console
    ctx.on('console', lambda m: said.append(m.text))
    # The host the guard must refuse: were a request to reach the network it would be recorded here, then stopped.
    ctx.route('https://tiles.example.net/**', lambda route: route.abort())
    web = lambda since=0: [u for u in requests[since:] if urlparse(u).scheme in ('http', 'https')]
    foreign = lambda since=0: sorted({urlparse(u).netloc for u in web(since) if urlparse(u).netloc != here})
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    ant = EX / 'place-centric-antonine.json'; antj = json.loads(ant.read_text())
    ant_places = len(antj['spatialEntities'])
    ant_located = sum(1 for p in antj['spatialEntities'] if any(a.get('geometries') for a in p['attestations']))
    judgements = EX / 'place-centric-judgements.json'

    def default_load():
        s = chora_boot(page, base)
        drew = soon(page, '() => window.__chora_map.getStyle()?.name?.includes("Natural Earth") && window.__chora_map.queryRenderedFeatures({ layers: ["land"] }).length > 0', 30)
        style = page.evaluate('() => window.__chora_map.getStyle()?.name'); land = rendered(page, ['land'])['land']
        return drew and s['basemap'] == 'natural-earth' and land > 0, {'style': style, 'land': land, 'state': s}
    attempt('Chora: the map is idle on the Natural Earth basemap, from this site, with land drawn', default_load)
    def nothing_leaves():
        since = len(requests); chora_boot(page, base)
        soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["land"] }).length > 0', 30)
        mine = [u for u in web(since) if urlparse(u).netloc == here]
        # The absence means something only beside the presence: the basemap and PLATO's files were fetched, from here.
        return not foreign(since) and any('/basemap/' in u for u in mine) and any('/plato/' in u for u in mine), {'foreign': foreign(since), 'same-origin requests': len(mine)}
    attempt('Chora: a default load asks nothing of any other site (and did fetch the basemap and PLATO files from this one)', nothing_leaves)

    def guard():
        before = chora_boot(page, base)['blocked']; since = len(requests)
        # Two sources added at once: one on another site, which must be refused and counted, and one
        # on this site, which must be fetched, so that "nothing was asked" is known to be able to see a request.
        page.evaluate('''() => { const m = window.__chora_map;
          m.addSource('probe-foreign', { type: 'raster', tiles: ['https://tiles.example.net/{z}/{x}/{y}.png'], tileSize: 256 });
          m.addLayer({ id: 'probe-foreign', type: 'raster', source: 'probe-foreign' });
          m.addSource('probe-here', { type: 'geojson', data: './basemap/lakes.geojson?probe' });
          m.addLayer({ id: 'probe-here', type: 'line', source: 'probe-here' }); }''')
        counted = soon(page, 'b => window.__chora.blocked > b', 20, before)
        fetched = soon(page, '() => window.__chora_map.isSourceLoaded("probe-here")', 20)
        page.wait_for_timeout(500)
        s = cstate(page); asked = [u for u in web(since) if 'tiles.example.net' in u]; ours = [u for u in web(since) if 'lakes.geojson?probe' in u]
        return counted and fetched and 'https://tiles.example.net' in s['blockedOrigins'] and not asked and ours, {'blocked': s['blocked'], 'origins': s['blockedOrigins'], 'asked': asked, 'fetched here': ours}
    attempt('Chora: the guard refuses a request to another site and counts it, while a request to this site goes through', guard)
    def no_key_in_console():
        chora_boot(page, base)
        # Once the basemap is in: sources added before would go with the blank style it replaces.
        until(page, '() => window.__chora_map.getStyle()?.name?.includes("Natural Earth") && window.__chora_map.isStyleLoaded()', 30)
        since = len(said)
        # A basemap's key travels in its addresses, in the query string or in the path; a failed request
        # must not put it in the console. Three sources on this site that are not there: a key in the
        # query, a key in the path, and the control without either. Each failure is named by its site alone.
        page.evaluate('''() => { const m = window.__chora_map;
          m.addSource('probe-keyed', { type: 'geojson', data: './basemap/not-here.geojson?api_key=SECRETKEY123' });
          m.addLayer({ id: 'probe-keyed', type: 'line', source: 'probe-keyed' });
          m.addSource('probe-path', { type: 'geojson', data: './basemap/PATHKEY456/not-here-too.geojson' });
          m.addLayer({ id: 'probe-path', type: 'line', source: 'probe-path' });
          m.addSource('probe-bare', { type: 'geojson', data: './basemap/not-here-either.geojson' });
          m.addLayer({ id: 'probe-bare', type: 'line', source: 'probe-bare' }); }''')
        site = base.split('/')[0] + '//' + here
        named = lambda: [x for x in said[since:] if x.startswith('Map') and (site in x or 'not-here' in x)]
        t0 = time.time()
        # page.wait_for_timeout, not time.sleep: Playwright delivers console events only while it is called.
        while time.time() - t0 < T(15) and len(named()) < 3: page.wait_for_timeout(250)
        lines = said[since:]
        return (len(named()) >= 3 and all(site in x for x in named())
                and not any(k in x for x in lines for k in ('SECRETKEY123', 'PATHKEY456', 'not-here'))), {'console': [x[:160] for x in lines]}
    attempt('Chora: a failed map request is named in the console by its site alone, without a key from its query or its path', no_key_in_console)

    def load_plato():
        s = chora_boot(page, base, [fixture(ant, 'antonine-load.json', tmp)]); loads.append(s['phase'])
        listed = page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs.length')
        unplaced = page.eval_on_selector_all('#chora-list .tag', 'ts => ts.filter((t) => t.textContent === "no location").length')
        ov = page.evaluate('() => { const d = window.__chora_map.getSource("chora-overview").serialize().data; return (d.features || d.geojson?.features || []).length; }')
        dots = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-overview-points", "chora-overview-clusters"] }).length > 0', 20)
        text = page.inner_text('#chora-dataset')
        return (s['phase'] == 'loaded' and s['places'] == ant_places and listed == ant_places and unplaced == ant_places - ant_located and ov == ant_located and dots
                and f'{ant_places} places, {ant_located} with a location' in text), {'state': s, 'listed': listed, 'no location': unplaced, 'on the map': ov, 'drawn': dots, 'text': text}
    attempt(f'Chora: a PLATO JSON file opens: its {ant_places} places listed, the {ant_located} with a location on the map', load_plato)
    def load_tables():
        rows = list(csv.DictReader((PLATO / 'schemas/tables/examples/customs/places.csv').open(newline='')))
        s = chora_boot(page, base, sorted((PLATO / 'schemas/tables/examples/customs').glob('*.csv'))); loads.append(s['phase'])
        labels = page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs.map((b) => b.firstChild.textContent.trim())')
        return s['phase'] == 'loaded' and s['places'] == len(rows) and sorted(labels) == sorted(r['label'] for r in rows), {'state': s, 'listed': labels}
    attempt('Chora: the PLATO spreadsheet tables open, each place in places.csv listed', load_tables)

    def georef_said():
        # A IIIF Georeference Annotation is not a dataset: Chora says why, in the readers' own words.
        # The control: the same page then opens a dataset.
        s = chora_boot(page, base, [ROOT / 'test/fixtures/hermes-detect/bpl-rocque-annotation.json'])
        said = page.inner_text('#chora-phase')
        # On Chora the advice is to paste it under Historical maps, not the main page's (drop it with the Recogito export).
        ok = (s['phase'] == 'unrecognised' and 'IIIF Georeference Annotation' in said and 'Unsupported input' not in said
              and 'under Historical maps' in said and 'Recogito' not in said)
        s2 = chora_boot(page, base, [ant])
        return ok and s2['phase'] == 'loaded', {'state': s, 'said': said[:300], 'then': s2.get('phase')}
    attempt('Chora: a IIIF Georeference Annotation is refused as a dataset, saying to paste it under Historical maps (not the main page\'s advice)', georef_said)

    def search():
        chora_boot(page, base, [fixture(ant, 'antonine-search.json', tmp)])
        labels = lambda: sorted(page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs.map((b) => b.firstChild.textContent.trim())'))
        # What should be found, worked out from the file, folded as the page says it folds (chora_fold).
        fold = chora_fold
        want = sorted(p['label'] for p in antj['spatialEntities'] if 'road' in fold(p['label']))
        want_dover = sorted(p['label'] for p in antj['spatialEntities'] if 'dover' in fold(p['label']))
        page.fill('#chora-q', 'ROAD'); until(page, '() => /found/.test(document.getElementById("chora-found").textContent)', 20)
        roads, was = labels(), page.inner_text('#chora-found')
        # Diacritics are folded on both sides: "dóver" finds Dover.
        page.fill('#chora-q', 'dóver'); until(page, 'w => document.getElementById("chora-found").textContent !== w', 20, was)
        dover = labels()
        return 0 < len(want) < ant_places and roads == want and want_dover and dover == want_dover, {'road': roads, 'wanted': want, 'dóver': dover, 'wanted for dóver': want_dover}
    attempt('Chora: search finds by part of a name, whatever the case and accents, and only those', search)
    def search_names():
        chora_boot(page, base, [fixture(ant, 'antonine-names.json', tmp)])
        fold = chora_fold
        # "Ad portum" is in two places' names (Ad portum Dubris, Ad portum Lemanis) and in no label, so
        # only a search of the names can find them. Worked out from the file, not typed in.
        want = sorted((p['label'], n['toponym']) for p in antj['spatialEntities'] for a in p['attestations'] for n in a.get('names', [])
                      if 'ad portum' in fold(n['toponym']) and 'ad portum' not in fold(p['label']))
        was = page.inner_text('#chora-found')                         # "11 places.": the list before the search
        page.fill('#chora-q', 'AD PÓRTUM'); until(page, 'w => document.getElementById("chora-found").textContent !== w', 20, was)
        got = sorted(page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs.map((b) => [b.firstChild.textContent.trim(), b.querySelector(".also")?.textContent || null])'))
        return len(want) == 2 and got == [[l, f'— also {n}'] for l, n in want], {'listed': got, 'wanted': want}
    attempt('Chora: search finds a place by a name that is not its label, and shows the name it matched', search_names)
    def paging():
        # 120 places, so the list has three pages: 1-50, 51-100, 101-120. Next and Previous go on
        # from the place before the page (the request carries it as `after`), and the count stays that
        # of the whole query. The labels are not in the order of the file, so a list sorted by label,
        # or paged by anything but the order of the file, shows other places.
        f = tmp / 'chora-files' / 'paging.json'; f.parent.mkdir(exist_ok=True)
        order = [f'https://example.org/p/{i}' for i in range(1, 121)]
        label = {u: f'Stead {(i * 37) % 120 + 1:03d}' for i, u in enumerate(order, 1)}
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Paging', 'status': 'draft', 'version': '1'},
            'spatialEntities': [{'@id': u, 'label': label[u], 'attestations': []} for u in order]}))
        chora_boot(page, base, [f])
        shown = lambda: page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs.map((b) => [b.dataset.id, b.firstChild.textContent.trim()])')
        last = lambda: cstate(page).get('lastSearch') or {}
        seen, sent, prev = [], [], None
        for step in ['start', 'next', 'next', 'prev']:
            was = page.inner_text('#chora-found')
            if step != 'start':
                page.click(f'#chora-{step}'); until(page, 'w => document.getElementById("chora-found").textContent !== w', 20, was)
            ls, items = last(), shown()
            seen.append([page.inner_text('#chora-found'), [i for i, _ in items], [l for _, l in items], page.is_disabled('#chora-prev'), page.is_disabled('#chora-next')])
            # What each request asked for: after which place, and what the reply before it said came next.
            sent.append([step, ls.get('after'), (prev or {}).get('next'), ls.get('shown') == [i for i, _ in items]])
            prev = ls
        page_of = lambda a, b: [order[a:b], [label[u] for u in order[a:b]]]
        want = [['120 places, showing 1–50.', *page_of(0, 50), True, False],
                ['120 places, showing 51–100.', *page_of(50, 100), False, False],
                ['120 places, showing 101–120.', *page_of(100, 120), False, True],
                ['120 places, showing 51–100.', *page_of(50, 100), False, False]]
        # Next goes on from the place the reply before gave as next (not 0, not an offset), and the
        # first place of the page after is the place after the last of the page before, in the file.
        nexts_ok = all(a == n and isinstance(a, int) and a > 0 and same for step, a, n, same in sent if step == 'next')
        follows = all(order.index(seen[k + 1][1][0]) == order.index(seen[k][1][-1]) + 1 for k in (0, 1))
        return seen == want and nexts_ok and follows and sent[0][1] == 0, {'seen': [x[0] for x in seen], 'sent': sent, 'follows': follows,
                                                                            'first of each': [x[2][:1] for x in seen], 'wanted': [x[2][:1] for x in want]}
    attempt('Chora: the place list pages forwards and back, each page going on from the one before', paging)
    def paging_twice():
        # Next clicked twice before the first is answered goes on two pages: the second click asks for
        # the page after the one the first showed, not the same page again.
        f = tmp / 'chora-files' / 'paging-twice.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g2', 'title': 'Paging twice', 'status': 'draft', 'version': '1'},
            'spatialEntities': [{'@id': f'https://example.org/q/{i}', 'label': f'Holm {i:03d}', 'attestations': []} for i in range(1, 121)]}))
        chora_boot(page, base, [f])
        before = page.inner_text('#chora-found')
        page.evaluate('() => { const b = document.getElementById("chora-next"); b.click(); b.click(); }')
        got = soon(page, '() => /101–120/.test(document.getElementById("chora-found").textContent)', 20)
        after = page.inner_text('#chora-found'); first = page.eval_on_selector_all('#chora-list button[data-id]', 'bs => bs[0]?.firstChild.textContent.trim()')
        return before == '120 places, showing 1–50.' and got and first == 'Holm 101', {'before': before, 'after': after, 'first': first}
    attempt('Chora: Next clicked twice goes on two pages', paging_twice)
    def paging_then_typed():
        # Next clicked while the worker is busy, then a new query typed and settled before Next is sent:
        # Next sends nothing (a page of the new query worked out from the old query's pages would be
        # neither's), and the new query is asked for from its first page. The worker is held busy by
        # holding back the commands the page posts to it (Worker.prototype.postMessage, here only; the
        # map's workers, posting no commands, pass); every command posted is recorded, so what was
        # asked for is read, not inferred from what is shown.
        f = tmp / 'chora-files' / 'paging-typed.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g3', 'title': 'Paging, then typed', 'status': 'draft', 'version': '1'},
            'spatialEntities': [{'@id': f'https://example.org/t/{i}', 'label': f'Holm {i:03d}', 'attestations': []} for i in range(1, 121)]}))
        chora_boot(page, base, [f])
        before = page.inner_text('#chora-found')
        page.evaluate("""() => { window.__sent = []; window.__held = []; window.__hold = true;
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (m, ...rest) {
            if (!m || typeof m.cmd !== 'string') return post.call(this, m, ...rest);   // the map's own workers
            window.__sent.push(m.cmd === 'chora-search' ? [m.cmd, m.q, m.after] : [m.cmd]);
            if (window.__hold) window.__held.push([this, m]); else post.call(this, m);
          };
          window.__release = () => { window.__hold = false; for (const [w, m] of window.__held.splice(0)) post.call(w, m); }; }""")
        page.evaluate('() => document.querySelector("#chora-list button[data-id]").click()')   # chora-place: held, so the worker is busy
        until(page, '() => window.__sent.length === 1', 10)
        page.click('#chora-next')                                                                  # for "", from page 1: waits behind it
        page.fill('#chora-q', 'HOLM 1')                                                            # then typed ...
        page.wait_for_timeout(600)                                                           # ... and settled (200 ms) while still held
        page.evaluate('() => window.__release()')
        got = soon(page, '() => /found/.test(document.getElementById("chora-found").textContent)', 20)
        page.wait_for_timeout(300)
        sent = page.evaluate('() => window.__sent')
        found, ls = page.inner_text('#chora-found'), cstate(page).get('lastSearch') or {}
        searches = [x for x in sent if x[0] == 'chora-search']
        return (before == '120 places, showing 1–50.' and got and sent[0] == ['chora-place'] and searches == [['chora-search', 'HOLM 1', 0]]
                and found == '21 found.' and ls.get('after') == 0), {'before': before, 'sent': sent, 'found': found, 'lastSearch after': ls.get('after')}
    attempt('Chora: Next clicked, then a new query typed before Next is sent: Next asks for nothing, the new query its first page', paging_then_typed)

    def statuses():
        chora_boot(page, base, [fixture(judgements, 'judgements-card.json', tmp)])
        chora_pick(page, 'kingsbury'); kb = sorted(page.eval_on_selector_all('#chora-card .status', 'x => x.map((e) => e.textContent)'))
        bars = page.eval_on_selector_all('#chora-card svg.timeline rect', 'r => r.length')
        chora_pick(page, 'littleworth'); lw = sorted(page.eval_on_selector_all('#chora-card .status', 'x => x.map((e) => e.textContent)'))
        # Kingsbury's two markets: one reported, one doubted, each dated; Littleworth's market is denied.
        return kb == ['doubted', 'reported'] and bars == 2 and lw == ['denied'], {'kingsbury': kb, 'bars': bars, 'littleworth': lw}
    attempt('Chora: the place card labels what a source reports, doubts and denies, and dates them on its timeline', statuses)

    def timeline_theme():
        # The timeline's bars take their status's colour from the stylesheet, as the labels do, so they
        # follow the theme: a doubted bar is the doubted label's grey, darker in Light, lighter in Dark.
        BAR = """() => { const r = document.querySelector('#chora-card svg.timeline rect.tl-doubted'), s = document.querySelector('#chora-card .status-doubted');
          return r && s ? { bar: getComputedStyle(r).fill, edge: getComputedStyle(r).stroke, label: getComputedStyle(s).color, theme: document.documentElement.getAttribute('data-theme') } : null; }"""
        chora_boot(page, base, [fixture(judgements, 'judgements-theme.json', tmp)])
        chora_pick(page, 'kingsbury')
        try:
            page.click('#theme-switch label:has(input[value="light"])'); light = page.evaluate(BAR)
            page.click('#theme-switch label:has(input[value="dark"])'); dark = page.evaluate(BAR)
        finally:
            page.click('#theme-switch label:has(input[value="auto"])')     # this profile's later checks start in Auto
        return (bool(light) and bool(dark) and light['bar'] == light['label'] == light['edge'] == 'rgb(107, 114, 128)'
                and dark['bar'] == dark['label'] == dark['edge'] == 'rgb(165, 173, 186)' and dark['theme'] == 'dark'), {'light': light, 'dark': dark}
    attempt('Chora: a timeline bar is in its status\'s colour from the stylesheet, as its label is, and follows the theme (a doubted bar, Light then Dark)', timeline_theme)
    # The tooltips: those the page writes (a status's meaning, on the card), MapLibre's (its zoom
    # buttons, at the window's right edge, given title attributes by the library), and the badge's.
    # At 600 pixels, where Chora has the page's one column and its map reaches the window's right edge
    # (wider, the workflow rail is beside it).
    page.set_viewport_size({'width': 600, 'height': 900})
    try:
        chora_boot(page, base, [fixture(judgements, 'judgements-tips.json', tmp)]); chora_pick(page, 'kingsbury')
    except Exception as e: print('  (Chora tooltips: the page did not open the dataset:', str(e).split('\n')[0][:200], ')')
    tooltip_checks(page, 'Chora tooltips', ('#chora-card .status-reported', 'as said by others'), ('#chora-card .status-doubted', 'and doubts it'),
                   ('.maplibregl-ctrl-zoom-in', 'Zoom in', 'right', '.maplibregl-ctrl-zoom-out'))
    page.set_viewport_size({'width': 1400, 'height': 900})
    no_titles(page, 'Chora tooltips', ['Draw a point', 'Stop drawing', 'Show a historical map to trace from it', "goes onto it (hold Alt not to)", 'Zoom in', 'Zoom out', 'The source reports this as said by others.', 'market (1673), reported', 'being built in the open'])
    def withdrawn():
        chora_boot(page, base, [fixture(judgements, 'judgements-withdrawn.json', tmp)])
        chora_pick(page, 'littleworth')
        text = page.inner_text('#chora-card')
        where = page.evaluate('() => [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling?.textContent')
        # The file does give Littleworth a location, in the attestation a later one retracts: so "none
        # recorded" is the retraction honoured, not a location never there.
        lw = next(p for p in json.loads(judgements.read_text())['spatialEntities'] if p['@id'].endswith('/littleworth'))
        had = any(a.get('geometries') for a in lw['attestations'])
        return had and '1 withdrawn attestation not shown' in text and where == 'None recorded.', {'locations': where, 'text': text[-300:]}
    attempt('Chora: a retracted attestation is left out of the place card, and the card says one was withdrawn', withdrawn)

    def fallback():
        f = tmp / 'chora-files' / 'fallback.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Fallback'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/athens', 'label': 'Athens', 'ccodes': ['GR'], 'attestations': [{'geometries': [{'geojson': {'type': 'Point', 'coordinates': [23.72, 37.98]}}], 'sources': [{'title': 's'}]}]},
            {'@id': 'https://example.org/p/somewhere', 'label': 'Somewhere in Greece', 'ccodes': ['GR'], 'attestations': [{'names': [{'toponym': 'Somewhere'}], 'sources': [{'title': 's'}]}]}]}))
        chora_boot(page, base, [f])
        chora_pick(page, 'somewhere')
        outlined = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-context-area"] }).length > 0', 20)
        note = page.inner_text('#chora-card .note'); c = page.evaluate('() => window.__chora_map.getCenter().toArray()')
        w, s, e, n = json.loads(urllib.request.urlopen(base + 'basemap/ccodes.json', timeout=10).read())['GR']
        # The control: a place with a location of its own gets no country outline, and is drawn itself.
        chora_pick(page, 'athens'); ctl = rendered(page, ['chora-context-area', 'chora-place-points'])
        return (outlined and 'showing its country (GR)' in note and w <= c[0] <= e and s <= c[1] <= n
                and ctl['chora-context-area'] == 0 and ctl['chora-place-points'] > 0), {'note': note, 'centre': c, 'GR': [w, s, e, n], 'Athens': ctl}
    attempt('Chora: a place with no location of its own is shown by its country, outlined, and the map goes there', fallback)

    # PLATO #18, #19 and #20, in the shape Trismegistos gives them: a containment known only by name
    # ("in the Delta"), a location given only between two places, and an attestation window (the span
    # of the texts that mention the place).
    def name_only_and_evidence():
        f = tmp / 'chora-files' / 'trismegistos-shape.json'; f.parent.mkdir(exist_ok=True)
        P = 'https://w3id.org/plato#'; s = [{'title': 'Trismegistos Places'}]
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Windows'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/agathos', 'label': 'Agathos Daimon', 'ccodes': ['EG'], 'attestations': [
                {'names': [{'toponym': 'Agathos Daimon'}, {'toponym': 'Sṯt', 'language': 'egy-Latn-t-egy-egyd', 'script': 'Latn', 'transliterationSystem': 'Egyptological transliteration'}], 'sources': s},
                {'relations': [{'relationType': P + 'ContainedIn', 'relatedLabel': 'the Delta', 'relationLabel': 'in the Delta'}], 'sources': s},
                {'geometries': [{'sourceLabel': 'between Kom and Philai', 'qualification': {'relativeQualifier': P + 'BetweenXAndY', 'relativeTo': ['https://example.org/p/kom', 'https://www.trismegistos.org/place/1767']}}], 'sources': s},
                {'timespans': [{'startEarliest': '0015', 'endLatest': '0540', 'sourceLabel': 'AD 15 - AD 540'}], 'timespanRole': P + 'EvidenceSpan', 'sources': s}]},
            {'@id': 'https://example.org/p/kom', 'label': 'Kom Control', 'ccodes': ['EG'], 'attestations': [
                {'names': [{'toponym': 'Kom Control'}], 'timespans': [{'startEarliest': '0100', 'endLatest': '0200'}], 'sources': s},
                {'geometries': [{'geojson': {'type': 'Point', 'coordinates': [31.2, 30.0]}}], 'sources': s},
                {'relations': [{'relationType': P + 'ContainedIn', 'relatesTo': 'https://example.org/p/agathos'}], 'sources': s}]}]}))
        chora_boot(page, base, [f])
        chora_pick(page, 'agathos')
        rel = page.evaluate('() => { const ul = [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Related places")?.nextElementSibling; return ul ? { text: ul.textContent, links: ul.querySelectorAll("a").length } : null; }')
        tl = page.evaluate('() => { const s = document.querySelector("#chora-card svg.timeline"); return s ? { text: s.textContent, evidence: s.querySelectorAll("rect.tl-evidence").length, legend: s.querySelectorAll(".tl-legend").length } : null; }')
        note = page.inner_text('#chora-card .note')
        locs = page.evaluate('() => { const ul = [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling; return ul ? { text: ul.textContent, links: [...ul.querySelectorAll("a[data-place]")].map((a) => a.dataset.place) } : null; }')
        drawn = rendered(page, ['chora-place-points'])['chora-place-points']
        names = page.evaluate('() => { const ul = [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Names")?.nextElementSibling; return ul ? [...ul.querySelectorAll("li")].map((li) => li.textContent) : null; }')
        # The control: a location with coordinates is drawn and not written as relative; a dated claim is a solid bar with no legend, and a relation to a place of the dataset is a link.
        chora_pick(page, 'kom control')
        ctl_locs = page.evaluate('() => [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling?.textContent')
        ctl_drawn = rendered(page, ['chora-place-points'])['chora-place-points']
        ctl_rel = page.evaluate('() => [...document.querySelectorAll("#chora-card h3")].find((h) => h.textContent === "Related places")?.nextElementSibling?.querySelectorAll("a[data-place]").length')
        ctl = page.evaluate('() => { const s = document.querySelector("#chora-card svg.timeline"); return s ? { text: s.textContent, bars: s.querySelectorAll("rect").length, evidence: s.querySelectorAll("rect.tl-evidence").length, legend: s.querySelectorAll(".tl-legend").length } : null; }')
        return (rel and 'ContainedIn: the Delta' in rel['text'] and rel['links'] == 0
                and 'Located only relative to other places; showing its country (EG)' in note
                and locs and 'between Kom Control and 1767, as written “between Kom and Philai” (relative; not drawn)' in locs['text'] and locs['links'] == ['https://example.org/p/kom'] and drawn == 0
                and ctl_locs == 'Point' and ctl_drawn > 0
                and tl and 'mentioned in texts dated 15–540' in tl['text'] and tl['evidence'] == 1 and tl['legend'] == 1
                and ctl_rel == 1 and ctl and 'Kom Control · 100–200' in ctl['text'] and 'mentioned' not in ctl['text']
                and ctl['bars'] == 1 and ctl['evidence'] == 0 and ctl['legend'] == 0
                and names == ['Agathos Daimon', 'Sṯt (egy-Latn-t-egy-egyd) in Egyptological transliteration']), {'related': rel, 'locations': locs, 'drawn': drawn, 'control locations': ctl_locs, 'control drawn': ctl_drawn, 'timeline': tl, 'note': note, 'control links': ctl_rel, 'control timeline': ctl, 'names': names}
    attempt('Chora: a relation named only is plain text that places nothing, a location between two places is a line in words that is not drawn, the span of the texts is drawn hatched as a mention (a drawn location and a dated claim are not), and a name known only in transliteration says so', name_only_and_evidence)
    chora_vague_checks(page, base, tmp)

    # Drawing, in one file: each check below opens it afresh and finds what the one before left.
    draws = {'file': fixture(ant, 'antonine-draw.json', tmp)}
    def draw_three():
        f = draws['file']; chora_boot(page, base, [f]); draws['place'] = chora_pick(page, 'londinium')
        x, y = map_centre(page)
        draw(page, 'point', [(x + 150, y + 60)])
        draw(page, 'linestring', [(x - 200, y - 100), (x - 100, y - 150), (x, y - 100), (x, y - 100)])   # the last vertex again ends the line
        draw(page, 'polygon', [(x - 200, y + 100), (x - 100, y + 100), (x - 150, y + 200), (x - 200, y + 100)])   # the first corner again closes it
        page.click('#chora-draw-tools button[data-mode="static"]')
        soon(page, '() => window.__chora.pendingCount === 3', 10)
        on_map = soon(page, 'ls => ls.every((l) => window.__chora_map.queryRenderedFeatures({ layers: [l] }).length > 0)', 10, ['td-point', 'td-linestring', 'td-polygon'])
        k = kept(page, f.name)
        return (cstate(page)['pendingCount'] == 3 and on_map and kinds(page) == ['A line', 'A point', 'An area']
                and sorted(d['geojson']['type'] for d in k) == ['LineString', 'Point', 'Polygon'] and all(d['placeId'] == draws['place'] for d in k)), {
            'on the map': rendered(page, ['td-point', 'td-linestring', 'td-polygon']), 'listed': kinds(page), 'kept': [d['geojson']['type'] for d in k]}
    attempt('Chora: a point, a line and an area drawn with the mouse are on the map, listed as the place\'s drawings, and kept', draw_three)
    def move_point():
        f = draws['file']; chora_boot(page, base, [f]); chora_pick(page, 'londinium')
        before = next(d for d in kept(page, f.name) if d['geojson']['type'] == 'Point')['geojson']['coordinates']
        at = 'c => { const p = window.__chora_map.project(c), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }'
        px, py = page.evaluate(at, before)
        page.click('#chora-draw-tools button[data-mode="select"]')
        tap(page, px, py)                                       # select it, then drag it
        page.mouse.move(px, py); page.mouse.down(); page.mouse.move(px + 30, py + 20, steps=6); page.mouse.move(px + 60, py + 40, steps=6); page.mouse.up()
        page.click('#chora-draw-tools button[data-mode="static"]')
        target = page.evaluate('([x, y]) => { const r = window.__chora_map.getCanvas().getBoundingClientRect(); return window.__chora_map.unproject([x - r.left, y - r.top]).toArray(); }', [px + 60, py + 40])
        t0 = time.time(); after = before
        while time.time() - t0 < T(10) and after == before:
            after = next((d for d in kept(page, f.name) if d['geojson']['type'] == 'Point'), {'geojson': {'coordinates': before}})['geojson']['coordinates']; time.sleep(0.25)
        draws['moved'] = after
        near = abs(after[0] - target[0]) < 0.05 and abs(after[1] - target[1]) < 0.05
        return after != before and near and cstate(page)['pendingCount'] == 3, {'before': before, 'after': after, 'dragged to': target}
    attempt('Chora: a drawing moved with the Edit tool is kept where it was dropped', move_point)
    def remove_line():
        f = draws['file']; chora_boot(page, base, [f]); chora_pick(page, 'londinium')
        page.click('ul.pending li[data-draft]:has(.kind:text-is("A line")) button[data-remove]')
        soon(page, '() => window.__chora.pendingCount === 2', 10)
        gone = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["td-linestring"] }).length === 0', 10)
        r = rendered(page, ['td-point', 'td-linestring', 'td-polygon']); k = sorted(d['geojson']['type'] for d in kept(page, f.name))
        return gone and r['td-point'] > 0 and r['td-polygon'] > 0 and k == ['Point', 'Polygon'] and kinds(page) == ['A point', 'An area'], {'on the map': r, 'kept': k, 'listed': kinds(page)}
    attempt('Chora: a drawing removed is gone from the map, the list and the store, and the others stay', remove_line)
    def survive():
        f = draws['file']; s = chora_boot(page, base, [f]); note = page.inner_text('#chora-dataset')
        chora_pick(page, 'londinium')
        on_map = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["td-point"] }).length > 0 && window.__chora_map.queryRenderedFeatures({ layers: ["td-polygon"] }).length > 0', 10)
        r = rendered(page, ['td-point', 'td-linestring', 'td-polygon'])
        pt = page.evaluate('() => window.__chora_draw.getSnapshot().find((f) => f.geometry.type === "Point")?.geometry.coordinates')
        return s['pendingCount'] == 2 and '2 unsaved drawings were kept' in note and on_map and r['td-linestring'] == 0 and kinds(page) == ['A point', 'An area'] and pt == draws.get('moved'), {
            'state': s, 'note': note, 'on the map': r, 'point': pt, 'moved to': draws.get('moved')}
    attempt('Chora: the drawings not yet saved come back when the page is opened again with the same file', survive)

    def contributor():
        f = draws['file']; chora_boot(page, base, [f])
        page.evaluate("() => localStorage.removeItem('chora-contributor')")
        page.click('#chora-save')
        asked = page.is_visible('#chora-contributor-form')
        page.fill('#chora-c-name', 'Ada Test'); page.fill('#chora-c-orcid', '0000-0002-1825-0098')   # the check digit should be 7
        page.click('#chora-contributor-form button[type=submit]')
        err = page.inner_text('#chora-c-error') if page.is_visible('#chora-c-error') else ''
        refused = page.is_visible('#chora-contributor-form') and cstate(page)['lastSave'] is None and page.evaluate("() => localStorage.getItem('chora-contributor')") is None
        if not refused: return False, {'error': err, 'the mistyped iD was taken': cstate(page).get('lastSave') or page.evaluate("() => localStorage.getItem('chora-contributor')")}
        page.fill('#chora-c-orcid', '0000-0002-1825-0097'); page.click('#chora-contributor-form button[type=submit]')
        until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        c = json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')
        line = page.inner_text('#chora-contributor-line')
        return asked and 'ORCID' in err and refused and c == {'name': 'Ada Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097'} and 'Saving as Ada Test' in line, {'error': err, 'remembered': c, 'line': line}
    attempt('Chora: the first save asks who is saving; a mistyped ORCID iD (its check digit) is refused, a right one remembered', contributor)
    def save():
        f = draws['file']; s = chora_boot(page, base, [f])
        if page.evaluate("() => localStorage.getItem('chora-contributor')") is None:   # this check's own state, if the one before failed
            page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: 'https://orcid.org/0000-0002-1825-0097' }))")
        page.click('#chora-save')
        until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}; said = page.inner_text('#chora-save-result')
        return s['pendingCount'] == 2 and ls.get('passed') and ls.get('added') == 2 and [o['name'] for o in ls['outputs']] == ['antonine-draw.chora.json'] and 'Mneme' in said, {'kept': s['pendingCount'], 'save': ls, 'said': said}
    attempt('Chora: saving passes the version check (Mneme) with exactly the two drawings added', save)
    saved = tmp / 'chora-saved.json'
    def saved_file():
        f = draws['file']
        if not page.is_visible('#chora-save-result button.primary'): raise RuntimeError('no saved file offered (the save before did not pass)')
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        d.value.save_as(saved)
        out, inp = json.loads(saved.read_text()), json.loads(f.read_text())
        was = {p['@id']: p for p in inp['spatialEntities']}
        # Append-only, checked apart from Mneme: every place and attestation of the input is in the
        # output as it was, and the only new ones are the drawings, on the place drawn on.
        kept_all = all(a in p['attestations'] for p in out['spatialEntities'] for a in was.get(p['@id'], {}).get('attestations', [])) and len(out['spatialEntities']) == len(was)
        new = [(p['@id'], a) for p in out['spatialEntities'] for a in p['attestations'] if a not in was[p['@id']]['attestations']]
        ok_new = (len(new) == 2 and all(pid == draws['place'] for pid, _ in new)
                  and sorted(a['geometries'][0]['geojson']['type'] for _, a in new) == ['Point', 'Polygon']
                  and all(a.get('contributor') == {'name': 'Ada Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097'} and '@id' not in a
                          and re.match(r'^\d{4}-\d\d-\d\dT', a.get('created', '')) and 'Chora' in a.get('notes', '') and 'Natural Earth' in a.get('notes', '') for _, a in new))
        moved = next((a['geometries'][0]['geojson']['coordinates'] for _, a in new if a['geometries'][0]['geojson']['type'] == 'Point'), None)
        # A download cannot be seen to finish (__plato_forceDownload): the drafts are kept, the file still
        # offered, and the page says to save again if it did not complete, until the user lets them go.
        page.wait_for_timeout(500)
        after_download = {'pending': cstate(page)['pendingCount'], 'kept': len(kept(page, f.name)), 'offered': page.is_visible('#chora-save-result button.primary'),
                          'said': page.inner_text('#chora-save-result')}
        held = after_download['pending'] == 2 and after_download['kept'] == 2 and after_download['offered'] and 'If the download did not complete, save again' in after_download['said']
        if page.is_visible('#chora-save-result button[data-clear]'): page.click('#chora-save-result button[data-clear]')
        cleared = soon(page, '() => window.__chora.pendingCount === 0', 10) and kept(page, f.name) == [] and not page.is_visible('#chora-save-result button.primary')
        # The file keeps seven decimals (about a centimetre); the drawing kept in the browser, all of them.
        same_place = moved and draws.get('moved') and all(abs(a - b) < 1e-6 for a, b in zip(moved, draws['moved']))
        return kept_all and ok_new and same_place and held and cleared, {'new': new, 'all kept': kept_all, 'point': moved, 'moved to': draws.get('moved'), 'after the download': after_download, 'drafts cleared when asked': cleared}
    attempt('Chora: the saved file has the input as it was, and the two drawings as new attestations with contributor, date and note; after a download the drafts are kept until the user lets them go', saved_file)
    def saved_valid():
        f = draws['file']; m = main_page(ctx, base)
        try:
            # The check reads a copy: choosing the very file the page already has fires no change, and
            # the comparison after it would then read the check's result as its own.
            s = run_case(m, [shutil.copyfile(saved, tmp / 'chora-saved-check.json')], 'check')
            c = compare_case(m, saved, f)
            counts = (c.get('report') or {}).get('counts', {})
            return (s.get('phase') == 'done' and s['report']['errors'] == 0 and c.get('phase') == 'done' and c['report']['errors'] == 0
                    and counts.get('added') == 2 and counts.get('lost') == 0 and counts.get('changed') == 0), {'check': s.get('report') or s, 'compare': counts or c}
        finally: m.close()
    attempt('Chora: the saved file checks clean on the main page, and the version check there finds two added and nothing lost or changed', saved_valid)

    def resave():
        f = fixture(ant, 'antonine-resave.json', tmp); chora_boot(page, base, [f]); chora_pick(page, 'londinium')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 90, y + 50)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        offered = (cstate(page)['lastSave'] or {}).get('passed') and page.is_visible('#chora-save-result button.primary')
        # A drawing made after the save is not in the file that save wrote.
        draw(page, 'point', [(x - 90, y - 50)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 2', 10)
        stale = page.is_visible('#chora-save-result button.primary') and page.is_enabled('#chora-save-result button.primary')
        if stale:                                               # as a user would: saving that file let both drawings go
            with page.expect_download(timeout=T(60) * 1000): page.click('#chora-save-result button.primary')
            page.wait_for_timeout(500)
        left, k, text = cstate(page)['pendingCount'], len(kept(page, f.name)), page.inner_text('#chora-save-result')
        return offered and not stale and left == 2 and k == 2 and 'save again' in text, {'offered after the save': offered, 'still offered after drawing': stale, 'pending': left, 'kept': k, 'said': text}
    attempt('Chora: a drawing made after a save withdraws that save\'s file, and no drawing is let go that the file does not hold', resave)
    def conversion_said():
        tables = sorted((ROOT / 'test/fixtures/tables-routes').glob('*.csv'))
        chora_boot(page, base, tables); chora_pick(page, 'cambridge')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 40, y + 40)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount >= 1', 10)
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}; text = page.inner_text('#chora-save-result')
        # The conversion's warnings, from the worker's own report, each shown on the page.
        warned = [i['message'] for i in (ls.get('report') or {}).get('items', []) if i['severity'] == 'warning']
        return (ls.get('passed') and warned and all(w in text for w in warned) and 'conversion' in text and 'PLATO JSON' in text and 'spreadsheet tables' in text), {'warnings': warned, 'said': text}
    attempt('Chora: a save of spreadsheet tables says the file is a conversion to PLATO JSON, and shows what the conversion reported', conversion_said)
    def world_copy():
        f = fixture(ant, 'antonine-wrap.json', tmp); chora_boot(page, base, [f]); chora_pick(page, 'londinium')
        c = page.evaluate('() => window.__chora_map.getCenter().toArray()')
        page.evaluate('c => window.__chora_map.jumpTo({ center: [c[0] + 360, c[1]] })', c); page.evaluate(SETTLE)
        x, y = map_centre(page)
        here = page.evaluate('([x, y]) => { const r = window.__chora_map.getCanvas().getBoundingClientRect(); return window.__chora_map.unproject([x - r.left, y - r.top]).toArray(); }', [x, y])
        draw(page, 'point', [(x, y)]); page.click('#chora-draw-tools button[data-mode="static"]')
        got = soon(page, '() => window.__chora.pendingCount === 1', 10)
        k = kept(page, f.name); lon = k[0]['geojson']['coordinates'][0] if k else None
        on_copy = here[0] > 180                                   # the point was drawn where longitudes run past 180
        ok_point = got and len(k) == 1 and lon is not None and -180 <= lon <= 180 and abs(lon - (here[0] - 360)) < 0.01
        # A line across the antimeridian cannot be a PLATO geometry as drawn: refused, in words, and not kept.
        page.evaluate('() => window.__chora_map.jumpTo({ center: [180, -17], zoom: 6 })'); page.evaluate(SETTLE)
        draw(page, 'linestring', [(x - 80, y), (x + 80, y), (x + 80, y)]); page.click('#chora-draw-tools button[data-mode="static"]')
        refused = soon(page, '() => !!window.__chora.drawError', 10)
        text = page.inner_text('#chora-card'); k2 = kept(page, f.name)
        line_gone = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["td-linestring"] }).length === 0', 5)
        return (on_copy and ok_point and refused and 'was not kept' in text and 'longitude must be between -180 and 180' in text
                and len(k2) == 1 and cstate(page)['pendingCount'] == 1 and line_gone), {'drawn at': here, 'kept': [d['geojson'] for d in k2], 'error': cstate(page).get('drawError'), 'line gone': line_gone}
    attempt('Chora: a point drawn on a copy of the world is kept on the world, and a line across the antimeridian is refused in words', world_copy)

    def from_card():
        # The file chosen in step 1 is shown at once when Chora's card is chosen, in the same page, with no
        # reload (the presence: the page's own state, kept from before the click, is still there after it).
        f = fixture(ant, 'antonine-card.json', tmp)
        page.bring_to_front(); page.goto('about:blank'); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.set_input_files('#picker', str(f))
        until(page, '() => window.__plato.phase === "detected"', 30)
        page.evaluate('() => { window.__samePage = true; }')
        before = page.evaluate('() => !!window.__chora')
        page.click('#toolbox a.tool-link[href="#chora"]')
        until(page, '() => window.__chora && ["loaded", "error"].includes(window.__chora.phase) && window.__chora.mapReadyCount >= 1', 60); s = cstate(page)
        drawn = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-overview-points", "chora-overview-clusters"] }).length > 0', 20)
        same = page.evaluate('() => window.__samePage === true')
        shown = page.evaluate('() => !document.getElementById("chora").hidden && document.body.hasAttribute("data-chora")')
        return (not before and same and shown and s['phase'] == 'loaded' and s['places'] == ant_places and drawn and page.url == base + '#chora'), {
            'Chora before the click': before, 'the same page': same, 'shown': shown, 'state': {k: s.get(k) for k in ('phase', 'places')}, 'drawn': drawn, 'url': page.url}
    attempt('Chora: its card opens it in the page, with no reload, the file chosen in step 1 already shown and its places drawn on the map', from_card)

    def from_step2():
        # The same from step 2's "Show on the map (Chora)", offered with no tool chosen; with a tool chosen it
        # is not offered (the presence first, so that its absence after means something).
        f = fixture(ant, 'antonine-step2.json', tmp)
        page.bring_to_front(); page.goto('about:blank'); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.set_input_files('#picker', str(f))
        until(page, '() => window.__plato.phase === "detected"', 30)
        offered = page.is_visible('#to-chora')
        page.click('#toolbox .tool-link[href="#tool=check"]'); narrowed = page.is_visible('#to-chora')
        page.click('#every-action'); page.evaluate('() => { window.__samePage = true; }'); page.click('#to-chora')
        until(page, '() => window.__chora && ["loaded", "error"].includes(window.__chora.phase)', 60)
        s = cstate(page); same = page.evaluate('() => window.__samePage === true')
        return offered and not narrowed and same and s['phase'] == 'loaded' and s['places'] == ant_places and page.url == base + '#chora', {
            'offered': offered, 'with Elenchos chosen': narrowed, 'same page': same, 'state': {k: s.get(k) for k in ('phase', 'places')}, 'url': page.url}
    attempt('Chora: step 2\'s "Show on the map (Chora)" opens it in the page with the chosen file, and is not offered once a tool is chosen', from_step2)

    def two_tabs():
        page.goto('about:blank')                                # no other Chora tab: two of those share one pool
        a = main_page(ctx, base); b = ctx.new_page()
        try:
            # Each tab is brought to the front before it is used: a map in a hidden tab never draws.
            a.bring_to_front()
            first = run_case(a, [fixture(judgements, 'judgements-twotabs.json', tmp)], 'convert', 'plato-jsonl')
            b.bring_to_front()
            a_out = [o['name'] for o in first.get('outputs') or []]
            s = chora_boot(b, base, [fixture(ant, 'antonine-twotabs.json', tmp)]); chora_pick(b, 'londinium')
            x, y = map_centre(b); draw(b, 'point', [(x + 80, y + 40)]); b.click('#chora-draw-tools button[data-mode="static"]')
            soon(b, '() => window.__chora.pendingCount === 1', 10)
            b.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
            b.click('#chora-save'); until(b, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
            sb = cstate(b); a.bring_to_front(); outs, chora_outs = opfs_names(a, 'outputs'), chora_saved_names(a)
            lines = download(a, a_out[0], tmp / 'twotabs.jsonl').read_text().strip().split('\n') if a_out and a_out[0] in outs else []
            again = run_case(a, [fixture(EX / 'place-centric-king-john.json', 'king-john-twotabs.json', tmp)], 'check')
            return {'first': first.get('phase'), 'a_out': a_out, 'chora': s, 'save': sb.get('lastSave'), 'error': sb.get('error'), 'outputs': outs, 'chora-saved': chora_outs, 'lines': len(lines), 'again': again.get('phase'), 'again errors': (again.get('report') or {}).get('errors')}
        finally: a.close(); b.close()
    both = {}
    def two_tabs_run():
        both.update(two_tabs()); r = both
        return (r['first'] == 'done' and r['chora']['phase'] == 'loaded' and (r['save'] or {}).get('passed') and r['again'] == 'done' and r['again errors'] == 0), r
    attempt('Chora and the main page open at once: Chora opens and saves a dataset, and the main page still runs', two_tabs_run)
    attempt('Chora and the main page open at once: Chora\'s save leaves the main page\'s unsaved output in place, and it saves',
            lambda: (bool(both) and both['a_out'] and both['a_out'][0] in both['outputs'] and 'antonine-twotabs.chora.json' in both['chora-saved'] and both['lines'] > 1, both))

    # Chora's working database is in a SQLite pool one tab alone can hold, so a second Chora tab cannot
    # start. It must say so in words, not show the browser's createSyncAccessHandle error; the first tab
    # is the control (it still opens a file), and once it is closed the second starts on a reload.
    ANOTHER_TAB = 'Chora is already open in another tab of this browser. Close it, or use that one.'
    def another_tab():
        page.goto('about:blank')                                # no Chora tab but these two
        one, two = ctx.new_page(), ctx.new_page()
        try:
            chora_boot(one, base)                               # brought to the front, and ready
            two.bring_to_front(); two.goto(NOTOOLS if PROVE else base + '#chora')
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); s2 = cstate(two); said = two.inner_text('#chora-phase')
            # A file chosen in the second tab's step 1 is not opened by its Chora, which cannot start (the page's own tools still read it).
            two.set_input_files('#picker', [str(fixture(judgements, 'judgements-second-tab.json', tmp))])
            detected = wait_state(two, lambda s: s.get('phase') in ('detected', 'unrecognised'), T(60), 'detection').get('phase')
            two.wait_for_timeout(500); s2b = cstate(two)
            one.bring_to_front(); one.set_input_files('#picker', [str(fixture(judgements, 'judgements-another-tab.json', tmp))])
            until(one, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)'); s1 = cstate(one)
            one.close()                                         # its worker, and the pool with it, let go
            two.bring_to_front(); two.reload()
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); after = cstate(two)
            return {'second': s2.get('phase'), 'said': said, 'second, a file chosen': {'page': detected, 'Chora': s2b.get('phase'), 'places': s2b.get('places')},
                    'first': s1.get('phase'), 'after closing the first': after.get('phase'), 'error': after.get('error') or s2.get('error')}
        finally:
            for p in (one, two):
                if not p.is_closed(): p.close()
    tabs = {}
    def another_tab_run():
        tabs.update(another_tab()); r = tabs
        return (r['second'] == 'in-another-tab' and r['said'].strip() == ANOTHER_TAB and 'createSyncAccessHandle' not in r['said']
                and 'Something went wrong' not in r['said'] and r['second, a file chosen'] == {'page': 'detected', 'Chora': 'in-another-tab', 'places': None}
                and r['first'] == 'loaded'), r
    attempt('Chora in a second tab says plainly that Chora is open in another tab, opens nothing chosen there (the page reads it), and the first still opens a file', another_tab_run)
    attempt('Chora in a second tab starts once the first is closed', lambda: (bool(tabs) and tabs['after closing the first'] == 'ready', tabs))

    # The main page's pool is let go when a run ends, so that the browser stops counting the room its
    # removed databases took (src/engine/worker.js, runEnv). Chora's is not: holding it is what keeps a
    # second Chora tab out, and Chora opens its session database from it outside any run. A run of
    # Chora's that ends with no database open (a save with no dataset opened, sent to the page's own
    # engine) must leave the pool held: a second tab is still kept out, and the first still opens a file.
    # The page's engine is the worker built from src/engine/worker.js (the map has workers of its own).
    WORKERS = '''(() => { const W = window.Worker; window.__workers = [];
      window.Worker = class extends W { constructor(...a) { super(...a); if (/\\/assets\\/worker-|\\/engine\\/worker\\.js/.test(String(a[0]))) window.__workers.push(this); } }; })()'''
    RUN_EMPTY = '''async (text) => { const w = window.__workers[0]; if (!w) return 'no engine';
      return await Promise.race([new Promise((r) => setTimeout(() => r('no reply'), 60000)), new Promise((r) => {
        const on = ({ data }) => { if (data.type === 'done' || data.type === 'error') { w.removeEventListener('message', on); r(data.type); } };
        w.addEventListener('message', on);
        w.postMessage({ cmd: 'chora-save', files: [new File([text], 'held.json', { type: 'application/json', lastModified: 1 })], additions: [] }); })]); }'''
    def pool_held():
        page.goto('about:blank')                                # no Chora tab but these two
        one, two = ctx.new_page(), ctx.new_page()
        try:
            one.add_init_script(WORKERS); chora_boot(one, base)
            ran = one.evaluate(RUN_EMPTY, ant.read_text())
            two.bring_to_front(); two.goto(NOTOOLS if PROVE else base + '#chora')
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            s2 = cstate(two); two.close()
            one.bring_to_front(); one.set_input_files('#picker', [str(fixture(judgements, 'judgements-held.json', tmp))])
            until(one, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)'); s1 = cstate(one)
            return {'run': ran, 'second': s2.get('phase'), 'first': s1.get('phase'), 'error': s1.get('error') or s2.get('error')}
        finally:
            for p in (one, two):
                if not p.is_closed(): p.close()
    held = {}
    def pool_held_run():
        held.update(pool_held()); r = held
        return r['run'] == 'done' and r['second'] == 'in-another-tab', r
    attempt('Chora keeps its pool when a run ends with no database open: a second Chora tab is still kept out', pool_held_run)
    attempt('Chora keeps its pool when a run ends with no database open: it still opens a file', lambda: (bool(held) and held['first'] == 'loaded', held))

    def narrow():
        page.goto('about:blank')
        n = ctx.new_page(); n.set_viewport_size({'width': 390, 'height': 844}); n.bring_to_front()
        try:
            chora_boot(n, base, [fixture(ant, 'antonine-narrow.json', tmp)])
            chora_pick(n, 'londinium')                           # a real click: the list is there, and nothing covers it
            wide = n.evaluate('() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, innerWidth]')
            panel = n.query_selector('#chora-panel').bounding_box(); canvas = n.query_selector('#chora-map canvas').bounding_box()
            x, y = map_centre(n); draw(n, 'point', [(x, y + 30)]); n.click('#chora-draw-tools button[data-mode="static"]')
            drew = soon(n, '() => window.__chora.pendingCount === 1 && window.__chora_map.queryRenderedFeatures({ layers: ["td-point"] }).length > 0', 10)
            return (wide[2] == 390 and wide[0] <= wide[1] and 300 <= panel['width'] <= 390 and canvas['width'] >= 300 and canvas['height'] >= 250 and drew), {
                'scrollWidth, clientWidth, innerWidth': wide, 'panel': panel, 'map': canvas, 'drew': drew}
        finally: n.close()
    attempt('Chora on a phone (390 by 844): no sideways scrolling, the list and the map both usable, a point drawn', narrow)

    # A dataset the schema refuses still opens in Chora, so what it holds is shown as data, never as
    # markup; a save of it that passes the version check still shows the problems the writing found;
    # and a drawing for a place whose attestations are not a list is refused before anything is written.
    def odd_dataset(name):
        d = tmp / 'chora-files'; d.mkdir(exist_ok=True)
        src = [{'title': 'A survey'}]
        places = [
            {'@id': 'https://example.org/p/trapdoor', 'label': 'Trapdoor', 'attestations': [{'geometries': [
                {'geojson': {'type': 'Point', 'coordinates': [-0.1, 51.5]}, 'precisionKm': ['<img src=x onerror="window.__pwned = 1">']}], 'sources': src}]},
            {'@id': 'https://example.org/p/control', 'label': 'Control', 'attestations': [{'geometries': [
                {'geojson': {'type': 'Point', 'coordinates': [-1.25, 51.75]}, 'precisionKm': [12.5]}], 'sources': src}]},
            {'@id': 'https://example.org/p/oddity', 'label': 'Oddity', 'attestations': None},
        ]
        (d / name).write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Odd', 'status': 'published', 'version': '1'}, 'spatialEntities': places}))
        return d / name
    def markup_not_run():
        chora_boot(page, base, [odd_dataset('odd-card.json')]); chora_pick(page, 'trapdoor')
        page.wait_for_timeout(500)                              # time for an image that errors to run its handler
        trap = {'imgs': page.eval_on_selector_all('#chora-card img', 'x => x.length'), 'pwned': page.evaluate('() => window.__pwned ?? null'), 'card': page.inner_text('#chora-card')}
        chora_pick(page, 'control'); ctl = page.inner_text('#chora-card')
        # The control: a radius that is a number is shown; the subject: the card was the trapdoor's, and holds a location.
        return (trap['imgs'] == 0 and trap['pwned'] is None and 'Trapdoor' in trap['card'] and 'Point' in trap['card'] and 'to within' not in trap['card']
                and 'Point, to within 12.5 km' in ctl), {'trapdoor': trap, 'control card': ctl[:300]}
    attempt('Chora: a place card shows a radius only when it is a number, and markup in a dataset is never run (a numeric one is shown)', markup_not_run)
    def draw_and_save(name, place, make=None):
        f = (make or odd_dataset)(name); chora_boot(page, base, [f]); chora_pick(page, place)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 50, y + 30)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        return f, cstate(page), page.inner_text('#chora-save-result')
    def problems_shown():
        _, s, text = draw_and_save('odd-problems.json', 'trapdoor'); ls = s.get('lastSave') or {}
        errs = [i for i in (ls.get('report') or {}).get('items', []) if i['severity'] == 'error']
        return (ls.get('passed') and errs and all(i['message'] in text for i in errs) and 'found problems' in text), {'passed': ls.get('passed'), 'errors': [i['message'] for i in errs], 'said': text[:400]}
    attempt('Chora: a save that passes the version check still shows the problems the writing of it found', problems_shown)
    def not_a_list():
        f, s, text = draw_and_save('odd-unlisted.json', 'oddity'); ls = s.get('lastSave') or {}
        written = opfs_names(page, 'chora-outputs')
        return (ls.get('passed') is False and 'attestations are not a list' in text and 'Oddity (https://example.org/p/oddity)' in text
                and not page.is_visible('#chora-save-result button.primary') and 'odd-unlisted.chora.json' not in written and s['pendingCount'] == 1), {
                'save': {k: ls.get(k) for k in ('passed', 'added')}, 'said': text[:300], 'chora-outputs': written, 'pending': s.get('pendingCount')}
    attempt('Chora: a drawing for a place whose attestations are not a list is refused, naming the place, and no file is written or offered', not_a_list)

    STEP1 = '''async () => { const f = document.getElementById('picker').files[0]; if (!f) return null;
      try { return { name: f.name, bytes: (await f.arrayBuffer()).byteLength }; } catch (e) { return { name: f.name, error: e.name }; } }'''
    def save_again(place):
        # A drawing for `place`, saved; the save's state (lastSave cleared first, so that this save's is waited for).
        chora_pick(page, place)
        x, y = map_centre(page); draw(page, 'point', [(x + 40, y - 30)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount >= 1', 10)
        page.evaluate('() => { window.__chora.lastSave = null; window.__chora.handedOver = null; }')
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        return cstate(page).get('lastSave') or {}
    def downloaded():
        with page.expect_download(timeout=T(60) * 1000) as dl: page.click('#chora-save-result button.primary')
        return json.loads(pathlib.Path(dl.value.path()).read_text())
    by_label = lambda doc, label: next((x for x in doc['spatialEntities'] if x.get('label') == label), None)
    drawn_on = lambda doc, label: 'Ada Test' in json.dumps(by_label(doc, label) or {})

    def builds_on_saved():
        # Saved, the file downloaded and its drawings let go: Chora has the file it saved open from then on, so
        # that a second save holds the first's drawing too (the first file holds only its own: the presence).
        f, s, _ = draw_and_save('odd-twice.json', 'control')
        if not (s.get('lastSave') or {}).get('passed'): raise RuntimeError('the first save did not pass')
        until(page, '() => !!window.__chora.handedOver', 30)
        first = downloaded()
        page.click('#chora-save-result button[data-clear]')
        until(page, '() => window.__chora.rebased === "odd-twice.chora.json" && window.__chora.pendingCount === 0', 60)
        said = page.inner_text('#chora-save-result')
        ls = save_again('trapdoor')
        if not ls.get('passed'): return False, {'second save': ls}
        second = downloaded()
        got = {'first': {'control': drawn_on(first, 'Control'), 'trapdoor': drawn_on(first, 'Trapdoor')},
               'second': {'control': drawn_on(second, 'Control'), 'trapdoor': drawn_on(second, 'Trapdoor')},
               'second file': (ls.get('outputs') or [{}])[0].get('name'), 'said': said[-200:]}
        return (got['first'] == {'control': True, 'trapdoor': False} and got['second'] == {'control': True, 'trapdoor': True}
                and 'is open here now' in said), got
    attempt('Chora: once a saved file\'s drawings are let go, Chora has that file open, and the next save builds on it: it holds the first save\'s drawing and the second\'s', builds_on_saved)

    def refused_keeps_step1():
        # A save handed to the page (chosen in step 1), then a second save, from the same dataset, refused by its
        # check: step 1's file can still be read, as it could before (the presence).
        f, s, _ = draw_and_save('odd-refused.json', 'control')
        if not (s.get('lastSave') or {}).get('passed'): raise RuntimeError('the first save did not pass')
        until(page, '() => !!window.__chora.handedOver', 30)
        before = page.evaluate(STEP1)
        ls = save_again('oddity')
        after = page.evaluate(STEP1)
        return (before and before.get('name') == 'odd-refused.chora.json' and before.get('bytes', 0) > 0 and ls.get('passed') is False
                and after == before), {'step 1 before': before, 'second save passed': ls.get('passed'), 'step 1 after': after}
    attempt('Chora: a later save refused by its check (after clearing the folder it writes in) leaves the file an earlier save handed to step 1 readable there', refused_keeps_step1)

    # ---- At DEEP's scale (1.4 million attestations; a save of 14 minutes, most of it the version check).
    def jsonl_dataset(name):
        d = tmp / 'chora-files'; d.mkdir(exist_ok=True)
        src = [{'title': 'A survey'}]
        rows = [{'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Lines', 'licence': 'https://creativecommons.org/licenses/by/4.0/', 'status': 'published', 'version': '1'}},
                {'@id': 'https://example.org/p/first', 'label': 'First', 'attestations': [{'names': [{'toponym': 'First'}], 'sources': src}]},
                {'subject': 'https://example.org/p/first', 'object': 'https://sws.geonames.org/1/', 'identityType': 'unspecified'},
                {'@id': 'https://example.org/p/after', 'label': 'After', 'attestations': [{'geometries': [{'geojson': {'type': 'Point', 'coordinates': [-1.25, 51.75]}}], 'sources': src}]}]
        (d / name).write_text(''.join(json.dumps(r) + '\n' for r in rows)); return d / name
    def jsonl_saved():
        # The control first: a PLATO JSON document is saved as one.
        chora_boot(page, base, [odd_dataset('lines-control.json')]); as_json = page.inner_text('#chora-save')
        f, s, text = draw_and_save('lines.jsonl', 'after', jsonl_dataset); ls = s.get('lastSave') or {}
        as_lines = page.inner_text('#chora-save')
        return (as_json == 'Save as PLATO JSON' and as_lines == 'Save as PLATO JSON Lines' and ls.get('passed') and ls.get('added') == 1
                and [o['name'] for o in ls.get('outputs', [])] == ['lines.chora.jsonl'] and 'The saved file is PLATO JSON Lines, as the dataset is' in text), {
            'button, JSON': as_json, 'button, JSON Lines': as_lines, 'save': {k: ls.get(k) for k in ('passed', 'added', 'outputs')}, 'said': text[:300]}
    attempt('Chora: a JSON Lines dataset is offered and saved as PLATO JSON Lines, and passes the version check; a JSON one as PLATO JSON', jsonl_saved)
    def save_steps():
        f, s, text = draw_and_save('steps.json', 'control'); ls = s.get('lastSave') or {}
        steps = [x['text'] for x in s.get('saveProgress') or []]
        has = lambda pattern: any(re.search(pattern, t) for t in steps)
        # The odd dataset has two attestations (Oddity's are not a list); the file written, three.
        return (ls.get('passed') and has(r'^Saving, step 1 of 2, writing the file: 2 of 2 attestations')
                and has(r'^Saving, step 2 of 2, the version check \(Mneme\), reading the dataset as opened: 2 of 2 attestations')
                and has(r'^Saving, step 2 of 2, the version check \(Mneme\), reading the file written: 3 of 3 attestations')
                and has(r'comparing the two') and not page.is_visible('#chora-save-progress')), {'passed': ls.get('passed'), 'steps': steps, 'still shown': page.is_visible('#chora-save-progress')}
    attempt('Chora: a save shows each step on the page: writing the file, then the version check reading each version, n of N attestations, then comparing', save_steps)
    # The browser's storage: navigator.storage.estimate() is answered by the init script from
    # localStorage, set for these checks alone, so that a browser short of room can be had on demand.
    STUB = 'e2e-storage-estimate'
    def storage_short():
        try:
            page.evaluate('([k, v]) => localStorage.setItem(k, v)', [STUB, json.dumps({'quota': 1000000, 'usage': 999500})])
            f, s, text = draw_and_save('storage-short.json', 'control'); ls = s.get('lastSave') or {}
            load_warning = page.inner_text('#chora-storage-warning') if page.is_visible('#chora-storage-warning') else ''
            save_warning = page.inner_text('#chora-save-storage-warning') if page.is_visible('#chora-save-storage-warning') else ''
            short = s.get('storage') or {}
            # The control: with room, the same kind of file opens with no warning, and the answer given is the stub's.
            page.evaluate('([k, v]) => localStorage.setItem(k, v)', [STUB, json.dumps({'quota': 1e12, 'usage': 0})])
            room = chora_boot(page, base, [odd_dataset('storage-room.json')])
            quiet = not page.is_visible('#chora-storage-warning') and room.get('phase') == 'loaded' and (room.get('storage') or {}).get('quota') == 1e12 and (room.get('storage') or {}).get('short') is False
            return (short.get('quota') == 1000000 and short.get('short') and 'Opening this dataset needs about' in load_warning and 'only 500 bytes left' in load_warning
                    and 'Saving needs about' in save_warning and ls.get('passed') and quiet), {
                'short': short, 'load warning': load_warning, 'save warning': save_warning, 'saved all the same': ls.get('passed'), 'with room': room.get('storage'), 'quiet with room': quiet}
        finally:
            try: page.evaluate('k => localStorage.removeItem(k)', STUB)
            except Exception: pass
    attempt('Chora: a browser short of storage is warned, plainly, before a dataset is opened and before it is saved; one with room is not', storage_short)
    # A large dataset (over 200 MB read) does not have the browser asked to keep this site's storage:
    # navigator.storage.persist() shows a permission prompt in Firefox, and persistent storage is to be
    # offered in the toolbox's Permissions window, not by Chora. The init script records any call of
    # persist() or persisted(). The large one is a gzip of 1 MB or so whose trailer says 210 MB (a PLATO
    # document, then that much blank space). Presence: it is read at that size, the plain space warning is
    # shown for it when the browser is short (and the dataset opens all the same), and the recorder is seen
    # to record a call made directly.
    def big_dataset(name):
        import gzip
        d = tmp / 'chora-files'; d.mkdir(exist_ok=True)
        doc = json.loads(odd_dataset('big-src.json').read_text())
        with gzip.open(d / name, 'wb', compresslevel=9) as g:
            g.write(json.dumps(doc).encode()); chunk = b' ' * (1 << 20)
            for _ in range(210): g.write(chunk)
        return d / name
    def no_persist():
        try:
            big = big_dataset('big-no-persist.json.gz')
            page.evaluate('([k, v]) => localStorage.setItem(k, v)', [STUB, json.dumps({'quota': 1e8, 'usage': 0})])
            s = chora_boot(page, base, [big]); st = s.get('storage') or {}
            calls = page.evaluate('() => window.__e2e_persistCalls')
            warning = page.inner_text('#chora-storage-warning') if page.is_visible('#chora-storage-warning') else ''
            note = page.query_selector('#storage-note')
            # The control: the recorder sees a call made directly.
            page.evaluate('() => navigator.storage.persist()')
            seen = page.evaluate('() => window.__e2e_persistCalls')
            return (st.get('bytes', 0) > 2e8 and st.get('short') and 'Opening this dataset needs about' in warning and s.get('phase') == 'loaded'
                    and calls == [] and 'persist' not in s and (note is None or not note.is_visible()) and seen == ['persist']), {
                'storage': st, 'phase': s.get('phase'), 'calls during the open': calls, 'warning': warning[:120], 'state.persist': s.get('persist'),
                'note shown': bool(note and note.is_visible()), 'recorder control': seen}
        finally:
            try: page.evaluate('k => localStorage.removeItem(k)', STUB)
            except Exception: pass
    attempt('Chora: a large dataset opens without asking the browser to keep its storage (no persist(), no note), and the plain space warning is still given', no_persist)

    # Over everything above: loading, drawing, saving, Chora opened from the card and step 2, and two tabs.
    attempt('Chora: across all these checks, no request went to any other site, and no page error', lambda: (
        len(web()) > 50 and 'loaded' in loads and not foreign() and not errors, {'requests': len(web()), 'foreign': foreign(), 'errors': errors[:5]}))

    # ---- Permissions. After that check, since these ask other sites (each answered here, by a route).
    # Each check sets the permissions it needs in this profile's storage, and reloads, as a user would.
    PNG = __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
    OSM = 'https://tile.openstreetmap.org'
    hits = {'osm': 0, 'second': 0}
    def osm(route): hits['osm'] += 1; route.fulfill(status=200, content_type='image/png', body=PNG, headers={'Access-Control-Allow-Origin': '*'})
    ctx.route(OSM + '/**', osm)
    RESET = '''([g, b]) => { localStorage.removeItem('plato-tools.permissions'); sessionStorage.removeItem('plato-tools.permissions.tab');
      localStorage.removeItem('chora-basemaps'); localStorage.removeItem('plato-tools.keep-working-data');
      if (g) localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: g }));
      if (b) localStorage.setItem('chora-basemap', JSON.stringify(b)); else localStorage.removeItem('chora-basemap'); }'''
    def fresh(grants=None, basemap=None, files=None):
        """Chora with these permissions remembered (and nothing else decided), this basemap chosen, these files open."""
        chora_boot(page, base)
        page.evaluate(RESET, [grants, basemap])
        return chora_boot(page, base, files)
    def allow_in_panel(key):
        """From a "Needs permission" line: open the panel at it, allow it, and reload as the panel offers. Where the focus went."""
        page.click(f'[data-permission="{key}"] button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        at = page.evaluate(PANEL_STATE)
        page.check(f'#permissions-panel fieldset.perm[data-key="{key}"] input[value="allowed"]')
        with page.expect_navigation(timeout=60_000): page.click('#permissions-panel [data-reload]')
        until(page, '() => window.__chora && window.__chora.phase !== "reloading" && window.__chora.mapReadyCount >= 1 && window.__chora.canary !== "pending"', 60)
        return at
    def choose(bid):
        page.evaluate("() => { document.getElementById('chora-basemaps').open = true; }")
        page.check(f'input[name="basemap"][value="{bid}"]')
    META = '''() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null'''

    def allow_reload():
        fresh(files=[fixture(ant, 'antonine-allow.json', tmp)]); since = len(requests); h0 = hits['osm']
        choose('osm')
        line = page.inner_text('[data-permission="basemap:osm"]') if page.is_visible('[data-permission="basemap:osm"]') else ''
        before = {'osm asked': hits['osm'] - h0 + len([u for u in requests[since:] if u.startswith(OSM)]), 'basemap': cstate(page)['basemap']}
        at = allow_in_panel('basemap:osm')
        used = soon(page, '() => window.__chora.basemap === "osm" && window.__chora_map.isStyleLoaded()', 30)
        got = soon(page, '() => window.__chora_map.isSourceLoaded("basemap")', 30) and hits['osm'] > h0
        until(page, '() => ["loaded", "place"].includes(window.__chora.phase)', 60)
        after = cstate(page); csp = page.evaluate('() => window.__platoCsp')
        return ('Needs permission: OpenStreetMap' in line and before['osm asked'] == 0 and before['basemap'] == 'natural-earth'
                and at['open'] and at['focusKey'] == 'basemap:osm' and at['focusValue'] == 'undecided'
                and used and got and OSM in csp['origins'] and (after.get('resumed') or {}).get('files') == ['antonine-allow.json'] and after.get('places') == ant_places), {
            'line': line, 'before': before, 'panel focus': at, 'used': used, 'tiles': hits['osm'] - h0, 'policy': csp['origins'], 'resumed': after.get('resumed')}
    attempt('Chora: OpenStreetMap chosen asks nothing and says "Needs permission"; its button opens the panel at that permission; allowed and reloaded, its tiles are fetched, with the dataset still open', allow_reload)
    def chora_asks():
        fresh(); choose('osm')
        page.fill('#chora-paste', 'https://tiles.example.org/style.json')   # typed, not yet added
        page.click('[data-permission="basemap:osm"] button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.check('#permissions-panel fieldset.perm[data-key="basemap:osm"] input[value="allowed"]')
        page.click('#permissions-panel [data-reload]')
        asked = page.inner_text('#permissions-panel .perm-confirm') if page.is_visible('#permissions-panel .perm-confirm') else ''
        page.click('#permissions-panel [data-reload-cancel]'); page.keyboard.press('Escape')
        kept = page.input_value('#chora-paste') if page.is_visible('#chora-paste') else ''
        page.evaluate(RESET, [None, None])
        return 'pasting a basemap, not yet added' in asked and kept == 'https://tiles.example.org/style.json', {'asked': asked, 'kept': kept}
    attempt('Chora: a reload for a permission while an address waits in the paste box says so first, and Cancel keeps it', chora_asks)
    PROBE = 'u => { const m = window.__chora_map; const id = "probe-" + Math.random().toString(36).slice(2); m.addSource(id, { type: "raster", tiles: [u + "/{z}/{x}/{y}.png?" + id], tileSize: 256 }); m.addLayer({ id, type: "raster", source: id }); }'
    def revoke():
        fresh({'basemap:osm': {'state': 'allowed'}}, 'osm')
        on = soon(page, '() => window.__chora.basemap === "osm" && window.__chora_map.isStyleLoaded()', 20)
        h0 = hits['osm']
        page.evaluate(PROBE, OSM)
        page.wait_for_timeout(1500); control = hits['osm'] - h0
        page.click('#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.check('#permissions-panel fieldset.perm[data-key="basemap:osm"] input[value="never"]')
        page.keyboard.press('Escape')
        back = soon(page, '() => window.__chora.basemap === "natural-earth" && window.__chora_map.isStyleLoaded()', 20)
        b0 = cstate(page)['blocked']; h1 = hits['osm']; since = len(requests)
        page.evaluate(PROBE, OSM)
        blocked = soon(page, 'b => window.__chora.blocked > b', 20, b0)
        page.wait_for_timeout(1000)
        offered = page.is_visible('input[name="basemap"][value="osm"]')
        return (on and control > 0 and back and blocked and hits['osm'] == h1 and not [u for u in requests[since:] if u.startswith(OSM)]
                and OSM in cstate(page)['blockedOrigins'] and not offered and not page.is_visible('[data-permission="basemap:osm"]')), {
            'used': on, 'tiles before': control, 'back on Natural Earth': back, 'refused': blocked, 'asked after': hits['osm'] - h1, 'still offered': offered}
    attempt('Chora: OpenStreetMap allowed is used; set to Never in the panel, the map goes back to Natural Earth at once, its tiles are refused and not asked, and it is no longer offered (silently)', revoke)
    def panel_chora():
        fresh(); opened, closed, text = panel_cycle(page)
        return (opened['open'] and opened['focus'] == 'permissions-h' and not closed['open'] and closed['focus'] == 'permissions-button'
                and 'OpenStreetMap' in text and 'Keep my working data between visits' in text and 'Remember my token in this browser' in text
                and page.query_selector('header .privacy') is None), {'opened': opened, 'closed': closed}
    attempt('Chora: the Permissions panel opens from the header with the focus on its heading, Esc closes it and the focus returns; no privacy banner', panel_chora)
    def forged():
        INJECT = 'https://evil.example.org; script-src *'
        fresh({'basemap:https://forged.example.org': {'state': 'allowed', 'at': '2026-09-01T10:00:00Z', 'added': True}, f'basemap:{INJECT}': {'state': 'allowed'}, 'basemap:nosuch': {'state': 'allowed'}})
        csp = page.evaluate('() => window.__platoCsp'); meta = page.evaluate(META) or ''
        page.click('#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        keys = page.eval_on_selector_all('#permissions-panel fieldset.perm', 'fs => fs.map((f) => f.dataset.key)')
        sel = '#permissions-panel fieldset.perm[data-key="basemap:https://forged.example.org"]'
        entry = page.inner_text(sel) if 'basemap:https://forged.example.org' in keys else ''
        checked = page.evaluate('s => document.querySelector(s + " input:checked")?.value || null', sel)
        page.keyboard.press('Escape')
        return (csp['origins'] == ['https://forged.example.org'] and 'https://forged.example.org' in meta and 'evil' not in meta and 'evil' not in ' '.join(keys)
                and 'basemap:nosuch' not in keys and checked == 'allowed' and 'Added on 1 September 2026' in entry and 'You added' not in entry), {'policy': csp['origins'], 'keys': keys, 'entry': entry, 'checked': checked}
    attempt('Chora: a grant forged in storage is in the policy and listed in the panel, as kept; an injected site and an unknown provider are in neither', forged)
    def no_policy():
        page_url = base                                         # the page as served: Chora is in it, at #chora
        fresh({'basemap:osm': {'state': 'allowed'}}, 'osm'); h0 = hits['osm']
        ctx.route(page_url, strip_head)
        try:
            page.goto('about:blank'); page.goto(NOTOOLS if PROVE else page_url + '#chora')
            until(page, '() => window.__chora && window.__chora.canary && window.__chora.canary !== "pending" && window.__chora.mapReadyCount >= 1', 30)
            soon(page, '() => !!window.__chora.basemapError', 10)
            page.wait_for_timeout(1000)
            s = cstate(page); meta = page.evaluate(META)
        finally:
            ctx.unroute(page_url, strip_head)
        return (s['canary'] == 'not-enforced' and not meta and s['basemap'] == 'natural-earth' and 'protection' in (s.get('basemapError') or '') and hits['osm'] == h0), {
            'canary': s.get('canary'), 'why': s.get('canaryWhy'), 'meta': meta, 'basemap': s.get('basemap'), 'error': s.get('basemapError'), 'osm asked': hits['osm'] - h0}
    attempt('Chora: served without the script that writes its policy, the canary says it is not enforced, and an allowed basemap is not used (no other site asked)', no_policy)
    def keep_off():
        name = 'antonine-keepoff.json'; f = fixture(ant, name, tmp)
        fresh(files=[f]); chora_pick(page, 'londinium')
        x, y = map_centre(page); draw(page, 'point', [(x + 150, y + 60)]); page.click('#chora-draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.wait_for_timeout(500); held = len(kept(page, name))
        # A historical map shown, as Chora keeps one (chora-overlays/): a file put there stands for it.
        page.evaluate('''async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays', { create: true });
          const w = await (await d.getFileHandle('map.json', { create: true })).createWritable(); await w.write('{}'); await w.close(); }''')
        maps = opfs_names(page, 'chora-overlays')
        page.click('#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.uncheck('#perm-keep-work'); page.keyboard.press('Escape')
        off = page.evaluate("() => localStorage.getItem('plato-tools.keep-working-data')")
        s = chora_boot(page, base)
        until(page, '() => window.__chora.workingCleared === true', 10)
        left = opfs_names(page, 'chora-drafts'); maps_left = opfs_names(page, 'chora-overlays')
        s2 = chora_boot(page, base, [f])
        page.evaluate("() => localStorage.removeItem('plato-tools.keep-working-data')")
        return held == 1 and maps == ['map.json'] and off == 'no' and left == [] and maps_left == [] and s2.get('pendingCount') == 0, {
            'kept before': held, 'maps before': maps, 'setting': off, 'drafts left': left, 'maps left': maps_left, 'pending after': s2.get('pendingCount')}
    attempt('Chora: with "Keep my working data between visits" turned off in the panel, the drawings and historical maps kept are cleared at the next load (both were kept before)', keep_off)

    STYLES = 'https://styles.example.org'
    GOOD = json.dumps({'version': 8, 'name': 'Probe style', 'sources': {}, 'layers': [{'id': 'probe-bg', 'type': 'background', 'paint': {'background-color': '#f4efe4'}}]})
    CORS = {'Access-Control-Allow-Origin': '*'}
    ctx.route(STYLES + '/**', lambda route: route.fulfill(status=200, content_type='application/json', body=GOOD, headers=CORS) if route.request.url.endswith('/good.json') else route.fulfill(status=404, body='not here', headers=CORS))
    def paste(address):
        page.evaluate("() => { document.getElementById('chora-basemaps').open = true; }")
        page.fill('#chora-paste', address); page.click('#chora-paste-form button[type=submit]')
    def use_remembered():
        """After a reload, a pasted basemap is only remembered, never used until asked for in this load: ask (H2)."""
        page.evaluate("() => { document.getElementById('chora-basemaps').open = true; }")
        until(page, '() => !!document.getElementById("chora-use-remembered")', 10)
        page.click('#chora-use-remembered')
    def bad_style():
        fresh(); since = len(requests)
        # The control: a style that loads is kept, once its site is allowed (and the page reloaded).
        paste(STYLES + '/good.json')
        allow_in_panel('basemap:' + STYLES); use_remembered()
        kept_good = soon(page, '() => window.__chora_map.getStyle()?.name === "Probe style"', 20) and cstate(page)['basemap'].startswith('pasted-')
        paste(STYLES + '/missing.json')
        back = soon(page, '() => window.__chora.basemap === "natural-earth" && !!window.__chora.basemapError', 20)
        asked = any(u.endswith('/missing.json') for u in requests[since:])   # it failed for being missing, not for never being asked
        drew = soon(page, '() => window.__chora_map.getStyle()?.name?.includes("Natural Earth") && window.__chora_map.queryRenderedFeatures({ layers: ["land"] }).length > 0', 30)
        text = page.inner_text('#chora-basemap-options'); s = cstate(page)
        return (kept_good and asked and back and drew and 'Natural Earth' in text and 'could not be loaded' in text and s['basemapError'] in text), {
            'the good style kept': kept_good, 'asked for the missing one': asked, 'state': {k: s.get(k) for k in ('basemap', 'basemapError')}, 'said': text[:300]}
    attempt('Chora: a basemap whose style cannot be loaded gives way to Natural Earth, and the page says why (a style that loads is kept)', bad_style)
    # A pasted style whose sources are on a second site: that site needs its own permission once the
    # style is read, and is asked nothing until it is allowed; then both are used, and a third still refused.
    MULTI, SECOND, THIRD = 'https://multi.example.org', 'https://second.example.net', 'https://third.example.com'
    MULTI_STYLE = json.dumps({'version': 8, 'name': 'Multi probe', 'sources': {'second': {'type': 'raster', 'tiles': [SECOND + '/{z}/{x}/{y}.png'], 'tileSize': 256}},
                              'layers': [{'id': 'multi-bg', 'type': 'background', 'paint': {'background-color': '#eee'}}, {'id': 'second', 'type': 'raster', 'source': 'second'}]})
    def second(route): hits['second'] += 1; route.fulfill(status=200, content_type='image/png', body=PNG, headers=CORS)
    ctx.route(MULTI + '/**', lambda route: route.fulfill(status=200, content_type='application/json', body=MULTI_STYLE, headers=CORS))
    ctx.route(SECOND + '/**', second)
    ctx.route(THIRD + '/**', lambda route: route.abort())
    def multi_origin():
        fresh(); since = len(requests)
        paste(MULTI + '/style.json')
        sel = f'[data-permission="basemap:{MULTI}"]'
        first = page.inner_text(sel) if page.is_visible(sel) else ''
        unread = not any(u.startswith(MULTI) for u in requests[since:])
        allow_in_panel('basemap:' + MULTI); use_remembered()
        # Once the style is read, a line for the second site, and nothing yet asked of it.
        asked_second = soon(page, 's => !!document.querySelector(`[data-permission="basemap:${s}"]`)', 20, SECOND)
        page.wait_for_timeout(500)
        read = any(u.startswith(MULTI) for u in requests[since:])
        before = {'second asked': hits['second'] + len([u for u in requests[since:] if u.startswith(SECOND)]), 'basemap': cstate(page)['basemap']}
        if asked_second: allow_in_panel('basemap:' + SECOND); use_remembered()
        used = soon(page, '() => window.__chora_map.getStyle()?.name === "Multi probe"', 20)
        got = soon(page, '() => window.__chora_map.isSourceLoaded("second")', 20) and hits['second'] > 0
        # The control: a third site, allowed by nothing, is still refused.
        b0 = cstate(page)['blocked']
        page.evaluate('t => { const m = window.__chora_map; m.addSource("probe-third", { type: "raster", tiles: [t + "/{z}/{x}/{y}.png"], tileSize: 256 }); m.addLayer({ id: "probe-third", type: "raster", source: "probe-third" }); }', THIRD)
        third = soon(page, 'b => window.__chora.blocked > b', 20, b0)
        after = cstate(page)
        return ('Needs permission: multi.example.org' in first and unread and asked_second and read and before['second asked'] == 0 and not before['basemap'].startswith('pasted-')
                and used and got and third and THIRD in after['blockedOrigins'] and SECOND not in after['blockedOrigins']
                and not any(u.startswith(THIRD) for u in requests[since:])), {
            'first line': first, 'style unread before': unread, 'second site asked about': asked_second, 'style read': read, 'before allowing': before, 'used': used,
            'second fetched': got, 'hits': hits, 'third refused': third, 'blocked': after['blockedOrigins']}
    attempt('Chora: a pasted style on two sites needs each allowed before either is asked for tiles; once both are, both are used, and a third site is still refused', multi_origin)
    # The Consortium of Ancient World Mappers' tiles (14 October 2026), answered here: a PNG for each,
    # or, while cawm_mode says so, a failed connection, as a browser that refuses the site's certificate
    # would see it (its chain is incomplete: DEVELOPERS.md).
    CAWM = 'https://cawm.lib.uiowa.edu'
    hits['cawm'] = 0; cawm_mode = {'fail': False}
    def cawm(route):
        hits['cawm'] += 1
        if cawm_mode['fail']: route.abort('failed')
        else: route.fulfill(status=200, content_type='image/png', body=PNG, headers=CORS)
    ctx.route(CAWM + '/**', cawm)
    cawm_zooms = lambda since: [int(m.group(1)) for u in requests[since:] for m in [re.match(re.escape(CAWM) + r'/tiles/(\d+)/\d+/\d+\.png$', u)] if m]
    ATTRIB = '''() => { const a = document.querySelector('#chora-map .maplibregl-ctrl-attrib-inner'); return a ? { text: a.textContent, links: [...a.querySelectorAll('a')].map((x) => x.href) } : null; }'''
    def cawm_basemap():
        fresh(); since = len(requests); h0 = hits['cawm']
        choose('cawm')
        line = page.inner_text('[data-permission="basemap:cawm"]') if page.is_visible('[data-permission="basemap:cawm"]') else ''
        note = page.inner_text('#chora-basemap-options')
        before = {'cawm asked': hits['cawm'] - h0 + len([u for u in requests[since:] if u.startswith(CAWM)]), 'basemap': cstate(page)['basemap']}
        since = len(requests); at = allow_in_panel('basemap:cawm')
        used = soon(page, '() => window.__chora.basemap === "cawm" && window.__chora_map.isStyleLoaded()', 30)
        got = soon(page, '() => window.__chora_map.isSourceLoaded("basemap")', 30) and hits['cawm'] > h0
        page.evaluate(SETTLE)
        zooms = cawm_zooms(since); sites = foreign(since); attrib = page.evaluate(ATTRIB) or {}
        ours = page.evaluate('() => ["chora-overview-points", "chora-vague-marks", "chora-place-points"].filter((l) => !!window.__chora_map.getLayer(l))')
        # Beyond its zoom 11 the tiles of 11 are drawn larger: asked at 11, never above.
        z0 = len(requests)
        page.evaluate('() => window.__chora_map.jumpTo({ center: [12.49, 41.89], zoom: 13.6 })'); page.evaluate(SETTLE)
        over = cawm_zooms(z0)
        s = cstate(page)
        return ('Needs permission: Consortium of Ancient World Mappers' in line and 'ancient Mediterranean and Middle East' in note
                and before['cawm asked'] == 0 and before['basemap'] == 'natural-earth'
                and at['open'] and at['focusKey'] == 'basemap:cawm' and at['focusValue'] == 'undecided'
                and used and got and zooms and all(1 <= z <= 11 for z in zooms) and sites == ['cawm.lib.uiowa.edu']
                and 'Consortium of Ancient World Mappers' in (attrib.get('text') or '') and 'CC BY 4.0' in (attrib.get('text') or '')
                and CAWM + '/' in (attrib.get('links') or []) and len(ours) == 3
                and over and set(over) == {11} and not s.get('basemapError')), {
            'line': line, 'note shown': 'ancient Mediterranean' in note, 'before': before, 'panel focus': at, 'used': used, 'tiles': hits['cawm'] - h0,
            'zooms asked': sorted(set(zooms)), 'sites asked': sites, 'attribution': attrib, 'our layers': ours, 'zooms asked at 13.6': sorted(set(over)), 'error': s.get('basemapError')}
    attempt('Chora: Ancient World (CAWM) chosen asks nothing and says "Needs permission"; allowed and reloaded, its tiles (zooms 1 to 11, 11 when zoomed in further) are asked of cawm.lib.uiowa.edu and no other site, with its attribution and its regional note shown', cawm_basemap)
    def cawm_remembered():
        fresh({'basemap:cawm': {'state': 'allowed'}}, 'cawm')
        first = soon(page, '() => window.__chora.basemap === "cawm" && window.__chora_map.isSourceLoaded("basemap")', 30)
        h0 = hits['cawm']; since = len(requests)
        s = chora_boot(page, base)                              # a reload, as the user's next visit
        again = soon(page, '() => window.__chora.basemap === "cawm" && window.__chora_map.isSourceLoaded("basemap")', 30)
        checked = page.evaluate('() => document.querySelector(\'input[name="basemap"]:checked\')?.value || null')
        name = page.inner_text('#chora-basemap-name')
        return (first and again and hits['cawm'] > h0 and checked == 'cawm' and name == 'Ancient World (CAWM)' and foreign(since) == ['cawm.lib.uiowa.edu']), {
            'first load': first, 'after the reload': again, 'tiles after': hits['cawm'] - h0, 'checked': checked, 'named': name, 'sites': foreign(since)}
    attempt('Chora: Ancient World (CAWM), allowed and chosen, is still the basemap after a reload, and its tiles are asked again', cawm_remembered)
    def cawm_unreachable():
        cawm_mode['fail'] = True
        try:
            h0 = hits['cawm']
            fresh({'basemap:cawm': {'state': 'allowed'}}, 'cawm')
            back = soon(page, '() => window.__chora.basemap === "natural-earth" && !!window.__chora.basemapError', 30)
            text = page.inner_text('#chora-basemap-options'); s = cstate(page)
        finally:
            cawm_mode['fail'] = False
        err = s.get('basemapError') or ''
        return (hits['cawm'] > h0 and back and err.startswith(f'Ancient World (CAWM) could not be loaded from {CAWM} (none of its tiles could be loaded')
                and 'back on Natural Earth' in err and err in text), {'asked': hits['cawm'] - h0, 'back': back, 'error': err, 'said': text[:300]}
    attempt('Chora: Ancient World (CAWM) allowed, but its site unreachable (no tile loads), gives way to Natural Earth, and the page says it could not be loaded from cawm.lib.uiowa.edu', cawm_unreachable)
    # ---- The shared origin, the frame and the referrer: the security audit of 1 October 2026.
    # Every page of pelagios.org can write this browser's storage for the tools. What one could write:
    # a grant for a site, marked as if the user had added it, a pasted basemap on that site and the
    # choice of it. None of it may put the basemap on the map at load: the map stays on Natural Earth,
    # the site is asked nothing, the page names the remembered choice, and a click uses it (the control).
    INJECTED = 'https://injected.example.org'
    hits['injected'] = 0
    def injected(route): hits['injected'] += 1; route.fulfill(status=200, content_type='image/png', body=PNG, headers=CORS)
    ctx.route(INJECTED + '/**', injected)
    TILES = INJECTED + '/{z}/{x}/{y}.png'
    # The id a pasted basemap has is its address's own (fromPaste): an entry under any other id is not read.
    def pasted_id(s):
        h = 7
        for c in s: h = (h * 31 + ord(c)) & 0xFFFFFFFF
        digits = '0123456789abcdefghijklmnopqrstuvwxyz'; out = ''
        while h: out = digits[h % 36] + out; h //= 36
        return 'pasted-' + (out or '0')
    PID = pasted_id(TILES)
    PASTED = {'id': PID, 'name': 'Your tiles from injected.example.org', 'group': 'Pasted', 'kind': 'raster', 'tiles': TILES, 'attribution': 'Tiles from injected.example.org'}
    def injected_basemap():
        chora_boot(page, base)
        page.evaluate(RESET, [{f'basemap:{INJECTED}': {'state': 'allowed', 'at': '2026-10-01T09:00:00Z', 'added': True}}, PID])
        page.evaluate('b => localStorage.setItem("chora-basemaps", JSON.stringify([b]))', PASTED)
        since = len(requests); h0 = hits['injected']
        s = chora_boot(page, base)
        until(page, '() => window.__chora.canary && window.__chora.canary !== "pending"', 30)
        page.wait_for_timeout(1500)
        csp = page.evaluate('() => window.__platoCsp')
        before = {'basemap': cstate(page)['basemap'], 'asked': hits['injected'] - h0 + len([u for u in requests[since:] if u.startswith(INJECTED)]),
                  'remembered': cstate(page).get('basemapRemembered'), 'in policy': INJECTED in csp['origins'], 'canary': s.get('canary')}
        page.evaluate("() => { document.getElementById('chora-basemaps').open = true; }")
        line = page.inner_text('#chora-basemap-remembered') if page.is_visible('#chora-basemap-remembered') else ''
        checked = page.evaluate('() => document.querySelector("input[name=basemap]:checked")?.value || null')
        # The control: asked for by a click in this load, it is used and its tiles fetched.
        page.click('#chora-use-remembered')
        used = soon(page, 'id => window.__chora.basemap === id && window.__chora_map.isStyleLoaded()', 20, PID)
        got = soon(page, '() => window.__chora_map.isSourceLoaded("basemap")', 20) and hits['injected'] > h0
        page.evaluate(RESET, [None, None])
        return (before['basemap'] == 'natural-earth' and before['asked'] == 0 and before['remembered'] == PID and before['in policy']
                and 'remembered as your choice' in line and 'injected.example.org' in line and checked == 'natural-earth' and used and got), {
            'before the click': before, 'line': line, 'checked': checked, 'used after the click': used, 'tiles after': hits['injected'] - h0}
    attempt('Chora: a pasted basemap written into storage as allowed and chosen (as a sibling page could) is in the policy but not used at load, and its site asked nothing, until a click; then it is used', injected_basemap)

    # Framed by another origin, each page hides itself behind one line; framed by this site's own
    # origin, which script cannot tell from not being framed, it runs as it does on its own (the
    # control). The framer is a page the server really serves at another origin: a file written into
    # dist/ for this run, read on 127.0.0.1 (which is not localhost), with the frames added by script.
    # Nothing else does: a frame to localhost from a data: page, or from a page the harness fulfilled
    # itself (fabricated, or fetched and given back without its policy), comes up as chrome-error://,
    # and a page of the site is under the policy, whose default-src 'self' refuses a cross-origin frame
    # (measured, 2 October 2026). For the deployed site, which is public and has no dist/ here, a page
    # routed on framer.example.org is used, untested against that site.
    FRAME_STATE = '''() => ({ framed: document.documentElement.hasAttribute('data-framed'), flag: window.__platoCsp ? window.__platoCsp.framed : null,
      notice: document.querySelector('.framed-notice')?.textContent || '', buttonShown: !!document.getElementById('permissions-button')?.offsetParent,
      title: document.title })'''
    def frame_states(page, wait):
        out = {}
        for f in page.frames:
            if f == page.main_frame: continue
            try:
                f.wait_for_function(wait, timeout=T(30) * 1000)
                out[f.name] = f.evaluate(FRAME_STATE)
            except Exception as e: out[f.name or f.url] = {'error': str(e).split('\n')[0][:120]}
        return out
    def framed():
        chora_url = NOTOOLS if PROVE else base + '#chora'; main_url = NOTOOLS if PROVE else base
        local = 'localhost' in base
        framer = base.replace('localhost', '127.0.0.1') + 'framed-probe.html' if local else 'https://framer.example.org/framed-probe.html'
        other = lambda route: route.fulfill(status=200, content_type='text/html', body='<title>framer</title>')
        served = ROOT / 'dist' / 'framed-probe.html'
        if local: served.write_text('<!doctype html><title>framer</title>')
        else: ctx.route(framer, other)
        try:
            page.goto(framer)
            page.evaluate('''([c, m]) => { for (const [name, src] of [['c', c], ['m', m]]) { const f = document.createElement('iframe'); f.name = name; f.src = src; f.width = 900; f.height = 600; document.body.appendChild(f); } }''', [chora_url, main_url])
            # The head script says at once whether the page is framed; the notice comes once the body is there.
            blanked = frame_states(page, '() => !!window.__platoCsp && (!window.__platoCsp.framed || !!document.querySelector(".framed-notice"))')
        finally:
            if local: served.unlink(missing_ok=True)
            else: ctx.unroute(framer, other)
        probe = base + 'framed-probe.html'
        same = lambda route: route.fulfill(status=200, content_type='text/html', body=f'<title>same origin</title><iframe name="c" src="{chora_url}" width="900" height="600"></iframe>')
        ctx.route(probe, same)
        try:
            page.goto(NOTOOLS if PROVE else probe)
            as_own = frame_states(page, '() => window.__chora && window.__chora.phase === "ready"').get('c')
        finally:
            ctx.unroute(probe, same)
        both = (sorted(blanked) == ['c', 'm'] and all(v.get('framed') and v.get('flag') is True and 'cannot be used inside another site' in v.get('notice', '') and not v.get('buttonShown') for v in blanked.values()))
        return (both and as_own is not None and not as_own.get('framed') and as_own.get('flag') is False and as_own.get('notice') == '' and as_own.get('buttonShown')), {'framed by another origin': blanked, 'framed by this one': as_own}
    attempt('the page, and at #chora: framed by another origin, it hides itself behind one line (and the policy is still written); framed by this site\'s own origin, Chora runs as on its own', framed)

    # What another site is told when the user follows a link there: this site's origin at most (the
    # page's referrer policy), never the page's address; from a link in the data, nothing at all.
    PROBE_SITE = 'https://referrer-probe.example.org'
    referers = {}
    def probe_route(route):
        referers[route.request.url.rsplit('/', 1)[-1]] = route.request.headers.get('referer')
        route.fulfill(status=200, content_type='text/html', body='<title>probe</title>probe')
    ctx.route(PROBE_SITE + '/**', probe_route)
    def referrer():
        chora_boot(page, base)
        meta = page.evaluate('() => document.querySelector("meta[name=referrer]")?.content || null')
        origin = page.evaluate('() => location.origin')
        for name, rel in (('plain', ''), ('noreferrer', 'noopener noreferrer')):
            chora_boot(page, base)
            with page.expect_navigation(timeout=30_000):
                page.evaluate('([u, rel]) => { const a = document.createElement("a"); a.href = u; if (rel) a.rel = rel; a.textContent = "probe"; document.body.appendChild(a); a.click(); }', [PROBE_SITE + '/' + name, rel])
        return (meta == 'strict-origin-when-cross-origin' and referers.get('plain') == origin + '/' and 'chora' not in (referers.get('plain') or '')
                and 'noreferrer' in referers and referers['noreferrer'] is None), {'meta': meta, 'origin': origin, 'referer sent': referers}
    attempt('Chora: a link to another site carries this site\'s origin at most, never the page\'s address, and one with rel="noreferrer" carries nothing (both requests seen)', referrer)

    # Links written from the data (a source's address, the contributor's ORCID) open with neither a
    # referrer nor a window handle, and the panel says that following one is a visit of the user's own.
    def links_rel():
        d = json.loads(ant.read_text())
        p0 = next(p for p in d['spatialEntities'] if 'londinium' in json.dumps(p).lower())
        p0['attestations'][0]['sources'] = [{'@id': 'https://source.example.org/itinerary', 'title': 'Probe source'}]
        f = tmp / 'chora-files' / 'antonine-links.json'; f.parent.mkdir(exist_ok=True); f.write_text(json.dumps(d))
        chora_boot(page, base)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: 'https://orcid.org/0000-0002-1825-0097' }))")
        chora_boot(page, base, [f]); chora_pick(page, 'londinium')
        links = page.eval_on_selector_all('#chora-card a[href^="http"], #chora-contributor-line a[href^="http"]', 'as => as.map((a) => ({ href: a.getAttribute("href"), rel: a.rel }))')
        page.click('#permissions-button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        text = page.inner_text('#permissions-panel'); page.keyboard.press('Escape')
        hrefs = ' '.join(l['href'] for l in links)
        return (len(links) >= 2 and 'source.example.org/itinerary' in hrefs and 'orcid.org/0000-0002-1825-0097' in hrefs
                and all('noopener' in l['rel'] and 'noreferrer' in l['rel'] for l in links) and 'a visit you make yourself' in text), {'links': links, 'panel says': 'a visit you make yourself' in text}
    attempt('Chora: a source\'s link and the contributor\'s ORCID link carry rel="noopener noreferrer", and the panel says following a link is a visit the user makes', links_rel)

    # An identity planted in storage with an ORCID that is not one: dropped on load, on each page, and
    # the cleaned value written back; a right one is kept and shown (the control).
    def planted_contributor():
        f = fixture(ant, 'antonine-identity.json', tmp)
        chora_boot(page, base)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: 'javascript:alert(1)' }))")
        chora_boot(page, base, [f])
        bad = {'line': page.inner_text('#chora-contributor-line'), 'links': page.eval_on_selector_all('#chora-contributor-line a[href]', 'as => as.map((a) => a.getAttribute("href"))'),
               'stored': json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')}
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: '0000-0002-1825-0097' }))")
        chora_boot(page, base, [f])
        good = {'links': page.eval_on_selector_all('#chora-contributor-line a[href]', 'as => as.map((a) => a.getAttribute("href"))'), 'stored': json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')}
        page.evaluate("() => localStorage.removeItem('chora-contributor')")
        return ('Saving as Ada Test' in bad['line'] and 'javascript' not in bad['line'] and bad['links'] == ['#', '#'] and bad['stored'] == {'name': 'Ada Test'}
                and good['links'] == ['https://orcid.org/0000-0002-1825-0097', '#', '#'] and good['stored'] == {'name': 'Ada Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097'}), {'planted': bad, 'right': good}
    attempt('Chora: a remembered ORCID that is not one is dropped on load and not written back; a right one is kept, as the address, and linked', planted_contributor)
    def planted_reviewer():
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.evaluate("() => localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Rev Test', orcid: 'javascript:alert(1)' }))")
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        bad = {'name': page.input_value('#reviewer'), 'orcid': page.input_value('#orcid'), 'stored': json.loads(page.evaluate("() => localStorage.getItem('plato-tools.reviewer')") or 'null')}
        page.evaluate("() => localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: 'Rev Test', orcid: 'https://orcid.org/0000-0002-1825-0097' }))")
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        good = {'name': page.input_value('#reviewer'), 'orcid': page.input_value('#orcid'), 'stored': json.loads(page.evaluate("() => localStorage.getItem('plato-tools.reviewer')") or 'null')}
        # Nothing usable (no name): nothing kept, so the panel lists no empty identity.
        page.evaluate("() => localStorage.setItem('plato-tools.reviewer', JSON.stringify({ orcid: 'https://orcid.org/0000-0002-1825-0097' }))")
        page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
        nameless = page.evaluate("() => localStorage.getItem('plato-tools.reviewer')")
        page.evaluate("() => localStorage.removeItem('plato-tools.reviewer')")
        return (bad == {'name': 'Rev Test', 'orcid': '', 'stored': {'name': 'Rev Test'}}
                and good == {'name': 'Rev Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097', 'stored': {'name': 'Rev Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097'}}
                and nameless is None), {'planted': bad, 'right': good, 'nameless left': nameless}
    attempt('main page: a remembered reviewer\'s ORCID that is not one is dropped on load and not written back; a right one is kept and shown', planted_reviewer)

    ctx.close()


# ---- Chora in the page: its layout, its loading, its address (Stephen, 13 October 2026) -------------------
# Chora is in the main page's centre column at #chora: while it is shown the tools rail folds away (the
# centre takes its place) and the workflow rail stays; "Tools ▸" brings the tools back; leaving the map
# gives the three columns back. Its module, and MapLibre with it, is loaded only when it is first opened.
# Measured at 1440 × 900, in a browser context of its own, against the page's own boxes.
CHORA_BOXES = '''() => { const box = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect();
    return r.width && r.height ? { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null; };
  return { toolbox: box('toolbox'), rail: box('workflow-rail'), files: box('files'), chora: box('chora'), map: box('chora-map'),
    shown: !document.getElementById('chora').hidden, tools: document.getElementById('chora-tools')?.getAttribute('aria-expanded') ?? null,
    hash: location.hash }; }'''
def chora_layout_checks(pw, url):
    base = url.rstrip('/') + '/'
    browser = pw.chromium.launch(headless=True, args=GL)
    def fresh():
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        page = ctx.new_page(); page.set_default_timeout(T(30) * 1000)
        asked = []; page.on('request', lambda r: asked.append(r.url))
        return ctx, page, asked
    def ready(page):
        page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
    def opened(page):
        until(page, '() => window.__chora && window.__chora.phase !== "loading" && window.__chora.mapReadyCount >= 1', 60)
    f = EX / 'place-centric-antonine.json'
    try:
        def not_before():
            ctx, page, asked = fresh()
            try:
                ready(page)
                page.set_input_files('#picker', [str(f)]); wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
                map_chunk = lambda: [u for u in asked if re.search(r'/assets/map-[\w-]+\.js$', u)]
                before = {'main code': any(re.search(r'/assets/main-[\w-]+\.js$', u) for u in asked), 'map chunk': map_chunk(),
                          'map': page.evaluate("() => !!document.querySelector('.maplibregl-map')"), 'maplibre global': page.evaluate("() => typeof window.maplibregl !== 'undefined'"),
                          'Chora': page.evaluate('() => !!window.__chora')}
                page.click('#toolbox .tool-link[href="#chora"]'); opened(page)
                after = {'map chunk': map_chunk(), 'map': page.evaluate("() => !!document.querySelector('#chora .maplibregl-map')"), 'Chora': page.evaluate('() => !!window.__chora')}
                return (before['main code'] and not before['map chunk'] and not before['map'] and not before['maplibre global'] and not before['Chora']
                        and after['map chunk'] and after['map'] and after['Chora']), {'before': before, 'after': after}
            finally: ctx.close()
        attempt('Chora in the page: no map code is loaded before Chora is opened (no map chunk, no map, no MapLibre global, no Chora, with a file chosen and the page\'s own code loaded); opened, all are there', not_before)

        lay = {}
        def folds():
            ctx, page, asked = fresh(); lay['ctx'] = ctx; lay['page'] = page
            ready(page)
            page.set_input_files('#picker', [str(f)]); wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
            three = page.evaluate(CHORA_BOXES); lay['three'] = three
            page.click('#to-chora'); opened(page); until(page, '() => window.__chora.phase === "loaded"', 60); page.evaluate(SETTLE)
            on = page.evaluate(CHORA_BOXES); lay['on'] = on
            return (three['toolbox'] and three['files'] and three['rail'] and three['toolbox']['right'] < three['files']['left'] < three['rail']['left']
                    and on['shown'] and on['toolbox'] is None and on['rail'] and on['rail']['left'] == three['rail']['left']
                    and abs(on['chora']['left'] - three['toolbox']['left']) <= 2 and on['chora']['right'] < on['rail']['left']
                    and on['chora']['width'] > three['files']['width'] + 150 and on['map']['width'] >= 500 and on['tools'] == 'false' and on['hash'] == '#chora'
                    and on['files'] and on['files']['bottom'] <= on['chora']['top']), {'three columns': three, 'Chora shown': on}
        attempt('Chora in the page at 1440 × 900: the tools rail folds away and the centre takes its place, the workflow rail stays where it was, the map has the width, and step 1\'s line (its file) is above the map', folds)

        def toggled():
            page = lay['page']
            page.click('#chora-tools'); page.evaluate(SETTLE)
            back = page.evaluate(CHORA_BOXES)
            page.click('#chora-tools'); page.evaluate(SETTLE)
            folded = page.evaluate(CHORA_BOXES)
            three = lay['three']
            return (back['tools'] == 'true' and back['shown'] and back['toolbox'] and back['toolbox']['left'] == three['toolbox']['left'] and back['toolbox']['right'] < back['chora']['left']
                    and back['rail']['left'] == three['rail']['left'] and back['map']['width'] >= 300
                    and folded['tools'] == 'false' and folded['toolbox'] is None and folded['chora']['left'] == lay['on']['chora']['left']), {'tools shown': back, 'folded again': folded}
        attempt('Chora in the page: "Tools ▸" brings the tools rail back beside the map, and folds it away again', toggled)

        def left():
            page = lay['page']
            page.click('#chora-tools')                            # left with the tools shown: the page is as it was all the same
            page.click('#chora-leave'); page.wait_for_timeout(300)
            after = page.evaluate(CHORA_BOXES); three = lay['three']
            h = lambda b: b and {k: b[k] for k in ('left', 'right', 'width')}
            return (not after['shown'] and h(after['toolbox']) == h(three['toolbox']) and h(after['files']) == h(three['files']) and h(after['rail']) == h(three['rail'])
                    and after['tools'] == 'false' and '#chora' not in after['hash'] and not page.evaluate('() => document.body.hasAttribute("data-chora") || document.body.hasAttribute("data-chora-tools")')), {
                'three columns before': three, 'after leaving': after}
        attempt('Chora in the page: leaving the map gives the three columns back as they were', left)

        def reloads():
            page = lay['page']
            page.click('#to-chora'); opened(page); until(page, '() => window.__chora.phase === "loaded"', 60)
            page.reload(); wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready'); opened(page)
            s = cstate(page); box = page.evaluate(CHORA_BOXES)
            offered = soon(page, "() => { const e = document.getElementById('kept-file'); return !!e && !e.hidden; }", 15)
            return (box['shown'] and box['hash'] == '#chora' and box['toolbox'] is None and s['phase'] == 'ready' and s['mapReadyCount'] >= 1 and offered), {
                'boxes': box, 'state': {k: s.get(k) for k in ('phase', 'mapReadyCount')}, 'kept file offered': offered}
        attempt('Chora in the page: the page reloaded at #chora opens Chora again at once (the file kept from before offered above it, as on any reload)', reloads)

        def narrow_order():
            # On a phone (600 px): step 1's line, then the map, as at every width (the order of the page).
            ctx = browser.new_context(viewport={'width': 600, 'height': 900}, reduced_motion='reduce')
            try:
                page = ctx.new_page(); page.set_default_timeout(T(30) * 1000); ready(page)
                page.set_input_files('#picker', [str(f)]); wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
                page.click('#to-chora'); opened(page); until(page, '() => window.__chora.phase === "loaded"', 60); page.evaluate(SETTLE)
                b = page.evaluate(CHORA_BOXES)
                line = page.is_visible('#chosen-line')
                return (b['shown'] and line and b['files'] and b['chora'] and b['files']['bottom'] <= b['chora']['top'] and b['map']['width'] >= 400), {'boxes': b, 'step 1\'s line shown': line}
            finally: ctx.close()
        attempt('Chora in the page at 600 px: step 1\'s line (its file) is above the map, and the map takes the column', narrow_order)

        def chunk_fails():
            # The map's code refused once (the network down, say): said where the map would be, with the way to
            # try again (a reload: the browser keeps a module that failed as failed), which comes back to the map
            # and loads it (the presence after the absence).
            ctx, page, asked = fresh()
            try:
                ready(page)
                chunk = re.compile(r'/assets/app-[\w-]+\.js(\?.*)?$')
                page.route(chunk, lambda r: r.abort())
                page.click('#toolbox .tool-link[href="#chora"]')
                said = soon(page, "() => /could not be loaded/.test(document.getElementById('chora-root').textContent)", 20)
                text = page.inner_text('#chora-root')
                page.unroute(chunk)
                with page.expect_navigation(timeout=T(30) * 1000): page.click('#chora-root button:has-text("Reload the page")')
                again = soon(page, '() => !!window.__chora && window.__chora.mapReadyCount >= 1', 60)
                return (said and 'Reload the page to try again' in text and again and page.is_visible('#chora-map') and page.url.endswith('#chora')), {
                    'said': text[:200], 'loaded after the reload': again, 'url': page.url}
            finally: ctx.close()
        attempt('Chora in the page: when the map\'s code cannot be loaded it says so where the map would be, with the way to try again (a reload, which comes back to the map and loads it)', chunk_fails)
    finally:
        if lay.get('ctx'): lay['ctx'].close()
        browser.close()

# ---- Chora's historical maps (IIIF), against a real second origin ---------------------------------
# The map's servers are e2e/iiif_fixture_server.py on two free ports of 127.0.0.1: origin A, the image
# server allowed in Permissions (iiif:A), and origin B, which must never be asked for anything. The page
# is on localhost, so both are other sites. What reached each server is read from the server's own log
# (the census): Playwright's request events also list requests the browser stopped. Allmaps' annotation
# server is answered by page.route. A browser profile of its own, so that nothing is allowed at the start.
# Every permission is allowed in the panel, from the "Needs permission" line, as a user would.
import hashlib
FIX = ROOT / 'test/fixtures/chora-iiif'
ALLMAPS = 'https://annotations.allmaps.org'
AGREE_JS = """(pts) => { const o = window.__chora_overlays; return Promise.all(o.manager.entries.map(async (e) => {
  const wm = o.layer.getWarpedMap(e.mapId);
  const R = 6378137, merc = ([lon, lat]) => [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  const g = (await o.georef.toWorld(e.g, { type: 'MultiPoint', coordinates: pts }, { space: 'image', precision: 15 })).geojson.coordinates.map(merc);
  // Where the renderer draws each pixel: its transformer's projected (Web Mercator) coordinates; and its
  // longitude and latitude (transformToGeo), put into metres by the same formula as georef's.
  const r = pts.map((p) => wm.projectedTransformer.transformToProjectedGeo(p));
  const rl = pts.map((p) => merc(wm.projectedTransformer.transformToGeo(p)));
  const r1 = pts.map((p) => wm.getProjectedTransformer('polynomial1').transformToProjectedGeo(p));
  const d = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  return { annotation: e.g.annotationId, type: wm.transformationType, n: pts.length, worst: d(r, g), lonlat: d(rl, g), order1: d(r1, g), self: d(r, r),
           mapIds: o.layer.getMapIds().includes(e.mapId) }; })); }"""

# ---- Chora: adopting a location from a gazetteer match (src/chora/adopt-ui.js) --------------------------
# WHG is never called: a route answers for it, with the answers the unit tests use
# (test/fixtures/chora/adopt/), and records every request with its headers. In the style of the Krisis
# lookup case above: nothing before the permission is allowed; the token in the Authorization header only;
# each absence beside the presence that shows the check could see it.
ADOPT_FIX = ROOT / 'test/fixtures/chora/adopt'
ADOPT_TOKEN = 'e2e-SECRET-adopt-token-91c07f3a'
def abram(id, cc, point):
    return {'id': id, 'name': 'Abram', 'score': 100, 'match': True, 'description': f'Country: {cc}', 'ccodes': [cc], 'repr_point': point,
            'namespace': 'gn', 'alt_names': [], 'has_geom': False, 'confidence': 100}
# The real run of 10 October 2026 (#32): WHG's first Abrams were in Croatia and the USA.
ABRAM_HR, ABRAM_US, ABRAM_GB = abram('place:gn:3337500', 'HR', [15.9, 45.3]), abram('place:gn:4046000', 'US', [-88.3, 37.6]), abram('place:gn:2657859', 'GB', [-2.59, 53.51])

def chora_adopt_checks(pw, url, tmp):
    import re
    base = url.rstrip('/') + '/'
    ctx = pw.chromium.launch_persistent_context(str(tmp / 'chora-adopt-profile'), headless=True, accept_downloads=True, args=GL,
                                                viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    fx = lambda n: json.loads((ADOPT_FIX / n).read_text())
    calls, asked, errors = [], [], []
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
    def reply(route, status, body):
        route.fulfill(status=status, headers={**cors, 'Content-Type': 'application/json'}, body=json.dumps(body))
    def fake_whg(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
        calls.append({'url': req.url, 'method': req.method, 'headers': req.all_headers(), 'body': req.post_data or ''})
        if req.method == 'POST':
            qs = json.loads(req.post_data)['queries']
            first = next(iter(qs.values()))['query']
            if first.startswith('Abram'):
                # #32: two Abrams abroad and one in Lancashire; asked within a region (contained_in), only the one in it,
                # as WHG answers; 'Abram nowhere' has none within, 'Abram closed' a region WHG could not apply.
                scoped = isinstance(next(iter(qs.values())).get('contained_in'), list)
                found = ([] if first in ('Abram nowhere', 'Abram closed') else [ABRAM_GB]) if scoped else [ABRAM_HR, ABRAM_US, ABRAM_GB]
                scope = {'scope': {'applied': first != 'Abram closed'}} if scoped else {}
                return reply(route, 200, {**{k: {'result': found, **scope} for k in qs}, 'attribution': fx('whg-newcastle-reconcile.json')['attribution']})
            if first == 'Quota': return reply(route, 401, fx('whg-quota-401.json'))
            if first == 'Badtoken': return reply(route, 401, fx('whg-auth-401.json'))
            src = fx('whg-per-query-error.json') if first == 'Broken' else fx('whg-datasets-reconcile.json') if first == 'Tyneside' else fx('whg-newcastle-reconcile.json')
            return reply(route, 200, {**{k: src['q0'] for k in qs}, 'attribution': src.get('attribution')})
        m = re.search(r'/entity/([^/]+)/api', req.url)
        ent = m and m.group(1)
        if ent == 'place:tgn:7011781': return reply(route, 451, fx('whg-451.json'))
        if ent in ('place:gn:2641673', 'place:whg:1320:41'): return reply(route, 200, fx('lpf-point.json'))
        return reply(route, 404, {'detail': 'Not found'})
    ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), fake_whg)
    ctx.on('request', lambda r: asked.append(r.url) if 'whgazetteer.org' in r.url else None)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    P = 'https://example.org/place/'
    W3 = 'https://w3id.org/whg/id/'
    # The unit tests' dataset, with Newcastle given its country (GB), so that the candidates are ranked by it.
    doc = fx('dataset.json'); doc['spatialEntities'][0]['ccodes'] = ['GB']
    # A place linked only to a legacy WHG cluster page, and one whose @id IS a record's w3id.
    doc['spatialEntities'].append({'@id': P + 'portal-place', 'label': 'Portal place', 'attestations': [{'identities': [{'subject': P + 'portal-place', 'object': 'https://whgazetteer.org/places/123456/portal/', 'identityType': 'exactMatch'}], 'contributor': {'name': 'Ada'}, 'created': '2026-09-01T09:00:00Z'}]})
    doc['spatialEntities'].append({'@id': W3 + 'place:gn:2641673', 'label': 'Tyne record'})
    # #32: Abram, ContainedIn its parish (no identity), ContainedIn Lancashire, identified with gn:2644974.
    IN = 'https://w3id.org/plato#ContainedIn'
    within = lambda a, b: {'@id': a + '#a-in', 'relations': [{'relationType': IN, 'relatesTo': b}], 'contributor': {'name': 'Ada'}, 'created': '2026-09-01T09:00:00Z'}
    doc['spatialEntities'] += [
        {'@id': P + 'abram', 'label': 'Abram', 'ccodes': ['GB'], 'attestations': [
            {'@id': P + 'abram#a-names', 'names': [{'toponym': 'Abram', 'language': 'en'}], 'contributor': {'name': 'Ada'}, 'created': '2026-09-01T09:00:00Z'}, within(P + 'abram', P + 'region-wigan')]},
        {'@id': P + 'region-wigan', 'label': 'Wigan parish', 'attestations': [within(P + 'region-wigan', P + 'region-lancashire')]},
        {'@id': P + 'region-lancashire', 'label': 'Lancashire', 'attestations': [{'@id': P + 'region-lancashire#a-id', 'identities': [
            {'subject': P + 'region-lancashire', 'object': W3 + 'place:gn:2644974', 'identityType': 'exactMatch'}], 'contributor': {'name': 'Ada'}, 'created': '2026-09-01T09:00:00Z'}]}]
    RESET = """([g]) => { localStorage.removeItem('plato-tools.permissions'); sessionStorage.clear(); localStorage.removeItem('plato-tools.whg-token');
      localStorage.removeItem('plato-tools.whg-token.remember');
      if (g) localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: g })); }"""
    made = {'n': 0}
    def fresh(grants=None):
        """Chora with these permissions (nothing else decided, no token), and a copy of the dataset no other check has adopted on."""
        made['n'] += 1
        f = tmp / 'chora-files'; f.mkdir(exist_ok=True); f = f / f'adopt-{made["n"]}.json'
        f.write_text(json.dumps(doc))
        chora_boot(page, base); page.evaluate(RESET, [grants])
        chora_boot(page, base, [f])
        return f
    ad = lambda: (cstate(page) or {}).get('adopt') or {}
    def open_for(text):
        chora_pick(page, text)
        page.click('#adopt-find')
        until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10)
    def give_token():
        page.fill('#adopt-token', ADOPT_TOKEN); page.press('#adopt-token', 'Enter')
        until(page, '() => document.getElementById("adopt-token-forget")?.hidden === false', 10)
    def look_up(q):
        page.fill('#adopt-q', q); page.click('#adopt-send')
        until(page, '() => ["answered", "problem"].includes(window.__chora.adopt.phase)', 30)
        return ad()
    ALLOW = {'gazetteer:whg': {'state': 'allowed', 'at': '2026-10-03T09:00:00Z'}}
    has_token = lambda x: ADOPT_TOKEN in (x if isinstance(x, str) else json.dumps(x))

    # Not allowed: one line to the Permissions panel instead of Look up, and nothing sent, even by a script's click.
    def not_allowed():
        fresh(); open_for('newcastle upon')
        line = page.inner_text('#adopt-permission') if page.is_visible('#adopt-permission') else ''
        send_shown = page.is_visible('#adopt-send')
        before = len(calls) + len(asked)
        page.evaluate("() => { document.getElementById('adopt-q').value = 'Newcastle'; document.getElementById('adopt-send').click(); document.getElementById('adopt-form').requestSubmit(); }")
        page.wait_for_timeout(1500)
        panel = page.inner_text('#chora-adopt')
        out = {'line': line, 'send shown': send_shown, 'sent': len(calls) + len(asked) - before, 'panel': panel[:400],
               'policy': page.evaluate('() => (window.__platoCsp || {}).origins || null')}
        page.click('#adopt-permission button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        out['opened'] = page.evaluate(PANEL_STATE)
        return (line.startswith('Needs permission: World Historical Gazetteer') and send_shown is False and out['sent'] == 0 and out['policy'] == []
                and W3 not in panel and 'Your WHG token' in panel and 'privacy' not in panel.lower() and 'forgotten when the tab is closed' not in panel
                and out['opened'].get('focusKey') == 'gazetteer:whg'), out
    attempt('Chora adopt, not allowed: one "Needs permission" line opening the Permissions panel at WHG, no Look up, nothing sent by a script\'s click, no notice of its own (the token field is there, the control)', not_allowed)

    # A place without an @id: the button is disabled, and says why; the control is Newcastle's, enabled.
    def no_address():
        fresh(ALLOW); chora_pick(page, 'newcastle upon')
        on = page.is_enabled('#adopt-find')
        chora_pick(page, 'which')
        off = page.is_enabled('#adopt-find'); why = page.inner_text('#adopt-why') if page.is_visible('#adopt-why') else ''
        described = page.get_attribute('#adopt-find', 'aria-describedby')
        return on and not off and 'no address (@id)' in why and described == 'adopt-why', {'enabled for Newcastle': on, 'enabled for the place without @id': off, 'why': why}
    attempt('Chora adopt: "Find in a gazetteer…" is disabled for a place without an @id, with the reason shown, and enabled for one with', no_address)

    # Allowed: the token, one query sent with type Place, the candidates ranked by the place's country, numbered on the map.
    st = {}
    def lookup():
        f = fresh(ALLOW); st['file'] = f
        open_for('newcastle upon'); give_token()
        since = len(calls)
        a = look_up('Newcastle')
        posts = [c for c in calls[since:] if c['method'] == 'POST']
        body = json.loads(posts[0]['body']) if posts else {}
        cands = a.get('candidates') or []
        st['lookup'] = a
        markers = page.evaluate('() => [...document.querySelectorAll(".cand-marker")].map((m) => [m.dataset.cand, m.textContent])')
        listed = page.eval_on_selector_all('#adopt-candidates li', 'ls => ls.map((l) => [l.dataset.cand, l.querySelector(".cand-n").textContent])')
        # Newcastle's own country goes with it (#32); "Newcastle" is not one of its names ("Newcastle upon Tyne"), so no language.
        return (len(posts) == 1 and list(body.get('queries', {}).values()) == [{'countries': ['GB'], 'query': 'Newcastle', 'type': 'Place', 'limit': 10}]
                and [c['id'] for c in cands] == ['place:gn:2641591', 'place:gn:2641673', 'place:tgn:7011781', 'place:gn:2155472']
                and [c['inArea'] for c in cands] == [True, True, False, False] and a.get('reference') == 'box'
                and sorted(markers) == sorted(listed) and len(markers) == 4 and cstate(page)['pendingCount'] == 0), {
            'posts': len(posts), 'queries': body.get('queries'), 'order': [c['id'] for c in cands], 'markers': markers, 'listed': listed, 'pending': cstate(page)['pendingCount']}
    attempt("Chora adopt: allowed, one query is sent (type Place, the name typed, the place's country), and the four Newcastles are listed and on the map, numbered alike, GB's first (WHG gave Tyne last), nothing adopted yet", lookup)
    def headers():
        posts = [c for c in calls if c['method'] == 'POST']
        auth = [c['headers'].get('authorization') for c in posts]
        return (bool(posts) and all(x == f'Bearer {ADOPT_TOKEN}' for x in auth) and not any(ADOPT_TOKEN in c['url'] for c in calls)
                and not any(ADOPT_TOKEN in u for u in asked)), {'posts': len(posts), 'auth': [bool(x) for x in auth]}
    attempt('Chora adopt: the token goes in the Authorization header of the POST (the control), and in no address', headers)
    def ranked_words():
        text = page.inner_text('#adopt-candidates') if page.is_visible('#adopt-candidates') else ''
        order = page.inner_text('#adopt-order') if page.is_visible('#adopt-order') else ''
        kinds = page.eval_on_selector_all('#adopt-candidates .adopt-kind', 'els => els.map((e) => e.textContent)') if text else []
        return ('inside the area' in text and 'outside the area' in text and 'km away' not in text and 'same spelling' in text and 'Licence of its source' in text
                and "relative to the best in this search" in text and 'its countries first' in order and 'Nothing is chosen for you' in order
                and 'Kind of place: inhabited places aat:300008347' in kinds and 'Kind of place: gn:P.PPL' in kinds and not any('Place' in k.replace('Kind of place', '') for k in kinds)), {'order': order, 'kinds': kinds, 'text': text[:500]}
    attempt('Chora adopt: with only a country, each candidate says inside or outside the area (no distance), same spelling, its kind of place (an AAT id by its label, a code as a code, never the protocol\'s Place), its licence, and WHG\'s figures with their caveat', ranked_words)

    # A 451: the record is consulted, not copied: its marker goes, a hand-drawing is offered; the control, another's marker, stays.
    def unavailable():
        since = len(calls)
        page.click('#adopt-candidates li[data-cand="place:tgn:7011781"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        a = ad(); gets = [c for c in calls[since:] if c['method'] == 'GET']
        text = page.inner_text('#adopt-preview')
        return (a['preview']['unavailable'] and 'place:tgn:7011781' not in a['markers'] and 'place:gn:2641673' in a['markers']
                and 'consulted, not copied' in text and page.is_visible('#adopt-draw') and not page.is_visible('#adopt-go')
                and len(gets) == 1 and 'authorization' not in gets[0]['headers'] and cstate(page)['pendingCount'] == 0), {
            'preview': a.get('preview'), 'markers': a.get('markers'), 'gets': [(g['url'], 'authorization' in g['headers']) for g in gets], 'text': text[:300]}
    attempt("Chora adopt: a 451 copies nothing: its marker is hidden (another's stays), the record is said to be consulted, not copied, a hand-drawing is offered, and no Adopt", unavailable)

    # "Draw it yourself" arms the next drawing; Cancel, closing the panel, or another place disarms it.
    def disarm():
        armed = lambda: cstate(page).get('consultArmed')
        rec = W3 + 'place:tgn:7011781'
        page.click('#adopt-draw'); a1 = armed(); shown = page.is_visible('#adopt-armed')
        page.click('#adopt-unarm'); a2 = armed(); gone = not page.is_visible('#adopt-armed')
        page.click('#adopt-draw'); a3 = armed()
        page.click('#adopt-close'); a4 = armed()
        page.click('#adopt-find'); until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10); look_up('Newcastle')
        page.click('#adopt-candidates li[data-cand="place:tgn:7011781"] button[data-preview]'); until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        page.click('#adopt-draw'); a5 = armed()
        chora_pick(page, 'novocastria'); a6 = armed()
        chora_pick(page, 'newcastle upon'); page.click('#adopt-find'); until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10); look_up('Newcastle')
        return (a1 == rec and shown and a2 is None and gone and a3 == rec and a4 is None and a5 == rec and a6 is None), {'armed': [a1, a2, a3, a4, a5, a6], 'shown': shown, 'gone': gone}
    attempt('Chora adopt: "Draw it yourself" arms the next drawing to cite the record (the control); Cancel, closing the panel, and choosing another place each disarm it', disarm)

    # Adopting Tyne: the record fetched without the token (an authority's), its point offered, Adopt keeps one adoption draft.
    def adopt_one():
        since = len(calls)
        page.click('#adopt-candidates li[data-cand="place:gn:2641673"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview" && window.__chora.adopt.preview.id === "place:gn:2641673"', 30)
        gets = [c for c in calls[since:] if c['method'] == 'GET']
        drawn = soon(page, '() => window.__chora_map.getSource("chora-preview") && window.__chora_map.querySourceFeatures("chora-preview").length > 0', 10)
        before = cstate(page)['pendingCount']
        page.fill('#adopt-basis', 'Same city: the castle and the bridge')
        # A change of permission draws the panel again: what was typed in the basis is kept.
        page.click('#permissions-button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.click('#perm-keep-work'); page.click('#perm-keep-work'); page.keyboard.press('Escape')
        st['basis kept'] = page.input_value('#adopt-basis')
        page.click('#adopt-go')
        until(page, '() => window.__chora.adopt.phase === "adopted"', 10)
        # The draft is written to OPFS asynchronously: read it once the page says its writes are done.
        until(page, '() => window.__chora.draftWrites === 0', 10)
        k = kept(page, st['file'].name)
        return (len(gets) == 1 and gets[0]['url'].endswith('/entity/place:gn:2641673/api') and 'authorization' not in gets[0]['headers']
                and drawn and before == 0 and cstate(page)['pendingCount'] == 1 and ad()['done']['count'] == 2
                and len(k) == 1 and k[0].get('kind') == 'adoption' and k[0]['basis'] == 'Same city: the castle and the bridge' and st['basis kept'] == 'Same city: the castle and the bridge'), {'basis kept': st.get('basis kept'), 
            'gets': [(g['url'], 'authorization' in g['headers']) for g in gets], 'drawn': drawn, 'pending': [before, cstate(page)['pendingCount']], 'kept': k}
    attempt('Chora adopt: Show the record fetches it without the token (an authority\'s record), draws it, the basis typed survives the panel being drawn again, and Adopt keeps ONE adoption draft (two attestations), only on the button', adopt_one)
    def no_token_kept():
        k = kept(page, st['file'].name)
        session = page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token')")
        return has_token(session) and k and not has_token(k) and not has_token(cstate(page)), {'token kept for the tab (the control)': has_token(session), 'in drafts': has_token(k)}
    attempt('Chora adopt: the token is not in the draft kept, nor in the page state (the same search finds it where it is kept, for the tab)', no_token_kept)

    # WHG's own records: the token goes with one (place:whg), and a dataset that may not be redistributed has no marker and is never fetched.
    def whg_native():
        since = len(calls)
        a = look_up('Tyneside')
        ms = a.get('markers') or []
        page.click('#adopt-candidates li[data-cand="place:whg:1320:41"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        gets = [c for c in calls[since:] if c['method'] == 'GET']
        page.click('#adopt-candidates li[data-cand="place:whg:1319:277"] button[data-preview]')
        page.wait_for_timeout(500)
        gets2 = [c for c in calls[since:] if c['method'] == 'GET']
        text = page.inner_text('#adopt-preview')
        return (ms == ['place:whg:1320:41'] and len(gets) == 1 and gets[0]['headers'].get('authorization') == f'Bearer {ADOPT_TOKEN}'
                and len(gets2) == 1 and 'consulted, not copied' in text), {'markers': ms, 'gets': [(g['url'], 'authorization' in g['headers']) for g in gets2], 'text': text[:200]}
    attempt("Chora adopt: a WHG record is fetched with the token (the control for its absence on an authority's); a dataset that may not be redistributed has no marker, is never fetched, and is consulted, not copied", whg_native)

    # The place already linked: the geometry only; the place said to be different: struck through, nothing to adopt.
    def linked_and_denied():
        page.click('#adopt-close')
        open_for('novocastria'); a = look_up('Newcastle')
        tyne = next((c for c in a.get('candidates', []) if c['id'] == 'place:gn:2641673'), {})
        st['cluster on novocastria'] = page.is_visible('#adopt-cluster')
        label = page.inner_text('#adopt-candidates li[data-cand="place:gn:2641673"] button[data-preview]')
        page.click('#adopt-candidates li[data-cand="place:gn:2641673"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        go = page.inner_text('#adopt-go')
        page.click('#adopt-go'); until(page, '() => window.__chora.adopt.phase === "adopted"', 10)
        one = ad()['done']['count']
        page.click('#adopt-close')
        # Newcastle (NSW) is the second "Newcastle" in the list: the one with that exact label.
        page.fill('#chora-q', 'newcastle'); until(page, '() => document.querySelectorAll("#chora-list button[data-id]").length >= 2', 10)
        page.click(f'#chora-list button[data-id="{P}newcastle-nsw"]'); until(page, f'() => window.__chora.placeId === "{P}newcastle-nsw"', 10)
        page.click('#adopt-find'); until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10)
        b = look_up('Newcastle')
        nsw = next((c for c in b.get('candidates', []) if c['id'] == 'place:gn:2155472'), {})
        struck = page.eval_on_selector_all('#adopt-candidates li[data-cand="place:gn:2155472"] s', 'e => e.length')
        nsw_btn = page.eval_on_selector_all('#adopt-candidates li[data-cand="place:gn:2155472"] button[data-preview]', 'e => e.length')
        other_btn = page.eval_on_selector_all('#adopt-candidates li[data-cand="place:gn:2641673"] button[data-preview]', 'e => e.length')
        different = page.get_attribute('#adopt-candidates li[data-cand="place:gn:2641673"] a[data-different]', 'href')
        return (tyne.get('linked') == 'exact' and label == 'Use its location' and go == "Adopt the record's location" and one == 1
                and nsw.get('denied') is True and struck == 1 and nsw_btn == 0 and other_btn == 1 and different == './#tool=match'
                and cstate(page)['pendingCount'] == 2), {'tyne': tyne, 'label': label, 'go': go, 'count': one, 'nsw': nsw, 'struck': struck, 'buttons': [nsw_btn, other_btn], 'different': different, 'pending': cstate(page)['pendingCount']}
    attempt('Chora adopt: a place already linked by an exactMatch adopts the location only (one attestation); a candidate the dataset denies is struck through with nothing to adopt (another beside it can), and "Different places" goes to Krisis', linked_and_denied)

    # Saving: Mneme passes with 3 added (2 + 1), and the file holds both of Newcastle's attestations as the design says.
    def save():
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        page.click('#adopt-close')
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page).get('lastSave') or {}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        d.value.save_as(tmp / 'adopted.chora.json'); saved = json.loads((tmp / 'adopted.chora.json').read_text())
        nc = next(p for p in saved['spatialEntities'] if p.get('@id') == P + 'newcastle')['attestations'][1:]
        nv = next(p for p in saved['spatialEntities'] if p.get('@id') == P + 'novocastria')['attestations'][1:]
        rec = W3 + 'place:gn:2641673'
        ident = next((a for a in nc if a.get('identities')), {}); geom = next((a for a in nc if a.get('geometries')), {})
        cit = (geom.get('citations') or [{}])[0]
        st['saved'] = saved
        return (ls.get('passed') and ls.get('added') == 3 and len(nc) == 2 and len(nv) == 1 and nv[0].get('geometries')
                and ident.get('identities') == [{'subject': P + 'newcastle', 'object': rec, 'identityType': 'exactMatch', 'basis': 'Same city: the castle and the bridge'}]
                and cit.get('citationFunction') == 'http://purl.org/spar/cito/citesAsEvidence' and cit.get('locator') == rec
                and cit.get('source', {}).get('title') == 'World Historical Gazetteer' and cit.get('source', {}).get('licence') == 'https://spdx.org/licenses/CC-BY-4.0'
                and rec in ident.get('notes', '') and rec in geom.get('notes', '') and geom.get('timespans') and ident.get('created') == geom.get('created')
                and not has_token(saved)), {'lastSave': {k: ls.get(k) for k in ('passed', 'added')}, 'newcastle': nc, 'novocastria': nv}
    attempt('Chora adopt: the save passes Mneme with 3 added (2 for an adoption, 1 for the place already linked), and the file holds the identity and the copied geometry (citesAsEvidence, the record as locator, the upstream licence, when carried, the record in both notes), and no token', save)

    # What went wrong, in words: a quota 401 keeps the token; a refused token offers it again; a per-query error is "try again".
    def problems():
        page.click('#chora-card #adopt-find') if page.is_visible('#chora-card #adopt-find') else None
        until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10)
        q = look_up('Quota'); qt = page.inner_text('#adopt-status')
        kept_after_quota = page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token')")
        b = look_up('Broken'); bt = page.inner_text('#adopt-status'); retry = page.is_visible('#adopt-retry')
        t = look_up('Badtoken'); tt = page.inner_text('#adopt-status')
        return (q.get('problem') == 'quota' and 'try again tomorrow' in qt and kept_after_quota == ADOPT_TOKEN
                and b.get('problem') == 'unanswered' and 'not a finding' in bt and retry and not b.get('candidates')
                and t.get('problem') == 'auth' and 'Give it again' in tt and page.is_visible('#adopt-token-forget')), {'quota': [q.get('problem'), qt], 'broken': [b.get('problem'), bt, retry], 'auth': [t.get('problem'), tt]}
    attempt('Chora adopt: a spent allowance keeps the token and says try tomorrow; a per-query error is "try again", not "nothing found"; a refused token offers to give it again or forget it', problems)

    # Never: the line says so, with a button to the panel; nothing sent.
    def never():
        fresh({'gazetteer:whg': {'state': 'never'}}); open_for('newcastle upon')
        before = len(calls) + len(asked)
        page.evaluate("() => document.getElementById('adopt-form').requestSubmit()"); page.wait_for_timeout(1000)
        line = page.inner_text('#adopt-permission') if page.is_visible('#adopt-permission') else ''
        # A token half typed survives the panel being drawn again on a change of permission.
        page.fill('#adopt-token', 'half-typed')
        page.click('#permissions-button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.click('#perm-keep-work'); page.click('#perm-keep-work'); page.keyboard.press('Escape')
        typed = page.input_value('#adopt-token')
        return 'set to Never in Permissions' in line and not page.is_visible('#adopt-send') and len(calls) + len(asked) == before and typed == 'half-typed', {'line': line, 'token field': typed}
    attempt('Chora adopt, Never: the line says it is set to Never, with a button to the panel, and nothing is sent; a token half typed survives the panel being drawn again', never)

    # The token's field, as the main page's lookup panel (src/lib/token-field.js): before a token, an empty password
    # field saying where to get it, Remember, and no Forget (in the page, hidden); remembered, the field empty and
    # masked, where it is kept beside it, Forget, and the token nowhere in the page (the control: it was typed, and is
    # kept); Forget, with no message, back to the empty state with the focus in the field; Enter, for the tab only.
    TOKEN_STATE = """(t) => { const $ = (id) => document.getElementById(id), shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0, f = $('adopt-token');
      const kept = (() => { try { return { session: sessionStorage.getItem('plato-tools.whg-token'), local: localStorage.getItem('plato-tools.whg-token') }; } catch { return { session: 'no storage', local: 'no storage' }; } })();
      return { field: shown(f), type: f?.type ?? null, value: f?.value ?? null, placeholder: f?.placeholder ?? null,
        remember: shown($('adopt-token-remember')), forget: shown($('adopt-token-forget')), forgetInDom: !!$('adopt-token-forget'),
        state: $('adopt-token-state')?.textContent ?? null, help: $('adopt-token-help')?.textContent ?? null,
        status: $('adopt-status')?.textContent ?? null, panel: $('adopt')?.innerText ?? '', focus: document.activeElement && document.activeElement.id,
        inPage: !!t && (document.documentElement.outerHTML.includes(t) || [...document.querySelectorAll('input, textarea')].some((x) => x.value.includes(t)) || JSON.stringify(window.__chora || {}).includes(t)),
        ...kept }; }"""
    tk = {}
    def token_states():
        # Run once for the attempts below; a harness error is kept, so that every later attempt reports it too.
        if tk: return tk
        try: token_steps()
        except Exception as e: tk['error'] = 'harness error: ' + str(e).split('\n')[0][:200]
        return tk
    def token_steps():
        fresh(ALLOW); open_for('newcastle upon')
        tk['before'] = page.evaluate(TOKEN_STATE, None)
        page.fill('#adopt-token', ADOPT_TOKEN)
        tk['typed'] = ADOPT_TOKEN in page.input_value('#adopt-token')
        page.click('#adopt-token-remember')
        until(page, '() => document.getElementById("adopt-token-forget")?.hidden === false', 10)
        tk['remembered'] = page.evaluate(TOKEN_STATE, ADOPT_TOKEN)
        page.click('#adopt-token-forget')
        until(page, '() => document.getElementById("adopt-token-forget")?.hidden === true', 10)
        tk['forgotten'] = page.evaluate(TOKEN_STATE, ADOPT_TOKEN)
        page.fill('#adopt-token', ADOPT_TOKEN); page.press('#adopt-token', 'Enter')
        until(page, '() => document.getElementById("adopt-token-forget")?.hidden === false', 10)
        tk['tab'] = page.evaluate(TOKEN_STATE, ADOPT_TOKEN)
        # A value the browser fills in (an input event with no inputType, as an autofill), then Enter: emptied, never given.
        page.click('#adopt-token-forget')
        until(page, '() => document.getElementById("adopt-token-forget")?.hidden === true', 10)
        page.evaluate("""(t) => { const f = document.getElementById('adopt-token'); f.focus(); f.value = t; f.dispatchEvent(new Event('input', { bubbles: true })); }""", ADOPT_TOKEN)
        tk['filled value'] = page.input_value('#adopt-token')
        page.evaluate("(t) => { document.getElementById('adopt-token').value = t; }", ADOPT_TOKEN)
        page.press('#adopt-token', 'Enter')
        tk['filled'] = page.evaluate(TOKEN_STATE, ADOPT_TOKEN)
        tk['form'] = page.evaluate("() => !!document.getElementById('adopt-token')?.closest('form')")
        tk['autocomplete'] = page.get_attribute('#adopt-token', 'autocomplete')
    step = lambda fn: fn()
    def before():
        b = step(token_states).get('before') or {}
        return (b.get('field') is True and b.get('type') == 'password' and b.get('value') == '' and 'whgazetteer.org' in (b.get('placeholder') or '')
                and b.get('remember') is True and b.get('forgetInDom') is True and b.get('forget') is False and b.get('state') == ''), {k: v for k, v in b.items() if k != 'panel'} or tk
    attempt('Chora adopt, no token yet: an empty password field with a placeholder saying where to get it, "Remember my token" shown, "Forget the token" not shown', before)
    def remembered():
        r = step(token_states).get('remembered') or {}
        return (r.get('value') == '' and r.get('placeholder') == '••••••••' and r.get('state') == 'Token remembered in this browser'
                and r.get('forget') is True and r.get('remember') is False and r.get('focus') == 'adopt-token'
                and tk.get('typed') is True and r.get('inPage') is False and r.get('local') == ADOPT_TOKEN), {k: v for k, v in r.items() if k not in ('panel', 'session', 'local')} or tk
    attempt('Chora adopt, token remembered: the field empty with a masked placeholder, "Token remembered in this browser" beside it, Forget shown and Remember not, and the token nowhere in the page (the control: it was typed, and is kept in this browser)', remembered)
    def forgotten():
        g = step(token_states).get('forgotten') or {}
        return (g.get('value') == '' and 'whgazetteer.org' in (g.get('placeholder') or '') and g.get('remember') is True and g.get('forget') is False
                and g.get('state') == '' and g.get('focus') == 'adopt-token' and g.get('session') is None and g.get('local') is None
                and (g.get('status') or '') == '' and 'is forgotten' not in g.get('panel', '') and 'regenerating it' in (g.get('help') or '')), {k: v for k, v in g.items() if k != 'panel'} or tk
    attempt('Chora adopt, Forget: no confirmation and no message, back to the empty field with "Remember my token", the focus in the field, the token and the choice to remember it gone (the control: the revoking advice is in the static help)', forgotten)
    def for_tab():
        t = step(token_states).get('tab') or {}
        return (t.get('state') == 'Token kept for this tab only' and t.get('remember') is True and t.get('forget') is True and t.get('placeholder') == '••••••••'
                and t.get('session') == ADOPT_TOKEN and t.get('local') is None and t.get('inPage') is False and t.get('focus') == 'adopt-q'), {k: v for k, v in t.items() if k != 'panel'} or tk
    attempt('Chora adopt, Enter in the token field: kept for this tab only (said beside it, not in localStorage), Remember still offered, the field masked, and the focus on to the name', for_tab)
    def autofilled():
        f, t = step(token_states).get('filled') or {}, tk.get('tab') or {}
        return (tk.get('filled value') == '' and f.get('session') is None and f.get('state') == '' and f.get('value') == ''
                and tk.get('form') is False and tk.get('autocomplete') == 'new-password' and t.get('session') == ADOPT_TOKEN), \
            {'filled value': tk.get('filled value'), 'filled': f.get('session'), 'form': tk.get('form'), 'autocomplete': tk.get('autocomplete'), 'typed (the control)': t.get('session') == ADOPT_TOKEN, 'error': tk.get('error')}
    attempt('Chora adopt: the token field is in no form and asks for a new password, and a value the browser fills in is emptied and never given (the control: the same typed is given)', autofilled)

    # A legacy cluster link is named (Novocastria, with a record link, has no such line: the control); a place whose @id is the record's adopts the location only.
    def cluster_and_same():
        fresh(ALLOW); open_for('portal'); give_token(); look_up('Newcastle')
        cluster = page.inner_text('#adopt-cluster') if page.is_visible('#adopt-cluster') else ''
        page.click('#adopt-close')
        open_for('tyne record'); look_up('Newcastle')
        page.click('#adopt-candidates li[data-cand="place:gn:2641673"] button[data-preview]')
        until(page, '() => window.__chora.adopt.phase === "preview"', 30)
        page.click('#adopt-go'); until(page, '() => ["adopted"].includes(window.__chora.adopt.phase) || !!document.getElementById("adopt-refused")', 10)
        done = ad().get('done') or {}
        notes = page.inner_text('#chora-adopt') 
        return ('whether it holds this record is not known' in cluster and st.get('cluster on novocastria') is False
                and done.get('count') == 1 and not page.is_visible('#adopt-refused') and not errors), {'cluster': cluster, 'novocastria': st.get('cluster on novocastria'), 'done': done, 'errors': errors[:3]}
    attempt("Chora adopt: a place linked only to a WHG cluster page says so (one linked to a record does not); a place whose @id is the record's w3id adopts the location only, with no error", cluster_and_same)
    # #32: within its region. Abram is in Lancashire, which the dataset identifies with gn:2644974: the search says so
    # before anything is sent, sends contained_in with its country and language, and WHG's Abram there is the one listed.
    # Everywhere only when asked (the control: the foreign Abrams come back); nothing within is said, never widened.
    def scoped():
        fresh(ALLOW); open_for('abram'); give_token()
        said = page.inner_text('#adopt-sends')
        # With the name emptied, the line says nothing is sent (not what a search would send).
        page.fill('#adopt-q', ''); empty = page.inner_text('#adopt-sends')
        posts = lambda since: [json.loads(c['body']) for c in calls[since:] if c['method'] == 'POST']
        out = {'said': said, 'empty': empty}
        n = len(calls); a = look_up('Abram'); sent = posts(n)
        out['within'] = {'sent': [list(b.get('queries', {}).values()) for b in sent], 'listed': [c['id'] for c in a.get('candidates') or []], 'widen': page.is_visible('#adopt-widen')}
        n = len(calls); page.click('#adopt-widen'); until(page, '() => window.__chora.adopt.phase === "answered" && window.__chora.adopt.widened', 30)
        a = ad(); sent = posts(n)
        out['everywhere'] = {'sent': [list(b.get('queries', {}).values()) for b in sent], 'listed': sorted(c['id'] for c in a.get('candidates') or []),
                             'said': page.inner_text('#adopt-sends'), 'narrow': page.is_visible('#adopt-narrow')}
        page.click('#adopt-narrow'); until(page, '() => window.__chora.adopt.phase === "answered" && !window.__chora.adopt.widened', 30)
        n = len(calls); a = look_up('Abram nowhere'); page.wait_for_timeout(1500)
        out['nowhere'] = {'posts': len(posts(n)), 'listed': len(a.get('candidates') or []), 'none': page.inner_text('#adopt-none') if page.is_visible('#adopt-none') else '', 'widen': page.is_visible('#adopt-widen')}
        a = look_up('Abram closed')
        out['closed'] = {'failedClosed': a.get('failedClosed'), 'none': page.inner_text('#adopt-none') if page.is_visible('#adopt-none') else ''}
        w, e, nw, c = out['within'], out['everywhere'], out['nowhere'], out['closed']
        return ('looked for only within Lancashire (WHG gn:2644974), in GB' in said and 'its language (en)' in said
                and 'nothing is sent without one' in empty and 'Sent:' not in empty
                and w['sent'] == [[{'contained_in': ['gn:2644974'], 'countries': ['GB'], 'lang': 'en', 'query': 'Abram', 'type': 'Place', 'limit': 10}]]
                and w['listed'] == ['place:gn:2657859'] and w['widen']
                and e['sent'] == [[{'lang': 'en', 'query': 'Abram', 'type': 'Place', 'limit': 10}]]
                and e['listed'] == sorted(['place:gn:3337500', 'place:gn:4046000', 'place:gn:2657859']) and 'looked for everywhere' in e['said'] and e['narrow']
                and nw['posts'] == 1 and nw['listed'] == 0 and 'nothing of that name within Lancashire' in nw['none'] and 'unless you ask' in nw['none'] and nw['widen']
                and c['failedClosed'] is True and 'could not look within Lancashire' in c['none']
                and not any('area_only' in json.dumps(json.loads(x['body'])) for x in calls if x['method'] == 'POST')), out
    attempt("Chora adopt (#32): a place within a region the dataset identifies is searched within it (contained_in, its country, its name's language, said before sending), so only Lancashire's Abram is listed; everywhere only when asked (the foreign Abrams then come back); nothing within is said, and never widened by itself; no area_only ever sent", scoped)
    attempt('Chora adopt: no page error across these checks (and the checks ran: a request reached the fake WHG)', lambda: (not errors and len(calls) > 3, {'errors': errors[:5], 'calls': len(calls)}))
    ctx.close()

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

FIXTURES = {}
def start_fixtures(tmp):
    """The IIIF fixture server (e2e/iiif_fixture_server.py) on three free ports: origins A and B, and C, which
    lets no other site read what it sends (no CORS header); and its census."""
    a, b, c = free_port(), free_port(), free_port()
    log = tmp / 'iiif-census.jsonl'; log.write_text('')
    p = subprocess.Popen([sys.executable, str(ROOT / 'e2e/iiif_fixture_server.py'), str(a), str(b), str(log), str(c)], start_new_session=True, stdout=subprocess.DEVNULL)
    for _ in range(50):
        with socket.socket() as s1, socket.socket() as s2, socket.socket() as s3:
            if s1.connect_ex(('127.0.0.1', a)) == 0 and s2.connect_ex(('127.0.0.1', b)) == 0 and s3.connect_ex(('127.0.0.1', c)) == 0: break
        time.sleep(0.1)
    FIXTURES.update(proc=p, A=f'http://127.0.0.1:{a}', B=f'http://127.0.0.1:{b}', C=f'http://127.0.0.1:{c}', log=log)
    return FIXTURES

def stop_fixtures():
    p = FIXTURES.pop('proc', None)
    if p: stop(p)

# ---- Methodos: the interview and the tracker (src/methodos/page.js) ----------------------------------
# The interview's answers are given as a visitor gives them (clicks, and the keyboard), and the recipe
# and steps the page shows are compared with test/methodos-predicted.json, the table the unit test
# (test/methodos-interview.test.js) holds the engine to. Every absence is asserted beside a presence.
METHODOS_PREDICTED = json.loads((ROOT / 'test/methodos-predicted.json').read_text())
METHODOS_PAGE_STATE = '''() => { const v = (e) => !!e && !e.closest('[hidden]') && !!(e.offsetWidth || e.offsetHeight);
  const steps = (sel) => [...document.querySelectorAll(sel + ' li.track-step')].map((li) => ({ id: li.dataset.step, state: li.dataset.state, current: li.getAttribute('aria-current'),
    words: li.querySelector('.track-state')?.textContent, why: li.querySelector('.track-why')?.textContent || null }));
  const m = document.getElementById('methodos'), t = document.getElementById('methodos-tracker'), n = document.getElementById('for-tool');
  return { banner: v(document.getElementById('methodos-ask')), interview: v(m), recipe: m?.dataset.recipe || null, verdict: document.getElementById('methodos-verdict')?.textContent || '',
    plan: steps('#methodos-plan'), follow: v(document.getElementById('methodos-start')), followText: document.getElementById('methodos-start')?.textContent || '',
    blocked: document.querySelector('#methodos-plan .track-blocked')?.textContent || null, grid: v(document.getElementById('methodos-grid')),
    tracker: v(t), trackerRecipe: t?.dataset.recipe || null, track: steps('#methodos-track'), where: document.getElementById('methodos-tracker-where')?.textContent || '',
    hash: location.hash, tool: window.__plato?.tool ?? null, note: v(n) ? n.textContent : null, files: v(document.getElementById('files')),
    title: v(document.getElementById('workflow-title')) ? document.getElementById('workflow-title').textContent : null,
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.name || document.activeElement.tagName) : null }; }'''

# ---- Cards marked chosen: Hermes (which narrows nothing) and Methodos (while its interview is open) ----
# Each absence is read in the same call as a presence: the state moved to another card, or the card seen.
CARDS = """() => { const li = (sel) => document.querySelector(sel)?.closest('li.tool'), bg = (sel) => li(sel) ? getComputedStyle(li(sel)).backgroundColor : null;
  const note = document.getElementById('for-tool');
  return { current: [...document.querySelectorAll('#toolbox [aria-current]')].map((e) => e.dataset.tool ?? e.id),
    hermes: bg('#toolbox .tool-link[data-tool="read"]'), elenchos: bg('#toolbox .tool-link[data-tool="check"]'), methodos: bg('#methodos-card'),
    plain: bg('#toolbox .tool-link[data-tool="convert"]'), note: note && !note.hidden ? note.textContent : null, hash: location.hash,
    interview: !document.getElementById('methodos').hidden }; }"""
def gold(c):
    """The chosen card's tint of the gold (#f3c969, 26% into the page): red well above blue. Read as
    rgb() or as color(srgb …), in which the browser gives a color-mix(), with 0–1 channels."""
    try:
        r, g, b = [float(x) for x in c[c.index('(') + 1:c.index(')')].replace('srgb', '').replace(',', ' ').split()[:3]]
        if c.startswith('color('): r, b = r * 255, b * 255
    except Exception: return False
    return r - b > 30   # 26% gives 38, the hover tint (16%) 25, the page 3
def cards(page):
    """The cards' state, the pointer moved off them first: a card hovered has a paler tint of its own."""
    page.mouse.move(1, 1); page.wait_for_timeout(400)
    return page.evaluate(CARDS)
def card_chosen_checks(browser, url, pw):
    def fresh():
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        page.goto(NOTOOLS if PROVE else url)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return ctx, page
    def hermes():
        ctx, page = fresh()
        try:
            page.click('#toolbox .tool-link[data-tool="read"]')
            chosen = cards(page); chosen['focus'] = page.evaluate('() => document.activeElement?.id')
            page.set_input_files('#picker', str(FRONT_FILE))
            wait_state(page, lambda s: s.get('phase') == 'detected', T(60), 'detection')
            vis = page.evaluate(VISIBLE, ACTIONS); still = cards(page)
            page.click('#toolbox .tool-link[data-tool="check"]'); page.wait_for_timeout(300)
            moved = cards(page)
            ok = (chosen['current'] == ['read'] and gold(chosen['hermes']) and chosen['hermes'] != chosen['plain'] and chosen['focus'] == 'picker' and chosen['hash'] == ''
                  and (chosen['note'] or '').startswith('For Hermes, the readers: your file is read when you drop it') and 'Then choose what to do with it.' in chosen['note']
                  and all(vis.values()) and still['current'] == ['read']
                  and moved['current'] == ['check'] and gold(moved['elenchos']) and moved['hermes'] == moved['plain'] and 'Elenchos' in (moved['note'] or '') and 'Hermes' not in moved['note']
                  and moved['hash'] == '#tool=check')
            return ok, {'Hermes chosen': chosen, 'step 2 with a file': vis, 'after the file': still, 'Elenchos then': moved}
        finally: ctx.close()
    attempt('cards: Hermes chosen is marked (aria-current, gold) and said in #for-tool, keeps every action in step 2 and no #tool=; choosing Elenchos moves the mark and the sentence', hermes)
    def methodos():
        ctx, page = fresh()
        try:
            before = cards(page)
            page.click('#methodos-card'); until(page, "!document.getElementById('methodos').hidden", 5)
            opened = cards(page)
            page.click('#methodos-close'); page.wait_for_timeout(200)
            closed = cards(page)
            ok = (before['methodos'] is not None and 'methodos-card' not in before['current']
                  and opened['interview'] and opened['current'] == ['methodos-card'] and gold(opened['methodos']) and opened['methodos'] != opened['plain']
                  and not closed['interview'] and closed['methodos'] is not None and closed['current'] == [] and closed['methodos'] == closed['plain'])
            return ok, {'before': before, 'interview open': opened, 'after Close': closed}
        finally: ctx.close()
    attempt('cards: Methodos\'s card is marked (aria-current, gold) while its interview is open, and not after Close', methodos)
    def visited():
        # getComputedStyle reports a :visited link as unvisited (a privacy rule), so the colour is read
        # from the pixels drawn: the card's text, in its own colour, and beside it a link to the same
        # address that the test's own style turns blue only when visited, which shows that the address
        # counts as visited here and that the blue can be seen. The test's style needs CSP bypassed.
        # In Firefox: Playwright's headless Chromium draws no link as visited, with a profile or without
        # (tried 4 October 2026), so there this check could not fail.
        ff = pw.firefox.launch(headless=True)
        ctx = ff.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True)
        try:
            page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
            page.goto(NOTOOLS if PROVE else url + '#tool=check'); page.wait_for_timeout(500)
            page.goto('about:blank'); page.goto(NOTOOLS if PROVE else url)
            wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready')
            page.add_style_tag(content='#e2e-visited { color: #555 !important; font-size: 20px; } #e2e-visited:visited { color: #1f45b8 !important; }')
            page.evaluate("""() => { const a = document.createElement('a'); a.id = 'e2e-visited'; a.href = '#tool=check'; a.textContent = 'A link to the same address, blue only when visited';
              document.querySelector('#toolbox .tool-link[data-tool="check"]').closest('li').after(a); }""")
            page.mouse.move(1, 1); page.wait_for_timeout(1000)
            count = """async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
              const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
              const d = x.getImageData(0, 0, c.width, c.height).data; let blue = 0, ink = 0;
              for (let i = 0; i < d.length; i += 4) { const [r, g, b] = [d[i], d[i + 1], d[i + 2]]; if (b - r > 60 && b > 120) blue++; else if (r + g + b < 450) ink++; }
              return { blue, ink }; }"""
            import base64
            shot = lambda sel: base64.b64encode(page.locator(sel).screenshot()).decode()
            # The card's name (its words, not its icon, which is drawn in the band's blue): from 78rem the tools are a
            # rail whose cards show their name and label only, with "More" beside the label (Issue #33).
            card = page.evaluate(count, shot('#toolbox .tool-link[data-tool="check"] h4 .why'))
            plain = page.evaluate(count, shot('#e2e-visited'))
            return plain['blue'] > 20 and card['ink'] > 20 and card['blue'] == 0, {'the card\'s text': card, 'a link blue only when visited': plain}
        finally: ctx.close(); ff.close()
    attempt('cards: a card whose address was visited keeps its text\'s own colour, not the visited link\'s blue', visited)

def methodos_page_checks(browser, url):
    def fresh(width=1280, scheme='light'):
        ctx = browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=scheme)
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        page.goto(NOTOOLS if PROVE else url)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return ctx, page
    st = lambda page: page.evaluate(METHODOS_PAGE_STATE)
    def answer(page, have, want, yes):
        page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check(f'input[name="methodos-have"][value="{have}"]'); page.check(f'input[name="methodos-want"][value="{want}"]')
        for k, v in yes.items(): page.check(f'input[name="methodos-ask-{k}"][value="{"yes" if v else "no"}"]')

    def untouched():
        # A visitor who does not use Methodos: the interview and the tracker are not shown, #for-tool is
        # not either, and nothing is chosen (absences); the banner and step 1 are shown (presences).
        ctx, page = fresh()
        try:
            s = st(page)
            return (s['banner'] and s['files'] and not s['interview'] and not s['tracker'] and s['note'] is None and s['hash'] == '' and s['tool'] is None), s
        finally: ctx.close()
    attempt('Methodos: a visitor who does not open it sees step 1 and the one-line banner, and no interview, tracker or chosen step', untouched)

    def predicted():
        out = {}
        for i, p in enumerate(METHODOS_PREDICTED):
            ctx, page = fresh()
            try:
                answer(page, p['have'], p['want'], p['yes'])
                s = st(page)
                plan = [x['id'] for x in s['plan']]
                ok = (s['recipe'] == p['recipe'] and plan == p['steps'] and all(x['state'] == 'todo' and x['words'] == 'To come' for x in s['plan'])
                      and s['follow'] and s['blocked'] is None and str(len(p['steps'])) in s['verdict'])
                # Keyed by the row: two rows may share their first two answers (Match two datasets, into the dataset or not).
                out[f"{i}: {p['have']}+{p['want']}"] = (ok,{'recipe': s['recipe'], 'plan': plan, 'verdict': s['verdict'], 'follow': s['follow']})
            finally: ctx.close()
        return len(out) == len(METHODOS_PREDICTED) and all(v[0] for v in out.values()), {k: v[1] for k, v in out.items()}
    attempt("Methodos: the interview's answers give the recipe and the steps test/methodos-predicted.json predicts, for each of its rows", predicted)

    def tracker():
        # Follow the first prediction (Map your data): the tracker (before step 1 in the page) shows every step, the first
        # now and the rest to come; the first is Hermes's columns (no #tool=, said in #for-tool); a step
        # done moves to Elenchos's check, which chooses #tool=check; back a step returns; leaving clears all.
        p = METHODOS_PREDICTED[0]
        ctx, page = fresh()
        try:
            answer(page, p['have'], p['want'], p['yes'])
            page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
            a = st(page)
            order = page.evaluate("() => { const t = document.getElementById('methodos-tracker'), f = document.getElementById('files'); return !!(t.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }")
            # Before a file is chosen the workflow is not begun, and nothing can be said done (the absence,
            # beside the tracker's words asking for the file); a table chosen begins it, and its columns,
            # once read, are the result of the first step, which is the user's to say done.
            a['done shown'] = page.evaluate("() => !document.getElementById('methodos-done').hidden")
            a['message'] = page.evaluate("() => document.getElementById('methodos-message').textContent")
            page.set_input_files('#picker', [str(ROOT / 'test/fixtures/generic/with-ids.csv')])
            until(page, "() => window.__plato?.columns?.headers && document.getElementById('methodos-tracker').dataset.status === 'idle' && !document.getElementById('methodos-done').hidden", 30)
            page.click('#methodos-done'); until(page, "() => document.querySelector('#methodos-track li[data-step=\"check\"]')?.dataset.state === 'current'", 10); b = st(page)
            page.click('#methodos-back'); until(page, "() => document.querySelector('#methodos-track li[data-step=\"columns\"]')?.dataset.state === 'current'", 10); c = st(page)
            page.click('#methodos-leave'); until(page, "() => document.getElementById('methodos-tracker').hidden", 10); d = st(page)
            ids = [x['id'] for x in a['track']]
            first_ok = (a['tracker'] and not a['interview'] and not a['banner'] and order and a['trackerRecipe'] == p['recipe'] and ids == p['steps']
                        and a['track'][0]['state'] == 'current' and a['track'][0]['current'] == 'step' and a['track'][0]['words'] == 'Now'
                        and all(x['state'] == 'todo' and x['current'] is None for x in a['track'][1:])
                        and a['hash'] == '' and a['tool'] is None and a['note'] and (a['title'] or '').startswith(f"Step 1 of {len(ids)}: Hermes") and 'step 1 of' not in a['note'].lower()
                        and a['where'].startswith(f"Step 1 of {len(ids)}") and '%' not in a['where'] + a['note'] and a['focus'] == 'methodos-tracker-h'
                        and a['done shown'] is False and 'in step 1 to begin' in a['message'])
            second_ok = (b['track'][0]['state'] == 'done' and b['track'][0]['words'] == 'Done' and b['track'][1]['state'] == 'current'
                         and b['hash'] == '#tool=check' and b['tool'] == 'check' and 'Elenchos' in (b['note'] or '') and (b['title'] or '').startswith(f"Step 2 of {len(ids)}: Elenchos") and 'step 2 of' not in (b['note'] or '').lower())
            back_ok = c['track'][0]['state'] == 'current' and c['hash'] == '' and c['tool'] is None
            left_ok = not d['tracker'] and d['banner'] and d['hash'] == '' and d['tool'] is None and d['note'] is None and d['files']
            return first_ok and second_ok and back_ok and left_ok, {'started': a, 'above step 1': order, 'one done': b, 'back': c, 'left': d}
        finally: ctx.close()
    attempt('Methodos: the tracker above step 1 shows the workflow\'s steps as now and to come, begins when a table is chosen, and each step chooses its tool (#tool=) and is the centre\'s title, not said again in #for-tool; the columns step is said done by the user; back and leave undo it', tracker)

    def unavailable():
        # Has regions, answered Yes: the regions step is available now (Krisis's region review), and so is the
        # step that records the regions; nothing is "Not yet available" and the last step notes nothing (the
        # absences, beside the regions and relate steps planned, shown and begun as to come: the presences).
        ctx, page = fresh()
        try:
            # Options' base address is empty here: the interview asks for one (needed, the regions being minted
            # under it), and Follow is not offered until it is given; typed, it is written to Options too.
            before = {'options base': page.input_value('#base')}
            answer(page, 'table', 'map', {'has-regions': False, 'will-draw': False, 'will-publish': False})
            before['asked without regions'] = page.is_visible('#methodos-base')
            page.check('input[name="methodos-ask-has-regions"][value="yes"]')
            before.update({'asked': page.is_visible('#methodos-base'), 'shown': page.input_value('#methodos-base'), 'follow': page.is_visible('#methodos-start'),
                           'verdict': page.inner_text('#methodos-verdict')})
            page.fill('#methodos-base', 'https://example.org/asked/')
            until(page, "() => !document.getElementById('methodos-start').hidden", 5)
            before['options after'] = page.input_value('#base')
            a = st(page)
            page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
            b = st(page)
            page.set_input_files('#picker', [str(ROOT / 'test/fixtures/generic/with-ids.csv')])
            until(page, "() => document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            c = st(page)
            last = page.evaluate("() => document.querySelector('#methodos-track li.track-step:last-child .track-end')?.textContent || null")
            ids = lambda x: [y['id'] for y in x]
            want = ['columns', 'check', 'dataset', 'regions', 'lookup', 'review', 'relate', 'again', 'compare', 'out']
            ok = (ids(a['plan']) == want and all(x['state'] != 'unavailable' and not x['why'] for x in a['plan'])
                  and a['follow'] and a['blocked'] is None and f"in {len(want)} steps" in a['verdict']
                  and b['tracker'] and ids(b['track']) == want and all(x['state'] != 'unavailable' for x in b['track'])
                  and ids(c['track']) == want and next((x['state'] for x in c['track'] if x['id'] == 'regions'), None) == 'todo'
                  and c['track'][0]['state'] == 'current' and c['where'].startswith(f"Step 1 of {len(want)}") and not last
                  and 'Not yet available' not in page.evaluate("() => document.getElementById('methodos-tracker').textContent")
                  and before['options base'] == '' and before['asked without regions'] is False and before['asked'] is True and before['shown'] == ''
                  and before['follow'] is False and 'the base address among them' in before['verdict'] and before['options after'] == 'https://example.org/asked/')
            return ok, {'base': before, 'plan': a, 'started': b, 'begun': c, 'last step notes': last}
        finally: ctx.close()
    attempt('Methodos: with regions answered Yes the base address is asked (not without regions), Follow waits for it, and it is written to Options; the workflow is then followed and begun with its regions step and the step recording them available, nothing "Not yet available", and no note at the end', unavailable)

    def unsure_and_none():
        # "Not sure" leads to the plain grid of cards; answers with no recipe say so and name the tools.
        ctx, page = fresh()
        try:
            answer(page, 'table', 'unsure', {})
            a = st(page)
            page.click('#methodos-grid'); b = st(page)
            in_tools = page.evaluate("() => !!document.activeElement?.closest('#toolbox')")
            answer(page, 'plato', 'convert', {}); c = st(page)
            links = page.eval_on_selector_all('#methodos-plan a[data-methodos-tool]', 'es => es.map((e) => [e.textContent, e.getAttribute("href")])')
            fb = page.evaluate("""() => { const a = document.querySelector('#methodos-plan a.feedback'); if (!a) return null;
              const u = new URL(a.href); return { text: a.firstChild?.textContent, hint: a.querySelector('.visually-hidden')?.textContent, base: u.origin + u.pathname, title: u.searchParams.get('title'), labels: u.searchParams.get('labels'),
                target: a.target, rel: a.rel, visible: !!a.offsetWidth }; }""")
            page.click('#methodos-plan a[data-methodos-tool="convert"]'); page.wait_for_timeout(300)
            chosen = st(page); chosen['focus'] = page.evaluate('() => document.activeElement?.id')
            ok = (a['grid'] and not a['follow'] and a['recipe'] is None and not b['interview'] and in_tools and b['banner']
                  and c['recipe'] is None and not c['follow'] and 'no workflow for this yet' in c['verdict'] and ['Metaphrasis', '#tool=convert'] in links
                  and fb == {'text': 'Tell us what you wanted to do', 'hint': ' (opens in a new tab)', 'base': 'https://github.com/pelagios/plato-tools/issues/new', 'labels': 'Methodos',
                             'title': 'Methodos: a workflow for “A dataset already in a PLATO format” to “A file in another format”', 'target': '_blank', 'rel': 'noopener noreferrer', 'visible': True}
                  and not chosen['interview'] and chosen['hash'] == '#tool=convert' and chosen['tool'] == 'convert' and chosen['focus'] == 'files-h')
            return ok, {'unsure': a, 'grid': b, 'focus in the cards': in_tools, 'none': c, 'links': links, 'feedback': fb, 'Metaphrasis chosen': chosen}
        finally: ctx.close()
    attempt('Methodos: "not sure" leads to the plain grid of cards, and answers that name no workflow say so, link the tools that do the work (each chosen as its card chooses it), and invite feedback in a new issue', unsure_and_none)

    def keyboard():
        # By keyboard alone: Tab to the banner, Enter opens the interview with focus on its heading;
        # Tab and Space answer the first two; the questions are fieldsets with legends, every radio has a
        # name; the verdict is a live region. The card opens it too.
        ctx, page = fresh()
        try:
            tab_to(page, '#methodos-ask'); page.keyboard.press('Enter')
            until(page, "!document.getElementById('methodos').hidden", 5)
            opened = page.evaluate('() => document.activeElement?.id')
            page.keyboard.press('Tab'); page.keyboard.press('Space'); page.keyboard.press('Tab'); page.keyboard.press('Space')
            s = st(page)
            a11y = page.evaluate("""() => ({ legends: [...document.querySelectorAll('#methodos fieldset')].filter((f) => !f.hidden).map((f) => f.querySelector(':scope > legend')?.textContent.trim()),
              unlabelled: [...document.querySelectorAll('#methodos input')].filter((i) => !i.closest('label')).length, live: document.getElementById('methodos-verdict').getAttribute('aria-live'),
              said: document.getElementById('methodos-said').getAttribute('aria-live') })""")
            page.keyboard.press('Escape')
            page.click('#methodos-close'); closed = st(page)
            tab_to(page, '#methodos-card'); page.keyboard.press('Enter')
            again = page.evaluate("() => !document.getElementById('methodos').hidden && document.activeElement?.id")
            page.click('#methodos-close'); back_to_card = page.evaluate('() => document.activeElement?.id')
            ok = (opened == 'methodos-h' and s['recipe'] == 'map-your-data' and a11y['legends'][:3] == ['1. What do you have?', '2. What do you want at the end?', '3. Anything of these?']
                  and a11y['unlabelled'] == 0 and a11y['live'] == 'polite' and a11y['said'] == 'polite' and not closed['interview'] and closed['focus'] == 'methodos-ask'
                  and again == 'methodos-h' and back_to_card == 'methodos-card')
            return ok, {'focus on opening': opened, 'state': s, 'a11y': a11y, 'closed': closed, 'from the card': again, 'closed from the card': back_to_card}
        finally: ctx.close()
    attempt('Methodos: the interview opens from the banner and the card by keyboard, with focus on its heading, is answered with Tab and Space, its questions are labelled fieldsets, and Close returns focus to whichever opened it', keyboard)

    def clean_and_narrow():
        # No inline script, no inline handler and no title attribute, with the interview and tracker open
        # (presence: the page's own scripts by src, and the data-tip on Methodos's name); and at 390 px
        # in dark, no sideways scroll, in the dark colours (the tracker's card is the dark --card).
        ctx, page = fresh(390, 'dark')
        try:
            p = METHODOS_PREDICTED[0]
            answer(page, p['have'], p['want'], p['yes'])
            wide1 = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
            page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
            wide2 = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
            # The one inline script is the head's policy writer (front_page_checks); none other.
            r = page.evaluate("""() => ({ inline: [...document.scripts].filter((s) => !s.src && s !== document.head.querySelector('script')).length,
              writer: !!document.head.querySelector('script:not([src])'), bySrc: [...document.scripts].filter((s) => s.src).length,
              handlers: (() => { const probe = document.createElement('i'); probe.setAttribute('onclick', 'void 0'); probe.hidden = true; document.body.append(probe);
                const n = [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).length; probe.remove(); return n - 1; })(),
              titled: document.querySelectorAll('body [title]').length, tip: !!document.querySelector('#methodos-card .why[data-tip]'),
              bg: getComputedStyle(document.getElementById('methodos-tracker')).backgroundColor, body: getComputedStyle(document.body).backgroundColor })""")
            # The tooltips turn any title attribute into data-tip as the page loads (src/lib/tooltip.js), so
            # titles are looked for in the served file, beside the data-tip that the same search finds.
            served = urllib.request.urlopen(url, timeout=10).read().decode('utf-8') if not PROVE else ''
            r['titles served'] = len(re.findall(r'<[^>]*\stitle=', served)); r['data-tip served'] = len(re.findall(r'\sdata-tip=', served))
            ok = r['titles served'] == 0 and r['data-tip served'] > 0 and wide1 <= 0 and wide2 <= 0 and r['inline'] == 0 and r['writer'] and r['bySrc'] > 0 and r['handlers'] == 0 and r['titled'] == 0 and r['tip'] and r['bg'] == 'rgb(30, 34, 41)' and r['body'] == 'rgb(22, 25, 31)'
            return ok, {'overflow (interview, tracker)': (wide1, wide2), **r}
        finally: ctx.close()
    attempt('Methodos at 390 px in dark: no sideways scroll, dark colours, and no inline script, inline handler or title attribute with the interview and tracker open', clean_and_narrow)

# ---- The main page's layout (Issue #33; src/styles.css, src/methodos/layout.js) ---------------------------
# Three columns from 78rem (the tools rail, the steps, the workflow rail), two from 60rem, one below with the
# tracker a strip; in a workflow, one numbering (the page's numbers hidden, the centre titled with the step),
# the tracker's steps as checkboxes, step 1 folded once its file is chosen, and what is to be done next
# brought into view. Measured, not read from classes: each position and each absence has a presence beside
# it in the same reading (the tracker beside the step and the step in view; the numbers hidden, and shown
# before; a tick on the step done and none on the current one).
LAYOUT = """() => { const r = (id) => { const e = document.getElementById(id); if (!e || e.closest('[hidden]') || !e.getClientRects().length) return null;
    const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width) }; };
  const steps = [...document.querySelectorAll('#methodos-track li.track-step')].map((li) => { const c = li.querySelector('input.track-check'), w = li.querySelector('.track-state');
    return { id: li.dataset.step, state: li.dataset.state, box: !!c && c.type === 'checkbox' && c.disabled, checked: !!c?.checked, current: !!c && c.hasAttribute('data-current'),
      words: w?.textContent || null, wordsShown: !!w && w.getBoundingClientRect().width > 2 }; });
  const numbers = [...document.querySelectorAll('main .step')].filter((e) => !e.closest('[hidden]'));
  const strip = document.getElementById('methodos-strip');
  return { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), tracker: r('methodos-tracker'), files: r('files'), action: r('action'), actionH: r('action-h'), toolbox: r('toolbox'),
    title: r('workflow-title') ? document.getElementById('workflow-title').textContent : null,
    where: document.getElementById('methodos-tracker-where')?.textContent || '', list: r('methodos-track'), strip: r('methodos-strip'), stripWords: strip?.textContent.replace('▾', '').trim() || null,
    expanded: strip?.getAttribute('aria-expanded') || null, line: r('chosen-line'), drop: r('drop'),
    numbersShown: numbers.filter((e) => e.getClientRects().length).length, numbersAll: numbers.length,
    workflow: document.body.dataset.workflow || null, focus: document.activeElement?.id || null, steps,
    done: r('methodos-done'), railScrolled: Math.round(document.getElementById('workflow-rail')?.scrollTop || 0),
    listOverflows: (() => { const t = document.getElementById('methodos-track'); return !!t && t.scrollHeight > t.clientHeight + 1; })(),
    result: r('result'), resultOf: r('result-of') ? document.getElementById('result-of').textContent : null,
    parked: document.querySelector('#methodos-track .track-result')?.textContent || null,
    kids: (() => { const m = document.querySelector('main.layout'); return m ? [...m.children].filter((e) => getComputedStyle(e).display !== 'none').length : null; })() }; }"""
def layout_checks(browser, url):
    def fresh(width, height=900):
        ctx = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        page.goto(NOTOOLS if PROVE else url)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        return ctx, page
    L = lambda page: page.evaluate(LAYOUT)
    def follow(page):
        # Map your data, as in the screenshots asked for: a table, places on a map, with regions, drawing, no publishing.
        page.click('#methodos-ask'); until(page, "!document.getElementById('methodos').hidden", 5)
        page.check('input[name="methodos-have"][value="table"]'); page.check('input[name="methodos-want"][value="map"]')
        for k, v in (('has-regions', 'yes'), ('will-draw', 'yes'), ('will-publish', 'no')): page.check(f'input[name="methodos-ask-{k}"][value="{v}"]')
        page.fill('#methodos-base', 'https://example.org/parishes/')
        until(page, "() => !document.getElementById('methodos-start').hidden", 5)
        page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
    def chosen(page):
        # From the top of the page, the focus on the page itself, as after a click elsewhere.
        page.evaluate('() => { document.activeElement?.blur(); scrollTo(0, 0); }')
        page.set_input_files('#picker', [str(MYDATA_CSV)])
        until(page, "() => window.__plato?.phase === 'detected' && document.getElementById('methodos-tracker').dataset.status === 'idle' && !!window.__plato.columns?.headers", 30)
        page.wait_for_timeout(300)
    err = lambda r: {'error': r['error']} if 'error' in r else {}

    r = {}
    try:
        ctx, page = fresh(1440)
        try:
            r['landing'] = L(page)
            follow(page); r['pending'] = L(page)
            chosen(page); r['chosen'] = L(page)
            page.click('#methodos-done'); until(page, "() => document.querySelector('#methodos-track li[data-step=\"check\"]')?.dataset.state === 'current'", 10)
            page.wait_for_timeout(300); r['step2'] = L(page)
            # Check run in the workflow: the step done, the workflow goes on to step 3, and the result stays in
            # view, labelled as step 2's, until the user first acts on step 3 (a click in its action); then
            # it is put away, summed up in step 2's row, from which it is shown again.
            page.click('#check'); until(page, "() => document.querySelector('#methodos-track li[data-step=\"check\"]')?.dataset.state === 'done'", 60)
            page.wait_for_timeout(400); r['checked'] = L(page)
            page.click('#action-h'); until(page, "() => !!document.querySelector('#methodos-track .track-reopen')", 10); r['parked'] = L(page)
            page.click('#methodos-track .track-reopen'); page.wait_for_timeout(300); r['reopened'] = L(page)
        finally: ctx.close()
        # The file dropped first, then the workflow followed: step 1 folds as soon as the workflow begins.
        ctx, page = fresh(1440)
        try:
            page.set_input_files('#picker', [str(MYDATA_CSV)])
            until(page, "() => window.__plato?.phase === 'detected'", 30); r['dropped'] = L(page)
            follow(page); until(page, "() => document.getElementById('methodos-tracker').dataset.status === 'idle'", 30)
            page.wait_for_timeout(300); r['followed'] = L(page)
        finally: ctx.close()
        # Outside a workflow, a field being typed in keeps the focus and the view when a file is recognised;
        # with the focus on the page itself, step 2's heading takes it (the presence).
        ctx, page = fresh(1440)
        try:
            page.set_input_files('#picker', [str(MYDATA_CSV)]); until(page, "() => window.__plato?.phase === 'detected'", 30); page.wait_for_timeout(300)
            r['free'] = L(page)
            page.evaluate("() => { document.getElementById('paste').open = true; }")
            page.focus('#paste-text'); page.wait_for_timeout(200); before = L(page)
            page.set_input_files('#picker', [str(ROOT / 'test/fixtures/generic/with-ids.csv')])
            until(page, "() => window.__plato?.phase === 'detected' && /with-ids/.test(document.getElementById('chosen').textContent)", 30); page.wait_for_timeout(400)
            r['typing'] = {'before': before, 'after': L(page)}
        finally: ctx.close()
    except Exception as e: r['error'] = 'harness error: ' + str(e).split('\n')[0][:200]
    a, p, c, d = (r.get(k) or {} for k in ('landing', 'pending', 'chosen', 'step2'))
    k3, pk, ro = (r.get(k) or {} for k in ('checked', 'parked', 'reopened'))
    check('layout at 1440×900: the rail\'s step list scrolls on its own, and the step\'s buttons ("This step is done") stay in view below it, the rail itself not scrolled',
          bool(c.get('done')) and c['done']['bottom'] <= c['h'] and c['done']['top'] >= 0 and c.get('listOverflows') is True and c.get('railScrolled') == 0,
          {x: c.get(x) for x in ('done', 'h', 'listOverflows', 'railScrolled')} | err(r))
    check('layout: a check run in the workflow does its step, the title goes on to step 3, and the result stays in view labelled "Result of step 2"; acted on, step 3 puts it away into step 2\'s row, from which it is shown again',
          (k3.get('title') or '').startswith('Step 3 of ') and bool(k3.get('result')) and (k3.get('resultOf') or '').startswith('Result of step 2: Elenchos')
          and not pk.get('result') and 'Show its result' in (pk.get('parked') or '') and bool(ro.get('result')) and (ro.get('resultOf') or '').startswith('Result of step 2: '),
          {'checked': {x: k3.get(x) for x in ('title', 'result', 'resultOf')}, 'acted on': {x: pk.get(x) for x in ('result', 'parked')}, 'shown again': {x: ro.get(x) for x in ('result', 'resultOf')}} | err(r))
    dr, fo = r.get('dropped') or {}, r.get('followed') or {}
    check('layout: a file dropped first and a workflow followed after folds step 1 to its line as the workflow begins (open before it)',
          bool(dr.get('drop')) and not dr.get('line') and bool(fo.get('line')) and not fo.get('drop') and fo.get('workflow') == 'map-your-data',
          {'dropped': {x: dr.get(x) for x in ('drop', 'line')}, 'followed': {x: fo.get(x) for x in ('drop', 'line', 'workflow')}} | err(r))
    ty, fr = r.get('typing') or {}, r.get('free') or {}
    tb, ta = ty.get('before') or {}, ty.get('after') or {}
    check('layout: a file recognised while a field (step 1\'s pasted list) has the focus leaves the focus and the view where they were; with the focus on the page, step 2\'s heading takes it',
          fr.get('focus') == 'action-h' and tb.get('focus') == 'paste-text' and ta.get('focus') == 'paste-text' and ta.get('scrollY') == tb.get('scrollY'),
          {'free': fr.get('focus'), 'before': {x: tb.get(x) for x in ('focus', 'scrollY')}, 'after': {x: ta.get(x) for x in ('focus', 'scrollY')}} | err(r))
    states = [x for x in (a, p, c, d, k3, pk, ro, dr, fo) if x]
    check('layout: the page\'s grid has rows enough: at most twelve of main\'s children shown at once, in every state above (at least three: the rail, step 1 and the tools)',
          len(states) == 9 and all(isinstance(x.get('kids'), int) and 3 <= x['kids'] <= 12 for x in states), [x.get('kids') for x in states] + ([r['error']] if 'error' in r else []))
    inview = lambda x, box: bool(box) and 0 <= box['top'] < x['h']
    beside = lambda x: (bool(x.get('tracker')) and bool(x.get('action')) and x['tracker']['left'] >= x['action']['right']
                        and x['tracker']['top'] < x['h'] and x['tracker']['bottom'] > 0)
    check('layout at 1440×900: three columns, the tools rail left of the steps, and the tracker beside the step, in view, while the workflow runs',
          beside(c) and beside(d) and inview(d, d.get('actionH')) and bool(a.get('toolbox')) and bool(a.get('files')) and a['toolbox']['right'] <= a['files']['left'],
          {k: {x: (r.get(k) or {}).get(x) for x in ('tracker', 'action', 'toolbox', 'files', 'h')} for k in ('landing', 'chosen', 'step2')} | err(r))
    check('layout: once the file is chosen and recognised, step 2\'s action is brought into view (the page scrolled) and takes the focus, and step 1 folds to its one line',
          not p.get('action') and inview(c, c.get('actionH')) and c.get('scrollY', 0) > 0 and c.get('focus') == 'action-h'
          and bool(c.get('line')) and not c.get('drop') and bool(p.get('drop')) and not p.get('line'),
          {'before': {x: p.get(x) for x in ('action', 'drop', 'line')}, 'after': {x: c.get(x) for x in ('actionH', 'scrollY', 'focus', 'line', 'drop')}} | err(r))
    check('layout: the workflow going on to step 2 brings its action into view again, with the focus',
          inview(d, d.get('actionH')) and d.get('focus') == 'action-h' and (d.get('title') or '').startswith('Step 2 of '), {x: d.get(x) for x in ('actionH', 'focus', 'title')} | err(r))
    check('layout in a workflow: the page\'s own section numbers are hidden (shown before it), and the centre is titled with the tracker\'s current step',
          a.get('numbersShown', 0) >= 1 and d.get('numbersAll', 0) >= 2 and d.get('numbersShown') == 0 and d.get('workflow') == 'map-your-data' and not a.get('workflow')
          and bool(d.get('title')) and d['title'] + '.' == d.get('where') and d['title'].startswith('Step 2 of ') and 'Elenchos' in d['title']
          and bool(p.get('title')) and p['title'] + '.' == p.get('where') and p['title'].startswith('Step 1 of '),
          {'numbers before': a.get('numbersShown'), 'numbers in the workflow': [d.get('numbersShown'), d.get('numbersAll')], 'title': [p.get('title'), d.get('title')], 'where': [p.get('where'), d.get('where')]} | err(r))
    def boxes_match(x):
        st = x.get('steps') or []
        return (len(st) >= 5 and all(s['box'] and s['checked'] == (s['state'] == 'done') and s['current'] == (s['state'] == 'current') and s['words'] and not s['wordsShown'] for s in st)
                and sum(s['state'] == 'current' for s in st) == 1 and any(s['state'] == 'todo' for s in st))
    st2 = d.get('steps') or []
    check('layout: each step of the tracker has a disabled checkbox, ticked exactly when done, the current one marked and not ticked, its words kept for a screen reader (visually hidden)',
          boxes_match(c) and boxes_match(d) and not any(s['checked'] for s in c.get('steps') or [])
          and [s['state'] for s in st2[:2]] == ['done', 'current'] and st2[0]['checked'] and not st2[1]['checked'],
          {'step 1': c.get('steps'), 'step 2': st2} | err(r))

    r = {}
    try:
        ctx, page = fresh(1000)
        try: follow(page); chosen(page); r['two'] = L(page)
        finally: ctx.close()
        ctx, page = fresh(600)
        try:
            follow(page); chosen(page); r['one'] = L(page)
            page.click('#methodos-strip'); page.wait_for_timeout(200); r['open'] = L(page)
            page.click('#methodos-strip'); page.evaluate('() => scrollTo(0, document.documentElement.scrollHeight)'); page.wait_for_timeout(300); r['scrolled'] = L(page)
            # Opened, and the step said done from it: the workflow goes on, and the strip closes over the next step.
            page.evaluate('() => scrollTo(0, 0)'); page.click('#methodos-strip'); page.wait_for_timeout(200); r['reopened'] = L(page)
            page.click('#methodos-done'); until(page, "() => document.querySelector('#methodos-track li[data-step=\"check\"]')?.dataset.state === 'current'", 10)
            page.wait_for_timeout(300); r['went on'] = L(page)
        finally: ctx.close()
    except Exception as e: r['error'] = 'harness error: ' + str(e).split('\n')[0][:200]
    t, o, op, sc = (r.get(k) or {} for k in ('two', 'one', 'open', 'scrolled'))
    rp, wo = r.get('reopened') or {}, r.get('went on') or {}
    check('layout at 600 px: the strip, opened, closes when the workflow goes on to the next step, which is brought into view below it',
          rp.get('expanded') == 'true' and bool(rp.get('list')) and wo.get('expanded') == 'false' and not wo.get('list') and (wo.get('stripWords') or '').startswith('Step 2 of ')
          and bool(wo.get('actionH')) and bool(wo.get('strip')) and wo['actionH']['top'] >= wo['strip']['bottom'] and wo['actionH']['top'] < wo['h'],
          {'opened': {x: rp.get(x) for x in ('expanded', 'list')}, 'went on': {x: wo.get(x) for x in ('expanded', 'list', 'stripWords', 'actionH', 'strip')}} | err(r))
    check('layout at 1000 px: two columns, the steps and the tracker beside them, with the tools as cards below the steps',
          beside(t) and bool(t.get('toolbox')) and bool(t.get('action')) and t['toolbox']['left'] == t['action']['left'] and t['toolbox']['top'] > t['action']['top'] and not t.get('strip'),
          {x: t.get(x) for x in ('tracker', 'action', 'toolbox', 'strip')} | err(r))
    check('layout at 600 px: one column, the tracker a strip saying the step ("Step 1 of …") with its list folded away, which opens to the list, and stays at the top of the window when scrolled',
          bool(o.get('tracker')) and bool(o.get('action')) and abs(o['tracker']['left'] - o['action']['left']) <= 2 and o['tracker']['width'] == o['action']['width']
          and bool(o.get('strip')) and (o.get('stripWords') or '') + '.' == o.get('where') and (o.get('stripWords') or '').startswith('Step 1 of ') and not o.get('list') and o.get('expanded') == 'false'
          and bool(op.get('list')) and op.get('expanded') == 'true'
          and bool(sc.get('tracker')) and sc['tracker']['top'] <= 1 and sc.get('scrollY', 0) > 500 and sc['w'] <= 600,
          {'one': {x: o.get(x) for x in ('tracker', 'action', 'strip', 'stripWords', 'where', 'list', 'expanded')}, 'opened': {x: op.get(x) for x in ('list', 'expanded')},
           'scrolled': {x: sc.get(x) for x in ('tracker', 'scrollY')}} | err(r))

def iiif_checks(pw, url, tmp):
    fx = start_fixtures(tmp); A, B, log = fx['A'], fx['B'], fx['log']
    IA, ALLMAPS_KEY = f'iiif:{A}', 'allmaps:allmaps'
    base = url.rstrip('/') + '/'
    ctx = pw.chromium.launch_persistent_context(str(tmp / 'iiif-profile'), headless=True, accept_downloads=True, args=GL,
                                                viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    ctx.set_default_timeout(T(30) * 1000)                       # a click waits for its element: longer on the deployed site
    # The fixtures' sites are on this computer (127.0.0.1). Chromium lets a public site's page reach
    # them only with the local-network-access permission, which a real map server never needs: grant
    # it to the deployed site, so that a live run checks the page rather than this computer's network.
    if urlparse(base).hostname not in ('127.0.0.1', 'localhost'):
        ctx.grant_permissions(['local-network-access'], origin=f'{urlparse(base).scheme}://{urlparse(base).netloc}')
    errors = []
    ctx.on('page', lambda p: p.on('pageerror', lambda e: errors.append(str(e)[:200])))
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    def census(since=0):
        return [json.loads(l) for l in log.read_text().splitlines()[since:]]
    def at_origin(rows, o): return [r for r in rows if f"127.0.0.1:{r['port']}" == urlparse(o).netloc]
    def annotation(name='annotation.json', service=None, id=None):
        a = json.loads((FIX / name).read_text().replace('https://iiif.example.org', A).replace('https://elsewhere.example.org', B))
        if service: a['target']['source']['id'] = A + service
        if id: a['id'] = id
        return a
    def paste(text):
        page.fill('#chora-map-input', text if isinstance(text, str) else json.dumps(text)); page.click('#chora-map-form button[type=submit]')
    def ready():
        until(page, '() => window.__chora && window.__chora.phase !== "reloading" && window.__chora.mapReadyCount >= 1 && window.__chora.canary && window.__chora.canary !== "pending"', 60)
    def line(key):
        sel = f'#chora-map-needs [data-permission="{key}"]'
        return page.inner_text(sel) if soon(page, 's => { const e = document.querySelector(s); return !!e && !e.hidden; }', 15, sel) else ''
    def panel_set(keys, to='allowed', reload=False, via=None):
        """Open the panel (from a map's "Needs permission" line when `via` is given, else the header's button), set each permission, and reload as the panel offers."""
        page.click(f'#chora-map-needs [data-permission="{via}"] button' if via else '#permissions-button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        # Clicked, not page.check(): the panel is drawn again once a permission changes, so the radio clicked
        # is gone by the time page.check() would look whether it is checked. The state is asked instead.
        for k in keys:
            page.click(f'#permissions-panel fieldset.perm[data-key="{k}"] input[value="{to}"]')
            # Set to Undecided while nothing on the page waits on it (no map of that server shown or waiting:
            # on the deployed site the maps kept may not be back yet), it is no longer listed at all
            # (permissions.js list(): known services, what is decided, what a page waits on), so its entry
            # goes: then it is asked where it is kept, that it is no longer there.
            until(page, """([k, to]) => { const f = document.querySelector(`#permissions-panel fieldset.perm[data-key="${k}"]`);
              if (f) return !!f.querySelector(`input[value="${to}"]`)?.checked;
              return to === 'undecided' && !(JSON.parse(localStorage.getItem('plato-tools.permissions') || '{}').grants || {})[k]; }""", 10, [k, to])
            if not page.query_selector(f'#permissions-panel fieldset.perm[data-key="{k}"]'):
                print(f'  note: {k}, set to Undecided, is no longer listed in the panel (nothing on the page waits on it); maps shown: {len((cstate(page) or {}).get("overlays") or [])}')
        if reload:
            with page.expect_navigation(timeout=T(60) * 1000): page.click('#permissions-panel [data-reload]')
            ready()
        else:
            page.keyboard.press('Escape')
            until(page, '() => !document.getElementById("permissions-panel").open', 10)
    def shown(annotation_id, timeout=30):
        return soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', timeout, annotation_id)
    allmaps_hits = []
    def allmaps_route(route):
        allmaps_hits.append(route.request.url)
        u = urlparse(route.request.url)
        if u.path.startswith('/images/'):
            body = json.loads((FIX / 'allmaps-images-e564650581f5f6bb.json').read_text().replace('https://iiif.example.org', A))
            body['items'][0]['id'] = 'https://annotations.allmaps.org/maps/0000000000000003'
            route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(body))
        else: route.fulfill(status=404, headers={'Access-Control-Allow-Origin': '*'}, body='{}')
    page.route(ALLMAPS + '/**', allmaps_route)
    grid_id = 'https://annotations.allmaps.org/maps/0000000000000001'

    def before_permission():
        chora_boot(page, base); ready()
        since = len(census()); text = json.dumps(annotation())
        paste(text)
        said = line(IA)
        page.wait_for_timeout(1000)                              # time for anything that would be asked, to be asked
        early = census(since)
        navs = []; listen = lambda fr: navs.append(fr.url) if fr == page.main_frame else None
        page.on('framenavigated', listen)
        panel_set([IA], reload=True, via=IA)
        drew = shown(grid_id)
        page.remove_listener('framenavigated', listen)
        rows = census(since); s = cstate(page); csp = page.evaluate('() => window.__platoCsp')
        paths = [r['path'] for r in at_origin(rows, A)]
        typed = page.input_value('#chora-map-input')
        return (f'Needs permission: {urlparse(A).netloc}' in said and early == [] and len(navs) == 1 and s['canary'] == 'enforced'
                and drew and '/iiif/grid/info.json' in paths and any(p.endswith('/default.jpg') for p in paths) and at_origin(rows, B) == []
                and A in csp['origins'] and B not in csp['origins'] and s['overlays'][0]['transformation'] == 'polynomial1'
                and (s.get('resumed') or {}).get('maps', {}).get('pending', {}).get('text') == text and typed == text), {
            'line': said, 'asked before allowing': early, 'navigations': navs, 'census after': [(r['port'], r['status'], r['path']) for r in rows],
            'overlays': s['overlays'], 'canary': s['canary'], 'policy': csp['origins'], 'resumed': bool(s.get('resumed')), 'typed kept': typed == text}
    attempt('Chora maps: a pasted map asks nothing of its server, and says "Needs permission" for it; allowed in the panel, one reload, and the map waiting is added from its image information and tiles, from it alone', before_permission)

    GRID5 = [[64 + 96 * i, 64 + 96 * j] for i in range(5) for j in range(5)]
    def agreement_order1():
        r = page.evaluate(AGREE_JS, GRID5)
        one = next((x for x in r if x['annotation'] == grid_id), None)
        return (one and one['n'] == 25 and one['self'] == 0 and one['type'] == 'polynomial1' and one['worst'] <= 1e-7 and one['lonlat'] <= 1e-7), r
    attempt('Chora maps: where the renderer draws each of 25 pixels of the map is where georef places it, to 1e-7 m (order 1)', agreement_order1)
    def agreement_order2():
        o2 = annotation('annotation-order2.json'); since = len(census())
        paste(o2)
        drew = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 20, o2['id'])
        r = page.evaluate(AGREE_JS, GRID5)
        two = next((x for x in r if x['annotation'] == o2['id']), None)
        # The control: the renderer's own order-1 transformation of the same map disagrees by metres, which
        # is what it would draw had its transformation not been set from the georeference.
        return (drew and two and two['mapIds'] and two['self'] == 0 and two['type'] == 'polynomial2' and two['worst'] <= 1e-7 and two['lonlat'] <= 1e-7 and two['order1'] > 1
                and at_origin(census(since), B) == []), {'order 2': two, 'drew': drew}
    attempt('Chora maps: an order-2 map is drawn at order 2 (set from its georeference), agreeing with georef to 1e-7 m; order 1 would be metres off', agreement_order2)

    def several():
        older = annotation(id='https://annotations.allmaps.org/maps/00000000000000a1'); older['modified'] = '2026-09-01T10:00:00.000Z'
        newer = annotation('annotation-order2.json', id='https://annotations.allmaps.org/maps/00000000000000a2'); newer['modified'] = '2026-09-30T10:00:00.000Z'
        paste({'id': 'https://annotations.allmaps.org/images/e564650581f5f6bb', 'type': 'AnnotationPage', 'items': [older, newer]})
        offered = soon(page, '() => document.querySelectorAll("#chora-map-choice input[name=georef-choice]").length === 2', 15)
        said = page.inner_text('#chora-map-status')
        checked = page.get_attribute('#chora-map-choice input[name=georef-choice]:checked', 'value') if offered else None
        if offered: page.click('#chora-map-choose')
        got = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 20, newer['id'])
        return (offered and checked == '1' and '4 control points' in said and '9 control points' in said and '2026-09-30' in said and '2026-09-01' in said
                and 'index option' not in said and got and not any(o['annotationId'] == older['id'] for o in cstate(page)['overlays'])), {'said': said, 'default': checked, 'shown': got}
    attempt('Chora maps: a georeference holding several maps offers a choice, each with its date and control points, the newest chosen by default; the one chosen is shown', several)

    def raw_image_id():
        # The georeference names the image with a trailing slash. The page asks for {id}/info.json with no
        # slash (a server redirects the other), and gives the renderer the information under the id it looks
        # up, or it would fetch the information again, itself (the server's own log counts that).
        since = len(census()); rid = 'https://annotations.allmaps.org/maps/00000000000000b1'
        paste(annotation(service='/iiif/grid/', id=rid))
        got = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 20, rid)
        page.evaluate(SETTLE); page.wait_for_timeout(1500)
        infos = [r['path'] for r in census(since) if r['path'].endswith('info.json')]
        return got and infos == ['/iiif/grid/info.json'], {'admitted': got, 'image information asked for': infos}
    attempt('Chora maps: a map whose georeference writes its image with a trailing slash is asked for at {id}/info.json once, and the renderer asks for none of its own', raw_image_id)

    def bad_site():
        before = len(errors); since = len(census())
        paste('http://my_host.example.org/maps/grid/manifest')
        said = soon(page, '() => /plain https address/.test(document.getElementById("chora-map-status").textContent)', 10)
        text = page.inner_text('#chora-map-status')
        return (said and 'my_host.example.org' in text and not page.query_selector('#chora-map-needs [data-permission]') and len(errors) == before and census(since) == []), {'said': text, 'page errors': errors[before:]}
    attempt('Chora maps: a map on a site that cannot be a permission (nor in the page\'s policy) is refused in plain words, with no line asking for it and no error in the page', bad_site)

    def forwards():
        # An ARK-like address on A, which answers with a redirect to another host (B): refused in c2's
        # words, naming no host, with the address offered as a link to open in a new tab; B is asked nothing.
        since = len(census()); ark = A + '/ark/50959/x/manifest'
        paste(ark)
        said = soon(page, '() => /forwards to another one/.test(document.getElementById("chora-map-status").textContent)', 15)
        text = page.inner_text('#chora-map-status')
        link = page.evaluate('() => { const a = document.getElementById("chora-map-forwards"); return a ? { href: a.href, target: a.target, rel: a.rel } : null; }')
        rows = census(since)
        return (said and 'Open it in a new tab, and paste the address it ends at.' in text and urlparse(B).netloc not in text and link and link['href'] == ark
                and link['target'] == '_blank' and 'noopener' in link['rel'] and [r['status'] for r in at_origin(rows, A)] == [302] and at_origin(rows, B) == []), {
            'said': text, 'link': link, 'census': [(r['port'], r['status'], r['path']) for r in rows]}
    attempt('Chora maps: an address that forwards to another host is refused in plain words naming no host, offered as a link to open in a new tab; that host is asked nothing', forwards)

    def foreign_id():
        since = len(census())
        paste(annotation(service='/iiif/foreign', id='https://annotations.allmaps.org/maps/000000000000000f'))
        refused = soon(page, '() => /not shown/.test(document.getElementById("chora-map-status").textContent)', 20)
        said = page.inner_text('#chora-map-status'); rows = census(since)
        return (refused and B in said and '/iiif/foreign/info.json' in [r['path'] for r in at_origin(rows, A)]
                and not any('default.jpg' in r['path'] for r in at_origin(rows, A)) and at_origin(rows, B) == []
                and not any(o['annotationId'].endswith('00f') for o in cstate(page)['overlays'])), {'said': said, 'census': [(r['port'], r['path']) for r in rows]}
    attempt('Chora maps: a map whose image information names an image on another site is refused, in words; that site is asked nothing', foreign_id)

    def redirect():
        since = len(census())
        rid = 'https://annotations.allmaps.org/maps/0000000000000302'
        paste(annotation(service='/iiif/redirect', id=rid))
        admitted = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 20, rid)
        page.evaluate("() => { const o = window.__chora_overlays.manager.entries; window.__chora_map.fitBounds(window.__chora_overlays.layer.getMapsBounds(o.map((e) => e.mapId)), { duration: 0 }); }")
        page.evaluate(SETTLE)
        failed = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.tileErrors > 0)', 20, rid)
        page.wait_for_timeout(1500)
        rows = census(since); a_paths = [r['path'] for r in at_origin(rows, A)]
        honest = next((o for o in cstate(page)['overlays'] if o['annotationId'] == grid_id), {})
        said = page.inner_text('#chora-overlay-list'); csp = page.evaluate('() => window.__platoCsp')
        return (admitted and failed and any(p.startswith('/iiif/redirect/') and p.endswith('default.jpg') for p in a_paths)
                and any(r['status'] == 302 for r in at_origin(rows, A)) and at_origin(census(), B) == [] and honest.get('tilesLoaded', 0) > 0
                and A in csp['origins'] and B not in csp['origins'] and 'could not be loaded' in said), {
            'failed': failed, 'A': [(r['status'], r['path']) for r in at_origin(rows, A)], 'B, whole run': at_origin(census(), B), 'honest map': honest,
            'policy': csp['origins'], 'said': said[-300:], 'events': cstate(page).get('overlayEvents')}
    attempt('Chora maps: a tile answered by a redirect to another site is stopped by the page\'s policy in the built page\'s tile workers (that site gets no request at all, and is not in the policy), while the honest map drew', redirect)

    def lookup():
        hits = len(allmaps_hits)
        paste(A + '/manifests/grid/manifest')
        offered = soon(page, '() => !!document.getElementById("chora-map-lookup")', 20)
        offer = page.inner_text('#chora-map-status')
        editor_before = page.query_selector('#chora-map-editor, #chora-overlay-list a[data-editor]') is not None
        page.click('#chora-map-lookup')
        said = line(ALLMAPS_KEY)
        page.wait_for_timeout(500)
        before = len(allmaps_hits) - hits                          # nothing asked of Allmaps before it is allowed
        panel_set([ALLMAPS_KEY], reload=True, via=ALLMAPS_KEY)
        got = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 30, 'https://annotations.allmaps.org/maps/0000000000000003')
        asked = allmaps_hits[hits:]
        editor = page.get_attribute('#chora-overlay-list a[data-editor]', 'href') if page.query_selector('#chora-overlay-list a[data-editor]') else ''
        return (offered and editor_before and 'sends this map' in offer and 'Allmaps learns' not in offer and 'asks Allmaps' not in offer and before == 0 and 'Needs permission: Allmaps' in said
                and got and asked and all(urlparse(u).path.startswith('/images/') and '?url=' not in u for u in asked)
                and editor.startswith('https://editor.allmaps.org/images?url=')), {
            'offered': offered, 'offer': offer[:200], 'editor before': editor_before, 'line': said, 'asked before allowing': before, 'asked': asked, 'got': got, 'editor': editor}
    attempt('Chora maps: a manifest with no georeference offers "Look for a georeference" and, while Allmaps is not decided, the Editor link saying what it sends; Allmaps is asked nothing until allowed, then at /images/<id> only; the Editor link is still there once it is allowed', lookup)

    def editor_never():
        # Allmaps set to Never: the Editor link is absent from the offer and from every map's row, while the
        # offer itself is still made (the control), and Allmaps is asked nothing.
        # Neither change asks for a reload: Never is refused at once, and allowing again widens nothing, since
        # Allmaps was allowed when this page loaded and so is in its policy (the panel offers a reload only then).
        hits = len(allmaps_hits)
        panel_set([ALLMAPS_KEY], to='never')
        paste(A + '/manifests/grid/manifest')
        offered = soon(page, '() => /no georeference/.test(document.getElementById("chora-map-status")?.innerText || "")', 20)
        editor = page.query_selector('#chora-map-editor, #chora-overlay-list a[data-editor]') is not None
        listed = page.evaluate('() => window.__chora.overlays.length')
        asked = len(allmaps_hits) - hits
        panel_set([ALLMAPS_KEY], to='allowed')                   # put back for the checks after this one
        back = soon(page, '() => !!document.querySelector("#chora-overlay-list a[data-editor]")', 20) if listed else True
        return offered and not editor and asked == 0 and back, {'offered': offered, 'editor shown under Never': editor, 'Allmaps asked': asked, 'back once allowed': back}
    attempt('Chora maps: with Allmaps set to Never the Editor link is absent (the offer is still made, and Allmaps is asked nothing); allowed again, it is back', editor_never)

    def controls():
        s = cstate(page); keys = [o['key'] for o in s['overlays']]
        if not keys: raise RuntimeError('no map shown')
        k = next(o['key'] for o in s['overlays'] if o['annotationId'] == grid_id)
        row = f'#chora-overlay-list li[data-overlay="{k}"]'
        page.fill(f'{row} input[data-opacity]', '40')
        page.uncheck(f'{row} input[data-show]')
        o = page.evaluate('k => { const e = window.__chora_overlays.manager.entries.find((x) => x.key === k); const m = window.__chora_overlays.layer.getMapOptions(e.mapId); return { opacity: m.opacity, visible: m.visible }; }', k)
        page.check(f'{row} input[data-show]')
        # The row's Permissions… opens the panel at the map's server's permission.
        page.click(f'{row} button[data-permissions]')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        at = page.evaluate(PANEL_STATE); page.keyboard.press('Escape')
        others = [x for x in keys if x != k]
        for x in others:
            page.click(f'#chora-overlay-list li[data-overlay="{x}"] button[data-remove-map]')
            until(page, 'x => !window.__chora.overlays.some((o) => o.key === x)', 10, x)
        left = page.evaluate('() => window.__chora_overlays.layer.getMapIds()')
        # The folder read once the page's own writes are on disk: the map kept is written again for each change
        # of its opacity and Show (in turn, each landing on its writable's close), and while a write is open Chrome
        # lists its swap file (<key>.json.crswap) beside the file. Only a map's own file (<key>.json) is a map kept, as kept() reads them.
        written = soon(page, '() => window.__chora.overlayWrites === 0', 20)
        kept_maps = [n for n in opfs_names(page, 'chora-overlays') if re.fullmatch(r'[0-9a-f]{24}\.json', n)]
        return (abs(o['opacity'] - 0.4) < 1e-9 and o['visible'] is False and at['open'] and at['focusKey'] == IA and len(others) >= 3 and len(left) == 1
                and written and kept_maps == [f'{k}.json'] and [x['key'] for x in cstate(page)['overlays']] == [k]), {
            'map options': o, 'panel': at, 'removed': len(others), 'left': left, 'writes on disk': written, 'kept': kept_maps}
    attempt('Chora maps: opacity and show reach the renderer; a map\'s Permissions… opens the panel at its server; a map removed leaves the map, the list and the browser\'s store', controls)

    def trace_save():
        f = tmp / 'chora-files' / 'cambridge.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Traced'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/cambridge', 'label': 'Cambridge', 'attestations': [{'names': [{'toponym': 'Cambridge'}], 'sources': [{'title': 's'}]}]}]}))
        chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        until(page, '() => window.__chora.overlays.length === 1 && window.__chora.overlays[0].firstTile', 30)
        page.click('#chora-overlay-list button[data-fit]'); page.evaluate(SETTLE)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        xy = page.evaluate("""async () => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: [256, 256] }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }""")
        draw(page, 'point', [tuple(xy)]); page.click('#chora-draw-tools button[data-mode="static"]')
        traced = soon(page, '() => window.__chora.lastTrace && window.__chora.lastTrace.key', 15)
        card = page.inner_text('#chora-card'); lt = cstate(page).get('lastTrace') or {}
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'save': ls, 'card': card[-400:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        out = tmp / 'traced.json'; d.value.save_as(out)
        new = json.loads(out.read_text())['spatialEntities'][0]['attestations'][-1]
        cits = new.get('citations', []); fns = [c.get('citationFunction') for c in cits]
        loc = cits[0].get('locator', '') if cits else ''; notes = new.get('notes', ''); geo = (new.get('geometries') or [{}])[0]
        m = re.match(re.escape(A + '/manifests/grid/canvas/c1') + r'#xywh=(\d+),(\d+),(\d+),(\d+)$', loc)
        return (traced and 'Traced from' in card and ls.get('added') == 1 and lt.get('role') == 'RepresentativePoint' and lt.get('precision') == 'approximate'
                and geo.get('role') == 'https://w3id.org/plato#RepresentativePoint' and geo.get('spatialPrecision') == ['approximate']
                and fns == ['http://purl.org/spar/cito/citesAsEvidence', 'http://purl.org/spar/cito/usesMethodIn']
                and cits[0]['source'].get('@id') == A + '/manifests/grid/manifest' and m and int(m[3]) >= 64 and int(m[4]) >= 64
                and cits[1]['source'].get('@id') == grid_id and cits[1]['source'].get('derivedFrom') == A + '/manifests/grid/manifest'
                and notes.startswith(f'Georeferenced through {grid_id} (polynomial order 1, 4 control points)') and 'Traced by hand from a georeferenced historical map' in notes
                and 'retrieval date not recorded' in notes and '@id' not in new), {'citations': cits, 'notes': notes, 'geometry': geo, 'trace': lt, 'save': {k: ls.get(k) for k in ('passed', 'added')}}
    attempt('Chora maps: a point traced from the map is, by default, a representative point, approximate, and is saved citing the map (its canvas, 32 px of context each side) and the georeference, with the fixed notes; Mneme passes', trace_save)

    def moved_off():
        PX = """async (px) => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: px }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }"""
        # A dataset's own file only (drafts.js fileName: 32 hex digits, .json), read once the page's writes of
        # the drawings are on disk: until then the file still holds the drawings as they were (the point traced,
        # with its defaults), and while a write is open Chrome lists its swap file (<name>.json.crswap) beside it,
        # which is gone once the write closes (a read of it then is a NotFoundError).
        KEPT = """async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts');
          for await (const h of d.values()) { if (h.kind !== 'file' || !/^[0-9a-f]{32}\\.json$/.test(h.name)) continue;
            const x = JSON.parse(await (await h.getFile()).text()); if (x.fingerprint.startsWith('cambridge.json')) return x.drafts.map((k) => [!!k.trace, k.role || '', k.precision || '']); } return null; }"""
        page.evaluate(SETTLE)
        x, y = page.evaluate(PX, [200, 200]); n0 = cstate(page)['pendingCount']
        draw(page, 'point', [(x, y)]); page.click('#chora-draw-tools button[data-mode="static"]')
        traced = soon(page, 'n => window.__chora.lastTrace && window.__chora.lastTrace.key && window.__chora.pendingCount === n + 1', 15, n0)
        first = cstate(page).get('lastTrace')
        tx, ty = page.evaluate(PX, [504, 256])                  # on the image, outside the mask (16 to 496)
        page.click('#chora-draw-tools button[data-mode="select"]')
        tap(page, x, y)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move((x + tx) / 2, (y + ty) / 2, steps=6); page.mouse.move(tx, ty, steps=6); page.mouse.up()
        page.click('#chora-draw-tools button[data-mode="static"]')
        dropped = soon(page, '() => window.__chora.lastTrace && !window.__chora.lastTrace.key', 15)
        note = page.inner_text('#chora-card [data-trace-note]') if page.query_selector('#chora-card [data-trace-note]') else ''
        # The drop is kept in the same turn as lastTrace is set (app.js traceDraft, keepDrafts), so draftWrites counts it by now.
        written = dropped and soon(page, '() => window.__chora.draftWrites === 0', 20)
        k = page.evaluate(KEPT)
        # Off the map, it is a point drawn on the basemap: the traced point's defaults go with the citation.
        # (The drawing saved by the check before is still kept: its download was not let go.)
        return (traced and first and first.get('key') and dropped and 'no longer cites that map' in note and written and k and k[-1] == [False, '', '']), {
            'first': first, 'after': cstate(page).get('lastTrace'), 'note': note, 'writes on disk': written, 'kept': k}
    attempt('Chora maps: a traced point moved off its map with the Edit tool no longer cites the map, the card says so, and its traced-point defaults go', moved_off)

    def reshaped_onto_another():
        # Two maps of the same image, each holding one corner (X the top left, Y the bottom right), the
        # whole grid hidden: a point traced from X and moved onto Y is traced from Y, and Y alone is offered.
        def corner(mid, pts):
            a = annotation(id=mid); a['target']['selector'] = {'type': 'SvgSelector', 'value': f'<svg width="512" height="512"><polygon points="{pts}" /></svg>'}; return a
        xid, yid = 'https://annotations.allmaps.org/maps/00000000000000f1', 'https://annotations.allmaps.org/maps/00000000000000f2'
        grid_key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == grid_id)
        page.uncheck(f'#chora-overlay-list li[data-overlay="{grid_key}"] input[data-show]')
        for mid, pts in ((xid, '16,16 250,16 250,250 16,250 16,16'), (yid, '260,260 496,260 496,496 260,496 260,260')):
            paste(corner(mid, pts))
            if not soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 20, mid): return False, {'not shown': mid}
        keys = {o['annotationId']: o['key'] for o in cstate(page)['overlays']}
        page.click(f'#chora-overlay-list li[data-overlay="{grid_key}"] button[data-fit]'); page.evaluate(SETTLE)
        PX = """async (px) => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: px }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }"""
        x, y = page.evaluate(PX, [100, 100]); n0 = cstate(page)['pendingCount']
        draw(page, 'point', [(x, y)]); page.click('#chora-draw-tools button[data-mode="static"]')
        first = soon(page, '([k, n]) => window.__chora.lastTrace && window.__chora.lastTrace.key === k && window.__chora.pendingCount === n + 1', 15, [keys[xid], n0])
        tx, ty = page.evaluate(PX, [400, 400])
        page.click('#chora-draw-tools button[data-mode="select"]')
        tap(page, x, y)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move((x + tx) / 2, (y + ty) / 2, steps=6); page.mouse.move(tx, ty, steps=6); page.mouse.up()
        page.click('#chora-draw-tools button[data-mode="static"]')
        moved = soon(page, 'k => window.__chora.lastTrace && window.__chora.lastTrace.key === k', 15, keys[yid])
        lt = cstate(page).get('lastTrace') or {}
        offered = page.evaluate('() => [...document.querySelectorAll(\'#chora-card li[data-draft]:last-child select[data-field="tracedFrom"] option\')].map((o) => o.value)')
        # Back as the checks after this one expect: the corners gone, the grid shown.
        for mid in (xid, yid):
            page.click(f'#chora-overlay-list li[data-overlay="{keys[mid]}"] button[data-remove-map]')
            until(page, 'k => !window.__chora.overlays.some((o) => o.key === k)', 10, keys[mid])
        page.check(f'#chora-overlay-list li[data-overlay="{grid_key}"] input[data-show]')
        return (first and moved and lt.get('options') == [keys[yid]] and keys[xid] not in offered and keys[yid] in offered), {'first': first, 'moved': moved, 'trace': lt, 'offered': offered}
    attempt('Chora maps: a point traced from one map and moved onto another it alone lies on is traced from that one, which alone is offered', reshaped_onto_another)

    def come_back():
        KEPT_MAPS = '''async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays'); const out = [];
          for await (const h of d.values()) { if (!h.name.endsWith('.json')) continue; const x = JSON.parse(await (await h.getFile()).text()); out.push({ key: x.key, visible: x.visible, opacity: x.opacity }); } return out; }'''
        # (A write still open shows as its swap file, <key>.json.crswap, which is not a map kept.)
        # To begin with: the map shown, and kept as shown, every write of it on disk (the check before this one ticked "Show" last).
        grid_key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == grid_id)
        kept_shown = (soon(page, 'k => window.__chora.overlays.some((o) => o.key === k && o.visible)', 10, grid_key) and soon(page, '() => !(window.__chora.overlayWrites > 0)', 10)
                      and soon(page, f'async (k) => ({KEPT_MAPS})().then((m) => m.some((x) => x.key === k && x.visible === true))', 10, grid_key))
        page.reload(); ready()
        back = shown(grid_id)
        # Said on failure: what is kept of each map (shown or hidden), what the page shows, and where the map is.
        kept_maps = page.evaluate(KEPT_MAPS)
        view = page.evaluate('() => { const m = window.__chora_map; return { zoom: m.getZoom(), center: m.getCenter().toArray() }; }')
        return kept_shown and back and at_origin(census(), B) == [], {'kept as shown before': kept_shown, 'came back': back, 'kept': kept_maps, 'overlays': cstate(page)['overlays'], 'view': view}
    attempt('Chora maps: a map shown comes back on the next load', come_back)

    def tick_and_reload(show):
        """Untick (show False) or tick "Show" and reload at once, while the record's write is still open: every
        close() of a writable is held, so the page goes before its write reaches the disk (a reload within
        milliseconds of the tick). Returns what came back, and that the write was indeed held."""
        KEPT = '''async (k) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays');
          return JSON.parse(await (await (await d.getFileHandle(k + '.json')).getFile()).text()).visible; }'''
        soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 30, grid_id)
        grid_key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == grid_id)
        box = f'#chora-overlay-list li[data-overlay="{grid_key}"] input[data-show]'
        # Each check sets its own starting state (the map hidden for the tick, shown for the untick), kept so on disk.
        # (First the record as the box is, and every write of it done, so that no write from the load still
        # landing follows the change.)
        if page.is_checked(box) == show:
            soon(page, '() => !(window.__chora.overlayWrites > 0)', 10)
            soon(page, f'async ([k, v]) => ({KEPT})(k).then((x) => x === v)', 15, [grid_key, show])
            page.uncheck(box) if show else page.check(box)
        settled = (soon(page, '() => !(window.__chora.overlayWrites > 0)', 10) and page.is_checked(box) == (not show)
                   and soon(page, f'async ([k, v]) => ({KEPT})(k).then((x) => x === v)', 15, [grid_key, not show]))
        page.evaluate('() => { FileSystemWritableFileStream.prototype.close = function () { return new Promise(() => {}); }; }')
        page.check(box) if show else page.uncheck(box)
        held = {'writes in flight': page.evaluate('() => window.__chora.overlayWrites'), 'on disk': page.evaluate(KEPT, grid_key)}
        page.reload(); ready()
        back = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 30, grid_id)
        o = next((x for x in cstate(page)['overlays'] if x['annotationId'] == grid_id), {})
        return {'settled before': settled, 'held': held['on disk'] == (not show) and (held['writes in flight'] or 0) >= 1, 'held detail': held,
                'came back': back, 'visible': o.get('visible'), 'box ticked': page.is_checked(box) if back else None,
                'drawn': shown(grid_id) if show and back else None}
    def hidden_at_once():
        # The other way: a map hidden and the page reloaded at once comes back hidden (so the check below can see one).
        # (The control for the fix itself is the unit test with the note taken away: test/chora-overlays-kept.test.js.)
        r = tick_and_reload(False)
        return r['settled before'] and r['held'] and r['came back'] and r['visible'] is False and r['box ticked'] is False, r
    attempt('Chora maps: a map hidden and the page reloaded at once, before its record is written, comes back hidden (the other way: back hidden)', hidden_at_once)
    def shown_at_once():
        r = tick_and_reload(True)
        if r['came back'] and r['visible'] is not True:   # left as the checks after this one expect: shown
            page.check(f'#chora-overlay-list li[data-overlay="{next(o["key"] for o in cstate(page)["overlays"] if o["annotationId"] == grid_id)}"] input[data-show]')
        return r['settled before'] and r['held'] and r['came back'] and r['visible'] is True and r['box ticked'] is True and r['drawn'], r
    attempt('Chora maps: a map ticked "Show" and the page reloaded at once, before its record is written, comes back shown', shown_at_once)

    def withdraw():
        back = shown(grid_id)
        panel_set([IA], 'undecided')
        gone = soon(page, '() => window.__chora.overlays.length === 0 && window.__chora_overlays.layer.getMapIds().length === 0', 10)
        since = len(census())
        said = line(IA)
        # Nothing more is asked of A while it is withdrawn, the map moved about to want new tiles.
        page.evaluate('() => { const m = window.__chora_map; m.jumpTo({ zoom: m.getZoom() + 1 }); }'); page.evaluate(SETTLE); page.wait_for_timeout(1500)
        quiet = at_origin(census(since), A)
        # The control: allowed again (A is still in this load's policy), the map comes back at once, asked of A.
        panel_set([IA], 'allowed')
        # (Its tiles are in the renderer's cache already, so no first tile is awaited: the map, admitted again.)
        again = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId) && window.__chora_overlays.layer.getMapIds().length > 0', 30, grid_id)
        return (back and gone and f'Needs permission: {urlparse(A).netloc}' in said and quiet == [] and again and at_origin(census(since), A) != [] and opfs_names(page, 'chora-overlays')), {
            'shown first': back, 'taken off': gone, 'line': said, 'asked while withdrawn': quiet, 'back once allowed': again}
    attempt('Chora maps: a map\'s permission withdrawn in the panel takes it off the map at once, asks its server nothing more, and says "Needs permission"; allowed again, it comes back', withdraw)

    def never():
        soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 30, grid_id)
        panel_set([IA], 'never')
        gone = soon(page, '() => window.__chora.overlays.length === 0 && window.__chora_overlays.layer.getMapIds().length === 0', 10)
        page.wait_for_timeout(500)
        silent = page.evaluate('() => [...document.querySelectorAll("#chora-map-needs [data-permission]")].filter((e) => !e.hidden).length') == 0 and page.inner_text('#chora-map-status').strip() == ''
        since = len(census())
        paste(annotation(id='https://annotations.allmaps.org/maps/0000000000000099'))
        said = soon(page, '() => /set to Never in Permissions/.test(document.getElementById("chora-map-status").textContent)', 10)
        page.wait_for_timeout(1000)
        rows = census(since)
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (gone and silent and said and rows == []), {'taken off': gone, 'nothing said of the kept map': silent, 'said of the new one': page.inner_text('#chora-map-status'), 'census': rows}
    attempt('Chora maps: set to Never, a map\'s server is done without: its maps go, nothing is said of them, and a map pasted on it says only that it is set to Never; nothing is asked', never)

    def kept_together():
        # Two maps kept, on two sites neither allowed (A withdrawn; the second is A's port by another name,
        # localhost): one "Needs permission" line for each, together, and one reload brings both back.
        A2 = 'http://localhost:' + A.rsplit(':', 1)[1]
        pid = 'https://annotations.allmaps.org/maps/00000000000000d1'
        item = json.loads(json.dumps(annotation(id=pid)).replace(A, A2))
        entry = {'version': 1, 'key': hashlib.sha256(pid.encode()).hexdigest()[:24], 'item': item, 'manifest': None, 'manifestUrl': None, 'fetchedAt': None,
                 'opacity': 1, 'visible': True, 'added': '2026-10-01T00:00:00.000Z'}
        page.evaluate("""async (e) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays', { create: true });
          const w = await (await d.getFileHandle(e.key + '.json', { create: true })).createWritable(); await w.write(JSON.stringify(e)); await w.close(); }""", entry)
        panel_set([IA], 'undecided')
        page.reload(); ready()
        both_lines = soon(page, 'ks => ks.every((k) => { const e = document.querySelector(`#chora-map-needs [data-permission="${k}"]`); return e && !e.hidden; })', 30, [IA, f'iiif:{A2}'])
        navs = []; listen = lambda fr: navs.append(fr.url) if fr == page.main_frame else None
        page.on('framenavigated', listen)
        if both_lines:
            page.click(f'#chora-map-needs [data-permission="{IA}"] button')
            until(page, '() => document.getElementById("permissions-panel")?.open', 10)
            for k in (IA, f'iiif:{A2}'):
                page.click(f'#permissions-panel fieldset.perm[data-key="{k}"] input[value="allowed"]')
                until(page, 'k => document.querySelector(`#permissions-panel fieldset.perm[data-key="${k}"] input[value="allowed"]`)?.checked', 10, k)
            with page.expect_navigation(timeout=T(60) * 1000): page.click('#permissions-panel [data-reload]')
            ready()
        both = soon(page, 'ids => ids.every((id) => window.__chora.overlays.some((o) => o.annotationId === id))', 40, [grid_id, pid])
        page.wait_for_timeout(1000); page.remove_listener('framenavigated', listen)
        return (both_lines and both and len(navs) == 1 and not page.query_selector('#chora-map-needs [data-permission]:not([hidden])')), {
            'both lines': both_lines, 'both back': both, 'navigations': navs, 'overlays': [o['annotationId'] for o in cstate(page)['overlays']]}
    attempt('Chora maps: maps kept on two sites not allowed say "Needs permission" for both at once, and come back after one reload', kept_together)

    def kept_and_pasted():
        # A map kept waits on A (withdrawn, and reloaded, so A is not in this load's policy). A map pasted on A
        # waits too; A allowed from its line, the maps kept are looked at again (and still wait on A): what
        # they wait on is joined to the map pasted's, never put in its place, so the reload brings back both.
        kid, pid = 'https://annotations.allmaps.org/maps/00000000000000k1', 'https://annotations.allmaps.org/maps/00000000000000p1'
        key = lambda i: hashlib.sha256(i.encode()).hexdigest()[:24]
        entry = {'version': 1, 'key': key(kid), 'item': annotation(id=kid), 'manifest': None, 'manifestUrl': None, 'fetchedAt': None,
                 'opacity': 1, 'visible': True, 'added': '2026-10-01T00:00:02.000Z'}
        page.evaluate("""async (e) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays', { create: true });
          const w = await (await d.getFileHandle(e.key + '.json', { create: true })).createWritable(); await w.write(JSON.stringify(e)); await w.close(); }""", entry)
        panel_set([IA], 'undecided')
        page.reload(); ready()
        # The control: the map kept is there, waiting on A, and not shown; the map pasted is not shown before the reload.
        waiting = soon(page, 'k => window.__chora.mapNeeds?.includes(k)', 30, IA) and not any(o['annotationId'] == kid for o in cstate(page)['overlays'])
        text = json.dumps(annotation(id=pid))
        paste(text)
        # The map pasted is waiting too, before the reload is asked for (the line for A was there already, the map kept's).
        pasted_waits = soon(page, '() => window.__chora.mapPasted === true', 20)
        said = line(IA)
        before = [o['annotationId'] for o in cstate(page)['overlays']]
        if said: panel_set([IA], reload=True, via=IA)
        both = soon(page, 'ids => ids.every((id) => window.__chora.overlays.some((o) => o.annotationId === id))', 40, [kid, pid])
        s = cstate(page); handed = (s.get('resumed') or {}).get('maps') or {}
        # Their files let go once the page's own writes of them are on disk: a write still open would put a file back.
        soon(page, '() => window.__chora.overlayWrites === 0', 20)
        for i in (kid, pid):
            page.evaluate("k => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-overlays')).then((d) => d.removeEntry(k + '.json')).catch(() => {})", key(i))
        return (waiting and pasted_waits and f'Needs permission: {urlparse(A).netloc}' in said and kid not in before and pid not in before and both
                and (handed.get('pending') or {}).get('text') == text and handed.get('readmit') is True), {
            'kept map waiting': waiting, 'pasted map waiting': pasted_waits, 'line': said, 'shown before': before, 'both shown': both, 'handed over': {k: v for k, v in handed.items() if k != 'typed'},
            'overlays': [o['annotationId'] for o in s['overlays']]}
    attempt('Chora maps: a map kept waiting on a withdrawn site and a map pasted on it: allowed from the line, one reload brings back both (the maps kept never take the place of the map pasted)', kept_and_pasted)

    # Only a map's own file, <key>.json, as the page's kept() reads them: while a write is open, Chrome lists its
    # swap file (<key>.json.crswap) instead, holding the whole record. Read as a map kept, a new map's swap file
    # was taken for its file, and the row looked for by that name (<key>.json.crswap) never came.
    KEPT_ITEMS = """async () => { const out = {}; try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays');
      for await (const h of d.values()) if (h.kind === 'file' && /^[0-9a-f]{24}\\.json$/.test(h.name)) out[h.name] = JSON.parse(await (await h.getFile()).text()).item; } catch {} return out; }"""
    WRITTEN = '() => window.__chora.overlayWrites === 0'              # every write of the maps kept is on disk (overlays.js writesPending; a page without the count never holds)
    NO_ID = '() => window.__chora.overlays.find((o) => !o.annotationId && o.mapId)?.key || null'
    def kept_as_written():
        # A map with no georeference id, its image written with a trailing slash (which the image information
        # does not have): kept as written, so that the next load reads, cites and keys the same map, in one file.
        # (The http-to-https difference the unit test checks cannot be made here: this computer's sites stay http.)
        a = annotation(service='/iiif/grid/'); a.pop('id', None)
        until(page, WRITTEN, 20)                                  # the check before this one's writes done, so that its files are in `before`
        before = set(page.evaluate(KEPT_ITEMS))
        paste(a)
        # The keeping is not awaited by the page: it is queued as the map is shown (showMap), so once the map is
        # shown, the page's count of writes not yet on disk includes it; the folder is read once that is 0.
        got = soon(page, f'() => !!({NO_ID})()', 20)
        shown_key = page.evaluate(NO_ID)
        written = got and soon(page, WRITTEN, 20)
        first = {k: v for k, v in page.evaluate(KEPT_ITEMS).items() if k not in before}
        page.reload(); ready()
        back = soon(page, f'() => !!({NO_ID})()', 30) and soon(page, WRITTEN, 20)
        back_key = page.evaluate(NO_ID)
        second = {k: v for k, v in page.evaluate(KEPT_ITEMS).items() if k not in before}
        ids = [v['target']['source']['id'] for v in first.values()]
        # Let the map go (for the checks after this one), from its row once the row is there.
        row = f'#chora-overlay-list li[data-overlay="{back_key}"]'
        removed = False
        if back_key and soon(page, 's => !!document.querySelector(s)', 10, row):
            page.click(f'{row} button[data-remove-map]')
            removed = soon(page, 's => !document.querySelector(s)', 10, row) and soon(page, WRITTEN, 20)
        if not removed and shown_key:                             # no row to remove it from: its file let go directly, so that no later load brings it back
            soon(page, WRITTEN, 20)
            page.evaluate("k => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-overlays')).then((d) => d.removeEntry(k + '.json')).catch(() => {})", shown_key)
        return (got and written and list(first) == [f'{shown_key}.json'] and ids == [A + '/iiif/grid/'] and back and back_key == shown_key and second == first), {
            'shown': got, 'key shown': shown_key, 'kept': ids, 'files before reload': list(first), 'files after': list(second), 'came back': back, 'key back': back_key, 'removed after': removed}
    attempt('Chora maps: a map is kept with its georeference as written (its image\'s id not rewritten), and comes back from the same one file', kept_as_written)

    def kept_server_down():
        # A map kept whose image information cannot be had (the server answers 404): left for the next load,
        # and what is said of the map last pasted stays, at the load and on a change of permission.
        mid = 'https://annotations.allmaps.org/maps/00000000000000g1'
        entry = {'version': 1, 'key': hashlib.sha256(mid.encode()).hexdigest()[:24], 'item': annotation(service='/iiif/missing', id=mid), 'manifest': None, 'manifestUrl': None,
                 'fetchedAt': None, 'opacity': 1, 'visible': True, 'added': '2026-10-01T00:00:01.000Z'}
        page.evaluate("""async (e) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays', { create: true });
          const w = await (await d.getFileHandle(e.key + '.json', { create: true })).createWritable(); await w.write(JSON.stringify(e)); await w.close(); }""", entry)
        page.reload(); ready()
        tried = soon(page, '() => !!window.__chora.keptError', 30)
        at_load = page.inner_text('#chora-map-status').strip()
        paste(annotation())                                       # shown already: its status line
        said = soon(page, '() => /is shown already/.test(document.getElementById("chora-map-status").textContent)', 15)
        panel_set([ALLMAPS_KEY], 'allowed'); page.wait_for_timeout(1500)
        after = page.inner_text('#chora-map-status')
        panel_set([ALLMAPS_KEY], 'undecided')
        page.evaluate("k => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-overlays')).then((d) => d.removeEntry(k + '.json'))", entry['key'])
        return (tried and 'missing' not in at_load and said and 'is shown already' in after), {'kept error': cstate(page).get('keptError'), 'status at load': at_load, 'status after a permission changed': after}
    attempt('Chora maps: a map kept whose server cannot give its image is left quietly: the status of the map last pasted stays, at the load and when a permission changes', kept_server_down)

    def never_after_line():
        # A map pasted says "Needs permission"; set to Never from that line's panel, it says the site is set to Never.
        panel_set([IA], 'undecided')
        since = len(census())
        paste(annotation(id='https://annotations.allmaps.org/maps/00000000000000e1'))
        said = line(IA)
        if said: panel_set([IA], 'never', via=IA)
        told = soon(page, '() => /set to Never in Permissions/.test(document.getElementById("chora-map-status").textContent)', 10)
        lines = page.evaluate('() => [...document.querySelectorAll("#chora-map-needs [data-permission]")].filter((e) => !e.hidden).length')
        rows = at_origin(census(since), A)
        text = page.inner_text('#chora-map-status')
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (f'Needs permission: {urlparse(A).netloc}' in said and told and lines == 0 and rows == []), {'line': said, 'status': text, 'lines left': lines, 'asked of A': rows}
    attempt('Chora maps: a map pasted, waiting on "Needs permission", set to Never in the panel says its site is set to Never, and its line goes', never_after_line)

    def no_policy():
        page_url = base                                         # the page as served: Chora is in it, at #chora
        ctx.route(page_url, strip_head)
        try:
            page.goto('about:blank'); page.goto(NOTOOLS if PROVE else page_url + '#chora')
            until(page, '() => window.__chora && window.__chora.canary && window.__chora.canary !== "pending" && window.__chora.mapReadyCount >= 1', 30)
            since = len(census())
            paste(annotation(id='https://annotations.allmaps.org/maps/0000000000000011'))
            said = soon(page, '() => /cannot be shown in this browser/.test(document.getElementById("chora-map-status").textContent)', 20)
            text = page.inner_text('#chora-map-status'); page.wait_for_timeout(1000)
            rows = census(since); s = cstate(page); meta = page.evaluate('() => !!document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')')
        finally:
            ctx.unroute(page_url, strip_head)
        return (s['canary'] == 'not-enforced' and not meta and said and rows == [] and s['overlays'] == []), {'canary': s['canary'], 'said': text, 'census': rows, 'overlays': s['overlays']}
    attempt('Chora maps: on a page without its policy (the canary finds none), maps are refused in words, those kept included, and their server is asked nothing, though it is allowed', no_policy)
    ink_checks(page, base, tmp, {'census': census, 'at_origin': at_origin, 'annotation': annotation, 'paste': paste, 'line': line, 'panel_set': panel_set,
                                 'shown': shown, 'ready': ready, 'fx': fx})
    attempt('Chora maps: across these checks, origin B was never asked for anything, and no page error', lambda: (len(census()) > 5 and at_origin(census(), B) == [] and not errors, {'census': len(census()), 'B': at_origin(census(), B), 'errors': errors[:5]}))
    ctx.close()
    stop_fixtures()

# ---- Assisted ink tracing, on the same fixture server ---------------------------------------------
# ink.png (test/fixtures/chora-iiif/make-ink.py) served as IIIF tiles: JPEG at /iiif/ink, PNG at
# /iiif/inkpng, its full-resolution tiles refused (403) at /iiif/ink403, and the same from origin C, which
# lets no other site read it. Its features in image pixels, IIIF's corner convention (PIL draws by pixel
# index: half a pixel added to what make-ink.py prints). Every permission is allowed in the panel, from
# the "Needs permission" line, as a user would; the census is the fixture server's own log.
import math
INK_RIVER = [(90 + 8 * k + 0.5, 560 - 300 * math.sin(math.pi * k / 100) * (0.4 + 0.6 * k / 100) + 0.5) for k in range(101)]
INK_WASH = [(x + 0.5, y + 0.5) for x, y in [(420, 90), (610, 120), (650, 260), (560, 330), (430, 300), (380, 180)]]
INK_ROAD = [(120.5, 640.5), (900.5, 610.5)]
def _seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; L = dx * dx + dy * dy
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) if L else 0
    return math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])
def dist_line(p, pts): return min(_seg(p, pts[k], pts[k + 1]) for k in range(len(pts) - 1))
def dense(pts, step=0.5):
    out = []
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]; n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n)]
    return out + [pts[-1]]
def hausdorff(A, B): return max(max(dist_line(p, B) for p in dense(A)), max(dist_line(p, A) for p in dense(B)))

# Image pixels of a map shown (by its annotation's id) to the page's pixels, and back: through the
# page's own georeference module, as the drawing is placed.
INK_TO_SCREEN = """async ([id, pts]) => { const e = window.__chora_overlays.manager.entries.find((x) => x.g.annotationId === id);
  const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'MultiPoint', coordinates: pts }, { space: 'image' })).geojson.coordinates;
  const r = window.__chora_map.getCanvas().getBoundingClientRect(); return w.map((c) => { const p = window.__chora_map.project(c); return [r.left + p.x, r.top + p.y]; }); }"""
INK_TO_IMAGE = """async ([id, geometry]) => { const e = window.__chora_overlays.manager.entries.find((x) => x.g.annotationId === id);
  return (await window.__chora_overlays.georef.toPixels(e.g, geometry, { space: 'image' })).geometry; }"""
PROPOSAL_DRAWN = '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-ink-proposal"] }).length > 0'
TRACE_TIP = '() => [...document.querySelectorAll("#chora-draw-tools button[data-trace]")].map((b) => [b.getAttribute("aria-disabled"), b.disabled, b.dataset.tip, b.hasAttribute("title")])'

def ink_checks(page, base, tmp, h):
    """The checks of tracing with assistance. `h`: the iiif checks' helpers (census, at_origin, annotation,
    paste, line, panel_set, shown, ready, fx). Each check brings the page to the state it needs itself
    (on_map), whatever the checks before it did or failed to do."""
    census, at_origin, annotation, paste, line, panel_set, shown, ready, fx = (h[k] for k in ('census', 'at_origin', 'annotation', 'paste', 'line', 'panel_set', 'shown', 'ready', 'fx'))
    A, B, C = fx['A'], fx['B'], fx['C']
    IA, IC = f'iiif:{A}', f'iiif:{C}'
    ids = {k: f'https://annotations.allmaps.org/maps/00000000000000{k}' for k in ('e1', 'e2', 'e3', 'e4', 'e5')}
    def ink_annotation(path, key, origin=None):
        a = annotation('annotation-ink.json', id=ids[key])
        a['target']['source']['id'] = (origin or A) + path
        return a
    def place_file(name):
        f = tmp / 'chora-files' / name; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Ink'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/cambridge', 'label': 'Cambridge', 'attestations': [{'names': [{'toponym': 'Cambridge'}], 'sources': [{'title': 's'}]}]}]}))
        return f
    def only_map(id_):
        """Every other map shown let go (each check stands on its own), this one fitted and settled."""
        for o in cstate(page)['overlays']:
            if o['annotationId'] != id_:
                page.click(f'#chora-overlay-list li[data-overlay="{o["key"]}"] button[data-remove-map]')
                until(page, 'k => !window.__chora.overlays.some((o) => o.key === k)', 10, o['key'])
        key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == id_)
        page.click(f'#chora-overlay-list li[data-overlay="{key}"] button[data-fit]'); page.evaluate(SETTLE)
        return key
    GRANT = "k => (JSON.parse(localStorage.getItem('plato-tools.permissions') || '{}').grants || {})[k]?.state || 'undecided'"
    def drawn(id_, tiles=True):
        s = cstate(page)
        return bool(s) and any(o['annotationId'] == id_ and (o['firstTile'] or not tiles) for o in s['overlays'])
    def on_map(a, place=True, tiles=True, file=None):
        """Set-up: the map `a` shown (and drawn, its first tile in, unless not `tiles`) and the only one, fitted;
        its server allowed and in this load's policy, as a user does it (pasted, then from its "Needs
        permission" line, one reload) if it is not; Cambridge chosen if `place`. Each step only if the page is
        not so already, so on a page so already it costs a look. `file`: the page is opened afresh on it first,
        if the map is not drawn there now. Raises if the map is not drawn: the check fails at its set-up."""
        if not drawn(a['id'], tiles):
            if file: chora_boot(page, base, [file])
            in_policy = A in (page.evaluate('() => window.__platoCsp') or {}).get('origins', [])
            if page.evaluate(GRANT, IA) != 'allowed' or not in_policy:
                if page.evaluate(GRANT, IA) == 'never': panel_set([IA], 'undecided')   # left so by a check that failed: no line is shown for Never
                paste(a)
                said = line(IA)
                if 'Needs permission' in said: panel_set([IA], reload=True, via=IA)
                elif said:                                       # allowed since this page loaded: the line offers the reload
                    with page.expect_navigation(timeout=T(60) * 1000): page.click(f'#chora-map-needs [data-permission="{IA}"] button')
                    ready()
                else: raise RuntimeError(f'set-up: the map\'s server is not allowed ({page.evaluate(GRANT, IA)}, in the policy: {in_policy}), and no line asks for it')
            elif not drawn(a['id'], False): paste(a)
            ok = shown(a['id'], 40) if tiles else soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 30, a['id'])
            if not ok: raise RuntimeError('the map did not draw' if tiles else 'the map was not added')
        if place and cstate(page)['phase'] != 'place': chora_pick(page, 'cambridge')
        return only_map(a['id'])
    def click_image(id_, px, modifiers=None):
        [[x, y]] = page.evaluate(INK_TO_SCREEN, [id_, [list(px)]])
        page.mouse.move(x - 2, y - 2); page.mouse.move(x, y)
        if modifiers: page.keyboard.down(modifiers)
        page.mouse.down(); page.mouse.up()
        if modifiers: page.keyboard.up(modifiers)
        return x, y
    def no_maps_kept():
        """The maps kept let go, from the page with Chora not opened: Chora, mounted, brings its maps kept
        back as it starts, and keeps one again once shown, so while it runs it can write what is removed here
        (on the deployed site the map kept_together kept, on localhost, came back that way). Then it is read
        that none is kept."""
        page.goto(base)
        left = page.evaluate("""() => navigator.storage.getDirectory().then(async (r) => { await r.removeEntry('chora-overlays', { recursive: true }).catch(() => {});
          return r.getDirectoryHandle('chora-overlays').then(() => true, () => false); })""")
        if left: raise RuntimeError('set-up: the maps kept could not be let go')

    def trace_line_save():
        # No map kept, and the map's server not allowed: the tools are there, not offered, and say why in a tooltip.
        chora_boot(page, base)
        if page.evaluate(GRANT, IA) != 'undecided': panel_set([IA], 'undecided')     # allowed by the maps' checks (or Never, left by one that failed)
        no_maps_kept()
        f = place_file('ink-line.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        buttons = page.evaluate(TRACE_TIP)
        # What the page started with, said first if the check fails: the maps shown and the server's permission.
        start = {'grant': page.evaluate(GRANT, IA), 'shown': [(o['annotationId'][-4:], o['permission'].replace(A, 'A'), o['firstTile']) for o in cstate(page)['overlays']]}
        page.mouse.move(1, 1); page.hover('#chora-draw-tools button[data-trace="line"]')
        tip_before = [t['text'] for t in shown_tips(page, 'Show a historical map to trace from it')]
        waiting = (cstate(page).get('traceReady') is False and all(b[0] == 'true' and b[1] is False and not b[3] for b in buttons) and tip_before == ['Show a historical map to trace from it'])
        # Clicked while not offered, it does nothing. A plain page.click would wait for ever: Playwright (1.59)
        # counts a button with aria-disabled="true" as disabled, so force=True clicks it where it is, as a user does.
        page.click('#chora-draw-tools button[data-trace="line"]', force=True); page.wait_for_timeout(300)
        inert = page.get_attribute('#chora-draw-tools button[data-trace="line"]', 'aria-pressed') != 'true' and not page.evaluate('() => !!window.__chora_ink?.mode')
        since = len(census())
        a = ink_annotation('/iiif/inkpng', 'e1'); paste(a)
        said = line(IA)
        page.wait_for_timeout(800); early = [r['path'] for r in census(since)]
        if said: panel_set([IA], reload=True, via=IA)
        if cstate(page)['phase'] != 'place': chora_pick(page, 'cambridge')
        if not soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 40, a['id']): raise RuntimeError('the map did not draw')
        only_map(a['id'])
        buttons_after = page.evaluate(TRACE_TIP)
        offered = cstate(page).get('traceReady') is True and all(b[0] == 'false' for b in buttons_after) and 'followed both ways' in buttons_after[1][2]
        before = cstate(page)['pendingCount']
        page.click('#chora-draw-tools button[data-trace="line"]')
        click_image(a['id'], INK_RIVER[50])
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        ink = cstate(page)['ink']
        if ink['phase'] != 'proposed': return False, {'start': start, 'ink': ink}
        drawn = soon(page, PROPOSAL_DRAWN, 10)
        proposed = [tuple(p) for p in ink['last']['image']['coordinates']]
        hd = hausdorff(proposed, INK_RIVER)
        ends = sorted([proposed[0], proposed[-1]])
        # Shift-click carries the line on: here, onto the road (the line proposed then holds both).
        n = ink['proposals']
        road_y = lambda x: INK_ROAD[0][1] + (INK_ROAD[1][1] - INK_ROAD[0][1]) * (x - INK_ROAD[0][0]) / (INK_ROAD[1][0] - INK_ROAD[0][0])
        click_image(a['id'], (700, road_y(700)), 'Shift')
        until(page, 'n => window.__chora.ink.proposals > n && window.__chora.ink.phase === "proposed"', 60, n)
        joined = [tuple(p) for p in cstate(page)['ink']['last']['image']['coordinates']]
        carried = cstate(page)['ink']['last']['extended'] and any(dist_line(p, INK_ROAD) <= 1.5 for p in joined) and sum(dist_line(p, INK_RIVER) <= 1.5 for p in joined) >= len(proposed) - 2
        # Carried on, only the new click is traced: the river already proposed is kept as it was.
        traced_again = cstate(page)['ink']['last'].get('seedsTraced')
        page.keyboard.press('Enter')
        until(page, 'n => window.__chora.pendingCount === n + 1 && window.__chora.lastTrace && window.__chora.lastTrace.key', 20, before)
        card = page.inner_text('#chora-card')
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'start': start, 'save': ls, 'card': card[-300:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        out = tmp / 'ink-line-saved.json'; d.value.save_as(out)
        new = json.loads(out.read_text())['spatialEntities'][0]['attestations'][-1]
        cits = new.get('citations', []); notes = new.get('notes', '')
        rows = census(since); paths = [r['path'] for r in at_origin(rows, A)]
        return (waiting and inert and f'Needs permission: {urlparse(A).netloc}' in said and early == [] and offered and drawn and carried and traced_again == 1 and hd <= 2
                and math.hypot(ends[0][0] - INK_RIVER[0][0], ends[0][1] - INK_RIVER[0][1]) <= 4
                and math.hypot(ends[1][0] - INK_RIVER[-1][0], ends[1][1] - INK_RIVER[-1][1]) <= 4 and 'Traced with assistance from' in card
                and ls.get('added') == 1 and [c.get('citationFunction') for c in cits] == ['http://purl.org/spar/cito/citesAsEvidence', 'http://purl.org/spar/cito/usesMethodIn']
                and cits[0]['source'].get('@id') == A + '/iiif/inkpng' and cits[1]['source'].get('@id') == a['id']
                and notes.startswith(f'Georeferenced through {a["id"]}') and ' Traced with assistance in PLATO tools (Chora)' in notes and 'by following a line' in notes
                and notes.endswith('then accepted as proposed.') and new['geometries'][0]['geojson']['type'] == 'LineString'
                and any(p.startswith('/iiif/inkpng/') and p.endswith('default.jpg') for p in paths) and at_origin(rows, B) == [] and at_origin(rows, C) == []
                and len(rows) == len(at_origin(rows, A))), {
            'start': start, 'buttons before a map': buttons, 'tooltip before': tip_before, 'inert': inert, 'line': said, 'asked before allowing': early, 'buttons after': buttons_after,
            'hausdorff px': round(hd, 2), 'ends': ends, 'notes': notes[:220], 'citations': [c.get('citationFunction') for c in cits],
            'carried on': carried, 'clicks traced when carried on': traced_again, 'census': sorted({(r['port'], r['path'].split('/')[2] if r['path'].count('/') > 2 else r['path']) for r in rows}), 'ink': {k: ink['last'].get(k) for k in ('scale', 'grown', 'vertices', 'gaps')}}
    attempt('Chora ink: "Trace line" is not offered before a map is drawn, and says why in its tooltip (aria-disabled, no title); the map\'s server asked nothing until allowed in the panel; a click proposes the river (within 2 px, end to end) from that server\'s tiles alone; Shift-click carries it on (tracing the new click alone); Enter makes it a drawing; saved, it cites the map and the georeference, says it was traced with assistance and accepted as proposed, and Mneme passes', trace_line_save)

    def trace_area_esc():
        f = place_file('ink-area.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        since = len(census())
        a = ink_annotation('/iiif/ink', 'e2')
        on_map(a)
        before = cstate(page)['pendingCount']
        page.click('#chora-draw-tools button[data-trace="area"]')
        click_image(a['id'], (520, 210))
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        ink = cstate(page)['ink']
        if ink['phase'] != 'proposed': return False, {'ink': ink}
        ring = [tuple(p) for p in ink['last']['image']['coordinates'][0]]
        hd = hausdorff(ring, INK_WASH + [INK_WASH[0]])
        drawn = soon(page, PROPOSAL_DRAWN, 10)
        # A slider moved proposes again from the window already read: the server is asked for nothing more.
        n, asked_before = ink['proposals'], len(census())
        page.fill('#chora-ink-panel input[data-p="tolerance"]', '22')
        rerun = soon(page, 'n => window.__chora.ink.proposals > n && window.__chora.ink.phase === "proposed"', 20, n)
        page.wait_for_timeout(300)
        quiet = census(asked_before) == []
        page.keyboard.press('Escape')
        gone = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-ink-proposal"] }).length === 0', 10)
        page.wait_for_timeout(500)
        after = cstate(page)
        rows = census(since)
        return (drawn and rerun and quiet and hd <= 2.5 and gone and after['pendingCount'] == before and after['ink']['phase'] == 'idle' and at_origin(rows, B) == []
                and any(r['path'].startswith('/iiif/ink/') and r['path'].endswith('default.jpg') for r in at_origin(rows, A))), {'hausdorff px': round(hd, 2), 'drawn': drawn, 'slider re-run': rerun, 'asked after the slider': census(asked_before)[:3], 'gone': gone, 'pending': [before, after['pendingCount']], 'ink': after['ink'].get('phase')}
    attempt('Chora ink: "Trace area" proposes the wash (within 2.5 px) from JPEG tiles; a slider moved proposes again asking the server nothing; Esc lets it go, and nothing is drawn', trace_area_esc)

    def withdrawn_lets_go():
        # A map traced: its tiles are kept by the page. Withdrawn in the panel, every tile read from that server
        # is let go at once, with the proposal made from them; allowed again, it is kept. The map of the check
        # before, if it is shown still (it costs nothing to trace it again), else a page opened afresh on it.
        a = ink_annotation('/iiif/ink', 'e2'); a_id = a['id']
        on_map(a, place=False, file=place_file('ink-withdrawn.json'))
        page.click('#chora-draw-tools button[data-trace="area"]') if page.get_attribute('#chora-draw-tools button[data-trace="area"]', 'aria-pressed') != 'true' else None
        n = (cstate(page).get('ink') or {}).get('proposals', 0)
        click_image(a_id, (520, 210))
        until(page, 'n => !!window.__chora.ink && window.__chora.ink.proposals > n && window.__chora.ink.phase === "proposed"', 60, n)
        cached = page.evaluate('() => window.__chora_ink.cachedTiles'); let_go = cstate(page)['ink'].get('letGo') or 0
        # The worker's own tiles, asked of the worker itself (a 'count' message): some, before (the presence).
        in_worker = page.evaluate('() => window.__chora_ink.workerTiles()')
        drawn = soon(page, PROPOSAL_DRAWN, 10)
        panel_set([IA], 'undecided')
        emptied = soon(page, 'n => window.__chora_ink.cachedTiles === 0 && (window.__chora.ink.letGo || 0) > n', 10, let_go)
        s = cstate(page); after = page.evaluate('() => window.__chora_ink.cachedTiles')
        # The forget is a message to the worker: asked after it (messages are taken in order), it holds none.
        in_worker_after = page.evaluate('() => window.__chora_ink.workerTiles()')
        gone = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-ink-proposal"] }).length === 0', 10)
        buttons = page.evaluate(TRACE_TIP)
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (cached > 0 and in_worker > 0 and drawn and emptied and after == 0 and in_worker_after == 0 and gone and s['ink']['phase'] == 'idle' and s.get('traceReady') is False and all(b[0] == 'true' for b in buttons)), {
            'tiles kept before': cached, 'after': after, 'worker tiles before': in_worker, 'worker tiles after': in_worker_after, 'let go': s['ink'].get('letGo'), 'ink': s['ink'].get('phase'), 'proposal gone': gone, 'buttons': buttons}
    attempt('Chora ink: a map\'s server withdrawn in the panel lets go at once of every tile read from it for tracing (there were some, on the page and in the worker), here and in the worker, and of the proposal made from them; the trace tools are no longer offered', withdrawn_lets_go)

    def click_before_ink_arrives():
        # ink.js is loaded by the first press of a trace tool. On a slow connection a user who presses "Trace
        # area" and clicks the map at once clicks before it has arrived: the click waits for it, and is not lost.
        # Here the chunk is held by a route until the click has landed, then let through. (After the withdrawn
        # check; the check after this one opens the page afresh.) A page opened afresh, so ink.js is not loaded yet.
        f = place_file('ink-held.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        a = ink_annotation('/iiif/ink', 'e3')
        on_map(a)
        held = []
        ink_chunk = re.compile(r'/assets/ink-[^/?]*\.js')
        page.route(ink_chunk, lambda r: held.append(r))
        try:
            page.click('#chora-draw-tools button[data-trace="area"]')
            soon(page, '() => document.querySelector(\'#chora-draw-tools button[data-trace="area"]\').getAttribute("aria-pressed") === "true"', 5)
            click_image(a['id'], (520, 210))
            page.wait_for_timeout(500)
            before = cstate(page)
            # The presence: the chunk was asked for and is held, and so nothing has been proposed yet.
            not_yet = len(held) == 1 and before.get('ink') is None and not page.evaluate('() => !!window.__chora_ink')
        finally:
            for r in held: r.continue_()
            page.unroute(ink_chunk)
        proposed = soon(page, '() => window.__chora.ink?.phase === "proposed" && window.__chora.ink.proposals === 1', 60)
        ink = (cstate(page).get('ink') or {})
        drawn = proposed and soon(page, PROPOSAL_DRAWN, 10)
        page.keyboard.press('Escape')
        return (not_yet and proposed and drawn and ink.get('mode') == 'area'), {'held': len(held), 'before the chunk': {'ink': before.get('ink'), 'pressed': page.get_attribute('#chora-draw-tools button[data-trace="area"]', 'aria-pressed')}, 'proposed': proposed, 'drawn': drawn, 'ink': {k: ink.get(k) for k in ('phase', 'mode', 'proposals', 'lastError')}}
    attempt('Chora ink: a click on the map made while ink.js is still arriving, after the first press of "Trace area", is not lost: once it has arrived, the proposal is made from that click', click_before_ink_arrives)

    def keys_are_the_controls():
        # With a proposal live, Enter on a focused control is the control's (Save saves; nothing accepted), and
        # Esc in the permissions dialog closes the dialog (the proposal kept). The controls: Enter with nothing
        # focused accepts, and Esc with nothing focused lets go, so the keys do reach the proposal.
        f = place_file('ink-keys.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        a = ink_annotation('/iiif/ink', 'e2')
        on_map(a)
        blur = '() => document.activeElement && document.activeElement.blur()'
        def propose():
            # The page was opened afresh: ink.js, and the ink state with it, is loaded by the first Trace click.
            n = (cstate(page).get('ink') or {}).get('proposals', 0)
            if page.get_attribute('#chora-draw-tools button[data-trace="area"]', 'aria-pressed') != 'true': page.click('#chora-draw-tools button[data-trace="area"]')
            click_image(a['id'], (520, 210))
            until(page, 'n => !!window.__chora.ink && window.__chora.ink.proposals > n && window.__chora.ink.phase === "proposed"', 60, n)
        # Enter with nothing focused accepts (the positive control; it also makes a drawing, so Save can be used).
        propose()
        acc0 = cstate(page)['ink']['accepted']; page.evaluate(blur); page.keyboard.press('Enter')
        accepted = soon(page, 'n => window.__chora.ink.accepted === n + 1', 10, acc0)
        # Enter on Save, a proposal live: Save saves, and the proposal is not accepted.
        propose()
        acc1 = cstate(page)['ink']['accepted']
        page.focus('#chora-save'); page.keyboard.press('Enter')
        saved = soon(page, '() => !!window.__chora.lastSave || window.__chora.phase === "saving"', 60)
        page.wait_for_timeout(300)
        s1 = cstate(page)
        # Counted by the ink itself (a save may change the drawings pending, so they are not counted here).
        not_accepted = s1['ink']['accepted'] == acc1 and s1['ink']['phase'] == 'proposed'
        # Esc in the permissions dialog closes it, and the proposal is kept.
        page.click('#permissions-button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.keyboard.press('Escape')
        closed = soon(page, '() => !document.getElementById("permissions-panel").open', 5)
        kept = cstate(page)['ink']['phase'] == 'proposed' and soon(page, PROPOSAL_DRAWN, 5)
        # Esc with nothing focused lets it go (the control).
        page.evaluate(blur); page.keyboard.press('Escape')
        let_go = soon(page, '() => window.__chora.ink.phase === "idle"', 5)
        return (accepted and saved and not_accepted and closed and kept and let_go), {
            'enter accepts (control)': accepted, 'save ran': saved, 'not accepted on Save': not_accepted, 'ink after Save': s1['ink'].get('phase'),
            'dialog closed by Esc': closed, 'proposal kept': kept, 'esc lets go (control)': let_go}
    attempt('Chora ink: with a proposal live, Enter on Save saves and accepts nothing, and Esc in the permissions dialog closes it and keeps the proposal; with nothing focused, Enter accepts and Esc lets go', keys_are_the_controls)

    def trace_area_hole_save():
        f = place_file('ink-hole.json'); chora_boot(page, base, [f])
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        a = ink_annotation('/iiif/inkpng', 'e5')
        on_map(a, place=False)                                   # no place chosen: that is what is checked first
        before = cstate(page)['pendingCount']
        page.click('#chora-draw-tools button[data-trace="area"]')
        click_image(a['id'], (520, 210))
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        ink = cstate(page)['ink']
        if ink['phase'] != 'proposed': return False, {'ink': ink}
        holes = ink['last']['holes']
        # No place chosen yet: Enter keeps the proposal and says to choose a place; nothing is drawn.
        page.evaluate('() => document.activeElement && document.activeElement.blur()')
        page.keyboard.press('Enter'); page.wait_for_timeout(500)
        s0 = cstate(page); status0 = page.inner_text('#chora-ink-panel [data-ink-status]')
        kept_ = s0['ink']['phase'] == 'proposed' and s0['pendingCount'] == before and soon(page, PROPOSAL_DRAWN, 10)
        chora_pick(page, 'cambridge')
        page.evaluate('() => document.activeElement && document.activeElement.blur()')
        page.keyboard.press('Enter')
        until(page, 'n => window.__chora.pendingCount === n + 1 && window.__chora.lastTrace && window.__chora.lastTrace.key', 20, before)
        lt = cstate(page)['lastTrace']; card = page.inner_text('#chora-card')
        page.click('#chora-save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'save': ls, 'card': card[-300:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#chora-save-result button.primary')
        out = tmp / 'ink-hole-saved.json'; d.value.save_as(out)
        new = json.loads(out.read_text())['spatialEntities'][0]['attestations'][-1]
        cits = new.get('citations', []); notes = new.get('notes', ''); geom = new['geometries'][0]['geojson']
        return (holes == 1 and kept_ and 'Choose a place first' in status0
                and 'hole was left out' in (lt.get('note') or '') and 'hole was left out' in card
                and ls.get('added') == 1 and geom['type'] == 'Polygon' and len(geom['coordinates']) == 1
                and [c.get('citationFunction') for c in cits] == ['http://purl.org/spar/cito/citesAsEvidence', 'http://purl.org/spar/cito/usesMethodIn']
                and cits[0]['source'].get('@id') == A + '/iiif/inkpng' and cits[1]['source'].get('@id') == a['id']
                and notes.startswith(f'Georeferenced through {a["id"]}') and ' Traced with assistance in PLATO tools (Chora)' in notes and 'by filling an area' in notes
                and notes.endswith('; its 1 hole left out, as drawings are outlines; then accepted as proposed.')), {
            'holes proposed': holes, 'kept with no place': kept_, 'said': status0[:120], 'card note': lt.get('note'), 'notes': notes[:400], 'rings saved': len(geom['coordinates']),
            'citations': [c.get('citationFunction') for c in cits], 'mneme': ls.get('passed')}
    attempt('Chora ink: an area with a hole, accepted with Enter before a place is chosen, is kept as proposed and the page says to choose a place; chosen, Enter makes it a drawing (an outline, its hole left out and said so on its card); saved, it cites the map and the georeference, its notes say the hole was left out, and Mneme passes', trace_area_hole_save)

    def snap_to_ink():
        f = place_file('ink-snap.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        a = ink_annotation('/iiif/inkpng', 'e1')
        on_map(a)
        page.click('#chora-draw-tools button[data-mode="linestring"]')
        offered = page.is_visible('#chora-snap-ink')
        page.mouse.move(1, 1); page.hover('#chora-snap-ink')
        tip = [t['text'] for t in shown_tips(page, 'goes onto it')]
        page.check('#chora-snap-ink')
        until(page, '() => window.__chora.ink && window.__chora.ink.snapBuilds >= 1 && window.__chora.ink.snapPoints > 0', 30)
        # 5 screen pixels above the road at image x 300, then a second vertex, then the last again to finish.
        road_y = lambda x: INK_ROAD[0][1] + (INK_ROAD[1][1] - INK_ROAD[0][1]) * (x - INK_ROAD[0][0]) / (INK_ROAD[1][0] - INK_ROAD[0][0])
        [[x, y], [x2, y2]] = page.evaluate(INK_TO_SCREEN, [a['id'], [[300, road_y(300)], [600, 420]]])
        before = cstate(page)['pendingCount']
        for (px, py) in [(x, y - 5), (x2, y2), (x2, y2)]: tap(page, px, py)
        until(page, 'n => window.__chora.pendingCount === n + 1', 15, before)
        # The drawing is kept on the private file system a moment after it is counted: read until it is there.
        def lines_kept(n):
            ls = []
            for _ in range(int(T(10) * 4)):
                ls = [k for k in kept(page, f.name) if k['geojson']['type'] == 'LineString']
                if len(ls) >= n: return ls
                page.wait_for_timeout(250)
            raise RuntimeError(f'{n} line(s) drawn, {len(ls)} kept after {T(10)} s')
        d = lines_kept(1)[-1]
        img = page.evaluate(INK_TO_IMAGE, [a['id'], d['geojson']])
        first = img['coordinates'][0]; snapped = dist_line(first, INK_ROAD)
        # The control: the same, with Alt held, is not snapped.
        page.click('#chora-draw-tools button[data-mode="linestring"]')
        page.keyboard.down('Alt'); tap(page, x, y - 5); page.keyboard.up('Alt')
        for (px, py) in [(x2 + 40, y2), (x2 + 40, y2)]: tap(page, px, py)
        until(page, 'n => window.__chora.pendingCount === n + 2', 15, before)
        d2 = lines_kept(2)[-1]
        free = dist_line(page.evaluate(INK_TO_IMAGE, [a['id'], d2['geojson']])['coordinates'][0], INK_ROAD)
        per = page.evaluate("""async ([id, x, y]) => { const e = window.__chora_overlays.manager.entries.find((v) => v.g.annotationId === id); const m = window.__chora_map, r = m.getCanvas().getBoundingClientRect();
          const a = (await window.__chora_overlays.georef.toPixels(e.g, { type: 'Point', coordinates: m.unproject([x - r.left, y - r.top]).toArray() }, { space: 'image' })).geometry.coordinates;
          const b = (await window.__chora_overlays.georef.toPixels(e.g, { type: 'Point', coordinates: m.unproject([x - r.left, y - r.top + 10]).toArray() }, { space: 'image' })).geometry.coordinates;
          return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10; }""", [a['id'], x, y])
        return (offered and len(tip) == 1 and 'hold Alt not to' in tip[0] and snapped <= max(0.5, 0.5 * per) and free > 2 * per), {
            'tooltip': tip, 'snapped px': round(snapped, 3), 'unsnapped (Alt) px': round(free, 3), 'image px per screen px': round(per, 3), 'snap points': cstate(page)['ink']['snapPoints']}
    attempt('Chora ink: "Snap to ink" says what it does in its tooltip, and puts a vertex drawn by hand 5 px from the road onto its centre (to half a pixel of the image read); with Alt held it is not snapped', snap_to_ink)

    def snap_withdrawn_while_building():
        # A permission withdrawn while a site's FIRST snapping is being built: the build is let go, and nothing
        # read for it is kept (no snapping, no tile on the page or in the worker). The tiles it asks for are held
        # at the network until the permission is withdrawn: that they were asked for is the presence.
        f = place_file('ink-snap-wd.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        a = ink_annotation('/iiif/inkpng', 'e1')
        on_map(a)
        held = []
        # The map's own tiles are drawn by MapLibre (already drawn, settled): the snap's are the requests now.
        pattern = A + '/iiif/inkpng/**'
        page.route(pattern, lambda r: held.append(r))
        try:
            page.click('#chora-draw-tools button[data-mode="linestring"]')
            builds = (cstate(page).get('ink') or {}).get('snapBuilds', 0)
            page.check('#chora-snap-ink')
            for _ in range(int(T(8) * 10)):
                if held: break
                page.wait_for_timeout(100)
            asked = len(held)
            panel_set([IA], 'undecided')
            for r in held:
                try: r.continue_()
                except Exception: pass
        finally:
            page.unroute(pattern)
        page.wait_for_timeout(1500)
        s = cstate(page)['ink']
        tiles_page = page.evaluate('() => window.__chora_ink.cachedTiles')
        tiles_worker = page.evaluate('() => window.__chora_ink.workerTiles()')
        entry = page.evaluate('() => !!window.__chora_ink.snapEntry')
        snapped = page.evaluate('() => { const c = window.__chora_map.getCanvas(); return window.__chora_ink.snapAt(c.clientWidth / 2, c.clientHeight / 2) || null; }')
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (asked > 0 and s.get('snapBuilds', 0) == builds and s.get('snapPoints') == 0 and not entry and snapped is None
                and tiles_page == 0 and tiles_worker == 0 and (s.get('letGo') or 0) > 0), {
            'tiles asked for while building': asked, 'builds': [builds, s.get('snapBuilds')], 'snap points': s.get('snapPoints'), 'entry kept': entry,
            'snapped at the centre': snapped, 'page tiles': tiles_page, 'worker tiles': tiles_worker, 'let go': s.get('letGo'), 'snap error': s.get('snapError')}
    attempt('Chora ink: a map\'s server withdrawn while its first snapping is being built lets the build go: no snapping is made, and no tile read for it is kept on the page or in the worker', snap_withdrawn_while_building)

    def snap_not_rebuilt_while_hidden():
        # Snapping is built again as the map moves only while a line or an area is drawn by hand. The control:
        # moved while drawing a line, it is built again.
        f = place_file('ink-snap-hidden.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        a = ink_annotation('/iiif/inkpng', 'e1')
        on_map(a)
        page.click('#chora-draw-tools button[data-mode="linestring"]'); page.check('#chora-snap-ink')
        until(page, '() => window.__chora.ink && window.__chora.ink.snapBuilds >= 1 && window.__chora.ink.snapPoints > 0', 30)
        pan = '([dx]) => window.__chora_map.panBy([dx, 0], { duration: 0 })'
        n0 = cstate(page)['ink']['snapBuilds']
        page.evaluate(pan, [40]); page.evaluate(SETTLE)
        rebuilt = soon(page, 'n => window.__chora.ink.snapBuilds > n', 15, n0)
        page.click('#chora-draw-tools button[data-mode="point"]')
        hidden = page.is_hidden('#chora-snap-ink-label')
        n1 = cstate(page)['ink']['snapBuilds']
        page.evaluate(pan, [-40]); page.evaluate(SETTLE); page.wait_for_timeout(1000)
        quiet = cstate(page)['ink']['snapBuilds'] == n1
        return (rebuilt and hidden and quiet), {'rebuilt while drawing a line (control)': rebuilt, 'offered while drawing a point': not hidden, 'builds while hidden': [n1, cstate(page)['ink']['snapBuilds']]}
    attempt('Chora ink: snapping is built again as the map moves while a line is drawn by hand, and not while it is not offered (drawing a point)', snap_not_rebuilt_while_hidden)

    def cors_refused():
        f = place_file('ink-cors.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        since = len(census()); before = cstate(page)['pendingCount']
        a = ink_annotation('/iiif/ink', 'e3', origin=C)
        paste(a)
        said = line(IC)
        page.wait_for_timeout(800); early = at_origin(census(since), C)
        if said: panel_set([IC], reload=True, via=IC)
        refused = soon(page, '() => /may not allow other sites to read it/.test(document.getElementById("chora-map-status").textContent)', 30)
        text = page.inner_text('#chora-map-status')
        rows = census(since); s = cstate(page)
        return (f'Needs permission: {urlparse(C).netloc}' in said and early == [] and refused and urlparse(C).netloc in text and at_origin(rows, C)
                and all(r['path'] == '/iiif/ink/info.json' for r in at_origin(rows, C))
                and not any(o['annotationId'] == a['id'] for o in s['overlays']) and s['pendingCount'] == before), {
            'line': said, 'asked before allowing': early, 'said': text[:300], 'C asked': [(r['status'], r['path']) for r in at_origin(rows, C)], 'pending': s['pendingCount']}
    attempt('Chora ink: a map on a server that lets no other site read it (no CORS header), once allowed, is refused in words, after asking it only for its image information; nothing is drawn', cors_refused)

    def refused_403():
        f = place_file('ink-403.json'); chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        since = len(census()); before = cstate(page)['pendingCount']
        a = ink_annotation('/iiif/ink403', 'e4')
        on_map(a, tiles=False)                                   # added, not drawn: its full-resolution tiles are refused
        # Drawn from its coarser tiles (zoomed out), then traced close up, at full resolution, which is refused.
        page.evaluate('() => window.__chora_map.zoomTo(window.__chora_map.getZoom() - 2, { duration: 0 })'); page.evaluate(SETTLE)
        if not soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 30, a['id']):
            return False, {'not drawn; asked': [(r['status'], r['path']) for r in at_origin(census(since), A)][-6:], 'events': cstate(page).get('overlayEvents')}
        page.evaluate('() => window.__chora_map.zoomTo(window.__chora_map.getZoom() + 3, { duration: 0 })'); page.evaluate(SETTLE)
        page.click('#chora-draw-tools button[data-trace="line"]')
        click_image(a['id'], INK_RIVER[50])
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        s = cstate(page); panel = page.inner_text('#chora-ink-panel')
        page.keyboard.press('Enter'); page.wait_for_timeout(500)
        rows = census(since)
        return (s['ink']['phase'] == 'error' and '403' in (s['ink']['lastError'] or '') and 'IIIF Auth' in s['ink']['lastError'] and '403' in panel
                and cstate(page)['pendingCount'] == before and any(r['status'] == 403 for r in at_origin(rows, A)) and at_origin(rows, B) == []), {
            'ink': s['ink'].get('lastError'), 'panel': panel[:200], 'statuses': sorted({r['status'] for r in at_origin(rows, A)})}
    attempt('Chora ink: a server that refuses the map\'s pixels (403) is said so in words (IIIF Auth is not supported), and nothing is drawn', refused_403)

if __name__ == '__main__': main()
