// A fake of WHG's Workbench projects API, for the tests and the browser checks: never the real WHG. It
// copies the behaviour of WHG's own code (whg3 workbench/access.py, views.py, doctypes.py, models.py, and
// what workbench/tests_bearer.py asserts), in the order WHG does it:
//   - CORS for an allow-list of exact origins only: a preflight (OPTIONS) is answered before anything
//     else, 204, with the CORS headers only for an allowed origin; every answer to an allowed origin
//     carries Access-Control-Allow-Origin, Vary: Origin and Access-Control-Expose-Headers: Retry-After,
//     and never Access-Control-Allow-Credentials;
//   - Bearer only (never ?token=): a token not known, or its user inactive, 401 with WWW-Authenticate;
//     then an Origin outside the allow-list (and not WHG's own), 403 origin_not_allowed; then the budget,
//     a fixed one-minute window per user, 429 rate_limited with retry_after and Retry-After; then the
//     beta, 403 beta_required; no token, 401 (a cookie is not modelled: these tools never send one);
//   - the body cap on POST and PUT (after authentication), 413 body_too_large with limit and size;
//   - the views: projects/ (GET ?doc_type=, POST), projects/<uuid>/ (GET, PUT, DELETE),
//     projects/<uuid>/share/ (POST, DELETE), shared/<token>/ (GET, anonymous), every refusal JSON, and 405
//     with Allow for a method a view does not take; a path that is no view, Django's HTML 404;
//   - the snapshot kept as PostgreSQL's jsonb keeps it: a \u0000 anywhere refused (a 500, as the database
//     error would be), and the keys of every object given back in jsonb's order (shorter keys first, then
//     by their bytes), not the order they were sent in; the newest 25 versions kept.
// Run as a server for the browser checks: node test/workbench-fake.js serve --port <n> --origin <origin>…,
// with a control API under /__fake/ (POST JSON) for what a check sets up, and what it reads back.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const PREFIX = '/reconciliation/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const EDIT = ['owner', 'editor'];
const OPAQUE = ['plato'];
const DOC_TYPES = ['reconciliation', 'place_collection', 'itinerary', 'gazetteer_group', 'place_record', 'dataset_edit', 'plato'];

/** What jsonb gives back for `v`: every object's keys shorter first, then by their UTF-8 bytes; a \u0000 refused. */
export function jsonb(v) {
  if (typeof v === 'string') { if (v.includes('\u0000')) throw new Error('unsupported Unicode escape sequence'); return v; }
  if (Array.isArray(v)) return v.map(jsonb);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    for (const k of keys) if (k.includes('\u0000')) throw new Error('unsupported Unicode escape sequence');
    const b = (k) => Buffer.from(k, 'utf8');
    keys.sort((x, y) => b(x).length - b(y).length || Buffer.compare(b(x), b(y)));
    return Object.fromEntries(keys.map((k) => [k, jsonb(v[k])]));
  }
  return v;
}

/**
 * A fake Workbench: `origins` the allow-list (WHG's is https://pelagios.org), `self` WHG's own origin,
 * `rate` token requests a minute per user, `bodyMax` the body cap, `clock()` the time in ms.
 */
export function workbenchFake({ origins = ['https://pelagios.org'], self = 'https://whgazetteer.org', rate = 120, bodyMax = 2 * 1024 * 1024, clock = () => Date.now() } = {}) {
  const users = new Map(), tokens = new Map(), teams = new Map(), projects = new Map(), budget = new Map();
  let held = null;   // the minute held while cfg.holdMinute
  let nextUser = 1, nextTeam = 1;
  const log = [];
  const cfg = { origins: [...origins], rate, bodyMax, retryAfter: null, fail: 0, holdMinute: false };   // holdMinute: the minute does not turn while true, so a check that spends the budget is not undone by the wall clock   // fail: the next n requests (not preflights) answered 503, as a server down for a moment   // retryAfter: a fixed wait for a 429, for the browser checks (WHG's is the rest of its minute)

  function addUser({ token, name = `user${nextUser}`, beta = true, active = true } = {}) {
    const u = { id: nextUser++, name, beta, active };
    users.set(u.id, u);
    if (token) tokens.set(token, u.id);
    return u;
  }
  function personal(u) {
    for (const t of teams.values()) if (t.personal && t.owner === u.id) return t;
    const t = { id: nextTeam++, title: 'My workbench', personal: true, owner: u.id, members: new Map([[u.id, 'owner']]) };
    teams.set(t.id, t);
    return t;
  }
  const roleFor = (p, u) => teams.get(p.team)?.members.get(u.id) ?? null;
  const dict = (p, role) => ({ id: p.id, title: p.title, team: p.team, team_title: teams.get(p.team).title, role, version: p.version, status: p.status, doc_type: p.doc_type,
    updated: new Date(p.updated).toISOString().replace('Z', '+00:00'), shared: !!p.public_token, is_personal_team: teams.get(p.team).personal, published_collection: null });
  const store = (p, snapshot, u) => {
    p.snapshot = jsonb(snapshot);
    p.history.unshift({ version: p.version, snapshot: p.snapshot, by: u?.id ?? null });
    p.history.length = Math.min(p.history.length, 25);
    p.updated = clock();
  };

  // ---- the views (views.py) -----------------------------------------------------------------------
  const json = (status, body, headers = {}) => ({ status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const err = (status, error, code, extra = {}) => json(status, { error, ...(code ? { code } : {}), ...extra });
  const parse = (body) => { try { const v = JSON.parse(body || '{}'); return v; } catch { return {}; } };

  function projectsView(req, u, query) {
    if (req.method === 'GET') {
      const mine = [...teams.values()].filter((t) => t.members.has(u.id)).map((t) => t.id);
      let qs = [...projects.values()].filter((p) => mine.includes(p.team));
      const wanted = (query.get('doc_type') || '').trim();
      if (wanted) { if (!DOC_TYPES.includes(wanted)) return err(400, `unknown doc_type: ${wanted}`); qs = qs.filter((p) => p.doc_type === wanted); } else qs = qs.filter((p) => !OPAQUE.includes(p.doc_type));
      return json(200, { projects: qs.map((p) => dict(p, roleFor(p, u))) });
    }
    const data = parse(req.body);
    const snapshot = data.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return err(400, 'snapshot (object) is required');
    const docType = data.doc_type || 'reconciliation';
    if (!DOC_TYPES.includes(docType)) return err(400, `unknown doc_type: ${docType}`);
    let title = data.title;
    if (!title && !OPAQUE.includes(docType)) title = snapshot.title || snapshot.fileName;
    title = String(title || 'Untitled project').slice(0, 300);
    let team;
    if (data.team === undefined || data.team === null || data.team === '' || data.team === 'personal') team = personal(u);
    else { team = teams.get(data.team); if (!team || !EDIT.includes(team.members.get(u.id))) return err(403, 'you are not an editor of that team'); }
    const p = { id: randomUUID(), title, team: team.id, doc_type: docType, version: 1, status: 'draft', public_token: null, history: [], updated: clock(), created_by: u.id };
    try { store(p, snapshot, u); } catch (e) { return { status: 500, headers: { 'Content-Type': 'text/html' }, body: '<h1>Server Error (500)</h1>' }; }
    projects.set(p.id, p);
    return json(201, { id: p.id, version: 1, team: team.id, doc_type: docType, role: team.personal ? 'owner' : roleFor(p, u) });
  }

  function detailView(req, u, pid) {
    const p = projects.get(pid);
    if (!p) return err(404, 'not found', 'not_found');
    const role = roleFor(p, u);
    if (!role) return err(403, 'not a member of this project’s team');
    if (req.method === 'GET') {
      return json(200, { id: p.id, title: p.title, team: p.team, team_title: teams.get(p.team).title, team_personal: teams.get(p.team).personal, role, version: p.version, status: p.status,
        doc_type: p.doc_type, shared: !!p.public_token, published_collection: null, can_apply: true, snapshot: p.snapshot });
    }
    if (req.method === 'DELETE') {
      if (role !== 'owner') return err(403, 'only an owner can delete a project');
      projects.delete(pid);
      return json(200, { ok: true });
    }
    if (!EDIT.includes(role)) return err(403, 'view-only: your role cannot edit this project');
    const data = parse(req.body);
    if (!data.snapshot || typeof data.snapshot !== 'object' || Array.isArray(data.snapshot)) return err(400, 'snapshot (object) is required');
    if (!Number.isInteger(data.base_version) || typeof data.base_version !== 'number') return err(400, 'base_version (int) is required');
    if (data.base_version !== p.version) {
      if (OPAQUE.includes(p.doc_type)) return json(409, { status: 'conflict', reason: 'opaque', version: p.version, snapshot: p.snapshot });
      return json(409, { status: 'stale', version: p.version, snapshot: p.snapshot });   // the merge of other types is not modelled
    }
    const title = typeof data.title === 'string' ? data.title : null;
    const was = { snapshot: p.snapshot, version: p.version, history: [...p.history] };
    p.version += 1;
    try { store(p, data.snapshot, u); } catch { Object.assign(p, was); return { status: 500, headers: { 'Content-Type': 'text/html' }, body: '<h1>Server Error (500)</h1>' }; }
    if (title) p.title = title.slice(0, 300);
    return json(200, { status: 'ok', version: p.version, snapshot: null });
  }

  function shareView(req, u, pid) {
    const p = projects.get(pid);
    if (!p) return err(404, 'not found', 'not_found');
    if (!EDIT.includes(roleFor(p, u))) return err(403, 'only an editor or owner can share a project');
    if (req.method === 'DELETE') {
      p.public_token = null;
      if (p.status === 'shared') p.status = 'draft';
      p.updated = clock();
      return json(200, { ok: true, shared: false });
    }
    if (!p.public_token) p.public_token = randomUUID();
    if (p.status === 'draft') p.status = 'shared';
    p.updated = clock();
    return json(200, { ok: true, shared: true, token: p.public_token, url: OPAQUE.includes(p.doc_type) ? null : `${self}${PREFIX}?shared=${p.public_token}`, doc_type: p.doc_type });
  }

  function sharedView(req, token) {
    if (!UUID_ANY.test(token)) return err(404, 'not found', 'not_found');
    const t = token.toLowerCase().replace(/^(.{8})-?(.{4})-?(.{4})-?(.{4})-?(.{12})$/, '$1-$2-$3-$4-$5');
    const p = [...projects.values()].find((x) => x.public_token === t);
    if (!p) return err(404, 'not found', 'not_found');
    return json(200, { title: p.title, snapshot: p.snapshot, version: p.version, doc_type: p.doc_type, read_only: true });
  }

  // ---- access.py: CORS, authentication, the budget, the beta, the body cap --------------------------
  const ROUTES = [
    [/^projects\/$/, ['GET', 'POST'], true, (req, u, m, q) => projectsView(req, u, q)],
    [/^projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/$/, ['GET', 'PUT', 'DELETE'], true, (req, u, m) => detailView(req, u, m[1])],
    [/^projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/share\/$/, ['POST', 'DELETE'], true, (req, u, m) => shareView(req, u, m[1])],
    [/^shared\/([^/]+)\/$/, ['GET'], false, (req, u, m) => sharedView(req, decodeURIComponent(m[1]))],
  ];
  const header = (req, name) => { const h = req.headers || {}; for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k]; return undefined; };
  function withCors(res, origin) {
    if (!origin) return res;
    const vary = res.headers.Vary ? `${res.headers.Vary}, Origin` : 'Origin';
    return { ...res, headers: { ...res.headers, 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After', Vary: vary } };
  }
  /** Answer one request: { method, url (absolute, or a path), headers, body (a string) } -> { status, headers, body }. */
  function handle(req) {
    const url = new URL(req.url, self);
    const entry = { method: req.method, url: url.href, path: url.pathname + url.search, headers: Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: req.body ?? '' };
    log.push(entry);
    const res = route(req, url);
    entry.status = res.status;
    return res;
  }
  function route(req, url) {
    if (!url.pathname.startsWith(PREFIX)) return { status: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>Not Found</h1>' };
    const rest = url.pathname.slice(PREFIX.length);
    const hit = ROUTES.map((r) => [r, r[0].exec(rest)]).find(([, m]) => m);
    if (!hit) {
      // Django's APPEND_SLASH: a path that would match with a slash is redirected (a GET), else the HTML 404.
      if (!rest.endsWith('/') && ROUTES.some((r) => r[0].test(rest + '/'))) return { status: 301, headers: { Location: `${PREFIX}${rest}/${url.search}` }, body: '' };
      return { status: 404, headers: { 'Content-Type': 'text/html' }, body: '<h1>Not Found</h1>' };
    }
    const [[, methods0, auth, view], m] = hit;
    const methods = [...methods0, 'OPTIONS'];
    const origin = header(req, 'origin');
    const corsOrigin = origin && cfg.origins.includes(origin) ? origin : null;
    if (req.method === 'OPTIONS') {
      const res = { status: 204, headers: { 'Content-Type': 'application/json', Allow: methods.join(', ') }, body: '' };
      if (!corsOrigin) return res;
      const out = withCors(res, corsOrigin);
      Object.assign(out.headers, { 'Access-Control-Allow-Methods': methods.join(', '), 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
      return out;
    }
    if (cfg.fail > 0) { cfg.fail -= 1; return withCors({ status: 503, headers: { 'Content-Type': 'text/html' }, body: '<h1>Service Unavailable</h1>' }, corsOrigin); }
    return withCors(dispatch(req, url, methods, auth, view, m, origin), corsOrigin);
  }
  function dispatch(req, url, methods, auth, view, m, origin) {
    if (!methods.includes(req.method)) return { ...err(405, 'method not allowed', 'method_not_allowed'), headers: { 'Content-Type': 'application/json', Allow: methods.join(', ') } };
    let u = null;
    if (auth) {
      const a = header(req, 'authorization') || '';
      const key = a.toLowerCase().startsWith('bearer ') ? a.split(' ').slice(1).join(' ').trim() : null;
      const unauth = (msg) => ({ ...err(401, msg, 'unauthenticated'), headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="workbench"' } });
      if (key === null) return unauth('authentication required: send a WHG API token as "Authorization: Bearer <token>", or sign in');
      u = users.get(tokens.get(key));
      if (!u || !u.active) return unauth('invalid API token');
      if (origin && !cfg.origins.includes(origin) && origin !== self) return err(403, 'this origin may not use the Workbench API', 'origin_not_allowed');
      if (cfg.rate) {
        const now = clock() / 1000;
        held = cfg.holdMinute ? held ?? Math.floor(now / 60) : null;
        const window = held ?? Math.floor(now / 60), k = `${u.id}:${window}`;
        const used = (budget.get(k) || 0) + 1;
        budget.set(k, used);
        if (used > cfg.rate) {
          const retry = cfg.retryAfter ?? Math.max(1, Math.floor((window + 1) * 60 - now));
          return { ...err(429, `rate limit exceeded: at most ${cfg.rate} Workbench requests per minute per token; retry after ${retry}s`, 'rate_limited', { retry_after: retry }), headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) } };
        }
      }
      if (!u.beta) return err(403, 'the Workbench is in beta and this account is not enrolled', 'beta_required');
    }
    if (cfg.bodyMax && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const size = Buffer.byteLength(req.body || '', 'utf8');
      if (size > cfg.bodyMax) return err(413, `request body too large: ${size} bytes; the limit is ${cfg.bodyMax} bytes`, 'body_too_large', { limit: cfg.bodyMax, size });
    }
    return view(req, u, m, url.searchParams);
  }

  /** As fetch(): a Response for (url, init), through handle(). Credentials and redirects are the caller's to set. */
  async function fetch(url, init = {}) {
    const headers = {};
    if (init.headers) for (const [k, v] of Object.entries(init.headers)) headers[k] = v;
    const r = handle({ method: (init.method || 'GET').toUpperCase(), url: String(url), headers, body: init.body ?? '' });
    return new Response(r.status === 204 || r.status === 301 ? null : r.body, { status: r.status, headers: r.headers });
  }

  return {
    handle, fetch, log, cfg, users, projects, teams,
    addUser,
    /** A team of `owner`'s (not personal), with `members` [[user, role]]. */
    addTeam(owner, members = [], title = 'A team') {
      const t = { id: nextTeam++, title, personal: false, owner: owner.id, members: new Map([[owner.id, 'owner'], ...members.map(([u, r]) => [u.id, r])]) };
      teams.set(t.id, t);
      return t;
    },
    /** Move a project to a team (as if it had been made there). */
    moveTo(p, team) { projects.get(p).team = team.id; },
    /** Another browser's save: the project's snapshot replaced, its version up by one. */
    pushAs(pid, snapshot, u = null) { const p = projects.get(pid); p.version += 1; store(p, snapshot, u); return p.version; },
    /** Reset the per-minute budgets (a new minute). */
    newMinute() { budget.clear(); held = null; },
  };
}

// ---- As a server, for the browser checks (e2e/app_test.py) -------------------------------------------
// POST /__fake/<what> (JSON) sets it up and reads it back: user {token, beta?, active?}; config {origins?,
// rate?, bodyMax?, retryAfter?, fail?}; remove {id}; log (the requests so far, and clears them if {clear: true}); projects (every project,
// with its snapshot); push {id, snapshot} (another browser's save); share {id} / unshare {id} as the owner
// would; create {token, title, snapshot, doc_type} (a project made elsewhere); newMinute.
export function serve(fake, port, host = '127.0.0.1') {
  const control = {
    user: (b) => ({ id: fake.addUser(b).id }),
    config: (b) => { for (const k of ['origins', 'rate', 'bodyMax', 'retryAfter', 'fail', 'holdMinute']) if (b[k] !== undefined) fake.cfg[k] = b[k]; return { ...fake.cfg }; },
    log: (b) => { const out = fake.log.map((x) => ({ ...x, body: x.body.length > 4096 ? `${x.body.slice(0, 4096)}…` : x.body, size: x.body.length })); if (b.clear) fake.log.length = 0; return out; },
    projects: () => [...fake.projects.values()].map((p) => ({ id: p.id, title: p.title, version: p.version, doc_type: p.doc_type, shared: !!p.public_token, token: p.public_token, snapshot: p.snapshot, team: p.team })),
    push: (b) => ({ version: fake.pushAs(b.id, b.snapshot) }),
    create: (b) => { const r = fake.handle({ method: 'POST', url: `${PREFIX}projects/`, headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ snapshot: b.snapshot, title: b.title, doc_type: b.doc_type || 'plato' }) }); fake.log.pop(); return JSON.parse(r.body); },
    share: (b) => { const p = fake.projects.get(b.id); if (!p.public_token) p.public_token = randomUUID(); return { token: p.public_token }; },
    unshare: (b) => { fake.projects.get(b.id).public_token = null; return { ok: true }; },
    newMinute: () => { fake.newMinute(); return { ok: true }; },
    remove: (b) => { fake.projects.delete(b.id); return { ok: true }; },
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url.startsWith('/__fake/')) {
        const what = req.url.slice(8).replace(/\/$/, '');
        let out;
        try { out = { status: 200, body: JSON.stringify(control[what](JSON.parse(body || '{}'))) }; } catch (e) { out = { status: 500, body: JSON.stringify({ error: String(e?.message || e) }) }; }
        res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(out.body); return;
      }
      const r = fake.handle({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(r.status, r.headers); res.end(r.body);
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === 'serve') {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  const origins = process.argv.flatMap((a, i) => (a === '--origin' ? [process.argv[i + 1]] : []));
  const fake = workbenchFake({ origins: origins.length ? origins : undefined });
  serve(fake, Number(arg('port') || 0)).then((s) => { process.stdout.write(`listening ${s.address().port}\n`); });
}
