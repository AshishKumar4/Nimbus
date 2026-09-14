#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { writeTarballStream } from '../../packages/core/src/_shared/tarball.ts';
import { createTar } from '../../packages/core/src/substrate/lifo/utils/archive.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function archive(entries) {
  return gzipSync(createTar(entries.map(([name, data]) => ({
    path: `package/${name}`, type: 'file', mode: 0o644, mtime: 0,
    data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
  }))));
}
const manifest = JSON.stringify({ name: 'example', version: '1.0.0', bin: { example: 'cli.js' } });
const entries = [['package.json', manifest], ['cli.js', 'console.log(42);'], ['./lib/data.bin', new Uint8Array([0, 255, 128])]];
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const vfs = ws.vfs.as(CRED_KERNEL);
const originalFetch = globalThis.fetch;
try {
  const order = [];
  const target = {
    exists: (path) => vfs.exists(path),
    mkdir: (path, options) => vfs.mkdir(path, options),
    async writeFile(path, data) {
      await Promise.resolve();
      order.push(path);
      vfs.writeFile(path, data);
    },
  };
  const result = await writeTarballStream(new Blob([archive(entries)]).stream(), '/pkg', target);
  assert.deepEqual(order, ['/pkg/cli.js', '/pkg/lib/data.bin', '/pkg/package.json']);
  assert.deepEqual(result, { files: 3, bytes: manifest.length + 'console.log(42);'.length + 3 });
  assert.deepEqual(vfs.readFile('/pkg/lib/data.bin'), new Uint8Array([0, 255, 128]));

  const failed = new Error('disk write failed');
  await assert.rejects(writeTarballStream(new Blob([archive(entries)]).stream(), '/failed', {
    ...target,
    writeFile: async () => { throw failed; },
  }), (error) => error === failed);
  assert.equal(vfs.exists('/failed/package.json'), false);
  await writeTarballStream(new Blob([archive(entries)]).stream(), '/failed', target);
  assert.equal(vfs.readFileString('/failed/package.json'), manifest);
  await assert.rejects(
    writeTarballStream(new Blob([archive([['cli.js', 'incomplete']])]).stream(), '/incomplete', target),
    /carried no package.json/,
  );
  assert.equal(vfs.exists('/incomplete/package.json'), false);
  // A second manifest in one archive is malformed input, not an overwrite.
  await assert.rejects(
    writeTarballStream(
      new Blob([archive([['package.json', manifest], ['cli.js', 'x'], ['package.json', manifest]])]).stream(),
      '/dup',
      target,
    ),
    /two package\.json entries/,
  );
  assert.equal(vfs.exists('/dup/package.json'), false, 'a rejected duplicate leaves no manifest');
  vfs.writeFile('/blocked', 'not a directory');
  await assert.rejects(writeTarballStream(new Blob([archive(entries)]).stream(), '/blocked', target));

  // The sink receives the first file while later archive bytes are still pending.
  const compressed = archive([['package.json', manifest], ['first', 'ready'],
    ...Array.from({ length: 12 }, (_, i) => [`part-${i}`, crypto.getRandomValues(new Uint8Array(65536))])]);
  let consumed = 0;
  const streamed = new ReadableStream({
    pull(controller) {
      if (consumed === compressed.length) return controller.close();
      const next = Math.min(consumed + 256, compressed.length);
      controller.enqueue(compressed.subarray(consumed, next));
      consumed = next;
    },
  });
  await writeTarballStream(streamed, '/streamed', {
    ...target,
    writeFile(path, data) {
      if (path === '/streamed/first') assert.ok(consumed < compressed.length);
      vfs.writeFile(path, data);
    },
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/example/latest')) return Response.json({
      name: 'example', version: '1.0.0', dist: { tarball: 'https://registry.test/example.tgz' },
    });
    assert.equal(String(url), 'https://registry.test/example.tgz');
    const response = new Response(archive(entries));
    response.arrayBuffer = () => { throw new Error('tarball must not be buffered'); };
    return response;
  };
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  const installed = await ws.exec('npm install example');
  assert.equal(installed.exitCode, 0, installed.stderr);
  assert.match(installed.stdout, /added 1 package/);
  assert.equal(await ws.fs.readFile('/home/user/node_modules/example/package.json'), manifest);

  const calls = [];
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
    installer: {
      async install(projectDir, options) {
        calls.push({ projectDir, options });
        return { installed: ['example'], failed: ['broken dependency'], totalFiles: 3, elapsed: 1250 };
      },
    },
  }));
  const hosted = await ws.exec('npm install -D example');
  assert.equal(hosted.exitCode, 1);
  assert.match(hosted.stderr, /npm ERR! broken dependency/);
  assert.match(hosted.stdout, /added 1 package \(3 files\) in 1.3s/);
  assert.equal(calls[0].projectDir, '/home/user');
  assert.deepEqual(calls[0].options.packages, ['example']);
  assert.equal(calls[0].options.production, false);
  assert.ok(calls[0].options.pid > 0);
  assert.ok(ws.registry.has('example'), 'host installs register local package bins');
  console.log('npm-streaming-extraction: streaming, completion, retry and host installer passed');
} finally {
  globalThis.fetch = originalFetch;
  harness.db.close();
}
