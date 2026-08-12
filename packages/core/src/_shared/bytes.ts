/**
 * _shared/bytes.ts — Singleton TextEncoder / TextDecoder.
 *
 * TextEncoder and TextDecoder for UTF-8 are stateless per the WHATWG
 * Encoding spec, so a module-scope singleton is safe and saves the
 * repeated allocation (which shows up in flame graphs of hot paths
 * like sqlite-vfs writeFile and the WebSocket terminal frame decoder).
 *
 * Use these everywhere instead of `new TextEncoder()` / `new TextDecoder()`
 * in the supervisor isolate. Facet-isolate code-strings (e.g. inside
 * generateGitNetworkFacetCode) cannot import this module and must keep
 * their inline allocations — those copies are justified.
 */

/** Shared UTF-8 encoder. Stateless; safe to share across all callers. */
export const enc = new TextEncoder();

/** Shared UTF-8 decoder. Stateless; safe to share across all callers. */
export const dec = new TextDecoder();
