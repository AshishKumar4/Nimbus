// @serial
// test262's language tests (test/language) through the runtime-code
// interpreter, for every feature it claims.
//
// test262 is fetched at a pinned commit into the gitignored .cache/ at the
// repository root, once (a sparse checkout of harness/ and test/language/,
// about 25 k files); nothing of it is vendored. Each test runs in a fresh vm
// context that refuses string code generation, as a Worker does at request
// time, with the realm's Function constructors routed to the interpreter
// (tests/unit/lib/interpreter-test262-worker.mjs). A test the interpreter
// fails is also run natively: V8's own failures (features node 22 lacks) do
// not count against the interpreter.
//
// What the interpreter does not claim is skipped by test262's own metadata:
// module code and the features of module loading, explicit resource
// management, decorators, and anything that uses `eval` (an ordinary call of
// the global eval, refused in a Worker natively too). Its known deviations
// are KNOWN_FAILURES below, each with its reason; any other failure fails
// this test, and so does a known failure that starts passing.

import { YAML } from 'bun';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInterpreterFiles } from './lib/interpreter-build.mjs';

const TEST262_COMMIT = '7ab7fafa0003f73fc85c1b95d88094d33f7eb8bd';
const REPO = fileURLToPath(new URL('../../', import.meta.url));
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
const INDEX_ACCESSORS = "the interpreter's own arrays (its environments) meet properties defined on Array.prototype or Object.prototype indices";

/** test262 files (relative to test/language) the interpreter fails, and why. */
const KNOWN_FAILURES = {
  'arguments-object/10.6-10-c-ii-1.js': MAPPED_ARGUMENTS,
  'arguments-object/10.6-10-c-ii-2.js': MAPPED_ARGUMENTS,
  'arguments-object/10.6-11-b-1.js': INDEX_ACCESSORS,
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
  'expressions/array/11.1.4_4-5-1.js': INDEX_ACCESSORS,
  'expressions/array/11.1.4_5-6-1.js': INDEX_ACCESSORS,
  'expressions/yield/formal-parameters-after-reassignment-non-strict.js': MAPPED_ARGUMENTS,
  'global-code/decl-lex-restricted-global.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-deletion.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-lex.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-restricted-global.js': SCRIPT_LEXICALS,
  'global-code/script-decl-lex-var.js': SCRIPT_LEXICALS,
  'statements/async-function/evaluation-mapped-arguments.js': MAPPED_ARGUMENTS,
  'statements/async-generator/return-undefined-implicit-and-explicit.js': TICKS,
  'statements/for-await-of/ticks-with-sync-iter-resolved-promise-and-constructor-lookup.js': TICKS,
  'statements/for-in/head-lhs-let.js': INDEX_ACCESSORS,
  'statements/for-of/arguments-mapped-aliasing.js': MAPPED_ARGUMENTS,
};

/** The pinned test262 checkout: fetched on first use, then reused. */
function checkout() {
  const marker = join(CHECKOUT, '.nimbus-complete');
  if (existsSync(marker)) return;
  rmSync(CHECKOUT, { recursive: true, force: true });
  mkdirSync(CHECKOUT, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: CHECKOUT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (test262 is fetched from github.com on first run): ${r.stderr}`);
  };
  git('init', '-q', '.');
  git('remote', 'add', 'origin', 'https://github.com/tc39/test262');
  git('config', 'core.sparseCheckout', 'true');
  writeFileSync(join(CHECKOUT, '.git/info/sparse-checkout'), 'harness/\ntest/language/\n');
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', TEST262_COMMIT);
  git('checkout', '-q', 'FETCH_HEAD');
  writeFileSync(marker, `${TEST262_COMMIT}\n`);
}

function collect() {
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
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const path of files.sort()) {
    const source = readFileSync(path, 'utf8');
    const frontmatter = source.match(/\/\*---([\s\S]*?)---\*\//);
    const meta = (frontmatter && YAML.parse(frontmatter[1])) || {};
    const flags = new Set(meta.flags ?? []);
    const unclaimed = (meta.features ?? []).find((f) => UNCLAIMED_FEATURES.has(f));
    if (flags.has('module')) { skip('module code'); continue; }
    if (unclaimed) { skip(`feature ${unclaimed}`); continue; }
    if (/\beval\b/.test(frontmatter ? source.replace(frontmatter[0], '') : source)) { skip('uses eval'); continue; }
    tests.push({
      file: relative(join(CHECKOUT, 'test/language'), path), source, includes: meta.includes ?? [],
      async: flags.has('async'), raw: flags.has('raw'), onlyStrict: flags.has('onlyStrict'), noStrict: flags.has('noStrict'),
      negative: meta.negative ?? null,
    });
  }
  return { tests, skipped };
}

checkout();
const { tests, skipped } = collect();
const { dir, interpreterFile, opsFile } = await buildInterpreterFiles();
const jobs = Math.max(1, Math.min(16, availableParallelism()));
const results = [];
const crashes = [];
await Promise.all(Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
  const list = join(dir, `tests-${i}.json`);
  writeFileSync(list, JSON.stringify(tests.filter((_, n) => n % jobs === i)));
  const child = spawn('node', ['--expose-gc', '--max-old-space-size=1536', fileURLToPath(new URL('./lib/interpreter-test262-worker.mjs', import.meta.url)), list, CHECKOUT, interpreterFile, opsFile], {
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
const stale = Object.keys(KNOWN_FAILURES).filter((file) => !failedFiles.has(file));
const passed = counted.length - failures.length;
console.log(`test262 ${TEST262_COMMIT.slice(0, 12)}: ${tests.length} tests, ${results.length} runs (sloppy and strict where both apply)`);
console.log(`interpreter: ${passed} of ${counted.length} runs V8 passes (${((passed / counted.length) * 100).toFixed(2)}%); V8 itself fails ${results.length - counted.length}`);
console.log(`known deviations: ${failures.length - unexpected.length} runs in ${Object.keys(KNOWN_FAILURES).length - stale.length} files`);
console.log(`skipped: ${JSON.stringify(skipped)}`);
for (const r of unexpected.slice(0, 40)) console.log(`FAIL ${r.file}${r.strict ? ' (strict)' : ''}: ${r.why}`);
if (crashes.length) console.log(crashes.join('\n'));
if (stale.length) console.log(`now passing, remove from KNOWN_FAILURES: ${stale.join(', ')}`);
if (unexpected.length || crashes.length || stale.length || results.length === 0) process.exit(1);
