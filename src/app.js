// The page: choose files, check or convert them, or compare them with an earlier version; show
// progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, groups, draftNote, explainedLines } from './engine/words.js';
import { COLUMN_CHOICES, COLUMN_WORDS, columnWarnings, columnProblem, READING_WORDS, PASTE_WORDS } from './engine/words.js';
import { mappingToSave, levelChoices } from './engine/hermes/columns.js';
import { pastedListFile } from './engine/hermes/pasted.js';
// Hermes: grouping similar spellings for lookup, a panel of its own (src/hermes-spellings.js).
import { spellingsPanel } from './hermes-spellings.js';
import { splitMatching } from './engine/hermes/cluster.js';
import { review as W, POOL_BUSY, POOL_STUCK, PREVIEW_WORDS } from './engine/words.js';
const REVIEW_WORDS = W;   // the review's words, where W names the words for the columns
import { readable } from './engine/input.js';
import { readWork, serialiseWork, decide, reviewPlaces, candidatesOf, isReviewed, reviewProgress, filesDiffer, checkReviewer, checkMatchOptions, flag, noteOn, setRowState } from './engine/krisis/work.js';
import { exportCandidates, readCandidateSet, serialiseCandidateSet } from './engine/krisis/candidates.js';
import { datasetAddress, baseDiffers } from './engine/methodos/containment.js';
import { acceptGuarded, undoBatch, guardOf, guardsFirst, planGuarded } from './engine/krisis/guards.js';
import { KRISIS_CANDIDATES, guardWords as GW, variantWords as VW, rowWords as RW } from './engine/words.js';
import { stash as stashForChora, dropStale as dropStaleHandoff } from './chora/handoff.js';
import { dropStale as dropStaleHandback, workflowOf } from './chora/handback.js';
import { storageNeed } from './engine/storage.js';
import * as permissions from './lib/permissions.js';
import { keepNotes, restoreNotes } from './lib/typed-notes.js';
import { RELOAD_LOSES } from './lib/permission-words.js';
// Krisis: gazetteer lookup, run on this thread (never the worker), through the permissions module, with
// the token from its one keeper (permissions.token).
import { LOOKUP_WORDS, lookupPage as LW } from './engine/words.js';
import { createLookup, WHG_ENDPOINT, isWhg } from './engine/gazetteer/index.js';
import { runLookup, planLookup, gazetteerPermission, permittedFetch, serviceOf, iriFromTemplate, iriVia, manifestSettings, newWork, defaultChoice, licenceOf, PLACE_CHOICES, WHG_REQUESTS_A_DAY } from './engine/krisis/lookup.js';
import { candidateSource } from './engine/krisis/identity.js';
// Krisis: region review (Methodos #28, stages 3 and 4), run on this thread as the lookup is, through the same shared WHG lookup.
import { runLevel, runPlaces } from './engine/krisis/lookup.js';
import { seedRegions, decideRegion, settleRegion, undo as undoRegion, selectLevel, matchesOf, lastQueryOf } from './engine/krisis/regions.js';
import { REGION_PAGE as RP, REGION_WORDS } from './engine/words.js';
import { levelNames, levelLabel, navigator as levelNavigator, firstOpen, chainOf, placeChain, constraintLine, notesOf, relaxOptions, costOf, levelRegions, unsettledOf, placesToLook, lockedPlaces, wouldClear, priorOf, restorePrior, nameOf, regionDomId, certaintyChoices, CERTAINTY_DEFAULT, regionMatchOptions } from './krisis/region-page.js';
import { mountMethodos } from './methodos/page.js';
import { workflowStore } from './methodos/store.js';
const $ = (id) => document.getElementById(id);
const state = (window.__plato = { phase: 'loading' });
let worker, files = [], input = null, targets = {}, busy = false;
let runOp = null;   // the Methodos operation of the run under way (src/methodos/page.js), told when it ends
// The engine is ready (its first 'ready' message): a file Methodos chooses on load waits for it, or the
// page's 'ready' would come after, and over, the file's detection. An engine that fails settles it too,
// with false, so that nothing waits on it for ever.
let engineReady; const whenReady = new Promise((r) => { engineReady = r; });

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
    readingCaps = { editorial: !!data.reading?.editorial };
    Object.assign(state, { phase: 'ready', platoCommit: v.commit, platoDraft: v.draft ? v.ref : null });
    engineReady(true);
  } else if (data.type === 'detected') onDetected(data);
  else if (data.type === 'progress') onProgress(data);
  else if (data.type === 'done') onDone(data);
  else if (data.type === 'columns') onColumns(data);
  else if (data.type === 'tei-keys') onTeiKeys(data);
  else if (data.type === 'places') onPlaces(data);   // Krisis: gazetteer lookup
  else if (data.type === 'error' && placesWaiting) onPlaces({ subjects: null, places: null, reason: data.message });
  else if (data.type === 'preview') onPreview(data);
  else if (data.type === 'cluster') spellings.answer(data);   // Hermes: groups of similar spellings
  // Another tab of the main page is running: said in words, and the run may be tried again.
  else if (data.type === 'error' && data.kind === 'pool-busy') fail(data.message, POOL_BUSY);
  // This tab could not let go of the working files: no other tab is to blame, and a reload frees them.
  else if (data.type === 'error' && data.kind === 'pool-stuck') fail(data.message, POOL_STUCK);
  else if (data.type === 'error') fail(data.message);
}

function choose(list) {
  files = [...list];
  if (!files.length) return;
  methodos.chosen(files);   // a workflow followed begins with them, or checks they are its step's
  // A previous release chosen for another dataset is not this one's: it is chosen again, or not.
  $('previous').value = '';
  $('only').value = '';   // and so is a list of its places to publish
  const c = $('chosen'); c.hidden = false;
  c.innerHTML = `<ul>${files.map((f) => `<li><span class="name">${escapeHtml(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul><p>Looking at it…</p>`;
  $('action').hidden = true; $('result').hidden = true; $('review').hidden = true;
  clearPreview();
  Object.assign(state, { phase: 'detecting' });
  worker.postMessage({ cmd: 'detect', files });
}
function onDetected({ input: inp, targets: t }) {
  input = inp; targets = t;
  const p = $('chosen').querySelector('p');
  // Not recognised, or recognised and refused with a reason (a IIIF Georeference Annotation): input.js, readable().
  if (!inp.format || inp.reason !== undefined) { p.innerHTML = `<span class="warn">${escapeHtml(inp.reason)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: inp.reason }); return; }
  const what = formatName(inp);
  // Escaped: a workbook's sheet, named in it, is the file's own text.
  p.innerHTML = `This looks like <span class="detected">${escapeHtml(what)}</span>.`;
  const sel = $('target'); sel.innerHTML = '';
  for (const [k, v] of Object.entries(t)) {
    if (k === INPUT_TO_TARGET[inp.format]) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
  if (tool) chooseTool(tool);   // a tool chosen first: narrowed again for this file (Arithmos: N-Triples, now that it is offered)
  methodos.detected();   // Methodos: a step writing the file in its own format offers it to download
  document.querySelector('[data-for="tables-input"]').hidden = inp.format !== 'tables';
  // Hermes: a table of places shows which column holds what before it is run, and the web address
  // its place ids are made under.
  document.querySelector('[data-for="generic-input"]').hidden = !isTable(inp);
  // Every detection makes any answer about the columns of an earlier file stale, a table or not.
  columns = null; state.columns = null; columnsAsked++;
  if (isTable(inp)) { document.querySelector('[data-for="tables-input"]').hidden = false; requestColumns(); }
  // The reading options this format has, if any, all off; a TEI file's keys are looked for.
  renderReading();
  spellings.reset(isTable(inp));   // and nothing grouped
  if (inp.format === 'tei') requestTeiKeys();
  clearPreview();
  gateOnColumns();
  $('action').hidden = false;
  Object.assign(state, { phase: 'detected', format: inp.format, profile: inp.profile || null });
  storageCheck();
  if ($('lookup').open) refreshPreview();   // Krisis: gazetteer lookup
}
async function storageCheck() {
  const w = $('storage-warning');
  try {
    const { quota } = await navigator.storage.estimate();
    const need = storageNeed(input, files);   // room for the working database and the output, generously
    w.hidden = quota > need;
    if (!w.hidden) w.textContent = `This browser allows the page only ${fmtBytes(quota)} of storage, which may not be enough for this file. A private window keeps its storage in memory and allows very little; for large files, use an ordinary window.`;
  } catch { w.hidden = true; }
}

const buttons = (disabled) => { for (const id of ['check', 'check-candidates', 'convert', 'compare', 'publish', 'match', 'resume', 'finish', 'preview']) $(id).disabled = disabled; if (!disabled) gateOnColumns(); };
// Krisis: a table of places is matched, and its review finished, by the matching of its columns: until
// the worker's answer about them arrives, Match and Finish wait, or the table would be read by the guess.
const columnsPending = () => isTable(input) && !columns && !state.columns?.error;
function gateOnColumns() { if (busy) return; const wait = columnsPending(); $('match').disabled = wait; $('finish').disabled = wait; state.columnsPending = wait; gatePreview(); }
function start(action, earlier) {
  if (busy || looking || !input?.format || input.reason !== undefined) return;   // Krisis: nor while a lookup runs
  if (hermesChosen) chooseTool(null);   // a file's action chosen: Hermes has done its part, and its card is no longer marked
  // A reading option that cannot be used is said plainly, and nothing is run.
  const readingRefused = action === 'check' || action === 'convert' ? readingProblem() : null;
  if (readingRefused) { readingMessage(readingRefused); return refuse(readingRefused); }
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  buttons(true);
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null, said: null });
  const base = $('base').value.trim() || undefined;
  // Krisis: a review on the page is put away (and its keys with it) while anything but its own finishing runs.
  if (action !== 'apply') { $('review').hidden = true; lockColumns(); }
  // Methodos: the run is told, as the operation a workflow's step names, with the files it runs on.
  runOp = action === 'publish' ? `publish.${$('part').value}` : action;
  methodos.began({ op: runOp, files });
  // The version check: the files chosen are the later version, and `earlier` the one it is compared with.
  if (action === 'compare') worker.postMessage({ cmd: 'compare', earlier, later: files, options: { base } });
  else if (action === 'publish') onlyKeys().then(
    (only) => worker.postMessage({ cmd: 'publish', part: $('part').value, files, previous: [...$('previous').files], options: { base, ...publishOptions(), only } }),
    (e) => fail(`the list of places to include could not be read (${e.message || e}).`));
  // Match review (Krisis): the files chosen are the subjects, and `earlier` the other dataset; to finish, the review is applied to them.
  // A table of places is matched by the matching of its columns shown, as chosen (Hermes), which the work file keeps for finishing.
  else if (action === 'match') worker.postMessage({ cmd: 'match', subjects: files, others: earlier, options: { ...matchOptions(), base, ...sheetOption(), ...(isTable(input) && columns ? { columns: columnOptions() } : {}) } });
  // The title in the options is cited only when the review has none but a file's name: one left there from an earlier match must not replace the review's own.
  // The candidate set exported on the page, and the earlier sets given, are what the answers point into (promotedFrom).
  else if (action === 'apply') worker.postMessage({ cmd: 'apply', subjects: files, work, options: { output: earlier, reviewer: reviewer(), othersTitle: work.others?.titleFrom === 'file-name' ? matchOptions().othersTitle : undefined, base, ...sheetOption(),
    candidates: [exportedSet, ...earlierSets].filter(Boolean),
    // A table is finished by the review's own matching of its columns, unless another has been loaded since: that is sent, and said to differ.
    ...(isTable(input) && columns && reviewMapping !== undefined && mappingText(columnOptions()) !== reviewMapping ? { columns: columnOptions() } : {}) } });
  // Elenchos: a check given candidate sets (`earlier`), one file for each, to check the files chosen with.
  else worker.postMessage({ cmd: 'run', files, action, target, candidates: action === 'check' && earlier?.length ? earlier : undefined, options: { base, typing: $('typing').checked, cube: target === 'ntriples' && $('cube').checked,
    // Hermes: the matching of columns shown, as chosen (the same JSON as the command line's --columns,
    // a pattern column in its object form), and the reading options chosen.
    ...(isTable(input) && columns ? { columns: columnOptions() } : {}), ...sheetOption(), ...readingOptions(), ...(isTable(input) ? spellings.options() : {}) } });
}
// Agora's options, from the Options panel: only those given are sent.
function publishOptions() {
  const v = (id) => $(id).value.trim() || undefined;
  const maintainers = (v('maintainers') || '').split(/[\s,]+/).map((m) => m.replace(/^@/, '')).filter(Boolean);
  return { release: v('release'), conceptDoi: v('concept-doi'), repo: v('repo'), siteUrl: v('site-url'), maintainers, turtle: $('turtle').checked, name: tablesFolder(), toolsCommit: BUILD.commit || undefined };
}
// The subset of places for the site (Options, "Only these places"): a text file of place keys, one
// to a line, read as the command line reads --only (each line trimmed, blank ones skipped), so the
// engine is given the same array from either. No file chosen is no subset: undefined, not [].
async function onlyKeys() {
  const f = $('only').files[0];
  if (!f) return undefined;
  return (await f.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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
function onDone({ report, outputs, work: found, incomplete }) {
  busy = false;
  if (runOp) { methodos.ended({ op: runOp, report, outputs: outputs || [], incomplete: !!incomplete }); runOp = null; }
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
  if (state.action === 'match' && found) beginReview(found, outputs?.find((o) => /\.krisis\.json$/.test(o.name))?.name);
}
function renderReport(report) { $('report').innerHTML = reportHtml(report, state.action); }
/** A report's findings, group by group, as the page shows them. */
function reportHtml(report, action) {
  const out = [];
  for (const { severity: sev, title, intro } of groups(action)) {
    const items = report.items.filter((i) => i.severity === sev);
    if (!items.length) continue;
    out.push(`<div class="report-group ${sev}"><h3>${title}</h3><p>${intro}</p>` + items.map((i) =>
      `<details class="item"><summary>${escapeHtml(i.message)}<span class="count">× ${i.count.toLocaleString('en-GB')}</span></summary>${i.examples.length ? `<ul>${i.examples.map((e) => `<li>${escapeHtml(String(e))}${explained(i, e)}</li>`).join('')}</ul>` : ''}</details>`).join('') + '</div>');
  }
  return out.join('');
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
function fail(message, words) {
  busy = false;
  engineReady(false);
  if (runOp) { methodos.ended({ op: runOp, error: words || message }); runOp = null; }
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  $('summary').innerHTML = `<span class="warn">${escapeHtml(words || `Something went wrong: ${message}`)}</span>`;
  $('saves').innerHTML = ''; $('report').innerHTML = '';
  Object.assign(state, { phase: 'error', error: message, said: words || null });
}
// ---- Hermes: which column of a table of places holds what -------------------------------------------
// The worker reads the columns and guesses (src/engine/hermes/columns.js); the page shows the guess,
// one choice for each column, with three examples and the reason for the guess, and the run is given
// the matching as it stands. The matching can be saved as JSON and loaded again.
let columns = null, columnsAsked = 0, columnsFrom, columnsSaved;
// Krisis: the request for the columns of a resumed review, and the matching the review was made with, as text (undefined: not known yet).
let reviewColumnsAsked = 0, reviewMapping;
// A matching as text, in the file's order, to compare two by.
const mappingText = (m) => JSON.stringify(columns.headers.map((h) => [h, m[h]]));
// The column options a run is given (Hermes's run, Krisis's match and finish): the matching shown, a pattern column in its object form.
const columnOptions = () => mappingToSave(columns.mapping, columns.patterns, columns.levels, columns.splits);
const isTable = (inp) => inp?.format === 'csv' || inp?.format === 'geojson';
// A workbook read as a table of places: the sheet read (the first not hidden, until another is
// chosen), sent with every command that reads the table.
const isSheet = (inp) => inp?.format === 'csv' && inp.container === 'workbook';
const sheetOption = () => (isSheet(input) && input.sheet !== undefined ? { sheet: input.sheet } : {});
// The choice of sheet, above the columns table, when the workbook has more than one.
function sheetControl() {
  if (!isSheet(input) || !(input.sheets?.length > 1)) return '';
  const W = COLUMN_WORDS;
  const options = input.sheets.map((s) => `<option value="${escapeHtml(s.name)}"${s.name === input.sheet ? ' selected' : ''}>${escapeHtml(s.hidden ? W.sheetHidden(s.name) : s.name)}</option>`).join('');
  return `<p class="sheet-choice"><label for="columns-sheet">${escapeHtml(W.sheetLabel)}</label> <select id="columns-sheet" data-tip="${escapeHtml(W.sheetTip)}">${options}</select></p>`;
}
function requestColumns(saved, from) {
  const id = ++columnsAsked;
  if (saved === undefined) $('columns').innerHTML = `<h3 id="columns-h">${COLUMN_WORDS.heading}</h3>${sheetControl()}<p>${COLUMN_WORDS.looking}</p>`;
  columnsFrom = from; columnsSaved = saved;
  state.sheet = sheetOption().sheet ?? null;
  clearPreview();   // the matching is being read again (another sheet, a matching loaded)
  worker.postMessage({ cmd: 'columns', id, files, saved, ...sheetOption() });
}
function onColumns(d) {
  if (d.id !== columnsAsked) return;                    // an answer about a file no longer chosen
  const W = COLUMN_WORDS;
  if (d.error) {
    $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3>${sheetControl()}<p class="warn">${escapeHtml(W.cannotRead(d.error))}</p>`;
    state.columns = { error: d.error };
    gateOnColumns();
    return;
  }
  // With no prototype, so that a column called "__proto__" is a column like any other (columns.js).
  const own = (o) => Object.assign(Object.create(null), o);
  columns = { headers: d.headers, examples: own(d.examples), fields: d.fields, mapping: own(d.mapping), reasons: own(d.reasons), gazetteer: d.gazetteer || [],
    // A column of a gazetteer's ids: the pattern suggested for it, and the patterns confirmed (or saved).
    patterns: own(d.patterns || {}), suggested: own(d.suggested || {}), first: own(d.mapping),
    // A region's level ("within"), and a column split into levels, as the engine read them (columns.js).
    levels: own(d.levels || {}), splits: own(Object.fromEntries(Object.entries(d.splits || {}).map(([h, x]) => [h, { ...x, levels: [...x.levels] }]))) };
  // A column the saved matching gives, and the engine took as given, says so in the page's words;
  // one it could not take keeps the engine's reason.
  if (d.saved) for (const h of d.headers) if (d.reasons[h] && d.problems.every((p) => p.example !== h && !String(p.example).startsWith(`${h}: `))) columns.reasons[h] = W.saved;
  columns.messages = d.saved ? [W.loaded(columnsFrom || ''), ...d.problems.map(columnProblem)] : [];
  renderColumns();
  spellings.columns(columns.headers, columns.headers.find((h) => columns.mapping[h] === 'name'));
  // Krisis: the matching a resumed review was made with, as read for the file chosen, is the one its Finish compares with.
  if (d.id === reviewColumnsAsked) { reviewMapping = mappingText(columnOptions()); state.reviewColumns = Object.assign(Object.create(null), columns.mapping); }
  gateOnColumns();
}
// Another sheet of the workbook: its columns are asked for again, and guessed afresh.
function chooseSheet(name) {
  if (!isSheet(input) || !input.sheets.some((s) => s.name === name)) return;
  input.sheet = name;
  $('chosen').querySelector('p').innerHTML = `This looks like <span class="detected">${escapeHtml(formatName(input))}</span>.`;
  columns = null; state.columns = null;
  spellings.reset(true);   // groups found in another sheet are not this one's
  requestColumns();
  gateOnColumns();
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
      + `<td><label for="column-${i}" class="visually-hidden">${escapeHtml(W.selectLabel(h))}</label><select id="column-${i}" data-column="${i}" aria-describedby="column-why-${i}">${choiceOptions(c.mapping[h])}</select>${patternControl(h, i)}<span id="column-extra-${i}" class="column-extra">${extraControls(h, i)}</span></td>`
      + `<td id="column-why-${i}" class="why-guess">${escapeHtml(c.reasons[h] || '')}</td></tr>`;
  }).join('');
  $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3>${sheetControl()}<p>${escapeHtml(W.intro(geojson))} ${escapeHtml(W.base)}</p>`
    + `<p id="columns-locked" class="columns-locked" hidden>${escapeHtml(REVIEW_WORDS.columnsLocked)}</p>`
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
  lockColumns();
}
// Krisis: while a review is shown, the columns are read as the review was made, and cannot be chosen
// one by one; a saved matching can still be loaded, and Finish then sends it, and says it differs.
function lockColumns() {
  const reviewing = !!work && !$('review').hidden;
  const selects = document.querySelectorAll('#columns select[data-column]');
  for (const sel of selects) sel.disabled = reviewing;
  // A region's level and a split's controls too.
  for (const el of document.querySelectorAll('#columns [data-level-column], #columns [data-split-column]')) el.disabled = reviewing;
  // The sheet too: a review was made of one sheet.
  if ($('columns-sheet')) $('columns-sheet').disabled = reviewing;
  // and says why, exactly when they are locked.
  const note = $('columns-locked'); if (note) note.hidden = !(reviewing && selects.length);
  state.columnsLocked = reviewing;
}
// A column of a gazetteer's ids, with a pattern suggested (or confirmed): a box to tick to make its
// web addresses with the pattern, unticked until the user confirms it.
function patternControl(h, i) {
  const c = columns, pattern = Object.hasOwn(c.patterns, h) ? c.patterns[h] : c.suggested[h]?.pattern;
  if (!pattern) return '';
  return `<label class="use-pattern"><input type="checkbox" id="column-pattern-${i}" data-pattern-column="${i}"${Object.hasOwn(c.patterns, h) ? ' checked' : ''}> ${escapeHtml(COLUMN_WORDS.usePattern)} <code>${escapeHtml(pattern)}</code></label>`;
}
// ---- Hermes: the regions a place lies in ("within" columns, and a column split into levels) -------
// A "within" column has a level beside its choice (1 the widest); a split column, its separator, its
// levels (narrowest first) and whether its first part is the place's name. Levels are positional:
// a column newly read as a region takes the next level; choosing a level another column has swaps
// the two; a column no longer a region gives its level up, and the rest close up (columns.js, within.js).
const usedLevels = () => {
  const out = [];
  for (const [h, f] of Object.entries(columns.mapping)) {
    if (f === 'within' && Object.hasOwn(columns.levels, h)) out.push(columns.levels[h]);
    else if (f === 'split' && Object.hasOwn(columns.splits, h)) out.push(...columns.splits[h].levels);
  }
  return out;
};
function extraControls(h, i) {
  const W = COLUMN_WORDS, c = columns;
  if (c.mapping[h] === 'within' && Object.hasOwn(c.levels, h)) {
    const options = levelChoices(c.levels[h], usedLevels()).map((l) => `<option value="${l}"${l === c.levels[h] ? ' selected' : ''}>${l}</option>`).join('');
    return ` <label class="column-level" data-tip="${escapeHtml(W.levelTip)}">${escapeHtml(W.level)} <select id="column-level-${i}" data-level-column="${i}" aria-label="${escapeHtml(W.levelLabel(h))}">${options}</select></label>`;
  }
  if (c.mapping[h] === 'split' && Object.hasOwn(c.splits, h)) {
    const sp = c.splits[h];
    return `<span class="column-split" data-tip="${escapeHtml(W.splitTip)}">`
      + `<label>${escapeHtml(W.splitOn)} <input type="text" id="column-split-sep-${i}" data-split-column="${i}" data-split="separator" value="${escapeHtml(sp.separator)}" size="4" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(W.splitOnLabel(h))}"></label> `
      + `<label>${escapeHtml(W.splitLevels)} <input type="text" id="column-split-levels-${i}" data-split-column="${i}" data-split="levels" value="${escapeHtml(sp.levels.join(', '))}" size="8" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(W.splitLevelsLabel(h))}"></label> `
      + `<label><input type="checkbox" id="column-split-name-${i}" data-split-column="${i}" data-split="firstIsName"${sp.firstIsName ? ' checked' : ''}> ${escapeHtml(W.splitName)}</label></span>`;
  }
  return '';
}
function refreshExtras() {
  columns.headers.forEach((h, i) => { const el = $(`column-extra-${i}`); if (el) el.innerHTML = extraControls(h, i); });
  lockColumns();
}
// The parts of a column's examples, at most: the levels a split is first given, numbered widest (the last part) first.
function splitDefault(h) {
  const separator = ', ';
  const most = Math.max(1, ...(columns.examples[h] || []).map((v) => v.split(separator.trim()).filter((x) => x.trim()).length));
  return { separator, levels: Array.from({ length: most }, (_, k) => most - k), firstIsName: false };
}
// The "within" columns renumbered 1 to n in their order, once one has gone (with no split, whose levels are typed).
function closeUpLevels() {
  if (Object.values(columns.mapping).includes('split')) return;
  const within = columns.headers.filter((h) => columns.mapping[h] === 'within' && Object.hasOwn(columns.levels, h)).sort((a, b) => columns.levels[a] - columns.levels[b]);
  within.forEach((h, k) => { columns.levels[h] = k + 1; });
}
function chooseLevel(i, level) {
  const h = columns.headers[i], was = columns.levels[h];
  const other = columns.headers.find((o) => o !== h && columns.mapping[o] === 'within' && columns.levels[o] === level);
  columns.levels[h] = level;
  columns.reasons[h] = COLUMN_WORDS.youChose;
  if (other !== undefined) {
    columns.levels[other] = was;
    columns.reasons[h] = COLUMN_WORDS.levelSwapped(other, level);
    const j = columns.headers.indexOf(other);
    columns.reasons[other] = COLUMN_WORDS.levelSwapped(h, was);
    $(`column-why-${j}`).textContent = columns.reasons[other];
  }
  $(`column-why-${i}`).textContent = columns.reasons[h];
  refreshExtras();
  renderColumnWarnings();
}
function chooseSplit(i, what, el) {
  const W = COLUMN_WORDS, h = columns.headers[i], sp = columns.splits[h];
  if (what === 'firstIsName') sp.firstIsName = el.checked;
  else if (what === 'separator') {
    if (el.value === '') { $(`column-why-${i}`).textContent = W.splitSeparatorEmpty; el.value = sp.separator; return; }
    sp.separator = el.value;
  } else {
    const ls = el.value.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!ls.length || !ls.every((l) => Number.isInteger(l) && l >= 1) || new Set(ls).size !== ls.length) { $(`column-why-${i}`).textContent = W.splitLevelsBad; el.value = sp.levels.join(', '); return; }
    sp.levels = ls;
  }
  columns.reasons[h] = W.youChose;
  $(`column-why-${i}`).textContent = W.youChose;
  renderColumnWarnings();
}
function renderColumnWarnings() {
  const warnings = columnWarnings(columns.mapping, columns.gazetteer, columns.suggested, columns.patterns, columns.levels, columns.splits);
  $('columns-warnings').innerHTML = warnings.map((w) => `<p class="warn">${escapeHtml(w)}</p>`).join('');
  state.columns = { headers: [...columns.headers], mapping: Object.assign(Object.create(null), columns.mapping), reasons: Object.assign(Object.create(null), columns.reasons), examples: columns.examples, warnings, messages: [...columns.messages],
    patterns: Object.assign(Object.create(null), columns.patterns), suggested: Object.assign(Object.create(null), columns.suggested),
    levels: Object.assign(Object.create(null), columns.levels), splits: JSON.parse(JSON.stringify(columns.splits)) };
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
      dropPattern(other, j);
    });
  }
  const before = columns.mapping[h];
  columns.mapping[h] = field; columns.reasons[h] = W.youChose;
  clearPreview();
  $(`column-why-${i}`).textContent = W.youChose;
  // A region takes the next level; one no longer a region gives its level up. A split starts from its examples.
  if (field !== 'within' && Object.hasOwn(columns.levels, h)) { delete columns.levels[h]; closeUpLevels(); }
  if (field !== 'split') delete columns.splits[h];
  if (field === 'within' && before !== 'within') columns.levels[h] = Math.max(0, ...usedLevels()) + 1;
  if (field === 'split' && before !== 'split') columns.splits[h] = splitDefault(h);
  refreshExtras();
  // A pattern makes web addresses: it goes with the address, and with nothing else.
  if (field !== 'address') dropPattern(h, i);
  // Rows with the same id are one place only while a column is the id.
  if ($('reading-sameId')?.checked && !hasIdColumn()) { $('reading-sameId').checked = false; readingMessage(READING_WORDS.sameIdNoId); }
  renderColumnWarnings();
}
function dropPattern(h, i) {
  delete columns.patterns[h];
  const box = $(`column-pattern-${i}`); if (box) box.checked = false;
}
// The box beside a suggested pattern: ticked, the column is the place's web address, made with it;
// unticked, the column goes back to what it was first read as (an address column without the pattern).
function choosePattern(i, on) {
  const h = columns.headers[i], pattern = Object.hasOwn(columns.patterns, h) ? columns.patterns[h] : columns.suggested[h]?.pattern;
  if (on && pattern) {
    $(`column-${i}`).value = 'address';
    chooseColumn(i, 'address');
    columns.patterns[h] = pattern;
  } else {
    const back = columns.first[h] === 'address' ? 'address' : 'note';
    $(`column-${i}`).value = back;
    chooseColumn(i, back);
    dropPattern(h, i);
  }
  renderColumnWarnings();
}
function saveMatching() {
  const a = document.createElement('a');
  // In the file's order, which an object would not keep for a column whose heading is a number.
  // A column made into web addresses through a pattern is saved in its object form (mappingToSave).
  const saved = mappingToSave(columns.mapping, columns.patterns, columns.levels, columns.splits);
  const mapped = columns.headers.map((h) => `${JSON.stringify(h)}: ${JSON.stringify(saved[h])}`);
  // With groups of spellings ticked, the mapping and the groups side by side ({ columns, clusters },
  // src/engine/hermes/cluster.js): never inside the mapping, where any key could be a column's heading.
  const groups = spellings.confirmed();
  const text = Object.keys(groups).length
    ? `{\n  "columns": {\n${mapped.map((l) => `    ${l}`).join(',\n')}\n  },\n  "clusters": ${JSON.stringify(groups, null, 2).replace(/\n/g, '\n  ')}\n}\n`
    : `{\n${mapped.map((l) => `  ${l}`).join(',\n')}\n}\n`;
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
  // A matching saved with groups of spellings: the mapping is read as before, and the groups shown, ticked as saved.
  const { columns: mapping, clusters } = splitMatching(saved);
  if (clusters !== undefined) {
    try { spellings.load(clusters); }
    catch (e) { $('columns-messages').innerHTML = `<p class="warn">${escapeHtml(e.message)}</p>`; return; }
  }
  requestColumns(mapping, file.name);
}
$('columns').addEventListener('change', (e) => {
  if (e.target.id === 'columns-sheet') chooseSheet(e.target.value);
  else if (e.target.matches('select[data-column]')) chooseColumn(Number(e.target.dataset.column), e.target.value);
  else if (e.target.matches('input[data-pattern-column]')) { choosePattern(Number(e.target.dataset.patternColumn), e.target.checked); clearPreview(); }
  else if (e.target.matches('select[data-level-column]')) { chooseLevel(Number(e.target.dataset.levelColumn), Number(e.target.value)); clearPreview(); }
  else if (e.target.matches('[data-split-column]')) { chooseSplit(Number(e.target.dataset.splitColumn), e.target.dataset.split, e.target); clearPreview(); }
});

// ---- Hermes: Reading options --------------------------------------------------------------------
// One fieldset, shown only for a format that has reading options: a TEI edition (its list of places,
// and a pattern for each prefix of its keys) or a table of places (rows with the same id as one
// place). Every control is off until chosen. The options that convert the editors' words (TEI header
// places and commentary places, marked plato:Editorial) are shown only while tei.js's EDITORIAL_IRI
// is set, as it is: the worker says so, when it is ready.
// A hint for an option, if one is ever added, is a data-tip (src/lib/tooltip.js), never a title
// attribute; for now the report says what each does.
let readingCaps = { editorial: false }, teiKeys = null;
const hasIdColumn = () => !!columns && Object.values(columns.mapping).includes('id');
// Hermes: "Group similar spellings…", below the Reading options for a table of places. Only the
// groups ticked are sent with a run or a preview; any change to them clears the preview.
const spellings = spellingsPanel({ box: $('spellings'), ask: (m) => worker.postMessage({ ...m, files, ...sheetOption() }), changed: () => clearPreview(), publish: (s) => { state.spellings = s; } });
function renderReading() {
  const R = READING_WORDS, box = $('reading'), tei = input?.format === 'tei';
  teiKeys = null;
  box.hidden = !(tei || isTable(input));
  if (box.hidden) { box.innerHTML = ''; readingState(); return; }
  const controls = tei ? ['listPlaces', ...(readingCaps.editorial ? ['headerPlaces', 'commentaryPlaces'] : [])] : ['sameId'];
  box.innerHTML = `<legend>${escapeHtml(R.legend)}</legend>`
    + controls.map((c) => `<label><input type="checkbox" id="reading-${c}" data-reading="${c}"> ${escapeHtml(R[c])}</label>`).join('')
    + '<div id="reading-keys"></div><div id="reading-message" aria-live="polite"></div>';
  readingState();
}
function requestTeiKeys() {
  const id = ++columnsAsked;             // the same count as the columns': a later choice makes it stale
  worker.postMessage({ cmd: 'tei-keys', id, files });
}
function onTeiKeys(d) {
  if (d.id !== columnsAsked || input?.format !== 'tei') return;   // an answer about a file no longer chosen
  const R = READING_WORDS;
  // A file whose keys cannot be read: said here, briefly; the run reports what stops it, in full.
  teiKeys = d.error ? [] : d.prefixes;
  gatePreview();   // the keys are known: the preview may be made
  if (d.error) $('reading-keys').innerHTML = `<p class="warn" id="reading-keys-message">${escapeHtml(R.keysUnread(firstSentence(d.error)))}</p>`;
  else if (teiKeys.length) {
    const rows = teiKeys.map((k, i) => `<tr><th scope="row">${k.prefix ? `<code>${escapeHtml(k.prefix)}</code>` : `<em>${escapeHtml(R.noPrefix)}</em>`}</th>`
      + `<td>${k.count.toLocaleString('en-GB')}</td>`
      + `<td><ul class="examples">${k.examples.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></td>`
      + `<td><label for="key-pattern-${i}" class="visually-hidden">${escapeHtml(R.keyPatternLabel(k.prefix))}</label><input type="text" id="key-pattern-${i}" data-key="${i}" value="${escapeHtml(k.suggested || '')}" size="34" spellcheck="false" autocomplete="off"></td>`
      + `<td><label for="key-use-${i}" class="visually-hidden">${escapeHtml(R.keyUseLabel(k.prefix))}</label><input type="checkbox" id="key-use-${i}" data-key-use="${i}"></td></tr>`).join('');
    $('reading-keys').innerHTML = `<div class="columns-scroll"><table class="columns-table reading-keys"><caption>${escapeHtml(R.keysCaption)}</caption>`
      + `<thead><tr><th scope="col">${R.keyPrefix}</th><th scope="col">${R.keyCount}</th><th scope="col">${R.keyExamples}</th><th scope="col">${R.keyPattern}</th><th scope="col">${R.keyUse}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  readingState();
}
/** The first sentence of a message, for a short note (the report gives the rest). */
const firstSentence = (m) => { const t = String(m).split('\n')[0]; return (/^.*?\.(?=\s|$)/.exec(t) || [t])[0]; };
/** The patterns ticked for the keys' prefixes, as { prefix: pattern }. */
function keyPatterns() {
  const out = Object.create(null);
  (teiKeys || []).forEach((k, i) => { if ($(`key-use-${i}`)?.checked) out[k.prefix] = $(`key-pattern-${i}`).value.trim(); });
  return out;
}
/** The reading options chosen, for the run's options: only those that are on. */
function readingOptions() {
  const on = (id) => !!$(`reading-${id}`)?.checked, o = {};
  if (input?.format === 'tei') {
    if (on('listPlaces')) o.listPlaces = true;
    if (readingCaps.editorial && on('headerPlaces')) o.headerPlaces = true;
    if (readingCaps.editorial && on('commentaryPlaces')) o.commentaryPlaces = true;
    const kp = keyPatterns();
    if (Object.keys(kp).length) o.keyPatterns = { ...kp };
  } else if (isTable(input) && on('sameId')) o.sameId = true;
  return o;
}
/** Why the reading options chosen cannot be used, in words, or null. A pattern itself the engine checks, and refuses in the report. */
function readingProblem() {
  if (isTable(input) && $('reading-sameId')?.checked && !hasIdColumn()) return READING_WORDS.sameIdNoId;
  if (isTable(input) && spellings.problem()) return spellings.problem();
  if (input?.format === 'tei') for (const [prefix, pattern] of Object.entries(keyPatterns())) if (!pattern) return READING_WORDS.keyEmpty(prefix);
  return null;
}
function readingMessage(text) {
  const m = $('reading-message');
  if (m) m.innerHTML = text ? `<p class="warn">${escapeHtml(text)}</p>` : '';
  readingState();
}
function readingState() {
  const box = $('reading');
  state.reading = {
    shown: !box.hidden,
    controls: [...box.querySelectorAll('input[data-reading]')].map((x) => ({ id: x.dataset.reading, checked: x.checked })),
    keys: teiKeys && teiKeys.map((k, i) => ({ prefix: k.prefix, count: k.count, suggested: k.suggested || null, pattern: $(`key-pattern-${i}`)?.value ?? null, use: !!$(`key-use-${i}`)?.checked })),
    message: $('reading-message')?.textContent || '',
    keysMessage: $('reading-keys-message')?.textContent || '',
  };
}
$('reading').addEventListener('change', (e) => {
  clearPreview();
  if (e.target.id === 'reading-sameId' && e.target.checked && !hasIdColumn()) { e.target.checked = false; readingMessage(READING_WORDS.sameIdNoId); return; }
  readingMessage('');
});
$('reading').addEventListener('input', () => { clearPreview(); readingState(); });

// ---- Hermes: the preview of the first records -------------------------------------------------------
// For a table of places, a TEI edition or W3C Web Annotations (the formats src/engine/hermes/preview.js
// previews, named here so that the page need not load the engine to know them): the first records as
// a run reads them, shown as escaped JSON, with the losses so far, grouped as the report groups them.
// The worker writes nothing and opens no database for it. It waits for the columns to be answered (a
// table) or the keys looked for (TEI), and is cleared whenever the matching, the sheet, the reading
// options or the base address change, so that what it shows is never of another reading.
const PREVIEWED = new Set(['csv', 'geojson', 'tei', 'w3c-annotations']);
const PREVIEW_N = 10;
let previewAsked = 0;
const previewable = () => PREVIEWED.has(input?.format) && input.reason === undefined;
function previewReady() {
  if (!previewable()) return false;
  if (isTable(input)) return !!columns;
  if (input.format === 'tei') return teiKeys !== null;
  return true;
}
function gatePreview() {
  const b = $('preview');
  b.textContent = PREVIEW_WORDS.button(PREVIEW_N);
  b.setAttribute('data-tip', PREVIEW_WORDS.tip);
  b.closest('.previewing').hidden = !previewable();
  b.disabled = busy || !!looking || !!state.previewPending || !previewReady();   // Krisis: nor while a lookup runs
  state.previewReady = !b.disabled;
}
function clearPreview() {
  previewAsked++;
  state.previewPending = false; state.preview = null;
  const box = $('preview-result'); box.hidden = true; box.innerHTML = '';
  gatePreview();
}
function startPreview() {
  if (busy || looking || state.previewPending || !previewReady()) return;
  const refused = readingProblem();
  if (refused) { readingMessage(refused); return; }
  clearPreview();
  const id = previewAsked;
  state.previewPending = true;
  const box = $('preview-result'); box.hidden = false; box.innerHTML = `<p>${escapeHtml(PREVIEW_WORDS.pending)}</p>`;
  gatePreview();
  const base = $('base').value.trim() || undefined;
  worker.postMessage({ cmd: 'preview', id, files, limit: PREVIEW_N,
    options: { base, ...(isTable(input) && columns ? { columns: columnOptions() } : {}), ...sheetOption(), ...readingOptions(), ...(isTable(input) ? spellings.options() : {}) } });
}
function onPreview(d) {
  if (d.id !== previewAsked) return;              // an answer about a reading changed since
  state.previewPending = false;
  const box = $('preview-result'), P = PREVIEW_WORDS;
  if (d.error) {
    box.innerHTML = `<p class="warn">${escapeHtml(P.failed(d.error))}</p>`;
    state.preview = { error: d.error };
    gatePreview();
    return;
  }
  const values = d.items.map((ev) => ev.value);
  // The notice that the preview is partial is its why, said under the heading: not said twice.
  const losses = { ...d.report, items: d.report.items.filter((i) => i.kind !== 'preview-partial') };
  box.innerHTML = `<h3 id="preview-h">${escapeHtml(P.heading)}: ${escapeHtml(d.line)}</h3>`
    + (d.why ? `<p id="preview-why">${escapeHtml(d.why)}</p>` : '')
    + (values.length ? `<pre class="preview-json" tabindex="0" aria-label="${escapeHtml(P.jsonLabel)}">${escapeHtml(JSON.stringify(values, null, 2))}</pre>` : `<p>${escapeHtml(P.none)}</p>`)
    + `<h4>${escapeHtml(P.losses)}</h4><div id="preview-losses">${losses.items.length ? reportHtml(losses, 'check') : `<p>${escapeHtml(P.noLosses)}</p>`}</div>`;
  state.preview = { line: d.line, complete: d.complete, total: d.total, why: d.why, read: d.read, profile: d.profile, header: d.header, items: values, report: d.report };
  gatePreview();
}
$('preview').onclick = startPreview;
$('base').addEventListener('input', clearPreview);

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// Cleared once read, so that choosing the same file again (after editing it) is a change too.
$('picker').onchange = (e) => { choose(e.target.files); e.target.value = ''; };
// Hermes: a pasted list of names, read as a one-column CSV file (src/engine/hermes/pasted.js) handed
// in as a dropped file is, through the usual detection and matching of columns.
{
  const P = PASTE_WORDS;
  $('paste').innerHTML = `<summary>${escapeHtml(P.summary)}</summary>`
    + `<label for="paste-text">${escapeHtml(P.label)}</label><textarea id="paste-text" rows="6" spellcheck="false" aria-describedby="paste-note"></textarea>`
    + `<p class="actions"><button type="button" id="paste-use">${escapeHtml(P.use)}</button> <small id="paste-note">${escapeHtml(P.note)}</small></p><p id="paste-message" class="warn" aria-live="polite"></p>`;
  $('paste-use').onclick = () => {
    const f = pastedListFile($('paste-text').value);
    $('paste-message').textContent = f ? '' : P.empty;
    if (f) choose([f]);
  };
}
// Going to Chora's page with files chosen here hands them over (src/chora/handoff.js), and it offers
// to open them. Only then, not on every choice: the browser may keep a copy of a stored file, and
// the files here may be of any size.
document.addEventListener('click', async (e) => {
  if (e.defaultPrevented) return;   // a first tap that showed a tooltip, not a choice of the way
  // Methodos's "Open Chora" carries the workflow (./chora.html#workflow=<id>), and hands the files over too.
  const a = e.target.closest('a[href="./chora.html"], a[href^="./chora.html#workflow="]');
  if (!a || !files.length || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  await stashForChora(files);
  location.href = a.href;
});
// Files handed over that Chora's page never took (the way taken, its page not started) are not left
// in the browser: let go here when this page starts, is shown again (back from Chora) or is left,
// once they are older than the hand-over allows. A fresh hand-over, on the way to Chora now, is kept.
dropStaleHandoff();
for (const ev of ['pageshow', 'pagehide']) window.addEventListener(ev, () => dropStaleHandoff());
// Chora's hand-back is let go where the hand-off is, when stale (a fresh one waits for the user's click).
dropStaleHandback();
for (const ev of ['pageshow', 'pagehide']) window.addEventListener(ev, () => dropStaleHandback());
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault(); drop.classList.remove('over');
  // Methodos: a file dropped gives a handle too where the browser can (Chromium's getAsFileSystemHandle,
  // asked for during the event, as it must be), for one-click resume. A folder, a refusal or a browser
  // without it gives none, and the drop goes on as before.
  const list = [...e.dataTransfer.files];
  try {
    const item = [...(e.dataTransfer.items || [])].find((i) => i.kind === 'file');
    const asked = item && typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null;
    if (asked && list.length === 1) methodos.dropped(Promise.resolve(asked).catch(() => null), list[0]);
  } catch { /* no handle: chosen again on resume */ }
  choose(list);
};
$('check').onclick = () => start('check');
$('convert').onclick = () => start('convert');
// Comparing asks for one more file, the earlier version, and starts once it is chosen.
$('compare').onclick = () => $('earlier').click();
// Checking with candidate sets asks for them, and starts once they are chosen.
$('check-candidates').onclick = () => $('candidate-sets').click();
$('candidate-sets').onchange = (e) => { const sets = [...e.target.files]; e.target.value = ''; if (sets.length) start('check', sets); };
$('earlier').onchange = (e) => { const earlier = [...e.target.files]; e.target.value = ''; if (earlier.length) start('compare', earlier); };
$('publish').onclick = () => start('publish');
$('cancel').onclick = () => { worker.terminate(); busy = false; if (runOp) { methodos.ended({ op: runOp, cancelled: true }); runOp = null; } $('progress').hidden = true; clearPreview(); buttons(false); Object.assign(state, { phase: 'cancelled' }); startWorker();
  // Krisis: an answer about the columns still being worked out went with the worker: it is asked for again, as it was
  // (for a resumed review, by the matching the review was made with), or Match and Finish would wait for it for ever.
  if (columnsPending()) { const forReview = reviewColumnsAsked === columnsAsked; requestColumns(columnsSaved, columnsFrom); if (forReview) reviewColumnsAsked = columnsAsked; } };
// Matching asks for the other dataset, and starts once it is chosen; resuming asks for a saved review.
// Options that matching would refuse are said plainly first, before the other dataset is asked for.
$('match').onclick = () => { const problem = matchProblem(); if (problem) return refuse(problem); $('others').click(); };
$('others').onchange = (e) => { const others = [...e.target.files]; e.target.value = ''; if (others.length) start('match', others); };
$('resume').onclick = () => $('workfile').click();
$('workfile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) resume(f); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };

// ---- The tools, chosen first or not at all -------------------------------------------------------
// The data can be chosen first, and step 2 then offers everything that can be done with it, Chora's
// map included; or a tool's card can be chosen, before the data or after, and step 2 is narrowed to
// what that tool does (each part of step 2 names, in data-tools, the tools it is for). The choice is
// kept in the address as #tool=<key>, replaced rather than added to the history, so that a reload or
// a link keeps it. The keys are not the ids of step 2's buttons (#check would scroll to the button,
// not choose the tool). Hermes, the readers, narrows nothing: its card goes to the drop zone. Chora's
// card is a link to its own page, which takes the chosen file with it (the click handler above).
const GUIDE = 'https://pelagios.org/place-attestation-ontology/guide/tools.html';
const TOOLS = {
  check: { name: 'Elenchos', what: 'the check', heading: 'Check it', guide: ['checking', 'What it checks'] },
  convert: { name: 'Metaphrasis', what: 'conversion', heading: 'Convert it', guide: ['converting', 'What each format keeps'] },
  figures: { name: 'Arithmos', what: 'statistical figures, converted to N-Triples with the RDF Data Cube option (ticked, under Options)', heading: 'Convert its figures to RDF Data Cube', guide: ['converting', 'Converting, in the guide'] },
  versions: { name: 'Mneme', what: 'the version check: choose the new version here, and you will be asked for the earlier one', heading: 'Compare it with the earlier version', guide: ['comparing-two-versions', 'What it reports'] },
  publish: { name: 'Agora', what: 'publishing', heading: 'Prepare it for publishing', guide: ['publishing-your-dataset', 'What publishing takes'] },
  match: { name: 'Krisis', what: 'match review', heading: 'Match it with another dataset', guide: ['match-review', 'How to review matches'] },
};
const EVERY_ACTION = $('action-what').textContent;
let tool = null;
// Hermes chosen: it narrows nothing, and is not kept in the address, but its card is marked and #for-tool
// says what it reads, until another card or a file's action is chosen.
let hermesChosen = false;
const HERMES = 'For <strong>Hermes</strong>, the readers: your file is read when you drop it, whether annotations from Recogito, a TEI edition, a CSV file or workbook, or GeoJSON. Then choose what to do with it.';
let workflowStep = null;   // the step of a Methodos workflow the user is at, if they follow one: { tool, text, link }
// The fragment holds the tool chosen (#tool=<key>) and, back from Chora, the workflow it was opened for
// (#workflow=<id>, src/chora/handback.js), together as #tool=<key>&workflow=<id>.
const hashParam = (name) => { try { return new URLSearchParams(location.hash.replace(/^#/, '')).get(name); } catch { return null; } };
const toolFromHash = () => { const k = hashParam('tool'); return k && /^[a-z]+$/.test(k) && TOOLS[k] ? k : null; };
// The workflow the address named on arrival, carried through every rewrite of the fragment for as long as it is the one followed.
const arrivedFor = workflowOf(location.hash)?.id || null;
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function chooseTool(key) {
  const was = tool;
  tool = TOOLS[key] ? key : null;
  hermesChosen = key === 'read';
  if (was === 'figures' && tool !== 'figures') leaveFigures();
  // Arithmos with a file that is already N-Triples: there is nothing to convert it to that carries the
  // Data Cube, so the step offers the check instead, and says why.
  const asCheck = tool === 'figures' && input?.format === 'ntriples';
  const shownFor = asCheck ? 'check' : tool;
  for (const el of document.querySelectorAll('#action [data-tools]')) el.hidden = !!tool && !el.dataset.tools.split(' ').includes(shownFor);
  // Convert stands alone when Check is not shown, and is then the step's main button.
  $('convert').classList.toggle('primary', shownFor === 'convert' || shownFor === 'figures');
  $('action-what').textContent = asCheck ? 'Check it: it is already N-Triples' : tool ? TOOLS[tool].heading : EVERY_ACTION;
  $('action').classList.toggle('narrowed', !!tool);
  for (const a of document.querySelectorAll('#toolbox .tool-link[data-tool]')) {
    if (a.dataset.tool === (hermesChosen ? 'read' : tool)) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  }
  const note = $('for-tool');
  note.hidden = !tool && !workflowStep && !hermesChosen;
  note.textContent = '';
  if (workflowStep) {                     // a Methodos workflow's step, said first (src/methodos/page.js)
    const w = document.createElement('span');
    w.className = 'workflow-step'; w.textContent = workflowStep.text;
    if (workflowStep.link) { const a = document.createElement('a'); a.href = workflowStep.link.href; a.textContent = workflowStep.link.words; w.append(' ', a, '.'); }
    note.append(w, ' ');
  }
  if (tool) {
    const [anchor, words] = TOOLS[tool].guide;
    note.insertAdjacentHTML('beforeend', `For <strong>${TOOLS[tool].name}</strong>, ${escapeHtml(TOOLS[tool].what)}. <a href="${GUIDE}#${anchor}">${words}</a>. `);
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'link'; all.id = 'every-action'; all.textContent = 'Show every action';
    all.onclick = () => { chooseTool(null); setHash(null); focusStep1(); };
    note.appendChild(all);
    if (tool === 'figures' && !asCheck) presetFigures();
  }
  if (hermesChosen) note.insertAdjacentHTML('beforeend', HERMES);
  Object.assign(state, { tool });
}
// Arithmos: Convert to N-Triples, with the Data Cube option (in Options) ticked. Applied again when a
// file is detected, since the list of formats to convert to is made then. Leaving Arithmos for another
// tool, or for every action, undoes both: the format chosen before it (or the first offered) comes
// back, and the Data Cube option is cleared, so that a later conversion adds no Data Cube unasked.
let beforeFigures = null;
function presetFigures() {
  const sel = $('target');
  if (beforeFigures === null) beforeFigures = sel.value;
  if ([...sel.options].some((o) => o.value === 'ntriples')) { sel.value = 'ntriples'; sel.onchange(); }
  $('cube').checked = true;
}
function leaveFigures() {
  const sel = $('target');
  $('cube').checked = false;
  if (sel.options.length) {
    sel.value = [...sel.options].some((o) => o.value === beforeFigures) ? beforeFigures : sel.options[0].value;
    sel.onchange();
  }
  beforeFigures = null;
}
function setHash(key) {
  let w = null;
  try { w = arrivedFor && methodos.id() === arrivedFor ? arrivedFor : null; } catch { /* before Methodos is mounted */ }
  const parts = [key ? `tool=${key}` : null, w ? `workflow=${w}` : null].filter(Boolean);
  try { history.replaceState(history.state, '', location.pathname + location.search + (parts.length ? `#${parts.join('&')}` : '')); } catch {}
}
function focusStep1() {
  const h = $('files-h');
  h.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  h.focus({ preventScroll: true });
}
$('toolbox').addEventListener('click', (e) => {
  // A first tap on a card's name shows its tooltip, and goes no further (src/lib/tooltip.js).
  if (e.defaultPrevented) return;
  const a = e.target.closest('.tool-link[data-tool]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  if (a.dataset.tool === 'read') {          // Hermes: to the drop zone, with every action still offered
    chooseTool('read'); setHash(null);
    $('drop').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    $('picker').focus({ preventScroll: true });
    return;
  }
  chooseTool(a.dataset.tool); setHash(a.dataset.tool); focusStep1();
});
window.addEventListener('hashchange', () => { chooseTool(toolFromHash()); if (location.hash === '#methodos') methodos.open(); });
chooseTool(toolFromHash());

// ---- Methodos: the interview and the tracker (src/methodos/page.js) ------------------------------
// Opened from its card (or an address ending #methodos); until then the page is as it was. Each step
// the workflow comes to chooses that step's tool, as its card would, and is said in #for-tool.
const methodosStore = workflowStore();
const methodos = mountMethodos({
  banner: $('methodos-banner'), interview: $('methodos'), tracker: $('methodos-tracker'), tools: $('toolbox'), store: methodosStore,
  page: {
    files: () => files,
    choose: (list) => { const dt = new DataTransfer(); for (const f of list) dt.items.add(f); $('picker').files = dt.files; choose(list); },
    pick: () => $('picker').click(),
    ready: () => whenReady,
    output: async (name) => (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('outputs')).getFileHandle(name)).getFile(),
    mapping: () => (isTable(input) && columns && !columns.error ? columnOptions() : null),
    review: () => (work ? { text: serialiseWork(work), name: workName } : null),
    openWork: (f) => resume(f),
    pickWork: () => $('workfile').click(),
    ownTarget: () => (input && readable(input) ? INPUT_TO_TARGET[input.format] ?? null : null),
    base: () => $('base').value,
    // As if typed in Options: its own listeners (the preview made under it is let go) hear 'input' and 'change'.
    setBase: (v) => { if ($('base').value === v) return; $('base').value = v; for (const t of ['input', 'change']) $('base').dispatchEvent(new Event(t, { bubbles: true })); },
  },
  workflow: arrivedFor,
  onStep(step) {
    if (!step && !workflowStep) return;
    workflowStep = step;
    chooseTool(step?.tool ?? null); setHash(step?.tool ?? null);
  },
});
// Methodos: the interview's base address field shows Options' base address, the one store of it.
$('base').addEventListener('input', () => methodos.baseChanged());
for (const id of ['methodos-card', 'methodos-ask']) $(id).addEventListener('click', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // a first tap on the card's name shows its tooltip (src/lib/tooltip.js)
  e.preventDefault(); methodos.open();
});
if (location.hash === '#methodos') methodos.open();
// "Keep working data" turned off in the Permissions panel: Methodos's records go at once, not at its next save.
let keptBefore = permissions.keepWorkingData();
permissions.onChange(() => { const now = permissions.keepWorkingData(); if (now !== keptBefore) { keptBefore = now; methodos.keepChanged(now); } });

// Krisis: match review. One subject place at a time, with its candidates; each decision is written
// into the work object at once (decide() in engine/krisis/work.js), which "Save the review" saves
// and Finish hands to the engine to make the attestations.
let work = null, workName = 'review.krisis.json', order = [], cursor = 0, current = 0, basisFor = null, allDone = false;
let unsaved = 0;   // decisions made since the review began or was last saved (a reload would lose them)
let saves = 0;     // how many times it has been saved (Krisis × Methodos: with unsaved, whether the guards' plan may be stale)
const REVIEWER_KEY = 'plato-tools.reviewer';
/**
 * The reviewer remembered, checked again on load by the engine's own rule (checkReviewer), as before a
 * save: a name, and an ORCID only if it is one. What is kept here can be written by any page of the
 * site's origin (DEVELOPERS.md, "The shared origin"), so an ORCID that is not one is dropped, not shown.
 */
function remembered() {
  let r;
  try { r = JSON.parse(localStorage.getItem(REVIEWER_KEY)); } catch { return {}; }
  if (!r || typeof r !== 'object' || typeof r.name !== 'string') return {};
  const out = { name: r.name };
  if (typeof r.orcid === 'string') { try { checkReviewer({ name: r.name, orcid: r.orcid }); out.orcid = r.orcid; } catch { /* not an ORCID: dropped */ } }
  return out;
}
function remember() {
  const r = reviewer() || {};
  if (r.orcid && reviewerProblem()) delete r.orcid;   // an ORCID that is not one is not remembered
  try { localStorage.setItem(REVIEWER_KEY, JSON.stringify(r)); } catch {}
}
/** The reviewer, as a PLATO contributor ({ name, orcid? }), or null until a name is given. */
function reviewer() {
  const name = $('reviewer').value.trim();
  // An ORCID is recorded in full, as a web address; one given as its sixteen digits is written so.
  let orcid = $('orcid').value.trim();
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) orcid = 'https://orcid.org/' + orcid;
  return name ? { name, ...(orcid ? { orcid } : {}) } : null;
}
/** What is wrong with the reviewer given, in words, or null: the engine's own rule (checkReviewer), so the page never saves what a resumed review would refuse. */
function reviewerProblem() {
  const r = reviewer();
  if (!r) return null;
  try { checkReviewer(r); return null; } catch { return W.badOrcid; }
}
function matchOptions() {
  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : undefined; };
  return { threshold: num('threshold'), maxDistanceKm: num('max-distance'), othersTitle: $('others-title').value.trim() || undefined };
}
/** What is wrong with the matching options, in the engine's own words (checkMatchOptions), or null. */
function matchProblem() { try { checkMatchOptions(matchOptions()); return null; } catch (e) { return e.message; } }
/** Say plainly why something cannot be done, where results are shown. */
function refuse(message) {
  $('result').hidden = false; $('saves').innerHTML = ''; $('report').innerHTML = '';
  $('summary').innerHTML = `<span class="warn">${escapeHtml(message)}</span>`;
  Object.assign(state, { phase: 'error', error: message });
}
async function resume(file) {
  let w;
  try { w = readWork(await file.text()); } catch (e) { refuse(e.message); return; }
  $('result').hidden = true;
  // The other dataset's title typed for an earlier match is not this review's: put away, it cannot be taken for this one's at finishing.
  $('others-title').value = '';
  beginReview(w, file.name);
  // A review made from other files than those chosen now is still opened, with a warning; with none chosen, it says so.
  if (!files.length) { showWarning(W.noDatasetYet); return; }
  if (!readable(input)) { showWarning(W.notRecognisedYet); return; }
  // A table of places is shown as the review read it, by the matching kept in the work file (or by the guess, if it keeps none).
  if (isTable(input)) { columns = null; state.columns = null; gateOnColumns(); requestColumns(w.match_parameters.columns, workName); reviewColumnsAsked = columnsAsked; }
  try { const differ = await filesDiffer(w.subjects, files); showWarning(differ.length ? W.differs(differ) : ''); } catch { showWarning(''); }
}
function beginReview(w, name, { focus = true } = {}) {
  work = w; workName = name || workName; basisFor = null; findFor = null; allDone = false; unsaved = 0;
  exportedSet = null; earlierSets = []; candidatesStatus('');
  order = placeOrder(); lastBulk = null;
  cursor = Math.min(Math.max(0, work.cursor || 0), Math.max(0, order.length - 1));
  // A place with no candidates has nothing to review: start at the first that has some.
  if (order.length && !candidatesOf(work, order[cursor]).length) cursor = Math.max(0, order.findIndex((iri) => candidatesOf(work, iri).length));
  if (!work.reviewer?.name && !reviewer()) { const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || ''; }
  if (work.reviewer?.name && !reviewer()) { $('reviewer').value = work.reviewer.name; $('orcid').value = work.reviewer.orcid || ''; }
  $('review').hidden = false; showWarning('');
  // The matching of columns a review is finished by is the one shown when it begins: after Match, the one it was matched by.
  reviewColumnsAsked = 0; reviewMapping = isTable(input) && columns ? mappingText(columnOptions()) : undefined;
  lockColumns();
  askName(!reviewer() && order.length > 0);
  goTo(cursor, focus);
}
function showWarning(text) { $('review-warning').textContent = text; $('review-warning').hidden = !text; }
function askName(show, why) {
  const f = $('review-who'); f.hidden = !show;
  if (show) { $('review-name').value = $('reviewer').value; if (why) showWarning(why); $('review-name').focus(); }
}
const undecided = (iri) => candidatesOf(work, iri).findIndex((c) => !c.decision);
// A place still to decide has candidates, none of them decided; one with no candidates has nothing to decide.
const toDecide = (iri) => !isReviewed(work, iri) && candidatesOf(work, iri).length > 0;
function goTo(i, focus = true) {
  cursor = i; basisFor = null; findFor = null;
  const u = order.length ? undecided(order[cursor]) : -1;
  current = u < 0 ? 0 : u;
  render(focus);
}
/** The next (step 1) or previous (step -1) place the filter shows, or null. */
function step(dir) {
  const all = $('review-filter').value === 'all';
  for (let i = cursor + dir; i >= 0 && i < order.length; i += dir) if (all || toDecide(order[i])) return i;
  return null;
}
function move(dir) {
  const i = step(dir);
  allDone = i === null && dir > 0 && $('review-filter').value !== 'all' && !order.some(toDecide);
  if (i !== null) goTo(i); else render(true);
}
function decideOn(id, kind, basis) {
  const cands = candidatesOf(work, order[cursor]);
  decide(work, id, kind, { identityType: kind === 'distinct' ? 'exactMatch' : $('identity-type').value, basis });
  unsaved++;
  basisFor = null;
  const u = undecided(order[cursor]);
  if (kind && u < 0) return move(1);   // every candidate of this place decided: on to the next
  current = kind ? u : Math.max(0, cands.findIndex((c) => c.id === id));
  render(true);
}
function render(focus) {
  const box = $('review-place');
  const p = reviewProgress(work);
  $('review-progress').textContent = W.progress(p, order.length ? cursor + 1 : 0);
  $('review-prev').disabled = step(-1) === null; $('review-next').disabled = $('review-skip').disabled = step(1) === null;
  Object.assign(state, { phase: 'reviewing', work, review: { cursor, subject: order[cursor] || null, current, filter: $('review-filter').value, ...p } });
  $('finish-cites').textContent = LW.cites(citedSources());   // Krisis: gazetteer lookup, one attestation per source
  drawBulk();   // Krisis × Methodos
  drawRegions();   // Krisis: region review
  if (!order.length) { box.innerHTML = `<p>${escapeHtml(W.none)}</p>`; return; }
  const iri = order[cursor], place = work.places[iri] || {}, cands = candidatesOf(work, iri);
  const typed = keepTyped(iri), notes = keepNotes(box, document.activeElement);   // Krisis × Methodos: a note half-typed
  box.innerHTML = (allDone ? `<p class="good">${escapeHtml(W.allDone)}</p>` : '')
    + `<div class="subject"><h3 id="review-subject">${escapeHtml(place.label || iri)}</h3>`
    + (W.names(place.label, place.names) ? `<p>${escapeHtml(W.names(place.label, place.names))}</p>` : '')
    + `<p>${escapeHtml(W.point(place.point))}</p>` + placeRegionHtml(iri, place) + `<p class="iri">${escapeHtml(iri)}</p>` + rowStateHtml(place) + lookupPlaceHtml(iri, place) + '</div>'
    + (hasLookups() ? groupedHtml(cands)
      : `<p>${escapeHtml(W.candidates(cands.length))}</p><ol class="candidates">` + cands.map((c, i) => candidateHtml(c, i)).join('') + '</ol>');
  restoreTyped(typed); restoreNotes(box, notes);
  drawPermission();   // Krisis: gazetteer lookup
  // A form newly opened takes the focus; one redrawn (by a lookup's batch) has it back only if it had it.
  if (findFor === iri) { if (!typed.find || typed.find.focused) $('find-query')?.focus(); return; }
  if (basisFor) { if (!typed.basis || typed.basis.focused) $('basis-input')?.focus(); return; }
  if (!$('review-who').hidden) { $('review-name').focus(); return; }   // while the name is asked, it keeps the focus
  if (notes.some((n) => n.focused) && box.contains(document.activeElement)) return;   // a note being typed keeps it
  if (focus) box.focus({ preventScroll: false });
}
/**
 * What is typed in the find form or the basis field that render() is about to draw again (each batch
 * of a lookup redraws the place): its text, where the cursor is, and whether it has the focus, kept
 * only when the same form is drawn again (the same place's find, the same candidate's basis).
 */
function keepTyped(iri) {
  const one = (el, same) => (el && same ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el } : null);
  const f = $('find-query'), b = $('basis-input');
  return { find: one(f, findFor === iri && f?.form?.dataset.for === iri), basis: one(b, basisFor && b?.form?.dataset.id === basisFor) };
}
function restoreTyped(typed) {
  for (const [id, t] of [['find-query', typed.find], ['basis-input', typed.basis]]) {
    const el = $(id);
    if (!el || !t) continue;
    el.value = t.value;
    if (t.focused) { el.focus({ preventScroll: true }); try { el.setSelectionRange(t.start, t.end); } catch {} }
  }
}
function candidateHtml(c, i) {
  const o = c.other || (Object.hasOwn(work.places, c.candidate_candidate) ? work.places[c.candidate_candidate] : {}), d = c.decision, id = escapeHtml(c.id);
  const btn = (act, text, key) => `<button type="button" data-act="${act}" data-id="${id}" aria-pressed="${d?.kind === act}">${text}${i === current && key ? ` <kbd>${key}</kbd>` : ''}</button>`;
  return `<li class="candidate${i === current ? ' current' : ''}${d ? ' decided' : ''}" data-id="${id}" tabindex="-1"${i === current ? ' aria-current="true"' : ''}>`
    + `<h4><span class="n">${i + 1}</span>${escapeHtml(o.label || c.candidate_candidate)}</h4>`
    + (W.names(o.label, o.names) ? `<p>${escapeHtml(W.names(o.label, o.names))}</p>` : '')
    + `<p class="facts">${escapeHtml(W.facts(c))}; ${escapeHtml(W.point(o.point))}</p>`
    + (c.lookup ? gazetteerHtml(c) + guardHtml(c) : '')
    + `<p class="iri">${escapeHtml(c.candidate_candidate)}</p>`
    + `<p class="decision">${escapeHtml(W.decision(d))}</p>`
    + `<div class="acts">${btn('match', 'Same place', 'a')}${btn('not-this', 'Not this one', 'n')}${btn('distinct', 'Different places', 'd')}`
    + (d ? `<button type="button" data-act="undo" data-id="${id}">Undo</button>` : '')
    + `<button type="button" data-act="flag" data-id="${id}" aria-pressed="${!!c.flagged}">${escapeHtml(c.flagged ? RW.flagged : RW.flag)}</button>` + '</div>'
    + `<form class="note" data-id="${id}"><label>${escapeHtml(RW.noteLabel)} <input type="text" name="note" value="${escapeHtml(c.note || '')}" autocomplete="off"></label>`
    + `<button type="submit">${escapeHtml(RW.noteSave)}</button></form>`
    + (basisFor === c.id ? `<form class="basis" data-id="${id}"><label for="basis-input">${escapeHtml(W.basisLabel)}</label>`
      + `<input id="basis-input" type="text" value="${escapeHtml(d?.basis || '')}" autocomplete="off">`
      + `<button type="submit" class="primary">Record as different places</button><button type="button" data-act="cancel-basis">Cancel</button>`
      + `<p class="warn" id="basis-warn" hidden>${escapeHtml(W.basisNeeded)}</p></form>` : '')
    + '</li>';
}
function openBasis(id) { basisFor = id; current = Math.max(0, candidatesOf(work, order[cursor]).findIndex((c) => c.id === id)); render(); }
$('review-place').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b || busy) return;
  const { act, id } = b.dataset;
  if (act === 'match' || act === 'not-this') decideOn(id, act);
  else if (act === 'distinct') openBasis(id);
  else if (act === 'undo') decideOn(id, null);
  else if (act === 'cancel-basis') { basisFor = null; render(true); }
  else if (act === 'flag') { const c = work.candidates.find((x) => x.id === id); flag(work, id, !c?.flagged); unsaved++; render(false); }
});
$('review-place').addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.matches('form.note')) return keepNote(e.target);   // Krisis × Methodos
  if (!e.target.matches('form.basis')) return;   // Krisis: gazetteer lookup has a form of its own here
  const basis = $('basis-input').value.trim();
  if (!basis) { $('basis-warn').hidden = false; $('basis-input').focus(); return; }
  decideOn(e.target.dataset.id, 'distinct', basis);
});
$('review-place').addEventListener('keydown', (e) => { if (e.key === 'Escape' && basisFor) { basisFor = null; render(true); } else if (e.key === 'Escape' && findFor) { findFor = null; render(true); } });
// The keys act only while the review is shown, and never while typing (or choosing from a list).
document.addEventListener('keydown', (e) => {
  if ($('review').hidden || busy || !work || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.target.closest?.('#lookup, form.find-form, #regions')) return;   // Krisis: nor in the lookup panel, token field and all, nor in the region review
  const cands = order.length ? candidatesOf(work, order[cursor]) : [], c = cands[current];
  const k = e.key;
  if (k === 'j' || k === 's') move(1);
  else if (k === 'k') move(-1);
  else if (k === 'a' && c) decideOn(c.id, 'match');
  else if (/^[1-9]$/.test(k) && cands[+k - 1]) { current = +k - 1; decideOn(cands[current].id, 'match'); }
  else if (k === 'n' && c) decideOn(c.id, 'not-this');
  else if (k === 'd' && c) openBasis(c.id);
  else return;
  e.preventDefault();
});
$('review-prev').onclick = () => move(-1);
$('review-next').onclick = $('review-skip').onclick = () => move(1);
$('review-filter').onchange = () => { allDone = false; render(); };
$('review-who').onsubmit = (e) => {
  e.preventDefault();
  const name = $('review-name').value.trim(); if (!name) return;
  $('reviewer').value = name; remember(); askName(false); showWarning(''); render(true);
};
for (const id of ['reviewer', 'orcid']) $(id).addEventListener('change', remember);
{ const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || '';
  // Written back as checked (remembered), so that an ORCID that is not one is not kept, nor listed in the panel; nothing usable, nothing kept.
  try { if (localStorage.getItem(REVIEWER_KEY) !== null) { if (r.name) localStorage.setItem(REVIEWER_KEY, JSON.stringify(r)); else localStorage.removeItem(REVIEWER_KEY); } } catch {} }
$('save-review').onclick = () => {
  if (!work) return;
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  work.cursor = cursor;
  const who = reviewer(); if (who) work.reviewer = who;
  saveBlob(new Blob([serialiseWork(work)], { type: 'application/json' }), workName);
  Object.assign(state, { reviewSaved: workName });
  unsaved = 0; saves++;
};
$('finish').onclick = () => {
  if (!work) return;
  if (!readable(input)) return showWarning(files.length ? W.notRecognisedAtFinish : W.noDataset);
  if (!reviewer()) return askName(true, W.nameNeeded);
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  work.cursor = cursor; work.reviewer = reviewer();
  // Said, not acted on: the review's saved address is what Finish writes for.
  showWarning(baseDiffers(work, $('base').value) || '');
  start('apply', document.querySelector('input[name="review-output"]:checked').value);
};
// Krisis: the suggestions exported as a candidate set (engine/krisis/candidates.js), made here on the
// page from the work object, which then stores each candidate's address (saved with the review). The
// earlier sets given are left out of it, and Finish passes both to apply.
let exportedSet = null, earlierSets = [];
function candidatesStatus(text, warn = false) { const p = $('candidates-status'); p.textContent = text; p.hidden = !text; p.classList.toggle('warn', warn); }
$('earlier-candidates').onclick = () => $('earlier-candidates-file').click();
$('earlier-candidates-file').onchange = async (e) => {
  const chosen = [...e.target.files]; e.target.value = '';
  if (!chosen.length) return;
  try { earlierSets = await Promise.all(chosen.map(async (f) => readCandidateSet(await f.text(), f.name))); candidatesStatus(KRISIS_CANDIDATES.earlierGiven(earlierSets.length)); }
  catch (err) { earlierSets = []; candidatesStatus(err.message, true); }
  state.earlierCandidateSets = earlierSets.map((s) => s.candidateSet['@id']);
};
$('export-candidates').onclick = () => {
  if (!work || busy) return;
  let x;
  // A table converted under a base address is that dataset (as Agora takes it): with no address of its
  // own, its candidates are exported for the base address given in Options, and the review keeps it.
  const forBase = !work.subjects.uri && datasetAddress($('base').value);
  if (forBase) Object.assign(work.subjects, { uri: forBase, uriFrom: 'base' });
  try { x = exportCandidates(work, { previousSets: earlierSets }); }
  catch (err) { if (forBase) { delete work.subjects.uri; delete work.subjects.uriFrom; } if (err?.name !== 'DataError') throw err; candidatesStatus(err.message, true); return; }
  work = x.work; exportedSet = x.set;
  const { problems, counted } = summary(x.report, 'candidates');
  candidatesStatus(`${problems} ${counted} ${KRISIS_CANDIDATES.saveReviewToo}`);
  const name = workName.replace(/\.krisis\.json$/i, '').replace(/\.json$/i, '') + '.candidates.json';
  if (x.set) saveBlob(new Blob([serialiseCandidateSet(x.set)], { type: 'application/json' }), name);
  Object.assign(state, { candidates: { setIri: x.setIri, leftOut: x.leftOut, set: x.set, name: x.set ? name : null } });
  render();
};
// ---- Krisis × Methodos (#28): WHG's guards, the bulk accept, flags, notes and row states ------------------
// Nothing is accepted for the reviewer: the bulk accept runs only when its button is pressed, takes the
// identity type chosen beside it (closeMatch by default), and can be undone at once (undoBatch, which
// keeps any decision changed since). The order "WHG's guards first" puts the places with a candidate
// that passes first; the candidates of a place keep their own order.
let lastBulk = null;
// planGuarded() reads every candidate: drawn on every render(), it is worked out again only when the
// work may have changed (another work, a decision or flag or row state since, a save, a lookup's batch).
let bulkPlan = null;
function guardedPlan() {
  const key = `${unsaved}|${saves}|${work.candidates.length}|${(work.lookups || []).length}`;
  if (bulkPlan?.work !== work || bulkPlan.key !== key) bulkPlan = { work, key, plan: planGuarded(work) };
  return bulkPlan.plan;
}
/** The places in the order chosen. */
function placeOrder() { return $('review-order')?.value === 'guards' ? guardsFirst(work, reviewPlaces(work)) : reviewPlaces(work); }
/** The order again (a lookup's batch, a new order chosen), the place on screen kept. */
function reorder() { const at = order[cursor]; order = placeOrder(); const i = order.indexOf(at); if (i >= 0) cursor = i; }
function drawBulk() {
  const box = $('review-bulk');
  if (!box) return;
  if (!box.firstChild) {
    box.innerHTML = `<label for="review-order">${escapeHtml(GW.orderLabel)}</label><select id="review-order">`
      + Object.entries(GW.orders).map(([k, t]) => `<option value="${k}">${escapeHtml(t)}</option>`).join('') + '</select>'
      + '<button id="bulk-accept" type="button"></button>'
      + `<label for="bulk-type">${escapeHtml(GW.typeLabel)}</label><select id="bulk-type">`
      + ['closeMatch', 'exactMatch', 'related'].map((t) => `<option value="${t}"${t === 'closeMatch' ? ' selected' : ''}>${escapeHtml($('identity-type').querySelector(`option[value="${t}"]`)?.textContent || t)}</option>`).join('') + '</select>'
      + '<p id="bulk-result" aria-live="polite"></p>';
    $('review-order').onchange = () => { reorder(); render(false); };
    $('bulk-accept').onclick = bulkAccept;
    $('review-bulk').addEventListener('click', (e) => { if (e.target.id === 'bulk-undo') bulkUndo(); });
  }
  const plan = guardedPlan(), n = plan.accept.length;
  $('bulk-accept').textContent = GW.accept(n);
  $('bulk-accept').disabled = !n || busy || !!looking;
  const res = $('bulk-result');
  if (lastBulk?.undone !== undefined) res.textContent = GW.undone(lastBulk.undone);
  else if (lastBulk) {
    res.innerHTML = (lastBulk.batch ? `${escapeHtml(GW.accepted(lastBulk.accepted))} <button type="button" id="bulk-undo" class="link">${escapeHtml(GW.undo)}</button> ` : `${escapeHtml(GW.none)} `)
      + escapeHtml(GW.leftOut(lastBulk.leftOut, lastBulk.several));
  } else res.textContent = GW.leftOut(plan.leftOut, plan.several);
}
function bulkAccept() {
  if (!work || busy || looking) return;
  if (!reviewer()) return askName(true, W.nameNeeded);
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  lastBulk = acceptGuarded(work, { reviewer: reviewer(), identityType: $('bulk-type').value });
  unsaved += lastBulk.accepted;
  Object.assign(state, { bulk: { ...lastBulk } });
  reorder(); render(false);
  $('bulk-undo')?.focus();
}
function bulkUndo() {
  if (!lastBulk?.batch) return;
  const n = undoBatch(work, lastBulk.batch);
  lastBulk = { ...lastBulk, undone: n };
  unsaved++;
  Object.assign(state, { bulk: { ...lastBulk } });
  reorder(); render(false);
}
/** A looked-up candidate's badge: that it passes WHG's guard, and on what; or why not. */
function guardHtml(c) {
  const v = guardOf(c);
  const how = c.gazetteer?.how ? `<p class="gazetteer">${escapeHtml(VW.foundBy(c.gazetteer.query, c.gazetteer.how))}</p>` : '';
  return how + (v.pass ? `<p class="badge good">${escapeHtml(GW.passes(v))}</p>` : `<p class="badge">${escapeHtml(GW.fails(v.reason))}</p>`);
}
/** The place's row state: reconcile (none), keep without reconciling (filter), leave out of the dataset (exclude). */
function rowStateHtml(place) {
  const now = place.rowState || 'reconcile';
  return `<label class="row-state">${escapeHtml(RW.stateLabel)} <select data-row-state>`
    + Object.entries(RW.states).map(([k, t]) => `<option value="${k}"${k === now ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('') + '</select></label>';
}
function keepNote(form) {
  const input = form.querySelector('input[name="note"]'), c = work.candidates.find((x) => x.id === form.dataset.id);
  if (!c || input.value.trim() === (c.note || '')) return;   // nothing new (a change and a focusout both bring it)
  noteOn(work, c.id, input.value); unsaved++;
}
$('review-place').addEventListener('change', (e) => {
  if (!work) return;
  if (e.target.matches('select[data-row-state]')) { setRowState(work, order[cursor], e.target.value === 'reconcile' ? null : e.target.value); unsaved++; render(false); }
  else if (e.target.matches('form.note input[name="note"]')) keepNote(e.target.form);
});
// A note put back after a redraw (restoreNotes) and left without more typing fires no change: kept on leaving it.
$('review-place').addEventListener('focusout', (e) => { if (work && e.target.matches?.('form.note input[name="note"]') && e.target.isConnected) keepNote(e.target.form); });

/** Save something made in the page, not by the engine: as save() does, to disk or as a download. */
async function saveBlob(blob, name) {
  if (window.showSaveFilePicker && !window.__plato_forceDownload) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
// The Permissions panel, from the header's button; and the proof that the page's policy is enforced
// (state.canary), without which no other site is asked from this page.
permissions.mount({ state });
// A reload for a permission cannot keep the files chosen here (the browser gives a page no way back to
// a file without the user choosing it again): it says so in the panel first, and may be cancelled.
// A tool that keeps more (Krisis's review) says what it would lose the same way, with onBeforeReload.
permissions.onBeforeReload(() => {}, { loses: () => (files.length ? RELOAD_LOSES.files(files.map((f) => f.name)) : null) });
permissions.onBeforeReload(() => {}, { loses: () => (busy ? RELOAD_LOSES.running : null) });
permissions.onBeforeReload(() => {}, { loses: () => (work && unsaved ? RELOAD_LOSES.review(unsaved) : null) });
// Krisis: gazetteer lookup (online, optional). The places of the dataset are looked up in WHG, or
// another reconciliation service, and what is found is added to the review on screen (or begins one).
// It runs HERE, on the page's thread, never in the worker (which is not under the page's policy), so
// that every request goes through the permissions module, and the token (permissions.token, its one
// keeper; the page holds no copy) goes nowhere but the Authorization header of a request to WHG: not
// into window.__plato, a work file, an address, the console or the words of an error. The page hands
// it to the shared WHG lookup when it changes (setToken; Forget calls clearToken), and never passes it
// anywhere else. The answers are merged into the work object after each batch, so "Save the review"
// works at any moment.
// Send is offered only once the service's permission ('gazetteer', 'whg' or its site) is allowed;
// until then the module's one line ("Needs permission: …", which opens the Permissions panel) is shown
// in its place, and the preview of what would be sent is still shown. A request the module refuses
// stops the lookup (permittedFetch aborts it with the PermissionError, runLookup words it).
let gathered = null, placesWaiting = null, looking = null, findFor = null, afterStop = null;
// What another service's manifest said (manifestSettings), by its address, once a lookup has read it: the preview then shows its type.
const manifests = new Map();
const token = permissions.token;
/** The fetch every lookup is made with, the same function for all (the shared lookup keeps its first). */
const gazetteerFetch = permittedFetch(permissions.fetch, (e) => looking?.abort(e));
/** WHG's lookup: the one shared in the page (one request in flight, whoever asks). */
const whgLookup = () => createLookup({ endpoint: WHG_ENDPOINT, fetch: gazetteerFetch });
/** Whether the permissions module allows a lookup of this service now (allowed, and in this load's policy). */
const mayLookUp = (svc) => !svc.problem && permissions.allowed('gazetteer', gazetteerPermission(svc.service.endpoint));
/**
 * The one line for this service's permission, in `el`: the module's ("Needs permission: …", which opens
 * Permissions; nothing once it is allowed), or, while it is set to Never (where the module says nothing,
 * and a lookup would otherwise just vanish), "Not allowed: … is set to Never in Permissions." with a
 * button that opens the panel at that permission. Drawn again on every change of permission.
 */
function needsLine(el, svc) {
  if (svc.problem) return permissions.unneed(el);
  const subj = gazetteerPermission(svc.service.endpoint), name = svc.whg ? undefined : svc.service.title;
  // Asked of the module in every state, so that the panel lists this service under its name.
  if (permissions.needs(el, 'gazetteer', subj, { name }) !== 'never') return;
  permissions.unneed(el);
  const key = permissions.keyOf('gazetteer', subj), b = document.createElement('button');
  b.type = 'button'; b.className = 'link'; b.textContent = LW.openPermissions;
  b.onclick = () => permissions.open({ focus: key });
  el.dataset.permission = key; el.classList.add('needs-permission'); el.hidden = false;
  el.append(LW.never(name || permissions.nameOf('gazetteer', subj)), ' — ', b);
}
/** The shared lookup takes the keeper's token, or none: at start (a token kept from before) and on every change. */
const passToken = () => { const t = token.get(); if (t) whgLookup().setToken(t); else whgLookup().clearToken(); };
const showTokenState = () => { $('whg-token-state').textContent = token.get() ? LW.tokenGiven : LW.tokenNone; };
/** The review on screen, which a lookup adds to; null when none is (a lookup then begins one). */
const reviewWork = () => (work && !$('review').hidden ? work : null);
const hasLookups = () => !!work && ((work.lookups || []).length > 0 || work.others === null);
const shortName = (service) => (isWhg(service.endpoint) ? LW.whg : service.title);
const lookupOf = (id) => (work.lookups || []).find((l) => l.id === id);
/** Text cleaned of the token, for what the gazetteer module does not word itself (a fault's stack). The module cleans its own errors and a query's. */
const scrub = (text) => { const t = token.get(); return t ? String(text).split(t).join('[token]') : String(text); };
function lookupSay(text, warn = false) { const p = $('lookup-progress'); p.textContent = text; p.classList.toggle('warn', warn); }
function lookupState(more) { state.lookup = { ...(state.lookup || {}), ...more }; }

// The places of the dataset, with the links it states, read by the worker (gather()); once per choice of files.
function gatherPlaces() {
  const base = $('base').value.trim() || undefined;
  // A table of places is read by the matching of its columns chosen, as Match reads it.
  // With the levels of its "within" columns (Krisis: region review), as Match sends them.
  const cols = isTable(input) && columns ? columnOptions() : undefined, colsText = cols ? mappingText(cols) : undefined;
  if (gathered && gathered.files === files && gathered.base === base && gathered.cols === colsText) return Promise.resolve(gathered);
  if (placesWaiting) return placesWaiting.promise;
  if (busy || !readable(input)) return Promise.resolve(null);
  busy = true; buttons(true);
  lookupSay(LW.reading);
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  placesWaiting = { promise, resolve, files, base, cols: colsText };
  worker.postMessage({ cmd: 'places', subjects: files, options: { base, ...(cols ? { columns: cols } : {}) } });
  return promise;
}
function onPlaces(data) {
  const w = placesWaiting; placesWaiting = null;
  busy = false; buttons(!!looking);   // a lookup running keeps them disabled
  gathered = { files: w.files, base: w.base, cols: w.cols, subjects: data.subjects || null, places: data.places || null, regions: data.regions || [] };
  lookupSay('');
  w.resolve(gathered);
}

/** The service chosen: WHG's, or another's by its address (and a template for its candidates' addresses). */
function lookupService() {
  if (document.querySelector('input[name="lookup-service"]:checked')?.value !== 'other') return { service: serviceOf(WHG_ENDPOINT), whg: true };
  const endpoint = $('lookup-endpoint').value.trim();
  let service;
  try { if (!/^https:\/\//i.test(endpoint)) throw new Error(); service = serviceOf(endpoint); } catch { return { problem: LW.badEndpoint }; }
  if (isWhg(endpoint)) return { service: serviceOf(WHG_ENDPOINT), whg: true };
  const t = $('lookup-iri').value.trim();
  if (t) { try { iriFromTemplate(t); } catch { return { problem: LW.badTemplate }; } }
  return { service, whg: false, template: t || null };
}
function lookupOptions(extra = {}) {
  const km = parseFloat($('lookup-near-km').value);
  return { places: $('lookup-places').value, allNames: $('lookup-all-names').checked, variants: $('lookup-variants').checked, countries: $('lookup-countries').checked,
    nearKm: $('lookup-near').checked && km > 0 ? km : null, maxDistanceKm: matchOptions().maxDistanceKm, ...extra };
}
/**
 * The places a lookup would take and what it would send, planned by runLookup()'s own planLookup, in
 * requests of the size of the lookup that would send them: WHG's shared one (whose size is the first
 * caller's, Chora's perhaps), or for another service the module's default, as lookUp() makes it.
 */
function planFor(svc, opts, places) {
  return planLookup({ lookup: svc.whg ? whgLookup() : null, work: reviewWork(), places,
    options: { ...opts, service: svc.service, type: svc.whg ? undefined : manifests.get(svc.service.endpoint)?.type || undefined } });
}

// The choice of places: after a match, those it found nothing for; once a lookup has run, those not answered.
function fillChoices() {
  const sel = $('lookup-places'), want = defaultChoice(reviewWork());
  sel.innerHTML = PLACE_CHOICES.map((k) => `<option value="${k}"${k === want ? ' selected' : ''}>${escapeHtml(LOOKUP_WORDS.choices[k])}</option>`).join('');
}
/** The preview: places, queries, requests, the share of WHG's allowance, and the first queries exactly as sent. */
async function refreshPreview() {
  const box = $('lookup-preview'), send = $('lookup-send');
  if (!$('lookup').open) return;
  const svc = lookupService();
  send.disabled = true;
  // Send is offered once the permission allows it; until then, the module's one line in its place.
  needsLine($('lookup-permission'), svc);
  send.hidden = !mayLookUp(svc);
  if (svc.problem) { box.innerHTML = `<p class="warn">${escapeHtml(svc.problem)}</p>`; return; }
  if (!readable(input) && !reviewWork()) { box.innerHTML = `<p>${escapeHtml(LW.noDataset)}</p>`; return; }
  const g = await gatherPlaces();
  const places = g?.places ?? null;
  if (!places && !reviewWork()) { box.innerHTML = `<p class="warn">${escapeHtml(busy ? LW.busy : LW.placesNotRead)}</p>`; return; }
  showRegionOffer(g);   // Krisis: region review
  const p = planFor(svc, lookupOptions(), places).preview;
  const lines = LOOKUP_WORDS.preview(p);
  if (svc.whg) lines.splice(1, 0, LW.share(p.requests, WHG_REQUESTS_A_DAY));
  if (!places) lines.push(LOOKUP_WORDS.linksUnknown);
  box.innerHTML = `<p>${lines.map(escapeHtml).join(' ')}</p>`
    + (p.first.length ? `<ol class="lookup-queries">${p.first.map((q) => `<li><code>${escapeHtml(JSON.stringify(q))}</code></li>`).join('')}</ol>` : `<p>${escapeHtml(LOOKUP_WORDS.noPlaces)}</p>`);
  send.textContent = LW.send(p.queries, shortName(svc.service));
  send.disabled = !p.queries || !!looking;
  lookupState({ preview: { places: p.places, queries: p.queries, requests: p.requests, first: p.first } });
}

/**
 * Look places up. With nothing given, as the panel says; `only` (IRIs) for one place from the review
 * screen, with `query` the name to send instead of its label, or `allNames` to send its other names.
 */
async function lookUp({ only = null, query = null, allNames, which } = {}) {
  if (looking) return;
  if ($('whg-token').value.trim()) commitToken();
  const svc = lookupService();
  if (svc.problem) { $('lookup').open = true; return lookupSay(svc.problem, true); }
  // Not allowed (not decided, or Never): nothing is sent; the panel shows the one line, whose button opens Permissions.
  if (!mayLookUp(svc)) {
    // Methodos: a workflow at its lookup waits for the permission, and says so.
    if (!only) { methodos.began({ op: 'lookup', files }); methodos.ended({ op: 'lookup', waiting: 'the gazetteer to be allowed in the Permissions panel; then look the places up again.' }); }
    $('lookup').open = true; lookupSay('');
    needsLine($('lookup-permission'), svc);
    $('lookup-permission').querySelector('button')?.focus();
    return;
  }
  if (svc.whg && !token.get()) { $('lookup').open = true; lookupSay(LW.needToken, true); $('whg-token').focus(); return; }
  const g = await gatherPlaces();
  const places = g?.places ?? null;
  const existing = reviewWork();
  if (!existing && !g?.subjects) return lookupSay(readable(input) ? LW.placesNotRead : LW.noDataset, true);
  // A name typed for one place is sent instead of its label, and what it finds is added beside the place's candidates (runLookup's query).
  const opts = lookupOptions({ ...(which ? { places: which } : {}), ...(only ? { places: 'all', only } : {}), ...(allNames !== undefined ? { allNames } : {}), ...(only && query ? { query } : {}) });
  let lookup;
  // Another service's candidates' addresses: by the template given, else by its manifest's view.url (read below).
  const template = { template: svc.template ?? null };
  try {
    // WHG's is the shared lookup, which already has the token (passToken); another service is sent none.
    lookup = svc.whg ? whgLookup() : createLookup({ endpoint: svc.service.endpoint, token: null, shared: false, iri: iriVia(template), fetch: gazetteerFetch });
  } catch (e) { return lookupSay(scrub(e.message), true); }
  const w = existing || newWork(g.subjects, { reviewer: reviewer() });
  // Krisis: region review. A plain lookup seeds no regions: they are seeded when the region review is begun
  // (startRegions), so a place looked up here is never shown waiting for regions it was not looked up within.
  const name = existing ? workName : `${(files[0]?.name || 'review').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '')}.krisis.json`;
  const before = new Set(w.candidates.map((c) => c.id));
  const service = shortName(svc.service);
  looking = new AbortController();
  afterStop = null;
  if (!only) methodos.began({ op: 'lookup', files });   // Methodos: a whole lookup is the lookup step's run; one place's is not
  $('lookup-send').disabled = true; $('lookup-stop').hidden = false; $('lookup-resume').hidden = true;
  buttons(true);   // as while the worker runs: Match, Check, Resume and the rest would take the review away under the lookup
  lookupSay(LW.sending(service));
  lookupState({ running: true, done: 0, total: null, stopped: null, summary: null, single: !!only });
  const show = () => { bulkPlan = null; if (work !== w || $('review').hidden) beginReview(w, name, { focus: false }); else { reorder(); render(false); } };
  let result = null, fault = false, settings = null;
  if (!svc.whg) {
    // Its type, and its address template unless one was given, from its manifest (asked for without a token).
    try { settings = await manifestSettings(lookup, { signal: looking.signal }); } catch { settings = null; }
    if (settings?.read) manifests.set(svc.service.endpoint, settings);
    if (settings?.template && !template.template) template.template = settings.template;
  }
  try {
    result = await runLookup({ lookup, work: w, places, options: { ...opts, service: svc.service, ...(settings?.type ? { type: settings.type } : {}) }, signal: looking.signal,
      onBatch: ({ done, total }) => { lookupSay(LW.progress({ done, total }, service)); lookupState({ done, total }); show(); } });
  } catch (e) {
    fault = true;
    console.error('Krisis lookup:', scrub(e?.stack || e?.message || e));
  } finally {
    looking = null;
    $('lookup-stop').hidden = true;
    buttons(busy);
  }
  show();
  const stopped = fault ? { kind: 'fault', message: null } : result.stopped;
  // Methodos: the lookup's work, as a file, is the step's result; stopped part-way, it is what the step had done.
  if (!only) {
    const made = new File([serialiseWork(w)], name, { type: 'application/json' });
    if (!stopped) methodos.ended({ op: 'lookup', work: made, report: { errors: 0, items: [] } });
    else if (stopped.kind === 'stopped') methodos.ended({ op: 'lookup', cancelled: true, partial: made });
    else if (stopped.kind === 'permission') methodos.ended({ op: 'lookup', waiting: 'the gazetteer to be allowed in the Permissions panel; then look the places up again.' });
    else methodos.ended({ op: 'lookup', error: LOOKUP_WORDS.stopped(stopped), partial: made });
  }
  const said = [];
  if (settings && !settings.read) said.push(LOOKUP_WORDS.noManifest);
  if (result) { const sum = LOOKUP_WORDS.summary(result.record.counts, svc.service.title); said.push(sum.problems, sum.counted); }
  // A stop's message is the gazetteer module's, which it has cleaned of the token.
  if (stopped) said.push(LOOKUP_WORDS.stopped(stopped), LW.kept);
  lookupSay(said.join(' '), !!stopped);
  lookupState({ running: false, stopped: stopped?.kind || null, summary: said.join(' '), counts: result?.record.counts || null });
  fillChoices();
  if (stopped && stopped.kind !== 'fault') offerResume(svc);
  await refreshPreview();
  if (stopped?.kind === 'auth') { $('lookup').open = true; $('whg-token').focus(); }   // a field in a closed panel cannot take the focus
  // After one place's lookup, the focus goes to the first new candidate, if any.
  if (only && order[cursor] && only.includes(order[cursor])) {
    const fresh = candidatesOf(work, order[cursor]).findIndex((c) => !before.has(c.id));
    if (fresh >= 0) { current = fresh; render(false); $('review-place').querySelector(`li.candidate[data-id="${CSS.escape(candidatesOf(work, order[cursor])[fresh].id)}"]`)?.focus(); }
  }
}
/**
 * After a stop: Resume takes the places not yet answered, with the same settings. It is shown only while
 * the permission allows a lookup (after a 'permission' stop, not until it is allowed again: called again
 * on every change of permission), so that it is never a button that does nothing.
 */
async function offerResume(svc) {
  const g = await gatherPlaces();
  if (looking) return;   // Send pressed while the places were gathered: Resume stays hidden during the run
  const p = planFor(svc, lookupOptions({ places: 'pending' }), g?.places ?? null).preview;
  const b = $('lookup-resume');
  if (!p.queries) { b.hidden = true; return; }
  afterStop = true;
  b.textContent = LW.resume(p.queries); b.hidden = !mayLookUp(svc);
}
function commitToken() {
  const f = $('whg-token');
  if (!f.value.trim()) return;
  token.set(f.value);
  f.value = '';   // the token is kept by its keeper only, not in the field
}

// Places and candidates on the review screen.
/** The latest lookup's word on a place, or null if it was never looked up. */
function lastQuery(iri) {
  let found = null;
  for (const l of work.lookups || []) if (l.queries[iri]) found = { l, q: l.queries[iri] };
  return found;
}
function lookupPlaceHtml(iri, place) {
  const svc = lookupService(), service = svc.problem ? LW.whg : shortName(svc.service), last = lastQuery(iri);
  const cands = candidatesOf(work, iri).filter((c) => c.lookup && lookupOf(c.lookup)?.service.endpoint === last?.l.service.endpoint);
  // Not allowed (or not decided): no button that would send, and in their place the module's one line,
  // drawn by drawPermission() once the place is on screen. (A service mistyped says so when Find is pressed.)
  const may = !!svc.problem || mayLookUp(svc);
  let out = '';
  if (last && !(last.q.state === 'answered' && cands.length)) {
    out += `<p class="lookup-state${last.q.state === 'answered' ? '' : ' warn'}">${escapeHtml(LW.state(shortName(last.l.service), last.q))}</p>`;
    const others = [...new Set((place.names || []).filter((n) => n && n.trim().toLowerCase() !== (place.label || '').trim().toLowerCase()))];
    if (may && last.q.state === 'answered' && !last.q.found && last.q.sent.length === 1 && others.length) out += `<button type="button" data-look="names">${escapeHtml(LW.tryNames(1 + others.length))}</button> `;
    if (may && last.q.state !== 'answered') out += `<button type="button" data-look="again">${escapeHtml(LW.again)}</button> `;
  }
  if (!may) return `<div class="find">${out}<p class="lookup-permission"></p></div>`;
  out += `<button type="button" data-look="find">${escapeHtml(LW.find(service))}</button>`;
  if (findFor === iri) {
    out += `<form class="find-form" data-for="${escapeHtml(iri)}"><label for="find-query">${escapeHtml(LW.findLabel)}</label>`
      + `<input id="find-query" type="text" value="${escapeHtml(place.label || '')}" autocomplete="off" spellcheck="false">`
      + `<button type="submit" class="primary">${escapeHtml(LW.findSend)}</button><button type="button" data-look="cancel">Cancel</button></form>`;
  }
  return `<div class="find">${out}</div>`;
}
/** The module's one line on the review screen, where lookupPlaceHtml() left room for it. */
function drawPermission() {
  const el = $('review-place').querySelector('.find .lookup-permission');
  if (el) needsLine(el, lookupService());
}
/** Candidates grouped by where they came from, each group in the order it was ranked in (never by name). */
function groupedHtml(cands) {
  const groups = [];
  cands.forEach((c, i) => {
    const l = c.lookup ? lookupOf(c.lookup) : null, key = l ? l.service.endpoint : '';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, title: l ? LW.from(l.service.title) : LW.fromOthers(work.others?.title || c.other?.source?.title || ''), items: [] });
    g.items.push(candidateHtml(c, i));
  });
  // A place with none, that a lookup has had its word on (not found, not answered), says only that.
  if (!cands.length && lastQuery(order[cursor])) return '';
  return `<p>${escapeHtml(LW.candidates(cands.length))}</p>`
    + groups.map((g) => `<section class="source-group" aria-label="${escapeHtml(g.title)}"><h4 class="source">${escapeHtml(g.title)}</h4><ol class="candidates">${g.items.join('')}</ol></section>`).join('');
}
/** What a looked-up candidate adds: far or not, the service's own figures (as its own), and its source's licence. */
function gazetteerHtml(c) {
  const l = lookupOf(c.lookup), g = c.gazetteer || {}, service = l ? shortName(l.service) : LW.whg;
  const km = l?.parameters?.maxDistanceKm ?? 50;
  const lic = licenceOf(l?.attribution ?? null, g.namespace ?? null);
  return (c.far ? `<p class="far">${escapeHtml(LW.far(km))}</p>` : '')
    + (LW.figures(g, service) ? `<p class="gazetteer">${escapeHtml(LW.figures(g, service))}</p>` : '')
    + (g.description ? `<p class="gazetteer">${escapeHtml(LW.described(service, g.description))}</p>` : '')
    + `<p class="licence${LW.licenceWarns(lic) ? ' warn' : ''}">${escapeHtml(LW.licence(lic))}</p>`;
}
/** The sources the attestations would cite, one per source (identity.js candidateSource, as Finish uses). */
function citedSources() {
  const out = new Map();
  for (const c of work.candidates) {
    if (!c.decision || c.decision.kind === 'not-this') continue;
    const s = candidateSource(work, c);
    out.set(s.title + '\n' + (s['@id'] || ''), s);
  }
  return [...out.values()];
}

$('review-place').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-look]'); if (!b) return;
  const iri = order[cursor], look = b.dataset.look;
  if (look === 'find') { findFor = iri; basisFor = null; render(); }
  else if (look === 'cancel') { findFor = null; render(true); }
  else if (look === 'names') lookUp({ only: [iri], allNames: true });
  else if (look === 'again') lookUp({ only: [iri] });
});
$('review-place').addEventListener('submit', (e) => {
  if (!e.target.matches('form.find-form')) return;
  e.preventDefault();
  const query = $('find-query').value.trim(), iri = order[cursor];
  if (!query) return $('find-query').focus();
  findFor = null;
  lookUp({ only: [iri], query });
});
$('lookup').addEventListener('toggle', () => { if ($('lookup').open) { fillChoices(); refreshPreview(); } });
$('lookup').addEventListener('change', (e) => {
  if (e.target.id === 'whg-token') return commitToken();
  if (e.target.name === 'lookup-service') document.querySelector('.lookup-other').hidden = e.target.value !== 'other';
  refreshPreview();
});
$('lookup').addEventListener('input', (e) => { if (e.target.type === 'number' || e.target.type === 'url' || e.target.id === 'lookup-iri') refreshPreview(); });
// Forget: the shared lookup sends no token from its next request, and the keeper forgets it.
$('whg-forget').onclick = () => { $('whg-token').value = ''; whgLookup().clearToken(); token.forget(); lookupSay(LW.forgotten); };
// A token given or forgotten (here, in the Permissions panel, or in another tab) goes to the shared lookup.
token.onChange(() => { showTokenState(); passToken(); });
// A permission allowed or withdrawn (in the panel, or another tab): Send, and the review screen's buttons, follow.
permissions.onChange(() => {
  if (looking) return;
  refreshPreview();
  if (afterStop) { const svc = lookupService(); if (mayLookUp(svc)) offerResume(svc); else $('lookup-resume').hidden = true; }
  if (work && !$('review').hidden && order.length) render(false);
});
showTokenState();
passToken();
$('lookup-send').onclick = () => lookUp();
$('lookup-variants-text').textContent = VW.option;
$('lookup-stop').onclick = () => looking?.abort();
$('lookup-resume').onclick = () => { $('lookup-resume').hidden = true; if (afterStop) lookUp({ which: 'pending' }); };
// Krisis: region review (Methodos #28, stages 3 and 4). The regions a table's places lie in (Hermes's
// "within" columns) are looked up level by level from the widest, each within the match of the region
// above (lookup.js runLevel, through the shared WHG lookup and the permissions module, as the lookup
// above is); then the places within their regions (runPlaces). What is shown is worked out by
// src/krisis/region-page.js from the work object, which every decision changes at once. A change to a
// settled region that would clear what lies below it is asked on the page first, and can be undone.
let regionLevel = null, regionChange = null, regionCleared = null, regionStatus = null;
const regionShown = new Map();   // how many regions of each level are shown
const REGION_PAGE_SIZE = 25;
const whgService = () => ({ service: serviceOf(WHG_ENDPOINT), whg: true });
const hasRegions = () => !!work && Object.keys(work.regions || {}).length > 0;
const regionNames = () => levelNames(columns?.levels || {});
const freshPlaces = () => (gathered && gathered.files === files ? gathered.places : null);
const batchSize = () => whgLookup().batchSize ?? 25;
function regionSay(text, warn = false) { regionStatus = text ? { text, warn } : null; }

/** The lookup panel's offer of a region review, once the dataset is read and gives regions. */
function showRegionOffer(g) {
  const box = $('regions-offer'), n = g?.regions?.length || 0;
  box.hidden = !n || (hasRegions() && !$('review').hidden);
  if (box.hidden) return;
  const levels = new Set(g.regions.map((r) => r.level)).size;
  $('regions-offer-text').textContent = RP.offer(n, levels);
  $('regions-start').textContent = RP.start;
}
/** Begin the region review: the dataset's regions into the review on screen, or into a new one. */
async function startRegions() {
  if (busy || looking) return;
  // Asked twice: a reading already under way (begun with other columns or another base address) is
  // awaited first, and the second call reads again only if what it was read with has changed since.
  await gatherPlaces();
  const g = await gatherPlaces();
  if (!g?.regions?.length) return lookupSay(g?.subjects ? RP.noRegions : readable(input) ? LW.placesNotRead : LW.noDataset, true);
  const existing = reviewWork();
  const w = existing || newWork(g.subjects, { reviewer: reviewer() });
  seedRegions(w, g);
  regionLevel = firstOpen(w); regionChange = null; regionCleared = null; regionSay('');
  if (existing) render(false);
  else beginReview(w, `${(files[0]?.name || 'review').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '')}.krisis.json`, { focus: false });
  $('regions-offer').hidden = true;
  $('regions-h').focus();
}

/** The region review, drawn again from the work object: the navigator, the level chosen (or the places), the confirmation and the status line. */
function drawRegions() {
  const box = $('regions');
  if (!hasRegions()) { box.hidden = true; state.regions = null; return; }
  box.hidden = false;
  $('regions-h').textContent = RP.heading; $('regions-how').textContent = RP.how;
  $('region-identity-label').textContent = RP.identityLabel;
  $('region-certainty-label').textContent = RP.certaintyLabel;
  const names = regionNames(), nav = levelNavigator(work, names);
  if (regionLevel === null || !nav.some((n) => n.level === regionLevel)) regionLevel = firstOpen(work);
  const navBox = $('regions-nav');
  navBox.setAttribute('aria-label', RP.nav.label);
  navBox.innerHTML = nav.map((n) => `<button type="button" class="region-level" data-rlevel="${n.level}" aria-pressed="${n.level === regionLevel}">${escapeHtml(n.text)}</button>`).join('<span class="sep" aria-hidden="true">·</span>');
  const svc = whgService(), may = mayLookUp(svc);
  needsLine($('regions-permission'), svc);
  const cf = $('regions-confirm');
  cf.hidden = !regionChange;
  cf.innerHTML = regionChange ? `<p>${escapeHtml(RP.confirm(regionChange.counts.decisions, regionChange.counts.candidates, nameOf(work, regionChange.key)))}</p>`
    + `<button type="button" class="primary" data-rconfirm="yes">${escapeHtml(RP.confirmYes)}</button> <button type="button" data-rconfirm="no">${escapeHtml(RP.confirmNo)}</button>` : '';
  const st = $('regions-status');
  st.innerHTML = regionStatus ? `<span${regionStatus.warn ? ' class="warn"' : ''}>${escapeHtml(regionStatus.text)}</span>` + (regionCleared ? ` <button type="button" data-rundo="1">${escapeHtml(RP.undo)}</button>` : '') : '';
  $('regions-stop').textContent = RP.stop; $('regions-stop').hidden = !looking;
  $('regions-level').innerHTML = regionLevel === 'places' ? placesLevelHtml(may) : levelHtml(regionLevel, names, may);
  state.regions = { level: regionLevel, nav: nav.map((n) => n.text), confirm: regionChange ? cf.querySelector('p').textContent : null, status: regionStatus?.text ?? null, undo: !!regionCleared };
}
const off = () => (busy || looking ? ' disabled' : '');
const costed = (text, keys, opts = {}) => { const c = costOf(work, keys, { batchSize: batchSize(), ...opts }); return RP.cost(text, c, c.fetches); };
function relaxButtons(keys, scope) {
  return relaxOptions(work, keys).map((o) => `<button type="button" data-rrelax="${o.relax}" data-rscope="${scope}"${off()}>${escapeHtml(costed(o.text, keys, { relax: o.relax }))}</button>`).join(' ');
}
function levelHtml(level, names, may) {
  const name = levelLabel(level, names), nodes = levelRegions(work, level), ready = selectLevel(work, level).map((n) => n.key), unsettled = unsettledOf(work, level);
  let out = `<h4 class="region-level-name">${escapeHtml(name)}</h4>`;
  if (may) {
    out += ready.length ? `<p><button type="button" class="primary" data-rgo="level"${off()}>${escapeHtml(costed(RP.lookLevel(name, ready.length), ready))}</button></p>` : `<p class="note">${escapeHtml(RP.noneReady(name))}</p>`;
    const relax = unsettled.length ? relaxButtons(unsettled, 'level') : '';
    if (relax) out += `<div class="region-relax"><p>${escapeHtml(RP.relaxLevel(name, unsettled.length))}</p>${relax}</div>`;
  }
  const shown = regionShown.get(level) || REGION_PAGE_SIZE;
  out += nodes.slice(0, shown).map((n) => regionHtml(n, may)).join('');
  if (nodes.length > shown) out += `<p><button type="button" data-rmore="1">${escapeHtml(RP.more(Math.min(REGION_PAGE_SIZE, nodes.length - shown)))}</button></p>`;
  return out;
}
function regionHtml(n, may) {
  const key = n.key, k = escapeHtml(key), cands = candidatesOf(work, key), st = n.state, settled = st === 'settled';
  const hid = regionDomId(key);
  let out = `<article class="region region-${st}" data-rkey="${k}" tabindex="-1" aria-labelledby="${hid}"><h5 id="${hid}">${escapeHtml(n.names[0])}</h5>`
    + `<p class="region-where">${escapeHtml(chainOf(work, key))} · ${escapeHtml(RP.places(n.count))} · <span class="region-state">${escapeHtml(RP.states[st])}</span></p>`;
  if (st === 'locked') return out + '</article>';
  out += `<p class="region-constraint">${escapeHtml(constraintLine(work, key))}</p>`;
  out += notesOf(work, key).map((x) => `<p class="region-note${x.kind === 'union' ? '' : ' warn'}" data-note="${x.kind}">${escapeHtml(x.text)}</p>`).join('');
  if (settled && work.regions[key].outcome === 'no-match') out += `<p class="region-none">${escapeHtml(RP.settledNone)}</p><button type="button" data-ract="reopen"${off()}>${escapeHtml(RP.buttons.reopen)}</button>`;
  if (cands.length) {
    out += `<p>${escapeHtml(RP.candidates(cands.length))}</p><ol class="candidates">` + cands.map((c) => {
      const o = c.other || {}, d = c.decision, id = escapeHtml(c.id);
      const btn = (act, text) => `<button type="button" data-ract="${act}" data-rcand="${id}" aria-pressed="${d?.kind === act}"${off()}>${escapeHtml(text)}</button>`;
      return `<li class="candidate${d ? ' decided' : ''}" data-id="${id}"><h6>${escapeHtml(o.label || c.candidate_candidate)}</h6>`
        + (W.names(o.label, o.names) ? `<p>${escapeHtml(W.names(o.label, o.names))}</p>` : '')
        + (c.lookup ? gazetteerHtml(c) : '') + `<p class="iri">${escapeHtml(c.candidate_candidate)}</p>`
        + `<p class="decision">${escapeHtml(d ? RP.decided[d.kind] || W.decision(d) : W.decision(d))}</p>`
        + `<div class="acts">${btn('match', RP.buttons.match)}${btn('not-this', RP.buttons.notThis)}${d ? `<button type="button" data-ract="undo" data-rcand="${id}"${off()}>${escapeHtml(RP.buttons.undo)}</button>` : ''}</div></li>`;
    }).join('') + '</ol>';
  } else if (lastQueryOf(work, key)?.state === 'answered' && !lastQueryOf(work, key).stale) out += `<p>${escapeHtml(RP.candidates(0))}</p>`;
  if (!settled) out += `<div class="acts"><button type="button" data-ract="none"${off()}>${escapeHtml(RP.buttons.none)}</button> <button type="button" data-ract="skip">${escapeHtml(RP.buttons.skip)}</button></div>`;
  if (may && (st === 'ready' || st === 'review')) {
    if (st === 'ready') out += `<p><button type="button" data-rgo="one"${off()}>${escapeHtml(costed(RP.lookOne, [key]))}</button></p>`;
    const relax = relaxButtons([key], 'one');
    if (relax) out += `<div class="region-relax"><p>${escapeHtml(RP.relaxOne)}</p>${relax}</div>`;
  }
  return out + '</article>';
}
function placesLevelHtml(may) {
  const places = freshPlaces(), ready = placesToLook(work, { places }), locked = lockedPlaces(work), names = regionNames();
  let out = `<h4 class="region-level-name">${escapeHtml(RP.placesHeading)}</h4><p class="note">${escapeHtml(RP.placesHow)}</p>`;
  if (may) out += ready.length ? `<p><button type="button" class="primary" data-rgo="places"${off()}>${escapeHtml(costed(RP.lookPlaces(ready.length), ready, { places }))}</button></p>` : `<p class="note">${escapeHtml(RP.noPlacesReady)}</p>`;
  if (locked.length) {
    out += `<p>${escapeHtml(RP.locked(locked.length))}</p><ul class="region-locked">` + locked.slice(0, 20).map((p) => `<li data-place="${escapeHtml(p.iri)}">${escapeHtml(p.label)}: `
      + `${escapeHtml(RP.lockedReason(nameOf(work, p.region), levelLabel(work.regions[p.region].level, names)))}`
      + (may ? ` <button type="button" data-runc="${escapeHtml(p.iri)}"${off()}>${escapeHtml(RP.unconstrained)}</button>` : '') + '</li>').join('') + '</ul>'
      + (locked.length > 20 ? `<p>${escapeHtml(RP.andMore(locked.length - 20))}</p>` : '')
      + (may ? `<p><button type="button" data-runc-all="1"${off()}>${escapeHtml(costed(RP.unconstrainedAll(locked.length), locked.map((p) => p.iri), { unconstrained: true, places }))}</button></p>` : '');
  }
  return out;
}
/** On the review screen of places: where the place lies, what it was looked up within, and the notes that go with it. */
function placeRegionHtml(iri, place) {
  if (!hasRegions() || typeof place.within !== 'string') return '';
  return `<p class="region-where">${escapeHtml(RP.placeWithin(placeChain(work, iri)))}</p>`
    + (lastQueryOf(work, iri) ? `<p class="region-constraint">${escapeHtml(constraintLine(work, iri))}</p>` + notesOf(work, iri).map((x) => `<p class="region-note warn" data-note="${x.kind}">${escapeHtml(x.text)}</p>`).join('') : '');
}
function focusRegion(key) { $('regions-level').querySelector(`[data-rkey="${CSS.escape(key)}"]`)?.focus({ preventScroll: false }); }

/**
 * Change a region's review: `act(work)` decides (decideRegion) or settles it (settleRegion) and gives
 * the snapshot of what it cleared. Tried on a copy first: a change that would clear decisions or
 * candidates below is asked on the page, never with window.confirm.
 */
function changeRegion(key, act) {
  regionChange = null;
  let counts;
  try { counts = wouldClear(work, act); } catch (e) { regionSay(e.message, true); return drawRegions(); }
  if (counts) { regionChange = { key, act, counts }; drawRegions(); $('regions-confirm').querySelector('[data-rconfirm="no"]')?.focus(); return; }
  commitRegion(key, act);
}
function commitRegion(key, act) {
  const prior = priorOf(work, key), snap = act(work);
  unsaved++;
  if (snap && (snap.counts.decisions || snap.counts.candidates)) { regionCleared = { key, snapshot: snap, prior }; regionSay(RP.cleared(snap.counts.decisions, snap.counts.candidates, nameOf(work, key))); }
  else { regionCleared = null; regionSay(''); }
  render(false); focusRegion(key);
}
/** Undo: what the change cleared (invalidate's snapshot, regions.js undo), and the change itself. */
function undoRegionChange() {
  const c = regionCleared; if (!c) return;
  undoRegion(work, c.snapshot); restorePrior(work, c.key, c.prior);
  regionCleared = null; unsaved++;
  regionSay(RP.undone(nameOf(work, c.key)));
  render(false); focusRegion(c.key);
}

/**
 * Look up a level's regions (runLevel) or the places within (runPlaces), as the command line's lookup
 * --levels does, with the same options: WHG's shared lookup, which the permissions module gates and
 * which has the token; the request size its own.
 */
async function regionRun(kind, { level, relax, only, unconstrained = false } = {}) {
  if (looking || busy || !work) return;
  if ($('whg-token').value.trim()) commitToken();
  const svc = whgService();
  // Methodos: looking up every place within its settled regions is the lookup step's run (one place's, or one unconstrained, is not).
  const whole = kind === 'places' && !only && !unconstrained;
  if (!mayLookUp(svc)) {
    // As the plain lookup: a workflow at its lookup waits for the permission, and says so.
    if (whole) { methodos.began({ op: 'lookup', files }); methodos.ended({ op: 'lookup', waiting: 'the gazetteer to be allowed in the Permissions panel; then look the places up again.' }); }
    drawRegions(); $('regions-permission').querySelector('button')?.focus(); return;
  }
  if (!token.get()) { $('lookup').open = true; lookupSay(LW.needToken, true); $('whg-token').focus(); return; }
  const g = kind === 'places' ? (await gatherPlaces(), await gatherPlaces()) : null;   // twice: as startRegions
  const w = work, service = LW.whg;
  looking = new AbortController();
  if (whole) methodos.began({ op: 'lookup', files });
  regionCleared = null; regionChange = null;
  buttons(true); $('lookup-stop').hidden = false;
  regionSay(LW.sending(service)); lookupSay(LW.sending(service));
  lookupState({ running: true, done: 0, total: null, stopped: null, summary: null, single: false, regions: kind === 'places' ? 'places' : level });
  drawRegions();
  const how = { lookup: whgLookup(), relax, only, options: { service: svc.service, maxDistanceKm: matchOptions().maxDistanceKm }, reviewer: reviewer(), signal: looking.signal,
    onBatch: ({ done, total }) => { regionSay(LW.progress({ done, total }, service)); lookupState({ done, total }); if (work === w) render(false); } };
  let result = null, fault = false;
  try { result = kind === 'places' ? await runPlaces(w, { ...how, places: g?.places ?? null, unconstrained }) : await runLevel(w, level, how); }
  catch (e) { fault = true; console.error('Krisis region lookup:', scrub(e?.stack || e?.message || e)); }
  finally { looking = null; $('lookup-stop').hidden = true; buttons(busy); }
  unsaved++;
  const stopped = fault ? { kind: 'fault', message: null } : result.stopped;
  const said = [];
  if (result && !result.record) said.push(REGION_WORDS.nothingReady);
  else if (result) { const sum = LOOKUP_WORDS.summary(result.record.counts, svc.service.title); said.push(REGION_WORDS.ran(kind === 'places' ? 'places' : level, result.looked.length, result.record.counts.failedClosed || 0), sum.problems); }
  if (stopped) said.push(LOOKUP_WORDS.stopped(stopped), LW.kept);
  regionSay(said.join(' '), !!stopped); lookupSay(said.join(' '), !!stopped);
  if (whole) {
    const made = new File([serialiseWork(w)], workName, { type: 'application/json' });
    if (!stopped) methodos.ended({ op: 'lookup', work: made, report: { errors: 0, items: [] } });
    else if (stopped.kind === 'stopped') methodos.ended({ op: 'lookup', cancelled: true, partial: made });
    else if (stopped.kind === 'permission') methodos.ended({ op: 'lookup', waiting: 'the gazetteer to be allowed in the Permissions panel; then look the places up again.' });
    else methodos.ended({ op: 'lookup', error: LOOKUP_WORDS.stopped(stopped), partial: made });
  }
  lookupState({ running: false, stopped: stopped?.kind || null, summary: said.join(' '), counts: result?.record?.counts || null, looked: result?.looked || [] });
  if (work === w) { reorder(); render(false); }
  if (stopped?.kind === 'auth') { $('lookup').open = true; $('whg-token').focus(); }
  else if (only?.length === 1 && kind !== 'places') focusRegion(only[0]);
}

$('regions-start').onclick = () => startRegions();
$('regions-stop').onclick = () => looking?.abort();
$('regions').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.rlevel !== undefined) { regionLevel = d.rlevel === 'places' ? 'places' : Number(d.rlevel); regionChange = null; drawRegions(); $('regions-level').querySelector('[data-rkey], button')?.focus(); return; }
  if (d.rconfirm) { const ch = regionChange; regionChange = null; if (!ch) return; if (d.rconfirm === 'yes') commitRegion(ch.key, ch.act); else { drawRegions(); focusRegion(ch.key); } return; }
  if (d.rundo) return undoRegionChange();
  if (d.rmore) { regionShown.set(regionLevel, (regionShown.get(regionLevel) || REGION_PAGE_SIZE) + REGION_PAGE_SIZE); return drawRegions(); }
  if (busy || looking || !work) return;
  const art = b.closest('[data-rkey]'), key = art?.dataset.rkey;
  if (d.rgo === 'level') return regionRun('level', { level: regionLevel });
  if (d.rgo === 'one') return regionRun('level', { level: regionLevel, only: [key] });
  if (d.rrelax) return regionRun('level', { level: regionLevel, relax: d.rrelax, only: d.rscope === 'level' ? unsettledOf(work, regionLevel) : [key] });
  if (d.rgo === 'places') return regionRun('places');
  if (d.runc) return regionRun('places', { unconstrained: true, only: [d.runc] });
  if (d.runcAll) return regionRun('places', { unconstrained: true, only: lockedPlaces(work).map((p) => p.iri) });
  if (d.ract === 'skip') {
    const arts = [...$('regions-level').querySelectorAll('article.region:not(.region-settled):not(.region-locked)')];
    (arts[arts.indexOf(art) + 1] || arts[0])?.focus();
    return;
  }
  if (d.rcand) {
    const kind = d.ract === 'undo' ? null : d.ract, how = regionMatchOptions({ identityType: $('region-identity').value, certainty: $('region-certainty').value });
    return changeRegion(key, (w) => decideRegion(w, d.rcand, kind, kind === 'match' ? how : {}).snapshot);
  }
  if (d.ract === 'none') {
    if (matchesOf(work, key).length) { regionSay(RP.noneButMatched, true); return drawRegions(); }
    return changeRegion(key, (w) => settleRegion(w, key, 'no-match'));
  }
  if (d.ract === 'reopen') return changeRegion(key, (w) => settleRegion(w, key, null));
});
$('regions').addEventListener('keydown', (e) => { if (e.key === 'Escape' && regionChange) { const k = regionChange.key; regionChange = null; drawRegions(); focusRegion(k); } });
{ const sel = $('region-identity'); sel.innerHTML = ['closeMatch', 'exactMatch'].map((t) => `<option value="${t}">${escapeHtml(RP.identity[t])}</option>`).join(''); }
{ const sel = $('region-certainty'); sel.innerHTML = certaintyChoices().map((c) => `<option value="${c.value}"${c.value === CERTAINTY_DEFAULT ? ' selected' : ''}>${escapeHtml(c.text)}</option>`).join(''); }
startWorker();
