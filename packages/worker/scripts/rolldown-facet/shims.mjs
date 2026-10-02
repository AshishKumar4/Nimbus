/**
 * Node modules rolldown's JavaScript imports that a build facet has no use
 * for, or that workerd's nodejs_compat may not answer as Node does: each is
 * what the bundling path of rolldown reads of it, and nothing else. Anything
 * else of them that runs throws, naming itself.
 */
const unsupported = (what) => () => { throw new Error(`Nimbus's build facet does not support ${what}`); };

// node:worker_threads: not the main thread (no trace subscriber), and no workers (parallel plugins).
export const isMainThread = false;
export class Worker { constructor() { unsupported('worker_threads.Worker')(); } }
export class MessageChannel { constructor() { unsupported('worker_threads.MessageChannel')(); } }

// node:tty, node:os: no terminal, no colour.
export const isatty = () => false;
export class WriteStream { constructor() { unsupported('tty.WriteStream')(); } }
export const EOL = '\n';
export const platform = () => 'linux';
export const homedir = () => '/';
export const tmpdir = () => '/tmp';
export const cpus = () => [];

// node:util: plain text.
export const styleText = (_format, text) => text;
export const formatWithOptions = (_options, ...args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
export const inspect = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

// node:module: no CommonJS loading.
export class Module {}
export const createRequire = () => unsupported('require');

// node:fs, node:fs/promises: modules come from the plugin; nothing is read.
export const readFileSync = unsupported('fs.readFileSync');
export const existsSync = () => false;
export const readFile = unsupported('fs.readFile');
export const writeFile = unsupported('fs.writeFile');
export const stat = unsupported('fs.stat');

// node:process
export const env = {};
export const cwd = () => '/';
export const argv = [];
export const versions = {};
export const stdin = { isTTY: false, on() {} };
export const stdout = { isTTY: false, write() {} };
export const stderr = { isTTY: false, write() {} };
export const exit = unsupported('process.exit');
export const on = () => {};

// node:readline, node:child_process: no prompts, no processes.
export const createInterface = unsupported('readline.createInterface');
export const spawn = unsupported('child_process.spawn');
export const execSync = unsupported('child_process.execSync');

// node:url
export const fileURLToPath = (url) => decodeURIComponent(new URL(String(url)).pathname);
export const pathToFileURL = (path) => new URL(`file://${encodeURI(path)}`);

const self = {
  isMainThread, Worker, MessageChannel, isatty, WriteStream, EOL, platform, homedir, tmpdir, cpus, styleText, formatWithOptions, inspect,
  Module, createRequire, readFileSync, existsSync, readFile, writeFile, stat, env, cwd, argv, stdin, versions, stdout, stderr, exit, on,
  fileURLToPath, pathToFileURL, createInterface, spawn, execSync, promises: { readFile, writeFile, stat },
};
export default self;
