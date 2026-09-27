import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
type BindingBody = string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array | ArrayBuffer> | Blob | null | undefined;
export declare function ensureBindingDir(vfs: Pick<CredentialedVfs, 'exists' | 'mkdir'>, path: string): void;
export declare function coerceBindingBody(value: BindingBody): Promise<Uint8Array>;
export {};
//# sourceMappingURL=body.d.ts.map