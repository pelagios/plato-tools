// The page: choose files, check or convert them, or compare them with an earlier version; show
// progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, groups, draftNote, explainedLines } from './engine/words.js';
import { COLUMN_CHOICES, COLUMN_WORDS, columnWarnings, columnProblem } from './engine/words.js';
const $ = (id) => document.getElementById(id);
const state = (window.__plato = { phase: 'loading' });
let worker, files = [], input = null, targets = {}, busy = false;

// The commit of PLATO tools this page was built from (scripts/build-info.mjs writes it before the
// build), for the site's workflow to run the same; absent from a build made without it.
const BUILD = Object.values(import.meta.glob('./build-info.json', { eager: true, import: 'default' }))[0] || {};
const INPUT_TO_TARGET = { tables: 'tables', 'plato-json': 'plato-json', 'plato-jsonl': 'plato-jsonl', ntriples: 'ntriples', lpf: 'lpf', 'lpf-seq': 'lpf-seq' };

function startWorker() {
  worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
  worker.onerror = (e) => fail(`The engine stopped: ${e.message || 'unknown error'}`);
  worker.postMessage({ cmd: 'init', base: new URL('./', location.href).href });
}
function onMessage({ data }) {
  if (data.type === 'ready') {
    const v = data.version;
    $('plato-version').innerHTML = `${v.versionInfo} at <a href="${v.repository}/tree/${v.commit}">${v.commit.slice(0, 7)}</a>`
      // A pin to a branch other than main is a draft of PLATO, and says so wherever the pin is shown.
      + (v.draft ? ` <strong class="draft">${draftNote(v)}</strong>` : '');
    Object.assign(state, { phase: 'ready', platoCommit: v.commit, platoDraft: v.draft ? v.ref : null });
  } else if (data.type === 'detected') onDetected(data);
  else if (data.type === 'progress') onProgress(data);
  else if (data.type === 'done') onDone(data);
  else if (data.type === 'columns') onColumns(data);
  else if (data.type === 'error') fail(data.message);
}

function choose(list) {
  files = [...list];
  if (!files.length) return;
  // A previous release chosen for another dataset is not this one's: it is chosen again, or not.
  $('previous').value = '';
  const c = $('chosen'); c.hidden = false;
  c.innerHTML = `<ul>${files.map((f) => `<li><span class="name">${escapeHtml(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul><p>Looking at it…</p>`;
  $('action').hidden = true; $('result').hidden = true;
  Object.assign(state, { phase: 'detecting' });
  worker.postMessage({ cmd: 'detect', files });
}
function onDetected({ input: inp, targets: t }) {
  input = inp; targets = t;
  const p = $('chosen').querySelector('p');
  // Not recognised, or recognised and refused with a reason (a IIIF Georeference Annotation): input.js, readable().
  if (!inp.format || inp.reason !== undefined) { p.innerHTML = `<span class="warn">${escapeHtml(inp.reason)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: inp.reason }); return; }
  const what = formatName(inp);
  p.innerHTML = `This looks like <span class="detected">${what}</span>.`;
  const sel = $('target'); sel.innerHTML = '';
  for (const [k, v] of Object.entries(t)) {
    if (k === INPUT_TO_TARGET[inp.format]) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
  document.querySelector('[data-for="tables-input"]').hidden = inp.format !== 'tables';
  // Hermes: a table of places shows which column holds what before it is run, and the web address
  // its place ids are made under.
  document.querySelector('[data-for="generic-input"]').hidden = !isTable(inp);
  // Every detection makes any answer about the columns of an earlier file stale, a table or not.
  columns = null; state.columns = null; columnsAsked++;
  if (isTable(inp)) { document.querySelector('[data-for="tables-input"]').hidden = false; requestColumns(); }
  $('action').hidden = false;
  Object.assign(state, { phase: 'detected', format: inp.format, profile: inp.profile || null });
  storageCheck();
}
async function storageCheck() {
  const w = $('storage-warning');
  try {
    const { quota } = await navigator.storage.estimate();
    const size = files.reduce((n, f) => n + f.size, 0);
    const gz = /\.gz$/i.test(files[0]?.name || '');
    const need = size * (gz ? 40 : 4);   // room for the working database and the output, generously
    w.hidden = quota > need;
    if (!w.hidden) w.textContent = `This browser allows the page only ${fmtBytes(quota)} of storage, which may not be enough for this file. A private window keeps its storage in memory and allows very little; for large files, use an ordinary window.`;
  } catch { w.hidden = true; }
}

const buttons = (disabled) => { for (const id of ['check', 'convert', 'compare', 'publish']) $(id).disabled = disabled; };
function start(action, earlier) {
  if (busy || !input?.format || input.reason !== undefined) return;
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  buttons(true);
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null });
  const base = $('base').value.trim() || undefined;
  // The version check: the files chosen are the later version, and `earlier` the one it is compared with.
  if (action === 'compare') worker.postMessage({ cmd: 'compare', earlier, later: files, options: { base } });
  else if (action === 'publish') worker.postMessage({ cmd: 'publish', part: $('part').value, files, previous: [...$('previous').files], options: { base, ...publishOptions() } });
  else worker.postMessage({ cmd: 'run', files, action, target, options: { base, typing: $('typing').checked, cube: target === 'ntriples' && $('cube').checked,
    // Hermes: the matching of columns shown, as chosen (the same JSON as the command line's --columns).
    ...(isTable(input) && columns ? { columns: { ...columns.mapping } } : {}) } });
}
// Agora's options, from the Options panel: only those given are sent.
function publishOptions() {
  const v = (id) => $(id).value.trim() || undefined;
  const maintainers = (v('maintainers') || '').split(/[\s,]+/).map((m) => m.replace(/^@/, '')).filter(Boolean);
  return { release: v('release'), conceptDoi: v('concept-doi'), repo: v('repo'), siteUrl: v('site-url'), maintainers, turtle: $('turtle').checked, name: tablesFolder(), toolsCommit: BUILD.commit || undefined };
}
// Spreadsheet tables chosen as a folder (or dropped as one) know its name, as the command line
// does: the site's zip and the workflow's path are named after it. Chosen file by file they do
// not, and the site names them after the dataset's short name instead, and says so.
function tablesFolder() {
  if (input?.format !== 'tables' || input.container !== 'csv') return undefined;
  const dirs = new Set(files.map((f) => (f.webkitRelativePath || '').split('/').slice(0, -1).join('/')));
  const [dir] = dirs;
  return dirs.size === 1 && dir ? dir.split('/').pop() : undefined;
}
function onProgress(p) {
  $('phase').textContent = progressText(p);
  Object.assign(state, { progress: p });
}
function onDone({ report, outputs }) {
  busy = false;
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  const { problems, counted } = summary(report, state.action);
  $('summary').innerHTML = `<span class="${report.errors ? 'warn' : 'good'}">${problems}</span> ` + escapeHtml(counted);
  const saves = $('saves'); saves.innerHTML = '';
  for (const o of outputs || []) {
    const b = document.createElement('button'); b.className = 'primary';
    b.textContent = `Save ${o.name} (${fmtBytes(o.size)})`;
    b.onclick = () => save(o.name);
    saves.appendChild(b);
  }
  renderReport(report);
  Object.assign(state, { phase: 'done', report, outputs });
}
function renderReport(report) {
  const out = [];
  for (const { severity: sev, title, intro } of groups(state.action)) {
    const items = report.items.filter((i) => i.severity === sev);
    if (!items.length) continue;
    out.push(`<div class="report-group ${sev}"><h3>${title}</h3><p>${intro}</p>` + items.map((i) =>
      `<details class="item"><summary>${escapeHtml(i.message)}<span class="count">× ${i.count.toLocaleString('en-GB')}</span></summary>${i.examples.length ? `<ul>${i.examples.map((e) => `<li>${escapeHtml(String(e))}${explained(i, e)}</li>`).join('')}</ul>` : ''}</details>`).join('') + '</div>');
  }
  $('report').innerHTML = out.join('');
}
// What changed in an example of a version check: the statements only one version makes.
function explained(item, example) {
  const lines = (item.explained || []).filter((x) => x.example === example).flatMap(explainedLines);
  return lines.length ? `<ul class="changes">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '';
}
async function save(name) {
  const root = await navigator.storage.getDirectory();
  const file = await (await (await root.getDirectoryHandle('outputs')).getFileHandle(name)).getFile();
  if (window.showSaveFilePicker && !window.__plato_forceDownload) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      await file.stream().pipeTo(await h.createWritable());   // disk to disk, nothing held in memory
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
window.__plato_save = save;
function fail(message) {
  busy = false;
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  $('summary').innerHTML = `<span class="warn">Something went wrong: ${escapeHtml(message)}</span>`;
  $('saves').innerHTML = ''; $('report').innerHTML = '';
  Object.assign(state, { phase: 'error', error: message });
}
// ---- Hermes: which column of a table of places holds what -------------------------------------------
// The worker reads the columns and guesses (src/engine/hermes/columns.js); the page shows the guess,
// one choice for each column, with three examples and the reason for the guess, and the run is given
// the matching as it stands. The matching can be saved as JSON and loaded again.
let columns = null, columnsAsked = 0, columnsFrom;
const isTable = (inp) => inp?.format === 'csv' || inp?.format === 'geojson';
function requestColumns(saved, from) {
  const id = ++columnsAsked;
  if (saved === undefined) $('columns').innerHTML = `<h3 id="columns-h">${COLUMN_WORDS.heading}</h3><p>${COLUMN_WORDS.looking}</p>`;
  columnsFrom = from;
  worker.postMessage({ cmd: 'columns', id, files, saved });
}
function onColumns(d) {
  if (d.id !== columnsAsked) return;                    // an answer about a file no longer chosen
  const W = COLUMN_WORDS;
  if (d.error) {
    $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3><p class="warn">${escapeHtml(W.cannotRead(d.error))}</p>`;
    state.columns = { error: d.error };
    return;
  }
  // With no prototype, so that a column called "__proto__" is a column like any other (columns.js).
  const own = (o) => Object.assign(Object.create(null), o);
  columns = { headers: d.headers, examples: own(d.examples), fields: d.fields, mapping: own(d.mapping), reasons: own(d.reasons), gazetteer: d.gazetteer || [] };
  // A column the saved matching gives, and the engine took as given, says so in the page's words;
  // one it could not take keeps the engine's reason.
  if (d.saved) for (const h of d.headers) if (d.reasons[h] && d.problems.every((p) => p.example !== h && !String(p.example).startsWith(`${h}: `))) columns.reasons[h] = W.saved;
  columns.messages = d.saved ? [W.loaded(columnsFrom || ''), ...d.problems.map(columnProblem)] : [];
  renderColumns();
}
function choiceOptions(chosen) {
  const keys = [...Object.keys(COLUMN_CHOICES).filter((k) => columns.fields[k] || k === 'note' || k === 'skip'),
    ...Object.keys(columns.fields).filter((k) => !COLUMN_CHOICES[k])];     // a field these words do not yet name
  return keys.map((k) => `<option value="${k}"${k === chosen ? ' selected' : ''}>${escapeHtml(COLUMN_CHOICES[k] || k)}</option>`).join('');
}
function renderColumns() {
  const W = COLUMN_WORDS, c = columns, geojson = input.format === 'geojson';
  const rows = c.headers.map((h, i) => {
    const ex = c.examples[h] || [];
    return `<tr><th scope="row"><code>${escapeHtml(h)}</code></th>`
      + `<td>${ex.length ? `<ul class="examples">${ex.map((v) => `<li>${escapeHtml(v.length > 60 ? v.slice(0, 59) + '…' : v)}</li>`).join('')}</ul>` : `<em>${W.noExamples}</em>`}</td>`
      + `<td><label for="column-${i}" class="visually-hidden">${escapeHtml(W.selectLabel(h))}</label><select id="column-${i}" data-column="${i}" aria-describedby="column-why-${i}">${choiceOptions(c.mapping[h])}</select></td>`
      + `<td id="column-why-${i}" class="why-guess">${escapeHtml(c.reasons[h] || '')}</td></tr>`;
  }).join('');
  $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3><p>${escapeHtml(W.intro(geojson))} ${escapeHtml(W.base)}</p>`
    + `<div class="columns-scroll"><table class="columns-table"><caption>${escapeHtml(W.caption(files[0]?.name || '', geojson))}</caption>`
    + `<thead><tr><th scope="col">${W.column}</th><th scope="col">${W.examples}</th><th scope="col">${W.readAs}</th><th scope="col">${W.why}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div id="columns-messages" aria-live="polite">${c.messages.map((m) => `<p>${escapeHtml(m)}</p>`).join('')}</div>`
    + `<div id="columns-warnings" aria-live="polite"></div>`
    + `<div class="actions columns-files"><button type="button" id="columns-save">${W.save}</button><button type="button" id="columns-load">${W.load}</button>`
    + `<input type="file" id="columns-file" accept=".json,application/json" hidden aria-label="${W.loadLabel}"><small>${escapeHtml(W.saveNote)}</small></div>`;
  $('columns-save').onclick = saveMatching;
  $('columns-load').onclick = () => $('columns-file').click();
  $('columns-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadMatching(f); };
  renderColumnWarnings();
}
function renderColumnWarnings() {
  const warnings = columnWarnings(columns.mapping, columns.gazetteer);
  $('columns-warnings').innerHTML = warnings.map((w) => `<p class="warn">${escapeHtml(w)}</p>`).join('');
  state.columns = { headers: [...columns.headers], mapping: Object.assign(Object.create(null), columns.mapping), reasons: Object.assign(Object.create(null), columns.reasons), examples: columns.examples, warnings, messages: [...columns.messages] };
}
// A choice for one column. A field one column only can be (the name, the id…) is taken from the
// column that had it, which is then kept as a note, and says why.
function chooseColumn(i, field) {
  const W = COLUMN_WORDS, h = columns.headers[i];
  if (columns.fields[field]?.single) {
    columns.headers.forEach((other, j) => {
      if (j === i || columns.mapping[other] !== field) return;
      columns.mapping[other] = 'note'; columns.reasons[other] = W.movedTo(COLUMN_CHOICES[field] || field, h);
      $(`column-${j}`).value = 'note'; $(`column-why-${j}`).textContent = columns.reasons[other];
    });
  }
  columns.mapping[h] = field; columns.reasons[h] = W.youChose;
  $(`column-why-${i}`).textContent = W.youChose;
  renderColumnWarnings();
}
function saveMatching() {
  const a = document.createElement('a');
  // In the file's order, which an object would not keep for a column whose heading is a number.
  const text = `{\n${columns.headers.map((h) => `  ${JSON.stringify(h)}: ${JSON.stringify(columns.mapping[h])}`).join(',\n')}\n}\n`;
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = (files[0]?.name || 'table').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '') + '-columns.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function loadMatching(file) {
  let saved;
  try { saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); } catch { saved = undefined; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    $('columns-messages').innerHTML = `<p class="warn">${escapeHtml(COLUMN_WORDS.notJson(file.name))}</p>`;
    state.columns = { ...state.columns, messages: [COLUMN_WORDS.notJson(file.name)] };
    return;
  }
  requestColumns(saved, file.name);
}
$('columns').addEventListener('change', (e) => { if (e.target.matches('select[data-column]')) chooseColumn(Number(e.target.dataset.column), e.target.value); });

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// Cleared once read, so that choosing the same file again (after editing it) is a change too.
$('picker').onchange = (e) => { choose(e.target.files); e.target.value = ''; };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files); };
$('check').onclick = () => start('check');
$('convert').onclick = () => start('convert');
// Comparing asks for one more file, the earlier version, and starts once it is chosen.
$('compare').onclick = () => $('earlier').click();
$('earlier').onchange = (e) => { const earlier = [...e.target.files]; e.target.value = ''; if (earlier.length) start('compare', earlier); };
$('publish').onclick = () => start('publish');
$('cancel').onclick = () => { worker.terminate(); busy = false; $('progress').hidden = true; buttons(false); Object.assign(state, { phase: 'cancelled' }); startWorker(); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };
startWorker();
