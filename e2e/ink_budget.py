"""The budget of tracing with assistance (ink-tracing-design.md §9), measured in the page itself, in
Playwright's bundled headless Chromium, against the fixture server's large map (/iiif/inkbig, 4097 x 3073,
512-px tiles at 1, 2, 4 and 8: e2e/iiif_fixture_server.py big()).

    E2E_PORT=<free port> python3 e2e/ink_budget.py [--runs=3] [--no-gl-flags]

What is timed is the page's own account (window.__chora.ink.lastMs: from the click's trace starting to
the proposal drawn, the georeference's carrying it into the world included), each the median of --runs:

- an area whose window grows to 1024 x 1024 at full resolution: the first click (its tiles fetched from
  the fixture server on this machine), the same click again (the tiles kept), and a slider moved;
- a line followed across the map until the window is 2048 wide (the whole map at 1/2), first and again;
- a snap lookup: Terra Draw's question, asked 20,000 times at random over the map.

The worker's memory is measured in Node instead (e2e/ink_memory.mjs): sampled from outside, a worker
busy with a trace answers no question until it is done, so its peak cannot be seen from the page.

The machine's load is printed beside the numbers: they are of this machine, then.
"""
import json, os, pathlib, signal, socket, statistics, subprocess, sys, tempfile, threading, time, urllib.request, shutil, math
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('E2E_PORT', '4174'))
RUNS = int(next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--runs=')), '3'))
GL = [] if '--no-gl-flags' in sys.argv else ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
FIX = ROOT / 'test/fixtures/chora-iiif'
BIG_RIVER = [(300 + 3.4 * k + 0.5, 1500 + 700 * math.sin(k / 160) + 0.5) for k in range(1001)]
BIG_WASH_CENTRE = (2970, 800)

import re
# Chora's policy forbids evaluating a string: a predicate is given as a function (e2e/app_test.py's rule).
FUNCTION = re.compile(r'^\s*(async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>|function\b)')
def as_function(js): return js if FUNCTION.match(js) else f'() => ({js})'
def until(page, js, timeout=60, arg=None): page.wait_for_function(as_function(js), arg=arg, timeout=timeout * 1000)
def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def stop(p):
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    p.wait(timeout=10)
def load(): return os.getloadavg()

SETTLE = '''() => new Promise((r) => { const m = window.__chora_map, t = setTimeout(() => r(false), 20000);
  const done = () => { clearTimeout(t); r(true); };
  if (!m.isMoving() && m.loaded()) requestAnimationFrame(() => requestAnimationFrame(done)); else m.once('idle', done); })'''
TO_SCREEN = """async ([id, pts]) => { const e = window.__chora_overlays.manager.entries.find((x) => x.g.annotationId === id);
  const w = (await window.__chora_overlays.georef.toWorld(e.g, { type: 'MultiPoint', coordinates: pts }, { space: 'image' })).geojson.coordinates;
  const r = window.__chora_map.getCanvas().getBoundingClientRect(); return w.map((c) => { const p = window.__chora_map.project(c); return [r.left + p.x, r.top + p.y]; }); }"""
RATIO = """async (id) => { const e = window.__chora_overlays.manager.entries.find((x) => x.g.annotationId === id); const m = window.__chora_map, c = m.getCanvas();
  const px = async (x, y) => (await window.__chora_overlays.georef.toPixels(e.g, { type: 'Point', coordinates: m.unproject([x, y]).toArray() }, { space: 'image' })).geometry.coordinates;
  const a = await px(c.clientWidth / 2, c.clientHeight / 2), b = await px(c.clientWidth / 2 + 10, c.clientHeight / 2); return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10; }"""

def main():
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', PORT)) == 0: sys.exit(f'Port {PORT} is in use: set E2E_PORT to a free port.')
    subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
    srv = subprocess.Popen(['npx', 'vite', 'preview', '--port', str(PORT), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='plato-ink-budget-'))
    a, b = free_port(), free_port()
    fx = subprocess.Popen([sys.executable, str(ROOT / 'e2e/iiif_fixture_server.py'), str(a), str(b), str(tmp / 'census.jsonl')], start_new_session=True, stdout=subprocess.DEVNULL)
    A = f'http://127.0.0.1:{a}'
    base = f'http://localhost:{PORT}/'
    for _ in range(60):
        try: urllib.request.urlopen(base, timeout=1); urllib.request.urlopen(A + '/iiif/ink/info.json', timeout=1); break
        except Exception: time.sleep(0.5)
    out = {'load at start': load()}
    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(str(tmp / 'profile'), headless=True, args=GL, viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(base + 'chora.html')
            page.evaluate(f"() => localStorage.setItem('chora-consent', JSON.stringify([{{ origin: '{A}', kind: 'iiif' }}]))")
            page.reload(); until(page, '() => window.__chora && window.__chora.phase === "ready" && window.__chora.canary === "enforced"', 60)
            f = tmp / 'place.json'
            f.write_text(json.dumps({'profile': 'place-centric', 'gazetteer': {'@id': 'https://example.org/g', 'title': 'Budget'}, 'spatialEntities': [
                {'@id': 'https://example.org/p/cambridge', 'label': 'Cambridge', 'attestations': [{'names': [{'toponym': 'Cambridge'}], 'sources': [{'title': 's'}]}]}]}))
            page.set_input_files('#picker', [str(f)]); until(page, '() => window.__chora.phase === "loaded"', 60)
            page.click('#list button[data-id]'); until(page, '() => window.__chora.phase === "place"', 30)
            ann = json.loads((FIX / 'annotation-ink.json').read_text().replace('https://iiif.example.org', A))
            ann['id'] = 'https://annotations.allmaps.org/maps/00000000000000b9'
            src = ann['target']['source']; src['id'] = A + '/iiif/inkbig'; src['width'], src['height'] = 4097, 3073
            ann['target']['selector']['value'] = '<svg width="4097" height="3073"><polygon points="0,0 4097,0 4097,3073 0,3073 0,0" /></svg>'
            for feat, rc in zip(ann['body']['features'], [[0, 0], [4097, 0], [4097, 3073], [0, 3073]]): feat['properties']['resourceCoords'] = rc
            page.fill('#map-input', json.dumps(ann)); page.click('#map-form button[type=submit]')
            until(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 60, ann['id'])
            page.evaluate(SETTLE)
            def at_ratio(target):
                r = page.evaluate(RATIO, ann['id'])
                page.evaluate('z => window.__chora_map.jumpTo({ zoom: z })', page.evaluate('() => window.__chora_map.getZoom()') + math.log2(r / target)); page.evaluate(SETTLE)
                return page.evaluate(RATIO, ann['id'])
            def centre_on(px):
                [[x, y]] = page.evaluate(TO_SCREEN, [ann['id'], [list(px)]])
                ll = page.evaluate('([x, y]) => { const r = window.__chora_map.getCanvas().getBoundingClientRect(); return window.__chora_map.unproject([x - r.left, y - r.top]).toArray(); }', [x, y])
                page.evaluate('c => window.__chora_map.jumpTo({ center: c })', ll); page.evaluate(SETTLE)
            def trace(mode, px, again=False):
                n = page.evaluate('() => window.__chora.ink ? window.__chora.ink.proposals : 0')
                if not again:
                    [[x, y]] = page.evaluate(TO_SCREEN, [ann['id'], [list(px)]])
                    page.mouse.move(x - 2, y - 2); page.mouse.move(x, y); page.mouse.down(); page.mouse.up()
                until(page, 'n => window.__chora.ink && (window.__chora.ink.proposals > n || window.__chora.ink.phase === "error")', 120, n)
                ink = page.evaluate('() => JSON.parse(JSON.stringify(window.__chora.ink))')
                if ink['phase'] == 'error' or 'last' not in ink: raise RuntimeError(json.dumps({k: ink.get(k) for k in ('phase', 'lastError', 'proposals', 'mode')}))
                return ink
            # ---- An area, its window grown to 1024 x 1024 at full resolution ----
            page.click('#draw-tools button[data-trace="area"]')
            out['area: image px per screen px'] = round(at_ratio(1.0), 3)
            centre_on(BIG_WASH_CENTRE)
            ink = trace('area', BIG_WASH_CENTRE); first = ink['lastMs']; out['area: window'] = ink['last']['frame']
            cached, slider = [], []
            for run in range(RUNS):
                page.evaluate('() => window.__chora_ink.discard()')
                cached.append(trace('area', BIG_WASH_CENTRE)['lastMs'])
                page.fill('#ink-panel input[data-p="tolerance"]', str(14 + run))
                slider.append(trace('area', None, again=True)['lastMs'])
            out['area: first click, tiles fetched (ms)'] = round(first)
            out['area: click again, tiles kept (ms, median)'] = round(statistics.median(cached))
            out['area: slider moved (ms, median)'] = round(statistics.median(slider))
            page.evaluate('() => window.__chora_ink.discard()')

            # ---- A line, followed until its window is the whole map at 1/2 (2049 x 1537) ----
            page.click('#draw-tools button[data-trace="line"]')
            out['line: image px per screen px'] = round(at_ratio(3.0), 3)
            centre_on(BIG_RIVER[300])
            line_first, line_again = [], []
            for run in range(RUNS):
                page.evaluate('() => window.__chora_ink.discard()')
                ink = trace('line', BIG_RIVER[300])
                (line_first if run == 0 else line_again).append(ink['lastMs'])
                out['line: window'] = ink['last']['frame']; out['line: grown'] = ink['last']['grown']; out['line: vertices'] = ink['last']['vertices']
            out['line: first click, tiles fetched (ms)'] = round(line_first[0])
            out['line: click again, tiles kept (ms, median)'] = round(statistics.median(line_again)) if line_again else None
            page.evaluate('() => window.__chora_ink.discard()')

            # ---- A snap lookup ----
            page.click('#draw-tools button[data-trace="line"]')   # off again
            page.click('#draw-tools button[data-mode="linestring"]'); page.check('#snap-ink')
            until(page, '() => window.__chora.ink.snapBuilds >= 1 && window.__chora.ink.snapPoints > 0', 60)
            snap = page.evaluate('''() => { const c = window.__chora_map.getCanvas(), w = c.clientWidth, h = c.clientHeight, n = 20000; let hits = 0, worst = 0;
              const t0 = performance.now();
              for (let k = 0; k < n; k++) { const s = performance.now(); if (window.__chora_ink.snapAt(Math.random() * w, Math.random() * h)) hits++; worst = Math.max(worst, performance.now() - s); }
              return { n, meanMs: (performance.now() - t0) / n, worstMs: worst, hits, points: window.__chora.ink.snapPoints }; }''')
            out['snap lookup'] = snap
            ctx.close()
    finally:
        stop(srv); stop(fx); shutil.rmtree(tmp, ignore_errors=True)
    out['load at end'] = load()
    print(json.dumps(out, indent=1))

main()
