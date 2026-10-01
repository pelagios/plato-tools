"""Browser tests of the page itself, in Playwright's bundled Chromium with an on-disk profile.

    python3 e2e/app_test.py                 run every check against the built site
    python3 e2e/app_test.py --url=https://pelagios.org/plato-tools/   the deployed site
    python3 e2e/app_test.py --prove-it-fails run every check against a page with no tools on it;
                                            every check must fail, or the harness cannot fail
    --no-gl-flags   start Chora's browser without the software-GL switches, to measure whether the map
                    still draws without them (it did on this machine, Chromium 147, September 2026)
    --chora-only    Chora's checks alone, for work on Chora (a full run is what counts)
    --maps-only     Chora's historical-map checks alone
"""
import json, os, pathlib, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLATO = pathlib.Path(os.environ.get('PLATO_REPO', ROOT.parent / 'place-attestation-ontology'))
PROVE = '--prove-it-fails' in sys.argv
CHORA_ONLY = '--chora-only' in sys.argv or '--maps-only' in sys.argv
MAPS_ONLY = '--maps-only' in sys.argv
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

def download(page, name, dest):
    with page.expect_download(timeout=600_000) as d:
        page.evaluate(f'window.__plato_save({json.dumps(name)})')
    d.value.save_as(dest); return pathlib.Path(dest)

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
            if not CHORA_ONLY:                       # the main page's checks
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
            ctx.close()
            if not MAPS_ONLY: chora_checks(pw, url, tmp)
            iiif_checks(pw, url, tmp)
    finally:
        stop(srv)
        stop_fixtures()
        # The profile and the saved outputs are this run's alone: remove them (they were left in
        # /tmp by every run until now, some 2.7 MB each).
        shutil.rmtree(tmp, ignore_errors=True)
    report()

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

FIXTURES = {}
def start_fixtures(tmp):
    """The IIIF fixture server (e2e/iiif_fixture_server.py) on two free ports: origins A and B, and its census."""
    a, b = free_port(), free_port()
    log = tmp / 'iiif-census.jsonl'; log.write_text('')
    p = subprocess.Popen([sys.executable, str(ROOT / 'e2e/iiif_fixture_server.py'), str(a), str(b), str(log)], start_new_session=True, stdout=subprocess.DEVNULL)
    for _ in range(50):
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', a)) == 0 and s.connect_ex(('127.0.0.1', b)) == 0: break
        time.sleep(0.1)
    FIXTURES.update(proc=p, A=f'http://127.0.0.1:{a}', B=f'http://127.0.0.1:{b}', log=log)
    return FIXTURES

def stop_fixtures():
    p = FIXTURES.get('proc')
    if p: stop(p)

def report():
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
import zlib, struct
def _png(w=256, h=256, rgb=(200, 180, 140)):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
PNG = _png()
EX = PLATO / 'schemas/examples'
T = (lambda s: min(s, 6)) if PROVE else (lambda s: s)   # against the page with no tools every wait fails: sooner

def attempt(name, fn):
    """A check made of steps, any of which may raise: a harness error is a failed check, never a crash."""
    try: ok, detail = fn()
    except Exception as e: ok, detail = False, 'harness error: ' + str(e).split('\n')[0][:240]
    check(name, ok, detail)

DIAG = '''() => { const m = window.__chora_map; return { hidden: document.hidden, phase: window.__chora?.phase, mapReadyCount: window.__chora?.mapReadyCount,
  styleLoaded: m ? m.isStyleLoaded() : null, loaded: m ? m.loaded() : null, says: document.getElementById('phase')?.textContent || document.title }; }'''

# A predicate given to Playwright as an expression is evaluated in the page from a string, which
# Chora's Content Security Policy forbids (as it should: no 'unsafe-eval'); a function is called as it
# is. So an expression is made a function here.
FUNCTION = re.compile(r'^\s*(async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>|function\b)')
def as_function(js): return js if FUNCTION.match(js) else f'() => ({js})'

CSP_JS = """() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return { first: !!m && document.head.firstElementChild === m, policy: m ? m.getAttribute('content') : null, published: window.__choraCsp || null,
           canary: window.__chora?.canary, why: window.__chora?.canaryWhy || null, directive: window.__chora?.canaryDirective || null }; }"""
def directives(policy):
    return {d.strip().split(' ', 1)[0]: (d.strip().split(' ', 1) + [''])[1] for d in (policy or '').split(';') if d.strip()}

def until(page, js, timeout=60, arg=None):
    """Wait for `js` to hold; a timeout says what the page was doing (a hidden tab never draws a map, and
    looks exactly like a map that cannot), in the words the page itself shows."""
    t0 = time.time()
    try: page.wait_for_function(as_function(js), arg=arg, timeout=T(timeout) * 1000)
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
    return page.evaluate('''async (name) => { let d; try { d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts'); } catch { return []; }
      for await (const h of d.values()) { const x = JSON.parse(await (await h.getFile()).text()); if (x.fingerprint.split('|')[0] === name) return x.drafts; } return []; }''', name)

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

    # The hard block: the page's Content Security Policy, written by the first script in its <head>.
    def csp_first():
        chora_boot(page, base)
        until(page, '() => window.__chora.canary !== "pending"', 15)
        c = page.evaluate(CSP_JS); pol = directives(c['policy'])
        return (c['first'] and pol.get('connect-src') == "'self' data: blob:" and pol.get('worker-src') == "'self' blob:" and pol.get('default-src') == "'self'"
                and c['published'] and c['published']['origins'] == [] and c['canary'] == 'enforced' and c['directive'] == 'connect-src'), c
    attempt('Chora: first in its <head> is a Content Security Policy that lets it reach this site alone, and the canary finds it enforced in a blob: worker', csp_first)
    def canary_can_fail():
        # The same page served without the script that writes the policy: the canary must say that the
        # policy is NOT enforced. (Otherwise "enforced" above might be what it says whatever happens.)
        def strip(route):
            r = route.fetch()
            route.fulfill(response=r, body=re.sub(r"<script>\s*// Chora's hard block.*?</script>", '', r.text(), flags=re.S))
        page.route('**/chora.html', strip)
        try:
            chora_boot(page, base)
            until(page, '() => window.__chora.canary !== "pending"', 15)
            c = page.evaluate(CSP_JS)
        finally: page.unroute('**/chora.html', strip)
        return c['policy'] is None and not c['published'] and c['canary'] == 'not-enforced', c
    attempt('Chora: without its policy script, the same page\'s canary reports the policy NOT enforced', canary_can_fail)

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
        # A basemap's key travels in its addresses' query string; a failed request must not put it in
        # the console. Two sources on this site that are not there: one with a key, and its control without.
        page.evaluate('''() => { const m = window.__chora_map;
          m.addSource('probe-keyed', { type: 'geojson', data: './basemap/not-here.geojson?api_key=SECRETKEY123' });
          m.addLayer({ id: 'probe-keyed', type: 'line', source: 'probe-keyed' });
          m.addSource('probe-bare', { type: 'geojson', data: './basemap/not-here-either.geojson' });
          m.addLayer({ id: 'probe-bare', type: 'line', source: 'probe-bare' }); }''')
        t0 = time.time()
        # page.wait_for_timeout, not time.sleep: Playwright delivers console events only while it is called.
        while time.time() - t0 < T(15) and not (any('not-here.geojson' in x for x in said[since:]) and any('not-here-either.geojson' in x for x in said[since:])): page.wait_for_timeout(250)
        lines = said[since:]
        return (any('not-here.geojson' in x for x in lines) and any('not-here-either.geojson' in x for x in lines)
                and not any('SECRETKEY123' in x for x in lines)), {'console': [x[:160] for x in lines]}
    attempt('Chora: a failed map request is named in the console, without the key in its address', no_key_in_console)

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

    def search():
        chora_boot(page, base, [fixture(ant, 'antonine-search.json', tmp)])
        labels = lambda: sorted(page.eval_on_selector_all('#list button[data-id]', 'bs => bs.map((b) => b.firstChild.textContent.trim())'))
        # What should be found, worked out from the file, folded as the page says it folds (NFD, marks dropped, lower case).
        fold = lambda t: ''.join(c for c in unicodedata.normalize('NFD', t) if not unicodedata.combining(c)).lower()
        want = sorted(p['label'] for p in antj['spatialEntities'] if 'road' in fold(p['label']))
        want_dover = sorted(p['label'] for p in antj['spatialEntities'] if 'dover' in fold(p['label']))
        page.fill('#q', 'ROAD'); until(page, '() => /found/.test(document.getElementById("found").textContent)', 20)
        roads, was = labels(), page.inner_text('#found')
        # Diacritics are folded on both sides: "dóver" finds Dover.
        page.fill('#q', 'dóver'); until(page, 'w => document.getElementById("found").textContent !== w', 20, was)
        dover = labels()
        return 0 < len(want) < ant_places and roads == want and want_dover and dover == want_dover, {'road': roads, 'wanted': want, 'dóver': dover, 'wanted for dóver': want_dover}
    attempt('Chora: search finds by part of a name, whatever the case and accents, and only those', search)

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
        cleared = soon(page, '() => window.__chora.pendingCount === 0', 10) and kept(page, f.name) == []
        # The file keeps seven decimals (about a centimetre); the drawing kept in the browser, all of them.
        same_place = moved and draws.get('moved') and all(abs(a - b) < 1e-6 for a, b in zip(moved, draws['moved']))
        return kept_all and ok_new and same_place and cleared, {'new': new, 'all kept': kept_all, 'point': moved, 'moved to': draws.get('moved'), 'drafts cleared': cleared}
    attempt('Chora: the saved file has the input as it was, and the two drawings as new attestations with contributor, date and note; the drafts are let go', saved_file)
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
            two.bring_to_front(); two.goto(NOTOOLS if PROVE else base + 'chora.html')
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); s2 = cstate(two); said = two.inner_text('#phase'); shut = two.is_disabled('#picker')
            one.bring_to_front(); one.set_input_files('#picker', [str(fixture(judgements, 'judgements-another-tab.json', tmp))])
            until(one, '["loaded", "error", "unrecognised"].includes(window.__chora.phase)'); s1 = cstate(one)
            one.close()                                         # its worker, and the pool with it, let go
            two.bring_to_front(); two.reload()
            until(two, '() => window.__chora && ["in-another-tab", "error", "ready"].includes(window.__chora.phase)', 60)
            two.bring_to_front(); after = cstate(two)
            return {'second': s2.get('phase'), 'said': said, 'picker disabled': shut, 'first': s1.get('phase'), 'after closing the first': after.get('phase'), 'error': after.get('error') or s2.get('error')}
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

    # Over everything above: loading, drawing, saving, the hand-off and two tabs.
    attempt('Chora: across all these checks, no request went to any other site, and no page error', lambda: (
        len(web()) > 50 and 'loaded' in loads and not foreign() and not errors, {'requests': len(web()), 'foreign': foreign(), 'errors': errors[:5]}))

    # After that check, since it asks another site (stopped here, by the route) for a style.
    STYLES = 'https://styles.example.org'
    GOOD = json.dumps({'version': 8, 'name': 'Probe style', 'sources': {}, 'layers': [{'id': 'probe-bg', 'type': 'background', 'paint': {'background-color': '#f4efe4'}}]})
    TILES2 = 'https://tiles2.example.org'
    MULTI = json.dumps({'version': 8, 'name': 'Probe multi', 'sources': {'t': {'type': 'raster', 'tiles': [TILES2 + '/{z}/{x}/{y}.png'], 'tileSize': 256}},
                        'layers': [{'id': 'probe-bg', 'type': 'background', 'paint': {'background-color': '#f4efe4'}}, {'id': 't', 'type': 'raster', 'source': 't'}]})
    STYLE_BODIES = {'/good.json': GOOD, '/multi.json': MULTI}
    def style_route(route):
        body = STYLE_BODIES.get(urlparse(route.request.url).path)
        route.fulfill(status=200, content_type='application/json', body=body) if body else route.fulfill(status=404, body='not here')
    ctx.route(STYLES + '/**', style_route)
    tile_hits = []
    ctx.route(TILES2 + '/**', lambda route: (tile_hits.append(route.request.url), route.fulfill(status=200, content_type='image/png', body=PNG)))
    def agree_and_reload(p):
        """Agree in the notice shown: the page reloads, once, to put the sites in its policy; wait for it to be back."""
        with p.expect_navigation(timeout=T(30) * 1000): p.click('#consent-yes')
        until(p, '() => window.__chora && window.__chora.mapReadyCount >= 1 && !["loading", "opening", "reloading"].includes(window.__chora.phase)', 60)
    def use_pasted(address):
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.fill('#paste', address); page.click('#paste-form button[type=submit]')
        if soon(page, '() => !!document.getElementById("consent-yes")', 5): agree_and_reload(page)
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

    OFM = 'https://tiles.openfreemap.org'; ofm_asked = []
    OFM_STYLE = json.dumps({'version': 8, 'name': 'Probe OFM', 'sources': {}, 'layers': [{'id': 'probe-bg', 'type': 'background', 'paint': {'background-color': '#e4efe4'}}]})
    ctx.route(OFM + '/**', lambda route: (ofm_asked.append(route.request.url), route.fulfill(status=200, content_type='application/json', body=OFM_STYLE)))
    def builtin_basemap():
        chora_boot(page, base)
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.click('input[name=basemap][value="ofm-liberty"]')
        notice = page.inner_text('#consent-text') if soon(page, '() => !!document.getElementById("consent-text")', 5) else ''
        before = len(ofm_asked)                                  # nothing is asked of the provider before the user agrees
        agree_and_reload(page)
        kept = soon(page, '() => window.__chora_map.getStyle()?.name === "Probe OFM"', 20)
        c = page.evaluate(CSP_JS); s = cstate(page)
        page.evaluate("() => localStorage.setItem('chora-basemap', JSON.stringify('natural-earth'))")   # the checks after this start on Natural Earth
        return (OFM in notice and before == 0 and kept and len(ofm_asked) > 0 and OFM in c['published']['origins'] and OFM in directives(c['policy']).get('connect-src', '')
                and s['basemap'] == 'ofm-liberty'), {'notice': notice, 'asked before agreeing': before, 'asked after': len(ofm_asked), 'kept': kept, 'policy': c['policy'], 'basemap': s['basemap']}
    attempt('Chora: OpenFreeMap, agreed to, is put in the page\'s policy by one reload and used; nothing is asked of it before', builtin_basemap)
    def multi_origin():
        # A pasted style whose tiles are on another site: the style's site was agreed to (the check
        # before), and the tiles' site is asked about by name before any tile is asked for. The reload
        # that follows keeps the dataset, the place and the drawing not yet saved.
        f = fixture(ant, 'antonine-multi.json', tmp); chora_boot(page, base, [f]); pid = chora_pick(page, 'londinium')
        x, y = map_centre(page); draw(page, 'point', [(x + 50, y + 30)]); page.click('#draw-tools button[data-mode="static"]')
        until(page, '() => window.__chora.pendingCount === 1', 10)
        navs = []; page.on('framenavigated', lambda fr: navs.append(fr.url) if fr == page.main_frame else None)
        page.evaluate("() => { document.getElementById('basemaps').open = true; }")
        page.fill('#paste', STYLES + '/multi.json'); page.click('#paste-form button[type=submit]')
        notice = page.inner_text('#consent-text') if soon(page, '() => !!document.getElementById("consent-text")', 10) else ''
        before = len(tile_hits)
        agree_and_reload(page)
        until(page, '() => !!window.__chora.resumed && window.__chora.phase === "place"', 60)
        drew = soon(page, '() => window.__chora_map.getStyle()?.name === "Probe multi"', 20) and soon(page, '() => window.__chora_map.isSourceLoaded("t")', 20)
        s = cstate(page); c = page.evaluate(CSP_JS)
        page.evaluate("() => localStorage.setItem('chora-basemap', JSON.stringify('natural-earth'))")
        return (TILES2 in notice and STYLES not in notice and before == 0 and drew and len(tile_hits) > 0 and TILES2 in c['published']['origins']
                and len(navs) == 1 and s['resumed']['files'] == [f.name] and s['placeId'] == pid and s['pendingCount'] == 1 and s['blocked'] == 0), {
            'notice': notice, 'tiles before agreeing': before, 'tiles after': len(tile_hits), 'drew': drew, 'navigations': navs, 'state': {k: s.get(k) for k in ('resumed', 'placeId', 'pendingCount', 'blocked', 'blockedOrigins')}}
    attempt('Chora: a pasted style with tiles on another site asks about that site by name, then one reload keeps the dataset, place and drawing, and the tiles load', multi_origin)
    ctx.close()

# ---- Chora's historical maps (IIIF), against a real second origin ---------------------------------
# The map's servers are e2e/iiif_fixture_server.py on two ports of 127.0.0.1: origin A, the image
# server agreed to, and origin B, which must never be asked for anything. The page is on localhost,
# so both are other sites. What reached each server is read from the server's own log (the census):
# Playwright's request events also list requests the browser stopped. Allmaps' annotation server is
# answered by page.route. A browser profile of its own, so that nothing has been agreed to at the start.
FIX = pathlib.Path(__file__).resolve().parent.parent / 'test/fixtures/chora-iiif'
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

def iiif_checks(pw, url, tmp):
    fx = start_fixtures(tmp); A, B, log = fx['A'], fx['B'], fx['log']
    base = url.rstrip('/') + '/'
    ctx = pw.chromium.launch_persistent_context(str(tmp / 'iiif-profile'), headless=True, accept_downloads=True, args=GL,
                                                viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
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
    def paste(p, text):
        p.fill('#map-input', text if isinstance(text, str) else json.dumps(text)); p.click('#map-form button[type=submit]')
    def agree_map(p):
        with p.expect_navigation(timeout=T(30) * 1000): p.click('#map-yes')
        until(p, '() => window.__chora && window.__chora.mapReadyCount >= 1 && window.__chora.canary !== "pending" && !["loading", "opening", "reloading"].includes(window.__chora.phase)', 60)
    def shown(p, annotation_id):
        return soon(p, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 30, annotation_id)
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

    def before_consent():
        chora_boot(page, base); until(page, '() => window.__chora.canary !== "pending"', 15)
        since = len(census())
        paste(page, annotation())
        asked = soon(page, '() => !!document.getElementById("map-yes")', 10)
        notice = page.inner_text('#map-consent-text') if asked else ''
        page.wait_for_timeout(1000)                              # time for anything that would be asked, to be asked
        early = census(since)
        navs = []; page.on('framenavigated', lambda fr: navs.append(fr.url) if fr == page.main_frame else None)
        agree_map(page)
        drew = shown(page, grid_id)
        rows = census(since); s = cstate(page); c = page.evaluate(CSP_JS)
        paths = [r['path'] for r in at_origin(rows, A)]
        return (asked and A in notice and 'sees nothing of your data' in notice and early == [] and len(navs) == 1 and s['canary'] == 'enforced'
                and drew and '/iiif/grid/info.json' in paths and any(p.endswith('/default.jpg') for p in paths) and at_origin(rows, B) == []
                and A in c['published']['origins'] and s['overlays'][0]['transformation'] == 'polynomial1'), {
            'notice': notice, 'asked before agreeing': early, 'navigations': navs, 'census after': [(r['port'], r['status'], r['path']) for r in rows], 'overlays': s['overlays'], 'canary': s['canary']}
    attempt('Chora maps: nothing is asked of a map\'s server until the user agrees to it by name; then one reload, and its image information and tiles, from it alone', before_consent)

    GRID5 = [[64 + 96 * i, 64 + 96 * j] for i in range(5) for j in range(5)]
    def agreement_order1():
        r = page.evaluate(AGREE_JS, GRID5)
        one = next((x for x in r if x['annotation'] == grid_id), None)
        return (one and one['n'] == 25 and one['self'] == 0 and one['type'] == 'polynomial1' and one['worst'] <= 1e-7 and one['lonlat'] <= 1e-7), r
    attempt('Chora maps: where the renderer draws each of 25 pixels of the map is where georef places it, to 1e-7 m (order 1)', agreement_order1)
    def agreement_order2():
        o2 = annotation('annotation-order2.json'); since = len(census())
        paste(page, o2)
        # In the renderer (its tiles are the grid's, already fetched for the map before).
        drew = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 20, o2['id'])
        r = page.evaluate(AGREE_JS, GRID5)
        two = next((x for x in r if x['annotation'] == o2['id']), None)
        # The control: the renderer's own order-1 transformation of the same map disagrees by metres, which
        # is what it would draw had its transformation not been set from the georeference.
        return (drew and two and two['mapIds'] and two['self'] == 0 and two['type'] == 'polynomial2' and two['worst'] <= 1e-7 and two['lonlat'] <= 1e-7 and two['order1'] > 1
                and at_origin(census(since), B) == []), {'order 2': two, 'drew': drew}
    attempt('Chora maps: an order-2 map is drawn at order 2 (set from its georeference), agreeing with georef to 1e-7 m; order 1 would be metres off', agreement_order2)

    def foreign_id():
        since = len(census())
        paste(page, annotation(service='/iiif/foreign', id='https://annotations.allmaps.org/maps/000000000000000f'))
        refused = soon(page, '() => /not shown/.test(document.getElementById("map-status").textContent)', 20)
        said = page.inner_text('#map-status'); rows = census(since)
        # A is asked for the image information (and the manifest the georeference names); B for nothing.
        return (refused and B in said and '/iiif/foreign/info.json' in [r['path'] for r in at_origin(rows, A)]
                and not any('default.jpg' in r['path'] for r in at_origin(rows, A)) and at_origin(rows, B) == []
                and not any(o['annotationId'].endswith('00f') for o in cstate(page)['overlays'])), {'said': said, 'census': [(r['port'], r['path']) for r in rows]}
    attempt('Chora maps: a map whose image information names an image on another site is refused, in words; that site is asked nothing', foreign_id)

    def redirect():
        since = len(census())
        rid = 'https://annotations.allmaps.org/maps/0000000000000302'
        paste(page, annotation(service='/iiif/redirect', id=rid))
        admitted = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 20, rid)
        page.evaluate("() => { const o = window.__chora_overlays.manager.entries; window.__chora_map.fitBounds(window.__chora_overlays.layer.getMapsBounds(o.map((e) => e.mapId)), { duration: 0 }); }")
        page.evaluate(SETTLE)
        failed = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.tileErrors > 0)', 20, rid)
        page.wait_for_timeout(1500)
        rows = census(since); a_paths = [r['path'] for r in at_origin(rows, A)]
        # In the same run, the honest map on A drew (its tiles reached the renderer).
        honest = next((o for o in cstate(page)['overlays'] if o['annotationId'] == grid_id), {})
        said = page.inner_text('#overlay-list')
        events = cstate(page).get('overlayEvents')
        return (admitted and failed and any(p.startswith('/iiif/redirect/') and p.endswith('default.jpg') for p in a_paths)
                and any(r['status'] == 302 for r in at_origin(rows, A)) and at_origin(census(), B) == [] and honest.get('tilesLoaded', 0) > 0
                and 'could not be loaded' in said), {'failed': failed, 'events': events, 'tile message': 'could not be loaded' in said, 'A': [(r['status'], r['path']) for r in at_origin(rows, A)], 'B, whole run': at_origin(census(), B), 'honest map': honest, 'said': said[-300:], 'failed': failed, 'events': events}
        # (the order above is kept short enough to read in the one line a failure prints)
    attempt('Chora maps: a tile answered by a redirect to another site is stopped by the page\'s policy (that site gets no request at all), while the honest map drew', redirect)

    def lookup():
        since = len(census()); hits = len(allmaps_hits)
        paste(page, A + '/manifests/grid/manifest')
        offered = soon(page, '() => !!document.getElementById("map-lookup")', 20)
        editor = page.get_attribute('#map-status a[href^="https://editor.allmaps.org"]', 'href') if offered else ''
        before = len(allmaps_hits) - hits                           # nothing asked of Allmaps before the button
        page.click('#map-lookup')
        notice = page.inner_text('#map-consent-text') if soon(page, '() => !!document.getElementById("map-yes")', 10) else ''
        agree_map(page)
        # Admitted (its image is the grid's, whose tiles the renderer may hold already, so no new tile is due).
        got = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id)', 30, 'https://annotations.allmaps.org/maps/0000000000000003')
        asked = allmaps_hits[hits:]
        return (offered and before == 0 and 'Allmaps' in notice and got and asked and all('/images/' in u for u in asked)
                and editor.startswith('https://editor.allmaps.org/images?url=')), {'got': got, 'asked': asked, 'offered': offered, 'asked before the button': before, 'editor': editor, 'notice': notice[:60]}
    attempt('Chora maps: a manifest with no georeference asks nothing of Allmaps until "Look for a georeference" is pressed and Allmaps agreed to; then it finds one by the image', lookup)

    def controls():
        s = cstate(page); keys = [o['key'] for o in s['overlays']]
        if not keys: raise RuntimeError('no map shown')
        k = next(o['key'] for o in s['overlays'] if o['annotationId'] == grid_id)
        row = f'#overlay-list li[data-overlay="{k}"]'
        page.fill(f'{row} input[data-opacity]', '40')
        page.uncheck(f'{row} input[data-show]')
        o = page.evaluate('k => { const e = window.__chora_overlays.manager.entries.find((x) => x.key === k); const m = window.__chora_overlays.layer.getMapOptions(e.mapId); return { opacity: m.opacity, visible: m.visible }; }', k)
        page.check(f'{row} input[data-show]')
        others = [x for x in keys if x != k]
        for x in others:
            page.click(f'#overlay-list li[data-overlay="{x}"] button[data-remove-map]')
            until(page, 'x => !window.__chora.overlays.some((o) => o.key === x)', 10, x)
        left = page.evaluate('() => window.__chora_overlays.layer.getMapIds()')
        kept = opfs_names(page, 'chora-overlays')
        return (abs(o['opacity'] - 0.4) < 1e-9 and o['visible'] is False and len(others) >= 3 and len(left) == 1 and kept == [f'{k}.json']
                and [x['key'] for x in cstate(page)['overlays']] == [k]), {'map options': o, 'removed': len(others), 'left': left, 'kept': kept}
    attempt('Chora maps: opacity and show reach the renderer; a map removed leaves the map, the list and the browser\'s store', controls)

    def trace_save():
        f = tmp / 'chora-files' / 'cambridge.json'; f.parent.mkdir(exist_ok=True)
        f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Traced'}, 'spatialEntities': [
            {'@id': 'https://example.org/p/cambridge', 'label': 'Cambridge', 'attestations': [{'names': [{'toponym': 'Cambridge'}], 'sources': [{'title': 's'}]}]}]}))
        chora_boot(page, base, [f]); pid = chora_pick(page, 'cambridge')
        until(page, '() => window.__chora.overlays.length === 1 && window.__chora.overlays[0].firstTile', 30)
        page.click('#overlay-list button[data-fit]'); page.evaluate(SETTLE)
        page.evaluate("() => localStorage.setItem('chora-contributor', JSON.stringify({ name: 'Ada Test' }))")
        xy = page.evaluate("""async () => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: [256, 256] }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }""")
        draw(page, 'point', [tuple(xy)]); page.click('#draw-tools button[data-mode="static"]')
        traced = soon(page, '() => window.__chora.lastTrace && window.__chora.lastTrace.key', 15)
        card = page.inner_text('#card')
        page.click('#save'); until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 120)
        ls = cstate(page)['lastSave'] or {}
        if not ls.get('passed'): return False, {'save': ls, 'card': card[-400:]}
        with page.expect_download(timeout=T(60) * 1000) as d: page.click('#save-result button.primary')
        out = tmp / 'traced.json'; d.value.save_as(out)
        new = json.loads(out.read_text())['spatialEntities'][0]['attestations'][-1]
        cits = new.get('citations', [])
        fns = [c.get('citationFunction') for c in cits]
        loc = cits[0].get('locator', '') if cits else ''
        notes = new.get('notes', '')
        return (traced and 'Traced from' in card and ls.get('added') == 1
                and fns == ['http://purl.org/spar/cito/citesAsEvidence', 'http://purl.org/spar/cito/usesMethodIn']
                and cits[0]['source'].get('@id') == A + '/manifests/grid/manifest' and re.match(re.escape(A + '/manifests/grid/canvas/c1') + r'#xywh=\d+,\d+,\d+,\d+$', loc)
                and cits[1]['source'].get('@id') == grid_id and cits[1]['source'].get('derivedFrom') == A + '/manifests/grid/manifest'
                and notes.startswith('Traced by hand from a georeferenced historical map') and f'Georeferenced through {grid_id} (polynomial order 1, 4 control points)' in notes
                and 'retrieval date not recorded' in notes and '@id' not in new), {'citations': cits, 'notes': notes, 'save': {k: ls.get(k) for k in ('passed', 'added')}}
    attempt('Chora maps: a point traced from the map is saved citing the map (on its canvas) and the georeference, with the fixed notes, and Mneme passes', trace_save)

    def moved_off():
        # A traced point moved off the map with the Edit tool no longer cites the map, and says so; the
        # control is the same point traced first (the check before left the page on the map, fitted).
        PX = """async (px) => { const e = window.__chora_overlays.manager.entries[0];
          const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'Point', coordinates: px }, { space: 'image' })).geojson.coordinates;
          const p = window.__chora_map.project(w), r = window.__chora_map.getCanvas().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }"""
        KEPT = """async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts');
          for await (const h of d.values()) { const x = JSON.parse(await (await h.getFile()).text()); if (x.fingerprint.startsWith('cambridge.json')) return x.drafts.map((k) => !!k.trace); } return null; }"""
        page.evaluate(SETTLE)
        x, y = page.evaluate(PX, [200, 200])
        draw(page, 'point', [(x, y)]); page.click('#draw-tools button[data-mode="static"]')
        traced = soon(page, '() => window.__chora.lastTrace && window.__chora.lastTrace.key && window.__chora.pendingCount === 1', 15)
        first = cstate(page).get('lastTrace')
        tx, ty = page.evaluate(PX, [504, 256])                  # on the image, outside the mask (16 to 496)
        page.click('#draw-tools button[data-mode="select"]')
        tap(page, x, y)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move((x + tx) / 2, (y + ty) / 2, steps=6); page.mouse.move(tx, ty, steps=6); page.mouse.up()
        page.click('#draw-tools button[data-mode="static"]')
        dropped = soon(page, '() => window.__chora.lastTrace && !window.__chora.lastTrace.key', 15)
        note = page.inner_text('#card [data-trace-note]') if page.query_selector('#card [data-trace-note]') else ''
        kept = page.evaluate(KEPT)
        return (traced and first and first.get('key') and dropped and 'no longer cites that map' in note and kept == [False]), {'first': first, 'after': cstate(page).get('lastTrace'), 'note': note, 'kept traced': kept}
    attempt('Chora maps: a traced point moved off its map with the Edit tool no longer cites the map, and the card says so', moved_off)

    def come_back_and_forget():
        page.reload(); until(page, '() => window.__chora && window.__chora.phase === "ready" && window.__chora.canary !== "pending"', 60)
        back = soon(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 30, grid_id)
        since = len(census())
        with page.expect_navigation(timeout=T(30) * 1000): page.click('#forget-sites')
        until(page, '() => window.__chora && window.__chora.phase === "ready" && window.__chora.canary !== "pending"', 60)
        asked = soon(page, '() => !!document.getElementById("map-yes")', 20)
        notice = page.inner_text('#map-consent-text') if asked else ''
        page.wait_for_timeout(1000)
        c = page.evaluate(CSP_JS)
        return (back and asked and A in notice and census(since) == [] and c['published']['origins'] == [] and cstate(page)['overlays'] == []), {
            'came back': back, 'notice': notice, 'asked after forgetting': census(since), 'policy': c['published']}
    attempt('Chora maps: a map shown comes back on the next load; after "Forget the sites", it is asked about again, and nothing is asked of its server', come_back_and_forget)

    def no_policy():
        # The same page served without its policy script: maps are refused, in words, and nothing is asked.
        def strip(route):
            r = route.fetch(); route.fulfill(response=r, body=re.sub(r"<script>\s*// Chora's hard block.*?</script>", '', r.text(), flags=re.S))
        page.evaluate(f"() => localStorage.setItem('chora-consent', JSON.stringify([{{ origin: '{A}', kind: 'iiif' }}]))")
        page.route('**/chora.html', strip)
        try:
            chora_boot(page, base); until(page, '() => window.__chora.canary !== "pending"', 15)
            since = len(census())
            paste(page, annotation(id='https://annotations.allmaps.org/maps/0000000000000011'))
            said = page.inner_text('#map-status') if soon(page, '() => /cannot be shown in this browser/.test(document.getElementById("map-status").textContent)', 20) else page.inner_text('#map-status')
            page.wait_for_timeout(1000)
            rows = census(since); s = cstate(page)
        finally: page.unroute('**/chora.html', strip)
        return s['canary'] == 'not-enforced' and 'cannot be shown in this browser' in said and rows == [] and s['overlays'] == [], {'canary': s['canary'], 'said': said, 'census': rows}
    attempt('Chora maps: with no policy on the page (the canary finds none), maps are refused in words and their server is asked nothing', no_policy)
    attempt('Chora maps: across these checks, origin B was never asked for anything, and no page error', lambda: (len(census()) > 5 and at_origin(census(), B) == [] and not errors, {'census': len(census()), 'B': at_origin(census(), B), 'errors': errors[:5]}))
    ctx.close()

main()
