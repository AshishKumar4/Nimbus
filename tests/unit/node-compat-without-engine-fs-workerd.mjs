// @serial
// @tier slow — bundles core's node-compat and runs it in workerd at an early compatibility date.
//
// createNodeCompat outside Nimbus (Kinu ask 70), in the isolate Kinu runs
// eval programs in: a Worker Loader isolate at compatibility date 2025-06-01
// with nodejs_compat, where the engine has no `node:fs`
// (`process.getBuiltinModule('node:fs')` is undefined). There, and in this
// process (an engine with its own `node:fs`):
// - createNodeCompat over an async face returns `fs`, and
//   `fs.promises.readFile('a.txt', 'utf8')` answers;
// - `fs.createReadStream` throws ENOSYS, as a face without descriptors makes
//   it, never a TypeError;
// - `readFile(p, 'base64')` and `readFile(p, 'hex')` answer the file's bytes
//   in that encoding, as Node's `buffer.toString(encoding)`, not its bytes
//   decoded as UTF-8 text;
// - `access` reports the stat's own errno (EIO, EACCES), not ENOENT for every
//   failed stat, as access(2) does.
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const repo = new URL('../../', import.meta.url).pathname;

// The program: the checks, over an in-memory async face, answering what each found.
const program = `import { createNodeCompat } from ${JSON.stringify(join(repo, 'packages/core/src/node-compat/index.ts'))};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const failing = (code) => Object.assign(new Error(code + ': ' + code.toLowerCase()), { code, syscall: 'stat' });
const stat = (size) => ({ dev: 1, ino: 2, nlink: 1, type: 'file', size, ctime: 0, atime: 0, mtime: 0, mode: 0o100644, uid: 0, gid: 0, revision: 1 });
const contents = { '/w/a.txt': new TextEncoder().encode('hello'), '/w/chart.png': PNG };
const files = {
  async stat(path) {
    if (path === '/w/eio') throw failing('EIO');
    if (path === '/w/eacces') throw failing('EACCES');
    if (!(path in contents)) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT', syscall: 'stat', path });
    return stat(contents[path].byteLength);
  },
  async lstat(path) { return this.stat(path); },
  async readFile(path) {
    if (!(path in contents)) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT', syscall: 'open', path });
    return contents[path];
  },
  async writeFile() {},
  async readdir() { return []; },
};

export async function checks() {
  const out = { engineFs: typeof process.getBuiltinModule === 'function' && process.getBuiltinModule('node:fs') !== undefined };
  let fs;
  try {
    ({ fs } = createNodeCompat({ files }, { cwd: '/w' }));
    out.loads = true;
  } catch (error) {
    out.loads = String(error);
    return out;
  }
  out.utf8 = await fs.promises.readFile('a.txt', 'utf8');
  try {
    fs.createReadStream('a.txt');
    out.stream = 'made';
  } catch (error) {
    out.stream = [error.constructor.name, error.code];
  }
  out.base64 = await fs.promises.readFile('chart.png', 'base64');
  out.hex = await fs.promises.readFile('chart.png', 'hex');
  out.buffer = [...(await fs.promises.readFile('chart.png'))];
  const accessed = async (path) => fs.promises.access(path).then(() => 'ok', (error) => [error.code, error.syscall, error.path]);
  out.access = { present: await accessed('a.txt'), missing: await accessed('none'), eio: await accessed('eio'), eacces: await accessed('eacces') };
  return out;
}
`;

const expected = (engineFs) => ({
  engineFs,
  loads: true,
  utf8: 'hello',
  stream: ['Error', 'ENOSYS'],
  base64: 'iVBORw==',
  hex: '89504e47',
  buffer: [0x89, 0x50, 0x4e, 0x47],
  access: { present: 'ok', missing: ['ENOENT', 'access', 'none'], eio: ['EIO', 'access', 'eio'], eacces: ['EACCES', 'access', 'eacces'] },
});

const root = mkdtempSync(join(tmpdir(), 'nimbus-node-compat-no-fs-'));
let served;
const failures = [];
try {
  const bundled = await build({
    stdin: { contents: program, loader: 'js', resolveDir: repo },
    bundle: true, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*', ...builtinModules],
    conditions: ['workerd', 'worker', 'import'], mainFields: ['module', 'main'], write: false, logLevel: 'silent',
  });
  const library = bundled.outputFiles[0].text;

  // Here: an engine with its own node:fs.
  const here = await import(`data:text/javascript;base64,${Buffer.from(library).toString('base64')}`);
  try {
    assert.deepEqual(await here.checks(), expected(true));
  } catch (error) {
    failures.push(`with the engine's node:fs: ${error.message}`);
  }

  // A Worker Loader isolate's: compatibility date 2025-06-01, nodejs_compat, no node:fs.
  served = await servePlainWorkerd({
    name: 'node-compat-no-fs',
    files: {
      'lib.js': library,
      'main.js': `import { checks } from './lib.js';\nexport default { async fetch() { try { return Response.json(await checks()); } catch (error) { return new Response(String(error && error.stack || error), { status: 500 }); } } };\n`,
    },
    config: ({ port }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [(name = "main", worker = (
  modules = [(name = "main.js", esModule = embed "main.js"), (name = "lib.js", esModule = embed "lib.js")],
  compatibilityDate = "2025-06-01", compatibilityFlags = ["nodejs_compat"]
 ))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);`,
  });
  const response = await fetch(`${served.base}/`, { signal: AbortSignal.timeout(60_000) });
  const body = await response.text();
  try {
    assert.equal(response.status, 200, `${body}\n${served.logs()}`);
    assert.deepEqual(JSON.parse(body), expected(false));
  } catch (error) {
    failures.push(`in a 2025-06-01 isolate: ${error.message}`);
  }
} finally {
  await served?.stop();
  rmSync(root, { recursive: true, force: true });
}

assert.deepEqual(failures, []);
console.log('node-compat-without-engine-fs-workerd: createNodeCompat loads with no node:fs, reads every encoding, and access reports the stat\'s errno');
