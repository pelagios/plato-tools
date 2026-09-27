"""Run one conversion in the real page at full scale, sampling browser memory and disk throughout.

    python3 e2e/scale_test.py --input FILE --target plato-jsonl --out OUT [--timeout 7200]
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, tempfile, time, urllib.request
import psutil
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True); ap.add_argument('--target', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--timeout', type=int, default=7200); ap.add_argument('--port', type=int, default=4175)
ap.add_argument('--no-typing', action='store_true')
a = ap.parse_args()
ROOT = pathlib.Path(__file__).resolve().parent.parent
srv = subprocess.Popen(['npx', 'vite', 'preview', '--port', str(a.port), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
url = f'http://localhost:{a.port}/'
for _ in range(60):
    try: urllib.request.urlopen(url, timeout=1); break
    except Exception: time.sleep(0.5)
me = psutil.Process()
def mem():
    tot = mx = 0
    for p in me.children(recursive=True):
        try:
            if 'ms-playwright' in (p.exe() or ''): r = p.memory_info().rss; tot += r; mx = max(mx, r)
        except psutil.Error: pass
    return tot, mx
profile = tempfile.mkdtemp(prefix='plato-scale-profile-', dir=os.environ.get('SCALE_TMP'))
result = {'input': a.input, 'target': a.target}
try:
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(profile, headless=True, accept_downloads=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.add_init_script('window.__plato_forceDownload = true;')
        page.goto(url)
        page.wait_for_function("window.__plato && window.__plato.phase === 'ready'", timeout=60_000)
        page.set_input_files('#picker', a.input)
        page.wait_for_function("['detected','unrecognised'].includes(window.__plato.phase)", timeout=120_000)
        page.select_option('#target', a.target)
        if a.no_typing: page.uncheck('#typing')
        page.click('#convert')
        t0 = time.time(); peak = peak_tot = peak_disk = 0; last = last_du = -99; st = {}
        while time.time() - t0 < a.timeout:
            tot, mx = mem(); peak = max(peak, mx); peak_tot = max(peak_tot, tot)
            el = time.time() - t0
            if el - last_du > 20:
                last_du = el; peak_disk = max(peak_disk, sum(f.stat().st_size for f in pathlib.Path(profile).rglob('*') if f.is_file()))
            st = page.evaluate('() => JSON.parse(JSON.stringify(window.__plato))')
            if st.get('phase') in ('done', 'error'): break
            if el - last > 30:
                last = el; p = st.get('progress') or {}
                print(f"[{el:6.0f}s] {p.get('phase')} triples={p.get('triples')} places={p.get('places')} rss_max={mx/1e6:.0f}MB disk={peak_disk/1e6:.0f}MB", flush=True)
            time.sleep(1)
        else:
            st['phase'] = 'TIMEOUT'; st['summary'] = page.evaluate("() => document.getElementById('summary')?.textContent")
        result.update({'phase': st.get('phase'), 'elapsedS': round(time.time() - t0), 'peakRssMaxMB': round(peak / 1e6), 'peakRssTotalMB': round(peak_tot / 1e6),
                       'peakProfileOnDiskMB': round(peak_disk / 1e6), 'counts': (st.get('report') or {}).get('counts'), 'errors': (st.get('report') or {}).get('errors'),
                       'items': [(i['severity'], i['kind'], i['count'], i['message'][:120]) for i in (st.get('report') or {}).get('items', [])][:25], 'error': st.get('error')})
        if st.get('phase') == 'done' and st.get('outputs'):
            with page.expect_download(timeout=1_800_000) as d:
                page.evaluate(f"window.__plato_save({json.dumps(st['outputs'][0]['name'])})")
            d.value.save_as(a.out); result['outputBytes'] = pathlib.Path(a.out).stat().st_size
        ctx.close()
finally:
    srv.kill(); shutil.rmtree(profile, ignore_errors=True)
print('RESULT ' + json.dumps(result), flush=True)
