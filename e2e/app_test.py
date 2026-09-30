"""Browser tests of the page itself, in Playwright's bundled Chromium with an on-disk profile.

    python3 e2e/app_test.py                 run every check against the built site
    python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   the deployed site
    python3 e2e/app_test.py --prove-it-fails run every check against a page with no tools on it;
                                            every check must fail, or the harness cannot fail
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

def publish_case(page, files, part, fields=None, previous=None, timeout=300):
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
        before = page.evaluate(count)
        page.set_input_files('#picker', [str(PLATO / 'schemas/examples/place-centric-judgements.json')])
        after_ = wait_state(page, lambda s: s.get('phase') in ('detected', 'unrecognised'), 60, 'detection')
        after = page.evaluate(count)
        check('choosing a new dataset clears the previous release chosen for the last one', before == 1 and after == 0 and after_.get('phase') == 'detected', {'before': before, 'after': after})
    except Exception as e: check('choosing a new dataset clears the previous release chosen for the last one', False, str(e).split('\n')[0][:200])

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
            s = run_case(page, sorted((ex / 'customs').glob('*.csv')), 'check')
            check('customs tables: detected as tables and checked with no problems', s.get('format') == 'tables' and s.get('phase') == 'done' and s['report']['errors'] == 0, s.get('report') or s)
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
            ctx.close()
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

main()
