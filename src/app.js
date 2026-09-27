// The page: choose files, check or convert them, show progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
const $ = (id) => document.getElementById(id);
const state = (window.__plato = { phase: 'loading' });
let worker, files = [], input = null, targets = {}, busy = false;

function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes'; }
function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }
const FORMAT_NAMES = { tables: 'PLATO spreadsheet tables', 'plato-json': 'a PLATO JSON document', 'plato-jsonl': 'PLATO JSON Lines', ntriples: 'RDF (N-Triples)', nquads: 'RDF (N-Quads)', turtle: 'RDF (Turtle)', lpf: 'a Linked Places Format FeatureCollection', 'lpf-seq': 'a Linked Places Format sequence' };
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
    $('plato-version').innerHTML = `${v.versionInfo} at <a href="${v.repository}/tree/${v.commit}">${v.commit.slice(0, 7)}</a>`;
    Object.assign(state, { phase: 'ready', platoCommit: v.commit });
  } else if (data.type === 'detected') onDetected(data);
  else if (data.type === 'progress') onProgress(data);
  else if (data.type === 'done') onDone(data);
  else if (data.type === 'error') fail(data.message);
}

function choose(list) {
  files = [...list];
  if (!files.length) return;
  const c = $('chosen'); c.hidden = false;
  c.innerHTML = `<ul>${files.map((f) => `<li>${escapeHtml(f.name)} <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul><p>Looking at it…</p>`;
  $('action').hidden = true; $('result').hidden = true;
  Object.assign(state, { phase: 'detecting' });
  worker.postMessage({ cmd: 'detect', files });
}
function onDetected({ input: inp, targets: t }) {
  input = inp; targets = t;
  const p = $('chosen').querySelector('p');
  if (!inp.format) { p.innerHTML = `<span class="warn">${escapeHtml(inp.reason)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: inp.reason }); return; }
  const what = FORMAT_NAMES[inp.format] + (inp.profile ? ` (${inp.profile})` : '') + (inp.lpfVersion === 2 ? ', version 2' : '');
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

function start(action) {
  if (busy || !input?.format) return;
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  $('check').disabled = $('convert').disabled = true;
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null });
  worker.postMessage({ cmd: 'run', files, action, target, options: { base: $('base').value, typing: $('typing').checked } });
}
function onProgress(p) {
  const bits = [];
  if (p.triples) bits.push(`${p.triples.toLocaleString('en-GB')} triples`);
  if (p.places) bits.push(`${p.places.toLocaleString('en-GB')} places`);
  if (p.attestations) bits.push(`${p.attestations.toLocaleString('en-GB')} attestations`);
  const phase = { reading: 'Reading', loading: 'Loading into the working database', indexing: 'Indexing', writing: 'Writing', done: 'Finishing' }[p.phase] || p.phase;
  $('phase').textContent = `${phase}${bits.length ? ': ' + bits.join(', ') : ''} (${fmtTime(p.elapsedMs || 0)})`;
  Object.assign(state, { progress: p });
}
function onDone({ report, outputs }) {
  busy = false;
  $('check').disabled = $('convert').disabled = false;
  $('progress').hidden = true; $('result').hidden = false;
  const c = report.counts;
  const counted = ['places', 'attestations', 'identity relations', 'triples', 'triples written', 'table rows'].filter((k) => c[k]).map((k) => `${c[k].toLocaleString('en-GB')} ${k}`).join(', ');
  const nErr = report.errors;
  $('summary').innerHTML = (nErr ? `<span class="warn">${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} found.</span> ` : '<span class="good">No problems found.</span> ') + escapeHtml(counted ? `Read ${counted}.` : '');
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
  const checking = state.action === 'check';
  const groups = { error: 'Problems', warning: 'Warnings', loss: checking ? 'Would not be carried over' : 'Not carried over' };
  const intro = { error: 'These must be fixed for the data to be valid PLATO.', warning: 'Worth a look; the data can still be used.',
    loss: checking ? 'PLATO JSON has no place for these, so a conversion to it would leave them out.' : 'The target format has no place for these, so they are left out.' };
  const out = [];
  for (const [sev, title] of Object.entries(groups)) {
    const items = report.items.filter((i) => i.severity === sev);
    if (!items.length) continue;
    out.push(`<div class="report-group ${sev}"><h3>${title}</h3><p>${intro[sev]}</p>` + items.map((i) =>
      `<details class="item"><summary>${escapeHtml(i.message)}<span class="count">× ${i.count.toLocaleString('en-GB')}</span></summary>${i.examples.length ? `<ul>${i.examples.map((e) => `<li>${escapeHtml(String(e))}</li>`).join('')}</ul>` : ''}</details>`).join('') + '</div>');
  }
  $('report').innerHTML = out.join('');
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
  $('check').disabled = $('convert').disabled = false;
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
$('cancel').onclick = () => { worker.terminate(); busy = false; $('progress').hidden = true; $('check').disabled = $('convert').disabled = false; Object.assign(state, { phase: 'cancelled' }); startWorker(); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };
startWorker();
