"""The budget of tracing with assistance (ink-tracing-design.md §9), measured in the page itself, in
Playwright's bundled headless Chromium, against the fixture server's large map (/iiif/inkbig, 4097 x 3073,
512-px tiles at 1, 2, 4 and 8: e2e/iiif_fixture_server.py big()).

    E2E_PORT=<free port> python3 e2e/ink_budget.py [--runs=3] [--no-gl-flags] [--snap-only]

What is timed is the page's own account (window.__chora.ink.lastMs: from the click's trace starting to
the proposal drawn, the georeference's carrying it into the world included), each the median of --runs:

- an area whose window grows to 1024 x 1024 at full resolution: the first click (its tiles fetched from
  the fixture server on this machine), the same click again (the tiles and the window kept), a slider
  moved, and the click again once another trace has taken the worker's window (tiles kept, its windows,
  512 and then 1024, made afresh);
- a line followed across the map until the window is 2048 wide (the whole map at 1/2), first and again;
- snapping's build with the whole map in view: the main thread's part (the ink's points into the world
  through the georeference, and onto the screen), and its part again on each moveend (--snap-only: this alone);
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
SNAP_ONLY = '--snap-only' in sys.argv   # snapping's build at full view alone
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
            # A measurement, not a check: the map's server is allowed in storage, as the panel would keep it
            # (src/lib/permissions.js), and the page's policy names it from the next load.
            page.evaluate("a => localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { ['iiif:' + a]: { state: 'allowed', at: new Date().toISOString() } } }))", A)
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
            # ---- Snapping's build at full view (the whole map on the screen): the main thread's part ----
            # The worker finds the ink's points; the page carries them into the world (toWorld) and onto the
            # screen (project, binned), the latter again on every moveend. Timed by the page (ink.snapBuild).
            key = page.evaluate('id => window.__chora.overlays.find((o) => o.annotationId === id).key', ann['id'])
            page.click(f'#overlay-list li[data-overlay="{key}"] button[data-fit]'); page.evaluate(SETTLE)
            out['snap build: image px per screen px'] = round(page.evaluate(RATIO, ann['id']), 3)
            page.click('#draw-tools button[data-mode="linestring"]'); page.check('#snap-ink')
            until(page, '() => window.__chora.ink && window.__chora.ink.snapBuilds >= 1 && window.__chora.ink.snapBuild', 120)
            def snap_builds(label):
                builds, moves = [page.evaluate('() => window.__chora.ink.snapBuild')], []
                for run in range(RUNS):
                    n = page.evaluate('() => window.__chora.ink.snapBuilds')
                    page.evaluate('k => window.__chora_map.panBy([k % 2 ? 3 : -3, 0], { animate: false })', run); page.evaluate(SETTLE)
                    moves.append(page.evaluate('() => window.__chora.ink.snapReprojectMs'))
                    until(page, 'n => window.__chora.ink.snapBuilds > n', 120, n)
                    builds.append(page.evaluate('() => window.__chora.ink.snapBuild'))
                out[f'snap build {label}: points'] = builds[-1]['points']
                out[f'snap build {label}: window, scale'] = [builds[-1]['window'], builds[-1]['scale']]
                out[f'snap build {label}: into the world (ms, median)'] = round(statistics.median(b['worldMs'] for b in builds))
                out[f'snap build {label}: onto the screen (ms, median)'] = round(statistics.median(b['reprojectMs'] for b in builds))
                out[f'snap build {label}: main thread in all (ms, median)'] = round(statistics.median(b['mainMs'] for b in builds))
                out[f'snap {label}, each moveend: onto the screen again (ms, median)'] = round(statistics.median(moves))
            snap_builds('at full view')
            # The most points: the largest window read at full resolution (1/1 is read up to 2 image px a
            # screen pixel: at 1.95 a view about 2700 image px wide, the window capped at 2048), on the map's middle.
            r = page.evaluate(RATIO, ann['id'])
            n = page.evaluate('() => window.__chora.ink.snapBuilds')
            page.evaluate('z => window.__chora_map.jumpTo({ zoom: z })', page.evaluate('() => window.__chora_map.getZoom()') + math.log2(r / 1.95)); page.evaluate(SETTLE)
            until(page, 'n => window.__chora.ink.snapBuilds > n', 120, n)
            out['snap build: image px per screen px, at the finest window'] = round(page.evaluate(RATIO, ann['id']), 3)
            snap_builds('at the largest window at 1/1')
            page.uncheck('#snap-ink'); page.click('#draw-tools button[data-mode="static"]') if page.query_selector('#draw-tools button[data-mode="static"]') else None
            if SNAP_ONLY: raise StopIteration

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
                out['line: its steps (' + ('first' if run == 0 else 'again') + ')'] = ink.get('steps')
                out['line: window'] = ink['last']['frame']; out['line: grown'] = ink['last']['grown']; out['line: vertices'] = ink['last']['vertices']
            # The middle case: the wash's tiles kept, but its windows made afresh (the line's window has
            # taken the worker's place for one): read at 512, grown to 1024.
            page.evaluate('() => window.__chora_ink.discard()')
            afresh = []
            for run in range(RUNS):
                if run:   # the line's window again, to put the wash's out of the worker
                    page.click('#draw-tools button[data-trace="line"]'); at_ratio(3.0); centre_on(BIG_RIVER[300])
                    trace('line', BIG_RIVER[300]); page.evaluate('() => window.__chora_ink.discard()')
                page.click('#draw-tools button[data-trace="area"]'); at_ratio(1.0); centre_on(BIG_WASH_CENTRE)
                afresh.append(trace('area', BIG_WASH_CENTRE)['lastMs'])
            out['area: tiles kept, windows made afresh (ms, median)'] = round(statistics.median(afresh))
            out['area: windows made afresh, its steps (the last run)'] = page.evaluate('() => window.__chora.ink.steps')
            out['area: windows made afresh, into the world (ms)'] = page.evaluate('() => window.__chora.ink.last.worldMs')
            page.evaluate('() => window.__chora_ink.discard()')
            page.click('#draw-tools button[data-trace="line"]')
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
    except StopIteration: pass
    finally:
        stop(srv); stop(fx); shutil.rmtree(tmp, ignore_errors=True)
    out['load at end'] = load()
    print(json.dumps(out, indent=1))

main()
