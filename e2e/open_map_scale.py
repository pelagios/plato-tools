"""Make an open map at the cap of 200 places with every option on (#39): time, memory and output size.

    python3 e2e/open_map_scale.py [width ...]      default widths: 1600 8000

200 constructed places of the Aegean (120 exact points, 40 approximate with circles, 25 areas, 15 lines, each named in
Greek and Latin and labelled), Natural Earth with its modern features, sea names and regions, the shaded relief (the
browser checks' fixture file: Aegean tiles only), a georeferenced historical map (the browser checks' grid), the key,
north arrow, inset and title. Prints, for each width, the time of the first composition after the last option is set,
of a second (the preview made again), of the SVG and PNG downloads, their sizes, the page's JS heap and the browser's
peak resident memory (the sum of every browser process of this run, sampled every 0.25 s). Nothing leaves this
machine: the sites are this one's and the fixture servers'. Run through ~/.config/plato-tools/heavy.sh.
"""
import importlib.util, json, math, os, pathlib, random, subprocess, sys, tempfile, threading, time, urllib.request
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
WIDTHS = [int(a) for a in sys.argv[1:]] or [1600, 8000]
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location('app_test', ROOT / 'e2e/app_test.py'); m = importlib.util.module_from_spec(spec); sys.modules['app_test'] = m; spec.loader.exec_module(m)

def dataset(n=200, seed=39):
    rnd = random.Random(seed)
    ents = []
    greek = ['Ἀθῆναι', 'Κόρινθος', 'Σπάρτη', 'Θῆβαι', 'Ἄργος', 'Δῆλος', 'Νάξος', 'Πάρος', 'Μίλητος', 'Ἔφεσος']
    for i in range(n):
        lon, lat = rnd.uniform(22.0, 26.0), rnd.uniform(36.2, 38.8)
        kind = 'point' if i < 120 else 'approx' if i < 160 else 'area' if i < 185 else 'line'
        if kind in ('point', 'approx'): g = {'type': 'Point', 'coordinates': [round(lon, 4), round(lat, 4)]}
        elif kind == 'area':
            d = rnd.uniform(0.05, 0.25); g = {'type': 'Polygon', 'coordinates': [[[lon, lat], [lon + d, lat], [lon + d, lat + d * 0.8], [lon, lat + d * 0.8], [lon, lat]]]}
        else: g = {'type': 'LineString', 'coordinates': [[lon, lat], [lon + 0.2, lat + 0.1], [lon + 0.35, lat - 0.05]]}
        geom = {'geojson': g, 'spatialPrecision': ['exact'] if kind == 'point' else ['approximate'] if kind == 'approx' else ['exact']}
        if kind == 'approx': geom['spatialPrecision'] = ['approximate']; geom['precisionKm'] = rnd.choice([5, 12, 20])
        pid = f'https://example.org/scale/place/p{i:03d}'
        ents.append({'@id': pid, 'label': f'Place {i:03d}', 'attestations': [{
            'sources': [{'@id': 'https://example.org/scale/source/s', 'title': 'A constructed source', 'licence': 'https://creativecommons.org/licenses/by/4.0/'}],
            'names': [{'toponym': f'{greek[i % 10]} {i}', 'language': 'grc', 'script': 'Grek'}, {'toponym': f'Locus {i:03d}', 'language': 'la', 'script': 'Latn'}],
            'geometries': [geom]}]})
    return {'$schema': 'https://w3id.org/plato/schemas/place-centric.schema.json', 'profile': 'place-centric',
            'gazetteer': {'@id': 'https://example.org/scale/', 'title': 'Two hundred places (scale test)', 'description': 'Constructed.', 'licence': 'https://creativecommons.org/licenses/by/4.0/', 'status': 'draft', 'uriSpace': 'https://example.org/scale/'},
            'spatialEntities': ents}

def rss_tree(root):
    """Resident memory (KB) of root and all its descendants."""
    kids = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            st = open(f'/proc/{pid}/stat').read(); ppid = int(st[st.rindex(')') + 2:].split()[1]); kids.setdefault(ppid, []).append(int(pid))
        except Exception: pass
    tot, todo = 0, [root]
    while todo:
        p = todo.pop(); todo.extend(kids.get(p, []))
        try:
            for l in open(f'/proc/{p}/status'):
                if l.startswith('VmRSS:'): tot += int(l.split()[1])
        except Exception: pass
    return tot

def main():
    port = os.environ.get('E2E_PORT', '4192')
    subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
    srv = subprocess.Popen(['npx', 'vite', 'preview', '--host', '127.0.0.1', '--port', port, '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    url = f'http://localhost:{port}/'
    for _ in range(60):
        try: urllib.request.urlopen(url, timeout=1); break
        except Exception: time.sleep(.5)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='plato-scale-'))
    base = url; results = []
    try:
        fx = m.start_fixtures(tmp); A, B = fx['A'], fx['B']
        data = tmp / 'scale-200.json'; data.write_text(json.dumps(dataset()))
        with m.sync_playwright() as pw:
            prof = tmp / 'profile'
            ctx = pw.chromium.launch_persistent_context(str(prof), headless=True, args=m.GL, viewport={'width': 1500, 'height': 1000}, reduced_motion='reduce', accept_downloads=True)
            ctx.add_init_script('window.__plato_forceDownload = true;'); ctx.set_default_timeout(600 * 1000)
            page = ctx.pages[0]
            errors = []; page.on('pageerror', lambda e: errors.append(str(e)[:200]))
            page.route('**/basemap/relief.pmtiles', m.relief_route)
            d = json.loads((m.FIX / 'manifest-rumsey-shaped.json').read_text().replace('https://iiif.example.org', A)); d['navDate'] = '1746-01-01T00:00:00Z'
            ctx.route(A + '/manifests/grid/manifest', lambda route: route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(d)))
            peak = [0]; stop = threading.Event()
            def sample():
                while not stop.is_set():
                    peak[0] = max(peak[0], rss_tree(os.getpid())); time.sleep(0.25)
            threading.Thread(target=sample, daemon=True).start()
            page.goto(base)
            page.evaluate(f"""() => {{ localStorage.setItem('plato-tools.permissions', JSON.stringify({{ version: 1, grants: {{ 'iiif:{A}': {{ state: 'allowed', at: '2026-10-15T10:00:00Z' }} }} }}));
              localStorage.setItem('chora-contributor', JSON.stringify({{ name: 'Ada Mapmaker' }})); localStorage.setItem('chora-relief', 'on'); localStorage.removeItem('chora-basemap'); }}""")
            print("booting", flush=True); m.chora_boot(page, base, [data]); print("booted", flush=True)
            m.until(page, '() => window.__chora.phase === "loaded"', 60)
            a = json.loads((m.FIX / 'annotation.json').read_text().replace('https://iiif.example.org', A).replace('https://elsewhere.example.org', B))
            page.fill('#chora-map-input', json.dumps(a)); page.click('#chora-map-form button[type=submit]')
            m.until(page, 'id => window.__chora.overlays.some((o) => o.annotationId === id && o.firstTile)', 120, a['id'])
            m.until(page, '() => !!window.__chora_map.getLayer("chora-relief")', 60)
            page.evaluate('() => window.__chora_map.jumpTo({ center: [24, 37.5], zoom: 7.0 })'); page.evaluate(m.SETTLE)
            print("opening export", flush=True); page.click("#chora-export-open")
            ready = '() => window.__chora.export && ["ready", "error"].includes(window.__chora.export.phase) && !!document.querySelector("#chora-export-preview-map svg")'
            m.until(page, ready, 600); print("export ready", flush=True)
            def settle_after(change, name=''):
                page.evaluate('() => { const s = document.querySelector("#chora-export-preview-map svg"); if (s) s.dataset.old = "1"; }')
                t = time.time(); change()
                try:
                    m.until(page, '() => { const s = document.querySelector("#chora-export-preview-map svg"); return !!s && !s.dataset.old && ["ready", "error"].includes(window.__chora.export.phase); }', 240)
                except Exception:
                    st = page.evaluate('() => JSON.parse(JSON.stringify(window.__chora.export || null))')
                    print('STUCK', name, json.dumps({k: st.get(k) for k in ('phase', 'error', 'said')} if st else None), flush=True); raise
                dt = time.time() - t; print('step', name, round(dt, 1), flush=True); return dt
            for opt in ('modern', 'marine', 'physical'):
                if not page.is_checked(f'#chora-export-{opt}'): settle_after(lambda o=opt: page.check(f'#chora-export-{o}'), opt)
            if not page.is_checked('#chora-export-relief'): settle_after(lambda: page.check('#chora-export-relief'), 'relief')
            for opt in ('north', 'inset', 'key', 'title-on'):
                if not page.is_checked(f'#chora-export-{opt}'): settle_after(lambda o=opt: page.check(f'#chora-export-{o}'), opt)
            key = next(o['key'] for o in m.cstate(page)['overlays'] if o['annotationId'] == a['id'])
            settle_after(lambda: page.select_option('#chora-export-hist', key), 'historical')
            if page.evaluate('() => !document.getElementById("chora-export-statement").value'):
                settle_after(lambda: page.select_option('#chora-export-statement', 'PD-Art|PD-old-assumed'), 'statement')
            for w in WIDTHS:
                peak[0] = 0
                t_compose = settle_after(lambda w=w: page.fill('#chora-export-width', str(w)) or page.dispatch_event('#chora-export-width', 'change'), f'width {w}')
                t_again = settle_after(lambda: page.fill('#chora-export-width', str(w + 1)) or page.dispatch_event('#chora-export-width', 'change'), 'again')
                s = page.evaluate('() => JSON.parse(JSON.stringify(window.__chora.export))')
                row = {'width': w, 'export keys': sorted(s)[:30], 'phase': s.get('phase'), 'layers': s.get('layers'), 'compose s': round(t_compose, 1), 'compose again s': round(t_again, 1)}
                for fmt in ('svg', 'png'):
                    t = time.time()
                    with page.expect_download(timeout=600 * 1000) as dl: page.click(f'#chora-export-{fmt}')
                    p = tmp / f'out-{w}.{fmt}'; dl.value.save_as(p)
                    row[f'{fmt} s'] = round(time.time() - t, 1); row[f'{fmt} MB'] = round(p.stat().st_size / 1e6, 2)
                svg = (tmp / f'out-{w}.svg').read_text()
                row['in the file'] = {'relief image': '<g id="relief"' in svg, 'finer coast': '<g id="ne-coast-sea"' in svg, 'historical map': '<g id="historical-map"' in svg,
                                      'place labels': svg.count('data-place='), 'uncertainty circles': svg.count('stroke-dasharray'), 'text elements': svg.count('<text'),
                                      'ne groups': sorted(set(__import__('re').findall(r'<g id="(ne-[a-z-]+)"', svg)))}
                row['places counted by the panel'] = page.inner_text('#chora-export-count')[:80] if page.query_selector('#chora-export-count') else None
                row['SVG bytes'] = len(svg.encode())
                try: row['JS heap MB'] = round(page.evaluate('() => performance.memory.usedJSHeapSize') / 1e6)
                except Exception: pass
                row['browser peak RSS MB'] = round(peak[0] / 1024)
                row['page errors'] = len(errors)
                results.append(row); print(json.dumps(row), flush=True)
            stop.set(); ctx.close()
    finally:
        m.stop(srv); m.stop_fixtures()
    print('DONE', json.dumps(results))

if __name__ == '__main__': main()
