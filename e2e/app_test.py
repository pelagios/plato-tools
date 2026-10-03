"""Browser tests of the page itself, in Playwright's bundled Chromium with an on-disk profile.

    python3 e2e/app_test.py                 run every check against the built site
    python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   the deployed site
    python3 e2e/app_test.py --prove-it-fails run every check against a page with no tools on it;
                                            every check must fail, or the harness cannot fail
    --no-gl-flags   start Chora's browser without the software-GL switches, to measure whether the map
                    still draws without them (it did on this machine, Chromium 147, September 2026)
"""
import csv, json, os, pathlib, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request, zipfile
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
    page.evaluate(f"() => {{ document.getElementById('base').value = {json.dumps(base)}; }}")
    r = reading_run(page)
    page.evaluate("() => { document.getElementById('base').value = ''; }")
    doc = reading_doc(page, r, tmp, 'within.json')
    text = json.dumps(doc)
    mill = next((p for p in doc.get('spatialEntities', []) if p['@id'] == base + 'place/1'), {})
    contained = sorted((a['sequence'], a['relations'][0]['relatedLabel']) for a in mill.get('attestations', []) if a.get('relations'))
    region_labels = sorted(p['label'] for p in doc.get('spatialEntities', []) if '/place/region-' in p['@id'])
    check('column table: converted under a base address, the place is ContainedIn each region at its level, each region minted once; no "within" key is written',
          r.get('phase') == 'done' and contained == [(1, 'Rotherhithe'), (2, 'Surrey'), (3, 'England')] and region_labels == ['England', 'Rotherhithe', 'Surrey']
          and '"within"' not in text and 'https://w3id.org/plato#ContainedIn' in text, {'phase': r.get('phase'), 'contained': contained, 'regions': region_labels})

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
          saved.get('krisis') == 2 and skinds == {'bristol': 'match', 'bath': 'distinct', 'wells': 'not-this'} and (saved.get('reviewer') or {}).get('name') == 'Ada Reviewer', saved.get('error') or skinds)
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
    check('match review: the file made is the new attestations only, in PLATO JSON, with no @id minted', bool(atts) and out.get('profile') == 'attestation-centric'
          and not any('@id' in a for a in atts), {k: v for k, v in out.items() if k != 'attestations'} if isinstance(out, dict) else out)
    # Resuming: the saved review, opened again, is back where it was, decisions and all.
    r = {}
    if saved.get('krisis') == 2:
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
    if saved.get('krisis') == 2 and 'other files than the ones chosen' in w:
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
    def fake_whg(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=cors)
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
          and 'optional and goes online' not in na.get('panel text', '') and 'this tab' not in na.get('panel text', '') and 'No token is sent' not in na.get('panel text', ''), na.get('panel text', na))
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
          o.get('session') == LOOKUP_TOKEN and o.get('local') is None and o.get('field') == '' and 'A token is given' in o.get('tokenState', ''), {k: v for k, v in o.items() if k in ('field', 'local', 'tokenState', 'error')})
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
          lk(s).get('stopped') == 'quota' and states == {'answered': 24, 'unanswered': 1, 'stopped': 5} and "allowance of requests for today is spent" in s.get('progress', '')
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

def download(page, name, dest):
    with page.expect_download(timeout=600_000) as d:
        page.evaluate(f'window.__plato_save({json.dumps(name)})')
    d.value.save_as(dest); return pathlib.Path(dest)

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

# ---- Tooltips (src/lib/tooltip.js), on both pages ------------------------------------------------
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
            page.goto('data:text/html,<title>no tools here</title><input id=picker type=file multiple>' if PROVE else url)
            ready = wait_state(page, lambda s: s.get('phase') == 'ready', 30, 'ready')
            check('page is ready and names the PLATO commit it checks against', ready.get('phase') == 'ready' and len(ready.get('platoCommit') or '') == 40, ready)
            # The commit shown is the one served, and a draft pin (a PLATO branch, not a release) says so.
            served = json.loads(urllib.request.urlopen(url.rstrip('/') + '/plato/VERSION.json', timeout=10).read())
            footer = page.evaluate("() => document.getElementById('plato-version')?.textContent || ''")
            check('the footer shows the commit served, and says DRAFT exactly when the pin is a draft',
                  ready.get('phase') == 'ready' and ready.get('platoCommit') == served['commit'] and served['commit'][:7] in footer
                  and ('DRAFT' in footer) == bool(served.get('draft')), {'footer': footer, 'served': served})
            # The tooltips and the "Under development" badge's, at a phone's width, where the badge's
            # tooltip is wider than the room on one side of the badge: the badge sits beside the name,
            # by the window's right edge, or wrapped below it, by the left, as the fonts fall; the
            # check is made at whichever edge it is by. (Chora's zoom buttons are by the right, below.)
            page.set_viewport_size({'width': 390, 'height': 844})
            side = 'left'
            try: side = 'right' if page.eval_on_selector('.dev-badge', 'e => e.getBoundingClientRect().right > innerWidth - 60') else 'left'
            except Exception: pass
            tooltip_checks(page, 'tooltips', ('#toolbox .tool-link[data-tool="convert"] .why', 'μετάφρασις'), ('.dev-badge', 'being built in the open'),
                           ('.dev-badge', 'being built in the open', side))
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
            krisis_case(page, tmp)
            krisis_pattern_match(page, tmp)

            # The storage warning (src/app.js, storageCheck): shown when the browser's quota is below
            # what the tables need, and hidden, the control, with the same tables and the real quota.
            # Each page counts its calls of navigator.storage.estimate, so that the hidden warning is
            # read after the page has asked, not before; one page is told its quota is 1,000 bytes.
            def storage_warning(quota):
                p = ctx.new_page()
                try:
                    p.add_init_script('''(() => { const real = navigator.storage.estimate.bind(navigator.storage); window.__estimates = 0;
                      navigator.storage.estimate = async () => { const e = await real(); window.__estimates++; return %s; }; })()''' % ('{ ...e, quota: %d }' % quota if quota else 'e'))
                    p.goto('data:text/html,<title>no tools here</title><input id=picker type=file multiple>' if PROVE else url)
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
                    two.goto('data:text/html,<title>no tools here</title><input id=picker type=file multiple>' if PROVE else url)
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
                        p.goto('data:text/html,<title>no tools here</title><input id=picker type=file multiple>' if PROVE else url)
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
            ctx.close()
            front = pw.chromium.launch(headless=True)
            try: front_page_checks(front, url); theme_checks(front, url); methodos_page_checks(front, url)
            finally: front.close()
            methodos_checks(pw, url, tmp)
            chora_checks(pw, url, tmp)
            chora_adopt_checks(pw, url, tmp)
            iiif_checks(pw, url, tmp)
    finally:
        stop(srv)
        stop_fixtures()
        # The profile and the saved outputs are this run's alone: remove them (they were left in
        # /tmp by every run until now, some 2.7 MB each).
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    if PROVE:
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
    finally:
        browser.close()

# ---- Permissions (src/lib/permissions.js) on the main page ------------------------------------------
# The page runs under the Content Security Policy written from the permissions allowed (none, here),
# and every check above ran under it. The panel is the same on both pages; Chora's checks below allow,
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

# ---- Chora (chora.html): the map page ------------------------------------------------------------
# Chora has a browser profile of its own, so that its storage (the drawings kept, the contributor
# remembered, its SQLite pool) is this run's alone and nothing the main page's checks did is in it.
# The map is WebGL: the software-GL switches are kept as insurance (with none, the map still drew on
# this machine), and --no-gl-flags measures that again. Waits are on the page's own state
# (window.__chora) and on the map instance, never on a fixed sleep.
import csv, re, unicodedata
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

def until(page, js, timeout=60, arg=None):
    """Wait for `js` to hold; a timeout says what the page was doing (a hidden tab never draws a map, and
    looks exactly like a map that cannot), in the words the page itself shows."""
    t0 = time.time()
    # The pages run under a Content Security Policy without 'unsafe-eval', and Playwright evaluates a
    # bare expression with eval(): an expression is given as a function, which it calls instead.
    if not re.match(r'\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>', js): js = f'() => ({js})'
    try: page.wait_for_function(js, arg=arg, timeout=T(timeout) * 1000)
    except Exception as e:
        try: d = page.evaluate(DIAG)
        except Exception as e2: d = str(e2).split('\n')[0][:100]
        raise RuntimeError(f'waited {time.time() - t0:.0f}s for {js[:90]!r}: {d}') from e

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
    """Open chora.html afresh (a navigation: nothing is carried over in memory), and the files if any."""
    page.bring_to_front(); page.goto(NOTOOLS if PROVE else base + 'chora.html')
    until(page, 'window.__chora && window.__chora.phase === "ready" && window.__chora.mapReadyCount >= 1')
    if files:
        page.set_input_files('#picker', [str(f) for f in files])
        until(page, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)')
    return cstate(page)

SETTLE = '''() => new Promise((r) => { const m = window.__chora_map, t = setTimeout(() => r(false), 20000);
  const done = () => { clearTimeout(t); r(true); };
  if (!m.isMoving() && m.loaded()) requestAnimationFrame(() => requestAnimationFrame(done)); else m.once('idle', done); })'''

def chora_pick(page, text):
    """Find `text` in the place list and choose the first place found, as a user does; its id."""
    page.fill('#q', text)
    until(page, 't => { const b = [...document.querySelectorAll("#list button[data-id]")]; return b.length && b.every((x) => x.textContent.toLowerCase().includes(t)); }', 20, text.lower())
    pid = page.get_attribute('#list button[data-id]', 'data-id')
    drawn = page.evaluate('window.__chora.mapReadyCount')   # before the change: the place is drawn once it moves
    page.click('#list button[data-id]')
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

def map_centre(page):
    page.query_selector('#map').scroll_into_view_if_needed()
    b = page.query_selector('#map').bounding_box(); return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

def tap(page, x, y):
    # Terra Draw reads pointer events on the canvas; a mouse arrives at a point before pressing on it.
    page.mouse.move(x - 3, y - 3); page.mouse.move(x, y); page.mouse.down(); page.mouse.up(); page.wait_for_timeout(150)

def draw(page, mode, points):
    page.click(f'#draw-tools button[data-mode="{mode}"]')
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
                    and chora and chora[0] == './chora.html' and 'Show on the map (Chora)' in chora[1]), {'state': s.get('phase'), 'visible': vis, 'chora': chora, 'cards marked': current}
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
        # takes no one to its page); a second tap chooses.
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
            page.tap('#toolbox .tool-link[href="./chora.html"] .why'); page.wait_for_timeout(500)
            chora = {'tip': shown_tips(page, 'χώρα', 3), 'url': page.url}
            return (len(first['tip']) == 1 and first['hash'] == '' and first['tool'] is None and second['hash'] == '#tool=check' and second['tool'] == 'check'
                    and len(chora['tip']) == 1 and not chora['url'].endswith('chora.html')), {'first tap': first, 'second tap': second, 'Chora first tap': chora}
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
            hermes = {'focus': page.evaluate('() => document.activeElement?.id'), 'hash': page.evaluate('() => location.hash'), 'current': page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.length')}
            return (el['id'] == 'files-h' and el['tabindex'] == '-1' and 'Choose your data' in el['text'] and 0 <= el['top'] < 900
                    and hermes['focus'] == 'picker' and hermes['hash'] == '' and hermes['current'] == 0), {'after a card': el, 'after Hermes': hermes}
        finally: ctx.close()
    attempt('front page: a card chosen by keyboard moves focus to step 1\'s heading, in view; Hermes\'s card goes to the drop zone and narrows nothing', focus_step1)

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
            # The groups flow (Stephen, 2 October): a group of one shares a row with the next, so Start
            # here sits beside Bring your data in, and Publish and keep beside Explore; the groups of
            # three and two that follow each other start rows of their own. Tops of the headings, by group.
            rows = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#toolbox h3.tool-group')].map((h) => [h.id.slice(3), Math.round(h.getBoundingClientRect().top)]))""")
            vw = page.evaluate('() => innerWidth')
            page.click('#toolbox ul[aria-labelledby="tg-check"] .tool-link[data-tool="check"]')
            chose = {'hash': page.evaluate('() => location.hash'), 'tool': page.evaluate('() => window.__plato.tool ?? null'),
                     'current': page.eval_on_selector_all('#toolbox [aria-current]', 'es => es.map((e) => e.dataset.tool)')}
            want = [('Guided workflows', ['Methodos']), ('Bring your data in', ['Hermes']), ('Check and convert', ['Elenchos', 'Metaphrasis', 'Arithmos']),
                    ('Identify and locate', ['Krisis', 'Chora']), ('Publish and keep', ['Agora', 'Mneme']), ('Explore', ['Peripleo'])]
            return ([(g['heading'], g['cards']) for g in got] == want and all(g['visible'] and g['list'] for g in got) and every == 10
                    and first == {'name': 'Methodos', 'coming': False, 'link': True}
                    and chose == {'hash': '#tool=check', 'tool': 'check', 'current': ['check']}
                    and vw >= 1000 and rows.get('start') == rows.get('in') and rows.get('publish') == rows.get('explore')
                    and rows['in'] < rows['check'] < rows['locate'] < rows['publish']), {'groups': got, 'first card': first, 'cards': every, 'Elenchos chosen': chose, 'heading tops': rows, 'width': vw}
        finally: ctx.close()
    attempt('front page: the ten cards are in six groups under plain headings, in the order decided, Methodos (a link to its interview) first, the groups of one sharing a row, and a card in a group is still chosen', grouped)

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

    # The acknowledgement of ISHI ends the footer of both pages: a rebase once dropped it unseen.
    ISHI ='Development has been supported by the Institute for Spatial History Innovation (ISHI) at the University of Pittsburgh.'
    def acknowledged():
        found = {}
        for name in ('', 'chora.html'):
            ctx = browser.new_context(); page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
            try:
                page.goto(NOTOOLS if PROVE else url + name)
                found[name or 'index.html'] = page.evaluate("""() => { const f = document.querySelector('footer'), a = f?.querySelector('a[href="https://www.ishi.pitt.edu/"]');
                  return { text: (f?.textContent || '').replace(/\\s+/g, ' '), link: a ? a.textContent.trim() : null }; }""")
            finally: ctx.close()
        return (len(found) == 2 and all(ISHI in v['text'] and v['link'] == 'Institute for Spatial History Innovation (ISHI)' for v in found.values())), found
    attempt('both pages: the footer acknowledges ISHI, with its link', acknowledged)

# ---- The colour theme (public/theme.js): Auto, Light or Dark, on both pages ----------------------------
# The browser is told which scheme the device prefers (color_scheme), and the page's colours are
# measured, not only its attributes read: the page's background, a panel's, and on the main page the
# band of a tool's card (cobalt in light, light blue in dark) and the drawing's inversion. Each check
# sees both schemes, so a page that never changes cannot pass one, and the switch must be there to be used.
THEME_STATE = """() => { const lum = (c) => { const m = c && c.match(/[\\d.]+/g); if (!m) return null; const [r, g, b] = m.map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? 'light' : 'dark'; };
  const css = (e, p) => e ? getComputedStyle(e)[p] : null, root = document.documentElement, group = document.getElementById('theme-switch');
  const checked = group ? [...group.querySelectorAll('input[name="plato-theme"]')].filter((i) => i.checked).map((i) => i.value) : null;
  return { page: lum(css(document.body, 'backgroundColor')), body: css(document.body, 'backgroundColor'), panel: lum(css(document.getElementById('files'), 'backgroundColor')),
    band: css(document.querySelector('#toolbox .tool:not(.coming) .icon'), 'stroke'), mark: css(document.querySelector('#intro .plato-mark'), 'filter'),
    colorScheme: css(root, 'colorScheme'), attr: root.getAttribute('data-theme'), checked, group: !!group && !!group.offsetWidth,
    stored: (() => { try { return localStorage.getItem('plato-tools.theme'); } catch { return 'refused'; } })(),
    violations: window.__cspViolations || null, atParse: window.__themeAtParse }; }"""
# The theme on <html> at the moment <body> is parsed, before any paint and before the page's modules run.
THEME_AT_PARSE = """window.__themeAtParse = null;
new MutationObserver((ms, o) => { if (!document.body) return; window.__themeAtParse = { attr: document.documentElement.getAttribute('data-theme'), modulesRun: !!(window.__plato || window.__chora) }; o.disconnect(); })
  .observe(document, { childList: true, subtree: true });"""
THEME_PAGES = (('index', ''), ('chora', 'chora.html'))
COBALT, IRIS = 'rgb(31, 69, 184)', 'rgb(124, 196, 242)'

def theme_checks(browser, url):
    def opened(scheme, name, init=(), ctx=None):
        ctx = ctx or browser.new_context(viewport={'width': 1280, 'height': 900}, color_scheme=scheme)
        for s in (CSP_WATCH, THEME_AT_PARSE, *init): ctx.add_init_script(s)
        page = ctx.new_page(); page.set_default_timeout(T(8) * 1000)
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)[:160]))
        page.goto(NOTOOLS if PROVE else url + name)
        return ctx, page, errors
    def state(page): return page.evaluate(THEME_STATE)
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
    attempt('theme, both pages: under a device set to dark, Light chosen gives light colours (page, panels, tool bands, drawing, native controls), set before the page is painted after a reload, and Auto gives dark again', lambda: each_page(light_under_dark))

    def auto_follows(key, name):
        ctx, page, errors = opened('light', name)
        try:
            a = state(page); page.emulate_media(color_scheme='dark'); b = state(page); page.emulate_media(color_scheme='light'); c = state(page)
            return (a['group'] and a['checked'] == ['auto'] and a['page'] == 'light' and a['colorScheme'] == 'light' and b['page'] == 'dark' and b['panel'] == 'dark' and b['colorScheme'] == 'dark'
                    and c['page'] == 'light' and a['attr'] is None and b['attr'] is None and clean(a, b, c) and not errors), {'light': a, 'dark': b, 'light again': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, both pages: Auto follows the device\'s setting both ways, light to dark and back, with no reload', lambda: each_page(auto_follows))

    def dark_under_light(key, name):
        ctx, page, errors = opened('light', name)
        try:
            a = state(page); choose(page, 'dark'); b = state(page); page.reload(); c = state(page)
            return (a['group'] and a['page'] == 'light' and b['checked'] == ['dark'] and b['page'] == 'dark' and b['panel'] == 'dark' and b['colorScheme'] == 'dark' and b['attr'] == 'dark'
                    and b['stored'] == 'dark' and c['page'] == 'dark' and c['checked'] == ['dark'] and c['atParse'] == {'attr': 'dark', 'modulesRun': False}
                    and (key != 'index' or (a['band'] == COBALT and b['band'] == IRIS)) and clean(a, b, c) and not errors), {'light': a, 'dark': b, 'after reload': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, both pages: under a device set to light, Dark chosen gives dark colours, and is kept after a reload', lambda: each_page(dark_under_light))

    def refused(key, name):
        ctx, page, errors = opened('dark', name, init=[REFUSE_STORAGE])
        try:
            a = state(page); choose(page, 'light'); b = state(page); page.reload(); c = state(page)
            return (a['stored'] == 'refused' and a['group'] and a['page'] == 'dark' and b['page'] == 'light' and b['checked'] == ['light']
                    and c['page'] == 'dark' and c['checked'] == ['auto'] and clean(a, b, c) and not errors), {'first': a, 'light': b, 'after reload': c, 'errors': errors}
        finally: ctx.close()
    attempt('theme, both pages: with storage refused, Light chosen still applies to the page, nothing fails, and a reload is back to Auto', lambda: each_page(refused))

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
    attempt('theme, both pages: the switch is a radio group named "Colour theme" (Auto, Light, Dark; Auto chosen), worked by the arrow keys, with a focus ring', lambda: each_page(accessible))

    def other_tabs():
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, color_scheme='dark')
        try:
            _, one, _ = opened('dark', '', ctx=ctx); _, two, _ = opened('dark', 'chora.html', ctx=ctx)
            a = state(two); choose(one, 'light')
            moved = soon(two, "() => document.documentElement.getAttribute('data-theme') === 'light'", 5); b = state(two)
            choose(one, 'auto'); back = soon(two, "() => !document.documentElement.hasAttribute('data-theme')", 5); c = state(two)
            return (a['page'] == 'dark' and moved and b['page'] == 'light' and b['checked'] == ['light'] and back and c['page'] == 'dark' and c['checked'] == ['auto']), {'before': a, 'after Light in the other tab': b, 'after Auto': c}
        finally: ctx.close()
    attempt('theme: a theme chosen on the main page is taken up at once by Chora open in another tab, and Auto too', other_tabs)

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
    said = []                                                   # what Chora's pages wrote to the console
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
        listed = page.eval_on_selector_all('#list button[data-id]', 'bs => bs.length')
        unplaced = page.eval_on_selector_all('#list .tag', 'ts => ts.filter((t) => t.textContent === "no location").length')
        ov = page.evaluate('() => { const d = window.__chora_map.getSource("chora-overview").serialize().data; return (d.features || d.geojson?.features || []).length; }')
        dots = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["chora-overview-points", "chora-overview-clusters"] }).length > 0', 20)
        text = page.inner_text('#dataset')
        return (s['phase'] == 'loaded' and s['places'] == ant_places and listed == ant_places and unplaced == ant_places - ant_located and ov == ant_located and dots
                and f'{ant_places} places, {ant_located} with a location' in text), {'state': s, 'listed': listed, 'no location': unplaced, 'on the map': ov, 'drawn': dots, 'text': text}
    attempt(f'Chora: a PLATO JSON file opens: its {ant_places} places listed, the {ant_located} with a location on the map', load_plato)
    def load_tables():
        rows = list(csv.DictReader((PLATO / 'schemas/tables/examples/customs/places.csv').open(newline='')))
        s = chora_boot(page, base, sorted((PLATO / 'schemas/tables/examples/customs').glob('*.csv'))); loads.append(s['phase'])
        labels = page.eval_on_selector_all('#list button[data-id]', 'bs => bs.map((b) => b.firstChild.textContent.trim())')
        return s['phase'] == 'loaded' and s['places'] == len(rows) and sorted(labels) == sorted(r['label'] for r in rows), {'state': s, 'listed': labels}
    attempt('Chora: the PLATO spreadsheet tables open, each place in places.csv listed', load_tables)

    def georef_said():
        # A IIIF Georeference Annotation is not a dataset: Chora says why, in the readers' own words.
        # The control: the same page then opens a dataset.
        s = chora_boot(page, base, [ROOT / 'test/fixtures/hermes-detect/bpl-rocque-annotation.json'])
        said = page.inner_text('#phase')
        # On Chora the advice is to paste it under Historical maps, not the main page's (drop it with the Recogito export).
        ok = (s['phase'] == 'unrecognised' and 'IIIF Georeference Annotation' in said and 'Unsupported input' not in said
              and 'under Historical maps' in said and 'Recogito' not in said)
        s2 = chora_boot(page, base, [ant])
        return ok and s2['phase'] == 'loaded', {'state': s, 'said': said[:300], 'then': s2.get('phase')}
    attempt('Chora: a IIIF Georeference Annotation is refused as a dataset, saying to paste it under Historical maps (not the main page\'s advice)', georef_said)

    def search():
        chora_boot(page, base, [fixture(ant, 'antonine-search.json', tmp)])
        labels = lambda: sorted(page.eval_on_selector_all('#list button[data-id]', 'bs => bs.map((b) => b.firstChild.textContent.trim())'))
        # What should be found, worked out from the file, folded as the page says it folds (chora_fold).
        fold = chora_fold
        want = sorted(p['label'] for p in antj['spatialEntities'] if 'road' in fold(p['label']))
        want_dover = sorted(p['label'] for p in antj['spatialEntities'] if 'dover' in fold(p['label']))
        page.fill('#q', 'ROAD'); until(page, '() => /found/.test(document.getElementById("found").textContent)', 20)
        roads, was = labels(), page.inner_text('#found')
        # Diacritics are folded on both sides: "dóver" finds Dover.
        page.fill('#q', 'dóver'); until(page, 'w => document.getElementById("found").textContent !== w', 20, was)
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
        was = page.inner_text('#found')                         # "11 places.": the list before the search
        page.fill('#q', 'AD PÓRTUM'); until(page, 'w => document.getElementById("found").textContent !== w', 20, was)
        got = sorted(page.eval_on_selector_all('#list button[data-id]', 'bs => bs.map((b) => [b.firstChild.textContent.trim(), b.querySelector(".also")?.textContent || null])'))
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
        shown = lambda: page.eval_on_selector_all('#list button[data-id]', 'bs => bs.map((b) => [b.dataset.id, b.firstChild.textContent.trim()])')
        last = lambda: cstate(page).get('lastSearch') or {}
        seen, sent, prev = [], [], None
        for step in ['start', 'next', 'next', 'prev']:
            was = page.inner_text('#found')
            if step != 'start':
                page.click(f'#{step}'); until(page, 'w => document.getElementById("found").textContent !== w', 20, was)
            ls, items = last(), shown()
            seen.append([page.inner_text('#found'), [i for i, _ in items], [l for _, l in items], page.is_disabled('#prev'), page.is_disabled('#next')])
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
        before = page.inner_text('#found')
        page.evaluate('() => { const b = document.getElementById("next"); b.click(); b.click(); }')
        got = soon(page, '() => /101–120/.test(document.getElementById("found").textContent)', 20)
        after = page.inner_text('#found'); first = page.eval_on_selector_all('#list button[data-id]', 'bs => bs[0]?.firstChild.textContent.trim()')
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
        before = page.inner_text('#found')
        page.evaluate("""() => { window.__sent = []; window.__held = []; window.__hold = true;
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (m, ...rest) {
            if (!m || typeof m.cmd !== 'string') return post.call(this, m, ...rest);   // the map's own workers
            window.__sent.push(m.cmd === 'chora-search' ? [m.cmd, m.q, m.after] : [m.cmd]);
            if (window.__hold) window.__held.push([this, m]); else post.call(this, m);
          };
          window.__release = () => { window.__hold = false; for (const [w, m] of window.__held.splice(0)) post.call(w, m); }; }""")
        page.evaluate('() => document.querySelector("#list button[data-id]").click()')   # chora-place: held, so the worker is busy
        until(page, '() => window.__sent.length === 1', 10)
        page.click('#next')                                                                  # for "", from page 1: waits behind it
        page.fill('#q', 'HOLM 1')                                                            # then typed ...
        page.wait_for_timeout(600)                                                           # ... and settled (200 ms) while still held
        page.evaluate('() => window.__release()')
        got = soon(page, '() => /found/.test(document.getElementById("found").textContent)', 20)
        page.wait_for_timeout(300)
        sent = page.evaluate('() => window.__sent')
        found, ls = page.inner_text('#found'), cstate(page).get('lastSearch') or {}
        searches = [x for x in sent if x[0] == 'chora-search']
        return (before == '120 places, showing 1–50.' and got and sent[0] == ['chora-place'] and searches == [['chora-search', 'HOLM 1', 0]]
                and found == '21 found.' and ls.get('after') == 0), {'before': before, 'sent': sent, 'found': found, 'lastSearch after': ls.get('after')}
    attempt('Chora: Next clicked, then a new query typed before Next is sent: Next asks for nothing, the new query its first page', paging_then_typed)

    def statuses():
        chora_boot(page, base, [fixture(judgements, 'judgements-card.json', tmp)])
        chora_pick(page, 'kingsbury'); kb = sorted(page.eval_on_selector_all('#card .status', 'x => x.map((e) => e.textContent)'))
        bars = page.eval_on_selector_all('#card svg.timeline rect', 'r => r.length')
        chora_pick(page, 'littleworth'); lw = sorted(page.eval_on_selector_all('#card .status', 'x => x.map((e) => e.textContent)'))
        # Kingsbury's two markets: one reported, one doubted, each dated; Littleworth's market is denied.
        return kb == ['doubted', 'reported'] and bars == 2 and lw == ['denied'], {'kingsbury': kb, 'bars': bars, 'littleworth': lw}
    attempt('Chora: the place card labels what a source reports, doubts and denies, and dates them on its timeline', statuses)

    def timeline_theme():
        # The timeline's bars take their status's colour from the stylesheet, as the labels do, so they
        # follow the theme: a doubted bar is the doubted label's grey, darker in Light, lighter in Dark.
        BAR = """() => { const r = document.querySelector('#card svg.timeline rect.tl-doubted'), s = document.querySelector('#card .status-doubted');
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
    try:
        chora_boot(page, base, [fixture(judgements, 'judgements-tips.json', tmp)]); chora_pick(page, 'kingsbury')
    except Exception as e: print('  (Chora tooltips: the page did not open the dataset:', str(e).split('\n')[0][:200], ')')
    tooltip_checks(page, 'Chora tooltips', ('#card .status-reported', 'as said by others'), ('#card .status-doubted', 'and doubts it'),
                   ('.maplibregl-ctrl-zoom-in', 'Zoom in', 'right', '.maplibregl-ctrl-zoom-out'))
    no_titles(page, 'Chora tooltips', ['Draw a point', 'Stop drawing', 'Show a historical map to trace from it', "goes onto it (hold Alt not to)", 'Zoom in', 'Zoom out', 'The source reports this as said by others.', 'market (1673), reported', 'being built in the open'])
    def withdrawn():
        chora_boot(page, base, [fixture(judgements, 'judgements-withdrawn.json', tmp)])
        chora_pick(page, 'littleworth')
        text = page.inner_text('#card')
        where = page.evaluate('() => [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling?.textContent')
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
        note = page.inner_text('#card .note'); c = page.evaluate('() => window.__chora_map.getCenter().toArray()')
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
        rel = page.evaluate('() => { const ul = [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Related places")?.nextElementSibling; return ul ? { text: ul.textContent, links: ul.querySelectorAll("a").length } : null; }')
        tl = page.evaluate('() => { const s = document.querySelector("#card svg.timeline"); return s ? { text: s.textContent, evidence: s.querySelectorAll("rect.tl-evidence").length, legend: s.querySelectorAll(".tl-legend").length } : null; }')
        note = page.inner_text('#card .note')
        locs = page.evaluate('() => { const ul = [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling; return ul ? { text: ul.textContent, links: [...ul.querySelectorAll("a[data-place]")].map((a) => a.dataset.place) } : null; }')
        drawn = rendered(page, ['chora-place-points'])['chora-place-points']
        names = page.evaluate('() => { const ul = [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Names")?.nextElementSibling; return ul ? [...ul.querySelectorAll("li")].map((li) => li.textContent) : null; }')
        # The control: a location with coordinates is drawn and not written as relative; a dated claim is a solid bar with no legend, and a relation to a place of the dataset is a link.
        chora_pick(page, 'kom control')
        ctl_locs = page.evaluate('() => [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Locations")?.nextElementSibling?.textContent')
        ctl_drawn = rendered(page, ['chora-place-points'])['chora-place-points']
        ctl_rel = page.evaluate('() => [...document.querySelectorAll("#card h3")].find((h) => h.textContent === "Related places")?.nextElementSibling?.querySelectorAll("a[data-place]").length')
        ctl = page.evaluate('() => { const s = document.querySelector("#card svg.timeline"); return s ? { text: s.textContent, bars: s.querySelectorAll("rect").length, evidence: s.querySelectorAll("rect.tl-evidence").length, legend: s.querySelectorAll(".tl-legend").length } : null; }')
        return (rel and 'ContainedIn: the Delta' in rel['text'] and rel['links'] == 0
                and 'Located only relative to other places; showing its country (EG)' in note
                and locs and 'between Kom Control and 1767, as written “between Kom and Philai” (relative; not drawn)' in locs['text'] and locs['links'] == ['https://example.org/p/kom'] and drawn == 0
                and ctl_locs == 'Point' and ctl_drawn > 0
                and tl and 'mentioned in texts dated 15–540' in tl['text'] and tl['evidence'] == 1 and tl['legend'] == 1
                and ctl_rel == 1 and ctl and 'Kom Control · 100–200' in ctl['text'] and 'mentioned' not in ctl['text']
                and ctl['bars'] == 1 and ctl['evidence'] == 0 and ctl['legend'] == 0
                and names == ['Agathos Daimon', 'Sṯt (egy-Latn-t-egy-egyd) in Egyptological transliteration']), {'related': rel, 'locations': locs, 'drawn': drawn, 'control locations': ctl_locs, 'control drawn': ctl_drawn, 'timeline': tl, 'note': note, 'control links': ctl_rel, 'control timeline': ctl, 'names': names}
    attempt('Chora: a relation named only is plain text that places nothing, a location between two places is a line in words that is not drawn, the span of the texts is drawn hatched as a mention (a drawn location and a dated claim are not), and a name known only in transliteration says so', name_only_and_evidence)

    # Drawing, in one file: each check below opens it afresh and finds what the one before left.
    draws = {'file': fixture(ant, 'antonine-draw.json', tmp)}
    def draw_three():
        f = draws['file']; chora_boot(page, base, [f]); draws['place'] = chora_pick(page, 'londinium')
        x, y = map_centre(page)
        draw(page, 'point', [(x + 150, y + 60)])
        draw(page, 'linestring', [(x - 200, y - 100), (x - 100, y - 150), (x, y - 100), (x, y - 100)])   # the last vertex again ends the line
        draw(page, 'polygon', [(x - 200, y + 100), (x - 100, y + 100), (x - 150, y + 200), (x - 200, y + 100)])   # the first corner again closes it
        page.click('#draw-tools button[data-mode="static"]')
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
        page.click('#draw-tools button[data-mode="select"]')
        tap(page, px, py)                                       # select it, then drag it
        page.mouse.move(px, py); page.mouse.down(); page.mouse.move(px + 30, py + 20, steps=6); page.mouse.move(px + 60, py + 40, steps=6); page.mouse.up()
        page.click('#draw-tools button[data-mode="static"]')
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
        f = draws['file']; s = chora_boot(page, base, [f]); note = page.inner_text('#dataset')
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
        page.click('#save')
        asked = page.is_visible('#contributor-form')
        page.fill('#c-name', 'Ada Test'); page.fill('#c-orcid', '0000-0002-1825-0098')   # the check digit should be 7
        page.click('#contributor-form button[type=submit]')
        err = page.inner_text('#c-error') if page.is_visible('#c-error') else ''
        refused = page.is_visible('#contributor-form') and cstate(page)['lastSave'] is None and page.evaluate("() => localStorage.getItem('chora-contributor')") is None
        if not refused: return False, {'error': err, 'the mistyped iD was taken': cstate(page).get('lastSave') or page.evaluate("() => localStorage.getItem('chora-contributor')")}
        page.fill('#c-orcid', '0000-0002-1825-0097'); page.click('#contributor-form button[type=submit]')
        until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        c = json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')
        line = page.inner_text('#contributor-line')
        return asked and 'ORCID' in err and refused and c == {'name': 'Ada Test', 'orcid': 'https://orcid.org/0000-0002-1825-0097'} and 'Saving as Ada Test' in line, {'error': err, 'remembered': c, 'line': line}
    attempt('Chora: the first save asks who is saving; a mistyped ORCID iD (its check digit) is refused, a right one remembered', contributor)
    def save():
        f = draws['file']; s = chora_boot(page, base, [f])
        if page.evaluate("() => localStorage.getItem('chora-contributor')") is None:   # this check's own state, if the one before failed
            page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: 'https://orcid.org/0000-0002-1825-0097' }))")
        page.click('#save')
        until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}; said = page.inner_text('#save-result')
        return s['pendingCount'] == 2 and ls.get('passed') and ls.get('added') == 2 and [o['name'] for o in ls['outputs']] == ['antonine-draw.chora.json'] and 'Mneme' in said, {'kept': s['pendingCount'], 'save': ls, 'said': said}
    attempt('Chora: saving passes the version check (Mneme) with exactly the two drawings added', save)
    saved = tmp / 'chora-saved.json'
    def saved_file():
        f = draws['file']
        if not page.is_visible('#save-result button.primary'): raise RuntimeError('no saved file offered (the save before did not pass)')
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
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
        after_download = {'pending': cstate(page)['pendingCount'], 'kept': len(kept(page, f.name)), 'offered': page.is_visible('#save-result button.primary'),
                          'said': page.inner_text('#save-result')}
        held = after_download['pending'] == 2 and after_download['kept'] == 2 and after_download['offered'] and 'If the download did not complete, save again' in after_download['said']
        if page.is_visible('#save-result button[data-clear]'): page.click('#save-result button[data-clear]')
        cleared = soon(page, '() => window.__chora.pendingCount === 0', 10) and kept(page, f.name) == [] and not page.is_visible('#save-result button.primary')
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
        x, y = map_centre(page); draw(page, 'point', [(x + 90, y + 50)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        offered = (cstate(page)['lastSave'] or {}).get('passed') and page.is_visible('#save-result button.primary')
        # A drawing made after the save is not in the file that save wrote.
        draw(page, 'point', [(x - 90, y - 50)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 2', 10)
        stale = page.is_visible('#save-result button.primary') and page.is_enabled('#save-result button.primary')
        if stale:                                               # as a user would: saving that file let both drawings go
            with page.expect_download(timeout=T(60) * 1000): page.click('#save-result button.primary')
            page.wait_for_timeout(500)
        left, k, text = cstate(page)['pendingCount'], len(kept(page, f.name)), page.inner_text('#save-result')
        return offered and not stale and left == 2 and k == 2 and 'save again' in text, {'offered after the save': offered, 'still offered after drawing': stale, 'pending': left, 'kept': k, 'said': text}
    attempt('Chora: a drawing made after a save withdraws that save\'s file, and no drawing is let go that the file does not hold', resave)
    def conversion_said():
        tables = sorted((ROOT / 'test/fixtures/tables-routes').glob('*.csv'))
        chora_boot(page, base, tables); chora_pick(page, 'cambridge')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 40, y + 40)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount >= 1', 10)
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}; text = page.inner_text('#save-result')
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
        draw(page, 'point', [(x, y)]); page.click('#draw-tools button[data-mode="static"]')
        got = soon(page, '() => window.__chora.pendingCount === 1', 10)
        k = kept(page, f.name); lon = k[0]['geojson']['coordinates'][0] if k else None
        on_copy = here[0] > 180                                   # the point was drawn where longitudes run past 180
        ok_point = got and len(k) == 1 and lon is not None and -180 <= lon <= 180 and abs(lon - (here[0] - 360)) < 0.01
        # A line across the antimeridian cannot be a PLATO geometry as drawn: refused, in words, and not kept.
        page.evaluate('() => window.__chora_map.jumpTo({ center: [180, -17], zoom: 6 })'); page.evaluate(SETTLE)
        draw(page, 'linestring', [(x - 80, y), (x + 80, y), (x + 80, y)]); page.click('#draw-tools button[data-mode="static"]')
        refused = soon(page, '() => !!window.__chora.drawError', 10)
        text = page.inner_text('#card'); k2 = kept(page, f.name)
        line_gone = soon(page, '() => window.__chora_map.queryRenderedFeatures({ layers: ["td-linestring"] }).length === 0', 5)
        return (on_copy and ok_point and refused and 'was not kept' in text and 'longitude must be between -180 and 180' in text
                and len(k2) == 1 and cstate(page)['pendingCount'] == 1 and line_gone), {'drawn at': here, 'kept': [d['geojson'] for d in k2], 'error': cstate(page).get('drawError'), 'line gone': line_gone}
    attempt('Chora: a point drawn on a copy of the world is kept on the world, and a line across the antimeridian is refused in words', world_copy)

    def handoff():
        f = fixture(ant, 'antonine-handoff.json', tmp)
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.set_input_files('#picker', str(f))
        until(page, '() => window.__plato.phase === "detected"', 30)
        page.click('#toolbox a.tool-link[href="./chora.html"]')
        until(page, '() => window.__chora && window.__chora.handoff', 30)
        offer = page.inner_text('#handoff'); page.click('#open-handoff')
        until(page, '() => ["loaded", "error"].includes(window.__chora.phase)', 60); s = cstate(page)
        # Once opened, the files are let go: the page opened again offers nothing.
        page.reload(); until(page, '() => window.__chora.phase === "ready"', 60); page.wait_for_timeout(500)
        again = page.is_visible('#handoff') or bool(cstate(page).get('handoff'))
        return f.name in offer and s['phase'] == 'loaded' and s['places'] == ant_places and not again, {'offer': offer, 'state': s, 'offered again': again}
    attempt('Chora: a file chosen on the main page is offered on Chora\'s page, opens there, and is not kept after', handoff)

    def handoff_from_step2():
        # The same hand-over from step 2's "Show on the map (Chora)", offered with no tool chosen; with a
        # tool chosen it is not offered (the presence first, so that its absence after means something).
        f = fixture(ant, 'antonine-step2.json', tmp)
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.set_input_files('#picker', str(f))
        until(page, '() => window.__plato.phase === "detected"', 30)
        offered = page.is_visible('#to-chora')
        page.click('#toolbox .tool-link[href="#tool=check"]'); narrowed = page.is_visible('#to-chora')
        page.click('#every-action'); page.click('#to-chora')
        until(page, '() => window.__chora && window.__chora.handoff', 30)
        offer = page.inner_text('#handoff')
        return offered and not narrowed and f.name in offer and page.url.endswith('chora.html'), {'offered': offered, 'with Elenchos chosen': narrowed, 'offer': offer, 'url': page.url}
    attempt('Chora: step 2\'s "Show on the map (Chora)" hands the chosen file to Chora\'s page, and is not offered once a tool is chosen', handoff_from_step2)
    IDB = '''(put) => new Promise((resolve, reject) => { const q = indexedDB.open('plato-tools-chora', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => { const db = q.result, t = db.transaction('kv', put ? 'readwrite' : 'readonly'), s = t.objectStore('kv');
        const r = put ? s.put({ files: [new File(['{}'], 'stale.json')], at: Date.now() - 10 * 60 * 1000 }, 'chora-handoff') : s.get('chora-handoff');
        t.oncomplete = () => { db.close(); resolve(put ? true : r.result ? { names: (r.result.files || []).map((f) => f.name), at: r.result.at } : null); }; t.onerror = () => reject(t.error); };
      q.onerror = () => reject(q.error); })'''
    IDB_FRESH = '''() => new Promise((resolve, reject) => { const q = indexedDB.open('plato-tools-chora', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => { const db = q.result, t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put({ files: [new File(['{}'], 'fresh.json')], at: Date.now() }, 'chora-handoff');
        t.oncomplete = () => { db.close(); resolve(true); }; t.onerror = () => reject(t.error); };
      q.onerror = () => reject(q.error); })'''
    def handoff_let_go():
        f = fixture(ant, 'antonine-handoff-go.json', tmp)
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.set_input_files('#picker', str(f)); until(page, '() => window.__plato.phase === "detected"', 30)
        page.click('#toolbox a.tool-link[href="./chora.html"]')
        until(page, '() => window.__chora && window.__chora.handoff', 30)
        offered = f.name in page.inner_text('#handoff')
        left = page.evaluate(IDB, False)                         # not opened yet: already let go, held in the page alone
        # A hand-off older than a few minutes is not offered, and is let go too.
        page.evaluate(IDB, True); page.reload(); until(page, '() => window.__chora.phase === "ready"', 60); page.wait_for_timeout(500)
        stale = page.is_visible('#handoff') or bool(cstate(page).get('handoff')); after = page.evaluate(IDB, False)
        return offered and left is None and not stale and after is None, {'offered': offered, 'left in the browser': left, 'stale offered': stale, 'stale left': after}
    attempt('Chora: files handed over from the main page are let go by the browser as soon as they are offered, and an old hand-off is not offered', handoff_let_go)

    # The way back into a Methodos workflow (src/chora/handback.js): opened as chora.html#workflow=<id>,
    # a file saved is handed back by reference, in the hand-off's store, under 'chora-handback'.
    HANDBACK = '''(op) => new Promise((resolve, reject) => { const q = indexedDB.open('plato-tools-chora', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => { const db = q.result, t = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite'), s = t.objectStore('kv');
        const r = op === 'get' ? s.get('chora-handback') : op === 'delete' ? s.delete('chora-handback') : s.put({ probe: true }, 'chora-handback');
        t.oncomplete = () => { db.close(); resolve(op === 'get' ? (r.result === undefined ? null : JSON.parse(JSON.stringify(r.result))) : true); };
        t.onerror = () => reject(t.error); };
      q.onerror = () => reject(q.error); })'''
    WF = 'wf-e2e-7Kq2_x'
    def saved_in(hash_, name):
        """Chora opened at chora.html<hash_> afresh, a drawing saved and its file downloaded: the file, and the page's account."""
        f = fixture(ant, name, tmp)
        page.goto('about:blank')                                # a navigation, not a change of fragment: the page reads its address afresh
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base + 'chora.html' + hash_)
        until(page, 'window.__chora && window.__chora.phase === "ready" && window.__chora.mapReadyCount >= 1')
        page.evaluate(HANDBACK, 'delete')                       # this check's own state: no hand-back from before
        page.set_input_files('#picker', [str(f)]); until(page, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)')
        chora_pick(page, 'londinium')
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 60, y + 30)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        if not (cstate(page)['lastSave'] or {}).get('passed'): raise RuntimeError('the save did not pass')
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
        out = tmp / ('downloaded-' + name); d.value.save_as(out)
        # The handler hands back (or not) before it offers to let the drawings go: that offer is the point both ways.
        until(page, '() => !!document.querySelector("#save-result button[data-clear]")', 20)
        return out, d.value.suggested_filename
    def handback_given():
        out, named = saved_in('#workflow=' + WF, 'antonine-handback.json')
        body = out.read_bytes(); rec = page.evaluate(HANDBACK, 'get'); now = page.evaluate('() => Date.now()')
        want = [{'type': 'dataset', 'name': named, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}]
        link = page.query_selector('#back-to-workflow')
        href = link.evaluate('a => a.href') if link else None; shown = link.is_visible() if link else False
        note = page.is_visible('#workflow') and 'workflow' in page.inner_text('#workflow')
        s = cstate(page)
        # While it hashed, the save button waited and the page said why; afterwards, both were put back.
        busy = s.get('handingBack')
        restored = page.is_enabled('#save-result button.primary') and 'Handing the file back' not in page.inner_text('#save-result')
        published = (s.get('handback') or {}).get('files') == want
        ok_rec = (rec is not None and sorted(rec) == ['at', 'files', 'handback', 'workflow'] and rec['handback'] == 1 and rec['workflow'] == WF
                  and rec['files'] == want and 0 <= now - rec['at'] < 120000 and len(body) > 0)
        # The way back: the main page, with the workflow, and the record written again (fresh) on the way.
        at0 = rec['at'] if rec else None
        if shown: page.click('#back-to-workflow')
        went = soon(page, 'u => location.href === u && !!window.__plato', 30, base + '#workflow=' + WF)
        after = page.evaluate(HANDBACK, 'get') if went else None
        return (ok_rec and note and shown and href == base + '#workflow=' + WF and went and page.url == base + '#workflow=' + WF
                and after is not None and after['files'] == want and after['at'] > at0
                and busy == {'disabled': True, 'said': 'Handing the file back to the workflow…'} and restored and published), {
                    'record': rec, 'expected files': want, 'link': href, 'note': note, 'went to': page.url, 'after the click': after,
                    'rewritten on the click by (ms)': (after['at'] - at0) if after and at0 is not None else None,
                    'while handing back': busy, 'restored after': restored, 'state.handback files as expected': published}
    attempt('Chora, in a workflow: a file saved is handed back by reference (name, size and SHA-256 of the file downloaded), and "Back to the workflow" goes to the main page with the id', handback_given)
    def handback_control():
        # The same save without #workflow: nothing written, nothing offered (the reader shown able to see a record, in this page, after).
        out, named = saved_in('', 'antonine-handback-none.json')
        rec = page.evaluate(HANDBACK, 'get'); link = page.query_selector('#back-to-workflow'); note = page.is_visible('#workflow')
        page.evaluate(HANDBACK, 'put'); seen = page.evaluate(HANDBACK, 'get'); page.evaluate(HANDBACK, 'delete')
        s = cstate(page)
        return (out.stat().st_size > 0 and rec is None and link is None and not note and seen == {'probe': True}
                and s.get('workflow') is None and s.get('handback') is None and s.get('handingBack') is None), {'record': rec, 'link': bool(link), 'note': note, 'reader sees a record put': seen, 'state': {k: s.get(k) for k in ('workflow', 'handback', 'handingBack')}}
    attempt('Chora, not in a workflow (the control): the same save writes no hand-back and offers no way back', handback_control)
    def handback_bad_id():
        # A workflow id that is not one (markup, here) is neither used nor put in the page; the presence: the warning line is shown.
        page.goto('about:blank'); page.bring_to_front()
        page.goto(NOTOOLS if PROVE else base + 'chora.html#workflow=%3Cimg%20src%3Dx%20onerror%3D%22window.__pwned%3D1%22%3E')
        until(page, 'window.__chora && window.__chora.phase === "ready"')
        s = cstate(page); shown = page.is_visible('#workflow'); text = page.inner_text('#workflow') if shown else ''
        imgs = page.eval_on_selector_all('#workflow img, #save-result img', 'xs => xs.length'); pwned = page.evaluate('() => window.__pwned === 1')
        return (shown and 'not in a form' in text and s.get('workflowRefused') is True and s.get('workflow') is None and imgs == 0 and not pwned), {'state': {k: s.get(k) for k in ('workflow', 'workflowRefused')}, 'said': text, 'img': imgs, 'ran': pwned}
    attempt('Chora: an address whose workflow is not an id is refused in words, and nothing of it reaches the page', handback_bad_id)

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
            x, y = map_centre(b); draw(b, 'point', [(x + 80, y + 40)]); b.click('#draw-tools button[data-mode="static"]')
            soon(b, '() => window.__chora.pendingCount === 1', 10)
            b.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
            b.click('#save'); until(b, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
            sb = cstate(b); a.bring_to_front(); outs, chora_outs = opfs_names(a, 'outputs'), opfs_names(a, 'chora-outputs')
            lines = download(a, a_out[0], tmp / 'twotabs.jsonl').read_text().strip().split('\n') if a_out and a_out[0] in outs else []
            again = run_case(a, [fixture(EX / 'place-centric-king-john.json', 'king-john-twotabs.json', tmp)], 'check')
            return {'first': first.get('phase'), 'a_out': a_out, 'chora': s, 'save': sb.get('lastSave'), 'error': sb.get('error'), 'outputs': outs, 'chora-outputs': chora_outs, 'lines': len(lines), 'again': again.get('phase'), 'again errors': (again.get('report') or {}).get('errors')}
        finally: a.close(); b.close()
    both = {}
    def two_tabs_run():
        both.update(two_tabs()); r = both
        return (r['first'] == 'done' and r['chora']['phase'] == 'loaded' and (r['save'] or {}).get('passed') and r['again'] == 'done' and r['again errors'] == 0), r
    attempt('Chora and the main page open at once: Chora opens and saves a dataset, and the main page still runs', two_tabs_run)
    attempt('Chora and the main page open at once: Chora\'s save leaves the main page\'s unsaved output in place, and it saves',
            lambda: (bool(both) and both['a_out'] and both['a_out'][0] in both['outputs'] and 'antonine-twotabs.chora.json' in both['chora-outputs'] and both['lines'] > 1, both))

    # Chora's working database is in a SQLite pool one tab alone can hold, so a second Chora tab cannot
    # start. It must say so in words, not show the browser's createSyncAccessHandle error; the first tab
    # is the control (it still opens a file), and once it is closed the second starts on a reload.
    ANOTHER_TAB = 'Chora is already open in another tab of this browser. Close it, or use that one.'
    def another_tab():
        page.goto('about:blank')                                # no Chora tab but these two
        one, two = ctx.new_page(), ctx.new_page()
        try:
            chora_boot(one, base)                               # brought to the front, and ready
            # Files handed over from the main page, as if the way to Chora had been taken again: the
            # second tab offers nothing, so it must let them go, not leave them in the browser.
            one.evaluate(IDB_FRESH); handed = one.evaluate(IDB, False)
            two.bring_to_front(); two.goto(NOTOOLS if PROVE else base + 'chora.html')
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); s2 = cstate(two); said = two.inner_text('#phase'); shut = two.is_disabled('#picker')
            left = two.evaluate(IDB, False)
            one.bring_to_front(); one.set_input_files('#picker', [str(fixture(judgements, 'judgements-another-tab.json', tmp))])
            until(one, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)'); s1 = cstate(one)
            one.close()                                         # its worker, and the pool with it, let go
            two.bring_to_front(); two.reload()
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); after = cstate(two)
            return {'second': s2.get('phase'), 'said': said, 'picker disabled': shut, 'first': s1.get('phase'), 'after closing the first': after.get('phase'), 'error': after.get('error') or s2.get('error'),
                    'handed over': handed, 'hand-off left': left}
        finally:
            for p in (one, two):
                if not p.is_closed(): p.close()
    tabs = {}
    def another_tab_run():
        tabs.update(another_tab()); r = tabs
        return (r['second'] == 'in-another-tab' and r['said'].strip() == ANOTHER_TAB and 'createSyncAccessHandle' not in r['said']
                and 'Something went wrong' not in r['said'] and r['picker disabled'] and r['first'] == 'loaded'), r
    attempt('Chora in a second tab says plainly that Chora is open in another tab, and the first still opens a file', another_tab_run)
    attempt('Chora in a second tab starts once the first is closed', lambda: (bool(tabs) and tabs['after closing the first'] == 'ready', tabs))
    attempt('Chora in a second tab lets go of files handed over from the main page, which it cannot open',
            lambda: (bool(tabs) and tabs['second'] == 'in-another-tab' and (tabs['handed over'] or {}).get('names') == ['fresh.json'] and tabs['hand-off left'] is None, tabs))

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
            two.bring_to_front(); two.goto(NOTOOLS if PROVE else base + 'chora.html')
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
            panel = n.query_selector('#panel').bounding_box(); canvas = n.query_selector('#map canvas').bounding_box()
            x, y = map_centre(n); draw(n, 'point', [(x, y + 30)]); n.click('#draw-tools button[data-mode="static"]')
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
        trap = {'imgs': page.eval_on_selector_all('#card img', 'x => x.length'), 'pwned': page.evaluate('() => window.__pwned ?? null'), 'card': page.inner_text('#card')}
        chora_pick(page, 'control'); ctl = page.inner_text('#card')
        # The control: a radius that is a number is shown; the subject: the card was the trapdoor's, and holds a location.
        return (trap['imgs'] == 0 and trap['pwned'] is None and 'Trapdoor' in trap['card'] and 'Point' in trap['card'] and '±' not in trap['card']
                and '(±12.5 km)' in ctl), {'trapdoor': trap, 'control card': ctl[:300]}
    attempt('Chora: a place card shows a radius only when it is a number, and markup in a dataset is never run (a numeric one is shown)', markup_not_run)
    def draw_and_save(name, place, make=None):
        f = (make or odd_dataset)(name); chora_boot(page, base, [f]); chora_pick(page, place)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        x, y = map_centre(page); draw(page, 'point', [(x + 50, y + 30)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        return f, cstate(page), page.inner_text('#save-result')
    def problems_shown():
        _, s, text = draw_and_save('odd-problems.json', 'trapdoor'); ls = s.get('lastSave') or {}
        errs = [i for i in (ls.get('report') or {}).get('items', []) if i['severity'] == 'error']
        return (ls.get('passed') and errs and all(i['message'] in text for i in errs) and 'found problems' in text), {'passed': ls.get('passed'), 'errors': [i['message'] for i in errs], 'said': text[:400]}
    attempt('Chora: a save that passes the version check still shows the problems the writing of it found', problems_shown)
    def not_a_list():
        f, s, text = draw_and_save('odd-unlisted.json', 'oddity'); ls = s.get('lastSave') or {}
        written = opfs_names(page, 'chora-outputs')
        return (ls.get('passed') is False and 'attestations are not a list' in text and 'Oddity (https://example.org/p/oddity)' in text
                and not page.is_visible('#save-result button.primary') and 'odd-unlisted.chora.json' not in written and s['pendingCount'] == 1), {
                'save': {k: ls.get(k) for k in ('passed', 'added')}, 'said': text[:300], 'chora-outputs': written, 'pending': s.get('pendingCount')}
    attempt('Chora: a drawing for a place whose attestations are not a list is refused, naming the place, and no file is written or offered', not_a_list)

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
        chora_boot(page, base, [odd_dataset('lines-control.json')]); as_json = page.inner_text('#save')
        f, s, text = draw_and_save('lines.jsonl', 'after', jsonl_dataset); ls = s.get('lastSave') or {}
        as_lines = page.inner_text('#save')
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
                and has(r'comparing the two') and not page.is_visible('#save-progress')), {'passed': ls.get('passed'), 'steps': steps, 'still shown': page.is_visible('#save-progress')}
    attempt('Chora: a save shows each step on the page: writing the file, then the version check reading each version, n of N attestations, then comparing', save_steps)
    # The browser's storage: navigator.storage.estimate() is answered by the init script from
    # localStorage, set for these checks alone, so that a browser short of room can be had on demand.
    STUB = 'e2e-storage-estimate'
    def storage_short():
        try:
            page.evaluate('([k, v]) => localStorage.setItem(k, v)', [STUB, json.dumps({'quota': 1000000, 'usage': 999500})])
            f, s, text = draw_and_save('storage-short.json', 'control'); ls = s.get('lastSave') or {}
            load_warning = page.inner_text('#storage-warning') if page.is_visible('#storage-warning') else ''
            save_warning = page.inner_text('#save-storage-warning') if page.is_visible('#save-storage-warning') else ''
            short = s.get('storage') or {}
            # The control: with room, the same kind of file opens with no warning, and the answer given is the stub's.
            page.evaluate('([k, v]) => localStorage.setItem(k, v)', [STUB, json.dumps({'quota': 1e12, 'usage': 0})])
            room = chora_boot(page, base, [odd_dataset('storage-room.json')])
            quiet = not page.is_visible('#storage-warning') and room.get('phase') == 'loaded' and (room.get('storage') or {}).get('quota') == 1e12 and (room.get('storage') or {}).get('short') is False
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
            warning = page.inner_text('#storage-warning') if page.is_visible('#storage-warning') else ''
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

    # Over everything above: loading, drawing, saving, the hand-off and two tabs.
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
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
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
        page.fill('#paste', 'https://tiles.example.org/style.json')   # typed, not yet added
        page.click('[data-permission="basemap:osm"] button')
        until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        page.check('#permissions-panel fieldset.perm[data-key="basemap:osm"] input[value="allowed"]')
        page.click('#permissions-panel [data-reload]')
        asked = page.inner_text('#permissions-panel .perm-confirm') if page.is_visible('#permissions-panel .perm-confirm') else ''
        page.click('#permissions-panel [data-reload-cancel]'); page.keyboard.press('Escape')
        kept = page.input_value('#paste') if page.is_visible('#paste') else ''
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
        page_url = base + 'chora.html'
        fresh({'basemap:osm': {'state': 'allowed'}}, 'osm'); h0 = hits['osm']
        ctx.route(page_url, strip_head)
        try:
            page.goto(NOTOOLS if PROVE else page_url)
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
        x, y = map_centre(page); draw(page, 'point', [(x + 150, y + 60)]); page.click('#draw-tools button[data-mode="static"]')
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
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.fill('#paste', address); page.click('#paste-form button[type=submit]')
    def use_remembered():
        """After a reload, a pasted basemap is only remembered, never used until asked for in this load: ask (H2)."""
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        until(page, '() => !!document.getElementById("use-remembered")', 10)
        page.click('#use-remembered')
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
        text = page.inner_text('#basemap-options'); s = cstate(page)
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
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        line = page.inner_text('#basemap-remembered') if page.is_visible('#basemap-remembered') else ''
        checked = page.evaluate('() => document.querySelector("input[name=basemap]:checked")?.value || null')
        # The control: asked for by a click in this load, it is used and its tiles fetched.
        page.click('#use-remembered')
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
        chora_url = NOTOOLS if PROVE else base + 'chora.html'; main_url = NOTOOLS if PROVE else base
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
    attempt('both pages: framed by another origin, each hides itself behind one line (and the policy is still written); framed by this site\'s own origin, Chora runs as on its own', framed)

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
        return (meta == 'strict-origin-when-cross-origin' and referers.get('plain') == origin + '/' and 'chora.html' not in (referers.get('plain') or '')
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
        links = page.eval_on_selector_all('#card a[href^="http"], #contributor-line a[href^="http"]', 'as => as.map((a) => ({ href: a.getAttribute("href"), rel: a.rel }))')
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
        bad = {'line': page.inner_text('#contributor-line'), 'links': page.eval_on_selector_all('#contributor-line a[href]', 'as => as.map((a) => a.getAttribute("href"))'),
               'stored': json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')}
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test', orcid: '0000-0002-1825-0097' }))")
        chora_boot(page, base, [f])
        good = {'links': page.eval_on_selector_all('#contributor-line a[href]', 'as => as.map((a) => a.getAttribute("href"))'), 'stored': json.loads(page.evaluate("() => localStorage.getItem('chora-contributor')") or 'null')}
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

    # A hand-off Chora's page never took is let go by the main page when it starts, once it is no longer
    # fresh; a fresh one, on its way to Chora, is kept (the control).
    def handoff_stale_main():
        page.bring_to_front(); page.goto(NOTOOLS if PROVE else base)
        if wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready').get('phase') != 'ready': raise RuntimeError('the main page did not start')
        page.evaluate(IDB, True); page.reload()
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready'); page.wait_for_timeout(500)
        stale = page.evaluate(IDB, False)
        page.evaluate(IDB_FRESH); page.reload()
        wait_state(page, lambda s: s.get('phase') == 'ready', T(30), 'ready'); page.wait_for_timeout(500)
        fresh_kept = page.evaluate(IDB, False)
        page.evaluate('''() => new Promise((resolve) => { const q = indexedDB.open('plato-tools-chora', 1);
          q.onsuccess = () => { const db = q.result, t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete('chora-handoff'); t.oncomplete = () => { db.close(); resolve(true); }; }; })''')
        return stale is None and fresh_kept is not None and fresh_kept['names'] == ['fresh.json'], {'stale left': stale, 'fresh kept': fresh_kept}
    attempt('main page: a hand-off to Chora older than two minutes is let go when the main page starts; a fresh one is kept for Chora', handoff_stale_main)
    ctx.close()

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
        page.fill('#adopt-token', ADOPT_TOKEN); page.click('#adopt-token-form button[type="submit"]')
        until(page, '() => !document.getElementById("adopt-token")', 10)
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
        panel = page.inner_text('#adopt')
        out = {'line': line, 'send shown': send_shown, 'sent': len(calls) + len(asked) - before, 'panel': panel[:400],
               'policy': page.evaluate('() => (window.__platoCsp || {}).origins || null')}
        page.click('#adopt-permission button'); until(page, '() => document.getElementById("permissions-panel")?.open', 10)
        out['opened'] = page.evaluate(PANEL_STATE)
        return (line.startswith('Needs permission: World Historical Gazetteer') and send_shown is False and out['sent'] == 0 and out['policy'] == []
                and W3 not in panel and 'Your WHG token' in panel and 'privacy' not in panel.lower() and 'this tab' not in panel
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
        return (len(posts) == 1 and list(body.get('queries', {}).values()) == [{'query': 'Newcastle', 'type': 'Place', 'limit': 10}]
                and [c['id'] for c in cands] == ['place:gn:2641591', 'place:gn:2641673', 'place:tgn:7011781', 'place:gn:2155472']
                and [c['inArea'] for c in cands] == [True, True, False, False] and a.get('reference') == 'box'
                and sorted(markers) == sorted(listed) and len(markers) == 4 and cstate(page)['pendingCount'] == 0), {
            'posts': len(posts), 'queries': body.get('queries'), 'order': [c['id'] for c in cands], 'markers': markers, 'listed': listed, 'pending': cstate(page)['pendingCount']}
    attempt("Chora adopt: allowed, one query is sent (type Place, the name typed), and the four Newcastles are listed and on the map, numbered alike, GB's first (WHG gave Tyne last), nothing adopted yet", lookup)
    def headers():
        posts = [c for c in calls if c['method'] == 'POST']
        auth = [c['headers'].get('authorization') for c in posts]
        return (bool(posts) and all(x == f'Bearer {ADOPT_TOKEN}' for x in auth) and not any(ADOPT_TOKEN in c['url'] for c in calls)
                and not any(ADOPT_TOKEN in u for u in asked)), {'posts': len(posts), 'auth': [bool(x) for x in auth]}
    attempt('Chora adopt: the token goes in the Authorization header of the POST (the control), and in no address', headers)
    def ranked_words():
        text = page.inner_text('#adopt-candidates') if page.is_visible('#adopt-candidates') else ''
        order = page.inner_text('#adopt-order') if page.is_visible('#adopt-order') else ''
        return ('inside the area' in text and 'outside the area' in text and 'km away' not in text and 'same spelling' in text and 'Licence of its source' in text
                and "relative to the best in this search" in text and 'its countries first' in order and 'Nothing is chosen for you' in order), {'order': order, 'text': text[:500]}
    attempt('Chora adopt: with only a country, each candidate says inside or outside the area (no distance), same spelling, its licence, and WHG\'s figures with their caveat', ranked_words)

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
        page.fill('#q', 'newcastle'); until(page, '() => document.querySelectorAll("#list button[data-id]").length >= 2', 10)
        page.click(f'#list button[data-id="{P}newcastle-nsw"]'); until(page, f'() => window.__chora.placeId === "{P}newcastle-nsw"', 10)
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
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page).get('lastSave') or {}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
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
        page.click('#card #adopt-find') if page.is_visible('#card #adopt-find') else None
        until(page, '() => window.__chora.adopt && window.__chora.adopt.open', 10)
        q = look_up('Quota'); qt = page.inner_text('#adopt-status')
        kept_after_quota = page.evaluate("() => sessionStorage.getItem('plato-tools.whg-token')")
        b = look_up('Broken'); bt = page.inner_text('#adopt-status'); retry = page.is_visible('#adopt-retry')
        t = look_up('Badtoken'); tt = page.inner_text('#adopt-status')
        return (q.get('problem') == 'quota' and 'try again tomorrow' in qt and kept_after_quota == ADOPT_TOKEN
                and b.get('problem') == 'unanswered' and 'not a finding' in bt and retry and not b.get('candidates')
                and t.get('problem') == 'auth' and 'Give it again' in tt and page.is_visible('#adopt-forget')), {'quota': [q.get('problem'), qt], 'broken': [b.get('problem'), bt, retry], 'auth': [t.get('problem'), tt]}
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
        notes = page.inner_text('#adopt') 
        return ('whether it holds this record is not known' in cluster and st.get('cluster on novocastria') is False
                and done.get('count') == 1 and not page.is_visible('#adopt-refused') and not errors), {'cluster': cluster, 'novocastria': st.get('cluster on novocastria'), 'done': done, 'errors': errors[:3]}
    attempt("Chora adopt: a place linked only to a WHG cluster page says so (one linked to a record does not); a place whose @id is the record's w3id adopts the location only, with no error", cluster_and_same)
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
    focus: document.activeElement ? (document.activeElement.id || document.activeElement.name || document.activeElement.tagName) : null }; }'''

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
        for p in METHODOS_PREDICTED:
            ctx, page = fresh()
            try:
                answer(page, p['have'], p['want'], p['yes'])
                s = st(page)
                plan = [x['id'] for x in s['plan']]
                ok = (s['recipe'] == p['recipe'] and plan == p['steps'] and all(x['state'] == 'todo' and x['words'] == 'To come' for x in s['plan'])
                      and s['follow'] and s['blocked'] is None and str(len(p['steps'])) in s['verdict'])
                out[f"{p['have']}+{p['want']}"] = (ok, {'recipe': s['recipe'], 'plan': plan, 'verdict': s['verdict'], 'follow': s['follow']})
            finally: ctx.close()
        return len(out) == len(METHODOS_PREDICTED) and all(v[0] for v in out.values()), {k: v[1] for k, v in out.items()}
    attempt("Methodos: the interview's answers give the recipe and the steps test/methodos-predicted.json predicts, for each of its rows", predicted)

    def tracker():
        # Follow the first prediction (Map your data): the tracker above step 1 shows every step, the first
        # now and the rest to come; the first is Hermes's columns (no #tool=, said in #for-tool); a step
        # done moves to Elenchos's check, which chooses #tool=check; back a step returns; leaving clears all.
        p = METHODOS_PREDICTED[0]
        ctx, page = fresh()
        try:
            answer(page, p['have'], p['want'], p['yes'])
            page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
            a = st(page)
            order = page.evaluate("() => { const t = document.getElementById('methodos-tracker'), f = document.getElementById('files'); return !!(t.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); }")
            page.click('#methodos-done'); b = st(page)
            page.click('#methodos-back'); c = st(page)
            page.click('#methodos-done'); page.click('#methodos-leave'); d = st(page)
            ids = [x['id'] for x in a['track']]
            first_ok = (a['tracker'] and not a['interview'] and not a['banner'] and order and a['trackerRecipe'] == p['recipe'] and ids == p['steps']
                        and a['track'][0]['state'] == 'current' and a['track'][0]['current'] == 'step' and a['track'][0]['words'] == 'Now'
                        and all(x['state'] == 'todo' and x['current'] is None for x in a['track'][1:])
                        and a['hash'] == '' and a['tool'] is None and a['note'] and f"step 1 of {len(ids)}" in a['note'] and 'Hermes' in a['note']
                        and a['where'].startswith(f"Step 1 of {len(ids)}") and '%' not in a['where'] + a['note'] and a['focus'] == 'methodos-tracker-h')
            second_ok = (b['track'][0]['state'] == 'done' and b['track'][0]['words'] == 'Done' and b['track'][1]['state'] == 'current'
                         and b['hash'] == '#tool=check' and b['tool'] == 'check' and 'Elenchos' in (b['note'] or '') and f"step 2 of {len(ids)}" in (b['note'] or ''))
            back_ok = c['track'][0]['state'] == 'current' and c['hash'] == '' and c['tool'] is None
            left_ok = not d['tracker'] and d['banner'] and d['hash'] == '' and d['tool'] is None and d['note'] is None and d['files']
            return first_ok and second_ok and back_ok and left_ok, {'started': a, 'above step 1': order, 'one done': b, 'back': c, 'left': d}
        finally: ctx.close()
    attempt('Methodos: the tracker above step 1 shows the workflow\'s steps as now and to come, and each step chooses its tool (#tool=) and says itself in #for-tool; back and leave undo it', tracker)

    def unavailable():
        # Has regions, answered Yes: the workflow is not refused. The regions step is in the plan and the
        # tracker, "Not yet available" with the engine's reason, and is skipped: the first step is now, the
        # count leaves it out, Done never stops on it, and the last step notes that the regions were not
        # identified. No "Answer No" (an absence, beside the Follow button and the reason, presences).
        ctx, page = fresh()
        try:
            answer(page, 'table', 'map', {'has-regions': True, 'will-draw': False, 'will-publish': False})
            a = st(page)
            page.click('#methodos-start'); until(page, "!document.getElementById('methodos-tracker').hidden", 5)
            b = st(page)
            seen = []
            for _ in range(12):
                cur = next((x['id'] for x in st(page)['track'] if x['state'] == 'current'), None)
                if cur is None: break
                seen.append(cur); page.click('#methodos-done')
            last = page.evaluate("() => document.querySelector('#methodos-track li.track-step:last-child .track-end')?.textContent || null")
            c = st(page)
            r = next((x for x in a['plan'] if x['id'] == 'regions'), None)
            t = next((x for x in b['track'] if x['id'] == 'regions'), None)
            avail = [x['id'] for x in a['plan'] if x['id'] != 'regions']
            ok = (r is not None and r['state'] == 'unavailable' and r['words'] == 'Not yet available' and 'Regions cannot be identified yet' in (r['why'] or '')
                  and a['follow'] and a['blocked'] is None and 'Answer No' not in page.evaluate("() => document.getElementById('methodos').textContent")
                  and f"in {len(avail)} steps" in a['verdict']
                  and b['tracker'] and t is not None and t['state'] == 'unavailable' and 'Regions cannot be identified yet' in (t['why'] or '')
                  and b['track'][0]['state'] == 'current' and b['where'].startswith(f"Step 1 of {len(avail)}")
                  and seen == avail and 'regions were not identified' in (last or '') and c['where'].startswith('Every one'))
            return ok, {'plan': a, 'started': b, 'steps taken': seen, 'last step notes': last, 'at the end': c['where']}
        finally: ctx.close()
    attempt('Methodos: with regions answered Yes the workflow is followed, its regions step shown as "Not yet available" with its reason and skipped, and the last step notes the regions were not identified', unavailable)

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
        page.fill('#map-input', text if isinstance(text, str) else json.dumps(text)); page.click('#map-form button[type=submit]')
    def ready():
        until(page, '() => window.__chora && window.__chora.phase !== "reloading" && window.__chora.mapReadyCount >= 1 && window.__chora.canary && window.__chora.canary !== "pending"', 60)
    def line(key):
        sel = f'#map-needs [data-permission="{key}"]'
        return page.inner_text(sel) if soon(page, 's => { const e = document.querySelector(s); return !!e && !e.hidden; }', 15, sel) else ''
    def panel_set(keys, to='allowed', reload=False, via=None):
        """Open the panel (from a map's "Needs permission" line when `via` is given, else the header's button), set each permission, and reload as the panel offers."""
        page.click(f'#map-needs [data-permission="{via}"] button' if via else '#permissions-button')
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
        typed = page.input_value('#map-input')
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
        offered = soon(page, '() => document.querySelectorAll("#map-choice input[name=georef-choice]").length === 2', 15)
        said = page.inner_text('#map-status')
        checked = page.get_attribute('#map-choice input[name=georef-choice]:checked', 'value') if offered else None
        if offered: page.click('#map-choose')
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
        said = soon(page, '() => /plain https address/.test(document.getElementById("map-status").textContent)', 10)
        text = page.inner_text('#map-status')
        return (said and 'my_host.example.org' in text and not page.query_selector('#map-needs [data-permission]') and len(errors) == before and census(since) == []), {'said': text, 'page errors': errors[before:]}
    attempt('Chora maps: a map on a site that cannot be a permission (nor in the page\'s policy) is refused in plain words, with no line asking for it and no error in the page', bad_site)

    def forwards():
        # An ARK-like address on A, which answers with a redirect to another host (B): refused in c2's
        # words, naming no host, with the address offered as a link to open in a new tab; B is asked nothing.
        since = len(census()); ark = A + '/ark/50959/x/manifest'
        paste(ark)
        said = soon(page, '() => /forwards to another one/.test(document.getElementById("map-status").textContent)', 15)
        text = page.inner_text('#map-status')
        link = page.evaluate('() => { const a = document.getElementById("map-forwards"); return a ? { href: a.href, target: a.target, rel: a.rel } : null; }')
        rows = census(since)
        return (said and 'Open it in a new tab, and paste the address it ends at.' in text and urlparse(B).netloc not in text and link and link['href'] == ark
                and link['target'] == '_blank' and 'noopener' in link['rel'] and [r['status'] for r in at_origin(rows, A)] == [302] and at_origin(rows, B) == []), {
            'said': text, 'link': link, 'census': [(r['port'], r['status'], r['path']) for r in rows]}
    attempt('Chora maps: an address that forwards to another host is refused in plain words naming no host, offered as a link to open in a new tab; that host is asked nothing', forwards)

    def foreign_id():
        since = len(census())
        paste(annotation(service='/iiif/foreign', id='https://annotations.allmaps.org/maps/000000000000000f'))
        refused = soon(page, '() => /not shown/.test(document.getElementById("map-status").textContent)', 20)
        said = page.inner_text('#map-status'); rows = census(since)
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
        said = page.inner_text('#overlay-list'); csp = page.evaluate('() => window.__platoCsp')
        return (admitted and failed and any(p.startswith('/iiif/redirect/') and p.endswith('default.jpg') for p in a_paths)
                and any(r['status'] == 302 for r in at_origin(rows, A)) and at_origin(census(), B) == [] and honest.get('tilesLoaded', 0) > 0
                and A in csp['origins'] and B not in csp['origins'] and 'could not be loaded' in said), {
            'failed': failed, 'A': [(r['status'], r['path']) for r in at_origin(rows, A)], 'B, whole run': at_origin(census(), B), 'honest map': honest,
            'policy': csp['origins'], 'said': said[-300:], 'events': cstate(page).get('overlayEvents')}
    attempt('Chora maps: a tile answered by a redirect to another site is stopped by the page\'s policy in the built page\'s tile workers (that site gets no request at all, and is not in the policy), while the honest map drew', redirect)

    def lookup():
        hits = len(allmaps_hits)
        paste(A + '/manifests/grid/manifest')
        offered = soon(page, '() => !!document.getElementById("map-lookup")', 20)
        offer = page.inner_text('#map-status')
        editor_before = page.query_selector('#map-editor, #overlay-list a[data-editor]') is not None
        page.click('#map-lookup')
        said = line(ALLMAPS_KEY)
        page.wait_for_timeout(500)
        before = len(allmaps_hits) - hits                          # nothing asked of Allmaps before it is allowed
        panel_set([ALLMAPS_KEY], reload=True, via=ALLMAPS_KEY)
        got = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 30, 'https://annotations.allmaps.org/maps/0000000000000003')
        asked = allmaps_hits[hits:]
        editor = page.get_attribute('#overlay-list a[data-editor]', 'href') if page.query_selector('#overlay-list a[data-editor]') else ''
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
        offered = soon(page, '() => /no georeference/.test(document.getElementById("map-status")?.innerText || "")', 20)
        editor = page.query_selector('#map-editor, #overlay-list a[data-editor]') is not None
        listed = page.evaluate('() => window.__chora.overlays.length')
        asked = len(allmaps_hits) - hits
        panel_set([ALLMAPS_KEY], to='allowed')                   # put back for the checks after this one
        back = soon(page, '() => !!document.querySelector("#overlay-list a[data-editor]")', 20) if listed else True
        return offered and not editor and asked == 0 and back, {'offered': offered, 'editor shown under Never': editor, 'Allmaps asked': asked, 'back once allowed': back}
    attempt('Chora maps: with Allmaps set to Never the Editor link is absent (the offer is still made, and Allmaps is asked nothing); allowed again, it is back', editor_never)

    def controls():
        s = cstate(page); keys = [o['key'] for o in s['overlays']]
        if not keys: raise RuntimeError('no map shown')
        k = next(o['key'] for o in s['overlays'] if o['annotationId'] == grid_id)
        row = f'#overlay-list li[data-overlay="{k}"]'
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
            page.click(f'#overlay-list li[data-overlay="{x}"] button[data-remove-map]')
            until(page, 'x => !window.__chora.overlays.some((o) => o.key === x)', 10, x)
        left = page.evaluate('() => window.__chora_overlays.layer.getMapIds()')
        kept_maps = opfs_names(page, 'chora-overlays')
        return (abs(o['opacity'] - 0.4) < 1e-9 and o['visible'] is False and at['open'] and at['focusKey'] == IA and len(others) >= 3 and len(left) == 1
                and kept_maps == [f'{k}.json'] and [x['key'] for x in cstate(page)['overlays']] == [k]), {'map options': o, 'panel': at, 'removed': len(others), 'left': left, 'kept': kept_maps}
    attempt('Chora maps: opacity and show reach the renderer; a map\'s Permissions… opens the panel at its server; a map removed leaves the map, the list and the browser\'s store', controls)

    def trace_save():
        f = tmp / 'chora-files' / 'cambridge.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Traced'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/cambridge', 'label': 'Cambridge', 'attestations': [{'names': [{'toponym': 'Cambridge'}], 'sources': [{'title': 's'}]}]}]}))
        chora_boot(page, base, [f]); chora_pick(page, 'cambridge')
        until(page, '() => window.__chora.overlays.length === 1 && window.__chora.overlays[0].firstTile', 30)
        page.click('#overlay-list button[data-fit]'); page.evaluate(SETTLE)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        xy = page.evaluate("""async () => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: [256, 256] }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }""")
        draw(page, 'point', [tuple(xy)]); page.click('#draw-tools button[data-mode="static"]')
        traced = soon(page, '() => window.__chora.lastTrace && window.__chora.lastTrace.key', 15)
        card = page.inner_text('#card'); lt = cstate(page).get('lastTrace') or {}
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'save': ls, 'card': card[-400:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
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
        KEPT = """async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts');
          for await (const h of d.values()) { const x = JSON.parse(await (await h.getFile()).text()); if (x.fingerprint.startsWith('cambridge.json')) return x.drafts.map((k) => [!!k.trace, k.role || '', k.precision || '']); } return null; }"""
        page.evaluate(SETTLE)
        x, y = page.evaluate(PX, [200, 200]); n0 = cstate(page)['pendingCount']
        draw(page, 'point', [(x, y)]); page.click('#draw-tools button[data-mode="static"]')
        traced = soon(page, 'n => window.__chora.lastTrace && window.__chora.lastTrace.key && window.__chora.pendingCount === n + 1', 15, n0)
        first = cstate(page).get('lastTrace')
        tx, ty = page.evaluate(PX, [504, 256])                  # on the image, outside the mask (16 to 496)
        page.click('#draw-tools button[data-mode="select"]')
        tap(page, x, y)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move((x + tx) / 2, (y + ty) / 2, steps=6); page.mouse.move(tx, ty, steps=6); page.mouse.up()
        page.click('#draw-tools button[data-mode="static"]')
        dropped = soon(page, '() => window.__chora.lastTrace && !window.__chora.lastTrace.key', 15)
        note = page.inner_text('#card [data-trace-note]') if page.query_selector('#card [data-trace-note]') else ''
        k = page.evaluate(KEPT)
        # Off the map, it is a point drawn on the basemap: the traced point's defaults go with the citation.
        # (The drawing saved by the check before is still kept: its download was not let go.)
        return (traced and first and first.get('key') and dropped and 'no longer cites that map' in note and k and k[-1] == [False, '', '']), {'first': first, 'after': cstate(page).get('lastTrace'), 'note': note, 'kept': k}
    attempt('Chora maps: a traced point moved off its map with the Edit tool no longer cites the map, the card says so, and its traced-point defaults go', moved_off)

    def reshaped_onto_another():
        # Two maps of the same image, each holding one corner (X the top left, Y the bottom right), the
        # whole grid hidden: a point traced from X and moved onto Y is traced from Y, and Y alone is offered.
        def corner(mid, pts):
            a = annotation(id=mid); a['target']['selector'] = {'type': 'SvgSelector', 'value': f'<svg width="512" height="512"><polygon points="{pts}" /></svg>'}; return a
        xid, yid = 'https://annotations.allmaps.org/maps/00000000000000f1', 'https://annotations.allmaps.org/maps/00000000000000f2'
        grid_key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == grid_id)
        page.uncheck(f'#overlay-list li[data-overlay="{grid_key}"] input[data-show]')
        for mid, pts in ((xid, '16,16 250,16 250,250 16,250 16,16'), (yid, '260,260 496,260 496,496 260,496 260,260')):
            paste(corner(mid, pts))
            if not soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.mapId)', 20, mid): return False, {'not shown': mid}
        keys = {o['annotationId']: o['key'] for o in cstate(page)['overlays']}
        page.click(f'#overlay-list li[data-overlay="{grid_key}"] button[data-fit]'); page.evaluate(SETTLE)
        PX = """async (px) => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: px }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }"""
        x, y = page.evaluate(PX, [100, 100]); n0 = cstate(page)['pendingCount']
        draw(page, 'point', [(x, y)]); page.click('#draw-tools button[data-mode="static"]')
        first = soon(page, '([k, n]) => window.__chora.lastTrace && window.__chora.lastTrace.key === k && window.__chora.pendingCount === n + 1', 15, [keys[xid], n0])
        tx, ty = page.evaluate(PX, [400, 400])
        page.click('#draw-tools button[data-mode="select"]')
        tap(page, x, y)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move((x + tx) / 2, (y + ty) / 2, steps=6); page.mouse.move(tx, ty, steps=6); page.mouse.up()
        page.click('#draw-tools button[data-mode="static"]')
        moved = soon(page, 'k => window.__chora.lastTrace && window.__chora.lastTrace.key === k', 15, keys[yid])
        lt = cstate(page).get('lastTrace') or {}
        offered = page.evaluate('() => [...document.querySelectorAll(\'#card li[data-draft]:last-child select[data-field="tracedFrom"] option\')].map((o) => o.value)')
        # Back as the checks after this one expect: the corners gone, the grid shown.
        for mid in (xid, yid):
            page.click(f'#overlay-list li[data-overlay="{keys[mid]}"] button[data-remove-map]')
            until(page, 'k => !window.__chora.overlays.some((o) => o.key === k)', 10, keys[mid])
        page.check(f'#overlay-list li[data-overlay="{grid_key}"] input[data-show]')
        return (first and moved and lt.get('options') == [keys[yid]] and keys[xid] not in offered and keys[yid] in offered), {'first': first, 'moved': moved, 'trace': lt, 'offered': offered}
    attempt('Chora maps: a point traced from one map and moved onto another it alone lies on is traced from that one, which alone is offered', reshaped_onto_another)

    def come_back():
        KEPT_MAPS = '''async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays'); const out = [];
          for await (const h of d.values()) { const x = JSON.parse(await (await h.getFile()).text()); out.push({ key: x.key, visible: x.visible, opacity: x.opacity }); } return out; }'''
        # The map is shown, and kept as shown, before the reload: the check before this one ticked "Show" last,
        # and the record is written after the tick, not with it (a reload at once would find it kept hidden).
        grid_key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == grid_id)
        kept_shown = soon(page, 'k => window.__chora.overlays.some((o) => o.key === k && o.visible)', 10, grid_key) and soon(page, f'async (k) => ({KEPT_MAPS})().then((m) => m.some((x) => x.key === k && x.visible === true))', 10, grid_key)
        page.reload(); ready()
        back = shown(grid_id)
        # Said on failure: what is kept of each map (shown or hidden), what the page shows, and where the map is.
        kept_maps = page.evaluate(KEPT_MAPS)
        view = page.evaluate('() => { const m = window.__chora_map; return { zoom: m.getZoom(), center: m.getCenter().toArray() }; }')
        return kept_shown and back and at_origin(census(), B) == [], {'kept as shown before': kept_shown, 'came back': back, 'kept': kept_maps, 'overlays': cstate(page)['overlays'], 'view': view}
    attempt('Chora maps: a map shown comes back on the next load', come_back)

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
        silent = page.evaluate('() => [...document.querySelectorAll("#map-needs [data-permission]")].filter((e) => !e.hidden).length') == 0 and page.inner_text('#map-status').strip() == ''
        since = len(census())
        paste(annotation(id='https://annotations.allmaps.org/maps/0000000000000099'))
        said = soon(page, '() => /set to Never in Permissions/.test(document.getElementById("map-status").textContent)', 10)
        page.wait_for_timeout(1000)
        rows = census(since)
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (gone and silent and said and rows == []), {'taken off': gone, 'nothing said of the kept map': silent, 'said of the new one': page.inner_text('#map-status'), 'census': rows}
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
        both_lines = soon(page, 'ks => ks.every((k) => { const e = document.querySelector(`#map-needs [data-permission="${k}"]`); return e && !e.hidden; })', 30, [IA, f'iiif:{A2}'])
        navs = []; listen = lambda fr: navs.append(fr.url) if fr == page.main_frame else None
        page.on('framenavigated', listen)
        if both_lines:
            page.click(f'#map-needs [data-permission="{IA}"] button')
            until(page, '() => document.getElementById("permissions-panel")?.open', 10)
            for k in (IA, f'iiif:{A2}'):
                page.click(f'#permissions-panel fieldset.perm[data-key="{k}"] input[value="allowed"]')
                until(page, 'k => document.querySelector(`#permissions-panel fieldset.perm[data-key="${k}"] input[value="allowed"]`)?.checked', 10, k)
            with page.expect_navigation(timeout=T(60) * 1000): page.click('#permissions-panel [data-reload]')
            ready()
        both = soon(page, 'ids => ids.every((id) => window.__chora.overlays.some((o) => o.annotationId === id))', 40, [grid_id, pid])
        page.wait_for_timeout(1000); page.remove_listener('framenavigated', listen)
        return (both_lines and both and len(navs) == 1 and not page.query_selector('#map-needs [data-permission]:not([hidden])')), {
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
        for i in (kid, pid):
            page.evaluate("k => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-overlays')).then((d) => d.removeEntry(k + '.json')).catch(() => {})", key(i))
        return (waiting and pasted_waits and f'Needs permission: {urlparse(A).netloc}' in said and kid not in before and pid not in before and both
                and (handed.get('pending') or {}).get('text') == text and handed.get('readmit') is True), {
            'kept map waiting': waiting, 'pasted map waiting': pasted_waits, 'line': said, 'shown before': before, 'both shown': both, 'handed over': {k: v for k, v in handed.items() if k != 'typed'},
            'overlays': [o['annotationId'] for o in s['overlays']]}
    attempt('Chora maps: a map kept waiting on a withdrawn site and a map pasted on it: allowed from the line, one reload brings back both (the maps kept never take the place of the map pasted)', kept_and_pasted)

    KEPT_ITEMS = """async () => { const out = {}; try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-overlays');
      for await (const h of d.values()) out[h.name] = JSON.parse(await (await h.getFile()).text()).item; } catch {} return out; }"""
    def kept_as_written():
        # A map with no georeference id, its image written with a trailing slash (which the image information
        # does not have): kept as written, so that the next load reads, cites and keys the same map, in one file.
        # (The http-to-https difference the unit test checks cannot be made here: this computer's sites stay http.)
        a = annotation(service='/iiif/grid/'); a.pop('id', None)
        before = set(page.evaluate(KEPT_ITEMS))
        paste(a)
        got = soon(page, '() => window.__chora.overlays.some((o) => !o.annotationId && o.mapId)', 20)
        first = {}
        for _ in range(20):                                       # the keeping is not awaited by the page: asked until written
            first = {k: v for k, v in page.evaluate(KEPT_ITEMS).items() if k not in before}
            if first: break
            page.wait_for_timeout(500)
        written = bool(first)
        page.reload(); ready()
        back = soon(page, '() => window.__chora.overlays.some((o) => !o.annotationId && o.mapId)', 30)
        page.wait_for_timeout(1000)
        second = {k: v for k, v in page.evaluate(KEPT_ITEMS).items() if k not in before}
        ids = [v['target']['source']['id'] for v in first.values()]
        key = next(iter(first), '').removesuffix('.json')
        if key: page.click(f'#overlay-list li[data-overlay="{key}"] button[data-remove-map]')
        return (got and written and len(first) == 1 and ids == [A + '/iiif/grid/'] and back and second == first), {'shown': got, 'kept': ids, 'files before reload': list(first), 'files after': list(second), 'came back': back}
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
        at_load = page.inner_text('#map-status').strip()
        paste(annotation())                                       # shown already: its status line
        said = soon(page, '() => /is shown already/.test(document.getElementById("map-status").textContent)', 15)
        panel_set([ALLMAPS_KEY], 'allowed'); page.wait_for_timeout(1500)
        after = page.inner_text('#map-status')
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
        told = soon(page, '() => /set to Never in Permissions/.test(document.getElementById("map-status").textContent)', 10)
        lines = page.evaluate('() => [...document.querySelectorAll("#map-needs [data-permission]")].filter((e) => !e.hidden).length')
        rows = at_origin(census(since), A)
        text = page.inner_text('#map-status')
        panel_set([IA], 'allowed')                               # for the checks after this one
        return (f'Needs permission: {urlparse(A).netloc}' in said and told and lines == 0 and rows == []), {'line': said, 'status': text, 'lines left': lines, 'asked of A': rows}
    attempt('Chora maps: a map pasted, waiting on "Needs permission", set to Never in the panel says its site is set to Never, and its line goes', never_after_line)

    def no_policy():
        page_url = base + 'chora.html'
        ctx.route(page_url, strip_head)
        try:
            page.goto(NOTOOLS if PROVE else page_url)
            until(page, '() => window.__chora && window.__chora.canary && window.__chora.canary !== "pending" && window.__chora.mapReadyCount >= 1', 30)
            since = len(census())
            paste(annotation(id='https://annotations.allmaps.org/maps/0000000000000011'))
            said = soon(page, '() => /cannot be shown in this browser/.test(document.getElementById("map-status").textContent)', 20)
            text = page.inner_text('#map-status'); page.wait_for_timeout(1000)
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
TRACE_TIP = '() => [...document.querySelectorAll("#draw-tools button[data-trace]")].map((b) => [b.getAttribute("aria-disabled"), b.disabled, b.dataset.tip, b.hasAttribute("title")])'

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
                page.click(f'#overlay-list li[data-overlay="{o["key"]}"] button[data-remove-map]')
                until(page, 'k => !window.__chora.overlays.some((o) => o.key === k)', 10, o['key'])
        key = next(o['key'] for o in cstate(page)['overlays'] if o['annotationId'] == id_)
        page.click(f'#overlay-list li[data-overlay="{key}"] button[data-fit]'); page.evaluate(SETTLE)
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
                    with page.expect_navigation(timeout=T(60) * 1000): page.click(f'#map-needs [data-permission="{IA}"] button')
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
        """The maps kept let go, from a page of the same site that is not Chora's: a Chora page brings its maps kept
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
        page.mouse.move(1, 1); page.hover('#draw-tools button[data-trace="line"]')
        tip_before = [t['text'] for t in shown_tips(page, 'Show a historical map to trace from it')]
        waiting = (cstate(page).get('traceReady') is False and all(b[0] == 'true' and b[1] is False and not b[3] for b in buttons) and tip_before == ['Show a historical map to trace from it'])
        # Clicked while not offered, it does nothing. A plain page.click would wait for ever: Playwright (1.59)
        # counts a button with aria-disabled="true" as disabled, so force=True clicks it where it is, as a user does.
        page.click('#draw-tools button[data-trace="line"]', force=True); page.wait_for_timeout(300)
        inert = page.get_attribute('#draw-tools button[data-trace="line"]', 'aria-pressed') != 'true' and not page.evaluate('() => !!window.__chora_ink?.mode')
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
        page.click('#draw-tools button[data-trace="line"]')
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
        card = page.inner_text('#card')
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'start': start, 'save': ls, 'card': card[-300:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
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
        page.click('#draw-tools button[data-trace="area"]')
        click_image(a['id'], (520, 210))
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        ink = cstate(page)['ink']
        if ink['phase'] != 'proposed': return False, {'ink': ink}
        ring = [tuple(p) for p in ink['last']['image']['coordinates'][0]]
        hd = hausdorff(ring, INK_WASH + [INK_WASH[0]])
        drawn = soon(page, PROPOSAL_DRAWN, 10)
        # A slider moved proposes again from the window already read: the server is asked for nothing more.
        n, asked_before = ink['proposals'], len(census())
        page.fill('#ink-panel input[data-p="tolerance"]', '22')
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
        page.click('#draw-tools button[data-trace="area"]') if page.get_attribute('#draw-tools button[data-trace="area"]', 'aria-pressed') != 'true' else None
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
            page.click('#draw-tools button[data-trace="area"]')
            soon(page, '() => document.querySelector(\'#draw-tools button[data-trace="area"]\').getAttribute("aria-pressed") === "true"', 5)
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
        return (not_yet and proposed and drawn and ink.get('mode') == 'area'), {'held': len(held), 'before the chunk': {'ink': before.get('ink'), 'pressed': page.get_attribute('#draw-tools button[data-trace="area"]', 'aria-pressed')}, 'proposed': proposed, 'drawn': drawn, 'ink': {k: ink.get(k) for k in ('phase', 'mode', 'proposals', 'lastError')}}
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
            if page.get_attribute('#draw-tools button[data-trace="area"]', 'aria-pressed') != 'true': page.click('#draw-tools button[data-trace="area"]')
            click_image(a['id'], (520, 210))
            until(page, 'n => !!window.__chora.ink && window.__chora.ink.proposals > n && window.__chora.ink.phase === "proposed"', 60, n)
        # Enter with nothing focused accepts (the positive control; it also makes a drawing, so Save can be used).
        propose()
        acc0 = cstate(page)['ink']['accepted']; page.evaluate(blur); page.keyboard.press('Enter')
        accepted = soon(page, 'n => window.__chora.ink.accepted === n + 1', 10, acc0)
        # Enter on Save, a proposal live: Save saves, and the proposal is not accepted.
        propose()
        acc1 = cstate(page)['ink']['accepted']
        page.focus('#save'); page.keyboard.press('Enter')
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
        page.click('#draw-tools button[data-trace="area"]')
        click_image(a['id'], (520, 210))
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        ink = cstate(page)['ink']
        if ink['phase'] != 'proposed': return False, {'ink': ink}
        holes = ink['last']['holes']
        # No place chosen yet: Enter keeps the proposal and says to choose a place; nothing is drawn.
        page.evaluate('() => document.activeElement && document.activeElement.blur()')
        page.keyboard.press('Enter'); page.wait_for_timeout(500)
        s0 = cstate(page); status0 = page.inner_text('#ink-panel [data-ink-status]')
        kept_ = s0['ink']['phase'] == 'proposed' and s0['pendingCount'] == before and soon(page, PROPOSAL_DRAWN, 10)
        chora_pick(page, 'cambridge')
        page.evaluate('() => document.activeElement && document.activeElement.blur()')
        page.keyboard.press('Enter')
        until(page, 'n => window.__chora.pendingCount === n + 1 && window.__chora.lastTrace && window.__chora.lastTrace.key', 20, before)
        lt = cstate(page)['lastTrace']; card = page.inner_text('#card')
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'save': ls, 'card': card[-300:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
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
        page.click('#draw-tools button[data-mode="linestring"]')
        offered = page.is_visible('#snap-ink')
        page.mouse.move(1, 1); page.hover('#snap-ink')
        tip = [t['text'] for t in shown_tips(page, 'goes onto it')]
        page.check('#snap-ink')
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
        page.click('#draw-tools button[data-mode="linestring"]')
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
            page.click('#draw-tools button[data-mode="linestring"]')
            builds = (cstate(page).get('ink') or {}).get('snapBuilds', 0)
            page.check('#snap-ink')
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
        page.click('#draw-tools button[data-mode="linestring"]'); page.check('#snap-ink')
        until(page, '() => window.__chora.ink && window.__chora.ink.snapBuilds >= 1 && window.__chora.ink.snapPoints > 0', 30)
        pan = '([dx]) => window.__chora_map.panBy([dx, 0], { duration: 0 })'
        n0 = cstate(page)['ink']['snapBuilds']
        page.evaluate(pan, [40]); page.evaluate(SETTLE)
        rebuilt = soon(page, 'n => window.__chora.ink.snapBuilds > n', 15, n0)
        page.click('#draw-tools button[data-mode="point"]')
        hidden = page.is_hidden('#snap-ink-label')
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
        refused = soon(page, '() => /may not allow other sites to read it/.test(document.getElementById("map-status").textContent)', 30)
        text = page.inner_text('#map-status')
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
        page.click('#draw-tools button[data-trace="line"]')
        click_image(a['id'], INK_RIVER[50])
        until(page, '() => ["proposed", "error"].includes(window.__chora.ink?.phase)', 60)
        s = cstate(page); panel = page.inner_text('#ink-panel')
        page.keyboard.press('Enter'); page.wait_for_timeout(500)
        rows = census(since)
        return (s['ink']['phase'] == 'error' and '403' in (s['ink']['lastError'] or '') and 'IIIF Auth' in s['ink']['lastError'] and '403' in panel
                and cstate(page)['pendingCount'] == before and any(r['status'] == 403 for r in at_origin(rows, A)) and at_origin(rows, B) == []), {
            'ink': s['ink'].get('lastError'), 'panel': panel[:200], 'statuses': sorted({r['status'] for r in at_origin(rows, A)})}
    attempt('Chora ink: a server that refuses the map\'s pixels (403) is said so in words (IIIF Auth is not supported), and nothing is drawn', refused_403)

if __name__ == '__main__': main()
