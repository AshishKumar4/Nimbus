#!/usr/bin/env bun
// A runtime's interpreter image reaches its facet without taking over the
// session's content cache.
//
// python.wasm (10-19 MiB) and ruby+stdlib.wasm (34 MiB) are read on every
// invocation, including the warm-up `nimbus install python` runs. Read
// through the cached path they filled the 32 MiB chunk LRU in the session's
// own isolate and stayed there, on top of the copies handed to the facet. The
// facet must still get the installed bytes, exactly.

import assert from 'node:assert/strict';
import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const IMAGE_BYTES = 3 * 1024 * 1024 + 11;
const image = Uint8Array.from({ length: IMAGE_BYTES }, (_, i) => (i * 7 + (i >> 12)) & 0xff);

function installed(files) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', USER.uid, USER.gid);
  for (const [path, bytes] of Object.entries(files)) {
    root.mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o755 });
    root.writeFile(path, bytes, { mode: 0o644 });
  }
  return { raw, filesystem: new SqliteFilesystemAuthority(raw) };
}

/** A facet host that records every wasm image it is handed. */
function recordingFacets() {
  const images = [];
  const take = (modules) => { for (const [name, bytes] of Object.entries(modules ?? {})) images.push({ name, bytes }); };
  return {
    images,
    host: {
      open(spec) {
        take(spec.wasmModules);
        return {
          async submit(_fn, _args, options) {
            take(options?.wasmModules);
            return { exitCode: 0, stdout: '', stderr: '' };
          },
          dispose() {},
        };
      },
    },
  };
}

const context = (filesystem, args) => ({
  pid: 41,
  cred: USER,
  vfs: new ExecutionFs(filesystem.bind({ pid: 41, cred: USER })),
  args,
  cwd: '/home/user',
  env: {},
  stdin: '',
  stdout: { write() {} },
  stderr: { write() {} },
});

function assertHandedOff(raw, images, name) {
  assert.equal(images.length, 1, `${name}: ${images.length} images handed to the facet`);
  assert.equal(images[0].name, name);
  assert.deepEqual(new Uint8Array(images[0].bytes), image, `${name}: the facet got other bytes than were installed`);
  assert.equal(raw.getStats().cache.hotBytes, 0, `${name}: the image was left in the session content cache`);
}

{
  const { raw, filesystem } = installed({
    'runtime/python/share/cpython/python.wasm': image,
    'runtime/python/lib/python313.zip': new Uint8Array([1]),
  });
  const manifest = { version: '3.13.14', files: [{ path: 'share/cpython/python.wasm' }, { path: 'lib/python313.zip' }] };
  const facets = recordingFacets();
  const run = makeCPythonRunnerFactory({ facets: facets.host })(manifest, '/runtime/python', 'python', undefined);

  assert.equal(await run(context(filesystem, ['-c', 'print(1)'])), 0);
  assertHandedOff(raw, facets.images, 'python.wasm');
  console.log('  ok  python hands its facet the installed image without caching it');
}

{
  const { raw, filesystem } = installed({ 'runtime/ruby/share/ruby/ruby+stdlib.wasm': image });
  const manifest = { files: [{ path: 'share/ruby/ruby+stdlib.wasm' }] };
  const facets = recordingFacets();
  const run = await makeRubyRunnerFactory({ facets: facets.host, filesystem })(manifest, '/runtime/ruby', 'ruby', undefined);

  assert.equal(await run(context(filesystem, ['-e', 'puts 1'])), 0);
  assertHandedOff(raw, facets.images, 'ruby+stdlib.wasm');
  console.log('  ok  ruby hands its facet the installed image without caching it');
}

console.log('runtime-image-handoff: ok');
