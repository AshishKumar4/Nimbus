// test262's language tests (test/language) through the runtime-code
// interpreter, for every feature it claims: the shared runner behind
// tests/unit/interpreter-test262-*.mjs, each of which runs one SLICE.
//
// test262 is fetched at a pinned commit into the gitignored .cache/ at the
// repository root, once (a sparse checkout of harness/ and test/language/,
// about 25 k files); nothing of it is vendored. Each test runs in a fresh vm
// context that refuses string code generation, as a Worker does at request
// time, with the realm's Function constructors routed to the interpreter
// (lib/interpreter-test262-worker.mjs). A test the interpreter fails is also
// run natively: V8's own failures (features node 22 lacks) do not count
// against the interpreter.
//
// What the interpreter does not claim is skipped by test262's own metadata:
// module code and the features of module loading, explicit resource
// management, decorators, and anything that uses `eval` (an ordinary call of
// the global eval, refused in a Worker natively too). Its known deviations
// are KNOWN_FAILURES below, each with its reason; any other failure fails
// the slice that runs it, and so does a known failure that starts passing.

import { YAML } from 'bun';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInterpreterFiles } from './interpreter-build.mjs';

export const TEST262_COMMIT = '7ab7fafa0003f73fc85c1b95d88094d33f7eb8bd';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CHECKOUT = join(REPO, '.cache/test262', TEST262_COMMIT);

/** Features the interpreter does not run (module loading and syntax it refuses) or V8 lacks. */
const UNCLAIMED_FEATURES = new Set([
  'explicit-resource-management', 'decorators', 'source-phase-imports', 'import-defer', 'import-attributes',
  'json-modules', 'top-level-await', 'dynamic-import', 'import.meta', 'IsHTMLDDA', 'cross-realm',
  'tail-call-optimization', 'regexp-modifiers',
]);

const MAPPED_ARGUMENTS = "a sloppy function's arguments object is not mapped to its parameters";
const SCRIPT_LEXICALS = "each script's top-level let/const/class is its own, not shared with later scripts";
const TICKS = 'an async generator or for-await step takes a different number of microtask ticks';
const CALLER = "Function.prototype.caller reports the interpreter's own frames";

/** test262 files (relative to test/language) the interpreter fails, and why. */
const KNOWN_FAILURES = {
  'arguments-object/10.6-10-c-ii-1.js': MAPPED_ARGUMENTS,
  'arguments-object/10.6-10-c-ii-2.js': MAPPED_ARGUMENTS,
  'arguments-object/10.6-13-a-2.js': CALLER,
  'arguments-object/10.6-13-a-3.js': CALLER,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-2.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-3.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-4.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-delete-2.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-delete-3.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-delete-4.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-nonwritable-3.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-nonwritable-4.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-nonwritable-5.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-2.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-3.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-4.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-descriptors-define-failure.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-descriptors-set-value-by-arguments.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-descriptors-set-value-with-define-property.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-descriptors-with-param-assign.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-arguments.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-param.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-arguments.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-param.js': MAPPED_ARGUMENTS,
  'arguments-object/mapped/writable-enumerable-configurable-descriptor.js': MAPPED_ARGUMENTS,
  'expressions/yield/formal-parameters-after-reassignment-non-strict.js': MAPPED_ARGUMENTS,
  'global-code/decl-lex-restricted-global.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-deletion.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-lex.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-restricted-global.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-var.js': SCRIPT_LEXICALS,
  'statements/async-function/evaluation-mapped-arguments.js': MAPPED_ARGUMENTS,
  'statements/async-generator/return-undefined-implicit-and-explicit.js': TICKS,
  'statements/for-of/arguments-mapped-aliasing.js': MAPPED_ARGUMENTS,
};

/**
 * The slices, by test262 directory (relative to test/language). A file
 * belongs to the slice with the longest prefix it starts with; the last
 * slice, with no prefixes, takes everything else, so the slices cover every
 * test exactly once, whatever test262 adds. Each is about a fifth of the
 * work, measured per directory, so each runs in about 150 s alone on a
 * 4-vCPU CI shard; statements/class and expressions/class (their dstr/ and
 * elements/ tests above all) are over half of it.
 */
export const SLICES = [
  { name: 'statements-class-dstr', prefixes: ['statements/class/dstr/', 'statements/class/async-gen-method-static/', 'statements/class/definition/'] },
  { name: 'statements-class', prefixes: ['statements/class/', 'statements/for-await-of/'] },
  { name: 'expressions-class', prefixes: ['expressions/class/'] },
  { name: 'expressions', prefixes: ['expressions/'] },
  { name: 'rest', prefixes: [] },
];

if (SLICES.at(-1).prefixes.length !== 0) throw new Error('the last test262 slice must be the rest (no prefixes)');
const prefixes = SLICES.flatMap((slice) => slice.prefixes.map((prefix) => ({ prefix, slice: slice.name })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const twice = prefixes.find((a, i) => prefixes.findIndex((b) => b.prefix === a.prefix) !== i);
if (twice) throw new Error(`test262 slice prefix ${twice.prefix} is given twice`);

/** The slice that runs `file` (relative to test/language). */
export function sliceOf(file) {
  return prefixes.find(({ prefix }) => file.startsWith(prefix))?.slice ?? SLICES.at(-1).name;
}

/**
 * The pinned test262 checkout: fetched on first use, then reused. Fetched
 * into a directory of its own and renamed into place whole, so slices that
 * start together on one machine never see (or delete) one another's half.
 */
function checkout() {
  const marker = join(CHECKOUT, '.nimbus-complete');
  if (existsSync(marker)) return;
  mkdirSync(dirname(CHECKOUT), { recursive: true });
  const fetching = mkdtempSync(`${CHECKOUT}.fetching-`);
  try {
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: fetching, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (test262 is fetched from github.com on first run): ${r.stderr}`);
    };
    git('init', '-q', '.');
    git('remote', 'add', 'origin', 'https://github.com/tc39/test262');
    git('config', 'core.sparseCheckout', 'true');
    writeFileSync(join(fetching, '.git/info/sparse-checkout'), 'harness/\ntest/language/\n');
    git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', TEST262_COMMIT);
    git('checkout', '-q', 'FETCH_HEAD');
    writeFileSync(join(fetching, '.nimbus-complete'), `${TEST262_COMMIT}\n`);
    try {
      renameSync(fetching, CHECKOUT);
    } catch (error) {
      // Another slice finished first: use its checkout.
      if (existsSync(marker)) return;
      throw new Error(`${CHECKOUT} exists but is not a complete checkout (no .nimbus-complete); remove it: ${error.message}`);
    }
  } finally {
    rmSync(fetching, { recursive: true, force: true });
  }
}

/**
 * The tests the interpreter claims among the files `include` accepts
 * (relative to test/language), in path order, and each skipped one with why.
 */
export function collectTests(include = () => true) {
  checkout();
  return collect(include);
}

function collect(include) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.js') && !entry.includes('_FIXTURE')) files.push(path);
    }
  };
  walk(join(CHECKOUT, 'test/language'));
  const tests = [];
  const skipped = [];
  for (const path of files.sort()) {
    const file = relative(join(CHECKOUT, 'test/language'), path);
    if (!include(file)) continue;
    const skip = (why) => { skipped.push([file, why]); };
    const source = readFileSync(path, 'utf8');
    const frontmatter = source.match(/\/\*---([\s\S]*?)---\*\//);
    /** test262's frontmatter (INTERPRETING.md): the fields the runner reads. */
    const meta = /** @type {{ flags?: string[], features?: string[], includes?: string[], negative?: { phase: string, type: string } }} */ (
      (frontmatter && YAML.parse(frontmatter[1])) || {});
    const flags = new Set(meta.flags ?? []);
    const unclaimed = (meta.features ?? []).find((f) => UNCLAIMED_FEATURES.has(f));
    if (flags.has('module')) { skip('module code'); continue; }
    if (unclaimed) { skip(`feature ${unclaimed}`); continue; }
    if (/\beval\b/.test(frontmatter ? source.replace(frontmatter[0], '') : source)) { skip('uses eval'); continue; }
    tests.push({
      file, source, includes: meta.includes ?? [],
      async: flags.has('async'), raw: flags.has('raw'), onlyStrict: flags.has('onlyStrict'), noStrict: flags.has('noStrict'),
      negative: meta.negative ?? null,
    });
  }
  return { tests, skipped };
}

/**
 * Run the slice `name`: its tests through the interpreter workers, its share
 * of KNOWN_FAILURES checked both ways. Prints the slice's report and returns
 * every run's result; `ok` is false on an unexpected failure, a crashed
 * worker, a known failure that now passes, or no runs at all.
 * NIMBUS_TEST262_ONLY=<substring> runs only the matching files of the slice,
 * and prints each run.
 */
export async function runTest262Slice(name) {
  if (!SLICES.some((slice) => slice.name === name)) throw new Error(`no test262 slice ${name}`);
  const only = process.env.NIMBUS_TEST262_ONLY;
  const collected = collectTests((file) => sliceOf(file) === name && (!only || file.includes(only)));
  const { tests } = collected;
  const skipped = {};
  for (const [, why] of collected.skipped) skipped[why] = (skipped[why] ?? 0) + 1;
  const { dir, primordialsFile, interpreterFile, opsFile } = await buildInterpreterFiles();
  const jobs = Math.max(1, Math.min(16, availableParallelism()));
  const results = [];
  const crashes = [];
  await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
    const list = join(dir, `tests-${i}.json`);
    writeFileSync(list, JSON.stringify(tests.filter((_, n) => n % jobs === i)));
    const child = spawn('node', ['--expose-gc', '--max-old-space-size=1536', fileURLToPath(new URL('./interpreter-test262-worker.mjs', import.meta.url)), list, CHECKOUT, primordialsFile, interpreterFile, opsFile], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
        results.push(JSON.parse(pending.slice(0, nl)));
        pending = pending.slice(nl + 1);
      }
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) crashes.push(`worker ${i} exited ${code ?? signal}`);
      resolve();
    });
  })));

  rmSync(dir, { recursive: true, force: true });
  const counted = results.filter((r) => r.ok || r.nativeOk);
  const failures = counted.filter((r) => !r.ok);
  const unexpected = failures.filter((r) => !Object.hasOwn(KNOWN_FAILURES, r.file));
  const failedFiles = new Set(failures.map((r) => r.file));
  const known = Object.keys(KNOWN_FAILURES).filter((file) => sliceOf(file) === name && (!only || file.includes(only)));
  const stale = known.filter((file) => !failedFiles.has(file));
  if (only) for (const r of results) console.log(`${r.ok ? 'pass' : r.nativeOk ? 'FAIL' : 'v8-fails'} ${r.file}${r.strict ? ' (strict)' : ''}${r.why ? `: ${r.why}` : ''}`);
  const passed = counted.length - failures.length;
  console.log(`test262 ${TEST262_COMMIT.slice(0, 12)} ${name}: ${tests.length} tests, ${results.length} runs (sloppy and strict where both apply)`);
  console.log(`interpreter: ${passed} of ${counted.length} runs V8 passes (${counted.length ? ((passed / counted.length) * 100).toFixed(2) : '0.00'}%); V8 itself fails ${results.length - counted.length}`);
  console.log(`known deviations: ${failures.length - unexpected.length} runs in ${known.length - stale.length} files`);
  console.log(`skipped: ${JSON.stringify(skipped)}`);
  for (const r of unexpected.slice(0, 40)) console.log(`FAIL ${r.file}${r.strict ? ' (strict)' : ''}: ${r.why}`);
  if (crashes.length) console.log(crashes.join('\n'));
  if (stale.length) console.log(`now passing, remove from KNOWN_FAILURES: ${stale.join(', ')}`);
  return { results, ok: !(unexpected.length || crashes.length || stale.length || results.length === 0) };
}
