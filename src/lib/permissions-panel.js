// The Permissions panel, one for the whole toolbox, on index.html and chora.html alike: a native
// <dialog> opened with showModal(), its heading (or the permission asked about) given the focus, closed
// by Esc or its Close button, the focus going back to what opened it. It is given the module's
// functions (src/lib/permissions.js) and has no state of its own: every change goes through them, and
// the panel is drawn again from what they say, here and in any other tab (the storage event).
import { PROMISE, PANEL, CATEGORY_WORDS } from './permission-words.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (at) => { try { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; } };

let dialog = null, opener = null, confirming = false;

/** What a remembered value is, briefly: a person's name (and ORCID), or the hosts of pasted basemaps. Never an address or a key. */
function summary(v) {
  if (Array.isArray(v?.basemaps)) {
    return `${v.basemaps.length} basemap${v.basemaps.length === 1 ? '' : 's'}: ${v.basemaps.map((b) => `${b.host || '?'}${b.key ? ` (${PANEL.keyHeld})` : ''}`).join(', ')}`;
  }
  if (v && typeof v.name === 'string') return `${v.name}${v.orcid ? ` (${String(v.orcid).replace('https://orcid.org/', 'ORCID ')})` : ''}`;
  return '';
}

function entry(x) {
  const id = `perm-${x.key.replace(/[^a-z0-9]+/gi, '-')}`;
  const radio = (value, label) => `<label><input type="radio" name="${esc(`perm:${x.key}`)}" value="${value}"${x.state === value ? ' checked' : ''}> ${esc(label)}</label>`;
  const many = x.origins.length > 2;
  const notes = [many ? PANEL.sitesShort(x.key, x.origins) : PANEL.sitesOf(x.origins)];
  if (x.added) notes.push(PANEL.added(date(x.at)));
  if (x.scope === 'tab') notes.push(PANEL.forTab);
  if (x.reload) notes.push(PANEL.reloadNote);
  return `<fieldset class="perm" data-key="${esc(x.key)}" aria-describedby="${id}-d">
    <legend>${esc(x.name)}</legend>
    <p class="muted" id="${id}-d">${esc(notes.join(' '))}</p>
    ${many ? `<details class="perm-sites"><summary>${esc(PANEL.allSites(x.origins.length))}</summary><ul>${x.origins.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></details>` : ''}
    <div class="perm-choices">${radio('allowed', PANEL.allowed)} ${radio('undecided', PANEL.undecided)} ${radio('never', PANEL.never)}
    ${x.state === 'undecided' ? `<button type="button" data-tab="${esc(x.key)}">${esc(PANEL.allowTab)}</button>` : ''}</div>
  </fieldset>`;
}

// The reload, and, when it would lose something, the question first: what would be lost, and Cancel.
function reloadPart(api) {
  const losses = api.reloadLosses();
  if (confirming && losses.length) {
    return `<div class="perm-reload perm-confirm" role="group" aria-labelledby="perm-confirm-h">
      <p id="perm-confirm-h"><strong>${esc(PANEL.reloadLoses)}</strong></p>
      <ul>${losses.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <p><button type="button" class="primary" data-reload-confirmed>${esc(PANEL.reloadAnyway)}</button> <button type="button" data-reload-cancel>${esc(PANEL.reloadCancel)}</button></p></div>`;
  }
  return `<p class="perm-reload"><button type="button" class="primary" data-reload>${esc(PANEL.reload)}</button> ${esc(losses.length ? PANEL.reloadAsks : PANEL.reloadKept)}</p>`;
}

function render(api) {
  const all = api.list(), cats = [...new Set(all.map((x) => x.cat))];
  const canary = api.canaryState();
  const reload = all.some((x) => x.reload);
  const t = api.token.get() !== null, remembered = api.remembered(), persist = api.persistChoice();
  return `<form method="dialog" class="panel-close"><button type="submit">${esc(PANEL.close)}</button></form>
    <h2 id="permissions-h" tabindex="-1">${esc(PANEL.title)}</h2>
    <p class="promise">${esc(PROMISE)}</p>
    <p>${esc(PANEL.shared)}</p>
    ${canary && !canary.enforced ? `<p class="warn">${esc(PANEL.notProtected)}</p>` : ''}
    <section aria-labelledby="perm-sites-h">
      <h3 id="perm-sites-h">${esc(PANEL.sitesHeading)}</h3>
      <p class="muted">${esc(PANEL.sitesIntro)}</p>
      <p class="muted">${esc(PANEL.links)}</p>
      ${cats.map((c) => `<h4>${esc(CATEGORY_WORDS[c].heading)}</h4><p class="muted">${esc(CATEGORY_WORDS[c].learns)}</p>${all.filter((x) => x.cat === c).map(entry).join('')}`).join('')}
      ${reload || confirming ? reloadPart(api) : ''}
      <p><button type="button" data-forget-all>${esc(PANEL.forgetAll)}</button> <span class="muted" role="status" id="perm-forgot"></span></p>
    </section>
    <section aria-labelledby="perm-token-h">
      <h3 id="perm-token-h">${esc(PANEL.tokenHeading)}</h3>
      <p>${esc(t ? PANEL.tokenHeld(api.token.remembered()) : PANEL.tokenNone)}</p>
      <label><input type="checkbox" id="perm-token-remember"${api.token.remembered() ? ' checked' : ''} aria-describedby="perm-token-note"> ${esc(PANEL.tokenRemember)}</label>
      <p class="muted" id="perm-token-note">${esc(PANEL.tokenRememberNote)}</p>
      <p><button type="button" data-token-forget${t ? '' : ' disabled'}>${esc(PANEL.tokenForget)}</button></p>
      <p class="muted">${esc(PANEL.tokenRevoke)}</p>
    </section>
    <section aria-labelledby="perm-remembered-h">
      <h3 id="perm-remembered-h">${esc(PANEL.rememberedHeading)}</h3>
      ${remembered.length ? `<ul class="perm-remembered">${remembered.map((r) => `<li>${esc(r.label)}${summary(r.value) ? `: <span class="muted">${esc(summary(r.value))}</span>` : ''} <button type="button" data-forget="${esc(r.key)}">${esc(PANEL.forget)}</button></li>`).join('')}</ul>` : `<p class="muted">${esc(PANEL.rememberedNone)}</p>`}
    </section>
    <section aria-labelledby="perm-work-h">
      <h3 id="perm-work-h">${esc(PANEL.workHeading)}</h3>
      <label><input type="checkbox" id="perm-keep-work"${api.keepWorkingData() ? ' checked' : ''} aria-describedby="perm-keep-note"> ${esc(PANEL.keepWork)}</label>
      <p class="muted" id="perm-keep-note">${esc(PANEL.keepWorkNote)}</p>
      <label><input type="checkbox" id="perm-persist"${persist ? ' checked' : ''} aria-describedby="perm-persist-note"> ${esc(PANEL.persist)}</label>
      <p class="muted" id="perm-persist-note">${esc(PANEL.persistNote)}</p>
      <p role="status" id="perm-persist-result">${persist ? esc(persist.unsupported ? PANEL.persistResult.unsupported : persist.granted ? PANEL.persistResult.granted : PANEL.persistResult.refused) : ''}</p>
    </section>`;
}

function create(api) {
  dialog = document.createElement('dialog');
  dialog.id = 'permissions-panel';
  dialog.className = 'permissions-panel';
  dialog.setAttribute('aria-labelledby', 'permissions-h');
  dialog.addEventListener('change', (e) => {
    const r = e.target.closest('input[type=radio][name^="perm:"]');
    if (r) {
      const key = r.name.slice(5), i = key.indexOf(':'), cat = key.slice(0, i), subj = key.slice(i + 1);
      if (r.value === 'undecided') api.forget(cat, subj); else api.set(cat, subj, r.value);
      return;
    }
    if (e.target.id === 'perm-token-remember') api.token.remember(e.target.checked);
    if (e.target.id === 'perm-keep-work') api.setKeepWorkingData(e.target.checked);
    // Asked once, on this choice only; the answer shows when it comes (the panel is drawn again).
    if (e.target.id === 'perm-persist') api.choosePersist(e.target.checked);
  });
  dialog.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) { const key = b.dataset.tab, i = key.indexOf(':'); api.allowOnce(key.slice(0, i), key.slice(i + 1)); }
    else if (b.hasAttribute('data-reload')) { if (api.reloadLosses().length) { confirming = true; refreshPanel(api); dialog.querySelector('[data-reload-cancel]')?.focus(); } else api.reload({ confirmed: true }); }
    else if (b.hasAttribute('data-reload-confirmed')) api.reload({ confirmed: true });
    else if (b.hasAttribute('data-reload-cancel')) { confirming = false; refreshPanel(api); dialog.querySelector('[data-reload]')?.focus(); }
    else if (b.hasAttribute('data-forget-all')) { api.forgetAll(); const s = dialog.querySelector('#perm-forgot'); if (s) s.textContent = PANEL.forgotAll; }
    else if (b.hasAttribute('data-token-forget')) api.token.forget();
    else if (b.dataset.forget) api.forgetRemembered(b.dataset.forget);
  });
  // The focus goes back to what opened the panel, however it was closed (Esc, Close).
  dialog.addEventListener('close', () => { confirming = false; if (opener?.isConnected) opener.focus(); opener = null; });
  document.body.appendChild(dialog);
}

/** Draw the panel again, if it is open, keeping the focus where it was. */
export function refreshPanel(api) {
  if (!dialog?.open) return;
  const a = document.activeElement;
  const where = a && dialog.contains(a) ? { name: a.name, value: a.value, id: a.id, data: a.dataset ? { ...a.dataset } : {} } : null;
  dialog.innerHTML = render(api);
  if (!where) return;
  let back = null;
  if (where.name) back = [...dialog.querySelectorAll('input')].find((x) => x.name === where.name && x.value === where.value);
  else if (where.id) back = dialog.querySelector(`#${CSS.escape(where.id)}`);
  else if (where.data.forget) back = dialog.querySelector('#perm-remembered-h');
  back ??= dialog.querySelector('#permissions-h');
  back?.focus();
}

/** Open the panel at its heading, or at the permission `focus` ('cat:subj'): its chosen state has the focus. */
export function openPanel(api, { focus, confirmReload } = {}) {
  if (!dialog) create(api);
  confirming = !!confirmReload;
  if (dialog.open && confirmReload) refreshPanel(api);
  if (!dialog.open) {
    opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog.innerHTML = render(api);
    dialog.showModal();
  }
  const set = focus ? [...dialog.querySelectorAll('fieldset.perm')].find((f) => f.dataset.key === focus) : null;
  const target = set ? (set.querySelector('input:checked') || set.querySelector('input'))
    : confirmReload ? dialog.querySelector('[data-reload-cancel]') || dialog.querySelector('#permissions-h') : dialog.querySelector('#permissions-h');
  target?.focus();
  set?.scrollIntoView({ block: 'center' });
  return dialog;
}
