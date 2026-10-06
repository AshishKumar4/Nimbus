// @serial
// @tier slow — drives a local workerd; CI median 69 s wall, 57 s CPU, 2.1 GiB peak (6 runs, 2026-10-06)
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
//     constructors, vm.compileFunction and a file written then imported go
//     to the runtime-code service: the launch that produced the code runs it
//     in the interpreter, and records it for the next launch of the same
//     command — a one-shot's envelope and a resident process's exit report
//     alike — which runs it natively from its module map. Each fixture says
//     where its code ran: a stack taken inside it names the staged `gen/`
//     module only when it ran natively, and NIMBUS_RUNTIME_CODE=interpret
//     makes a launch interpret what it staged. Text the constructor would
//     refuse throws its SyntaxError in both launches and never runs.
//   - The plain Function constructor is answered the same way, so a probe of
//     it (TypeBox's CanEvaluate, `Function("null")()`) says yes in every
//     launch, a module that builds a function as it loads (depd, under
//     express 4) and a program that compiles a schema at request time
//     (serve's ajv) work from their first launch.
//   - A SyntaxError in an entry names the file.
//   - node:url, node:path and Readable.from answer as host node's do, and
//     path.resolve starts from the process's cwd.
//
// One of five files, each its own local workerd and session, so each fits
// the suite's per-file budget on a loaded machine (together they took
// 240-260 s alone, against run-all's 300 s): runtime code
// (node-runtime-code-workerd); stdin (node-runtime-code-stdin-workerd);
// a 48 MiB `< file` handed and refused (node-runtime-code-stdin-file-workerd)
// and streamed (node-runtime-code-stdin-stream-workerd); resident processes
// (node-runtime-code-resident-workerd).
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
    // A script's value as V8 gives it: a lone string is a directive, and the script's value;
    // `this` at a script's top level is the global object, strict or not.
    '  vmstr: () => require("vm").runInThisContext("\\"hello\\""),',
    '  vmthis: () => require("vm").runInThisContext("\'use strict\'; this") === globalThis,',
    '  vmarrow: () => require("vm").runInThisContext("\'use strict\'; (() => this)()") === globalThis,',
    '  breakout: () => typeof new (Object.getPrototypeOf(async function () {}).constructor)("}, globalThis.__broke = 1, async function () {"),',
    '  where: () => (new Function("return new Error().stack")().includes("/gen/") ? "native" : "interpreted"),',
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
  'grammar.js': "async function f(){ const ok = await /import(\"fake\")/.test('import\"fake\"'); const m = await import(\"./grammar-dep.js\"); console.log(\"GRAMMAR \" + ok + \" \" + m.value); } f();",
  'grammar-dep.js': 'module.exports = { value: 7 };',
  // Module files written while the program runs (so interpreted), each with
  // top-level await: import() resolves once the module has finished, and
  // rejects with what its evaluation throws. require() returns the exports
  // at once, by design: static imports are lowered to require, which cannot
  // wait (Node's own require of such a module throws ERR_REQUIRE_ASYNC_MODULE,
  // which a lowered import cannot be told apart from). An export the module
  // has not reached is in its TDZ until it does, and so is what a module
  // that imports it statically reads (`transitive`; Node: 42).
  'tla.js': [
    'const fs = require("fs");',
    'const dir = "/home/user/w/.tmp-tla";',
    'fs.mkdirSync(dir, { recursive: true });',
    'const name = Date.now() + "-" + Math.random().toString(36).slice(2);',
    'fs.writeFileSync(dir + "/late-" + name + ".mjs", "export const v = await new Promise((r) => setTimeout(() => r(42), 20));\\n");',
    'fs.writeFileSync(dir + "/bad-" + name + ".mjs", "export const w = 1;\\nawait new Promise((r) => setTimeout(r, 5));\\nthrow new Error(\\"tla failed\\");\\n");',
    'fs.writeFileSync(dir + "/req-" + name + ".mjs", "export const early = 1;\\nexport const v = await new Promise((r) => setTimeout(() => r(42), 20));\\n");',
    'fs.writeFileSync(dir + "/dep-" + name + ".mjs", "export const v = await new Promise((r) => setTimeout(() => r(42), 20));\\n");',
    'fs.writeFileSync(dir + "/top-" + name + ".mjs", "import { v } from \\"./dep-" + name + ".mjs\\";\\nexport const read = () => { try { return v; } catch (e) { return e.name; } };\\n");',
    'const req = require(dir + "/req-" + name + ".mjs");',
    'let reqNow; try { reqNow = req.early + "," + req.v; } catch (e) { reqNow = req.early + "," + e.name; }',
    'import(dir + "/late-" + name + ".mjs").then((m) => "late=" + m.v, (e) => "late!" + (e.code || e.message))',
    '  .then((late) => import(dir + "/bad-" + name + ".mjs").then(() => late + " bad=resolved", (e) => late + " bad!" + e.message))',
    '  .then((line) => import(dir + "/top-" + name + ".mjs").then((m) => line + " transitive=" + m.read()))',
    '  .then((line) => console.log("TLA " + line + " req=" + reqNow + " later=" + req.v));',
  ].join('\n'),
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
    // A file URL's path is percent-decoded; one naming a host, another
    // scheme or an encoded "/" is refused with Node's code.
    'const tryPath = (u) => { try { return url.fileURLToPath(u); } catch (e) { return e.code; } };',
    'console.log("FILEURL " + JSON.stringify([tryPath("file:///tmp/a%20b"), tryPath(new URL("file:///tmp/%C3%A9t%C3%A9")), tryPath("file://localhost/etc/x"), tryPath("file://host/x"), tryPath("http://x/y"), tryPath("file:///a%2Fb"), url.pathToFileURL("/tmp/a b#c%").href]));',
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
      `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    const cells = await terminal.run(`cd ${W} && node cells.js`);
    assert.match(cells.stdout, /CELLS number,2,tr,tr-space,tab,tabx function:\/own\n/, cells.stdout);

    const grammar = await terminal.run(`cd ${W} && node grammar.js`);
    assert.equal(grammar.status, 0, grammar.stdout);
    assert.match(grammar.stdout, /^GRAMMAR true 7$/m, grammar.stdout);

    // One EventEmitter, workerd's: Node's function-constructor inheritance,
    // express's prototype mixin, native http servers and the static helpers.
    const tla = await terminal.run(`cd ${W} && node tla.js`);
    assert.match(tla.stdout, /TLA late=42 bad!tla failed transitive=ReferenceError req=1,ReferenceError later=42/, tla.stdout);

    const events = await terminal.run(`cd ${W} && node events.js`);
    assert.equal(events.status, 0, events.stdout);
    assert.match(events.stdout,
      /^EVENTS \{"legacy":\[1,true\],"mixin":true,"server":true,"stream":true,"legacyStream":true,"max":20,"captured":"rejected","once":7,"on":"a"\}$/m,
      events.stdout);

    const first = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(first.stdout,
      /FN fn=42 probe=true async=function gen=7 vm=15 vmexpr=5 vmstr=hello vmthis=true vmarrow=true breakout!SyntaxError where=interpreted file=written broke=undefined\n/,
      first.stdout);
    const second = await terminal.run(`cd ${W} && node fn.js`);
    assert.match(second.stdout, /FN fn=42 probe=true async=function gen=7 vm=15 vmexpr=5 vmstr=hello vmthis=true vmarrow=true breakout!SyntaxError where=native file=written broke=undefined\n/, second.stdout);
    // The diagnostic switch interprets what the launch staged: native and interpreted, side by side.
    const forced = await terminal.run(`cd ${W} && NIMBUS_RUNTIME_CODE=interpret node fn.js`);
    assert.match(forced.stdout, /FN fn=42 probe=true async=function gen=7 vm=15 vmexpr=5 vmstr=hello vmthis=true vmarrow=true breakout!SyntaxError where=interpreted file=written broke=undefined\n/, forced.stdout);
    // A module runner's whole SSR graph runs in the launch that produced it.
    const runnerFirst = await terminal.run(`cd ${W} && node runner.js`);
    assert.match(runnerFirst.stdout, /RUNNER value=111 imported=a,b,d,c\n/, runnerFirst.stdout);
    const runnerSecond = await terminal.run(`cd ${W} && node runner.js`);
    assert.match(runnerSecond.stdout, /RUNNER value=111 imported=a,b,d,c\n/, runnerSecond.stdout);
    const lexer = await terminal.run(`cd ${W} && node lexer-buffer.js`);
    assert.match(lexer.stdout, /LEXER 16 import é 255 255\n/, lexer.stdout);
    const dataFirst = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataFirst.stdout, /DATA \["café","\/",true,true,true,true,true\]/, dataFirst.stdout);
    const dataSecond = await terminal.run('cd ' + W + ' && node data.js');
    assert.match(dataSecond.stdout, /DATA \["café","\/",true,true,true,true,true\]/, dataSecond.stdout);

    for (const launch of ['first', 'next']) {
      const plain = await terminal.run(`cd ${W} && node plain.js`);
      assert.equal(plain.status, 0, plain.stdout);
      assert.match(plain.stdout, /^PLAIN 15$/m, `a function built as a module loads runs in the ${launch} launch`);
      assert.match(plain.stdout, /^PROBE yes$/m, `a probe answers yes in the ${launch} launch`);
      const reported = await terminal.run(`cd ${W} && node reported.js`);
      assert.equal(reported.status, 0, reported.stdout);
      assert.match(reported.stdout, /^REPORTED 7$/m, `request-time code runs in the ${launch} launch`);
    }
    // A probe, then an unrelated failure, then a clean next launch: the
    // probe and the check it guards answer alike in both.
    const unrelated = await terminal.run(`cd ${W} && touch fail.flag && node probe-fail.js`);
    assert.match(unrelated.stdout, /^PROBEFAIL true true$/m, unrelated.stdout);
    const clean = await terminal.run(`cd ${W} && rm fail.flag && node probe-fail.js`);
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /^PROBEFAIL true true$/m, clean.stdout);

    const urlRun = await terminal.run(`cd ${W} && node url.js`);
    const hostUrl = spawnSync('node', ['-e', FILES['url.js']], { encoding: 'utf8' });
    assert.equal(hostUrl.status, 0, hostUrl.stderr);
    assert.equal(/^URL .*$/m.exec(urlRun.stdout)?.[0], /^URL .*$/m.exec(hostUrl.stdout)?.[0], 'url.parse/resolve/format answer as node does');
    assert.equal(/^FILEURL .*$/m.exec(urlRun.stdout)?.[0], /^FILEURL .*$/m.exec(hostUrl.stdout)?.[0], 'fileURLToPath and pathToFileURL answer as node does');

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

    const bad = await terminal.run(`cd ${W} && node bad.js`);
    assert.match(bad.stdout, /\/home\/user\/w\/bad\.js\n\nSyntaxError/, bad.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-workerd: registry cells and runtime code behave as Node\'s under workerd');
