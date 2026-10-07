/**
 * git/pack/upload-pack.ts — the client side of git's smart HTTP fetch
 * (Documentation/gitprotocol-http.txt, gitprotocol-pack.txt), protocol v0.
 *
 * discover() reads the advertisement; requestPack() sends one request (wants,
 * shallows, deepen, filter, haves, done: no multi-round negotiation) and
 * returns the shallow lines and the pack as a stream that is read only as
 * fast as its consumer pulls, so nothing between the network and the pack
 * processor buffers more than one side-band packet.
 */
import { STALL_MS } from './transport.js';
export interface GitTransportAuth {
    username: string;
    password: string;
}
export interface UploadPackOptions {
    url: string;
    auth?: GitTransportAuth;
    /**
     * The server's progress (side-band 2), a finished line at a time: a
     * phase's last line ("Compressing objects: 100% (42/42), done.") and its
     * summary ("Total ..."), not every percentage step it redraws over.
     */
    onProgress?(line: string): void;
    /** For tests: the fetch to use. */
    fetch?: typeof fetch;
    /** How long a response may send nothing (STALL_MS). */
    stallMs?: number;
    signal?: AbortSignal;
}
export interface Advertisement {
    /** Ref name → id, peeled tags under "<name>^{}". */
    refs: Map<string, string>;
    /** Symbolic refs the server named (symref=HEAD:refs/heads/main). */
    symrefs: Map<string, string>;
    capabilities: Set<string>;
}
export interface PackRequest {
    wants: readonly string[];
    haves?: readonly string[];
    /** The receiver's shallow commits (its .git/shallow). */
    shallows?: readonly string[];
    depth?: number;
    /** deepen-since: history after this time (seconds since the epoch). */
    deepenSince?: number;
    /** deepen-not: history not reachable from these refs. */
    deepenNot?: readonly string[];
    /** deepen-relative: `depth` counts from the receiver's shallow boundary. */
    deepenRelative?: boolean;
    filter?: string;
    /** include-tag: annotated tags of the objects sent come with them (on unless false). */
    includeTag?: boolean;
    /** Ask for a thin pack: deltas against `haves` the server need not send. */
    thin?: boolean;
}
export interface PackResponse {
    shallows: string[];
    unshallows: string[];
    /** The pack's bytes; null when the server answered that there is nothing to send. */
    pack: AsyncIterable<Uint8Array> | null;
}
export declare class UploadPackError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare function pktLine(text: string): Uint8Array;
export declare function headers(options: UploadPackOptions, extra: Record<string, string>): Record<string, string>;
export declare function repoUrl(url: string): string;
export { STALL_MS };
/** pkt-lines off a byte stream, pulled one at a time; null is a flush. */
export declare class PktReader {
    private readonly reader;
    private readonly stallMs;
    private buffer;
    private done;
    constructor(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs?: number);
    /** The next chunk, or a stall error when none comes in time (the read is cancelled). */
    private read;
    private fill;
    /** The next packet's payload, null for a flush, undefined at the stream's end. */
    next(): Promise<Uint8Array | null | undefined>;
    cancel(): Promise<void>;
}
export declare function text(payload: Uint8Array): string;
/** The refs and capabilities `service` (upload-pack for a fetch, receive-pack for a push) advertises. */
export declare function discover(options: UploadPackOptions, service?: 'git-upload-pack' | 'git-receive-pack'): Promise<Advertisement>;
/** One request, and the pack it answers with. */
export declare function requestPack(options: UploadPackOptions, advertised: Set<string>, request: PackRequest): Promise<PackResponse>;
//# sourceMappingURL=upload-pack.d.ts.map