/**
 * module-importer.ts — the URL import() in a module resolves against: what
 * a cell's import() is lowered with (runtime/bundle-cell-transform.ts) and
 * what the module's own Function carries (commonjs-cell.ts, THE WRAPPER).
 * Self-contained: the guest inlines it by its source.
 */

/** The importer URL of the module at `path`: a VFS path, with or without its leading slash, or a data: URL. */
export function moduleImporterUrl(path: string): string {
  return path.startsWith('data:') ? 'data:text/javascript,' : 'file:///' + path.replace(/^\/+/, '');
}
