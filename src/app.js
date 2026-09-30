// The page: choose files, check or convert them, or compare them with an earlier version; show
// progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, groups, draftNote, explainedLines } from './engine/words.js';
const $ = (id) => document.getElementById(id);
const state = (window.__plato = { phase: 'loading' });
let worker, files = [], input = null, targets = {}, busy = false;

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
  else if (data.type === 'error') fail(data.message);
}

function choose(list) {
  files = [...list];
  if (!files.length) return;
  const c = $('chosen'); c.hidden = false;
  c.innerHTML = `<ul>${files.map((f) => `<li><span class="name">${escapeHtml(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul><p>Looking at it…</p>`;
  $('action').hidden = true; $('result').hidden = true;
  Object.assign(state, { phase: 'detecting' });
  worker.postMessage({ cmd: 'detect', files });
}
function onDetected({ input: inp, targets: t }) {
  input = inp; targets = t;
  const p = $('chosen').querySelector('p');
  if (!inp.format) { p.innerHTML = `<span class="warn">${escapeHtml(inp.reason)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: inp.reason }); return; }
  const what = formatName(inp);
  p.innerHTML = `This looks like <span class="detected">${what}</span>.`;
  const sel = $('target'); sel.innerHTML = '';
  for (const [k, v] of Object.entries(t)) {
    if (k === INPUT_TO_TARGET[inp.format]) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
  document.querySelector('[data-for="tables-input"]').hidden = inp.format !== 'tables';
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

const buttons = (disabled) => { for (const id of ['check', 'convert', 'compare']) $(id).disabled = disabled; };
function start(action, earlier) {
  if (busy || !input?.format) return;
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  buttons(true);
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null });
  const base = $('base').value.trim() || undefined;
  // The version check: the files chosen are the later version, and `earlier` the one it is compared with.
  if (action === 'compare') worker.postMessage({ cmd: 'compare', earlier, later: files, options: { base } });
  else worker.postMessage({ cmd: 'run', files, action, target, options: { base, typing: $('typing').checked, cube: target === 'ntriples' && $('cube').checked } });
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
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

$('picker').onchange = (e) => choose(e.target.files);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files); };
$('check').onclick = () => start('check');
$('convert').onclick = () => start('convert');
// Comparing asks for one more file, the earlier version, and starts once it is chosen.
$('compare').onclick = () => $('earlier').click();
$('earlier').onchange = (e) => { const earlier = [...e.target.files]; e.target.value = ''; if (earlier.length) start('compare', earlier); };
$('cancel').onclick = () => { worker.terminate(); busy = false; $('progress').hidden = true; buttons(false); Object.assign(state, { phase: 'cancelled' }); startWorker(); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };
startWorker();
