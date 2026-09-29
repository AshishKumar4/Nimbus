// @serial
// Node guests on the real registry: how module cells are wrapped and named,
// and code a program produces at runtime, under workerd.
//
// What only workerd shows, which a Function stand-in for the registry cannot:
//   - A CommonJS cell runs as Node's wrapper runs it (a var and a function of
//     one name, a strict cell declaring a function twice), and an ES module
//     lowered to CommonJS keeps its own top-level bindings of the wrapper's
//     names.
//   - Cells whose paths differ only where URL parsing is lossy (a trailing
//     space, a tab) are distinct modules, and the map loads.
//   - Code generation is refused at request time, so the Function
//     constructors, vm.compileFunction and a file written then imported go to
//     the runtime-code service: refused with ERR_NIMBUS_CODE_NEXT_LAUNCH in
//     the launch that produced them, compiled in the next launch of the same
//     command — a one-shot's envelope and a resident process's exit report
//     alike. Text the constructor would refuse throws its SyntaxError there
//     and never runs.
//   - A SyntaxError in an entry names the file.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/w';
const FILES = {
  'legacy.js': 'var f = 1;\nfunction f() {}\nmodule.exports = typeof f;\n',
  'strictdup.js': '"use strict";\nfunction g() { return 1; }\nfunction g() { return 2; }\nmodule.exports = g();\n',
  'esm.mjs': 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst __dirname = "/own";\nexport const v = typeof require("path").join + ":" + __dirname;\n',
  'tr': 'module.exports = "tr";\n',
  'tr ': 'module.exports = "tr-space";\n',
  'tab\tx.js': 'module.exports = "tab";\n',
  'tabx.js': 'module.exports = "tabx";\n',
  'cells.js': [
    'const out = [require("./legacy"), require("./strictdup"), require("./tr"), require("./tr "), require("./tab\\tx.js"), require("./tabx.js")];',
    'import("./esm.mjs").then((m) => console.log("CELLS " + out.join(",") + " " + m.v));',
  ].join('\n'),
  'fn.js': [
    'const out = [];',
    'const make = {',
    '  fn: () => new Function("a", "return a * 2")(21),',
    '  async: () => typeof new (Object.getPrototypeOf(async function () {}).constructor)("a", "return a + 1"),',
    '  gen: () => new (Object.getPrototypeOf(function* () {}).constructor)("yield 7")().next().value,',
    '  vm: () => require("vm").compileFunction("return x * 3", ["x"])(5),',
    '  breakout: () => Function("}, globalThis.__broke = 1, function () {"),',
    '};',
    'for (const [label, run] of Object.entries(make)) {',
    '  try { out.push(label + "=" + run()); } catch (e) { out.push(label + "!" + (e.code || e.name)); }',
    '}',
    'const temp = "/home/user/w/.tmp/config.timestamp-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mjs";',
    'require("fs").mkdirSync("/home/user/w/.tmp", { recursive: true });',
    'require("fs").writeFileSync(temp, "export default \\"written\\";\\n");',
    'import(temp).then((m) => out.push("file=" + m.default), (e) => out.push("file!" + (e.code || e.name)))',
    '  .then(() => console.log("FN " + out.join(" ") + " broke=" + globalThis.__broke));',
  ].join('\n'),
  'server.js': [
    'require("http").createServer((q, s) => s.end("ok")).listen(7071);',
    'setTimeout(() => {',
    '  let r;',
    '  try { r = new Function("return \\"resident-ok\\"")(); } catch (e) { r = e.code || e.name; }',
    '  require("fs").writeFileSync("/home/user/w/resident.txt", String(r));',
    '  process.exit(0);',
    '}, 300);',
  ].join('\n'),
  'bad.js': 'const x = ;\n',
};

console.log('node-runtime-code-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    const cells = await terminal.run(`cd ${W} && node cells.js`);
    assert.match(cells.stdout, /CELLS number,2,tr,tr-space,tab,tabx function:\/own\n/, cells.stdout);

    const first = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(first.stdout,
      /FN fn!ERR_NIMBUS_CODE_NEXT_LAUNCH async!ERR_NIMBUS_CODE_NEXT_LAUNCH gen!ERR_NIMBUS_CODE_NEXT_LAUNCH vm!ERR_NIMBUS_CODE_NEXT_LAUNCH breakout!ERR_NIMBUS_CODE_NEXT_LAUNCH file!ERR_NIMBUS_CODE_NEXT_LAUNCH broke=undefined\n/,
      first.stdout);
    const second = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(second.stdout, /FN fn=42 async=function gen=7 vm=15 breakout!SyntaxError file=written broke=undefined\n/, second.stdout);

    const residentResult = async () => {
      for (let i = 0; i < 120; i++) {
        const r = await terminal.run(`cat ${W}/resident.txt 2>/dev/null`);
        if (r.stdout.trim()) return r.stdout.trim();
        await Bun.sleep(500);
      }
      return '(no result)';
    };
    await terminal.run(`cd ${W} && node server.js`);
    assert.equal(await residentResult(), 'ERR_NIMBUS_CODE_NEXT_LAUNCH', 'a resident process is refused in the launch that produced the code');
    await terminal.run(`rm -f ${W}/resident.txt`);
    await Bun.sleep(1000);
    await terminal.run(`cd ${W} && node server.js`);
    assert.equal(await residentResult(), 'resident-ok', 'and its exit report staged it for the next launch');

    const bad = await terminal.run(`cd ${W} && node bad.js`);
    assert.match(bad.stdout, /\/home\/user\/w\/bad\.js\n\nSyntaxError/, bad.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-workerd: registry cells and runtime code behave as Node\'s under workerd');
