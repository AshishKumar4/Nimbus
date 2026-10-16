/**
 * module-importer.ts — the URL import() in a module resolves against: what
 * a cell's import() is lowered with (runtime/bundle-cell-transform.ts) and
 * what the module's own Function carries (commonjs-cell.ts, THE WRAPPER);
 * the interpreter gives a module it compiles the same (importer-url.ts).
 * The shared build-time compiler carries it into the guest.
 */
import { importerUrl } from './importer-url.js';
// Taken when the module loads: the guest's copy runs after a program may have replaced String.prototype's.
const stringCharCodeAt = String.prototype.charCodeAt;
const reflectApply = Reflect.apply;
const charCodeAt = (text, index) => reflectApply(stringCharCodeAt, text, [index]);
/** The importer URL of the module at `path`: a VFS path, with or without its leading slash, or a data: URL. */
export function moduleImporterUrl(path) {
    return importerUrl(path, charCodeAt);
}
