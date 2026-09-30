/**
 * bundle-cell-transform.ts — what the session does to one staged module
 * before it can run as a module cell.
 *
 * Every cell a process can require is CommonJS by the time it is wrapped
 * (commonjs-cell.ts): the guest's registry could compile an ES module, but
 * cannot resolve its package imports, give it its own file URL, or import
 * names from the CommonJS it depends on. So an ES module or a TypeScript
 * source is lowered to CommonJS, and a CommonJS cell's dynamic `import()`
 * calls are routed to the process's ESM loader.
 *
 * A cell's result is a function of four things: its path, its source, this
 * pipeline's code, and the transform host's code. That is what lets a
 * launch's results be kept by content (the worker's TransformStore): each is
 * stored under the sha256 of all four, and the build pins the pipeline's code
 * as TRANSFORM_PIPELINE_ID (scripts/bundle-facet-workers.mjs hashes the
 * bundled closure of this module and EsbuildService), so a deploy that
 * changes any step here never serves a result the old steps produced.
 * Nothing that decides a cell's output may live outside that closure.
 */
import { typescriptLoader } from '../_shared/typescript-specifiers.js';
import { errorText } from '../_shared/error-text.js';
import { vfsPathExtension } from '../vfs/path.js';
import { mayHaveDynamicImport } from './dynamic-import-rewrite.js';
import { rewriteBundledEsmToCjs, rewriteProvidedCommonJsModules, } from './esbuild-service.js';
import { bindImportMetaResolve, importMetaDefines } from './import-meta-transform.js';
import { hasTopLevelModuleSyntax, parseJavaScriptModule } from './javascript-ast.js';
/**
 * Bundled ESM this large is lowered by the bounded declaration rewrite in the
 * session rather than by esbuild: esbuild's Go heap grows with the module and
 * is never released.
 */
export const BUNDLED_ESM_REWRITE_MIN_BYTES = 512 * 1024;
/**
 * The bundle entries that may need the ESM→CJS transform before they can run
 * as module cells.
 *
 * Extensionless entries are in the set because that is the shape of nearly
 * every npm `bin` script. `.json` is data and `.cjs` is CommonJS by
 * definition; neither needs the transform. Content decides from here:
 * `looksLikeEsm` sniffs module syntax, and parses an extensionless file,
 * which may be data rather than a script.
 */
export function isBundleModuleCandidate(path) {
    const ext = vfsPathExtension(path);
    return ext === '.js' || ext === '.mjs' || ext === '' || bundleTypescriptLoader(path) !== null;
}
/**
 * The esbuild loader for a TypeScript source in the bundle, or null when the
 * path does not name one. Which extensions are TypeScript is
 * `typescriptLoader`'s table, the one a runtime's entry script is decided by.
 *
 * A resolved `.ts` file reaches the facet as TypeScript, and TypeScript is not
 * JavaScript: compiling a type annotation is a SyntaxError whether or
 * not the file has a single import in it. So these transform on their
 * EXTENSION, where `.js` files transform on their content — `looksLikeEsm` is
 * the right question for a file that is already valid JS either way, and the
 * wrong one for a file that is never valid JS.
 *
 * A declaration file (`.d.ts`, `.d.mts`, `.d.cts`) is not a source: it has
 * no runtime form, nothing `require()`s one, and esbuild's output for it is
 * empty by definition. It is DATA — read by the program that ships it, which
 * is exactly typescript: `tsc` reads its own `lib/lib.*.d.ts` with
 * `readFileSync`, and every declaration it type-checks against comes from
 * those bytes. Transforming them handed the compiler an 811-byte license
 * comment where `lib.es5.d.ts` (217 KB) had been, and every global type was
 * gone. So a declaration file is left exactly as it was staged.
 */
export function bundleTypescriptLoader(path) {
    return isTypescriptDeclarationFile(path) ? null : typescriptLoader(path);
}
/** `name.d.ts` / `name.d.mts` / `name.d.cts`, by TypeScript's own rule. */
export function isTypescriptDeclarationFile(path) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return /\.d\.[mc]?ts$/.test(base);
}
/** Whether a JavaScript file is an ES module: module syntax, and for an extensionless file, a parse. */
export function looksLikeEsm(path, src) {
    if (!hasTopLevelModuleSyntax(src))
        return false;
    if (vfsPathExtension(path) !== '')
        return true;
    // No extension: a bin script, or data such as a LICENSE whose prose says "import". Only a parse tells them apart.
    try {
        parseJavaScriptModule(src);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Whether the staged cell at `path` goes through the pipeline at all: an ES
 * module or TypeScript source to lower, or CommonJS (`.cjs` included) whose
 * dynamic `import()` calls are the process's.
 */
export function needsBundleCellTransform(path, src) {
    if (path.endsWith('.cjs'))
        return mayHaveDynamicImport(src);
    if (!isBundleModuleCandidate(path))
        return false;
    return bundleTypescriptLoader(path) !== null || looksLikeEsm(path, src) || mayHaveDynamicImport(src);
}
/**
 * Parseable CommonJS standing in for a module esbuild could not transform: it
 * throws the esbuild reason when required, so the failure surfaces at the
 * `require` with its cause rather than as a bare "Cannot use import statement".
 */
export function esbuildDiagnosticShim(path, reason) {
    const escapedReason = JSON.stringify(`esbuild transform failed for ${path}: ${reason.replace(/\n/g, ' ')}`);
    return '// framework-fixes-F4 diagnostic shim — esbuild rejected the ESM transform\n' +
        '(function () { throw new Error(' + escapedReason + '); })();\n';
}
/**
 * Run the session's steps of the pipeline on `source`, staged at `path`.
 *
 * This is computation in the caller's isolate proportional to the source —
 * the provided-module pre-pass and, for large bundled ESM, the bounded
 * declaration rewrite — so a paced caller accounts the source before it.
 */
export function prepareBundleCell(path, source) {
    const loader = bundleTypescriptLoader(path);
    const typescript = loader !== null;
    // Source is transformed once per path; import.meta reads metadata from
    // each evaluation's module object, including its query and fragment.
    // The source URL still supplies the static parent for rewritten dynamic
    // imports and diagnostics.
    const absUrl = 'file:///' + path.replace(/^\/+/, '');
    // Every cell's dynamic import() is the process's: the transform keeps
    // them, and the facet rewrites each to the process's ESM loader.
    const moduleMetadata = !path.endsWith('.cjs') && (typescript || looksLikeEsm(path, source));
    const request = (code, rewriteOnly) => ({
        code,
        options: rewriteOnly
            ? { rewriteOnly: true, dynamicImportParent: absUrl, moduleMetadata }
            : { loader: loader ?? 'js', format: 'cjs', target: 'esnext', define: importMetaDefines(absUrl, true), dynamicImportParent: absUrl, moduleMetadata },
    });
    let src;
    try {
        src = typescript ? source : rewriteProvidedCommonJsModules(source);
    }
    catch (e) {
        // The pre-pass cannot read this cell: a verdict on it alone, like esbuild's.
        return { path, typescript, lowered: false, absUrl, outcome: { error: errorText(e) } };
    }
    // CommonJS already: only its dynamic import() calls change.
    const rewriteOnly = path.endsWith('.cjs') || (!typescript && !looksLikeEsm(path, src));
    const cell = { path, typescript, lowered: !rewriteOnly && !typescript, absUrl };
    if (!rewriteOnly && !typescript && src.length >= BUNDLED_ESM_REWRITE_MIN_BYTES) {
        let rewritten;
        try {
            rewritten = rewriteBundledEsmToCjs(src, absUrl, true);
        }
        catch (e) {
            rewritten = { error: errorText(e) };
        }
        if (rewritten && 'error' in rewritten)
            return { ...cell, outcome: rewritten };
        if (rewritten) {
            // Its declarations are CommonJS now; what import() calls remain go to
            // the host like any cell's.
            if (!mayHaveDynamicImport(rewritten.code) && !rewritten.code.includes('import.meta'))
                return { ...cell, outcome: rewritten };
            return { ...cell, request: request(rewritten.code, true) };
        }
    }
    return { ...cell, request: request(src, rewriteOnly) };
}
/**
 * The cell's result from the host's (or the session's) outcome. A transient
 * error is no verdict on the source — the host could not run the transform
 * this time — so it throws, before any bundle, image or store can keep a
 * diagnostic that would poison the next launch.
 */
export function settleBundleCell(cell, outcome) {
    if ('error' in outcome) {
        if (outcome.transient)
            throw new Error(`esbuild transform unavailable for ${cell.path}: ${outcome.error}`);
        return { code: esbuildDiagnosticShim(cell.path, outcome.error), lowered: cell.lowered, failed: true };
    }
    return { code: bindImportMetaResolve(outcome.code, cell.absUrl), lowered: cell.lowered, failed: false };
}
/**
 * The entry script as the facet compiles it: each dynamic `import()` routed to
 * the process's ESM loader, with `parentUrl` (the script's own URL) as the
 * parent. Its result is the host's code as returned.
 */
export function entryScriptRequest(code, parentUrl) {
    return { code, options: { rewriteOnly: true, dynamicImportParent: parentUrl } };
}
