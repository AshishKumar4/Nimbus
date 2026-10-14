import { createHash } from 'node:crypto';
import { hex } from '../vfs/content-chunking.js';

/**
 * A Durable Object facet's name for `parts` in `namespace`: each part whole,
 * so no two lists name one facet, and bounded, as workerd refuses a name
 * over 256 bytes (actor-state.c++). The namespace, then the list's SHA-256.
 */
export function facetName(namespace: string, parts: readonly string[]): string {
  const digest = createHash('sha256').update(new TextEncoder().encode(JSON.stringify(parts))).digest();
  return `${namespace}:${hex(new Uint8Array(digest))}`;
}
