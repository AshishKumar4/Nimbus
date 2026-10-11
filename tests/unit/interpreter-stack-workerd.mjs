// @serial
// @tier slow — drives a local workerd
// The same frames, CallSites, and fatal arrows under Node 22 and workerd,
// both for require(esm) adoption and modules written after launch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const ROOT = '/home/user/frames';
const SOURCE = [
  'import { bridge, nativeFault, nativeStack } from "./bridge.cjs";',
  'export {};',
  'const frames = (stack) => stack.split("\\n").filter((line) => line.startsWith("    at ") && /\\/(frames\\.mjs|bridge\\.cjs):/.test(line));',
  'const report = (name, stack) => console.log("FRAMES " + JSON.stringify([name, frames(stack)]));',
  'function leaf() { return new Error("created").stack; }',
  'function middle() { return leaf(); }',
  'report("created", middle());',
  'function thrown() { throw new Error("thrown"); }',
  'function caller() { thrown(); }',
  'try { caller(); } catch (e) { report("thrown", e.stack); }',
  'try { const notFunction = 1; notFunction(); } catch (e) { report("not-function", e.stack); }',
  'try { const nothing = null; nothing.value; } catch (e) { report("null", e.stack); }',
  'class C { constructor() { this.stack = new Error("constructor").stack; } method() { return new Error("method").stack; } }',
  'const instance = new C();',
  'report("constructor", instance.stack);',
  'report("method", instance.method());',
  'const object = { method() { return new Error("object").stack; } };',
  'report("object", object.method());',
  'function outer() { return bridge(() => leaf()); }',
  'report("interleaved", outer());',
  'report("host-created", bridge(() => nativeStack()));',
  'try { bridge(() => nativeFault()); } catch (e) { report("host-error", e.stack); }',
  'function capture() { const holder = {}; Error.captureStackTrace(holder); return holder.stack; }',
  'report("capture", capture());',
  'function omitted() { const holder = {}; Error.captureStackTrace(holder, omitted); return holder.stack; }',
  'report("capture-above", omitted());',
  'function* generator() { yield 1; yield leaf(); }',
  'const iterator = generator(); iterator.next();',
  'report("generator", iterator.next().value);',
  'async function asyncLeaf() { await Promise.resolve(); throw new Error("async"); }',
  'async function asyncCaller() { await asyncLeaf(); }',
  'async function afterAwait() {',
  '  try { await asyncCaller(); } catch (e) { report("async", e.stack); }',
  '  async function* asyncGenerator() { await Promise.resolve(); yield leaf(); }',
  '  const iterator = asyncGenerator(); report("async-generator", (await iterator.next()).value);',
  '  const saved = Error.prepareStackTrace;',
  '  Error.prepareStackTrace = (_e, sites) => sites.filter((s) => /\\/(frames\\.mjs|bridge\\.cjs)$/.test(s.getFileName() ?? "")).map((s) => [s.getFunctionName(),s.getTypeName(),s.getMethodName(),s.getFileName(),s.getLineNumber(),s.getColumnNumber(),s.isConstructor(),s.isAsync(),s.isToplevel(),s.getThis() === undefined,s.getFunction() === undefined,String(s)]);',
  '  console.log("SITES " + JSON.stringify(middle()));',
  '  Error.prepareStackTrace = saved;',
  '}',
  'afterAwait();',
  'const alias = { other: function named() { return new Error("alias").stack; } };',
  'report("alias", alias.other());',
  'try { 1n + 2; } catch (e) { report("binary", e.stack); }',
  'function parameter(value = new Error("parameter").stack) { return value; }',
  'report("parameter", parameter());',
].join('\n') + '\n';
const FATAL = 'export {};\nfunction crash() { throw new Error("fatal-frame"); }\ncrash();\n';
const FILES = {
  'package.json': '{"private":true}',
  'bridge.cjs': 'exports.bridge = function bridge(callback) { return callback(); };\nexports.nativeFault = function nativeFault() { throw new Error("host"); };\nexports.nativeStack = function nativeStack() { return new Error("native-created").stack; };\n',
  'frames.mjs': SOURCE,
  'fatal.mjs': FATAL,
  'adopt.cjs': 'require("./frames.mjs");\n',
  'runtime.cjs': `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(ROOT + '/late')}, {recursive:true}); fs.writeFileSync(${JSON.stringify(ROOT + '/late/frames.mjs')}, ${JSON.stringify(SOURCE.replace('./bridge.cjs', '../bridge.cjs'))}); import("./late/frames.mjs");\n`,
  'fatal-adopt.cjs': 'require("./fatal.mjs");\n',
  'fatal-runtime.cjs': `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(ROOT + '/late')}, {recursive:true}); fs.writeFileSync(${JSON.stringify(ROOT + '/late/fatal.mjs')}, ${JSON.stringify(FATAL)}); import("./late/fatal.mjs");\n`,
  'runtime-cjs.cjs': `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(ROOT + '/late')}, {recursive:true}); fs.writeFileSync(${JSON.stringify(ROOT + '/late/module.cjs')}, 'function leaf() { return new Error("cjs").stack; }\\nexports.stack = leaf();\\nexports.top = new Error("top").stack;\\n'); const m = require("./late/module.cjs"); for (const [name,stack] of Object.entries(m)) console.log("CJS " + JSON.stringify([name, stack.split("\\n").filter((line) => line.startsWith("    at ") && line.includes("/late/module.cjs:"))]));\n`,
};
const RUNS = ['adopt.cjs', 'runtime.cjs', 'runtime-cjs.cjs', 'fatal-adopt.cjs', 'fatal-runtime.cjs'];
function said(text, fatal) {
  if (!fatal) return text.split('\n').filter((line) => /^(FRAMES|SITES|CJS) /.test(line));
  // Whole guest stderr, byte for byte except foreign loader/runtime frames,
  // as node-fatal-report-matches-node-workerd does. Keep every source frame,
  // arrow, header, version and blank line (including duplicate reports).
  return text.split('\n').filter((line) => !line.startsWith('    at ') || /\/fatal\.mjs:/.test(line)).join('\n');
}

const disk = realpathSync(mkdtempSync(join(tmpdir(), 'interpreted-frames-')));
const expected = {};
try {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), text.replaceAll(ROOT, disk));
  }
  for (const script of RUNS) {
    const run = spawnSync('node', [script], { cwd: disk, encoding: 'utf8' });
    const text = (run.stdout + run.stderr).replaceAll(disk, ROOT);
    assert.equal(run.status, script.startsWith('fatal-') ? 1 : 0, `Node premise: ${script}: ${text}`);
    expected[script] = said(script.startsWith('fatal-') ? run.stderr.replaceAll(disk, ROOT) : text, script.startsWith('fatal-'));
  }
  assert.equal(expected['adopt.cjs'].length, 19, 'every frame and CallSite fixture ran under Node');
  assert.match(expected['fatal-runtime.cjs'], /fatal\.mjs:\d+\n[^\n]+\n[ \t]*\^+\n/, 'Node prints the module source and arrow for an unhandled rejection');
} finally {
  rmSync(disk, { recursive: true, force: true });
}

const probe = await startLocalProbe();
try {
  const { terminal: t, run: command, close: cleanup } = await localTerminal(probe);
  try {
    for (const [rel, text] of Object.entries(FILES)) {
      const path = `${ROOT}/${rel}`;
      await t.run(`mkdir -p ${dirname(path)} && printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > ${path}`, 15_000);
    }
    for (const script of RUNS) {
      if (script.startsWith('fatal-')) {
        await command(`cd ${ROOT} && node ${script} > frame-out.txt 2> frame-err.txt; echo $? > frame-code.txt`, 120_000);
        const read = await command(`cd ${ROOT} && node -e "const fs = require('fs'); console.log(JSON.stringify({err:fs.readFileSync('frame-err.txt').toString('base64'),code:fs.readFileSync('frame-code.txt','utf8')}))"`, 60_000);
        const line = splitScenarioOutput(read.stdout).lines.find((line) => line.startsWith('{'));
        assert.ok(line, `${script}: read guest fd 2: ${read.stdout}`);
        const got = JSON.parse(line);
        assert.equal(Number(got.code.trim()), 1, `${script}: Node's exit code`);
        assert.equal(said(Buffer.from(got.err, 'base64').toString('utf8'), true), expected[script], `${script}: whole guest stderr is Node's`);
        continue;
      }
      const run = await t.run(`cd ${ROOT} && node ${script}; echo "FRAME_STATUS=$?"`, 120_000);
      const text = run.output.replace(/\r/g, '');
      assert.equal(Number(/FRAME_STATUS=(\d+)/.exec(text)?.[1]), script.startsWith('fatal-') ? 1 : 0, `${script}: ${text}`);
      assert.deepEqual(said(text, script.startsWith('fatal-')), expected[script], `${script}: interpreted frames are Node's:\n${text}`);
    }
  } finally { await cleanup(); }
} finally { await probe.stop(); }
console.log('interpreter-stack-workerd: adopted and runtime-written frames, CallSites, async/generator resumes, fatal arrows match Node');
