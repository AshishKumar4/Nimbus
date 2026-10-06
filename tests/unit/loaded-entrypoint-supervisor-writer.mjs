#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

{
  // One graph, so the bundled bindings and the composition module the test
  // registers the supervisor name through share ONE module instance.
  const { NimbusLoadedEntrypoint, composeFabric } = await importWorkerBundle({
    'packages/fabric/src/bindings.ts': ['NimbusLoadedEntrypoint'],
    'packages/fabric/src/composition.ts': ['composeFabric'],
  });
  composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });

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
    // What the schema decides, not zod's English for it: the message depends on
    // whether the bundle kept zod's locale side effect ("Invalid UUID" under bun
    // 1.4.0's bundler, "Invalid input" under 1.4.2's).
    (error) => {
      assert.equal(error?.name, 'ZodError');
      assert.deepEqual(
        error.issues.map(({ code, format, path }) => ({ code, format, path })),
        [{ code: 'invalid_format', format: 'uuid', path: ['supervisor', 'writerId'] }],
      );
      return true;
    },
  );

  console.log('loaded-entrypoint-supervisor-writer: all assertions passed');
}
