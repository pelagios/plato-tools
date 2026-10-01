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
          saved.get('krisis') == 1 and skinds == {'bristol': 'match', 'bath': 'distinct', 'wells': 'not-this'} and (saved.get('reviewer') or {}).get('name') == 'Ada Reviewer', saved.get('error') or skinds)
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
    if saved.get('krisis') == 1:
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
    if saved.get('krisis') == 1 and 'other files than the ones chosen' in w:
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

REMOTE = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--url=')), None)

def main():
    if REMOTE:                                    # the deployed site: a green local run is not a green deploy
        srv = subprocess.Popen(['true']); url = REMOTE
    else:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', PORT)) == 0:
                sys.exit(f'Port {PORT} is in use, so the page there is not this build: set E2E_PORT to a free port.')
        subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
        srv = subprocess.Popen(['npx', 'vite', 'preview', '--port', str(PORT), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
        url = f'http://localhost:{PORT}/'
    for _ in range(60):
        try: urllib.request.urlopen(url, timeout=1); break
        except Exception: time.sleep(0.5)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='plato-tools-e2e-'))
    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(str(tmp / 'profile'), headless=True, accept_downloads=True)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
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
            check('TEI edition -> PLATO JSON: the page says it is TEI, and both place names in the text become attestations about Pleiades 678374',
                  ok and s.get('format') == 'tei' and 'a TEI XML edition' in said and len(atts) == 2
                  and [p['@id'] for p in doc['spatialEntities']] == ['https://pleiades.stoa.org/places/678374'], s.get('report') or s)

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
            check('odd-headed CSV -> PLATO JSON with the guess: Roma is about Wikidata Q220, typed "city", with the remark in its notes, and no column reported as not carried',
                  r1 is not None and r1['place'] == 'https://www.wikidata.org/wiki/Q220' and [t.get('label') for t in r1.get('types', [])] == ['city']
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
            krisis_case(page, tmp)

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
                    p.wait_for_function('window.__estimates > 0', timeout=10_000); p.wait_for_timeout(300)
                    return {'visible': p.is_visible('#storage-warning'), 'text': p.inner_text('#storage-warning')}
                except Exception as e:
                    return {'error': str(e).split('\n')[0][:200]}
                finally:
                    p.close()
            low, normal = storage_warning(1000), storage_warning(None)
            check('the storage warning shows when the quota is below what the tables need, naming the quota, and not with the real quota',
                  (low or {}).get('visible') is True and 'allows the page only 1000 bytes of storage' in low.get('text', '')
                  and (normal or {}).get('visible') is False, {'low': low, 'normal': normal})
            ctx.close()
            chora_checks(pw, url, tmp)
    finally:
        stop(srv)
        # The profile and the saved outputs are this run's alone: remove them (they were left in
        # /tmp by every run until now, some 2.7 MB each).
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    if PROVE:
        print('PROVE-IT-FAILS:', 'every check failed, as it must' if len(failed) == len(results) else f'{len(results) - len(failed)} check(s) passed against a page with no tools: they cannot fail')
        sys.exit(0 if len(failed) == len(results) else 1)
    print('RESULT:', 'ALL PASS' if not failed else f'{len(failed)} FAILED'); sys.exit(1 if failed else 0)

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
T = (lambda s: min(s, 6)) if PROVE else (lambda s: s)   # against the page with no tools every wait fails: sooner
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

def chora_checks(pw, url, tmp):
    base = url.rstrip('/') + '/'; here = urlparse(base).netloc
    ctx = pw.chromium.launch_persistent_context(str(tmp / 'chora-profile'), headless=True, accept_downloads=True, args=GL,
                                                viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
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
        ok = s['phase'] == 'unrecognised' and 'IIIF Georeference Annotation' in said and 'Unsupported input' not in said
        s2 = chora_boot(page, base, [ant])
        return ok and s2['phase'] == 'loaded', {'state': s, 'said': said[:300], 'then': s2.get('phase')}
    attempt('Chora: a IIIF Georeference Annotation is refused as a dataset with the reason the readers give', georef_said)

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
    def draw_and_save(name, place):
        f = odd_dataset(name); chora_boot(page, base, [f]); chora_pick(page, place)
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

    # Over everything above: loading, drawing, saving, the hand-off and two tabs.
    attempt('Chora: across all these checks, no request went to any other site, and no page error', lambda: (
        len(web()) > 50 and 'loaded' in loads and not foreign() and not errors, {'requests': len(web()), 'foreign': foreign(), 'errors': errors[:5]}))

    # After that check, since it asks another site (stopped here, by the route) for a style.
    STYLES = 'https://styles.example.org'
    GOOD = json.dumps({'version': 8, 'name': 'Probe style', 'sources': {}, 'layers': [{'id': 'probe-bg', 'type': 'background', 'paint': {'background-color': '#f4efe4'}}]})
    ctx.route(STYLES + '/**', lambda route: route.fulfill(status=200, content_type='application/json', body=GOOD) if route.request.url.endswith('/good.json') else route.fulfill(status=404, body='not here'))
    def use_pasted(address):
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.fill('#paste', address); page.click('#paste-form button[type=submit]')
        if page.is_visible('#consent-yes'): page.click('#consent-yes')
    def bad_style():
        chora_boot(page, base); since = len(requests)
        # The control: a style that loads is kept.
        use_pasted(STYLES + '/good.json')
        kept_good = soon(page, '() => window.__chora_map.getStyle()?.name === "Probe style"', 20) and cstate(page)['basemap'].startswith('pasted-')
        use_pasted(STYLES + '/missing.json')
        back = soon(page, '() => window.__chora.basemap === "natural-earth" && !!window.__chora.basemapError', 20)
        asked = any(u.endswith('/missing.json') for u in requests[since:])   # it failed for being missing, not for never being asked
        drew = soon(page, '() => window.__chora_map.getStyle()?.name?.includes("Natural Earth") && window.__chora_map.queryRenderedFeatures({ layers: ["land"] }).length > 0', 30)
        text = page.inner_text('#basemap-options'); s = cstate(page)
        return (kept_good and asked and back and drew and 'Natural Earth' in text and 'could not be loaded' in text and s['basemapError'] in text), {
            'the good style kept': kept_good, 'asked for the missing one': asked, 'state': {k: s.get(k) for k in ('basemap', 'basemapError')}, 'said': text[:300]}
    attempt('Chora: a basemap whose style cannot be loaded gives way to Natural Earth, and the page says why (a style that loads is kept)', bad_style)
    # A pasted style whose sources are on a second site: that site is named in a notice once the style
    # is read, and asked nothing until the user agrees; then both are allowed, and a third still refused.
    MULTI, SECOND, THIRD = 'https://multi.example.org', 'https://second.example.net', 'https://third.example.com'
    MULTI_STYLE = json.dumps({'version': 8, 'name': 'Multi probe', 'sources': {'second': {'type': 'raster', 'tiles': [SECOND + '/{z}/{x}/{y}.png'], 'tileSize': 256}},
                              'layers': [{'id': 'multi-bg', 'type': 'background', 'paint': {'background-color': '#eee'}}, {'id': 'second', 'type': 'raster', 'source': 'second'}]})
    PNG = __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
    hits = {'second': 0}
    def second(route): hits['second'] += 1; route.fulfill(status=200, content_type='image/png', body=PNG, headers={'Access-Control-Allow-Origin': '*'})
    ctx.route(MULTI + '/**', lambda route: route.fulfill(status=200, content_type='application/json', body=MULTI_STYLE, headers={'Access-Control-Allow-Origin': '*'}))
    ctx.route(SECOND + '/**', second)
    ctx.route(THIRD + '/**', lambda route: route.abort())
    def multi_origin():
        chora_boot(page, base); since = len(requests)
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.fill('#paste', MULTI + '/style.json'); page.click('#paste-form button[type=submit]')
        first = page.inner_text('#consent-text') if page.is_visible('#consent-text') else ''
        if page.is_visible('#consent-yes'): page.click('#consent-yes')
        # Once the style is read, a notice naming both sites, and nothing yet asked of the second.
        asked_both = soon(page, 's => { const t = document.getElementById("consent-text"); return !!t && t.textContent.includes(s); }', 20, SECOND)
        notice = page.inner_text('#consent-text') if page.is_visible('#consent-text') else ''
        page.wait_for_timeout(500)
        read = any(u.startswith(MULTI) for u in requests[since:])
        before = {'second asked': hits['second'] + len([u for u in requests[since:] if u.startswith(SECOND)]), 'basemap': cstate(page)['basemap'], 'blocked': cstate(page)['blockedOrigins']}
        if page.is_visible('#consent-yes'): page.click('#consent-yes')
        used = soon(page, '() => window.__chora_map.getStyle()?.name === "Multi probe"', 20)
        got = soon(page, '() => window.__chora_map.isSourceLoaded("second")', 20) and hits['second'] > 0
        # The control: a third site, named by nothing the user agreed to, is still refused.
        b0 = cstate(page)['blocked']
        page.evaluate('t => { const m = window.__chora_map; m.addSource("probe-third", { type: "raster", tiles: [t + "/{z}/{x}/{y}.png"], tileSize: 256 }); m.addLayer({ id: "probe-third", type: "raster", source: "probe-third" }); }', THIRD)
        third = soon(page, 'b => window.__chora.blocked > b', 20, b0)
        after = cstate(page)
        return (MULTI in first and asked_both and MULTI in notice and SECOND in notice and read and before['second asked'] == 0 and not before['basemap'].startswith('pasted-')
                and SECOND not in before['blocked'] and used and got and third and THIRD in after['blockedOrigins'] and SECOND not in after['blockedOrigins']
                and not any(u.startswith(THIRD) for u in requests[since:])), {
            'first notice': first, 'second notice': notice, 'style read': read, 'before agreeing': before, 'used': used, 'second fetched': got, 'hits': hits,
            'third refused': third, 'blocked': after['blockedOrigins']}
    attempt('Chora: a pasted style on two sites names both before either is asked for tiles; once agreed, both are used, and a third site is still refused', multi_origin)
    ctx.close()

main()
