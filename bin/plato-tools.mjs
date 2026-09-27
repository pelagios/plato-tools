#!/usr/bin/env node
// The command line: check and convert PLATO data in batch, with the engine the browser uses
// (src/engine/pipeline.js), hosted in Node by src/node/host.js. Exit status: 0 when no input has
// problems, 1 when any has, 2 when the command is wrong or an input cannot be read or written.

// Node's built-in SQLite announces itself as experimental on every run; that says nothing about
// the data, so it is left out. Every other warning is still shown.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};

const { parseArgs } = await import('node:util');
const { readFileSync } = await import('node:fs');
const { run, TARGETS } = await import('../src/engine/pipeline.js');
const { detect } = await import('../src/engine/input.js');
const { nodeResources, gatherInputs, openFiles, isSystemError, NodeHost } = await import('../src/node/host.js');
const { fmtBytes, fmtTime, formatName, progressText, summary, groups } = await import('../src/engine/words.js');

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_BASE = 'https://example.org/my-dataset/';   // as the page's "Web address for your identifiers"

const HELP = `plato-tools: check and convert PLATO data from the command line.

Usage:
  plato-tools check [options] INPUT...
  plato-tools convert --to TARGET [--out DIR] [options] INPUT...

Each INPUT is one file, or one set of spreadsheet tables:
  - a directory is one set of tables, made of the CSV files in it;
  - CSV files named one by one are one set of tables per directory they are in;
  - a zip of the CSV files, or a workbook (.xlsx), is one set of tables.
Everything else is read as the format it turns out to be: PLATO JSON or JSON Lines, RDF
(N-Triples, N-Quads, Turtle) or Linked Places Format v1. Gzipped files are read directly.

Targets for --to:
${Object.entries(TARGETS).map(([k, v]) => `  ${k.padEnd(12)} ${v.label}`).join('\n')}

Options:
  --to TARGET       convert: the format to write (required).
  --out DIR         convert: where to write the outputs (default: the current directory).
                    Each output is named after its input; an existing file is never replaced
                    unless --overwrite is given.
  --overwrite       convert: replace outputs that already exist.
  --base URL        spreadsheet tables: the web address under which the identifiers of the
                    places and sources are made (default: ${DEFAULT_BASE}).
  --no-typing       N-Triples output: leave out the node types and typed dates that the DEEP RDF
                    export adds (they are added by default, as in the browser).
  --work-dir DIR    where the working database for RDF and attestation-centric input is kept
                    while it is in use (default: the system's temporary directory). It needs
                    room for about 1.5 times the uncompressed input; it is removed afterwards.
  --json            print one JSON object per input, one per line, then one for the total.
  --brief           print one line per input and the total, without the details.
  -h, --help        show this help.
  -V, --version     show the version, and the PLATO commit the checks follow.

Exit status: 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
cannot be read or written. Warnings, and what a conversion cannot carry over, do not count
as problems.
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
        base: { type: 'string', default: DEFAULT_BASE }, typing: { type: 'boolean', default: true },
        'work-dir': { type: 'string' }, json: { type: 'boolean', default: false }, brief: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (e) { return usage(e.message); }
  const { values: o, positionals } = parsed;
  if (o.help) { process.stdout.write(HELP); return 0; }
  const resources = await nodeResources();
  if (o.version) { process.stdout.write(`plato-tools ${PKG.version}, checking against PLATO ${resources.version.versionInfo} at ${resources.version.commit}\n`); return 0; }
  const [action, ...args] = positionals;
  if (!action) return usage('say what to do: check or convert.');
  if (action !== 'check' && action !== 'convert') return usage(`"${action}" is not a command; the commands are check and convert.`);
  if (!args.length) return usage(`name at least one input to ${action}.`);
  if (action === 'convert' && !o.to) return usage(`convert needs --to, one of: ${Object.keys(TARGETS).join(', ')}.`);
  if (action === 'convert' && !TARGETS[o.to]) return usage(`"${o.to}" is not a target; the targets are ${Object.keys(TARGETS).join(', ')}.`);
  if (action === 'check' && (o.to || o.overwrite)) return usage('--to and --overwrite are for convert.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');

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

/** Check or convert one input, and say how it went, as an object that --json prints as it is. */
async function runOne(item, action, o, resources, host, live) {
  const t0 = Date.now();
  const r = { type: 'input', input: item.label, files: item.paths, format: null, profile: null, action, target: action === 'convert' ? o.to : null,
    status: 'failed', errors: 0, counts: {}, items: [], outputs: [], storeBytes: null, elapsedMs: 0 };
  if (item.failure) { r.message = item.failure; return r; }
  let files, input;
  try { files = await openFiles(item.paths); input = await detect(files); }
  catch (e) {
    if (isSystemError(e)) { r.message = e.message; r.elapsedMs = Date.now() - t0; return r; }
    input = { format: null, reason: `It could not be read: ${e.message}` };
  }
  if (!input.format) { r.message = input.reason; r.elapsedMs = Date.now() - t0; return r; }
  r.format = input.format; r.profile = input.profile || null;
  if (input.lpfVersion) r.lpfVersion = input.lpfVersion;
  const progress = live ? (p) => process.stderr.write(`\r\x1b[K${item.label}: ${progressText(p)}`) : undefined;
  const xlsx = input.container === 'workbook' ? await import('xlsx') : undefined;
  const { env, finish } = host.env(resources, { progress, xlsx });
  let result = null, failure = null;
  try { result = await run({ input, action, target: r.target, options: { base: o.base, typing: o.typing, name: item.name } }, env); }
  catch (e) { failure = e; }
  if (live) process.stderr.write('\r\x1b[K');
  const done = finish(!!failure);
  r.storeBytes = done.storeBytes;
  r.elapsedMs = Date.now() - t0;
  if (failure && isSystemError(failure)) {
    r.message = failure.code === 'EEXIST' ? `${failure.path} already exists; give --overwrite to replace it, or --out for somewhere else.` : failure.message;
    return r;
  }
  if (failure) {
    // The data stopped the reader (JSON that is not well formed, say): a problem in the file.
    r.status = 'problems'; r.errors = 1;
    r.items = [{ severity: 'error', kind: 'unreadable', message: 'The file could not be read to the end, so it was not fully checked', count: 1, examples: [String(failure.message || failure)] }];
    if (done.removed.length) r.message = `Nothing was written: ${done.removed.join(', ')} was removed, being incomplete.`;
    return r;
  }
  Object.assign(r, { status: result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items,
    outputs: result.outputs.map(({ path, size }) => ({ path, size })) });
  return r;
}

function describe(r, action, brief) {
  const head = `${r.input}${r.format ? `: ${formatName(r)}` : ''}${r.status !== 'failed' ? ` (${fmtTime(r.elapsedMs)})` : ''}\n`;
  if (r.status === 'failed') return `${head}  Could not be ${action === 'check' ? 'checked' : 'converted'}: ${r.message}\n${brief ? '' : '\n'}`;
  const { problems, counted } = summary({ errors: r.errors, counts: r.counts });
  const lines = [head + `  ${problems}${counted ? ' ' + counted : ''}`];
  if (!brief) {
    for (const g of groups(action === 'check')) {
      const items = r.items.filter((i) => i.severity === g.severity);
      if (!items.length) continue;
      lines.push(`  ${g.title}. ${g.intro}`);
      for (const i of items) {
        lines.push(`    × ${i.count.toLocaleString('en-GB')}  ${i.message}`);
        for (const e of i.examples) lines.push(`        ${String(e)}`);
      }
    }
  }
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
