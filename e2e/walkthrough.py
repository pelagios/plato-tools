"""A walkthrough of "Map your data" in the real page, for showing live and for recording.

    python3 e2e/walkthrough.py                    both walks, no window, a video and screenshots written
    python3 e2e/walkthrough.py --headed --slow    a visible window, paced for talking over, captions on the page
    python3 e2e/walkthrough.py --walk=places      one walk only: places (a list of places, WHG's LP-TSV) or regions
    python3 e2e/walkthrough.py --out=DIR          where the video and screenshots go (default .scratch/walkthrough)
    python3 e2e/walkthrough.py --pace=2500        milliseconds each caption is held (default 1200; 4000 with --slow; 0 = a check only)
    python3 e2e/walkthrough.py --no-captions      screenshots of the page as it is, with no caption bar
    python3 e2e/walkthrough.py --no-build         the site as already built in dist/
    python3 e2e/walkthrough.py --url=URL          another copy of the site (WHG is answered by the stub all the same)
    python3 e2e/walkthrough.py --prove-it-fails   the same steps against a page with no tools: every one must fail
    python3 e2e/walkthrough.py --break=no-candidates   the page is the real one, and WHG's stub finds nothing: the walks
                                                  must stop at the lookup (places) and at the counties (regions), and say so
    python3 e2e/walkthrough.py --break=no-licence      no source states a licence: they must stop where the locations are taken

Run it through ~/.config/plato-tools/heavy.sh, as any browser run (DEVELOPERS.md, Testing).

Two walks, each as a visitor follows it, from the interview to the file downloaded:

- places: WHG's own twelve-place sample (test/fixtures/generic/whg-lp7-12.tsv, kept with WHG's permission), its columns
  read by their LP-TSV roles, checked, converted, looked up in WHG, reviewed (one decision by hand, the rest in bulk), the
  decisions recorded, the matched places' locations taken (the licence gate: a source that states no licence is left out
  until the box is ticked), seen on the map, and written out as the spreadsheet.
- regions: ten farms with a parish and a county column (test/fixtures/methodos/parishes.csv): the regions matched level
  by level, the places looked up within their parishes, reviewed, recorded, located, and written out.

WHG is never called: every request to whgazetteer.org is answered here (STUB below), so the walk is the same every time
and needs no network and no token of anyone's. The browser is Playwright's own Chromium with a profile made for the run
and thrown away after it: never the Chrome installed on the machine, with --headed or without.

What is written (the directory is in .gitignore): NN-<walk>-<step>.png, one for each step, as the step ends;
walkthrough-<walk>.webm, the recording as Playwright makes it; and, where ffmpeg is installed, walkthrough-<walk>.mp4
and a small walkthrough-<walk>.gif. Each step ends on something read from the page or from a file it wrote, and a step
that does not hold stops the walk there, with a screenshot (NN-…-FAILED.png), what the page said, and exit status 1.

That it can fail is shown three ways, each to be run again after a change to it: against a page with no tools every step
fails (--prove-it-fails: 28 of 28); with the page as it is and the stub's answers wrong, the walk stops at the step that
depends on them and names it (--break); and the two things it reads off the drawn page (BESIDE and IN_SIGHT, below) each
failed on the page as it was before what they check was mended (November 2026).
"""
import json, os, pathlib, re, shutil, socket, subprocess, sys, tempfile, time, urllib.request, csv

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import app_test as A   # the browser checks' own helpers and stubs' data: until(), wait_state(), the page with no tools
from playwright.sync_api import sync_playwright

ROOT = A.ROOT
def opt(name, default=None):
    return next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith(f'--{name}=')), default)
HEADED = '--headed' in sys.argv
SLOW = '--slow' in sys.argv
PROVE = A.PROVE
PACE = int(opt('pace', '0' if PROVE else '4000' if SLOW else '1200'))
OUT = pathlib.Path(opt('out', str(ROOT / '.scratch' / 'walkthrough'))).resolve()
WALKS = [w for w in opt('walk', 'places,regions').split(',') if w]
BREAK = opt('break')
CAPTIONS = '--no-captions' not in sys.argv
PORT = int(os.environ.get('WALK_PORT', '4184'))
SIZE = {'width': 1280, 'height': 800}
PLACES_TSV = ROOT / 'test/fixtures/generic/whg-lp7-12.tsv'
REGIONS_CSV = A.MYDATA_CSV
T = A.T
KNOWN = {'--headed', '--slow', '--prove-it-fails', '--no-captions', '--no-build', '--no-gl-flags'}
for a in sys.argv[1:]:
    if a not in KNOWN and not re.match(r'^--(pace|out|walk|break|url)=', a): sys.exit(f'walkthrough.py: {a!r} is not an option (see the top of the file)')
if BREAK not in (None, 'no-candidates', 'no-licence'): sys.exit(f'walkthrough.py: --break={BREAK} is not one of no-candidates, no-licence')
if not set(WALKS) <= {'places', 'regions'} or not WALKS: sys.exit('walkthrough.py: --walk is places, regions, or both with a comma')

# ---- WHG, answered here --------------------------------------------------------------------------------------------
# The places walk: every name of the sample has one record, at a point near where the place is, in GeoNames (which
# states its licence), but for three: Ḥarrān's record is of a source that states no licence (the licence gate), Eski
# Musul's has no point on record, and Gebal has two records in its country (left to the reviewer). The six places the sample
# already links to GeoNames are answered with those same records, which the page does not suggest again.
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, accept, user-agent'}
ATTRIBUTION = {'whg': A.LOOKUP_ATTRIBUTION['whg'], 'sources': {**A.LOOKUP_ATTRIBUTION['sources'], 'wd': {'name': 'A source with no licence stated'}}}
def record(id, name, point, country, **more):
    r = {**A.mydata_answer(id, name, point), 'description': f'Country: {country}', 'ccodes': [country], **more}
    if point is None: del r['repr_point']
    return r
PLACES_ANSWERS = {
    'Emesa': [record('place:gn:169577', 'Homs', [36.72, 34.73], 'SY', alt_names=['Emesa', 'Ḥimṣ'], match=False)],
    'Eski Musul': [record('place:gn:8200002', 'Eski Mosul', None, 'IQ', match=False)],
    'Góra': [record('place:gn:3098722', 'Góra', [16.07, 52.62], 'PL')],
    'Ḥarrān': [record('place:wd:Q199547', 'Harran', [39.03, 36.86], 'TR', match=False)],
    'Livorno': [record('place:gn:3174659', 'Livorno', [10.326, 43.544], 'IT')],
    'Salzburg': [record('place:gn:2766824', 'Salzburg', [13.044, 47.799], 'AT')],
    'Saxony': [record('place:gn:2842567', 'Saxony', [13.0, 51.0], 'DE')],
    'Zurich': [record('place:gn:2657896', 'Zürich', [8.55, 47.367], 'CH')],
    'Gebal': [record('place:gn:273203', 'Gebal', [35.65, 34.12], 'LB', alt_names=['Jbail', 'Byblos']),
              record('place:gn:8200009', 'Gebal', [35.9, 35.36], 'LB', score=95, match=False, confidence=90)],
    'Geneva': [record('place:gn:2660646', 'Geneva', [6.146, 46.202], 'CH')],
    'Halle': [record('place:gn:2911522', 'Halle', [11.979, 51.482], 'DE')],
    'Al Mafraq': [record('place:gn:250582', 'Al Mafraq', [36.208, 32.343], 'JO')],
}
# The regions walk: the browser checks' own answers for the ten farms, their parishes and counties (app_test.py, MYDATA_ANSWERS:
# Kirk House has no record, and Wood Lane two of its name in its parish), with the farms' points spread out for the map.
SPREAD = {'Mill Farm': [-2.52, 53.31], 'Church Barn': [-2.44, 53.27], 'Hall Green': [-2.36, 53.33], 'Low Mill': [-2.31, 53.09], 'Moss Side': [-2.62, 53.46],
          'Brook End': [-2.71, 53.52], 'High Cross': [-2.74, 53.93], 'Old Hall': [-2.63, 53.88], 'Wood Lane': [-2.69, 53.84]}
REGIONS_ANSWERS = {name: [{**c, 'repr_point': SPREAD[name]} if name in SPREAD and i == 0 else c for i, c in enumerate(found)] for name, found in A.MYDATA_ANSWERS.items()}
ANSWERS = {'places': PLACES_ANSWERS, 'regions': REGIONS_ANSWERS}

def stub_for(walk, posts):
    answers = ANSWERS[walk]
    attribution = {'whg': ATTRIBUTION['whg'], 'sources': {k: {'name': k} for k in ATTRIBUTION['sources']}} if BREAK == 'no-licence' else ATTRIBUTION
    def stub(route):
        req = route.request
        if req.method == 'OPTIONS': return route.fulfill(status=204, headers=CORS)
        reply = lambda body, status=200: route.fulfill(status=status, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps(body))
        if req.method == 'GET': return reply({'detail': 'Not found'}, 404)
        body = json.loads(req.post_data or '{}'); posts.append(body)
        res = {'attribution': attribution}
        for k, q in (body.get('queries') or {}).items():
            found = [] if BREAK == 'no-candidates' else answers.get(q.get('query'), [])
            if q.get('area_only'): found = [c for c in found if c.get('has_geom')]
            res[k] = {'result': found, **({'scope': {'applied': True}} if isinstance(q.get('contained_in'), list) else {})}
        reply(res)
    return stub

# ---- The caption, and the pace ---------------------------------------------------------------------------------------
# A bar along the bottom of the window, put there by the walkthrough (it is no part of the page), saying what is being
# done. Its styles are set through the element's style object, which the page's Content Security Policy allows where a
# style attribute or a style element would be refused. It takes no clicks.
CAPTION_JS = '''([step, text]) => {
  let el = document.getElementById('__walk_caption');
  if (!el) {
    el = document.createElement('div'); el.id = '__walk_caption'; el.setAttribute('aria-hidden', 'true');
    const s = el.style;
    s.position = 'fixed'; s.left = '50%'; s.bottom = '14px'; s.transform = 'translateX(-50%)'; s.zIndex = '2147483647';
    s.maxWidth = 'min(960px, calc(100vw - 48px))'; s.padding = '10px 18px'; s.borderRadius = '10px'; s.pointerEvents = 'none';
    s.background = 'rgba(22, 28, 36, 0.92)'; s.color = '#fff'; s.font = '500 17px/1.35 system-ui, sans-serif';
    s.boxShadow = '0 4px 18px rgba(0, 0, 0, 0.35)'; s.textAlign = 'center';
    const n = document.createElement('span'); n.id = '__walk_n';
    n.style.opacity = '0.7'; n.style.marginRight = '10px'; n.style.fontVariantNumeric = 'tabular-nums';
    const t = document.createElement('span'); t.id = '__walk_t';
    el.append(n, t); document.body.append(el);
  }
  document.getElementById('__walk_n').textContent = step;
  document.getElementById('__walk_t').textContent = text;
}'''

# Two things read off the page as it is drawn (each was wrong at this window's size until November 2026, and is checked
# where the walk shows it). BESIDE: for every label shown in a bar of controls, whether it is on the line of its own list
# (a row that wrapped used to leave a label at one line's end and its list on the next). IN_SIGHT: whether the tracker's
# list of steps scrolls, and whether the step at hand is within what it shows.
BESIDE = """(bar) => [...document.querySelectorAll(bar + ' label')].filter((l) => l.offsetParent && l.htmlFor).map((l) => {
  const a = l.getBoundingClientRect(), b = document.getElementById(l.htmlFor).getBoundingClientRect();
  return [l.textContent.trim(), a.bottom > b.top && a.top < b.bottom && a.right <= b.left + 1]; })"""
IN_SIGHT = """() => { const list = document.getElementById('methodos-track'), now = list.querySelector('li[aria-current]');
  if (!now) return null;
  const r = list.getBoundingClientRect(), n = now.getBoundingClientRect();
  return { scrolls: list.scrollHeight > list.clientHeight, inSight: n.top >= r.top - 1 && n.bottom <= r.bottom + 1 }; }"""
def beside(w, bar):
    """(whether every label of the bar is beside its own list, and there are labels; what was found)"""
    found = w.page.evaluate(BESIDE, bar)
    return len(found) >= 2 and all(ok for _, ok in found), found

class Stopped(Exception): pass

class Walk:
    """One walk: its own browser context (and so its own recording), its steps in order, each a caption, what is done, and what must then hold."""
    def __init__(self, pw, name, base):
        self.name, self.base = name, base
        self.results, self.n, self.posts = [], 0, []
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix=f'plato-walk-{name}-'))
        self.browser = pw.chromium.launch(headless=not HEADED, args=A.GL, slow_mo=120 if SLOW else 0)
        video = {} if PROVE else {'record_video_dir': str(self.tmp / 'video'), 'record_video_size': SIZE}
        self.ctx = self.browser.new_context(accept_downloads=True, viewport=SIZE, **video, **({'reduced_motion': 'reduce'} if not HEADED else {}))
        self.ctx.add_init_script('window.__plato_forceDownload = true;')
        self.ctx.route(re.compile(r'^https?://([^/]*\.)?whgazetteer\.org/'), stub_for(name, self.posts))
        self.asked = []
        self.ctx.on('request', lambda q: self.asked.append(q.url))
        self.page = self.ctx.new_page(); self.page.set_default_timeout(T(20) * 1000)
        self.page.on('dialog', lambda d: d.accept())

    # What a step uses.
    def until(self, js, timeout=60, arg=None): return A.until(self.page, js, timeout, arg)
    def state(self, pred, timeout=60, what=''): return A.wait_state(self.page, pred, T(timeout), what)
    def track(self): return self.page.evaluate(A.JOIN_STATE)
    def step_is(self, step, state, timeout=60):
        self.until(f"() => document.querySelector('#methodos-track li[data-step=\"{step}\"]')?.dataset.state === '{state}'", timeout)
    def run(self, button, timeout=180):
        self.click(button)
        return self.state(lambda s: s.get('phase') in ('done', 'error'), timeout, 'run')
    def show(self, selector, block='center'):
        """Bring what is being talked about into the window, as a visitor would scroll to it."""
        try: self.page.eval_on_selector(selector, "(e, block) => e.scrollIntoView({ block, behavior: 'instant' })", block)
        except Exception: pass
    def click(self, selector):
        self.show(selector); self.pause(0.25); self.page.click(selector)
    def pause(self, share=1.0):
        if PACE: self.page.wait_for_timeout(int(PACE * share))
    def caption(self, text):
        if not CAPTIONS: return
        try: self.page.evaluate(CAPTION_JS, [f'{self.name} {self.n}', text])
        except Exception: pass
    def shot(self, slug):
        if PROVE: return None
        f = OUT / f'{self.n:02d}-{self.name}-{slug}.png'
        try: self.page.mouse.move(2, 2); self.page.screenshot(path=str(f))
        except Exception as e: print(f'        (no screenshot: {str(e).splitlines()[0][:100]})')
        return f
    def download(self, name):
        return A.download(self.page, name, self.tmp / name)

    def step(self, slug, caption, fn):
        """A step: the caption shown, `fn` run (it returns whether it held, and what it found), a screenshot taken. Not holding stops the walk."""
        self.n += 1
        self.caption(caption); self.pause(0.5)
        t0 = time.time()
        try: ok, detail = fn()
        except Stopped: raise
        except Exception as e: ok, detail = False, 'the step could not be done: ' + str(e).split('\n')[0][:1500]
        self.caption(caption)   # again: a step that loaded a page lost it
        name = f'{self.name} {self.n:02d} {slug}'
        self.results.append((name, bool(ok), detail))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  ({time.time() - t0:.1f}s){'' if ok else '  -- ' + str(detail)[:1800]}", flush=True)
        if ok and os.environ.get('WALK_DEBUG'): print('        ' + json.dumps(detail, ensure_ascii=False, default=str)[:2500])
        if ok: self.shot(slug); self.pause(1.0)
        elif not PROVE:
            self.shot(slug + '-FAILED')
            try: print('        the page said: ' + (self.page.evaluate("() => document.getElementById('methodos-message')?.textContent || document.getElementById('phase')?.textContent || document.title") or '')[:300])
            except Exception: pass
            raise Stopped(name)

    def close(self):
        """End the recording and return where Playwright wrote it (None with none)."""
        video = None
        try:
            v = self.page.video
            self.ctx.close()
            if v: video = pathlib.Path(v.path())
        except Exception as e: print(f'        (closing: {str(e).splitlines()[0][:120]})')
        try: self.browser.close()
        except Exception: pass
        return video

# ---- The steps both walks share ----------------------------------------------------------------------------------------
def begin(w, table, regions, reviewer):
    def open_page():
        w.page.goto(A.NOTOOLS if PROVE else w.base)
        # As a visitor who has used the page before: WHG allowed in Permissions, and the reviewer's name given.
        w.page.evaluate("(who) => { localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: { 'gazetteer:whg': { state: 'allowed', at: '2026-11-18T10:00:00Z' } } })); localStorage.setItem('plato-tools.reviewer', JSON.stringify({ name: who })); localStorage.setItem('chora-contributor', JSON.stringify({ name: who })); }", reviewer)
        w.page.goto(A.NOTOOLS if PROVE else w.base)
        s = w.state(lambda s: s.get('phase') == 'ready', 30, 'ready')
        return s.get('phase') == 'ready' and len(s.get('platoCommit') or '') == 40, {'phase': s.get('phase')}
    w.step('page', 'PLATO Tools, in the browser: nothing is uploaded, the work is done on this computer.', open_page)

    def interview():
        w.click('#methodos-ask'); w.until("!document.getElementById('methodos').hidden", 5)
        w.pause(0.4)
        w.page.check('input[name="methodos-have"][value="table"]'); w.pause(0.3)
        w.page.check('input[name="methodos-want"][value="map"]'); w.pause(0.3)
        for k, v in (('has-regions', 'yes' if regions else 'no'), ('will-draw', 'no'), ('will-publish', 'no')):
            w.page.check(f'input[name="methodos-ask-{k}"][value="{v}"]'); w.pause(0.2)
        w.until("() => !document.getElementById('methodos-start').hidden", 5)
        w.show('#methodos-plan')
        plan = w.page.eval_on_selector_all('#methodos-plan li', 'ls => ls.map((l) => l.textContent)')
        return len(plan) >= 8 and not any('Not yet available' in x for x in plan), {'plan': plan}
    w.step('interview', 'What do you have, and what do you want? A table of places, to see on a map' + (', within regions.' if regions else '.'), interview)

    def choose():
        w.click('#methodos-start'); w.until("['pending', 'idle'].includes(document.getElementById('methodos-tracker').dataset.status)", 10)
        w.page.set_input_files('#picker', [str(table)])
        w.until("() => window.__plato?.columns?.headers && document.getElementById('methodos-tracker').dataset.status === 'idle' && !document.getElementById('methodos-done').hidden", 30)
        w.show('#methodos-tracker', 'start')
        t = w.track()
        return t['steps'].get('columns') == 'current', {'steps': t['steps'], 'columns': w.page.evaluate('() => window.__plato.columns')}
    w.step('file', f'The workflow begins, and the table is chosen: {table.name}. It stays on this computer.', choose)

def write_out(w, expected, rows_expected):
    def see():
        s = w.run('#check'); w.step_is('again', 'done')
        w.until("() => !document.getElementById('methodos-compare').hidden", 30)
        w.click('#methodos-compare'); w.step_is('compare', 'done', 120)
        w.until("() => /locations? (are|is) on record/.test(document.getElementById('methodos-message').textContent)", 30)
        seen = w.track()['message']
        return s.get('phase') == 'done' and f'{expected()} locations are on record' in seen, {'seen': seen, 'expected': expected()}
    w.step('checked-again', 'The dataset is checked again and compared with the one first made: nothing lost, the matches and locations added.', see)

    def on_the_map():
        w.click('#methodos-chora')
        w.until('window.__chora && window.__chora.mapReadyCount >= 1 && ["loaded", "error", "unrecognised"].includes(window.__chora.phase)', 90)
        c = A.cstate(w.page)
        w.until('() => window.__chora_map && window.__chora_map.loaded()', 60)
        w.pause(1.0)
        return c.get('phase') == 'loaded', {'chora': {k: c.get(k) for k in ('phase', 'mapReadyCount', 'places', 'located')}}
    w.step('map', 'The places on the map, each where its gazetteer record is.', on_the_map)

    def out():
        w.click('#chora-leave')
        w.until("() => !document.getElementById('methodos-done').hidden && !!document.getElementById('methodos-done').offsetParent", 30)
        w.click('#methodos-done'); w.step_is('see', 'done', 15)
        w.until("() => document.getElementById('target').dataset.step === 'out' && /^Press Convert below\\./.test(document.getElementById('methodos-message').textContent)", 30)
        chosen = w.page.input_value('#target')
        s = w.run('#convert'); w.step_is('out', 'done', 60)
        name = next((o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('.flat.csv')), None)
        if not name: return False, {'outputs': [o['name'] for o in s.get('outputs') or []]}
        rows = list(csv.DictReader(w.download(name).open(encoding='utf-8-sig')))
        located = sum(1 for x in rows if x.get('lat') and x.get('lon'))
        matched = sum(1 for x in rows if x.get('match_status') and x['match_status'] != 'no match recorded')
        w.show('#methodos-tracker', 'start')
        steps = w.track()['steps']
        return (chosen == 'table-flat' and len(rows) == rows_expected and located == expected() and matched > 0 and all(v.startswith('done') for v in steps.values())), \
            {'chosen': chosen, 'rows': len(rows), 'located': located, 'matched': matched, 'steps': steps}
    w.step('export', 'Download your results: one spreadsheet, a row for each place, with its match and its location.', out)

LOCATE = A.LOCATE_STATE
def decided(s): return sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match')

# ---- The places walk ---------------------------------------------------------------------------------------------------
def places_walk(w):
    r = {}
    begin(w, PLACES_TSV, regions=False, reviewer='Demo Reviewer')

    def columns():
        cols = w.page.evaluate('() => window.__plato.columns')
        w.show('#columns', 'start'); w.pause(1.0)
        w.click('#methodos-done'); w.step_is('columns', 'done', 15)
        return bool(cols and cols.get('headers')), {'columns': cols}
    w.step('columns', 'Its columns are read by what they hold: title is the name, lon and lat the location, matches the links. Change any, or go on.', columns)

    def check_convert():
        c = w.run('#check'); w.step_is('check', 'done')
        w.page.select_option('#target', 'plato-json')
        s = w.run('#convert'); w.step_is('dataset', 'done')
        return c.get('phase') == 'done' and s.get('phase') == 'done', {'check': c.get('phase'), 'report': c.get('report'), 'convert': s.get('phase')}
    w.step('dataset', 'Checked, and made into a dataset: every place, name and link in it, each with where it came from.', check_convert)

    def lookup():
        w.click('#methodos-use')
        w.state(lambda s: s.get('phase') == 'detected' and s.get('format') == 'plato-json', 60, 'the converted dataset chosen')
        if not w.page.evaluate("() => document.getElementById('lookup').open"): w.click('#lookup > summary')
        w.page.fill('#whg-token', A.LOOKUP_TOKEN); w.page.press('#whg-token', 'Tab')
        w.until("() => /^Send \\d+ quer(y|ies) to WHG$/.test(document.getElementById('lookup-send').textContent) && !document.getElementById('lookup-send').disabled", 60)
        r['send'] = w.page.inner_text('#lookup-send')
        w.show('#lookup-send'); w.pause(1.0)
        w.click('#lookup-send'); w.step_is('lookup', 'done', 90)
        s = w.state(lambda s: (s.get('lookup') or {}).get('running') is False and len((s.get('work') or {}).get('candidates', [])) > 0, 30, 'candidates')
        n = len((s.get('work') or {}).get('candidates', []))
        r['candidates'] = n
        return r['send'] == 'Send 12 queries to WHG' and len(w.posts) == 1 and len(w.posts[0]['queries']) == 12 and n == 6, {'send': r['send'], 'requests': len(w.posts), 'candidates': n, 'queries': [q.get('query') for p in w.posts for q in p['queries'].values()]}
    w.step('lookup', 'Look the places up in the World Historical Gazetteer: the page says what will be sent before anything is.', lookup)

    def by_hand(name):
        """The place's own screen in the review, and its one candidate said to be the same place."""
        at = lambda: w.page.inner_text('#review-subject')
        seen = []
        for button in ('#review-prev', '#review-next'):   # back to the first place still to decide, then forward to this one
            for _ in range(40):
                seen.append(at())
                if (button == '#review-next' and name in seen[-1]) or w.page.is_disabled(button): break
                w.page.click(button)
        if name not in at():
            dbg = w.page.evaluate("() => ({ prev: document.getElementById('review-prev').disabled, next: document.getElementById('review-next').disabled, filter: document.getElementById('review-filter').value, progress: document.getElementById('review-progress').textContent, cands: window.__plato.work.candidates.map((c) => [c.candidate_source.split('/').pop(), c.other && c.other.label, c.decision && c.decision.kind]) })")
            raise RuntimeError(f'{name} is not among the places still to decide: {seen} {dbg}')
        w.show('#review-place', 'start'); w.pause(0.8)
        n = decided(w.state(lambda s: True, 5))
        w.click('#review-place li.candidate button[data-act="match"]')
        w.state(lambda s: decided(s) == n + 1, 10, f'{name} decided')
    def review():
        s = w.state(lambda s: True, 5)
        cands = (s.get('work') or {}).get('candidates', [])
        by_hand('Emesa')
        one = decided(w.state(lambda s: True, 5))
        w.until("() => !document.getElementById('bulk-accept').disabled", 30)
        r['bulk'] = w.page.inner_text('#bulk-accept')
        w.show('#bulk-accept'); w.pause(0.8)
        w.click('#bulk-accept')
        s = w.state(lambda s: decided(s) > one, 15, 'accepted in bulk')
        r['after bulk'] = decided(s)
        r['bulk said'] = w.page.inner_text('#bulk-result')
        gebal = [c.get('decision') for c in s['work']['candidates'] if c['candidate_source'].endswith('/Travelab_2')]
        w.show('#review-bulk', 'start'); w.pause(1.0)
        bars = [beside(w, '.review-bar'), beside(w, '#review-bulk')]
        return (all(ok for ok, _ in bars) and len(cands) == 6 and one == 1 and r['bulk'] == "Accept the 3 that pass WHG's guards" and r['after bulk'] == 4 and gebal == [None, None]), \
            {'candidates': len(cands), 'bulk': r['bulk'], 'said': r['bulk said'], 'after bulk': r['after bulk'], 'Gebal': gebal, 'progress': w.page.inner_text('#review-progress'), 'labels beside their lists': [b for _, b in bars]}
    w.step('review', 'Review the matches: one by hand (Emesa is Homs), then all that pass WHG\'s guards at once.', review)

    def left_for_you():
        by_hand('Gebal')
        s = w.state(lambda s: True, 5); r['matched'] = decided(s)
        progress = w.page.inner_text('#review-progress')
        w.show('#review-progress', 'start')
        return r['matched'] == 5 and progress.startswith('5 of 12 places reviewed'), {'matched': r['matched'], 'progress': progress}
    w.step('tie', 'Gebal has two candidates of its name in its country, so it was left for you: the first is the one.', left_for_you)

    def record():
        w.click('#methodos-done'); w.step_is('review', 'done', 15)
        w.page.check('input[name="review-output"][value="dataset"]')
        s = w.run('#finish'); w.step_is('apply', 'done', 30)
        name = next(o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('.krisis-dataset.json'))
        r['applied'] = w.download(name)
        doc = json.loads(r['applied'].read_text())
        ids = sum(len(a.get('identities') or []) for e in doc['spatialEntities'] for a in e.get('attestations') or [])
        w.step_is('locate', 'current', 15)
        w.show('#methodos-tracker', 'start')
        return ids >= r['matched'], {'identities in the dataset': ids, 'decided': r['matched']}
    w.step('record', 'The decisions are saved into the dataset: who decided, when, and from which candidate.', record)

    def gate():
        w.until("() => !document.getElementById('methodos-locate-go').hidden", 60)
        b = w.page.evaluate(LOCATE); r['gate'] = b
        w.show('#methodos-message'); w.pause(1.5)
        # The step's words and its box take room from the list of steps above them: the step at hand stays in sight in it.
        try: w.until("() => { const s = (" + IN_SIGHT + ")(); return !!s && s.inSight; }", 5)
        except Exception: pass
        b['list of steps'] = w.page.evaluate(IN_SIGHT)
        # The presence beside the absence: the licensed locations are offered, and the one of no stated licence is not, until the box is ticked.
        return (b['list of steps'] == {'scrolls': True, 'inSight': True} and b['step'] == 'current' and b['box'] is True and b['ticked'] is False and '1 left out because its licence is not stated' in b['message']
                and '1 has no location on record' in b['message'] and b['message'].endswith('Nothing is taken until you press the button.')
                and b['go'] == 'Use the locations of 2 places' and b['message'].startswith('Use the locations of 2 of 5 matched places; 1 already has a location;')), b
    w.step('licence', 'Use the locations of the matches? Only where the source says they may be reused: one has no licence stated, and is left out.', gate)

    def locate():
        n = int(re.search(r'\d+', r['gate']['go']).group(0))
        w.page.check('#methodos-locate-unknown')
        w.until("(t) => document.getElementById('methodos-locate-go').textContent === t", 15, f'Use the locations of {n + 1} places')
        w.pause(1.0)
        w.page.uncheck('#methodos-locate-unknown')
        w.until("(t) => document.getElementById('methodos-locate-go').textContent === t", 15, f'Use the locations of {n} places')
        w.click('#methodos-locate-go')
        w.until(f"() => document.getElementById('methodos-message').textContent.startsWith('The locations of {n} place')", 60)
        w.step_is('locate', 'done', 15)
        w.until("() => /\\.located\\.json$/.test((document.querySelector('#chosen .name') || {}).textContent || '') && window.__plato.phase === 'detected'", 60)
        s = w.page.evaluate(LOCATE)
        e = A.locate_ends(json.loads(w.download(s['chosen'][0]).read_text()))
        took = {k: v for k, v in e.items() if any('place:' in x['note'] for x in v)}
        r['located'] = sum(1 for v in e.values() if v)
        harran = [x for x in e.get('Ḥarrān', []) if 'place:' in x['note']]
        return (len(took) == n and harran == [] and all(x['licence'] == 'https://spdx.org/licenses/CC-BY-4.0' for v in took.values() for x in v if 'place:' in x['note'])), \
            {'taken for': sorted(took), 'Ḥarrān': e.get('Ḥarrān'), 'with a location': r['located'], 'said': s['message']}
    w.step('locate', 'Tick the box and it would be taken too, with your name on the choice. Left unticked: the licensed locations are added, each citing its source.', locate)

    write_out(w, lambda: r['located'], 12)

# ---- The regions walk --------------------------------------------------------------------------------------------------
def regions_walk(w):
    r = {}
    begin(w, REGIONS_CSV, regions=True, reviewer='Demo Reviewer')
    W = lambda: (w.state(lambda s: True, 5).get('work') or {})
    art = lambda k: f'#regions-level article[data-rkey="{k}"]'

    def columns():
        levels = (w.state(lambda s: ((s.get('columns') or {}).get('levels') or {}), 30, 'columns').get('columns') or {}).get('levels')
        w.show('#columns', 'start'); w.pause(1.0)
        w.click('#methodos-done'); w.step_is('columns', 'done', 15)
        return levels == {'county': 1, 'parish': 2}, {'levels': levels}
    w.step('columns', 'Ten farms, each with its parish and its county: the two columns are read as the regions the places are in, the county above the parish.', columns)

    def check_convert():
        c = w.run('#check'); w.step_is('check', 'done')
        w.page.select_option('#target', 'plato-json')
        s = w.run('#convert'); w.step_is('dataset', 'done')
        t = w.track()
        return c.get('phase') == 'done' and s.get('phase') == 'done' and t['steps'].get('regions') == 'current', {'check': c.get('phase'), 'convert': s.get('phase'), 'steps': t['steps']}
    w.step('dataset', 'Checked, and made into a dataset: ten places and the six regions they are in.', check_convert)

    def level(n, expected):
        def go():
            if n == 1:
                w.click('#methodos-use')
                w.state(lambda s: s.get('phase') == 'detected' and s.get('format') == 'plato-json', 60, 'the converted dataset chosen')
                if not w.page.evaluate("() => document.getElementById('lookup').open"): w.click('#lookup > summary')
                w.page.fill('#whg-token', A.LOOKUP_TOKEN); w.page.press('#whg-token', 'Tab')
                w.page.wait_for_function("() => !document.getElementById('regions-offer').hidden", timeout=T(60) * 1000)
                w.click('#regions-start')
                w.state(lambda s: len(((s.get('work') or {}).get('regions') or {})) == 6, 60, 'regions')
            w.click(f'#regions-nav button[data-rlevel="{n}"]')
            sent = len(w.posts)
            w.click('#regions-level button[data-rgo="level"]')
            w.state(lambda s: (s.get('lookup') or {}).get('running') is False and len(w.posts) > sent, 60, f'level {n}')
            w.show('#regions', 'start'); w.pause(1.2)
            keys = [k for k, g in (W().get('regions') or {}).items() if g['level'] == n]
            for k in keys:
                w.click(art(k) + ' li.candidate button[data-ract="match"]')
                w.state(lambda s: (((s.get('work') or {}).get('regions') or {}).get(k) or {}).get('outcome') == 'matched', 10, 'settled')
            within = sorted(json.dumps(q.get('contained_in')) for q in w.posts[-1]['queries'].values())
            names = sorted(g['names'][0] for g in (W().get('regions') or {}).values() if g['level'] == n and g.get('outcome') == 'matched')
            w.show('#regions', 'start')
            bar = beside(w, '.regions-bar')
            return bar[0] and names == expected[0] and within == expected[1], {'matched': names, 'sent within': within, 'labels beside their lists': bar[1]}
        return go
    w.step('counties', 'Regions first, from the top: the two counties are looked up in WHG, and each is matched.',
           level(1, (['Cheshire', 'Lancashire'], ['null', 'null'])))
    w.step('parishes', 'Then the parishes, each looked for only within its county: Newton in Cheshire is not Newton in Lancashire.',
           level(2, (['Ashby', 'Barton', 'Newton', 'Newton'], ['["gn:2644974"]', '["gn:2644974"]', '["gn:2653941"]', '["gn:2653941"]'])))

    def places():
        w.click('#methodos-done'); w.step_is('regions', 'done', 15)
        w.click('#regions-nav button[data-rlevel="places"]')
        n = len(w.posts)
        w.show('#regions', 'start'); w.pause(1.0)
        w.click('#regions-level button[data-rgo="places"]')
        w.step_is('lookup', 'done', 90)
        within = {q['query']: q.get('contained_in') for q in w.posts[n]['queries'].values()} if len(w.posts) > n else {}
        return len(within) == 10 and within.get('Mill Farm') == ['gn:2641434'] and within.get('Wood Lane') == ['gn:2657441'], {'within': within}
    w.step('places', 'Now the places themselves, each looked for within its own parish.', places)

    def review():
        w.until("() => !document.getElementById('bulk-accept').disabled", 30)
        bulk = w.page.inner_text('#bulk-accept')
        w.show('#review-bulk', 'start'); w.pause(1.0)
        w.click('#bulk-accept')
        places_matched = lambda s: sum(1 for c in (s.get('work') or {}).get('candidates', []) if (c.get('decision') or {}).get('kind') == 'match' and '/region-' not in c['candidate_source'])
        n = places_matched(w.state(lambda s: places_matched(s) == 8, 15, 'accepted'))
        said = w.page.inner_text('#bulk-result')
        wood = [c.get('decision') for c in W().get('candidates', []) if (c.get('other') or {}).get('label') == 'Wood Lane']
        for _ in range(12):
            if 'Wood Lane' in w.page.inner_text('#review-subject'): break
            w.page.click('#review-next')
        badge = w.page.eval_on_selector_all('#review-place .badge.namesakes', 'els => els.map((e) => e.textContent)')
        w.show('#review-place', 'start')
        return (n == 8 and '1 place has 2 candidates of its name where it was looked for' in said and wood == [None, None]
                and badge == ['2 places of this name in Ashby (Lancashire): left for you, not accepted in bulk.']), {'bulk': bulk, 'said': said, 'Wood Lane': wood, 'badge': badge}
    w.step('review', 'Eight pass WHG\'s guards and are accepted at once. Wood Lane has two places of its name in its parish: left for you, and the page says why.', review)

    def record():
        w.click('#methodos-done'); w.step_is('review', 'done', 15)
        w.page.check('input[name="review-output"][value="dataset"]')
        w.click('#export-candidates')
        w.until("() => !!window.__plato.candidates && !!window.__plato.candidates.setIri", 15)
        s = w.run('#finish'); w.step_is('relate', 'done', 30)
        name = next(o['name'] for o in (s.get('outputs') or []) if o['name'].endswith('.krisis-dataset.json'))
        e = A.mydata_ends(json.loads(w.download(name).read_text()))
        w.step_is('locate', 'current', 15)
        w.show('#methodos-tracker', 'start')
        return e['places'] == 10 and e['regions'] == 6 and e['contained'] == 10 and e['region identities'] == 6 and e['geometries from the stub'] == [], e
    w.step('record', 'The decisions are saved into the dataset: each place is recorded as within its parish, each parish within its county.', record)

    def locate():
        w.until("() => !document.getElementById('methodos-locate-go').hidden", 60)
        b = w.page.evaluate(LOCATE)
        w.show('#methodos-message'); w.pause(1.2)
        w.click('#methodos-locate-go'); w.step_is('locate', 'done', 60)
        w.until("() => /\\.located\\.json$/.test((document.querySelector('#chosen .name') || {}).textContent || '') && window.__plato.phase === 'detected'", 60)
        s = w.page.evaluate(LOCATE)
        e = A.mydata_ends(json.loads(w.download(s['chosen'][0]).read_text()))
        return (b['go'] == 'Use the locations of 8 places' and b['box'] is False and b['message'].startswith('Use the locations of 8 of 8 matched places.')
                and e['geometries from the stub'] == ['1', '2', '3', '5', '6', '7', '8', '9'] and e['contained'] == 10), {'before': b['message'], 'after': s['message'], 'ends': e}
    w.step('locate', 'The eight matched places take the locations of their gazetteer records: every source here states its licence, so nothing is left out.', locate)

    write_out(w, lambda: 8, 16)

# ---- The run -----------------------------------------------------------------------------------------------------------
def serve():
    """The site built and served here (or --url's), and how to stop it."""
    if A.REMOTE: return A.REMOTE.rstrip('/') + '/', lambda: None
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', PORT)) == 0: sys.exit(f'Port {PORT} is in use, so the page there is not this build: set WALK_PORT to a free port.')
    if '--no-build' not in sys.argv: subprocess.run(['npx', 'vite', 'build'], cwd=ROOT, check=True, capture_output=True)
    if not (ROOT / 'dist' / 'index.html').exists(): sys.exit('walkthrough.py: there is no built site in dist/ (run without --no-build)')
    srv = subprocess.Popen(['npx', 'vite', 'preview', '--host', '127.0.0.1', '--port', str(PORT), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    url = f'http://localhost:{PORT}/'
    for _ in range(60):
        try: urllib.request.urlopen(url, timeout=1); break
        except Exception: time.sleep(0.5)
    else: A.stop(srv); sys.exit('walkthrough.py: the built site did not come up')
    return url, lambda: A.stop(srv)

def films(video, walk):
    """The recording put beside the screenshots, and, with ffmpeg, an mp4 and a small GIF of it. Returns what was written."""
    made = []
    if not video or not video.exists() or video.stat().st_size == 0: return made
    webm = OUT / f'walkthrough-{walk}.webm'; shutil.copyfile(video, webm); made.append(webm)
    ff = shutil.which('ffmpeg')
    if not ff: print('        (ffmpeg is not installed: the recording is kept as .webm only)'); return made
    mp4, gif = OUT / f'walkthrough-{walk}.mp4', OUT / f'walkthrough-{walk}.gif'
    for f in (mp4, gif): f.unlink(missing_ok=True)   # a file left by an earlier run is not this run's
    quiet = [ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(webm)]
    # Small before fine: the mp4 at 8 frames a second (a page that changes step by step needs no more), the GIF at 2, 720
    # pixels wide, in 48 colours with no dithering (flat colour, which is what a page is, and which a GIF packs well).
    jobs = [(mp4, quiet + ['-an', '-vf', 'fps=8', '-c:v', 'libx264', '-preset', 'slow', '-crf', '32', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(mp4)]),
            (gif, quiet + ['-vf', 'fps=2,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', str(gif)])]
    for f, cmd in jobs:
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode == 0 and f.exists() and f.stat().st_size > 0: made.append(f)
        else: print(f'        (ffmpeg did not write {f.name}: {p.stderr.strip()[-200:]})')
    return made

def main():
    if not PROVE:
        OUT.mkdir(parents=True, exist_ok=True)
        for f in list(OUT.glob('[0-9][0-9]-*.png')) + list(OUT.glob('walkthrough-*.*')): f.unlink()   # only this run's files are there after it
    url, stop = serve()
    results, written = [], []
    try:
        with sync_playwright() as pw:
            for name in WALKS:
                print(f'{name}:', flush=True)
                w = Walk(pw, name, url)
                try: {'places': places_walk, 'regions': regions_walk}[name](w)
                except Stopped as e: print(f'  STOPPED at {e}', flush=True)
                finally:
                    w.caption(''); video = w.close()
                    results += w.results
                    written += films(video, name)
                    shutil.rmtree(w.tmp, ignore_errors=True)
    finally: stop()
    passed = [n for n, ok, _ in results if ok]; failed = [n for n, ok, _ in results if not ok]
    if PROVE:
        ok = bool(results) and not passed
        print(f"PROVE-IT-FAILS: {len(failed)} of {len(results)} steps failed against a page with no tools{'' if ok else '; PASSED there: ' + '; '.join(passed)}")
        sys.exit(0 if ok else 1)
    for f in written: print(f'  wrote {f}  ({f.stat().st_size / 1e6:.1f} MB)')
    print(f'  screenshots: {len(list(OUT.glob("[0-9][0-9]-*.png")))} in {OUT}')
    print(f"RESULT: {len(passed)} passed, {len(failed)} failed{'' if not failed else ': ' + '; '.join(failed)}")
    sys.exit(1 if failed or not results else 0)

if __name__ == '__main__': main()
