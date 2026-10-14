// Methodos's projects kept in the World Historical Gazetteer's Workbench (plan #34, item A1; WHG's own
// documentation, "Workbench Projects API"; docs/project-file.md, "Stored in WHG"). A project saved there
// is the .platoproj itself (src/engine/methodos/project.js), carried in a small envelope, so that what is
// opened from WHG is read and checked exactly as a file is: never the envelope's copy of anything.
//
// WHG stores a `plato` project's snapshot without reading it (its doc_type is opaque), as PostgreSQL
// jsonb: the order of keys and the white space are not kept, and a \u0000 is refused. So the project's
// bytes go in as base64, with their size and SHA-256, inside a JSON object whose shape these tools own:
//   { plato: 1, format: 'plato-tools-project', workflow: { id, name, created },
//     formatVersion: '1.1', project: '<base64 of the .platoproj>', size, sha256 }
// `workflow` lets the page match a project in WHG to a workflow of this browser without opening it; it
// is never trusted for anything else (the manifest and the record inside the project are).
//
// Pure: the fetch is given (the page's goes through permissions.fetch, under collaborate:whg; the
// command line's is Node's), as is the token (permissions.token.get), which is sent in the Authorization
// header and nowhere else: never in an address, a title, an error or a log. Every answer is JSON; a
// refusal is a WorkbenchError, whose `kind` says what the page does next and whose message says why in
// words. Nothing here retries on its own but a 429, once, through withPause().
import { Sha256 } from './krisis/digest.js';
import { writeProject, FORMAT, VERSION, MINOR } from './methodos/project.js';
import { fmtBytes } from './words.js';

/** Where the Workbench is: every path below is under it. */
export const WORKBENCH = 'https://whgazetteer.org/reconciliation/';
/** WHG's own page for asking to be enrolled in the Workbench's beta (there is no self-service enrolment). */
export const ENROL = 'https://whgazetteer.org/development/';
export const DOC_TYPE = 'plato';
/** The most a request's whole JSON body may be (POST and PUT): 2 MiB, as WHG documents and enforces it. */
export const BODY_MAX = 2 * 1024 * 1024;
/** The envelope's own version. */
export const ENVELOPE = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const enc = new TextEncoder();
/** Whether `s` is a project's id or a share link's token as WHG writes them (a UUID, in lower case): the only thing put into an address. */
export const isId = (s) => typeof s === 'string' && UUID.test(s);

// ---- Base64 (the project's bytes in the envelope) --------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_AT = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_AT[B64.charCodeAt(i)] = i;
export function toBase64(bytes) {
  const out = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    chunk += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
    if (chunk.length >= 1 << 16) { out.push(chunk); chunk = ''; }
  }
  out.push(chunk);
  return out.join('');
}
/** The bytes of a base64 text, or null if it is not one (no white space, padding only at the end). */
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const q = [0, 1, 2, 3].map((k) => { const ch = text.charCodeAt(i + k); return ch < 128 ? B64_AT[ch] : -1; });
    const last = i + 4 === text.length;
    if (q[0] < 0 || q[1] < 0 || (q[2] < 0 && !(last && pad >= 2 && text[i + 2] === '=')) || (q[3] < 0 && !(last && pad >= 1 && text[i + 3] === '='))) return null;
    out[o++] = (q[0] << 2) | (q[1] >> 4);
    if (o < out.length) out[o++] = ((q[1] & 15) << 4) | (Math.max(q[2], 0) >> 2);
    if (o < out.length) out[o++] = ((Math.max(q[2], 0) & 3) << 6) | Math.max(q[3], 0);
  }
  return out;
}
const hex = (bytes) => new Sha256().update(bytes).hex();

// ---- The envelope ----------------------------------------------------------------------------------
/** The snapshot WHG keeps for the project `bytes` (a .platoproj) of `workflow` ({ id, name, created }). */
export function envelope(bytes, workflow) {
  return {
    plato: ENVELOPE, format: FORMAT,
    workflow: { id: String(workflow?.id ?? ''), name: String(workflow?.name ?? '').slice(0, 255), created: String(workflow?.created ?? '') },
    formatVersion: `${VERSION}.${MINOR}`,
    project: toBase64(bytes), size: bytes.length, sha256: hex(bytes),
  };
}
/**
 * The project's bytes from a snapshot WHG gave back, checked whole (its size and SHA-256), to be read by
 * readProject() as a file is; or a WorkbenchError ('not-ours') in words. Nothing else of it is used.
 */
export function unwrap(snapshot) {
  const no = (why) => { throw new WorkbenchError('not-ours', `This is not a PLATO tools project kept in WHG: ${why}`); };
  if (!isObject(snapshot) || snapshot.format !== FORMAT || !Number.isSafeInteger(snapshot.plato)) no('it does not say it is one.');
  if (snapshot.plato > ENVELOPE) throw new WorkbenchError('not-ours', 'This project was saved to WHG by newer PLATO tools, in a form these tools do not read: open it with the PLATO tools that saved it, or a later version.');
  const bytes = fromBase64(snapshot.project);
  if (!bytes) no('its project is not base64.');
  if (bytes.length !== snapshot.size || hex(bytes) !== snapshot.sha256) no('its project is not the file it says it holds (its size or SHA-256 differs): it may have been damaged on the way.');
  return bytes;
}
/** The workflow a snapshot says it holds ({ id, created }), to match it to one of this browser's; null if it says none. Never trusted for anything else. */
export function workflowOf(snapshot) {
  const w = isObject(snapshot) && snapshot.format === FORMAT && isObject(snapshot.workflow) ? snapshot.workflow : null;
  return w && typeof w.id === 'string' && typeof w.created === 'string' ? { id: w.id, created: w.created, name: typeof w.name === 'string' ? w.name : '' } : null;
}
/** The size in bytes of the request body `body` as it is sent (its JSON, in UTF-8). */
export const bodySize = (body) => enc.encode(JSON.stringify(body)).length;
/** The title a project is given in WHG: the workflow's name (WHG keeps 300 characters). */
export const titleOf = (record) => String(record?.name || 'PLATO tools workflow').slice(0, 300);

// ---- Fitting a project into WHG's cap (D1) ----------------------------------------------------------
/**
 * The project of `record` that fits WHG's cap on a request's body, and the files left out for it: the
 * project is written with every file given (`files`, as writeProject takes them), its envelope made, and
 * the request body `bodyOf(snapshot)` measured, as it will be sent; while it is over `max`, files are
 * left out, the user's own first, then the largest of the steps' (never the record, nor the review), each
 * listed in the manifest's `left` as 'too-large', and it is written again. A write that is plainly over
 * is stopped early. Returns { bytes, snapshot, body, size, tooLarge: [ref] }; when even the record and the
 * review alone are over, throws a WorkbenchError 'too-large' in words that offer the file instead.
 * `own(ref)` says whether a file is the user's own. `refuse` is the secrets no part may hold (writeProject).
 */
export async function fitProject({ record, files = [], left = [], review = null, tools, refuse = [], now, own = () => false, bodyOf = (snapshot) => ({ snapshot }), max = BODY_MAX }) {
  const order = [...files.filter((f) => own(f.ref)), ...files.filter((f) => !own(f.ref)).sort((a, b) => b.ref.size - a.ref.size)];
  const out = [];
  const workflow = { id: record.id, name: record.name, created: record.created };
  const STOP = Symbol('over');
  // Base64 makes 3 bytes 4: a zip over this cannot fit, however small the rest of the body.
  const zipMax = Math.floor((max * 3) / 4);
  for (;;) {
    const keep = files.filter((f) => !out.includes(f));
    const chunks = [];
    let n = 0;
    try {
      await writeProject({ record, files: keep, left: [...left, ...out.map((f) => ({ ref: f.ref, why: 'too-large' }))], review, tools, refuse, ...(now ? { now } : {}) },
        (c) => { n += c.length; if (n > zipMax) throw STOP; chunks.push(c); });
    } catch (e) { if (e !== STOP) throw e; }
    if (n <= zipMax) {
      const bytes = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.length; }
      const snapshot = envelope(bytes, workflow), body = bodyOf(snapshot), size = bodySize(body);
      if (size <= max) return { bytes, snapshot, body, size, tooLarge: out.map((f) => f.ref) };
    }
    const next = order.find((f) => !out.includes(f));
    if (!next) throw new WorkbenchError('too-large', WORDS.tooLargeAlone(max, review), { limit: max });
    out.push(next);
  }
}

// ---- Asking WHG -------------------------------------------------------------------------------------
/** Why a request to the Workbench did not do what was asked. kind: token | unauthenticated | beta | origin | forbidden | gone | unlinked | conflict | too-large | rate | refused | server | network | permission | not-ours | bad-answer. */
export class WorkbenchError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'WorkbenchError'; this.kind = kind; Object.assign(this, extra); }
}

/** What is said of each refusal, in words: what happened, and what to do. Never the token, never an address that holds one. */
export const WORDS = {
  token: 'Your WHG token is needed first: give it in the token field, which is opened for you. Nothing was sent.',
  unauthenticated: 'WHG did not accept your token (it may have been regenerated): give it again in the token field, which is opened for you.',
  beta: 'Keeping projects in WHG is part of its Workbench, which is in beta, and your WHG account is not enrolled in it. It cannot be joined from here: ask WHG to enrol you, through “Get in touch” on its development page.',
  origin: 'WHG does not accept projects from this copy of PLATO tools: only from the tools at pelagios.org.',
  forbidden: {
    save: 'Your role in this WHG project lets you read it, not save to it: save it as a new WHG project of your own instead.',
    delete: 'Only the owner of a WHG project can delete it.',
    share: 'Only an editor or the owner of a WHG project can share it, or stop sharing it.',
    open: 'WHG does not let your account open this project: you are not a member of its team.',
  },
  gone: {
    save: 'WHG no longer has this project: it was deleted, perhaps from another browser. It is no longer linked here; “Save to WHG” makes a new one.',
    share: 'WHG no longer has this project: it was deleted, perhaps from another browser. It is no longer linked here; “Save to WHG” makes a new one, to share.',
    open: 'WHG no longer has this project: it was deleted, perhaps from another browser.',
    list: 'WHG no longer has this project: it was deleted, perhaps from another browser.',
    delete: 'WHG no longer has this project: it was already deleted, perhaps from another browser.',
  },
  goneShared: 'This share link no longer opens anything: the project was deleted, or its owner stopped sharing it.',
  tooLarge: (limit, size) => `Too large for WHG: the request came to ${fmtBytes(size)}, and WHG takes at most ${fmtBytes(limit)}.`,
  tooLargeAlone: (limit, review) => `Too large for WHG even with every file left out: the workflow${review ? ' and the review open' : ''} alone come to more than WHG takes (${fmtBytes(limit)}). Save the project to a file instead (“Save the project”).`,
  rate: (s) => `WHG asks for a pause of ${s} ${s === 1 ? 'second' : 'seconds'} (too many requests in a minute).`,
  rateAgain: 'WHG is still asking for a pause: try again in a minute.',
  failed: {
    save: 'Not saved to WHG. Your work is kept in this browser.',
    list: 'Your projects in WHG could not be listed.',
    open: 'The project was not opened from WHG.',
    delete: 'The project was not deleted from WHG.',
    share: 'Sharing was not changed.',
    shared: 'The shared project could not be read from WHG.',
  },
  server: (status) => `WHG answered with an error (${status}).`,
  badAnswer: 'WHG gave an answer these tools do not understand.',
  refused: (what) => `WHG refused the request${what ? ` (${what})` : ''}.`,
  wrongType: 'This share link is to a WHG project of another kind, not a PLATO tools project: open it in WHG itself.',
};

/** The words for `e` (a WorkbenchError) when doing `action` (save, list, open, delete, share, shared): what happened, then where that leaves the work. */
export function whyWords(e, action = 'save') {
  const failed = WORDS.failed[action] || WORDS.failed.save;
  if (!(e instanceof WorkbenchError)) return `${failed} ${e?.message || e}`;
  if (e.kind === 'forbidden') return WORDS.forbidden[action] || WORDS.forbidden.open;
  if (e.kind === 'gone' && action === 'shared') return WORDS.goneShared;
  if (e.kind === 'gone' && e.status === 404) return WORDS.gone[action] || WORDS.gone.open;
  if (['network', 'permission', 'server', 'bad-answer', 'refused', 'rate'].includes(e.kind)) return `${failed} ${e.message}`;
  return e.message;
}

/**
 * A client of the Workbench at `base`: `fetch(url, init)` (the page's permissions.fetch, under
 * collaborate:whg, or Node's), `token()` the token or null (no request that needs one is made without
 * it), and `userAgent`, sent where a fetch may set one (Node; a browser sends its own).
 */
export function workbench({ fetch, token = () => null, base = WORKBENCH, userAgent = null } = {}) {
  async function call(method, path, { body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (auth) {
      const t = typeof token === 'function' ? token() : null;
      if (!t) throw new WorkbenchError('token', WORDS.token);
      headers.Authorization = `Bearer ${t}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (userAgent) headers['User-Agent'] = userAgent;
    let r;
    try {
      r = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'omit', redirect: 'manual' });
    } catch (e) {
      // permissions.fetch's refusals are in words already, and name a site, never an address.
      throw new WorkbenchError(e?.name === 'PermissionError' ? 'permission' : 'network', e?.name === 'PermissionError' ? e.message : 'WHG could not be reached (this computer may be offline).', { cause: e?.kind });
    }
    let j = null;
    try { j = JSON.parse(await r.text()); } catch { j = null; }
    if (r.status >= 200 && r.status < 300) {
      if (!isObject(j)) throw new WorkbenchError('bad-answer', WORDS.badAnswer, { status: r.status });
      return j;
    }
    throw refusal(r, j);
  }
  return {
    base,
    /** Your projects of these tools ({ id, title, role, version, updated, shared, … }), in every team you are in. */
    async list() {
      const j = await call('GET', `projects/?doc_type=${DOC_TYPE}`);
      if (!Array.isArray(j.projects)) throw new WorkbenchError('bad-answer', WORDS.badAnswer);
      return j.projects.filter((p) => isObject(p) && isId(p.id) && p.doc_type === DOC_TYPE);
    },
    /** A new project in your personal team: { id, version: 1, role }. `body` is sent as given (fitProject measured it so), its doc_type `plato`. */
    async create(body) {
      const j = await call('POST', 'projects/', { body: body.doc_type === DOC_TYPE ? body : { ...body, doc_type: DOC_TYPE } });
      if (!isId(j.id) || !Number.isSafeInteger(j.version)) throw new WorkbenchError('bad-answer', WORDS.badAnswer);
      return j;
    },
    /** A project with its snapshot and version. */
    async get(id) {
      const j = await call('GET', `projects/${need(id)}/`);
      if (j.doc_type !== DOC_TYPE) throw new WorkbenchError('not-ours', WORDS.wrongType);
      return j;
    },
    /** Push `body` ({ snapshot, base_version, title? }): { version }, or a WorkbenchError 'conflict' with WHG's version and snapshot (nothing stored). */
    async push(id, body) {
      const j = await call('PUT', `projects/${need(id)}/`, { body });
      if (!Number.isSafeInteger(j.version)) throw new WorkbenchError('bad-answer', WORDS.badAnswer);
      return j;
    },
    /** Delete a project (its owner only). */
    async remove(id) { return call('DELETE', `projects/${need(id)}/`); },
    /** Share a project read-only: { token } (the same token while it stays shared; a new one after it was stopped). */
    async share(id) {
      const j = await call('POST', `projects/${need(id)}/share/`);
      if (!isId(j.token)) throw new WorkbenchError('bad-answer', WORDS.badAnswer);
      return j;
    },
    /** Stop sharing a project: its link opens nothing from now. */
    async unshare(id) { return call('DELETE', `projects/${need(id)}/share/`); },
    /** What a share link opens, without a token: { title, snapshot, version, doc_type }, refused unless it is these tools'. */
    async shared(shareToken) {
      const j = await call('GET', `shared/${need(shareToken, true)}/`, { auth: false });
      if (j.doc_type !== DOC_TYPE) throw new WorkbenchError('not-ours', WORDS.wrongType);
      return j;
    },
  };
}
// Only a UUID goes into an address: anything else is refused before a request is made, in words that do not repeat it.
function need(id, link = false) {
  if (!isId(id)) throw new WorkbenchError(link ? 'gone' : 'not-ours', link ? WORDS.goneShared : 'That is not the id of a WHG project.');
  return id;
}

/** A refusal from WHG (`r`, its JSON `j`) as a WorkbenchError. */
function refusal(r, j) {
  const status = r.status, code = isObject(j) ? j.code : null;
  if (status === 401) return new WorkbenchError('unauthenticated', WORDS.unauthenticated, { status });
  if (status === 403 && code === 'beta_required') return new WorkbenchError('beta', WORDS.beta, { status, code, link: ENROL });
  if (status === 403 && code === 'origin_not_allowed') return new WorkbenchError('origin', WORDS.origin, { status, code });
  if (status === 403) return new WorkbenchError('forbidden', WORDS.forbidden.open, { status, code });
  if (status === 404) return new WorkbenchError('gone', WORDS.gone.open, { status });
  if (status === 409) return new WorkbenchError('conflict', 'WHG has a newer save of this project than the one this browser last saved or opened.', { status, version: isObject(j) && Number.isSafeInteger(j.version) ? j.version : null, snapshot: isObject(j) && isObject(j.snapshot) ? j.snapshot : null });
  if (status === 413) { const limit = Number(j?.limit) || BODY_MAX, size = Number(j?.size) || 0; return new WorkbenchError('too-large', WORDS.tooLarge(limit, size), { status, limit, size }); }
  if (status === 429) {
    const h = Number.parseInt(r.headers?.get?.('Retry-After') ?? '', 10), b = Number(j?.retry_after);
    const s = Math.min(Math.max(Number.isFinite(h) && h > 0 ? h : Number.isFinite(b) && b > 0 ? Math.ceil(b) : 60, 1), 600);
    return new WorkbenchError('rate', WORDS.rate(s), { status, retryAfter: s });
  }
  if (r.type === 'opaqueredirect' || (status >= 300 && status < 400)) return new WorkbenchError('server', 'WHG answered by sending the request elsewhere, which is not followed.', { status });
  if (status >= 400 && status < 500) return new WorkbenchError('refused', WORDS.refused(isObject(j) && typeof j.error === 'string' ? j.error.slice(0, 200) : `status ${status}`), { status });
  return new WorkbenchError('server', WORDS.server(status), { status });
}

/**
 * Run `fn()`; if WHG asks for a pause (429), wait as long as it asks, once (`wait(seconds)`, awaited: the
 * page counts down), and run it again; asked again, stop, in words. Anything else is thrown as it is.
 */
export async function withPause(fn, wait) {
  try { return await fn(); } catch (e) {
    if (!(e instanceof WorkbenchError) || e.kind !== 'rate') throw e;
    await wait(e.retryAfter);
    try { return await fn(); } catch (e2) {
      if (e2 instanceof WorkbenchError && e2.kind === 'rate') throw new WorkbenchError('rate', WORDS.rateAgain, { retryAfter: e2.retryAfter, again: true });
      throw e2;
    }
  }
}

/** The address of a share link's page: the page's own address (`page`, without its fragment), and #whg-shared=<token>. */
export function shareLink(page, shareToken) {
  const u = new URL(page);
  u.hash = '';
  return `${u.href.replace(/#$/, '')}#whg-shared=${need(shareToken, true)}`;
}
/** The share token in an address or fragment (#whg-shared=<token>), or null. */
export function sharedToken(text) {
  const m = /(?:^|[#&])whg-shared=([0-9a-f-]{36})(?:&|$)/.exec(String(text ?? '').replace(/^[^#]*(?=#)/, ''));
  return m && isId(m[1]) ? m[1] : null;
}
