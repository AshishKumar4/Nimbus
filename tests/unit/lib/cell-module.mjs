// A wrapped module cell (core/_shared/commonjs-cell.ts wrapCommonJsCell)
// evaluated as the guest's registry evaluates its kind: a `{ cjs }` cell as
// workerd's CommonJS handler does (a sloppy function body with `module` and
// `exports` in scope), an ES cell as an ES module, required (Bun requires an
// ES module synchronously). Either way, its wrapper factory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireHere = createRequire(import.meta.url);
let dir;
let count = 0;

/** A `{ cjs }` module body's export. */
export function loadCommonJs(text) {
  const moduleObject = { exports: {} };
  new Function('module', 'exports', text)(moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

/** `wrapped`'s wrapper factory, its text evaluated as its kind is. */
export function loadCell(wrapped) {
  if (!wrapped.esModule) return loadCommonJs(wrapped.text);
  if (dir === undefined) {
    const made = mkdtempSync(join(tmpdir(), 'es-cell-'));
    dir = made;
    // The modules live as long as the test that required them: removed as it exits.
    process.on('exit', () => rmSync(made, { recursive: true, force: true }));
  }
  const file = join(dir, `cell-${count++}.mjs`);
  writeFileSync(file, wrapped.text);
  return requireHere(file).default;
}
