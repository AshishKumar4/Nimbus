import type { SupervisorOpName } from '@nimbus-sh/core/workspace/supervisor-op.js';

type Projection = (value: unknown) => unknown;
export interface ReplayPolicy {
  kind: 'observation' | 'effect' | 'open' | 'output' | 'input' | 'control';
  /** Exact, operation-local rules; never strip a property by its name globally. */
  answer?: Projection;
  args?: (args: readonly unknown[]) => readonly unknown[];
  /** Only these fields have a separate input-tape contract. */
  inputFields?: readonly string[];
}
const omit = (value: unknown, keys: readonly string[]): unknown => {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
};
const acquire = (value: unknown): unknown => {
  const v = omit(value, ['epoch', 'rev']) as { paths?: unknown[] } | null;
  return v && Array.isArray(v.paths) ? { ...v, paths: v.paths.map((p) => omit(p, ['rev'])) } : v;
};
const acquireArgs = (value: unknown): unknown => omit(value, ['epoch', 'cursor']);
const delivered = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const v = value as { args?: unknown; answer?: unknown };
  return { ...v, args: acquireArgs(v.args), answer: acquire(v.answer) };
};
const withAcquire = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || !('acquired' in value)) return value;
  return { ...value, acquired: delivered(value.acquired) };
};
const read = { kind: 'observation' } as const;
const effect = { kind: 'effect' } as const;
const output = { kind: 'output' } as const;
const control = { kind: 'control' } as const;

/**
 * The complete session-boundary policy. New operations fail closed both at
 * compile time (the Record) and at runtime (a missing entry is an effect).
 * Coherence cursors locate a cached version, never a program value; their
 * namespace/stat/content payloads ARE program values and remain in digests.
 * Output acknowledgements are void and checked by the output-prefix protocol.
 * Input preparation has its own identity: its bytes are owned by StdinTaken
 * and the guest's stdin-read tape, not mistaken for a read of a named file.
 * Control operations implement the boundary/network protocols themselves.
 */
export const REPLAY_OPERATION_POLICY = {
  readFile: read, readFileBytes: read, writeFile: effect, writeFileStat: effect,
  stat: read, lstat: read, hasLegacySymlinkUnder: read, utimes: effect,
  chmod: effect, access: read, chown: effect, setUmask: read,
  readdir: read, exists: read, mkdir: effect, rmdir: effect, rename: effect,
  unlink: effect, readlink: read, fsLinkLeadsTo: read, symlink: effect,
  fsAcquire: { kind: 'observation', answer: acquire, args: (a) => [a[2]] },
  fsAcquired: { kind: 'observation', answer: withAcquire, args: (a) => [acquireArgs(a[0]), a[1], a[2]] },
  fsRevision: read,
  fsList: { kind: 'observation', answer: (value) => {
    const v = omit(value, ['epoch', 'rev']) as { entries?: unknown[] } | null;
    return v && Array.isArray(v.entries) ? { ...v, entries: v.entries.map((e) => omit(e, ['rev'])) } : v;
  } },
  // The cache's physical facet name is not exposed by Node; its grant is.
  fsStorageGrant: { kind: 'observation', args: (a) => a.slice(1) },
  wsOpen: effect, wsPoll: read, wsSend: effect, wsClose: effect,
  fsOpen: { kind: 'open' }, fsRead: read, fsWrite: effect, fsClose: read,
  fsReadRange: read, fsReadRangeUncached: read, fsReadBatch: read,
  fsWriteRange: effect, fsAppend: effect, fsAppendAck: effect,
  fsTruncate: effect, writeBatch: effect, writeBatchStream: effect,
  // Mints a write-wave epoch the session holds open for the live process (state on the host, not a read).
  openWaveWriter: effect,
  putRegistryEntries: effect, stdout: output, stderr: output, prefetch: read,
  registerPort: effect, allocatePort: effect, unregisterPort: effect,
  reportExit: output, routeLoopback: effect, transform: read,
  cpSpawn: effect, reportRuntimeCode: output, cpStdinWrite: effect,
  cpStdinEnd: effect,
  cpReadStdin: { kind: 'input', inputFields: ['data', 'ended'] },
  stdinFileRead: { kind: 'input', inputFields: ['data', 'size'] },
  stdinPrepared: control,
  getCachedTarball: read, getPackument: read, putCachedTarball: effect,
  cacheResult: control,
  cpReadOutput: { kind: 'observation', answer: withAcquire, args: (a) => [...a.slice(0, 4), acquireArgs(a[4])] },
  cpDrainOutput: read, cpKill: effect,
  cpBlocked: { kind: 'control' },
  cpWait: { kind: 'observation', answer: withAcquire, args: (a) => [...a.slice(0, 2), acquireArgs(a[2])] },
  fsFstat: read, fsDup: read, fsSeek: read,
  fsSetStatus: effect, fsReaddirHandle: read, fsFtruncate: effect,
  fsFchmod: effect, fsFchown: effect, fsFutimes: effect, fsSync: read,
  fsRealpath: read, fsRemove: effect, fsCopyFile: effect, fsCopyTree: effect,
  fsAcquireExclusiveMutation: effect, fsReleaseExclusiveMutation: effect,
  innerDoFetch: effect, innerDoCall: effect, fanoutExecute: effect, processHostProbe: effect,
  hostProcess: effect, awaitHostedOpen: effect, awaitHostedBoot: effect,
  routeHostedHttp: effect, cancelHostProcess: effect, hostLost: effect, hmrRelay: effect,
  hmrNextEvent: effect, replayBoundary: control, netTls: effect, outbound: control,
} satisfies Record<SupervisorOpName, ReplayPolicy>;

export function operationPolicy(op: string): ReplayPolicy | undefined {
  return Object.hasOwn(REPLAY_OPERATION_POLICY, op)
    ? REPLAY_OPERATION_POLICY[op as keyof typeof REPLAY_OPERATION_POLICY] : undefined;
}

/** Public RPC methods that deliberately delegate or implement a protocol. */
export const REPLAY_PUBLIC_METHOD_POLICY = {
  answer: { kind: 'validated-filesystem-delegation' },
  fetch: { kind: 'journaled-outbound-protocol' },
  connect: { kind: 'effectful-outbound-protocol' },
} as const;
export const SUPERVISOR_CALLS_WITHOUT_EFFECTS: readonly string[] = [
  ...Object.entries(REPLAY_OPERATION_POLICY).filter(([, p]) => p.kind !== 'effect' && p.kind !== 'open').map(([name]) => name),
  // Object protocol, not supervisor operations.
  'then', 'constructor', 'toString', 'valueOf', 'toJSON',
];
export const REPLAY_OBSERVATION_CALLS: readonly string[] = Object.entries(REPLAY_OPERATION_POLICY)
  .filter(([, p]) => p.kind === 'observation' || p.kind === 'open').map(([name]) => name);
