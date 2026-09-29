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
//   - Code generation is refused at request time, so the async and generator
//     Function constructors, vm.compileFunction and a file written then
//     imported go to the runtime-code service: refused with
//     ERR_NIMBUS_CODE_NEXT_LAUNCH in the launch that produced them, compiled
//     in the next launch of the same command — a one-shot's envelope and a
//     resident process's exit report alike. Text the constructor would refuse
//     throws its SyntaxError there and never runs.
//   - The plain Function constructor stays native: a probe of it (TypeBox's
//     CanEvaluate, `Function("null")()`) answers "no" in every launch, so code
//     that probes once and then compiles everything keeps its fallback.
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
    '  probe: () => { try { Function("null")(); return true; } catch { return false; } },',
    '  async: () => typeof new (Object.getPrototypeOf(async function () {}).constructor)("a", "return a + 1"),',
    '  gen: () => new (Object.getPrototypeOf(function* () {}).constructor)("yield 7")().next().value,',
    '  vm: () => require("vm").compileFunction("return x * 3", ["x"])(5),',
    '  vmexpr: () => require("vm").runInThisContext("(function (x) { return x + 2 })", { filename: "jiti.cjs" })(3),',
    '  breakout: () => typeof new (Object.getPrototypeOf(async function () {}).constructor)("}, globalThis.__broke = 1, async function () {"),',
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
  'data.js': [
    'const text = ' + JSON.stringify('import { sep } from "node:path"; export const name = await Promise.resolve("café"); export {sep}; export const url=import.meta.url; export const bad=()=>import("./missing.js");'),
    'const url = "data:text/javascript;base64," + Buffer.from(text).toString("base64");',
    'import(url).then(async (m) => { const again=await import(url); const distinct=await import(url+"#another-instance"); let bad=false; try { await m.bad(); } catch { bad=true; } console.log("DATA " + JSON.stringify([m.name,m.sep,m.url===url,m===again,bad,distinct!==m,distinct.url===url+"#another-instance"])); }, (e) => console.log("DATA!" + (e.code || e.name)));',
  ].join('\n'),
  'server.js': [
    'require("http").createServer((q, s) => s.end("ok")).listen(7071);',
    'setTimeout(() => {',
    '  let r;',
    '  try { r = new (Object.getPrototypeOf(function* () {}).constructor)("yield \\"resident-ok\\"")().next().value; } catch (e) { r = e.code || e.name; }',
    '  require("fs").writeFileSync("/home/user/w/resident.txt", String(r));',
    '  process.exit(0);',
    '}, 300);',
  ].join('\n'),
  'node_modules/late-module/package.json': '{"name":"late-module","main":"unused.js"}',
  'node_modules/late-module/unused.js': 'module.exports = "unused";',
  'node_modules/late-module/deep/hidden.cjs': 'module.exports = "learned-live-file";',
  'caught.js': [
    'require("http").createServer((q,s)=>s.end("alive")).listen(7072);',
    'let result; try { result = require(process.cwd()+"/node_modules/"+["late","module"].join("-")+"/deep/"+["hid","den"].join("")+".cjs"); } catch(e) { result="CAUGHT "+e.message; }',
    'require("fs").writeFileSync("/home/user/w/caught.txt",String(result));',
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
      `mkdir -p ${W}/node_modules/late-module/deep && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    const cells = await terminal.run(`cd ${W} && node cells.js`);
    assert.match(cells.stdout, /CELLS number,2,tr,tr-space,tab,tabx function:\/own\n/, cells.stdout);

    const first = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(first.stdout,
      /FN fn!EvalError probe=false async!ERR_NIMBUS_CODE_NEXT_LAUNCH gen!ERR_NIMBUS_CODE_NEXT_LAUNCH vm!ERR_NIMBUS_CODE_NEXT_LAUNCH vmexpr!ERR_NIMBUS_CODE_NEXT_LAUNCH breakout!ERR_NIMBUS_CODE_NEXT_LAUNCH file!ERR_NIMBUS_CODE_NEXT_LAUNCH broke=undefined\n/,
      first.stdout);
    const second = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(second.stdout, /FN fn!EvalError probe=false async=function gen=7 vm=15 vmexpr=5 breakout!SyntaxError file=written broke=undefined\n/, second.stdout);
    const dataFirst = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataFirst.stdout, /DATA!ERR_NIMBUS_CODE_NEXT_LAUNCH/, dataFirst.stdout);
    const dataSecond = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataSecond.stdout, /DATA \["café","\/",true,true,true,true,true\]/, dataSecond.stdout);

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
    // An SSR server can catch a missing module without exiting. Persist that
    // file miss before acknowledging startup, so killing it does not lose
    // the dependency and make every subsequent launch repeat the same error.
    const caughtFile = async () => {
      for (let n = 0; n < 100; n++) {
        const r = await terminal.run('cat ' + W + '/caught.txt');
        if (r.exitCode === 0) return r.stdout.trim();
        await Bun.sleep(50);
      }
      throw new Error('caught module fixture never wrote its result');
    };
    const caughtFirst = await terminal.run('cd ' + W + ' && node caught.js');
    const caughtPid = Number(caughtFirst.stdout.match(/pid=(\d+)/)?.[1]);
    assert.ok(caughtPid > 0, caughtFirst.stdout);
    assert.match(await caughtFile(), /^CAUGHT /);
    await terminal.run('kill -KILL ' + caughtPid);
    await terminal.run('rm -f ' + W + '/caught.txt');
    await terminal.run('cd ' + W + ' && node caught.js');
    assert.equal(await caughtFile(), 'learned-live-file', 'a caught file miss survives a forced kill without an exit report');


    const bad = await terminal.run(`cd ${W} && node bad.js`);
    assert.match(bad.stdout, /\/home\/user\/w\/bad\.js\n\nSyntaxError/, bad.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-workerd: registry cells and runtime code behave as Node\'s under workerd');
