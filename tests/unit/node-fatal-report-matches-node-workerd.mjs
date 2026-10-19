// @serial
// @tier slow — workerd/Node differential: CI 35 s wall, 42 s CPU, 1.40 GiB peak (2026-10-11).
// What nothing caught ends the program as it ends Node 22.22.3's: the same
// stderr, byte for byte (but for the stack frames, which are the runtime's
// own beside the program's), and the same exit code (shims' fatal
// exception, node-shims.ts). The report: where it was thrown (the file, its
// line, a caret under the throw), the error as util.inspect shows it (its
// own properties, its cause), and Node's version; a rejection's from where
// the error was made, or Node's UnhandledPromiseRejection for a reason that
// is not an error; 'uncaughtException' and its monitor, a handler that
// takes it (the program goes on) or throws (exit 7, its stack as it is);
// 'exit' first, with process.exitCode, whose last value is the code. A
// file's CommonJS `this` is its exports, so its frame is Node's
// `Object.<anonymous>`. A module that does not compile is placed by the
// parser where V8 stops. Before, the guest printed the stack under
// "Uncaught exception:" and exited 1.
//
// Named limits (fine-print capabilities): an error a builtin throws, which
// Node places at its own library's source line, a value that is not an
// error, an error thrown away from where it was made or with its stack
// replaced, have no place or the place it was made at.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import { matchNodeInWorkerd, placed } from './lib/node-differential.mjs';

const W = '/home/user/fatal';
const FILES = {
  'sync.cjs': "const a = 1;\n  throw Object.assign(new TypeError('boom'), { code: 'E_X', extra: [1, 2] });\n",
  'rej.cjs': "Promise.reject(new Error('rejected'));\n",
  'rejstr.cjs': "Promise.reject('just a string');\n",
  'rejundef.cjs': 'Promise.reject();\n',
  'rejobj.cjs': 'Promise.reject({ a: 1 });\n',
  // Node reads the reason's own stack, and nothing else, through its traps.
  'rejproxy.cjs': "const traced = (trap) => (...args) => { console.error(trap, String(args[1] ?? '')); return Reflect[trap](...args); };\n"
    + "Promise.reject(new Proxy({}, { getPrototypeOf: traced('getPrototypeOf'), getOwnPropertyDescriptor: traced('getOwnPropertyDescriptor'), get: traced('get'), has: traced('has') }));\n",
  // Nor of a proxy it inherits from.
  'rejproto.cjs': "const traced = (trap) => (...args) => { console.error(trap, String(args[1] ?? '')); return Reflect[trap](...args); };\n"
    + "Promise.reject(Object.create(new Proxy({}, { getPrototypeOf: traced('getPrototypeOf'), getOwnPropertyDescriptor: traced('getOwnPropertyDescriptor'), get: traced('get'), has: traced('has') })));\n",
  'timer.cjs': 'setTimeout(() => {\n  null.x;\n}, 1);\n',
  'handler.cjs': "process.on('exit', (c) => { console.error('exit handler', c); });\nprocess.on('uncaughtException', () => { throw new TypeError('in handler'); });\nthrow new Error('first');\n",
  'exitcode.cjs': "process.on('exit', (c) => { console.error('exit handler', c, process.exitCode); process.exitCode = 9; });\nthrow new Error('x');\n",
  'handled.cjs': "process.on('uncaughtExceptionMonitor', (e, t) => console.error('monitor', e.message, t));\nprocess.on('uncaughtException', (e, t) => console.error('handled', e.message, t));\nthrow new Error('first');\n",
  'rejhandled.cjs': "process.on('uncaughtException', (e, t) => console.error('handled', e.message, t));\nPromise.reject(new Error('r'));\nsetTimeout(() => console.error('later'), 10);\n",
  'cause.cjs': "throw new Error('outer', { cause: new Error('inner') });\n",
  'minified.cjs': 'var a=1;function z(){throw new Error("deep")}var b=2;z();\n',
  'noname.cjs': "throw Object.assign(new Error('m'), { name: undefined });\n",
  'tab.cjs': "function f() {\n\tif (true) {\tthrow new Error('tabbed'); }\n}\nf();\n",
  'uni.cjs': "const s = 'h\u00e9llo'; throw new Error(s);\n",
  'multi.cjs': "throw Object.assign(\n  new Error('multi'), { z: 1 });\n",
  'fnthrow.cjs': "function make() { return new Error('made'); }\nthrow make();\n",
  'this.cjs': "console.error(this === module.exports);\nthrow new Error('this');\n",
  'bad.cjs': 'const broken = ;\n',
  'req.cjs': "const x = 1;\nrequire('./bad.cjs');\n",
  'code3.cjs': 'process.exitCode = 3;\n',
  'code4.cjs': "process.exitCode = '4';\nprocess.on('exit', (c) => console.error('exit', JSON.stringify(c)));\nprocess.exit();\n",
  'code257.cjs': 'process.exitCode = 257;\n',
  'codeneg.cjs': 'process.exitCode = -1;\n',
  'clearcode.cjs': 'process.exitCode = 7; process.exitCode = undefined;\n',
  'nullcode.cjs': 'process.exitCode = 7; process.exitCode = null;\n',
  'beforecode.cjs': 'process.on("beforeExit", () => { process.exitCode = 5; });\n',
  'beforework.cjs': 'let once = false; process.on("beforeExit", () => { if (!once) { once = true; setTimeout(() => { console.error("later"); process.exitCode = 6; }, 0); } });\n',
  'beforeprint.cjs': 'process.on("beforeExit", () => console.error("before"));\n',
  'beforewrite.cjs': 'process.on("beforeExit", () => { const fs = require("fs"); fs.writeFileSync("before.txt", "before-write"); console.error(fs.readFileSync("before.txt", "utf8")); });\n',
  'beforethrow.cjs': 'process.on("beforeExit", () => { throw new Error("before-exit failure"); });\n',
  'beforehandled.cjs': 'function broken() { throw new Error("before-exit failure"); } process.on("beforeExit", broken); process.on("uncaughtException", (error, kind) => { console.error(error.message, kind); process.removeListener("beforeExit", broken); setTimeout(() => { console.error("continued"); process.exitCode = 7; }, 0); }); process.on("exit", code => console.error("exit", code));\n',
  'input.js': 'throw new Error("in")\n',
};
const COMMANDS = [
  'node sync.cjs', 'node rej.cjs', 'node rejstr.cjs', 'node rejundef.cjs', 'node rejobj.cjs', 'node rejproxy.cjs', 'node rejproto.cjs', 'node timer.cjs',
  'node handler.cjs', 'node exitcode.cjs', 'node handled.cjs', 'node rejhandled.cjs', 'node cause.cjs',
  'node minified.cjs', 'node noname.cjs', 'node tab.cjs', 'node uni.cjs', 'node multi.cjs', 'node fnthrow.cjs',
  'node this.cjs', 'node bad.cjs', 'node req.cjs', 'node code3.cjs', 'node code4.cjs',
  'node code257.cjs', 'node codeneg.cjs', 'node clearcode.cjs', 'node nullcode.cjs', 'node beforecode.cjs', 'node beforework.cjs',
  'node beforeprint.cjs', 'node beforewrite.cjs', 'node beforethrow.cjs', 'node beforehandled.cjs',
  `node -e 'throw new Error("ev")'`, 'node - < input.js',
];

// What a command printed to fd 2, without stack frames (the runtime's own
// beside the program's) or the cause-stack elisions that count them.
const shown = (stderr, { from, root }) => placed(stderr, from, root)
  .split('\n').filter((line) => !/^\s+at /.test(line) && !/^\s*\.\.\. \d+ lines matching cause stack trace \.\.\.$/.test(line)).join('\n');
await matchNodeInWorkerd('node-fatal-report-matches-node-workerd', W, FILES, COMMANDS, { shown, streams: ['err'] });
console.log('node-fatal-report-matches-node-workerd: uncaught errors end the program as they end Node');
