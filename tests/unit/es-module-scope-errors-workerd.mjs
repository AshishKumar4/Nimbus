// @serial
// @tier slow — drives a local workerd
// A CommonJS name in an ES module throws what Node throws, from where Node
// throws it, in the guest as it runs in workerd (its module registry
// compiling each cell, so each frame names its module's file): V8's
// "require is not defined", completed by Node's loader where the error
// leaves the module's job ("in ES module scope", the package.json that made
// a .js a module, top-level await's ambiguity), and the module's own line as
// its stack's first frame. module-format-matches-node covers the rest of the
// scope, in-process.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const ROOT = '/home/user/scope';
// `report(label, error)`: its name, message, code and the file of its first frame, one JSON line.
const REPORT = "const report = (label, e) => console.log(JSON.stringify([label, e.name, e.message, e.code ?? null, /([^/\\s:()]+):\\d+:\\d+\\)?$/.exec(e.stack.split('\\n').find((l) => l.startsWith('    at ')) ?? '')?.[1] ?? null]));\n";
const files = {
  'package.json': JSON.stringify({ name: 'scope', private: true }),
  'typed/package.json': JSON.stringify({ name: 'typed', type: 'module' }),
  'typed/module-exports.js': '\n\nmodule.exports = 1;\n',
  'require-in-esm.mjs': "import 'node:path';\nrequire('node:fs');\n",
  'tla-require.mjs': "await 1;\nrequire('node:path');\n",
  'chain.mjs': "import './typed/module-exports.js';\n",
  'via-require.cjs': `${REPORT}try { require('./require-in-esm.mjs'); } catch (e) { report('require', e); }\n`,
  'via-import.cjs': `${REPORT}import('./typed/module-exports.js').catch((e) => report('import', e))
  .then(() => import('./tla-require.mjs')).catch((e) => report('tla', e));\n`,
  // Thrown in a callback, after the module's job: V8's own text.
  'later.mjs': `${REPORT}process.on('uncaughtException', (e) => report('later', e));\nsetTimeout(() => { __dirname; }, 0);\n`,
};
// Entries print their uncaught error; the rest report what they caught.
const RUNS = ['require-in-esm.mjs', 'typed/module-exports.js', 'chain.mjs', 'via-require.cjs', 'via-import.cjs', 'later.mjs'];

/** An uncaught error's `<Name>: <message>` and further message lines, and its first frame's file. */
function uncaught(text) {
  const block = /^[A-Z]\w*Error(?::[^\n]*)?(?:\n(?!    at )[^\n]+)*/m.exec(text)?.[0] ?? null;
  const frame = block === null ? '' : text.slice(text.indexOf(block) + block.length).split('\n').find((l) => l.startsWith('    at ')) ?? '';
  return [block, /([^/\s:()]+):\d+:\d+\)?$/.exec(frame)?.[1] ?? null];
}
/** What a run says: its reports, or its uncaught error. */
function said(text, failed) {
  const reports = text.split('\n').filter((l) => l.startsWith('["')).map((l) => JSON.parse(l));
  return failed ? uncaught(text) : reports;
}

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'es-scope-')));
const expected = {};
try {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), text);
  }
  for (const script of RUNS) {
    const node = spawnSync('node', [script], { cwd: disk, encoding: 'utf8' });
    expected[script] = said((node.stdout + node.stderr).replaceAll(disk, ROOT), node.status !== 0);
  }
} finally {
  rmSync(disk, { recursive: true, force: true });
}
assert.match(expected['require-in-esm.mjs'][0], /^ReferenceError: require is not defined in ES module scope, you can use import instead$/, 'premise');
assert.equal(expected['require-in-esm.mjs'][1], 'require-in-esm.mjs', 'premise: node names the module\'s own frame first');

// ── node in a session on workerd ─────────────────────────────────────────
const probe = await startLocalProbe();
try {
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal, stripAnsi } = await import('../behavioral/_driver.mjs');
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  try {
    const b64 = (s) => Buffer.from(s).toString('base64');
    for (const [rel, text] of Object.entries(files)) {
      const path = `${ROOT}/${rel}`;
      await t.run(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && printf '%s' '${b64(text)}' | base64 -d > ${path}`, 15_000);
    }
    for (const script of RUNS) {
      const run = await t.run(`cd ${ROOT} && node ${script}; echo "STATUS=$?"`, 120_000);
      const text = stripAnsi(run.output).replace(/\r/g, '');
      const status = Number(/STATUS=(\d+)/.exec(text)?.[1]);
      assert.deepEqual(said(text, status !== 0), expected[script], `node ${script} throws what node throws, from where node throws it:\n${text.slice(-1500)}`);
    }
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('es-module-scope-errors-workerd: a CommonJS name in an ES module throws as in node');
