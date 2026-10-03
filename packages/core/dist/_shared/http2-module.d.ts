/**
 * node:http2 as Nimbus provides it: exactly the names Node 22 exports, for
 * both node runtimes (the node shims a facet runs, and the substrate's
 * node-compat module map), from this one source.
 *
 * Nimbus serves HTTP/1.1 only, so nothing here opens a session or a server:
 * `createServer`, `createSecureServer`, `performServerHandshake` and the two
 * compatibility classes' constructors throw ERR_HTTP2_NOT_SUPPORTED, and
 * `connect` returns a client session that reports the same error, as a
 * failed connection does. What is pure computation is Node's:
 * `getDefaultSettings`, the 6-byte SETTINGS entries `getPackedSettings`
 * writes and `getUnpackedSettings` reads (lib/internal/http2/core.js and
 * util.js, with nghttp2's payload check), and `constants`. The two server
 * classes are real classes over the runtime's own streams, so an HTTP/1
 * request or response is never an instance of them (Astro's dev server asks
 * `res instanceof Http2ServerResponse` of every response).
 *
 * Self-contained: the node shims embed this function's compiled text
 * (scripts/bundle-facet-workers.mjs), so it reaches nothing outside itself
 * but `host`.
 */
/** What the runtime embedding the module supplies. */
export interface Http2ModuleHost {
    EventEmitter: new () => {
        emit(event: string, ...args: unknown[]): boolean;
    };
    /** Node's Http2ServerRequest is a Readable. */
    Readable: new () => Record<never, never>;
    /** Node's Http2ServerResponse is a Stream (the legacy base class). */
    Stream: new () => Record<never, never>;
    Buffer: {
        alloc(size: number): Uint8Array;
    };
    /** process.emitWarning, where the runtime has one. */
    emitWarning?: (message: string) => void;
}
/** A settings object, as Node's settings functions take and return one. */
export interface Http2Settings {
    headerTableSize?: number;
    enablePush?: boolean;
    initialWindowSize?: number;
    maxFrameSize?: number;
    maxConcurrentStreams?: number;
    maxHeaderListSize?: number;
    maxHeaderSize?: number;
    enableConnectProtocol?: boolean;
    customSettings?: Record<string, number>;
}
export declare function createHttp2Module(host: Http2ModuleHost): {
    connect: (_authority: unknown, _options?: unknown, _listener?: unknown) => {
        destroyed: boolean;
        closed: boolean;
        request(): never;
        settings(): void;
        close(callback?: () => void): void;
        destroy(error?: unknown): void;
        emit(event: string, ...args: unknown[]): boolean;
    };
    constants: Record<string, string | number>;
    createServer: (_options?: unknown, _onRequestHandler?: unknown) => never;
    createSecureServer: (_options?: unknown, _onRequestHandler?: unknown) => never;
    getDefaultSettings: () => Http2Settings;
    getPackedSettings: (settings?: Http2Settings) => Uint8Array<ArrayBufferLike> | undefined;
    getUnpackedSettings: (buf: ArrayLike<number>, options?: {
        validate?: boolean;
    } | null) => Http2Settings;
    performServerHandshake: (_socket: unknown, _options?: {}) => never;
    sensitiveHeaders: symbol;
    Http2ServerRequest: {
        new (_stream: unknown, _headers: unknown, _options: unknown, _rawHeaders: unknown): {};
    };
    Http2ServerResponse: {
        new (_stream: unknown, _options: unknown): {};
    };
};
//# sourceMappingURL=http2-module.d.ts.map