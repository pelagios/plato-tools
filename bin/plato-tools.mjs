#!/usr/bin/env node
// The command line: check and convert PLATO data in batch, and compare two versions of a dataset,
// with the engine the browser uses (src/engine/pipeline.js, src/engine/compare.js), hosted in Node
// by src/node/host.js. Exit status: 0 when no input has problems, 1 when any has, 2 when the command
// is wrong or an input cannot be read or written.

// Node's built-in SQLite announces itself as experimental on every run; that says nothing about
// the data, so it is left out. Every other warning is still shown.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};

const { parseArgs } = await import('node:util');
const { readFileSync } = await import('node:fs');
const { run, TARGETS, DEFAULT_TABLE_BASE } = await import('../src/engine/pipeline.js');
const { compare } = await import('../src/engine/compare.js');
const { detect } = await import('../src/engine/input.js');
const { nodeResources, gatherInputs, openFiles, isSystemError, NodeHost } = await import('../src/node/host.js');
const { fmtBytes, fmtTime, formatName, progressText, summary, groups, draftNote, explainedLines } = await import('../src/engine/words.js');

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `plato-tools: check and convert PLATO data, and compare versions of it, from the command line.

Usage:
  plato-tools check [options] INPUT...
  plato-tools convert --to TARGET [--out DIR] [options] INPUT...
  plato-tools compare [options] EARLIER LATER
                                            check that a published dataset was only added to:
                                            every attestation of the EARLIER version must be in
                                            the LATER one, unchanged (PLATO's append-only rule)
  plato-tools datacube [--json] FILE...     check a cube export (convert --to ntriples --cube)
                                            against the RDF Data Cube integrity constraints IC-1,
                                            IC-2, IC-11, IC-12 and IC-14

Each INPUT is one file, or one set of spreadsheet tables:
  - a directory is one set of tables, made of the CSV files in it;
  - CSV files named one by one are one set of tables per directory they are in;
  - a zip of the CSV files, or a workbook (.xlsx), is one set of tables.
Everything else is read as the format it turns out to be: PLATO JSON or JSON Lines, RDF
(N-Triples, N-Quads, Turtle), Linked Places Format v1, or W3C Web Annotations as Recogito exports
them (read only). Gzipped files are read directly.

Targets for --to:
${Object.entries(TARGETS).map(([k, v]) => `  ${k.padEnd(12)} ${v.label}`).join('\n')}

Options:
  --to TARGET       convert: the format to write (required).
  --out DIR         convert: where to write the outputs (default: the current directory).
                    Each output is named after its input; an existing file is never replaced
                    unless --overwrite is given.
  --overwrite       convert: replace outputs that already exist.
  --base URL        spreadsheet tables: the web address under which the identifiers of the
                    places and sources are made (default: the about sheet's base_uri, or
                    ${DEFAULT_TABLE_BASE} without one). Given, it is used instead of
                    base_uri, with a warning if they differ.
  --no-typing       N-Triples output: leave out the node types and typed dates that the DEEP RDF
                    export adds (they are added by default, as in the browser).
  --cube            N-Triples output: also write what the RDF Data Cube vocabulary expects of
                    each figure from a statistical table: its qb:Observation type,
                    the measure as a direct statement, sdmx-dimension:refArea and refPeriod,
                    and the types of its table and structure. Without it, the plain PLATO graph.
  --work-dir DIR    where the working database for RDF and attestation-centric input is kept
                    while it is in use (default: the system's temporary directory). It needs
                    room for about 1.5 times the uncompressed input; it is removed afterwards.
  --json            print one JSON object per input, one per line, then one for the total.
  --brief           print one line per input and the total, without the details.
  -h, --help        show this help.
  -V, --version     show the version, and the PLATO commit the checks follow.

Exit status: 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
cannot be read or written. Warnings, and what a conversion cannot carry over, do not count
as problems. For compare: 0 if nothing was deleted or changed, 1 if something was, 2 if the
versions could not be compared.
`;

function usage(message) {
  process.stderr.write(`plato-tools: ${message}\nRun "plato-tools --help" for how to use it.\n`);
  return 2;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, allowNegative: true, strict: true,
      options: {
        to: { type: 'string' }, out: { type: 'string', default: '.' }, overwrite: { type: 'boolean', default: false },
        base: { type: 'string' }, typing: { type: 'boolean', default: true }, cube: { type: 'boolean', default: false },
        'work-dir': { type: 'string' }, json: { type: 'boolean', default: false }, brief: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (e) { return usage(e.message); }
  const { values: o, positionals } = parsed;
  if (o.help) { process.stdout.write(HELP); return 0; }
  const resources = await nodeResources();
  if (o.version) {
    const v = resources.version;
    process.stdout.write(`plato-tools ${PKG.version}, checking against PLATO ${v.versionInfo} at ${v.commit}${v.draft ? ` (${draftNote(v)})` : ''}\n`);
    return 0;
  }
  const [action, ...args] = positionals;
  if (!action) return usage('say what to do: check, convert or compare.');
  if (action === 'datacube') return datacube(args, o);
  if (action !== 'check' && action !== 'convert' && action !== 'compare') return usage(`"${action}" is not a command; the commands are check, convert, compare and datacube.`);
  if (!args.length) return usage(`name at least one input to ${action}.`);
  if (action === 'convert' && !o.to) return usage(`convert needs --to, one of: ${Object.keys(TARGETS).join(', ')}.`);
  if (action === 'convert' && !TARGETS[o.to]) return usage(`"${o.to}" is not a target; the targets are ${Object.keys(TARGETS).join(', ')}.`);
  if (action !== 'convert' && (o.to || o.overwrite)) return usage('--to and --overwrite are for convert.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  if (o.cube && o.to !== 'ntriples') return usage('--cube is for convert --to ntriples.');

  const host = new NodeHost({ workDir: o['work-dir'], outDir: o.out, overwrite: o.overwrite });
  const stop = (signal) => {
    const removed = host.abandon();
    process.stderr.write(`\nplato-tools: stopped (${signal}); the working files${removed.length ? `, and the incomplete ${removed.join(', ')},` : ''} are removed.\n`);
    process.exit(130);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // Output piped into something that stops reading (head, say): stop too, and tidy up.
  process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; host.cleanup(); process.exit(process.exitCode ?? 0); });
  const out = (s) => process.stdout.write(s);
  const live = process.stderr.isTTY && !o.json;
  const results = [];
  if (action === 'compare') {
    const items = await gatherInputs(args);
    if (items.length !== 2) return usage(`compare takes two inputs, the earlier version and then the later one; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
    let r;
    try { r = await compareTwo(items, o, resources, host, live); } finally { host.cleanup(); }
    r.exitCode = r.status === 'failed' ? 2 : r.status === 'problems' ? 1 : 0;
    out(o.json ? JSON.stringify(r) + '\n' : describeComparison(r, o.brief));
    return r.exitCode;
  }
  try {
    for (const item of await gatherInputs(args)) {
      const r = await runOne(item, action, o, resources, host, live);
      results.push(r);
      out(o.json ? JSON.stringify(r) + '\n' : describe(r, action, o.brief));
    }
  } finally { host.cleanup(); }

  const total = {
    type: 'total', action, target: action === 'convert' ? o.to : null, inputs: results.length,
    ok: results.filter((r) => r.status === 'ok').length, problems: results.filter((r) => r.status === 'problems').length,
    failed: results.filter((r) => r.status === 'failed').length, errors: results.reduce((n, r) => n + (r.errors || 0), 0),
    outputs: results.reduce((n, r) => n + r.outputs.length, 0), outputBytes: results.reduce((n, r) => n + r.outputs.reduce((m, x) => m + x.size, 0), 0),
  };
  total.exitCode = total.failed ? 2 : total.problems ? 1 : 0;
  out(o.json ? JSON.stringify(total) + '\n' : describeTotal(total));
  return total.exitCode;
}

/** A thrown error that is not the data's: said to be the tools' fault, with where it happened. */
function toolsFault(e) {
  const where = String(e && e.stack || '').split('\n').find((l) => /\/src\//.test(l))?.trim().replace(/^at\s+/, '') || '';
  return `PLATO tools failed on this input, which is a fault in the tools, not in the data: ${e && e.message || e}${where ? ` (${where})` : ''}. Please report it at https://github.com/pelagios/plato-tools/issues.`;
}

/** Open one input and find what it is: { input }, or { message } saying why it cannot be read. */
async function readInput(item) {
  if (item.failure) return { message: item.failure };
  let input;
  try { input = await detect(await openFiles(item.paths)); }
  catch (e) {
    if (isSystemError(e)) return { message: e.message };
    // Detection turns what the data does wrong into a reason itself; anything thrown is the tools' own fault.
    return { message: toolsFault(e) };
  }
  return input.format ? { input } : { message: input.reason };
}

/** Compare two versions, and say how it went, as an object that --json prints as it is. */
async function compareTwo(items, o, resources, host, live) {
  const t0 = Date.now();
  const r = { type: 'comparison', earlier: null, later: null, status: 'failed', errors: 0, counts: {}, items: [], elapsedMs: 0 };
  const inputs = [];
  for (const [word, item] of [['earlier', items[0]], ['later', items[1]]]) {
    r[word] = { input: item.label, files: item.paths, format: null, profile: null };
    const { input, message } = await readInput(item);
    if (!input) { r.message = `${item.label}: ${message}`; r.elapsedMs = Date.now() - t0; return r; }
    Object.assign(r[word], { format: input.format, profile: input.profile || null });
    inputs.push(input);
  }
  const progress = live ? (p) => process.stderr.write(`\r\x1b[K${progressText(p)}`) : undefined;
  const xlsx = inputs.some((i) => i.container === 'workbook') ? await import('xlsx') : undefined;
  const { env, finish } = host.env(resources, { progress, xlsx });
  let result = null, failure = null;
  try { result = await compare({ earlier: inputs[0], later: inputs[1], options: { base: o.base } }, env); }
  catch (e) { failure = e; }
  if (live) process.stderr.write('\r\x1b[K');
  finish(true);
  r.elapsedMs = Date.now() - t0;
  if (failure) { r.message = isSystemError(failure) ? failure.message : toolsFault(failure); return r; }
  // A version that could not be read to the end was not compared: that is a failure to compare, not a
  // finding about the rule, though the report says what stopped the reader.
  Object.assign(r, { status: result.incomplete ? 'failed' : result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items });
  return r;
}
function describeComparison(r, brief) {
  const side = (word, s) => `${word} ${s.input}${s.format ? `: ${formatName(s)}` : ''}\n`;
  const lines = [side('Earlier:', r.earlier) + (r.later ? side('Later:  ', r.later) : '').replace(/\n$/, '')];
  if (r.message) lines.push(`  Could not be compared: ${r.message}`);
  else {
    const { problems, counted } = summary({ errors: r.errors, counts: r.counts }, 'compare');
    lines.push(`  ${problems}${counted ? ' ' + counted : ''} (${fmtTime(r.elapsedMs)})`);
    if (!brief) lines.push(...itemLines(r.items, 'compare'));
  }
  return lines.join('\n') + '\n';
}
/** A report's findings, group by group, as the lines the terminal shows. */
function itemLines(all, action) {
  const lines = [];
  for (const g of groups(action)) {
    const items = all.filter((i) => i.severity === g.severity);
    if (!items.length) continue;
    lines.push(`  ${g.title}. ${g.intro}`);
    for (const i of items) {
      lines.push(`    × ${i.count.toLocaleString('en-GB')}  ${i.message}`);
      for (const e of i.examples) {
        lines.push(`        ${String(e)}`);
        // The version check says what changed in an example: the statements only one version makes.
        for (const x of (i.explained || []).filter((x) => x.example === e)) for (const l of explainedLines(x)) lines.push(`            ${l}`);
      }
    }
  }
  return lines;
}

/** Check or convert one input, and say how it went, as an object that --json prints as it is. */
async function runOne(item, action, o, resources, host, live) {
  const t0 = Date.now();
  const r = { type: 'input', input: item.label, files: item.paths, format: null, profile: null, action, target: action === 'convert' ? o.to : null,
    status: 'failed', errors: 0, counts: {}, items: [], outputs: [], storeBytes: null, elapsedMs: 0 };
  const { input, message } = await readInput(item);
  if (!input) { r.message = message; r.elapsedMs = Date.now() - t0; return r; }
  r.format = input.format; r.profile = input.profile || null;
  if (input.lpfVersion) r.lpfVersion = input.lpfVersion;
  const progress = live ? (p) => process.stderr.write(`\r\x1b[K${item.label}: ${progressText(p)}`) : undefined;
  const xlsx = input.container === 'workbook' ? await import('xlsx') : undefined;
  const { env, finish } = host.env(resources, { progress, xlsx });
  let result = null, failure = null;
  try { result = await run({ input, action, target: r.target, options: { base: o.base, typing: o.typing, cube: o.cube, name: item.name } }, env); }
  catch (e) { failure = e; }
  if (live) process.stderr.write('\r\x1b[K');
  // A file the engine could not read to the end comes back as a report marked incomplete; any
  // output it had begun is removed, as after a failure.
  const done = finish(!!failure || !!result?.incomplete);
  r.storeBytes = done.storeBytes;
  r.elapsedMs = Date.now() - t0;
  if (failure && isSystemError(failure)) {
    r.message = failure.code === 'EEXIST' ? `${failure.path} already exists; give --overwrite to replace it, or --out for somewhere else.` : failure.message;
    return r;
  }
  if (failure) {
    // The engine turns a file that stops its reader (a DataError) into a report of its own, so what
    // reaches here is a fault in the tools, not in the data: it must not be presented as a problem in
    // the file. The input has failed, the exit status says so, and the error is shown as it is.
    r.message = toolsFault(failure) + (done.removed.length ? ` Nothing was written: ${done.removed.join(', ')} was removed, being incomplete.` : '');
    return r;
  }
  Object.assign(r, { status: result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items,
    outputs: result.outputs.map(({ path, size }) => ({ path, size })) });
  if (result.incomplete && done.removed.length) r.message = `Nothing was written: ${done.removed.join(', ')} was removed, being incomplete.`;
  return r;
}

function describe(r, action, brief) {
  const head = `${r.input}${r.format ? `: ${formatName(r)}` : ''}${r.status !== 'failed' ? ` (${fmtTime(r.elapsedMs)})` : ''}\n`;
  if (r.status === 'failed') return `${head}  Could not be ${action === 'check' ? 'checked' : 'converted'}: ${r.message}\n${brief ? '' : '\n'}`;
  const { problems, counted } = summary({ errors: r.errors, counts: r.counts });
  const lines = [head + `  ${problems}${counted ? ' ' + counted : ''}`];
  if (!brief) lines.push(...itemLines(r.items, action));
  if (r.message) lines.push(`  ${r.message}`);
  for (const x of r.outputs) lines.push(`  Wrote ${x.path} (${fmtBytes(x.size)})`);
  return lines.join('\n') + (brief ? '\n' : '\n\n');
}
function describeTotal(t) {
  const n = (k, one, many = one + 's') => `${k.toLocaleString('en-GB')} ${k === 1 ? one : many}`;
  const parts = [`${n(t.ok, 'without problems', 'without problems')}`, `${t.problems.toLocaleString('en-GB')} with problems${t.errors ? ` (${n(t.errors, 'problem')} in all)` : ''}`];
  if (t.failed) parts.push(`${t.failed.toLocaleString('en-GB')} could not be ${t.action === 'check' ? 'checked' : 'converted'}`);
  const wrote = t.action === 'convert' ? ` Wrote ${n(t.outputs, 'file')} (${fmtBytes(t.outputBytes)}).` : '';
  return `${t.action === 'check' ? 'Checked' : 'Converted'} ${n(t.inputs, 'input')}: ${parts.join(', ')}.${wrote}\n`;
}

process.exitCode = await main(process.argv.slice(2));

/**
 * Check cube exports against the Data Cube integrity constraints, streaming each file so that one of
 * any size can be checked. Exit 0 when every constraint passed, 1 when any failed or had nothing to
 * evaluate (a constraint over nothing is not tested, never passed), 2 when a file cannot be read.
 */
async function datacube(files, o) {
  if (!files.length) return usage('name at least one N-Triples cube export to check.');
  const { integrityOfFile } = await import('../src/lib/datacube.js');
  const { openFiles } = await import('../src/node/host.js');
  let code = 0;
  for (const path of files) {
    let results;
    try { const [f] = await openFiles([path]); results = await integrityOfFile(f); }
    catch (e) { process.stdout.write(o.json ? JSON.stringify({ input: path, status: 'failed', message: e.message }) + '\n' : `${path}: could not be checked: ${e.message}\n`); code = 2; continue; }
    const bad = results.filter((r) => r.status !== 'pass');
    if (bad.length && code < 1) code = 1;
    if (o.json) { process.stdout.write(JSON.stringify({ input: path, results: results.map(({ ic, status, evaluated, violations }) => ({ ic, status, evaluated, violations: violations.slice(0, 20), violationCount: violations.length })) }) + '\n'); continue; }
    process.stdout.write(`${path}:\n`);
    for (const r of results) {
      const word = r.status === 'pass' ? 'passes' : r.status === 'fail' ? `FAILS (${r.violations.length.toLocaleString('en-GB')})` : 'NOT TESTED: nothing to evaluate';
      process.stdout.write(`  ${r.ic.padEnd(6)} ${word}, ${r.evaluated.toLocaleString('en-GB')} evaluated\n`);
      for (const v of r.violations.slice(0, 5)) process.stdout.write(`         ${v}\n`);
    }
  }
  return code;
}
