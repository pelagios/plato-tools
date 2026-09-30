"""Measure what @allmaps/maplibre fetches, from where, and whether a page-side guard can see it.

    python3 spike/allmaps/run_spike.py [--no-gl-flags] [--prove-it-fails]

Starts `vite` (the page) and the two-origin fixture server, each in a session of its own, and
stops both whole in a finally. Each case runs in a fresh browser context of Playwright's bundled
Chromium. For each case it records three accounts of the requests and prints them side by side:
the fixture server's own log (the census: every request that reached origin A or B), Playwright's
request events (context-wide, so a worker's requests are counted if Playwright sees them), and the
page's fetchFn log.

--prove-it-fails points every case at a page with no map: every positive finding must then be absent.
"""
import json, os, pathlib, signal, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
PAGE_PORT, A, B = 47931, 47941, 47951
OUT = pathlib.Path(os.environ.get('SPIKE_OUT', '/tmp')) / 'allmaps-spike'
GL = [] if '--no-gl-flags' in sys.argv else ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
PROVE = '--prove-it-fails' in sys.argv
CASES = [('plain', None), ('fetchfn', None), ('imageinfos', None), ('v3', None), ('foreign', None), ('redirect', None),
         ('plain', 'csp'), ('redirect', 'csp'), ('plain', 'sw'), ('redirect', 'sw')]


def busy(port):
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


def wait_port(port, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if busy(port): return True
        time.sleep(0.2)
    return False


def stop(p):
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait(timeout=10)


def census(log, start):
    lines = log.read_text().splitlines() if log.exists() else []
    return [json.loads(l) for l in lines[start:]], len(lines)


def main():
    for p in (PAGE_PORT, A, B):
        if busy(p): sys.exit(f'port {p} is in use: stopping rather than testing whatever answers there')
    OUT.mkdir(parents=True, exist_ok=True)
    log = OUT / 'census.jsonl'
    log.write_text('')
    fix = subprocess.Popen([sys.executable, str(ROOT / 'spike/allmaps/fixture_server.py'), str(A), str(B), str(log)],
                           start_new_session=True, stdout=subprocess.DEVNULL)
    vite = subprocess.Popen(['npx', 'vite', '--host', '127.0.0.1', '--port', str(PAGE_PORT), '--strictPort'], cwd=ROOT,
                            start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    results = {}
    try:
        assert wait_port(A) and wait_port(B) and wait_port(PAGE_PORT), 'servers did not start'
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=GL)
            # Warm Vite's dependency optimiser once, so that a reload it forces is not in a case.
            ctx = browser.new_context(); pg = ctx.new_page()
            pg.goto(f'http://127.0.0.1:{PAGE_PORT}/spike/allmaps/index.html?case=plain&a={A}&b={B}')
            pg.wait_for_function('window.__spike && window.__spike.done', timeout=90_000)
            ctx.close()
            _, start = census(log, 0)
            for case, guard in CASES:
                name = case + ('+' + guard if guard else '')
                ctx = browser.new_context()
                pw_reqs, workers = [], []
                ctx.on('request', lambda r: pw_reqs.append({'url': r.url, 'type': r.resource_type,
                                                            'frame': bool(r.frame) if not r.service_worker else 'sw'}))
                page = ctx.new_page()
                page.on('worker', lambda w: workers.append(w.url[:60]))
                url = ('data:text/html,<title>no map here</title>' if PROVE
                       else f'http://127.0.0.1:{PAGE_PORT}/spike/allmaps/index.html?case={case}&a={A}&b={B}' + (f'&guard={guard}' if guard else ''))
                page.goto(url)
                t0 = time.time(); state = None
                while time.time() - t0 < 40:
                    state = page.evaluate('() => window.__spike ? JSON.parse(JSON.stringify(window.__spike)) : null')
                    if state and state.get('done'): break
                    time.sleep(0.25)
                time.sleep(1.0)
                if not PROVE and (state or {}).get('guard') != guard:
                    sys.exit(f'{name}: the page ran with guard {(state or {}).get("guard")!r}, not {guard!r}')
                reqs, start = census(log, start)
                results[name] = {'state': state, 'census': reqs, 'playwright': [r for r in pw_reqs if '127.0.0.1:%d' % PAGE_PORT not in r['url']],
                                 'workers': workers}
                ctx.close()
            browser.close()
    finally:
        stop(vite); stop(fix)
    (OUT / 'results.json').write_text(json.dumps(results, indent=1))
    for case, r in results.items():
        s = r['state'] or {}
        print(f'\n=== {case}   done={s.get("done")} pixel={s.get("pixel")} mapIds={len(s.get("mapIds") or [])}')
        print('  events   :', [e['type'] for e in s.get('events', [])])
        for e in s.get('events', []):
            if e.get('error'): print('  event err:', e['type'], e['error'][:200])
        print('  fetchFn  :', s.get('fetchFnCalls'))
        if s.get('guardFetched'): print('  guard    :', s.get('guardFetched'), s.get('imageInfosResult'))
        print('  errors   :', (s.get('errors') or [])[:3], (s.get('consoleErrors') or [])[:3])
        print('  workers  :', len(r['workers']), 'of which blob:', sum(w.startswith('blob:') for w in r['workers']))
        if s.get('guard'): print('  guard    :', s.get('guard'), 'controlled', s.get('controlled'), 'csp', s.get('cspViolations'), 'sw', s.get('swSeen'))
        print('  census   :')
        for c in r['census']:
            print('     ', c['port'], c['status'], c['path'], c.get('sec-fetch-dest'), c.get('sec-fetch-mode'), c.get('origin'), c.get('referer'))
        print('  playwright:')
        for p in r['playwright']:
            print('     ', p['type'], p['frame'], p['url'])


if __name__ == '__main__':
    main()
