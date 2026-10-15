// The `node:crypto` surface core uses: synchronous sha256 for content
// addressing, and the module lifo's node gives a program
// (substrate/lifo/node-compat/crypto.ts). workerd provides it under
// `nodejs_compat`; bun and node natively.
declare module 'node:crypto' {
  interface Hash {
    /** A string is hashed as its UTF-8 bytes. */
    update(data: Uint8Array | string): Hash;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512'): Hash;
  const crypto: { createHash: typeof createHash };
  export default crypto;
}
