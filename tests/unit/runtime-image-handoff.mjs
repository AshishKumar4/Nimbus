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
import { installedRuntime, runtimeContext } from './lib/runtime-session.mjs';

const IMAGE_BYTES = 3 * 1024 * 1024 + 11;
const image = Uint8Array.from({ length: IMAGE_BYTES }, (_, i) => (i * 7 + (i >> 12)) & 0xff);

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

const context = (filesystem, args) => runtimeContext(filesystem, { args }).ctx;

function assertHandedOff(raw, images, name) {
  assert.equal(images.length, 1, `${name}: ${images.length} images handed to the facet`);
  assert.equal(images[0].name, name);
  assert.deepEqual(new Uint8Array(images[0].bytes), image, `${name}: the facet got other bytes than were installed`);
  assert.equal(raw.getStats().cache.hotBytes, 0, `${name}: the image was left in the session content cache`);
}

{
  const { raw, filesystem } = installedRuntime({
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

// The facet is opened per invocation, under the invoking process's pid, and
// disposed after it: the supervisor capability is bound when it opens, so a
// facet held across calls would hand every later caller the first caller's
// write credential (cpython-runner.ts).
{
  const { filesystem } = installedRuntime({
    'runtime/python/share/cpython/python.wasm': image,
    'runtime/python/lib/python313.zip': new Uint8Array([1]),
  });
  const manifest = { version: '3.13.14', files: [{ path: 'share/cpython/python.wasm' }, { path: 'lib/python313.zip' }] };
  const opened = [];
  let disposed = 0;
  const host = {
    open(spec) {
      opened.push(spec.syscalls?.pid);
      return { async submit() { return { exitCode: 0, stdout: '', stderr: '' }; }, dispose() { disposed++; } };
    },
  };
  const run = makeCPythonRunnerFactory({ facets: host })(manifest, '/runtime/python', 'python', undefined);
  assert.equal(await run(runtimeContext(filesystem, { args: ['-c', 'print(1)'], pid: 41 }).ctx), 0);
  assert.equal(await run(runtimeContext(filesystem, { args: ['-c', 'print(2)'], pid: 42 }).ctx), 0);
  assert.deepEqual(opened, [41, 42], 'each invocation opens its own facet under its own pid');
  assert.equal(disposed, 2, 'each invocation disposes the facet it opened');
  console.log('  ok  python opens a facet per invocation, under the invoker\'s pid');
}

// A program that keeps serving runs as a resident process, whose host reads
// the image by path itself: the one-shot path's copy is never taken.
{
  const { raw, filesystem } = installedRuntime({
    'runtime/python/share/cpython/python.wasm': image,
    'runtime/python/lib/python313.zip': new Uint8Array([1]),
  });
  const manifest = { version: '3.13.14', files: [{ path: 'share/cpython/python.wasm' }, { path: 'lib/python313.zip' }] };
  const facets = recordingFacets();
  const started = [];
  const startResident = async (spec) => { started.push(spec.wasmVfsPath); return { exitCode: 0, stdout: '', stderr: '' }; };
  const run = makeCPythonRunnerFactory({ facets: facets.host, startResident })(manifest, '/runtime/python', 'python', undefined);

  assert.equal(await run(context(filesystem, ['-m', 'http.server', '8000'])), 0);
  assert.deepEqual(started, ['/runtime/python/share/cpython/python.wasm']);
  assert.equal(facets.images.length, 0, 'a resident python read the image for a facet it never ran');
  assert.equal(raw.getStats().cache.hotBytes, 0);
  console.log('  ok  resident python leaves the image to its host');
}

{
  const { raw, filesystem } = installedRuntime({ 'runtime/ruby/share/ruby/ruby+stdlib.wasm': image });
  const manifest = { files: [{ path: 'share/ruby/ruby+stdlib.wasm' }] };
  const facets = recordingFacets();
  const run = await makeRubyRunnerFactory({ facets: facets.host, filesystem, getHome: () => '/home/user' })(manifest, '/runtime/ruby', 'ruby', undefined);

  assert.equal(await run(context(filesystem, ['-e', 'puts 1'])), 0);
  assertHandedOff(raw, facets.images, 'ruby+stdlib.wasm');
  console.log('  ok  ruby hands its facet the installed image without caching it');
}

console.log('runtime-image-handoff: ok');
