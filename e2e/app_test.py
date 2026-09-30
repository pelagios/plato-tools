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
        srv = subprocess.Popen(['true'], start_new_session=True); url = REMOTE
    else:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', PORT)) == 0:
                sys.exit(f'Port {PORT} is in use, so the page there is not this build: set E2E_PORT to a free port.')
        subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
        # In a session of its own, so that stopping it stops vite too: killing npx alone left vite
        # serving the port, and the next run on that port refused to start.
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
            ctx.close()
    finally:
        try: os.killpg(srv.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        # The profile and the saved outputs are this run's alone: remove them (they were left in
        # /tmp by every run until now, some 2.7 MB each).
        shutil.rmtree(tmp, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    if PROVE:
        print('PROVE-IT-FAILS:', 'every check failed, as it must' if len(failed) == len(results) else f'{len(results) - len(failed)} check(s) passed against a page with no tools: they cannot fail')
        sys.exit(0 if len(failed) == len(results) else 1)
    print('RESULT:', 'ALL PASS' if not failed else f'{len(failed)} FAILED'); sys.exit(1 if failed else 0)

main()
