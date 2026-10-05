/**
 * git/wave-bench.ts — how fast the session takes a clone's writes, with N producers.
 *
 * NIMBUS_DEBUG only (POST /api/_test/w7-bench). Each producer is a Dynamic
 * Worker running the clone's own wave writer (git/wave-writer.ts) over
 * synthetic files, publishing through SupervisorRPC.writeBatchStream exactly
 * as a clone's facet does, so the measured path is the production one:
 * producer → SupervisorRPC → session → SQLite. Contents are random, so
 * content addressing stores every byte. The answer is the files/s and MB/s
 * the session sustained, and what the producers waited on.
 */
import { getCtxExports } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { GIT_WAVE_WRITER_SRC } from './wave-writer.generated.js';
// The producer: the writer, fed random files as fast as it takes them.
const PRODUCER_SOURCE = GIT_WAVE_WRITER_SRC + `
export default {
  async fetch(request, env) {
    const { root, base, files, sizes, pings } = await request.json();
    const writer = __nimbusGitWaveWriter.createWaveWriter({ supervisor: env.SUPERVISOR, root, base });
    const pingStarted = Date.now();
    for (let index = 0; index < pings; index++) {
      await writer.file('ping/p' + index, 0o644, new Uint8Array([index & 0xff]));
      await writer.flush();
    }
    const pingMs = pings > 0 ? (Date.now() - pingStarted) / pings : 0;
    const started = Date.now();
    let bytes = 0;
    for (let index = 0; index < files; index++) {
      const size = sizes[index % sizes.length];
      const data = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        crypto.getRandomValues(data.subarray(offset, Math.min(size, offset + 65536)));
      }
      await writer.file('d' + (index % 64) + '/f' + index, 0o644, data);
      bytes += size;
    }
    await writer.flush();
    const stats = writer.stats();
    return Response.json({
      pingMs, files, bytes, wallMs: Date.now() - started, waves: stats.waves,
      rpcWallMs: stats.rpcWallMs, maxRpcWallMs: stats.maxRpcWallMs, producerWaitMs: stats.producerWaitMs,
    });
  },
};
`;
function isBenchEnv(env) {
    if (typeof env !== 'object' || env === null || !('LOADER' in env))
        return false;
    const loader = env.LOADER;
    return typeof loader === 'object' && loader !== null && 'load' in loader && typeof loader.load === 'function';
}
export async function runWaveBench(ctx, env, options) {
    if (!isBenchEnv(env))
        throw new Error('w7-bench: env.LOADER.load is not available');
    const exports = getCtxExports();
    if (!exports?.SupervisorRPC)
        throw new Error('w7-bench: SupervisorRPC binding is not available');
    const supervisor = exports.SupervisorRPC({ props: supervisorBindingProps(ctx, options.pid) });
    const started = Date.now();
    try {
        const perProducer = await Promise.all(Array.from({ length: options.producers }, async (_, index) => {
            const endFetch = beginLoaderFetch(ctx, `w7-bench:${crypto.randomUUID()}`);
            let worker;
            let entrypoint;
            try {
                worker = env.LOADER.load({
                    compatibilityDate: CF_COMPAT_DATE,
                    compatibilityFlags: [...GUEST_COMPAT_FLAGS],
                    mainModule: 'w7-bench-producer.js',
                    modules: { 'w7-bench-producer.js': PRODUCER_SOURCE },
                    env: { SUPERVISOR: supervisor },
                });
                entrypoint = worker.getEntrypoint();
                const response = await entrypoint.fetch(new Request('http://w7-bench/', {
                    method: 'POST',
                    body: JSON.stringify({
                        root: options.root,
                        base: `${options.root}/p${index}`,
                        files: options.files,
                        sizes: options.sizes,
                        pings: options.pings ?? 0,
                    }),
                }));
                try {
                    if (!response.ok)
                        throw new Error(`w7-bench producer ${index}: ${await response.text()}`);
                    const result = await response.json();
                    return result;
                }
                finally {
                    disposeRpcResource(response);
                }
            }
            finally {
                disposeRpcResource(entrypoint);
                disposeRpcResource(worker);
                endFetch();
            }
        }));
        const wallMs = Math.max(1, Date.now() - started);
        const files = perProducer.reduce((total, producer) => total + producer.files, 0);
        const bytes = perProducer.reduce((total, producer) => total + producer.bytes, 0);
        return {
            producers: options.producers,
            files,
            bytes,
            wallMs,
            filesPerSecond: Math.round(files / (wallMs / 1000)),
            mbPerSecond: Math.round((bytes / 1048576) / (wallMs / 1000) * 10) / 10,
            perProducer,
        };
    }
    finally {
        disposeRpcResource(supervisor);
    }
}
