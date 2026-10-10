/** The one live WASI fd1/fd2 relay, shared by every runtime and scheduler. */
export declare const WASI_OUTPUT_IN_FLIGHT_BYTES: number;
export interface WasiOutputTarget {
    stdout(bytes: Uint8Array): void | Promise<void>;
    stderr(bytes: Uint8Array): void | Promise<void>;
}
export declare function wasiOutputRelay(target: WasiOutputTarget): {
    stdoutBytes: (bytes: Uint8Array) => void | Promise<void>;
    stderrBytes: (bytes: Uint8Array) => void | Promise<void>;
    ready: () => Promise<void> | undefined;
    drain: () => Promise<string | null>;
};
//# sourceMappingURL=stdio.d.ts.map