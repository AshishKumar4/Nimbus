// @serial
// @tier slow — drives a local workerd
// A hosted node program's ES modules, staged and interpreted, load as Node
// 22's do (audit RTM-4, SHI-M1, SHI-M2, SHI-5, SHI-6). Host Node running the
// same files is the oracle:
//   - a staged entry, and a staged package it imports, each statically
//     import a data: module (text/javascript, and JSON with its type);
//   - a data: JavaScript module is a module whatever its syntax: strict,
//     its `this` undefined;
//   - an ES module's own `__esModule` export is a name of its namespace, in a
//     module the program writes and in a data: module;
//   - a typeless .js the program writes, whose top level redeclares a
//     CommonJS wrapper parameter (`const require = 1`), is an ES module;
//   - a module under a directory named `a#b` imports beside itself, and its
//     import.meta.url escapes the `#`.
//
// Red before: the staged imports of data: modules failed to link; the data:
// module ran as sloppy CommonJS; `export const __esModule` threw a
// TypeError, and namespaces left the name out; the typeless .js ran as
// sloppy CommonJS; and `a#b/main.cjs` imported from the directory above it.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

// Written before the program runs, in the directory at \`root\` (its file: URL, with its slash): staged.
const filesAt = (root) => {
  // A data: module in a cycle through a staged module (back2.mjs) whose static import of it reads nothing of it.
  const cyclic = 'data:text/javascript,' + encodeURIComponent('import b from ' + JSON.stringify(root + 'back2.mjs') + '; export default "data:" + b;');
  return {
  'back2.mjs': 'import d from ' + JSON.stringify(cyclic) + ';\nexport default "back";\n',
  // Staged (the entry names it, in an import() it never makes); its JSON name is missing.
  'bad-json-child.mjs': `globalThis.badChildRan = true;
import { a } from 'data:application/json,{"a":1}' with { type: 'json' };
`,
  'node_modules/dpkg/package.json': JSON.stringify({ name: 'dpkg', version: '1.0.0', type: 'module', exports: './index.js' }),
  'node_modules/dpkg/index.js': "import five from 'data:text/javascript,export default 5';\nexport default five + 1;\n",
  'staged-json.mjs': `globalThis.stagedJsonRan = true;
import { a } from 'data:application/json,{"a":1}' with { type: 'json' };
`,
  'staged.mjs': `import fortyOne from 'data:text/javascript,export default 41';
import json from 'data:application/json,{"a":1}' with { type: 'json' };
import six from 'dpkg';
export default [fortyOne, json, six];
`,
  'main.mjs': `import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
if (globalThis.never) { await import('./back2.mjs'); await import('./bad-json-child.mjs'); }
const out = {};
// Each case on its own: one that fails is its error, and the rest still run.
const outcome = async (thunk) => {
  try { return await thunk(); } catch (e) { return ['threw', e?.constructor?.name ?? typeof e, String(e?.message ?? e).split('\\n')[0]]; }
};
const keys = (ns) => [Object.keys(ns), ns.__esModule];

// Staged modules' static imports of data: modules.
out.staged = await outcome(async () => (await import('./staged.mjs')).default);

// The data: module's goal is its MIME type's: a module.
out.dataStrict = await outcome(async () => {
  await import('data:text/javascript,globalThis.seen=(function(){return this})()===undefined');
  return globalThis.seen;
});

// An ES module's own __esModule, written now (interpreted), and in a data: module.
writeFileSync('own.mjs', 'export const __esModule = false; export const b = 2;\\n');
out.ownEsModule = await outcome(async () => keys(await import('./own.mjs')));
out.dataEsModule = await outcome(async () => keys(await import('data:text/javascript,export const __esModule = 7; export default 1')));
// Through export *, and a static namespace import, whose own export no delete removes.
writeFileSync('star.mjs', "export * from './own.mjs';\\n");
out.starEsModule = await outcome(async () => keys(await import('./star.mjs')));
writeFileSync('ns-user.mjs', "import * as ns from './own.mjs';\\nexport default [Reflect.deleteProperty(ns, '__esModule'), ns.__esModule];\\n");
out.deleteEsModule = await outcome(async () => (await import('./ns-user.mjs')).default);

// A static import of a data: module: one that exports \`then\`; a name it does not export (no body runs; JSON's too);
// a cycle through a file back to it (it runs once); and one that throws, imported twice (it runs once).
writeFileSync('then-user.mjs', "import { value } from 'data:text/javascript,export function then() {} export const value = 1';\\nexport default value;\\n");
out.thenExport = await outcome(async () => (await import('./then-user.mjs')).default);
const named = async (file, text) => {
  writeFileSync(file, text);
  try { await import('./' + file); return 'loaded'; } catch (e) { return e?.constructor?.name; }
};
out.missingName = [await named('missing.mjs', "globalThis.missingRan = true;\\nimport { nope } from 'data:text/javascript,export const present = 1';\\n"), globalThis.missingRan ?? false];
out.missingJsonName = [await named('missing-json.mjs', "globalThis.jsonRan = true;\\nimport { a } from 'data:application/json,{\\"a\\":1}' with { type: 'json' };\\n"), globalThis.jsonRan ?? false];
const back = pathToFileURL(process.cwd() + '/back.mjs').href;
const cyclic = 'data:text/javascript,' + encodeURIComponent('import b from ' + JSON.stringify(back) + '; globalThis.dataRuns = (globalThis.dataRuns ?? 0) + 1; export default "data:" + b;');
writeFileSync('back.mjs', 'import d from ' + JSON.stringify(cyclic) + ';\\nexport default "back";\\n');
out.cycle = await outcome(async () => [(await import(cyclic)).default, (await import('./back.mjs')).default, globalThis.dataRuns]);
// A staged module's missing JSON name, refused before it runs.
const stagedJson = await outcome(async () => { await import('./staged-json.mjs'); return 'loaded'; });
out.stagedMissingJson = [Array.isArray(stagedJson) ? stagedJson[1] : stagedJson, globalThis.stagedJsonRan ?? false];
// A namespace through a cycle sees the star exports its module installs after it; stars that conflict leave the name out.
const fileUrl = (name) => pathToFileURL(process.cwd() + '/' + name).href;
writeFileSync('star-src.mjs', 'export const x = 1;\\n');
const cycleStar = 'data:text/javascript,' + encodeURIComponent('import ' + JSON.stringify(fileUrl('cyc-user.mjs')) + '; export * from ' + JSON.stringify(fileUrl('star-src.mjs')) + ';');
writeFileSync('cyc-user.mjs', 'import * as ns from ' + JSON.stringify(cycleStar) + ';\\nglobalThis.cycleKeys = () => Object.keys(ns);\\n');
out.cycleStar = await outcome(async () => { await import(cycleStar); return globalThis.cycleKeys(); });
writeFileSync('conflict-a.mjs', 'export const x = 1; export const y = 1;\\n');
writeFileSync('conflict-b.mjs', 'export const x = 2;\\n');
out.starConflict = await outcome(async () => Object.keys(await import('data:text/javascript,' + encodeURIComponent('export * from ' + JSON.stringify(fileUrl('conflict-a.mjs')) + '; export * from ' + JSON.stringify(fileUrl('conflict-b.mjs')) + ';'))));
// One namespace by either import; a data: cycle through a staged module; a staged module's missing JSON name, reached
// through a module written now.
const identity = 'data:text/javascript,export const z = 1';
writeFileSync('id-user.mjs', 'import * as ns from ' + JSON.stringify(identity) + ';\\nexport default ns;\\n');
out.identity = await outcome(async () => (await import('./id-user.mjs')).default === await import(identity));
out.stagedCycle = await outcome(async () => (await import(${JSON.stringify(cyclic)})).default);
writeFileSync('late-parent.mjs', "import './bad-json-child.mjs';\\n");
const lateParent = await outcome(async () => { await import('./late-parent.mjs'); return 'loaded'; });
out.nestedMissingJson = [Array.isArray(lateParent) ? lateParent[1] : lateParent, globalThis.badChildRan ?? false];
// A static import of a data: module that awaits at its top level and rejects: the import that reaches it rejects.
writeFileSync('tla-user.mjs', "import 'data:text/javascript,await Promise.reject(new Error(\\"boom\\"))';\\n");
out.staticAwait = await outcome(() => import('./tla-user.mjs'));
const throwing = 'data:text/javascript,globalThis.throwRuns = (globalThis.throwRuns ?? 0) + 1; throw new Error("thrown")';
out.throwsOnce = [await outcome(() => import(throwing)), await outcome(() => import(throwing)), globalThis.throwRuns];

// A typeless .js that redeclares a wrapper parameter: an ES module.
writeFileSync('det.js', 'const require = 1; globalThis.detStrict = (function(){return this})()===undefined; globalThis.detRequire = require;\\n');
out.detected = await outcome(async () => {
  await import('./det.js');
  return [globalThis.detStrict, globalThis.detRequire];
});

// A directory named a#b.
mkdirSync('a#b', { recursive: true });
writeFileSync('a#b/dep.mjs', "export default 'beside';\\n");
writeFileSync('a#b/main.cjs', "module.exports = import('./dep.mjs').then((m) => m.default);\\n");
writeFileSync('a#b/meta.mjs', 'export default import.meta.url;\\n');
out.hashDirectory = await outcome(async () => (await import(pathToFileURL(process.cwd() + '/a#b/main.cjs').href)).default);
out.hashMeta = await outcome(async () => (await import(pathToFileURL(process.cwd() + '/a#b/meta.mjs').href)).default
  .replace(pathToFileURL(process.cwd() + '/').href, '<cwd>/'));
console.log('PARITY ' + JSON.stringify(out));
`,
  };
};

const report = (stdout) => {
  const line = stdout.split('\n').find((text) => text.startsWith('PARITY '));
  if (line === undefined) throw new Error(`no report in:\n${stdout}`);
  return JSON.parse(line.slice('PARITY '.length));
};

// ── The oracle: host Node runs the same files ─────────────────────────────
const host = mkdtempSync(join(tmpdir(), 'interpreted-esm-'));
let expected;
try {
  for (const [name, text] of Object.entries(filesAt(pathToFileURL(host).href + '/'))) {
    mkdirSync(dirname(join(host, name)), { recursive: true });
    writeFileSync(join(host, name), text);
  }
  const ran = spawnSync('node', ['main.mjs'], { cwd: host, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  expected = report(ran.stdout);
} finally {
  rmSync(host, { recursive: true, force: true });
}
// What the oracle says, stated, so the comparison is not vacuous.
assert.deepEqual(expected, {
  staged: [41, { a: 1 }, 6],
  dataStrict: true,
  ownEsModule: [['__esModule', 'b'], false],
  dataEsModule: [['__esModule', 'default'], 7],
  starEsModule: [['__esModule', 'b'], false],
  deleteEsModule: [false, false],
  thenExport: 1,
  missingName: ['SyntaxError', false],
  missingJsonName: ['SyntaxError', false],
  cycle: ['data:back', 'back', 1],
  throwsOnce: [['threw', 'Error', 'thrown'], ['threw', 'Error', 'thrown'], 1],
  stagedMissingJson: ['SyntaxError', false],
  identity: true,
  stagedCycle: 'data:back',
  nestedMissingJson: ['SyntaxError', false],
  cycleStar: ['x'],
  starConflict: ['y'],
  staticAwait: ['threw', 'Error', 'boom'],
  detected: [true, 1],
  hashDirectory: 'beside',
  hashMeta: '<cwd>/a%23b/meta.mjs',
});

// ── The session ────────────────────────────────────────────────────────────
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(filesAt('file:///home/user/'))).toString('base64');
    const setup = await session.run(
      `cd /home/user && node -e "const f=JSON.parse(Buffer.from('${payload}','base64').toString());for(const [n,t] of Object.entries(f)){require('fs').mkdirSync(require('path').dirname(n),{recursive:true});require('fs').writeFileSync(n,t)}console.log('SETUP')"`,
    );
    assert.equal(setup.status, 0, setup.stdout);
    const ran = await session.run('cd /home/user && node main.mjs', 120_000);
    assert.equal(ran.status, 0, ran.stdout);
    // Node waits for a statically imported module's top-level await; an interpreted module cannot, so Nimbus refuses
    // the import before that module runs (and leaves no unhandled rejection: the run exits 0).
    const { staticAwait, ...ours } = report(ran.stdout);
    const { staticAwait: _nodeWaits, ...theirs } = expected;
    assert.deepEqual(ours, theirs, 'staged and interpreted ES modules load as host Node loads them');
    assert.equal(staticAwait[0], 'threw');
    assert.match(staticAwait[2], /^A static import of data:text\/javascript,await .* cannot wait for its top-level await/);
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - interpreted-esm-parity-workerd (data: imports staged and interpreted, __esModule exports, wrapper-name detection and a#b URLs, as Node 22 has them)');
