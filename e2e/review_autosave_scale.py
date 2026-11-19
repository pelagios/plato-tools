"""How long keeping a review's progress takes in a real browser, and how much of that time the page cannot answer.

    python3 e2e/review_autosave_scale.py                       1,000, 10,000 and 50,000 decisions
    python3 e2e/review_autosave_scale.py --sizes=1000,5000     other sizes
    python3 e2e/review_autosave_scale.py --cap-max=50000       fill the store to its cap (MOST reviews) up to this size (default 10000)
    python3 e2e/review_autosave_scale.py --json=FILE           the figures as JSON too

Run it through ~/.config/plato-tools/heavy.sh: a review of 50,000 decisions is some 80 MB of text, held several times over.

What is measured is src/lib/review-progress.js itself, the module the page keeps a review's progress with, loaded in
Playwright's own Chromium from Vite's development server (which serves the source as it is) into an empty page of the
site's origin, with the browser's own
IndexedDB and sessionStorage, in a profile made for the run. A review of N places is constructed in the page in the
shape a lookup in WHG and a bulk accept leave (one candidate for each place, each decided: the fields are those of a
work file made by the walkthrough, e2e/walkthrough.py), and is read by the work file's own reader before anything is
timed: a review the reader refuses would be kept and never put back, and the timings would be of nothing.

For each size:
- the record: how long making it takes with nothing else done (recordOf: the whole review written out as text, the page
  answering nothing meanwhile), and as the page now makes it (recordSlowly: the same text, in pieces, the page answering
  between them): the time in all, and the longest the page was held;
- IndexedDB (working data kept): one keeping of the record as the page makes it at that size, the time in all and the
  longest the page was held; a keeping with every part put at once (as when the page is leaving); then the store filled
  to its cap (MOST reviews) and one more kept, with how many it then holds and what the browser says the origin uses;
- reading it back (get: the text parsed and checked by the work file's reader, in steps, the page answering between
  them), and the same record read at once (readRecord), as it was read before: the time in all, and the longest the page
  was held;
- sessionStorage (working data not kept): whether the record fits, and the largest review that does.

"The longest the page was held" is the longest gap between two turns of a timer set to fire every 4 ms while the work
goes on: what a click or a key would have waited. Every figure is one browser on one machine; the page's own check
(e2e/app_test.py, review_progress_checks) is what says the progress is kept and put back.
"""
import json, os, pathlib, signal, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
def opt(name, default=None):
    return next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith(f'--{name}=')), default)
SIZES = [int(x) for x in opt('sizes', '1000,10000,50000').split(',')]
CAP_MAX = int(opt('cap-max', '10000'))
PORT = int(os.environ.get('SCALE_PORT', '4186'))

# In the page. make(n): a review of n places as a WHG lookup and a bulk accept leave it. held(fn): fn run, with how long it
# took and the longest the page was held meanwhile.
MAKE = r'''  const base = 'https://example.org/gazetteer/place/';
  const make = (n, at = '2026-11-01T10:00:00.000Z') => {
    const places = {}, candidates = [], queries = {};
    for (let i = 0; i < n; i++) {
      const iri = base + i, name = 'Place ' + i;
      places[iri] = { label: name, names: [name, name + ' Magna'], point: null, types: ['settlement'], typeIds: ['http://vocab.getty.edu/aat/300008347'] };
      queries[iri] = { state: 'answered', sent: [name], found: 1, added: 1 };
      candidates.push({ id: 'l1-' + i, candidate_source: iri, candidate_candidate: 'https://w3id.org/whg/id/place:gn:' + (7000000 + i), similarity_score: 1, distance_km: null,
        candidate_status: 'confirmed', generated_at: at, algorithm_version: 'krisis-lookup 1', lookup: 'l1', ccodes_agree: null,
        other: { label: name, names: [name, name + ' Magna', name + ' Parva'], point: [-2.5 + (i % 100) / 100, 53 + (i % 77) / 100], source: { title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' }, ccodes: ['GB'] },
        gazetteer: { service: 'https://whgazetteer.org/reconcile', id: 'place:gn:' + (7000000 + i), score: 100, confidence: 100, match: true, answer_rank: 1, description: 'Country: GB', namespace: 'gn', query: name, dice: null, withheld: false, tie: false },
        decision: { kind: 'match', decided_at: '2026-11-02T09:00:00.000Z', identityType: 'closeMatch', basis: "Accepted in bulk by the reviewer as passing WHG's guard (exact title).",
          guard: { rule: 'whg-guard', threshold: 90, exact: true, score: 100, confidence: 100, dice: null }, batch: 'b1' } });
    }
    return W.readWork(JSON.stringify({ krisis: 3, generated_at: at, algorithm_version: 'krisis-lookup 1', match_parameters: {},
      subjects: { title: 'Places', titleFrom: 'gazetteer', files: [{ name: 'places.json', size: 1000 * n, sha256: 'a'.repeat(64) }] }, others: null, places, regions: {},
      candidates, reviewer: { name: 'Scale Reviewer' }, cursor: 0,
      lookups: [{ id: 'l1', service: { endpoint: 'https://whgazetteer.org/reconcile', title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' }, started_at: at, finished_at: at,
        algorithm_version: 'krisis-lookup 1', parameters: { places: 'unmatched', allNames: false, limit: 10, countries: false, nearKm: null, maxDistanceKm: 50, disagreeKm: 25, type: 'Place', linksKnown: true },
        attribution: { whg: { license: 'CC-BY-4.0' }, sources: { gn: { license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false }, redistributable: true } } },
        counts: { places: n, withoutName: 0, queries: n, requests: Math.ceil(n / 50), answered: n, notFound: 0, unanswered: 0, stopped: 0, found: n, added: n, far: 0,
          skipped: { noIri: 0, linked: 0, denied: 0, decided: 0, duplicate: 0, placeholder: 0 } }, stopped: null, queries }],
      batches: [{ id: 'b1', at: '2026-11-02T09:00:00.000Z', identityType: 'closeMatch', threshold: 90, accepted: n, leftOut: { far: 0, ccodes: 0, kind: 0, total: 0 } }] }));
  };
'''

PAGE = r'''async ([n, capMax]) => {
  const P = await import('/src/lib/review-progress.js');
  const W = await import('/src/engine/krisis/work.js');
''' + MAKE + r'''  const held = async (fn) => {
    let last = performance.now(), worst = 0;
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 4);
    await new Promise((r) => setTimeout(r, 30));
    worst = 0; last = performance.now();
    const t0 = performance.now(), out = await fn(), ms = performance.now() - t0;
    worst = Math.max(worst, performance.now() - last);
    clearInterval(tick);
    return { ms: Math.round(ms), held: Math.round(worst), out };
  };
  const drop = (name) => new Promise((r) => { const q = indexedDB.deleteDatabase(name); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  const count = () => new Promise((res, rej) => { const q = indexedDB.open(P.DB);
    q.onsuccess = () => { const c = q.result.transaction(P.STORE).objectStore(P.STORE).count(); c.onsuccess = () => { res(c.result); q.result.close(); }; }; q.onerror = () => rej(q.error); });
  const r = { n, most: P.MOST };
  await drop(P.DB); sessionStorage.clear();
  const work = make(n);
  r.decided = W.reviewProgress(work).reviewed;                 // the control: the reader took it, and every place is decided
  // The record, made at once.
  const once = await held(async () => P.recordOf(work));
  const record = once.out;
  r.chars = record.text.length; r.recordAtOnce = { ms: once.ms, held: once.held };
  // The record as the page makes it, where the module has it.
  let made = record;
  if (P.recordSlowly) {
    const slow = await held(() => P.recordSlowly(work, { changed: () => false }));
    made = slow.out;
    const read = P.readRecord(made, record.key);   // the control: what was written in pieces is this review
    r.recordSlowly = { ms: slow.ms, held: slow.held, parts: made.parts.length, chars: made.parts.reduce((n, p) => n + p.length, 0), same: !!read && read.reviewed === n && P.sameWork(read.work, work) };
  }
  // IndexedDB: the record as the page makes it for a review of this size (in pieces from SLOWLY_FROM candidates, where the module has that).
  if (!(n >= (P.SLOWLY_FROM || Infinity))) made = record;
  r.kept = made === record ? 'made at once' : 'made in pieces';
  const kept = P.progressStore({ keep: () => true });
  const first = await held(() => kept.put(made));
  r.put = { ms: first.ms, held: first.held, where: first.out };
  const again = await held(() => kept.put({ ...made, at: new Date().toISOString() }));
  r.putAgain = { ms: again.ms, held: again.held, where: again.out };
  const back = await held(() => kept.get(record.key));
  r.get = { ms: back.ms, held: back.held, reviewed: back.out && back.out.reviewed, same: !!back.out && P.sameWork(back.out.work, work) };
  // The same record read at once (readRecord: the text parsed and checked with no turn given), as the store read it before: both in this run, under this code.
  const whole = await held(async () => P.readRecord(made, record.key));
  r.readAtOnce = { ms: whole.ms, held: whole.held, reviewed: whole.out && whole.out.reviewed };
  if (P.recordSlowly) { const leaving = await held(() => kept.put({ ...record, at: new Date().toISOString() }, { atOnce: true })); r.putLeaving = { ms: leaving.ms, held: leaving.held, where: leaving.out }; }
  if (n <= capMax) {
    for (let i = 0; i < P.MOST; i++) {
      const other = make(n, new Date(Date.parse('2026-11-01T10:00:00Z') + (i + 1) * 1000).toISOString());
      await kept.put(P.recordOf(other, { at: new Date(Date.now() + i) }));
    }
    const over = await held(() => kept.put({ ...record, at: new Date(Date.now() + 1000).toISOString() }));
    const est = await navigator.storage.estimate();
    r.cap = { ms: over.ms, held: over.held, where: over.out, holds: await count(), usageMB: Math.round(est.usage / 1e6), quotaMB: Math.round(est.quota / 1e6) };
  }
  await kept.forgetAll();
  // sessionStorage: working data not kept.
  const tab = P.progressStore({ keep: () => false });
  const t = await held(() => tab.put(made));
  r.tab = { ms: t.ms, held: t.held, where: t.out, chars: JSON.stringify(record).length };
  await tab.forgetAll(); sessionStorage.clear();
  return r;
}'''

# The largest review the tab keeps (sessionStorage), found by halving between one that fits and one that does not.
FITS = r'''async (n) => {
  const P = await import('/src/lib/review-progress.js'), W = await import('/src/engine/krisis/work.js');
''' + MAKE + r'''  sessionStorage.clear();
  const work = make(n), record = P.recordOf(work);
  const tab = P.progressStore({ keep: () => false, indexedDB: null });
  const where = await tab.put(record);
  await tab.forgetAll(); sessionStorage.clear();
  return { where, chars: JSON.stringify(record).length };
}'''

def serve():
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', PORT)) == 0: sys.exit(f'Port {PORT} is in use: set SCALE_PORT to a free port.')
    srv = subprocess.Popen(['npx', 'vite', '--host', '127.0.0.1', '--port', str(PORT), '--strictPort'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    url = f'http://localhost:{PORT}/'
    for _ in range(120):
        try: urllib.request.urlopen(url, timeout=1); return url, srv
        except Exception: time.sleep(0.5)
    os.killpg(srv.pid, signal.SIGTERM); sys.exit('the development server did not come up')

def blank(page, url):
    """An empty page of the site's origin (answered here: the server has none), so that nothing but the module is at work."""
    page.route('**/__scale.html', lambda r: r.fulfill(content_type='text/html', body='<!doctype html><title>scale</title>'))
    page.goto(url + '__scale.html')

def main():
    url, srv = serve()
    rows = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for n in SIZES:
                ctx = browser.new_context()      # its own storage: nothing of another size's is there
                page = ctx.new_page(); page.set_default_timeout(1_800_000)
                blank(page, url)
                r = page.evaluate(PAGE, [n, CAP_MAX])
                if r['decided'] != n: sys.exit(f'the review constructed has {r["decided"]} of {n} places decided: nothing measured')
                if r.get('recordSlowly') and not r['recordSlowly']['same']: sys.exit(f'the review of {n} written out in pieces does not read back as the review: nothing measured')
                if r['get']['reviewed'] != n or not r['get']['same']: sys.exit(f'the review of {n} kept in IndexedDB reads back with {r["get"]["reviewed"]} places decided, {"the same review" if r["get"]["same"] else "not the review kept"}: nothing measured')
                if r['readAtOnce']['reviewed'] != n: sys.exit(f'the review of {n} read at once has {r["readAtOnce"]["reviewed"]} places decided: nothing measured')
                rows.append(r); print(json.dumps(r), flush=True)
                ctx.close()
            # sessionStorage's room, in decisions.
            ctx = browser.new_context(); page = ctx.new_page(); page.set_default_timeout(600_000)
            blank(page, url)
            lo, hi = 1, 20000
            fit = lambda n: page.evaluate(FITS, n)
            if fit(lo)['where'] != 'tab': sys.exit('a review of one decision does not fit the tab: nothing measured')
            if fit(hi)['where'] == 'tab': sys.exit(f'a review of {hi} decisions fits the tab: the search has no upper end')
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if fit(mid)['where'] == 'tab': lo = mid
                else: hi = mid
            room = {'largest that fits': lo, 'chars': fit(lo)['chars'], 'first that does not': hi}
            print(json.dumps({'sessionStorage': room}), flush=True)
            browser.close()
    finally:
        try: os.killpg(srv.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    print(f"\n{'decisions':>9} {'text MB':>8} | {'record at once':>15} | {'record in pieces':>17} | {'IndexedDB put':>14} | {'get':>12} | {'read at once':>12} | {'at the cap':>22} | tab")
    f = lambda x: f"{x['ms']} ms/{x['held']}" if x else '-'
    for r in rows:
        cap = f"{r['cap']['ms']} ms, {r['cap']['holds']} kept, {r['cap']['usageMB']} MB" if r.get('cap') else '-'
        print(f"{r['n']:>9} {r['chars'] / 1e6:>8.1f} | {f(r['recordAtOnce']):>15} | {f(r.get('recordSlowly')):>17} | {f(r['put']):>14} | {f(r['get']):>12} | {f(r['readAtOnce']):>12} | {cap:>22} | {r['tab']['where']}")
    print('(each "a ms/b": a in all, b the longest the page was held)')
    out = opt('json')
    if out: pathlib.Path(out).write_text(json.dumps({'rows': rows, 'sessionStorage': room}, indent=2))

if __name__ == '__main__': main()
