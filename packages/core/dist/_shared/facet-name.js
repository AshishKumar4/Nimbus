import { createHash } from 'node:crypto';
/**
 * A Durable Object facet's name for `parts` in `namespace`: each part whole,
 * so no two lists name one facet, and bounded, as workerd refuses a name
 * over 256 bytes (actor-state.c++). The namespace, then the list's SHA-256.
 */
export function facetName(namespace, parts) {
    return `${namespace}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
