"""Drive the spike in Playwright's own bundled Chromium (never the user's Chrome), sample the
resident memory of every browser process throughout, and report the page's own account of the run.

    python3 spike/run_spike.py --input FILE.nt.gz [--mode stream|naive] [--download OUT.jsonl]
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, tempfile, time, urllib.request
import psutil
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True)
ap.add_argument('--mode', default='stream', choices=['stream', 'naive'])
ap.add_argument('--timeout', type=int, default=3600, help='seconds')
ap.add_argument('--download', help='save the JSON Lines output here')
ap.add_argument('--port', type=int, default=4173)
ap.add_argument('--query', default='', help="page options, e.g. 'memdb' or 'cacheMB=256&pageSize=16384'")
a = ap.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
srv = subprocess.Popen(['npx', 'vite', 'preview', '--port', str(a.port), '--strictPort'], cwd=root,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
url = f'http://localhost:{a.port}/spike/index.html' + (('?' + a.query) if a.query else '')
for _ in range(60):
    try: urllib.request.urlopen(url, timeout=1); break
    except Exception: time.sleep(0.5)
else:
    srv.kill(); sys.exit('preview server did not start')

me = psutil.Process()
def browser_mem():
    tot = mx = 0
    for p in me.children(recursive=True):
        try:
            if 'ms-playwright' in (p.exe() or ''):
                r = p.memory_info().rss; tot += r; mx = max(mx, r)
        except psutil.Error:
            pass
    return tot, mx

result = {'mode': a.mode, 'input': a.input, 'inputBytes': pathlib.Path(a.input).stat().st_size}
try:
    with sync_playwright() as pw:
        # A persistent profile in a fresh temporary directory: isolated from the user's Chrome, but
        # on-the-record, so the origin's private file system is on disk as for a real user.
        # (new_context() is off-the-record, and Chromium then keeps OPFS in memory, which made
        # the first scale run measure the harness rather than the design.)
        profile = tempfile.mkdtemp(prefix='plato-spike-profile-', dir=os.environ.get('SPIKE_TMP'))
        ctx = pw.chromium.launch_persistent_context(profile, headless=True, accept_downloads=True)
        browser = ctx
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        crashed = []
        page.on('crash', lambda *_: crashed.append(True))
        page.goto(url)
        page.wait_for_function('window.__ready === true', timeout=30_000)
        result['baselineRssMaxMB'] = round(browser_mem()[1] / 1e6)
        page.set_input_files('#file', a.input)
        page.select_option('#mode', a.mode)
        page.click('#start')
        t0 = time.time(); peak_tot = peak_max = 0; last = 0; state = {}; first_state = None; last_du = -99; peak_disk = 0
        while True:
            el = time.time() - t0
            if el > a.timeout: state['phase'] = 'TIMEOUT'; break
            tot, mx = browser_mem(); peak_tot = max(peak_tot, tot); peak_max = max(peak_max, mx)
            if el - last_du > 15:
                last_du = el
                disk = sum(f.stat().st_size for f in pathlib.Path(profile).rglob('*') if f.is_file())
                peak_disk = max(peak_disk, disk)
            if crashed: state = {**state, 'phase': 'CRASHED', 'message': 'renderer crashed (page.on crash)'}; break
            try:
                state = page.evaluate('({...window.__spike})')
            except Exception as e:
                state = {**state, 'phase': 'PAGE-GONE', 'message': str(e)[:200]}; break
            first_state = first_state or dict(state)
            if state.get('phase') in ('done', 'error'): break
            if el - last > 20:
                last = el
                print(f"[{el:6.0f}s] {state.get('phase')} triples={state.get('triples')} entities={state.get('entities')} "
                      f"rss_max={mx/1e6:.0f}MB rss_total={tot/1e6:.0f}MB profile_on_disk={peak_disk/1e6:.0f}MB", flush=True)
            time.sleep(0.5)
        result.update({'elapsedS': round(time.time() - t0), 'peakRssMaxMB': round(peak_max / 1e6), 'peakProfileOnDiskMB': round(peak_disk / 1e6),
                       'peakRssTotalMB': round(peak_tot / 1e6), 'state': state})
        if a.download and state.get('phase') == 'done':
            with page.expect_download(timeout=900_000) as d:
                page.evaluate('window.__download()')
            d.value.save_as(a.download)
            result['downloadedBytes'] = pathlib.Path(a.download).stat().st_size
        browser.close()
        shutil.rmtree(profile, ignore_errors=True)
finally:
    srv.kill()
print('RESULT ' + json.dumps(result), flush=True)
