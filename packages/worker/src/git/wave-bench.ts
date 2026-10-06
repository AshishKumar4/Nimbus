/**
 * git/wave-bench.ts — how fast the session takes a clone's writes, with N producers.
 *
 * NIMBUS_DEBUG only (POST /api/_test/w7-bench). Each producer is a Dynamic
 * Worker running the clone's own wave writer (platform wave-writer.ts) over
 * synthetic files, publishing through SupervisorRPC.writeBatchStream exactly
 * as a clone's facet does, so the measured path is the production one:
 * producer → SupervisorRPC → session → SQLite. Contents are random, so
 * content addressing stores every byte. The answer is the files/s and MB/s
 * the session sustained, and what the producers waited on.
 */

import { ISOLATE_NETWORK } from '@nimbus-sh/core/_shared/workspace-network.js';
import * as workers from 'cloudflare:workers';
import { getCtxExports } from '@nimbus-sh/fabric/composition.js';
import { beginLoaderFetch } from '@nimbus-sh/fabric/budgets.js';
import { supervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { WAVE_WRITER_PREAMBLE } from '../loaders/generated-workers.js';

/**
 * Where a producer's waves go, to tell the costs on the way apart:
 * - supervisor: SupervisorRPC.writeBatchStream, as a clone's facet (two hops);
 * - vfs: straight to the session's VFS.writeStream (one hop);
 * - vfs-bytes: the encoded wave as one RPC argument, no stream (one hop);
 * - drain: the session reads the stream and writes nothing;
 * - drain-writing: the session reads it, committing one small row per read.
 */
export type WaveBenchSinkMode = 'supervisor' | 'vfs' | 'vfs-bytes' | 'drain' | 'drain-writing';

/** The session side of the bench's direct modes. */
export interface WaveBenchSession {
  writeStream(stream: ReadableStream<Uint8Array>): Promise<unknown>;
  sql: SqlStorage;
}

export interface WaveBenchOptions {
  /** The process whose credential the producers write as. */
  pid: number;
  sink: WaveBenchSinkMode;
  /** VFS directory the producers write below (p0, p1, …). */
  root: string;
  producers: number;
  /** Files per producer. */
  files: number;
  /** File sizes, cycled. */
  sizes: number[];
  /** One-file waves each producer sends first, flushed one at a time: the per-wave round trip. */
  pings?: number;
}

/**
 * One wave as its producer saw it: sent, first and last pulled by the
 * transport, answered. (A Durable Object's clock stands still while it
 * computes, so the session cannot time its side of a wave.)
 */
export interface WaveBenchWave {
  sentAt: number;
  firstPullAt: number;
  lastPullAt: number;
  pulls: number;
  bytes: number;
  answeredAt: number;
  /** The longest the transport went without pulling from this wave's stream. */
  maxGapMs: number;
}

export interface WaveBenchProducer {
  /** Mean wall of a one-file wave, sent and published alone. */
  pingMs: number;
  /** Its median, 95th percentile and slowest. */
  pingP50Ms: number;
  pingP95Ms: number;
  pingMaxMs: number;
  timeline: WaveBenchWave[];
  files: number;
  bytes: number;
  wallMs: number;
  waves: number;
  rpcWallMs: number;
  maxRpcWallMs: number;
  producerWaitMs: number;
}

export interface WaveBenchResult {
  producers: number;
  files: number;
  bytes: number;
  wallMs: number;
  filesPerSecond: number;
  mbPerSecond: number;
  perProducer: WaveBenchProducer[];
}

interface BenchProducerParams {
  root: string;
  base: string;
  files: number;
  sizes: number[];
  pings: number;
  mode: WaveBenchSinkMode;
}

interface BenchEntrypoint {
  run(params: BenchProducerParams, sink: WaveBenchSinkTarget): Promise<WaveBenchProducer>;
}

interface BenchWorker {
  getEntrypoint(name: string): BenchEntrypoint;
}

interface BenchEnv {
  LOADER: { load(code: object): BenchWorker };
}

// The producer: the writer, fed random files as fast as it takes them. Each
// wave's stream is observed where it leaves the producer: when it was sent,
// when the transport first and last pulled from it, and when its answer
// came back.
const PRODUCER_SOURCE = WAVE_WRITER_PREAMBLE + `
function observed(send, waves) {
  return {
    writeBatchStream(stream) {
      const wave = { sentAt: Date.now(), firstPullAt: 0, lastPullAt: 0, pulls: 0, bytes: 0, answeredAt: 0, maxGapMs: 0 };
      const reader = stream.getReader();
      const tapped = new ReadableStream({
        type: 'bytes',
        async pull(controller) {
          const pulledAt = Date.now();
          if (wave.firstPullAt === 0) wave.firstPullAt = pulledAt;
          else wave.maxGapMs = Math.max(wave.maxGapMs, pulledAt - wave.lastPullAt);
          wave.lastPullAt = pulledAt;
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          wave.pulls++;
          wave.bytes += next.value.byteLength;
          controller.enqueue(next.value);
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return send(tapped).then((result) => {
        wave.answeredAt = Date.now();
        waves.push(wave);
        return result;
      });
    },
  };
}

import { WorkerEntrypoint } from 'cloudflare:workers';

function sender(mode, env, sink) {
  switch (mode) {
    case 'supervisor': return (stream) => env.SUPERVISOR.writeBatchStream(stream);
    case 'vfs': return (stream) => sink.vfs(stream);
    case 'drain': return (stream) => sink.drain(stream);
    case 'drain-writing': return (stream) => sink.drainWriting(stream);
    case 'vfs-bytes': return async (stream) => sink.vfsBytes(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  throw new Error('w7-bench: unknown sink ' + mode);
}

export class Producer extends WorkerEntrypoint {
  async run(params, sink) {
    const { root, base, files, sizes, pings, mode } = params;
    const env = this.env;
    const waves = [];
    const writer = __nimbusWaveWriter.createWaveWriter({ supervisor: observed(sender(mode, env, sink), waves), root, base });
    const pingStarted = Date.now();
    const pingWalls = [];
    for (let index = 0; index < pings; index++) {
      const one = Date.now();
      await writer.file('ping/p' + index, 0o644, new Uint8Array([index & 0xff]));
      await writer.flush();
      pingWalls.push(Date.now() - one);
    }
    const pingMs = pings > 0 ? (Date.now() - pingStarted) / pings : 0;
    pingWalls.sort((a, b) => a - b);
    const pingAt = (q) => (pingWalls.length === 0 ? 0 : pingWalls[Math.min(pingWalls.length - 1, Math.floor(q * pingWalls.length))]);
    waves.length = 0;
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
    return {
      pingMs, pingP50Ms: pingAt(0.5), pingP95Ms: pingAt(0.95), pingMaxMs: pingAt(1), files, bytes, wallMs: Date.now() - started, waves: stats.waves,
      rpcWallMs: stats.rpcWallMs, maxRpcWallMs: stats.maxRpcWallMs, producerWaitMs: stats.producerWaitMs,
      timeline: waves,
    };
  }
}

export default { fetch() { return new Response('w7-bench producer', { status: 404 }); } };
`;

/** The session end of a direct mode, as a producer calls it. */
interface WaveBenchSinkTarget {
  vfs(stream: ReadableStream<Uint8Array>): Promise<unknown>;
  vfsBytes(bytes: Uint8Array): Promise<unknown>;
  drain(stream: ReadableStream<Uint8Array>): Promise<unknown>;
  drainWriting(stream: ReadableStream<Uint8Array>): Promise<unknown>;
}

/**
 * The session end of a direct mode, handed to each producer as an RPC stub.
 * Made when a bench runs, not when this module loads: a session module is
 * loaded where cloudflare:workers has no RpcTarget (unit stubs).
 */
function waveBenchSink(session: WaveBenchSession): WaveBenchSinkTarget {
  return new (class WaveBenchSink extends workers.RpcTarget {
    constructor(private readonly session: WaveBenchSession) {
      super();
    }

    async vfs(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      return this.session.writeStream(stream);
    }

    async vfsBytes(bytes: Uint8Array): Promise<unknown> {
      return this.session.writeStream(new Response(bytes).body!);
    }

    async drain(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      return this.read(stream, false);
    }

    async drainWriting(stream: ReadableStream<Uint8Array>): Promise<unknown> {
      return this.read(stream, true);
    }

    private async read(stream: ReadableStream<Uint8Array>, writing: boolean): Promise<unknown> {
      const reader = stream.getReader({ mode: 'byob' });
      let reads = 0;
      let bytes = 0;
      let buffer = new ArrayBuffer(64 * 1024);
      if (writing) this.session.sql.exec('CREATE TABLE IF NOT EXISTS nimbus_bench_drain (id INTEGER PRIMARY KEY, n INTEGER)');
      for (;;) {
        const next = await reader.read(new Uint8Array(buffer));
        if (next.done) break;
        reads++;
        bytes += next.value.byteLength;
        buffer = next.value.buffer;
        if (writing) this.session.sql.exec('INSERT INTO nimbus_bench_drain (n) VALUES (?)', next.value.byteLength);
      }
      return { ok: true, committedGroupSequence: 0, committedPathCount: 0, inodes: 0, chunks: 0, receipts: [], reads, bytes };
    }
  })(session);
}

function isBenchEnv(env: unknown): env is BenchEnv {
  if (typeof env !== 'object' || env === null || !('LOADER' in env)) return false;
  const loader = env.LOADER;
  return typeof loader === 'object' && loader !== null && 'load' in loader && typeof loader.load === 'function';
}

export async function runWaveBench(
  ctx: DurableObjectState,
  env: unknown,
  options: WaveBenchOptions,
  session: WaveBenchSession,
): Promise<WaveBenchResult> {
  const sink = waveBenchSink(session);
  if (!isBenchEnv(env)) throw new Error('w7-bench: env.LOADER.load is not available');
  const exports = getCtxExports();
  if (!exports?.SupervisorRPC) throw new Error('w7-bench: SupervisorRPC binding is not available');
  const supervisor = exports.SupervisorRPC({ props: supervisorBindingProps(ctx, options.pid, { writerId: crypto.randomUUID(), network: ISOLATE_NETWORK }) });
  const started = Date.now();
  try {
    const perProducer = await Promise.all(Array.from({ length: options.producers }, async (_, index) => {
      const endFetch = beginLoaderFetch(ctx, `w7-bench:${crypto.randomUUID()}`);
      let worker: BenchWorker | undefined;
      let entrypoint: BenchEntrypoint | undefined;
      try {
        worker = env.LOADER.load({
          compatibilityDate: CF_COMPAT_DATE,
          compatibilityFlags: [...GUEST_COMPAT_FLAGS],
          mainModule: 'w7-bench-producer.js',
          modules: { 'w7-bench-producer.js': PRODUCER_SOURCE },
          env: { SUPERVISOR: supervisor },
        });
        entrypoint = worker.getEntrypoint('Producer');
        const result = await entrypoint.run({
          root: options.root,
          base: `${options.root}/p${index}`,
          files: options.files,
          sizes: options.sizes,
          pings: options.pings ?? 0,
          mode: options.sink,
        }, sink);
        try {
          return { ...result, timeline: result.timeline.map((wave) => ({ ...wave })) };
        } finally {
          disposeRpcResource(result);
        }
      } finally {
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
  } finally {
    disposeRpcResource(supervisor);
  }
}
