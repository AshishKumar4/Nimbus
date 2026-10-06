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
    filter?: string;
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
export { STALL_MS };
export declare function discover(options: UploadPackOptions): Promise<Advertisement>;
/** One request, and the pack it answers with. */
export declare function requestPack(options: UploadPackOptions, advertised: Set<string>, request: PackRequest): Promise<PackResponse>;
//# sourceMappingURL=upload-pack.d.ts.map