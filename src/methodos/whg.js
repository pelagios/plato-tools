// Methodos's projects in WHG's Workbench, for the page (plan #34, item A1): saving the workflow there,
// opening one from there, deleting, sharing and reading a share link, each through the engine's client
// (src/engine/workbench.js) and the link kept beside the workflow's record (store.js, setLink/linkFor).
// What is said, and what is asked of the user, is the page's (page.js); here is only what is done, so
// that the tests can do it with a fake WHG and a fake IndexedDB.
//
// The link is local and only local: { projectId, version, sha256, shared, savedAt, base, title, state },
// the version and SHA-256 last pushed or pulled (so that a merge of decisions can be added later, D2),
// and `state`, a digest of the workflow and its review then, so that the page can say it has changed
// since. A save is only ever asked for by the user (D3), only to the personal team (D4), and never
// overwrites a newer save in WHG: a 409 comes back to the page, which offers to open WHG's copy or to save
// this one as a new project.
import { Sha256 } from '../engine/krisis/digest.js';
import { fitProject, unwrap, workflowOf, withPause, titleOf, WorkbenchError, DOC_TYPE } from '../engine/workbench.js';
import { projectName } from '../engine/methodos/project.js';

/** The JSON of `v` with every object's keys in order, so that the same data gives the same text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
/** A digest of the workflow (its record, when it was kept left aside) and the review open: what a save to WHG holds that can change. */
export function stateOf(record, reviewText = null) {
  const r = { ...record };
  delete r.saved;
  return new Sha256().update(new TextEncoder().encode(canonical({ record: r, review: reviewText ?? null }))).hex();
}

/**
 * The page's dealings with WHG: `client` (workbench() from the engine), `store` (workflowStore()),
 * `now()` the time. Each call takes `wait(seconds)`, which the page counts down when WHG asks for a pause.
 */
export function whgProjects({ client, store, now = () => new Date() }) {
  const run = (fn, wait) => (wait ? withPause(fn, wait) : fn());
  const linkOf = (record, j, extra = {}) => ({ projectId: j.projectId, version: j.version, sha256: j.sha256, shared: !!j.shared, savedAt: now().toISOString(), base: client.base, title: j.title, ...extra });
  return {
    /** The link kept for the workflow `id`, or null. */
    linkFor: (id) => store.linkFor(id),
    /** Keep (or, with null, let go) the link of the workflow `id`. */
    setLink: (id, link) => store.setLink(id, link),
    /**
     * Fit the project (fitProject's arguments, `project`) to WHG as it would be sent: for an update of
     * `linked` ({ projectId, version }) or, without one, as a new project: the very body sent (a new one's
     * doc_type included), so that what is measured is what WHG measures.
     */
    fit(project, linked = null) {
      const title = titleOf(project.record);
      return fitProject({ ...project, bodyOf: (snapshot) => (linked ? { snapshot, base_version: linked.version, title } : { snapshot, doc_type: DOC_TYPE, title }) });
    },
    /**
     * Save the workflow to WHG: `project` as fit() takes it; `to` the project to update ({ projectId,
     * version }: the link, or a match from your list), or null for a new one in your personal team.
     * Returns { link, tooLarge, size, created }, the link kept. A 409 is thrown as it comes (a WorkbenchError
     * 'conflict' with WHG's version and snapshot), nothing stored either side; a 404 lets the link go first.
     */
    async save({ project, to = null, review = null, shared = false, wait }) {
      const { record } = project;
      const fitted = await this.fit(project, to);
      const title = titleOf(record);
      let j;
      try {
        j = await run(() => (to ? client.push(to.projectId, fitted.body) : client.create(fitted.body)), wait);
      } catch (e) {
        if (e instanceof WorkbenchError && e.kind === 'gone' && to) await this.forget(record.id);
        throw e;
      }
      const projectId = to ? to.projectId : j.id;
      const link = linkOf(record, { projectId, version: j.version, sha256: fitted.snapshot.sha256, shared: to ? shared : false, title }, { state: stateOf(record, review) });
      await store.setLink(record.id, { ...(await store.linkFor(record.id)), ...link });
      return { link, tooLarge: fitted.tooLarge, size: fitted.size, created: !to };
    },
    /** Let the link of the workflow `id` go (its origin, if it was copied from a share link, is kept). */
    async forget(id) {
      const was = await store.linkFor(id);
      await store.setLink(id, was?.origin ? { origin: was.origin } : null);
    },
    /** Your projects of these tools in WHG: [{ id, title, role, version, updated, shared }], newest first. */
    async list(wait) {
      const all = await run(() => client.list(), wait);
      return all.map((p) => ({ id: p.id, title: String(p.title ?? ''), role: p.role, version: p.version, updated: p.updated, shared: !!p.shared, personal: !!p.is_personal_team }))
        .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    },
    /**
     * The projects in your list that hold the workflow `record` (its id and when it was begun, as their
     * envelope says), each opened to see (only those titled as it is, at most `limit`); those you can save to.
     */
    async matches(record, wait, { limit = 10 } = {}) {
      const title = titleOf(record);
      const same = (await this.list(wait)).filter((p) => p.title === title && ['owner', 'editor'].includes(p.role)).slice(0, limit);
      const out = [];
      for (const p of same) {
        let j;
        try { j = await run(() => client.get(p.id), wait); } catch (e) { if (e instanceof WorkbenchError && ['gone', 'forbidden', 'not-ours'].includes(e.kind)) continue; throw e; }
        const w = workflowOf(j.snapshot);
        if (w && w.id === record.id && w.created === record.created) out.push({ ...p, version: j.version });
      }
      return out;
    },
    /** A project from WHG: { blob, name, title, version, sha256, role, shared }, its envelope checked; readProject() is the page's. */
    async open(projectId, wait) {
      const j = await run(() => client.get(projectId), wait);
      return { ...fromSnapshot(j.snapshot, j.title), projectId, version: j.version, role: j.role, shared: !!j.shared };
    },
    /** The link to keep once the project opened from WHG (`got`, from open(), or a conflict's copy) is the workflow `record`'s. */
    async opened(record, got, review = null) {
      const link = linkOf(record, { projectId: got.projectId, version: got.version, sha256: got.sha256, shared: got.shared, title: got.title }, { state: stateOf(record, review) });
      await store.setLink(record.id, link);
      return link;
    },
    /** Delete a project from WHG (its owner only); the link of any workflow here to it is the page's to let go. */
    async remove(projectId, wait) { await run(() => client.remove(projectId), wait); },
    /** Share the linked project read-only: its token, which is never kept (only that it is shared). */
    async share(id, wait) {
      const link = await store.linkFor(id);
      if (!link?.projectId) throw new WorkbenchError('gone', 'This workflow is not saved to WHG yet: save it there first.');
      let j;
      try { j = await run(() => client.share(link.projectId), wait); } catch (e) { if (e instanceof WorkbenchError && e.kind === 'gone') await this.forget(id); throw e; }
      await store.setLink(id, { ...link, shared: true });
      return j.token;
    },
    /** Stop sharing the linked project: its link opens nothing from now. */
    async unshare(id, wait) {
      const link = await store.linkFor(id);
      if (!link?.projectId) return;
      try { await run(() => client.unshare(link.projectId), wait); } catch (e) { if (e instanceof WorkbenchError && e.kind === 'gone') { await this.forget(id); return; } throw e; }
      await store.setLink(id, { ...link, shared: false });
    },
    /** What a share link opens: { blob, name, title, version, sha256 }, read with no token. */
    async shared(token, wait) {
      const j = await run(() => client.shared(token), wait);
      return { ...fromSnapshot(j.snapshot, j.title), version: j.version };
    },
  };
}

/** The project in a snapshot WHG gave, as a file to open: { blob, name, title, sha256 }. */
export function fromSnapshot(snapshot, title) {
  const bytes = unwrap(snapshot);
  const name = projectName({ name: String(title || snapshot?.workflow?.name || 'workflow') });
  return { blob: new Blob([bytes], { type: 'application/zip' }), name, title: String(title ?? ''), sha256: snapshot.sha256 };
}
