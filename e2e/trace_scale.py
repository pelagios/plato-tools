"""Tracing a historical map into a new dataset, at scale, in the real page (DEVELOPERS.md, Limits): N features traced,
of which a share traced with assistance (an area proposed from the map's ink, its proposal kept as Chora keeps it),
each a place of its own, kept as Chora keeps its drawings. One feature is traced by hand on the grid fixture map, and
copied N times into the drawings kept (OPFS chora-drafts/, the file drafts.js writes), each its own name, address and
position on the map. Then, measured in the page: the drawings opened and shown on the map at once; one more change
(a feature drawn and named) and the write of every drawing kept that follows it; and the save, with the version check.

    python3 e2e/trace_scale.py [--n 2000 --n 5000] [--assisted 0.2] [--port 4178]   (the site built beforehand)

Prints each measurement, and writes them to --out (JSON). It reads the page's own counts (window.__chora.lastShow,
lastDraftWrite, lastSave), never a time it did not measure.
"""
import argparse, json, os, pathlib, signal, subprocess, sys, tempfile, time, urllib.request
ap = argparse.ArgumentParser()
ap.add_argument('--n', type=int, action='append'); ap.add_argument('--assisted', type=float, default=0.2)
ap.add_argument('--port', type=int, default=4178); ap.add_argument('--out', default=None)
a = ap.parse_args()
ns = a.n or [2000, 5000]
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.argv = ['app_test.py']
sys.path.insert(0, str(ROOT / 'e2e'))
os.chdir(ROOT)
import app_test as A
from playwright.sync_api import sync_playwright

BASE = 'https://example.org/scale/'
GRID = 'https://annotations.allmaps.org/maps/0000000000000001'
srv = subprocess.Popen(['npx', 'vite', 'preview', '--host', '127.0.0.1', '--port', str(a.port), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
url = f'http://localhost:{a.port}/'
for _ in range(60):
    try: urllib.request.urlopen(url, timeout=1); break
    except Exception: time.sleep(0.5)
tmp = pathlib.Path(tempfile.mkdtemp(prefix='trace-scale-'))
fx = A.start_fixtures(tmp); ORIGIN = fx['A']
DRAFTS = '''async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts');
  const out = []; for await (const [n, h] of d.entries()) if (h.kind === 'file' && /^[0-9a-f]{32}\\.json$/.test(n)) out.push([n, await (await h.getFile()).text()]); return out; }'''
WRITE = '''async ([n, text]) => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('chora-drafts');
  const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(text); await w.close(); return text.length; }'''

def ring(lon, lat, r, k):
    import math
    pts = [[round(lon + r * math.cos(2 * math.pi * i / k), 7), round(lat + 0.6 * r * math.sin(2 * math.pi * i / k), 7)] for i in range(k)]
    return [pts + [pts[0]]]

def measure(pw, n):
    ctx = pw.chromium.launch_persistent_context(str(tmp / f'profile-{n}'), headless=True, accept_downloads=True, args=A.GL, viewport={'width': 1400, 'height': 900}, reduced_motion='reduce')
    ctx.add_init_script('window.__plato_forceDownload = true;')
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.set_default_timeout(120_000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.goto(url)
    page.evaluate(f"""() => {{ localStorage.setItem('plato-tools.permissions', JSON.stringify({{ version: 1, grants: {{ 'iiif:{ORIGIN}': {{ state: 'allowed', at: '2026-10-14T10:00:00Z' }} }} }}));
      localStorage.setItem('chora-contributor', JSON.stringify({{ name: 'Scale Tracer' }})); }}""")
    A.chora_boot(page, url)
    ann = json.loads((A.FIX / 'annotation.json').read_text().replace('https://iiif.example.org', ORIGIN))
    page.fill('#chora-map-input', json.dumps(ann)); page.click('#chora-map-form button[type=submit]')
    A.until(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 60, GRID)
    key = A.cstate(page)['overlays'][0]['key']
    page.click(f'#chora-overlay-list li[data-overlay="{key}"] button[data-fit]'); page.evaluate(A.SETTLE)
    page.click(f'#chora-overlay-list li[data-overlay="{key}"] button[data-trace-new]')
    A.until(page, '() => !!document.getElementById("chora-trace-form")', 10)
    page.fill('#chora-tset-base', BASE); page.fill('#chora-tset-lang', 'en'); page.click('#chora-trace-form button[type=submit]')
    A.until(page, 'k => window.__chora.trace?.key === k && window.__chora.phase === "loaded"', 30, key)
    def name_one(px, name):
        [xy] = page.evaluate(A.INK_TO_SCREEN, [GRID, [list(px)]])
        A.draw(page, 'point', [tuple(xy)]); page.click('#chora-draw-tools button[data-mode="static"]')
        A.until(page, '() => !!window.__chora.naming?.draftId', 10)
        page.fill('#chora-name-toponym', name)
        t0 = time.time(); page.press('#chora-name-toponym', 'Enter')
        A.until(page, '() => !window.__chora.naming && window.__chora.draftWrites === 0', 120)
        return time.time() - t0
    name_one((256, 256), 'Seed point')
    [(fname, text)] = page.evaluate(DRAFTS)
    kept = json.loads(text); d0 = kept['drafts'][0]
    lon0, lat0 = d0['geojson']['coordinates']
    drafts = []
    for i in range(n):
        lon, lat = lon0 + ((i % 71) - 35) * 0.0004, lat0 + (((i // 71) % 71) - 35) * 0.00025
        d = json.loads(json.dumps(d0))
        d.update(id=f'synth-{i}', placeId=f'{BASE}place/place-{i}', placeLabel=f'Place {i}', names=[{'toponym': f'Place {i}', 'language': 'en'}], drawnAt='2026-10-14T12:00:00.000Z')
        if i < a.assisted * n:
            g = {'type': 'Polygon', 'coordinates': ring(lon, lat, 0.00015, 120)}
            d.update(geojson=g, role='Extent', precision='approximate')
            d['trace']['assisted'] = {'mode': 'area', 'scale': 2, 'scales': [2], 'epsilon': 1, 'gaps': 0, 'params': {'tolerance': 20, 'colour': None, 'bridge': 0},
                                      'seeds': [[256, 256]], 'window': [512, 512], 'proposed': g, 'from': d0['trace'].get('title'), 'fromKey': d0['trace'].get('key'), 'holes': {'dropped': 0}}
        else:
            d['geojson'] = {'type': 'Point', 'coordinates': [round(lon, 7), round(lat, 7)]}
        drafts.append(d)
    body = json.dumps({'fingerprint': kept['fingerprint'], 'drafts': drafts})
    page.evaluate(WRITE, [fname, body])
    # The drawings kept opened again, from the page loaded afresh: the tracing taken up from the panel, every drawing shown.
    A.chora_boot(page, url)
    A.until(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 60, GRID)
    A.until(page, '() => !!document.getElementById("chora-trace-resume")', 30)
    t0 = time.time(); page.click('#chora-trace-resume')
    A.until(page, 'n => window.__chora.trace?.features === n && window.__chora.lastShow?.count === n', 300, n)
    shown_at = time.time() - t0
    page.evaluate(A.SETTLE)
    drawn_at = time.time() - t0
    show = page.evaluate('() => window.__chora.lastShow')
    # One more change: a feature drawn and named; every drawing kept is written again after it.
    named_s = name_one((300, 300), 'One more')
    write = page.evaluate('() => window.__chora.lastDraftWrite')
    heap = page.evaluate('() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null')
    t0 = time.time(); page.click('#chora-save')
    A.until(page, '() => window.__chora.lastSave || window.__chora.phase === "error"', 1800)
    save_s = time.time() - t0
    ls = A.cstate(page)['lastSave'] or {}
    out = {'n': n + 1, 'assisted': int(a.assisted * n), 'kept file MB': round(len(body) / 1048576, 2), 'opened and shown s': round(shown_at, 2), 'map settled s': round(drawn_at, 2),
           'given to the drawing tool ms': show['ms'], 'named, written s': round(named_s, 2), 'write ms': write['ms'], 'write count': write['count'],
           'save s': round(save_s, 1), 'saved': ls.get('passed'), 'added': ls.get('added'), 'heap MB': heap, 'page errors': errors[:3]}
    ctx.close()
    return out

try:
    with sync_playwright() as pw:
        results = []
        for n in ns:
            r = measure(pw, n); results.append(r); print(json.dumps(r), flush=True)
    if a.out: pathlib.Path(a.out).write_text(json.dumps(results, indent=1))
finally:
    os.killpg(srv.pid, signal.SIGTERM); srv.wait(timeout=10)
    A.stop_fixtures()
