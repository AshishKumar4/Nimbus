/**
 * vfs-path.ts — Canonical VFS path normalization.
 *
 * Replaces three near-duplicate implementations that lived in
 * git-commands.ts, esbuild-service.ts, and require-resolver.ts. The
 * git-commands version had a defensive bounds check (`out.length > 0`
 * before pop) that the others lacked — that safer behavior is the one
 * preserved here.
 *
 * Facet-isolate code-string copies (e.g. inside
 * generateGitNetworkFacetCode in git-network-facet.ts, and inside
 * node-shims.ts) cannot import this module and must keep their inline
 * implementations; those copies are documented as justified.
 *
 * Semantics:
 *   - Strip empty segments (collapses `//` runs)
 *   - Drop `.` segments
 *   - Pop on `..`, but only if there's something to pop (won't escape root)
 *   - Returns slash-joined string with NO leading/trailing slash, suitable
 *     for direct VFS lookup keys
 *
 * Examples:
 *   normalizeVfsPath('/foo/./bar/../baz') -> 'foo/baz'
 *   normalizeVfsPath('/foo//bar/')         -> 'foo/bar'
 *   normalizeVfsPath('../escape')          -> 'escape'  (bounded; doesn't go negative)
 */
export function normalizeVfsPath(p: string): string {
  const segments = String(p ?? '').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..' && out.length > 0) out.pop();
    else if (seg !== '.' && seg !== '' && seg !== undefined) out.push(seg);
  }
  return out.join('/');
}

/** Strip leading slashes only — does not touch internal segments. */
export function stripLeadingSlashes(p: string): string {
  return p.replace(/^\/+/, '');
}
