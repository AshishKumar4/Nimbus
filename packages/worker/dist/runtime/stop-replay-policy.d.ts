type Projection = (value: unknown) => unknown;
export interface ReplayPolicy {
    kind: 'observation' | 'effect' | 'open' | 'output' | 'input' | 'control';
    /** Exact, operation-local rules; never strip a property by its name globally. */
    answer?: Projection;
    args?: (args: readonly unknown[]) => readonly unknown[];
    /** Only these fields have a separate input-tape contract. */
    inputFields?: readonly string[];
}
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
export declare const REPLAY_OPERATION_POLICY: {
    readFile: {
        readonly kind: "observation";
    };
    readFileBytes: {
        readonly kind: "observation";
    };
    writeFile: {
        readonly kind: "effect";
    };
    writeFileStat: {
        readonly kind: "effect";
    };
    stat: {
        readonly kind: "observation";
    };
    lstat: {
        readonly kind: "observation";
    };
    hasLegacySymlinkUnder: {
        readonly kind: "observation";
    };
    utimes: {
        readonly kind: "effect";
    };
    chmod: {
        readonly kind: "effect";
    };
    access: {
        readonly kind: "observation";
    };
    chown: {
        readonly kind: "effect";
    };
    setUmask: {
        readonly kind: "observation";
    };
    readdir: {
        readonly kind: "observation";
    };
    exists: {
        readonly kind: "observation";
    };
    mkdir: {
        readonly kind: "effect";
    };
    rmdir: {
        readonly kind: "effect";
    };
    rename: {
        readonly kind: "effect";
    };
    unlink: {
        readonly kind: "effect";
    };
    readlink: {
        readonly kind: "observation";
    };
    fsLinkLeadsTo: {
        readonly kind: "observation";
    };
    symlink: {
        readonly kind: "effect";
    };
    fsAcquire: {
        kind: "observation";
        answer: (value: unknown) => unknown;
        args: (a: readonly unknown[]) => unknown[];
    };
    fsAcquired: {
        kind: "observation";
        answer: (value: unknown) => unknown;
        args: (a: readonly unknown[]) => unknown[];
    };
    fsRevision: {
        readonly kind: "observation";
    };
    fsList: {
        kind: "observation";
        answer: (value: unknown) => {
            entries?: unknown[];
        } | null;
    };
    fsStorageGrant: {
        kind: "observation";
        args: (a: readonly unknown[]) => unknown[];
    };
    wsOpen: {
        readonly kind: "effect";
    };
    wsPoll: {
        readonly kind: "observation";
    };
    wsSend: {
        readonly kind: "effect";
    };
    wsClose: {
        readonly kind: "effect";
    };
    fsOpen: {
        kind: "open";
    };
    fsRead: {
        readonly kind: "observation";
    };
    fsWrite: {
        readonly kind: "effect";
    };
    fsClose: {
        readonly kind: "observation";
    };
    fsReadRange: {
        readonly kind: "observation";
    };
    fsReadRangeUncached: {
        readonly kind: "observation";
    };
    fsReadBatch: {
        readonly kind: "observation";
    };
    fsWriteRange: {
        readonly kind: "effect";
    };
    fsAppend: {
        readonly kind: "effect";
    };
    fsAppendAck: {
        readonly kind: "effect";
    };
    fsTruncate: {
        readonly kind: "effect";
    };
    writeBatch: {
        readonly kind: "effect";
    };
    writeBatchStream: {
        readonly kind: "effect";
    };
    putRegistryEntries: {
        readonly kind: "effect";
    };
    stdout: {
        readonly kind: "output";
    };
    stderr: {
        readonly kind: "output";
    };
    prefetch: {
        readonly kind: "observation";
    };
    registerPort: {
        readonly kind: "effect";
    };
    allocatePort: {
        readonly kind: "effect";
    };
    unregisterPort: {
        readonly kind: "effect";
    };
    reportExit: {
        readonly kind: "output";
    };
    routeLoopback: {
        readonly kind: "effect";
    };
    transform: {
        readonly kind: "observation";
    };
    cpSpawn: {
        readonly kind: "effect";
    };
    reportRuntimeCode: {
        readonly kind: "output";
    };
    cpStdinWrite: {
        readonly kind: "effect";
    };
    cpStdinEnd: {
        readonly kind: "effect";
    };
    cpReadStdin: {
        kind: "input";
        inputFields: string[];
    };
    stdinFileRead: {
        kind: "input";
        inputFields: string[];
    };
    stdinPrepared: {
        readonly kind: "control";
    };
    getCachedTarball: {
        readonly kind: "observation";
    };
    getPackument: {
        readonly kind: "observation";
    };
    putCachedTarball: {
        readonly kind: "effect";
    };
    cacheResult: {
        readonly kind: "control";
    };
    cpReadOutput: {
        kind: "observation";
        answer: (value: unknown) => unknown;
        args: (a: readonly unknown[]) => unknown[];
    };
    cpDrainOutput: {
        readonly kind: "observation";
    };
    cpKill: {
        readonly kind: "effect";
    };
    cpBlocked: {
        kind: "control";
    };
    cpWait: {
        kind: "observation";
        answer: (value: unknown) => unknown;
        args: (a: readonly unknown[]) => unknown[];
    };
    fsFstat: {
        readonly kind: "observation";
    };
    fsDup: {
        readonly kind: "observation";
    };
    fsSeek: {
        readonly kind: "observation";
    };
    fsSetStatus: {
        readonly kind: "effect";
    };
    fsReaddirHandle: {
        readonly kind: "observation";
    };
    fsFtruncate: {
        readonly kind: "effect";
    };
    fsFchmod: {
        readonly kind: "effect";
    };
    fsFchown: {
        readonly kind: "effect";
    };
    fsFutimes: {
        readonly kind: "effect";
    };
    fsSync: {
        readonly kind: "observation";
    };
    fsRealpath: {
        readonly kind: "observation";
    };
    fsRemove: {
        readonly kind: "effect";
    };
    fsCopyFile: {
        readonly kind: "effect";
    };
    fsCopyTree: {
        readonly kind: "effect";
    };
    fsAcquireExclusiveMutation: {
        readonly kind: "effect";
    };
    fsReleaseExclusiveMutation: {
        readonly kind: "effect";
    };
    innerDoFetch: {
        readonly kind: "effect";
    };
    innerDoCall: {
        readonly kind: "effect";
    };
    fanoutExecute: {
        readonly kind: "effect";
    };
    processHostProbe: {
        readonly kind: "effect";
    };
    hostProcess: {
        readonly kind: "effect";
    };
    awaitHostedOpen: {
        readonly kind: "effect";
    };
    awaitHostedBoot: {
        readonly kind: "effect";
    };
    routeHostedHttp: {
        readonly kind: "effect";
    };
    cancelHostProcess: {
        readonly kind: "effect";
    };
    hmrRelay: {
        readonly kind: "effect";
    };
    hmrNextEvent: {
        readonly kind: "effect";
    };
    replayBoundary: {
        readonly kind: "control";
    };
    netTls: {
        readonly kind: "effect";
    };
    outbound: {
        readonly kind: "control";
    };
};
export declare function operationPolicy(op: string): ReplayPolicy | undefined;
/** Public RPC methods that deliberately delegate or implement a protocol. */
export declare const REPLAY_PUBLIC_METHOD_POLICY: {
    readonly answer: {
        readonly kind: "validated-filesystem-delegation";
    };
    readonly fetch: {
        readonly kind: "journaled-outbound-protocol";
    };
    readonly connect: {
        readonly kind: "effectful-outbound-protocol";
    };
};
export declare const SUPERVISOR_CALLS_WITHOUT_EFFECTS: readonly string[];
export declare const REPLAY_OBSERVATION_CALLS: readonly string[];
export {};
//# sourceMappingURL=stop-replay-policy.d.ts.map