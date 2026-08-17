#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-loaded-entrypoint-writer-'));
try {
  // Two entries with splitting, so the bundled bindings and the ctx-exports
  // module the test registers the supervisor name through share ONE module
  // instance via the common chunk.
  const build = await Bun.build({
    entrypoints: [
      './packages/fabric/src/bindings.ts',
      './packages/fabric/src/ctx-exports.ts',
    ],
    splitting: true,
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'cloudflare-workers',
          namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class WorkerEntrypoint {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  const entry = build.outputs.find((output) => output.path.endsWith('/bindings.js'));
  assert.ok(entry);
  const ctxExportsEntry = build.outputs.find((output) => output.path.endsWith('/ctx-exports.js'));
  assert.ok(ctxExportsEntry);
  const { NimbusLoadedEntrypoint } = await import(pathToFileURL(entry.path).href);
  const { setSupervisorEntrypointName } = await import(pathToFileURL(ctxExportsEntry.path).href);
  setSupervisorEntrypointName('SupervisorRPC');

  const writerId = '11111111-1111-4111-8111-111111111111';
  let boundProps;
  const receiver = {
    ctx: {
      props: {
        key: 'writer-boundary-test',
        supervisor: {
          doId: 'coordinator-id',
          pid: 42,
          writerId,
        },
      },
      exports: {
        SupervisorRPC({ props }) {
          boundProps = props;
          return { props };
        },
      },
    },
  };

  const props = NimbusLoadedEntrypoint.prototype._props.call(receiver);
  await NimbusLoadedEntrypoint.prototype._supervisorBinding.call(receiver, props);
  assert.deepEqual(
    boundProps,
    { doId: 'coordinator-id', pid: 42, writerId },
    'the real entrypoint schema preserves the trusted writer incarnation through binding creation',
  );

  assert.throws(
    () => NimbusLoadedEntrypoint.prototype._props.call({
      ctx: {
        props: {
          key: 'invalid-writer-boundary-test',
          supervisor: { doId: 'coordinator-id', pid: 42, writerId: 'not-a-uuid' },
        },
      },
    }),
    /Invalid UUID/,
  );

  console.log('loaded-entrypoint-supervisor-writer: all assertions passed');
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
