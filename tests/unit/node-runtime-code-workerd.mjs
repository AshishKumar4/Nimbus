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
//   - The plain Function constructor keeps the native refusal for text no
//     launch staged, and stages what it refused only when the launch fails:
//     a probe of it (TypeBox's CanEvaluate, `Function("null")()`) in a
//     successful launch answers "no" every time, so code that probes once and
//     then compiles everything keeps its fallback, while a module that builds
//     a function as it loads (depd, under express 4) or a program that exits
//     1 after a refusal (serve's ajv) fails once and runs from the next
//     launch on.
//   - A SyntaxError in an entry names the file.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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
  'grammar.js': "async function f(){ const ok = await /import(\"fake\")/.test('import\"fake\"'); const m = await import(\"./grammar-dep.js\"); console.log(\"GRAMMAR \" + ok + \" \" + m.value); } f();",
  'grammar-dep.js': 'module.exports = { value: 7 };',
  'events.js': [
    'const EventEmitter = require("events");',
    'function Legacy() { EventEmitter.call(this); }',
    'require("util").inherits(Legacy, EventEmitter);',
    'const legacy = new Legacy();',
    'const out = {};',
    'legacy.on("x", function (v) { out.legacy = [v, this === legacy]; });',
    'legacy.emit("x", 1);',
    // express's createApplication mixes EventEmitter.prototype into a function.
    'const app = function () {};',
    'for (const k of Object.getOwnPropertyNames(EventEmitter.prototype)) Object.defineProperty(app, k, Object.getOwnPropertyDescriptor(EventEmitter.prototype, k));',
    'app.on("m", () => { out.mixin = true; }); app.emit("m");',
    // Constructed, not created: a createServer call would make it a resident launch.
    'const server = new (require("http").Server)();',
    'out.server = server instanceof EventEmitter && server instanceof require("node:events").EventEmitter;',
    'out.stream = require("stream").EventEmitter === EventEmitter;',
    // send (express.static): Node's legacy Stream is a function constructor.
    'function Send() { require("stream").call(this); }',
    'require("util").inherits(Send, require("stream"));',
    'out.legacyStream = new Send() instanceof EventEmitter && typeof new Send().pipe === "function";',
    'out.max = server.setMaxListeners(20).getMaxListeners();',
    '(async () => {',
    '  const e = new EventEmitter({ captureRejections: true });',
    '  const caught = new Promise((resolve) => e.on("error", (err) => resolve(err.message)));',
    '  e.on("boom", async () => { throw new Error("rejected"); });',
    '  e.emit("boom");',
    '  out.captured = await caught;',
    '  const once = EventEmitter.once(e, "ready");',
    '  e.emit("ready", 7);',
    '  out.once = (await once)[0];',
    '  const ticks = EventEmitter.on(e, "tick");',
    '  e.emit("tick", "a");',
    '  out.on = (await ticks.next()).value[0];',
    '  await ticks.return();',
    '  console.log("EVENTS " + JSON.stringify(out));',
    '})();',
  ].join('\n'),
  // depd's shape: a module that builds a function with `new Function` as it loads.
  'plain.js': [
    'const deprecated = new Function("fn", "\\"use strict\\"\\nreturn function (arg0) { return fn.apply(this, arguments) * 3 }")((a) => a);',
    'console.log("PLAIN " + deprecated(5));',
    'try { Function("null")(); console.log("PROBE yes"); } catch { console.log("PROBE no"); }',
  ].join('\n'),
  // serve 14's shape: the refusal (ajv compiling a schema) is caught and the
  // program exits 1.
  'reported.js': 'try { console.log("REPORTED " + new Function("return 7")()); } catch (e) { console.log("REPORTED " + e.message); process.exit(1); }',
  // TypeBox's CanEvaluate shape: a silent probe, then compile with Function
  // or fall back. A launch that fails for an unrelated reason must not stage
  // the probe, or the next launch's probe says yes and its check is refused.
  'probe-fail.js': [
    'const canEval = (() => { try { Function("null")(); return true; } catch { return false; } })();',
    'const check = canEval ? new Function("x", "return x === 1") : (x) => x === 1;',
    'console.log("PROBEFAIL " + canEval + " " + check(1));',
    'if (require("fs").existsSync("fail.flag")) process.exit(1);',
  ].join('\n'),
  // process.stdin wraps data listeners; removal must still find them.
  'stdin.js': [
    'const f = () => {}, g = () => {};',
    'process.stdin.on("data", f); process.stdin.off("data", f); process.stdin.on("data", g);',
    'const afterOn = process.stdin.listenerCount("data");',
    'const listed = process.stdin.listeners("data")[0] === g;',
    'process.stdin.removeListener("data", g);',
    'const onceFn = () => {}; process.stdin.once("data", onceFn); process.stdin.off("data", onceFn);',
    'const afterOff = process.stdin.listenerCount("data");',
    // once(): listed as the program's function; it fires once and removes itself.
    'let calls = 0; const h = () => { calls++; }; process.stdin.once("data", h);',
    'const onceListed = process.stdin.listeners("data")[0] === h;',
    'process.stdin.emit("data", Buffer.from("x")); process.stdin.emit("data", Buffer.from("y"));',
    'console.log("STDIN " + [afterOn, listed, afterOff, onceListed, calls, process.stdin.listenerCount("data")].join(" "));',
    'process.stdin.pause(); process.exit(0);',
  ].join('\n'),
  // A pipe or redirect is the program's stdin: readFileSync(0), 'data'/'end'
  // and async iteration each read it whole.
  'stdin-sync.js': 'process.stdout.write("SYNC " + JSON.stringify(require("fs").readFileSync(0, "utf8")) + "\\n");',
  'stdin-events.js': 'let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { s += c; }).on("end", () => console.log("EVENTS " + JSON.stringify(s)));',
  'stdin-await.js': '(async () => { let s = ""; for await (const c of process.stdin) s += c; console.log("AWAIT " + JSON.stringify(s)); })();',
  'stdin-both.js': 'const first = require("fs").readFileSync("/dev/stdin", "utf8"); let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => console.log("BOTH " + JSON.stringify([first, s])));',
  // node:path, compared with the host's real node below (totalist's
  // `join("", name)` builds the names sirv serves).
  'path.js': [
    'const path = require("path");',
    'console.log("PATH " + JSON.stringify([path.join("", "hello.txt"), path.join(), path.join("a", "", "b/"), path.normalize("a//b/../c/"), path.normalize(""),',
    '  path.relative("/a/b/c", "/a/d"), path.resolve("/x", "y/", "../z"), path.parse("/a/b.tar.gz"), path.format({ dir: "/a", name: "b", ext: ".c" }),',
    '  path.extname(".bashrc"), path.basename("/a/b/", ".x"), path.dirname("a"), path.posix === path, path.win32.join("a", "b")]));',
  ].join('\n'),
  // stream.Readable.from emits a string or Buffer whole, as node does
  // (http-server streams Readable.from(bytes) into each text response).
  'from.js': [
    'const { Readable } = require("stream");',
    'const seen = [];',
    'const done = (label, r) => new Promise((resolve) => r.on("data", (c) => seen.push(label + ":" + typeof c + ":" + c.length)).on("end", resolve));',
    'done("buffer", Readable.from(Buffer.from("h\u00e9llo"))).then(() => done("string", Readable.from("abc"))).then(() => done("array", Readable.from(["a", "bc"]))).then(() => console.log("FROM " + JSON.stringify(seen)));',
  ].join('\n'),
  // node:url's legacy API, compared with the host's real node below
  // (http-server reads `url.parse(req.url).pathname`).
  'url.js': [
    'const url = require("url");',
    'const pick = (u) => ({ protocol: u.protocol, auth: u.auth, host: u.host, port: u.port, hostname: u.hostname, hash: u.hash, search: u.search, query: u.query, pathname: u.pathname, path: u.path, href: u.href });',
    'console.log("URL " + JSON.stringify([pick(url.parse("/hello.txt?x=1#h")), pick(url.parse("http://u:p@host:8080/a/b?q=1", true)), url.resolve("/a/b/c", "../d"), url.format({ pathname: "/x", query: { a: 1 } })]));',
  ].join('\n'),
  'bad.js': 'const x = ;\n',
  // es-module-lexer copies each source into wasm memory with a UTF-16 write
  // into a Buffer view at an offset. Nothing outside the view may change.
  'lexer-buffer.js': [
    'const memory = new WebAssembly.Memory({ initial: 1 });',
    'const at = 8, bytes = new Uint8Array(memory.buffer);',
    'bytes.fill(255, 0, 40);',
    'const written = Buffer.from(memory.buffer, at, 24).write("import \\u00e9", "utf16le");',
    'const units = new Uint16Array(memory.buffer, at, 8);',
    'console.log("LEXER " + written + " " + String.fromCharCode(...units) + " " + bytes[at - 1] + " " + bytes[at + 16]);',
  ].join('\n'),
  // Vite's module runner: each SSR module is one AsyncFunction whose hoisted
  // imports load its dependencies, which are AsyncFunctions in turn.
  'runner.js': [
    'const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;',
    'const keys = ["__vite_ssr_exports__", "__vite_ssr_import_meta__", "__vite_ssr_import__", "__vite_ssr_dynamic_import__", "__vite_ssr_exportAll__", "__vite_ssr_exportName__"];',
    'const lead = "\\"use strict\\";\\n";',
    'const sources = {',
    '  a: lead + "__vite_ssr_exportName__(\\"value\\", () => { try { return value } catch {} });\\nconst __vite_ssr_import_0__ = await __vite_ssr_import__(\\"b\\", {\\"importedNames\\":[\\"b\\"]});\\nconst __vite_ssr_import_1__ = await __vite_ssr_import__(\\"c\\");\\nconst value = __vite_ssr_import_0__.b + __vite_ssr_import_1__.c;",',
    '  b: lead + "__vite_ssr_exportName__(\\"b\\", () => { try { return b } catch {} });\\nconst __vite_ssr_import_0__ = await __vite_ssr_import__(\\"d\\");\\nconst b = 10 + __vite_ssr_import_0__.d;",',
    '  c: lead + "__vite_ssr_exportName__(\\"c\\", () => { try { return c } catch {} });\\nconst c = 100;",',
    '  d: lead + "__vite_ssr_exportName__(\\"d\\", () => { try { return d } catch {} });\\nconst d = 1;",',
    '};',
    'const cache = new Map();',
    'const imported = [];',
    'function run(id) {',
    '  if (cache.has(id)) return cache.get(id);',
    '  imported.push(id);',
    '  const exports = Object.create(null);',
    '  const exportName = (name, get) => Object.defineProperty(exports, name, { enumerable: true, get });',
    '  const done = Promise.resolve().then(() => new AsyncFunction(...keys, sources[id])(exports, {}, run, run, () => {}, exportName)).then(() => exports);',
    '  cache.set(id, done);',
    '  return done;',
    '}',
    'run("a").then((m) => console.log("RUNNER value=" + m.value + " imported=" + imported.join(",")), (e) => console.log("RUNNER!" + (e.code || e.name) + " imported=" + imported.join(",")));',
  ].join('\n'),
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

    const grammar = await terminal.run(`cd ${W} && node grammar.js`);
    assert.equal(grammar.status, 0, grammar.stdout);
    assert.match(grammar.stdout, /^GRAMMAR true 7$/m, grammar.stdout);

    // One EventEmitter, workerd's: Node's function-constructor inheritance,
    // express's prototype mixin, native http servers and the static helpers.
    const events = await terminal.run(`cd ${W} && node events.js`);
    assert.equal(events.status, 0, events.stdout);
    assert.match(events.stdout,
      /^EVENTS \{"legacy":\[1,true\],"mixin":true,"server":true,"stream":true,"legacyStream":true,"max":20,"captured":"rejected","once":7,"on":"a"\}$/m,
      events.stdout);

    const first = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(first.stdout,
      /FN fn!EvalError probe=false async!ERR_NIMBUS_CODE_NEXT_LAUNCH gen!ERR_NIMBUS_CODE_NEXT_LAUNCH vm!ERR_NIMBUS_CODE_NEXT_LAUNCH vmexpr!ERR_NIMBUS_CODE_NEXT_LAUNCH breakout!ERR_NIMBUS_CODE_NEXT_LAUNCH file!ERR_NIMBUS_CODE_NEXT_LAUNCH broke=undefined\n/,
      first.stdout);
    const second = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(second.stdout, /FN fn!EvalError probe=false async=function gen=7 vm=15 vmexpr=5 breakout!SyntaxError file=written broke=undefined\n/, second.stdout);
    // One launch learns the whole static SSR graph, not one module per launch.
    const runnerFirst = await terminal.run(`cd ${W} && node runner.js`);
    assert.match(runnerFirst.stdout, /RUNNER!ERR_NIMBUS_CODE_NEXT_LAUNCH imported=a,b,d,c\n/, runnerFirst.stdout);
    const runnerSecond = await terminal.run(`cd ${W} && node runner.js`);
    assert.match(runnerSecond.stdout, /RUNNER value=111 imported=a,b,d,c\n/, runnerSecond.stdout);
    const lexer = await terminal.run(`cd ${W} && node lexer-buffer.js`);
    assert.match(lexer.stdout, /LEXER 16 import é 255 255\n/, lexer.stdout);
    const dataFirst = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataFirst.stdout, /DATA!ERR_NIMBUS_CODE_NEXT_LAUNCH/, dataFirst.stdout);
    const dataSecond = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataSecond.stdout, /DATA \["café","\/",true,true,true,true,true\]/, dataSecond.stdout);

    const refused = await terminal.run(`cd ${W} && node plain.js`);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stdout, /EvalError: Code generation from strings disallowed/, refused.stdout);
    assert.match(refused.stdout, /ERR_NIMBUS_CODE_NEXT_LAUNCH/, 'the crash says the text is staged');
    const staged = await terminal.run(`cd ${W} && node plain.js`);
    assert.equal(staged.status, 0, staged.stdout);
    assert.match(staged.stdout, /^PLAIN 15$/m, 'the next launch runs the staged function');
    assert.match(staged.stdout, /^PROBE no$/m, 'a probe in a successful launch is never staged');
    const reported = await terminal.run(`cd ${W} && node reported.js`);
    assert.equal(reported.status, 1, reported.stdout);
    assert.match(reported.stdout, /^REPORTED Code generation from strings disallowed/m, reported.stdout);
    const recovered = await terminal.run(`cd ${W} && node reported.js`);
    assert.equal(recovered.status, 0, recovered.stdout);
    assert.match(recovered.stdout, /^REPORTED 7$/m, 'a refusal the program reported before exiting 1 is staged');

    // A probe, then an unrelated failure, then a clean next launch.
    const unrelated = await terminal.run(`cd ${W} && touch fail.flag && node probe-fail.js`);
    assert.match(unrelated.stdout, /^PROBEFAIL false true$/m, unrelated.stdout);
    const clean = await terminal.run(`cd ${W} && rm fail.flag && node probe-fail.js`);
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /^PROBEFAIL false true$/m, 'an unrelated failure never stages a silent probe');

    const stdin = await terminal.run(`cd ${W} && node stdin.js < /dev/null`);
    const hostStdin = spawnSync('node', ['-e', FILES['stdin.js']], { encoding: 'utf8', input: '' });
    assert.equal(/^STDIN .*$/m.exec(stdin.stdout)?.[0], /^STDIN .*$/m.exec(hostStdin.stdout)?.[0], 'stdin data listeners list and remove as in node');

    await terminal.run(`cd ${W} && printf 'abc\\ndef\\n' > stdin.txt`);
    for (const [name, label] of [['stdin-sync.js', 'SYNC'], ['stdin-events.js', 'EVENTS'], ['stdin-await.js', 'AWAIT']]) {
      const piped = await terminal.run(`cd ${W} && echo hi | node ${name}`);
      assert.match(piped.stdout, new RegExp(`^${label} "hi\\\\n"$`, 'm'), `${name} reads a pipe`);
      const redirected = await terminal.run(`cd ${W} && node ${name} < stdin.txt`);
      assert.match(redirected.stdout, new RegExp(`^${label} "abc\\\\ndef\\\\n"$`, 'm'), `${name} reads a redirect`);
    }
    const evalPiped = await terminal.run(`echo hi | node -e 'console.log("EVAL " + JSON.stringify(require("fs").readFileSync(0, "utf8")))'`);
    assert.match(evalPiped.stdout, /^EVAL "hi\\n"$/m, 'node -e reads a pipe');
    const both = await terminal.run(`cd ${W} && echo hi | node stdin-both.js`);
    assert.match(both.stdout, /^BOTH \["hi\\n",""\]$/m, 'a synchronous read takes stdin; process.stdin then ends');

    const urlRun = await terminal.run(`cd ${W} && node url.js`);
    const hostUrl = spawnSync('node', ['-e', FILES['url.js']], { encoding: 'utf8' });
    assert.equal(hostUrl.status, 0, hostUrl.stderr);
    assert.equal(/^URL .*$/m.exec(urlRun.stdout)?.[0], /^URL .*$/m.exec(hostUrl.stdout)?.[0], 'url.parse/resolve/format answer as node does');

    const fromRun = await terminal.run(`cd ${W} && node from.js`);
    const hostFrom = spawnSync('node', ['-e', FILES['from.js']], { encoding: 'utf8' });
    assert.equal(hostFrom.status, 0, hostFrom.stderr);
    assert.equal(/^FROM .*$/m.exec(fromRun.stdout)?.[0], /^FROM .*$/m.exec(hostFrom.stdout)?.[0], 'Readable.from answers as node does');

    const pathRun = await terminal.run(`cd ${W} && node path.js`);
    const hostPath = spawnSync('node', ['-e', FILES['path.js']], { encoding: 'utf8' });
    assert.equal(hostPath.status, 0, hostPath.stderr);
    assert.equal(/^PATH .*$/m.exec(pathRun.stdout)?.[0], /^PATH .*$/m.exec(hostPath.stdout)?.[0], 'node:path answers as node does');
    const cwdRun = await terminal.run(`cd ${W} && node -e "const p = require('path'); console.log('CWD ' + p.resolve('x') + ' ' + p.relative('x', '/') + ' ' + p.resolve())"`);
    assert.match(cwdRun.stdout, new RegExp(`^CWD ${W}/x \\.\\./\\.\\./\\.\\./\\.\\. ${W}$`, 'm'), 'resolve and relative start from the process cwd');

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
        if (r.status === 0) return r.stdout.trim();
        await Bun.sleep(50);
      }
      const ps = await terminal.run('ps');
      const logs = await terminal.run('logs ' + caughtPid);
      throw new Error('caught module fixture never wrote its result: ' + JSON.stringify({startup:caughtFirst,ps,logs}));
    };
    const caughtFirst = await terminal.run('cd ' + W + ' && node caught.js');
    const caughtPid = Number(caughtFirst.stdout.match(/pid=(\d+)/)?.[1]);
    assert.ok(caughtPid > 0, caughtFirst.stdout);
    assert.match(await caughtFile(), /^CAUGHT /);
    await terminal.run('kill -KILL ' + caughtPid);
    await terminal.run('rm -f ' + W + '/caught.txt');
    await terminal.run('cd ' + W + ' && node caught.js');
    assert.equal(await caughtFile(), 'learned-live-file', 'a caught file miss survives a forced kill without an exit report');


    // Real workerd uses its own HTTP scheduling, not the Bun fixture's TCP
    // connection sweep. Measure the guest counter while each server is bound
    // and verify natural one-shot exit after close or unref (no runner deadline).
    const closeStart = performance.now();
    const closing = await terminal.run(
      `node -e "const s=require('http').createServer();s.listen(0,()=>{console.log('BOUND_TIMERS='+globalThis.__nimbusPendingTimers);s.close(()=>console.log('CLOSED_TIMERS='+globalThis.__nimbusPendingTimers))})"`, 15000,
    );
    assert.equal(closing.status, 0, closing.stdout);
    assert.match(closing.stdout, /^BOUND_TIMERS=0$/m);
    assert.match(closing.stdout, /^CLOSED_TIMERS=0$/m);
    console.log('workerd native listen/close natural exit: ' + Math.round(performance.now() - closeStart) + 'ms');
    const unrefStart = performance.now();
    const unref = await terminal.run(
      `node -e "const s=require('http').createServer();s.listen(0,()=>{console.log('UNREF_TIMERS='+globalThis.__nimbusPendingTimers);s.unref();console.log('UNREF_OK')})"`, 15000,
    );
    assert.equal(unref.status, 0, unref.stdout);
    assert.match(unref.stdout, /^UNREF_TIMERS=0$/m);
    assert.match(unref.stdout, /^UNREF_OK$/m, 'an unrefed native listener does not keep the process alive');
    console.log('workerd native listen/unref natural exit: ' + Math.round(performance.now() - unrefStart) + 'ms');

    const bad = await terminal.run(`cd ${W} && node bad.js`);
    assert.match(bad.stdout, /\/home\/user\/w\/bad\.js\n\nSyntaxError/, bad.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-workerd: registry cells and runtime code behave as Node\'s under workerd');
