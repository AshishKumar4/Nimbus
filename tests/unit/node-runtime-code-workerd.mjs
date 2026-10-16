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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { NODE_UNUSED_SOCKETS } from './lib/node-unused-socket-program.mjs';

const W = '/home/user/w';
const FILES = {
  'unused-sockets.js': NODE_UNUSED_SOCKETS,
  'identity.js': [
    'const locale = new Intl.DateTimeFormat().resolvedOptions().locale;',
    'const identity = { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, languages: navigator.languages };',
    'if (identity.userAgent !== "Node.js/" + process.version.slice(1).split(".")[0]) throw new Error("navigator does not identify this Node version");',
    'if (identity.language !== locale || identity.languages.length !== 1 || identity.languages[0] !== locale) throw new Error("navigator does not use this process ICU locale");',
    'if (!Object.isFrozen(navigator.languages) || navigator.languages !== navigator.languages) throw new Error("navigator languages must be a stable frozen list");',
    'console.log("IDENTITY " + JSON.stringify(identity));',
  ].join('\n'),
  'pg-transport.js': [
    'const { getStream } = require("pg/lib/stream");',
    'const stream = getStream(false);',
    'console.log("PGTRANSPORT " + (stream instanceof require("net").Socket));',
    'stream.destroy();',
  ].join('\n'),
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
  // A name cjs-module-lexer finds: what Node's import() of a CommonJS module has besides its default.
  'grammar-dep.js': 'exports.value = 7;',
  // A late graph holding TypeScript written while the program runs: the
  // launch compiles it next time, and refuses the graph before any of its
  // bodies runs (a staged sibling's included).
  'late-a.mjs': 'console.log("LATE A");',
  'late-ts.mjs': [
    'import { writeFileSync } from "node:fs";',
    'if (globalThis.never) await import("./late-a.mjs");',
    'writeFileSync(new URL("./late.ts", import.meta.url), "const n: number = 1;\\nconsole.log(\\"LATE TS \\" + n);\\n");',
    'writeFileSync(new URL("./late-root.mjs", import.meta.url), "import \\"./late-a.mjs\\";\\nimport \\"./late.ts\\";\\n");',
    'try { await import("./late-root.mjs"); console.log("LATE loaded"); } catch (e) { console.log("LATE " + e.code); }',
  ].join('\n'),
  // A JSX entry, which the launch compiles (node and bun alike): Bun runs it
  // so, and its output is the reference.
  'app.jsx': 'globalThis.React = { createElement: (type) => ({ type }) };\nconsole.log("JSX " + (<b/>).type);\n',
  // Module files written while the program runs (so interpreted), each with
  // top-level await: import() resolves once the module has finished, and
  // rejects with what its evaluation throws; require() refuses the module,
  // as Node's does (ERR_REQUIRE_ASYNC_MODULE), before it runs. An
  // interpreted module that imports it statically waits for it, as Node's
  // does (`transitive`: 42).
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
    'let reqNow; try { reqNow = require(dir + "/req-" + name + ".mjs").early; } catch (e) { reqNow = e.code; }',
    'import(dir + "/late-" + name + ".mjs").then((m) => "late=" + m.v, (e) => "late!" + (e.code || e.message))',
    '  .then((late) => import(dir + "/bad-" + name + ".mjs").then(() => late + " bad=resolved", (e) => late + " bad!" + e.message))',
    '  .then((line) => import(dir + "/top-" + name + ".mjs").then((m) => line + " transitive=" + m.read()))',
    '  .then((line) => console.log("TLA " + line + " req=" + reqNow));',
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
  // follow-redirects (axios's http adapter) and pre-class stream modules inherit
  // by calling the constructor: Node's stream classes are functions.
  'legacy-streams.js': [
    'const { Writable, Readable, Duplex, Transform, PassThrough } = require("stream");',
    'const out = {};',
    'function W(o) { Writable.call(this, o); } W.prototype = Object.create(Writable.prototype);',
    'const text = (c) => String(c);',
    'new W({ write(c, e, cb) { out.w = text(c); cb(); } }).end("w1");',
    'function R(o) { Readable.call(this, o); } R.prototype = Object.create(Readable.prototype);',
    'const r = new R({ read() {} }); r.on("data", (d) => { out.r = text(d); }); r.push("r1"); r.push(null);',
    'function T(o) { Transform.call(this, o); } T.prototype = Object.create(Transform.prototype);',
    'const t = new T({ transform(c, e, cb) { cb(null, text(c).toUpperCase()); } }); t.on("data", (d) => { out.t = text(d); }); t.end("t1");',
    'function D(o) { Duplex.call(this, o); } D.prototype = Object.create(Duplex.prototype);',
    'const d = new D({ read() {}, write(c, e, cb) { out.d = text(c); cb(); } }); d.end("d1");',
    'function P(o) { PassThrough.call(this, o); } P.prototype = Object.create(PassThrough.prototype);',
    'const p = new P(); p.on("data", (c) => { out.p = text(c); }); p.end("p1");',
    'out.instances = [new W() instanceof Writable, r instanceof Readable, t instanceof Transform, d instanceof Duplex, p instanceof PassThrough];',
    'out.unconstructed = [Writable() instanceof Writable, Readable() instanceof Readable, Duplex() instanceof Duplex, Transform() instanceof Transform];',
    'out.names = [Writable.name, Readable.name, Duplex.name, Transform.name, PassThrough.name];',
    'const keys = ["w", "r", "t", "d", "p", "instances", "unconstructed", "names"];',
    'setTimeout(() => console.log("LEGACYSTREAMS " + JSON.stringify(Object.fromEntries(keys.map((k) => [k, out[k]])))), 50);',
  ].join('\n'),
  // pipeline's destination used as it is, a stream that is only written to
  // (no pipe) and async-iterable as streamx's Writable is (tar-fs's extract,
  // the end of create-react-router's pipeline(input, gunzip(), extract)).
  'pipeline-writable.js': [
    'const { pipeline, Readable } = require("stream");',
    'const { EventEmitter } = require("events");',
    'class Sink extends EventEmitter {',
    '  constructor() { super(); this.got = []; this.writable = true; }',
    '  write(chunk) { this.got.push(Buffer.from(chunk).toString()); return true; }',
    '  end() { this.ended = true; queueMicrotask(() => { this.emit("finish"); this.emit("close"); }); return this; }',
    '  destroy(error) { if (error) this.emit("error", error); return this; }',
    '  async *[Symbol.asyncIterator]() {}',
    '}',
    'const sink = new Sink();',
    'pipeline(Readable.from(["a", "b"]), sink, (error) => console.log("PIPELINE " + JSON.stringify({ error: error ? error.message : null, got: sink.got, ended: !!sink.ended })));',
  ].join('\n'),
  // The stream front a program runs on is the platform's node:stream, and its
  // files' and children's streams are its classes: backpressure, lifecycle
  // order, pipeline and its errors, stream/promises, stream/consumers,
  // destroy, fs's read and write streams (a write stream owns what it has
  // acknowledged; a read stream's close callback comes after its 'close'),
  // and a child whose stdout a failing pipeline destroys still closes, and one
  // that keeps writing to a stdout its parent destroyed gets EPIPE, as a
  // transcript node writes the same.
  'stream-lifecycle.js': [
    'const { Readable, Writable, Transform, PassThrough } = require("stream");',
    'const sp = require("stream/promises");',
    'const consumers = require("stream/consumers");',
    'const fs = require("fs");',
    'const log = [];',
    'const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    '(async () => {',
    '  const w = new Writable({ highWaterMark: 4, write(c, e, cb) { log.push("w:" + c); setTimeout(cb, 1); } });',
    '  for (const name of ["drain", "finish", "close"]) w.on(name, () => log.push("w-" + name));',
    '  for (const chunk of ["ab", "cd", "ef"]) log.push("ret:" + w.write(chunk));',
    '  await new Promise((resolve) => w.once("drain", resolve));',
    '  w.end("gh", () => log.push("end-cb"));',
    '  await sp.finished(w);',
    '  await tick(5);',
    '  const r = new Readable({ read() {} });',
    '  r.push("x"); r.push("y"); r.push(null);',
    '  const seen = [];',
    '  for await (const c of r) seen.push(String(c));',
    '  log.push("r:" + seen.join(","));',
    '  const out = [];',
    '  await sp.pipeline(Readable.from(["a", "b"]), new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); }, flush(cb) { this.push("!"); cb(); } }),',
    '    new Writable({ write(c, e, cb) { out.push(String(c)); cb(); } }));',
    '  log.push("t:" + out.join(""));',
    '  log.push("perr:" + await sp.pipeline(new Readable({ read() { this.destroy(new Error("boom")); } }), new PassThrough()).then(() => "none", (e) => e.message));',
    '  const d = new PassThrough();',
    '  d.on("error", (e) => log.push("d-error:" + e.message)); d.on("close", () => log.push("d-close"));',
    '  d.destroy(new Error("x"));',
    '  await tick(5);',
    '  log.push("c:" + await consumers.text(Readable.from(["h", "i"])) + ":" + JSON.stringify(await consumers.json(Readable.from([\'{"a":\', "1}"]))) + ":" + (await consumers.buffer(Readable.from([Buffer.from("z")]))).length);',
    '  fs.writeFileSync("s.txt", "0123456789");',
    '  const parts = [];',
    '  for await (const c of fs.createReadStream("s.txt", { highWaterMark: 4, start: 2, end: 7 })) parts.push(String(c));',
    '  log.push("fs:" + parts.join("|"));',
    '  const ws = fs.createWriteStream("o.txt");',
    '  ws.write("p"); ws.end("q");',
    '  await sp.finished(ws);',
    '  log.push("fsw:" + fs.readFileSync("o.txt", "utf8"));',
    '  const reused = new Uint8Array([97]);',
    '  const own = fs.createWriteStream("own.txt");',
    '  await new Promise((resolve) => own.write(reused, () => { reused[0] = 98; own.end(resolve); }));',
    '  log.push("own:" + fs.readFileSync("own.txt", "utf8"));',
    '  const rs = fs.createReadStream("s.txt");',
    '  await new Promise((resolve) => { rs.on("close", () => log.push("rs-close")); rs.close((e) => { log.push("rs-cb:" + (e && e.code)); resolve(); }); });',
    '  const child = require("child_process").spawn("node", ["-e", "process.stdout.write(\\"x\\")"]);',
    '  const ends = [];',
    '  await new Promise((resolve) => {',
    '    sp.pipeline(child.stdout, new Writable({ write(c, e, cb) { cb(new Error("sink")); } })).catch((e) => ends.push("pipe:" + e.message));',
    '    child.stderr.resume();',
    '    child.on("close", (code) => { ends.push("close:" + code); resolve(); });',
    '  });',
    '  await tick(5);',
    '  log.push("cp:" + ends.sort().join(","));',
    '  const writer = require("child_process").spawn("node", ["-e", "process.stdout.on(\\"error\\", (e) => process.exit(e.code === \\"EPIPE\\" ? 42 : 1)); setInterval(() => process.stdout.write(\\"y\\".repeat(1024)), 1);"]);',
    '  writer.stdout.once("data", () => writer.stdout.destroy());',
    '  writer.stderr.resume();',
    '  log.push("epipe:" + await new Promise((resolve) => writer.on("close", (code) => resolve(code))));',
    '  console.log("STREAMS " + JSON.stringify(log));',
    '})();',
  ].join('\n'),
  // The terminal's classes a program constructs itself: a ReadStream reads
  // the process's stdin (and, destroyed, leaves it as it was), a WriteStream
  // writes its stdout or stderr.
  'tty.js': [
    'const tty = require("tty");',
    'const input = new tty.ReadStream(0);',
    'let got = "";',
    'input.on("data", (c) => { got += c; });',
    'input.on("end", () => { input.destroy(); });',
    'input.on("close", () => { new tty.WriteStream(2).write("TTY-ERR\\n"); new tty.WriteStream(1).write("TTY " + JSON.stringify(got) + " " + process.stdin.listenerCount("data") + "\\n"); });',
  ].join('\n'),
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

    const hostIdentity = spawnSync('node', ['-e', FILES['identity.js']], { encoding: 'utf8' });
    assert.equal(hostIdentity.status, 0, hostIdentity.stderr);
    for (const launch of ['first', 'next']) {
      const identity = await terminal.run(`cd ${W} && node identity.js`);
      assert.equal(identity.status, 0, identity.stdout);
      assert.equal(identity.stdout.split('\n').find((line) => line.startsWith('IDENTITY ')), hostIdentity.stdout.trim(),
        `navigator identifies Node with the process ICU locale in the ${launch} launch`);
    }
    const pgInstall = await terminal.run(`cd ${W} && npm install pg@8.16.3`);
    assert.equal(pgInstall.status, 0, pgInstall.stdout);
    const pgTransport = await terminal.run(`cd ${W} && node pg-transport.js`);
    assert.equal(pgTransport.status, 0, pgTransport.stdout);
    assert.ok(pgTransport.stdout.split('\n').includes('PGTRANSPORT true'), 'standard pg uses its Node socket transport');
    const unused = await terminal.run(`cd ${W} && node unused-sockets.js`);
    const hostUnused = spawnSync('node', ['-e', NODE_UNUSED_SOCKETS], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(hostUnused.status, 0, hostUnused.stderr);
    assert.equal(unused.status, 0, unused.stdout);
    assert.equal(unused.stdout.split('\n').find((line) => line.startsWith('UNUSED_SOCKETS ')), hostUnused.stdout.trim(),
      'sockets that never connect, including destroyed and unrefed ones, do not hold the program alive');

    const cells = await terminal.run(`cd ${W} && node cells.js`);
    assert.match(cells.stdout, /CELLS number,2,tr,tr-space,tab,tabx function:\/own\n/, cells.stdout);

    const lateTs = await terminal.run(`cd ${W} && node late-ts.mjs`);
    assert.equal(lateTs.status, 0, lateTs.stdout);
    assert.match(lateTs.stdout, /^LATE ERR_NIMBUS_CODE_NEXT_LAUNCH$/m, lateTs.stdout);
    assert.doesNotMatch(lateTs.stdout, /LATE A/, `no body of a graph that does not load runs:\n${lateTs.stdout}`);

    const grammar = await terminal.run(`cd ${W} && node grammar.js`);
    assert.equal(grammar.status, 0, grammar.stdout);
    assert.match(grammar.stdout, /^GRAMMAR true 7$/m, grammar.stdout);

    const jsxHost = mkdtempSync(join(tmpdir(), 'node-runtime-code-jsx-'));
    try {
      writeFileSync(join(jsxHost, 'app.jsx'), FILES['app.jsx']);
      const reference = spawnSync('bun', ['app.jsx'], { cwd: jsxHost, encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(reference.stdout, 'JSX b\n', `bun runs the JSX entry: ${reference.stderr}`);
    } finally {
      rmSync(jsxHost, { recursive: true, force: true });
    }
    for (const runtime of ['node', 'bun']) {
      const jsx = await terminal.run(`cd ${W} && ${runtime} app.jsx`);
      assert.equal(jsx.status, 0, `${runtime} app.jsx: ${jsx.stdout}`);
      assert.match(jsx.stdout, /^JSX b$/m, `${runtime} runs the compiled JSX entry as Bun does:\n${jsx.stdout}`);
    }

    // One EventEmitter, workerd's: Node's function-constructor inheritance,
    // express's prototype mixin, native http servers and the static helpers.
    const tla = await terminal.run(`cd ${W} && node tla.js`);
    assert.match(tla.stdout, /TLA late=42 bad!tla failed transitive=42 req=ERR_REQUIRE_ASYNC_MODULE/, tla.stdout);

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

    const legacyRun = await terminal.run(`cd ${W} && node legacy-streams.js`);
    const hostLegacy = spawnSync('node', ['-e', FILES['legacy-streams.js']], { encoding: 'utf8' });
    assert.equal(hostLegacy.status, 0, hostLegacy.stderr);
    assert.match(hostLegacy.stdout, /^LEGACYSTREAMS \{"w":"w1","r":"r1","t":"T1","d":"d1","p":"p1"/m, hostLegacy.stdout);
    assert.equal(/^LEGACYSTREAMS .*$/m.exec(legacyRun.stdout)?.[0], /^LEGACYSTREAMS .*$/m.exec(hostLegacy.stdout)?.[0],
      `a stream constructor called on its subclass's instance answers as node does: ${legacyRun.stdout}`);

    const pipelineRun = await terminal.run(`cd ${W} && node pipeline-writable.js`);
    const hostPipeline = spawnSync('node', ['-e', FILES['pipeline-writable.js']], { encoding: 'utf8' });
    assert.equal(hostPipeline.status, 0, hostPipeline.stderr);
    assert.match(hostPipeline.stdout, /^PIPELINE \{"error":null,"got":\["a","b"\],"ended":true\}$/m, hostPipeline.stdout);
    assert.equal(/^PIPELINE .*$/m.exec(pipelineRun.stdout)?.[0], /^PIPELINE .*$/m.exec(hostPipeline.stdout)?.[0],
      `pipeline writes into a destination that has no pipe of its own, as node does: ${pipelineRun.stdout}`);

    const streamsRun = await terminal.run(`cd ${W} && node stream-lifecycle.js`);
    const hostDir = mkdtempSync(join(tmpdir(), 'stream-lifecycle-'));
    const hostStreams = spawnSync('node', ['-e', FILES['stream-lifecycle.js']], { encoding: 'utf8', cwd: hostDir });
    rmSync(hostDir, { recursive: true, force: true });
    assert.equal(hostStreams.status, 0, hostStreams.stderr);
    assert.match(hostStreams.stdout, /^STREAMS \[.*"fsw:pq","own:a","rs-close","rs-cb:ERR_STREAM_PREMATURE_CLOSE","cp:close:0,pipe:sink","epipe:42"\]$/m, hostStreams.stdout);
    assert.equal(/^STREAMS .*$/m.exec(streamsRun.stdout)?.[0], /^STREAMS .*$/m.exec(hostStreams.stdout)?.[0],
      `streams run as node's do: ${streamsRun.stdout}`);

    const ttyRun = await terminal.run(`cd ${W} && echo TTY-IN | node tty.js`);
    assert.match(ttyRun.stdout, /^TTY "TTY-IN\\n" 0$/m, `a tty.ReadStream reads stdin and lets go of it, a tty.WriteStream writes stdout: ${JSON.stringify(ttyRun)}`);
    assert.match(`${ttyRun.stdout}${ttyRun.stderr ?? ''}`, /TTY-ERR/, 'and fd 2 its stderr');

    const pathRun = await terminal.run(`cd ${W} && node path.js`);
    const hostPath = spawnSync('node', ['-e', FILES['path.js']], { encoding: 'utf8' });
    assert.equal(hostPath.status, 0, hostPath.stderr);
    assert.equal(/^PATH .*$/m.exec(pathRun.stdout)?.[0], /^PATH .*$/m.exec(hostPath.stdout)?.[0], 'node:path answers as node does');
    const cwdRun = await terminal.run(`cd ${W} && node -e "const p = require('path'); console.log('CWD ' + p.resolve('x') + ' ' + p.relative('x', '/') + ' ' + p.resolve())"`);
    assert.match(cwdRun.stdout, new RegExp(`^CWD ${W}/x \\.\\./\\.\\./\\.\\./\\.\\. ${W}$`, 'm'), 'resolve and relative start from the process cwd');

    const bad = await terminal.run(`cd ${W} && node bad.js`);
    // Where it stops, as Node's report places it (node-fatal-report-matches-node-workerd).
    assert.ok(bad.stdout.includes('/home/user/w/bad.js:1\nconst x = ;\n          ^\n\nSyntaxError: Unexpected token \';\''), bad.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-workerd: registry cells and runtime code behave as Node\'s under workerd');
