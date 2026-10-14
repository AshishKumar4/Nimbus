import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
/** A body as a KV or R2 binding takes it, after it has crossed to the session. */
export type BindingBody = string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array | ArrayBuffer> | Blob | null | undefined;
export declare function ensureBindingDir(vfs: Pick<CredentialedVfs, 'exists' | 'mkdir'>, path: string): void;
/**
 * `body` written to `path` as it arrives, never held whole: a stream's
 * pieces go to the file as they are read, each also given to `onPiece` (a
 * digest). A body past `limit` bytes throws `tooLarge(received)`: a stream
 * once it passes the limit, cancelled rather than drained, any other body by
 * its length before it is written. A body that fails publishes nothing.
 * Answers the body's size.
 */
export declare function writeBody(vfs: Pick<CredentialedVfs, 'writeFile' | 'writeFileFrom'>, path: string, body: BindingBody, limit: number, tooLarge: (received: number) => Error, onPiece?: (piece: Uint8Array) => void): Promise<number>;
/**
 * The `length` bytes of the file at `path` from `start`, read a piece at a
 * time as they are asked for. The file changed under it (replaced, or
 * removed) errors the stream rather than mix two bodies.
 */
export declare function fileStream(vfs: Pick<CredentialedVfs, 'readRange' | 'revision'>, path: string, start: number, length: number): ReadableStream<Uint8Array>;
//# sourceMappingURL=body.d.ts.map