// The in-repo wasm runtimes (bash and CPython, built under packages/worker/wasm),
// written into a workspace as an install writes them. For the tests that run
// them off Cloudflare (core-wasm-runtime-bun, local-facet-realm).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

// The source under Bun, the built package under Node.
const { BASH_RUNNER } = await import(typeof process.versions.bun === 'string'
  ? '../../../packages/core/src/runtime/os-contracts.ts'
  : '../../../packages/core/dist/runtime/os-contracts.js');

const WASM_DIR = new URL('../../../packages/worker/wasm/', import.meta.url).pathname;
const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };

/**
 * The two runtimes, laid out exactly as `scripts/bundle-runtime.mjs` publishes
 * them. `null` content is a file the publisher synthesises rather than ships —
 * the stdlib marker is what makes the install root look like a Python prefix to
 * getpath.c, and without it the interpreter cannot find its own encodings.
 */
export const RUNTIMES = [
  {
    name: 'bash',
    version: '5.2.37-3',
    license: 'GPL-3.0-or-later',
    entrypoints: [{ binName: 'bash', runner: BASH_RUNNER, args: [] }],
    files: [
      ['share/bash/bash.async.wasm', `${WASM_DIR}bash/bash.async.wasm`],
      ['share/bash/coreutils/busybox.wasm', `${WASM_DIR}bash/coreutils/busybox.wasm`],
      ['share/bash/coreutils/busybox.applets', `${WASM_DIR}bash/coreutils/busybox.applets`],
    ],
  },
  {
    name: 'cpython',
    version: '3.13.14',
    license: 'PSF-2.0',
    entrypoints: [
      { binName: 'python', runner: 'cpython-runner', args: [] },
      { binName: 'python3', runner: 'cpython-runner', args: [] },
    ],
    files: [
      ['share/cpython/python.wasm', `${WASM_DIR}python/python.wasm`],
      ['lib/python313.zip', `${WASM_DIR}python/python313.zip`],
      ['etc/ssl/cert.pem', `${WASM_DIR}python/cacert.pem`],
      ['lib/python3.13/os.py', null, '# Nimbus stdlib marker.\n'],
    ],
  },
];

// The artifacts are committed, but a worktree mid-rebuild has neither.
/** The first runtime file not built in this tree, or null. */
export function missingRuntimeFile() {
  const missing = RUNTIMES.flatMap((r) => r.files).find(([, disk]) => disk !== null && !existsSync(disk));
  return missing ? missing[0] : null;
}

export const installRoot = (r) => `home/user/.nimbus/runtimes/${r.name}/${r.version}`;

/**
 * Write a runtime into the workspace exactly as an install does: the files
 * under their manifest paths, and a manifest.json beside them naming the runner
 * each command dispatches to. What makes a runtime invokable is this tree, not
 * the publisher that produced it.
 */
export function seedRuntime(vfs, runtime) {
  const fs = vfs.as(KERNEL);
  const root = installRoot(runtime);
  const files = [];
  const shipped = [...runtime.files];
  if (runtime.name === 'bash') {
    const names = readFileSync(`${WASM_DIR}bash/coreutils/busybox.applets`, 'utf8').split('\n').filter(Boolean);
    for (const name of names) shipped.push([`bin/${name}`, null, 'Nimbus WASI multicall entry\n']);
  }
  for (const [path, disk, synthetic] of shipped) {
    const bytes = disk === null ? Buffer.from(synthetic, 'utf8') : readFileSync(disk);
    const target = `${root}/${path}`;
    fs.mkdir(target.replace(/\/[^/]+$/, ''), { recursive: true });
    fs.writeFile(target, new Uint8Array(bytes), { mode: path.startsWith('bin/') ? 0o755 : 0o644 });
    files.push({
      path,
      content: `blobs/${runtime.name}-${runtime.version}/${path}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  }
  fs.writeFile(`${root}/manifest.json`, JSON.stringify({
    name: runtime.name,
    version: runtime.version,
    license: runtime.license,
    wasi_namespace: 'wasi_snapshot_preview1',
    files,
    entrypoints: runtime.entrypoints,
  }));
}
