/**
 * barrel-synthesizer.ts — generate synthetic entry files for "barrel"
 * packages so they tree-shake cleanly through esbuild.
 *
 * Why this exists
 * ───────────────
 * Some npm packages ship as a "barrel" — a single index file that
 * re-exports hundreds or thousands of named exports, each living in
 * its own source file. Examples observed in the wild:
 *
 *   lucide-react@0.460:        ~3940 files (~1500 icons × 2 entry forms)
 *   @phosphor-icons/react:     thousands of icon components
 *   react-icons:               thousands of icons across icon families
 *   @mui/icons-material:       thousands of Material icons
 *   @heroicons/react:          hundreds of icons (split by style)
 *
 * Bundling the whole barrel as if it were a normal browser module OOMs
 * esbuild's WASM facet — the compiler tries to ingest the entire
 * source tree into one ESM output. We previously fell back to
 * `https://esm.sh/<pkg>?deps=react@<v>,react-dom@<v>` (commit fc17847)
 * which violated the 100% edge contract: every preview load fetched
 * tree-shaken bytes from a third-party CDN.
 *
 * The fix is structural. Instead of bundling `import * from 'pkg'`,
 * we scan the user's source code for the SET of named imports the
 * project actually uses
 *
 *   import { Home, FileText, Zap } from 'lucide-react'
 *
 * and synthesize a tiny entry module
 *
 *   export { Home, FileText, Zap } from 'lucide-react';
 *
 * which esbuild bundles in milliseconds because reachability prunes
 * everything else. The output is small (5–20 KiB for typical icon
 * sets) and ships from our edge.
 *
 * Generality
 * ──────────
 * This is NOT lucide-react-specific. Any barrel package whose author
 * marked `sideEffects: false` (or whose individual icon files are
 * side-effect-free) works automatically — esbuild's tree-shake takes
 * care of selecting the actually-used exports. Packages without
 * sideEffects: false may still tree-shake because esbuild's static
 * analysis of `export { X } from './x.js'` is conservative-correct.
 *
 * Failure mode
 * ────────────
 * If the scanner can't enumerate the set (dynamic imports, computed
 * member access like `Icons[name]`, etc.), the synthesizer returns
 * null and the caller MUST hard-error. NO CDN fallback. The user
 * sees a clear remediation: "add a static import for the
 * dynamically-referenced icon."
 */
import { packageNameFromSpecifier } from '@nimbus-sh/core/runtime/barrel-detect.js';
import { importedSpecifiers, maskSourceForImports, UndecidableSourceError } from '@nimbus-sh/core/runtime/comment-strip.js';
import { BUNDLER_IMPORT_CONDITIONS } from '@nimbus-sh/core/runtime/bundler-resolution.js';
import { resolvePackageEntry } from '@nimbus-sh/core/_shared/exports-resolver.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { MODULE_PARSE_OPTIONS, parseStatements } from '@nimbus-sh/core/runtime/javascript-ast.js';
import { bindingIdentifiers } from '@nimbus-sh/core/runtime/binding-pattern.js';
/**
 * Stable signature for a barrel bundle's source import set. Stored in
 * pkg_esm_bundles.input_hash so a synthetic bundle generated for
 * `{ Home }` is never reused after the project starts importing
 * `{ Home, AlertTriangle }`.
 */
export function namedImportSignature(pkgName, names) {
    if (!names || names.size === 0)
        return null;
    return `barrel:${pkgName}:${Array.from(names).sort().join(',')}`;
}
/**
 * Scan the project's browser source under `projDir`: `.ts/.tsx/.jsx/.js/.mjs`
 * files up to six directories deep, skipping node_modules, .git, dist and
 * build, and the build tools' own config files at the project root
 * (vite.config.ts and friends), whose imports run server-side.
 *
 * Named imports recognized:
 *   import { A } from 'pkg'
 *   import { A, B } from 'pkg'
 *   import { A as X, B as Y } from 'pkg'
 *   import D, { A } from 'pkg'   // only A is captured (D is default)
 *   import { type A } from 'pkg' // captured; the bundle strips it
 *
 * NOT recognized as named (intentional — these can't be statically
 * tree-shaken): `import * as M from 'pkg'`, `import('pkg')`,
 * `const { A } = require('pkg')`, and named imports from a subpath, which
 * esbuild resolves file by file.
 *
 * Each file is read through core's import lexer (comment-strip.ts
 * maskSourceForImports: comments, strings, regexes and JSX told apart, as
 * TypeScript's parser reads them; import-scan-differential.mjs holds it to
 * the parser over this repository's sources), then the grammars above. A
 * file the lexer cannot decide is read through `parse` instead
 * (parsedImportView). The lexer reads ~77 MB/s where Oxc's transform,
 * in-process, reads ~26 MB/s and costs a transform-facet hop besides, so
 * the parser is the exception, not the path.
 *
 * With a `budget`, the walk reads at most what it allows, checked with a
 * stat before each read: a file past the per-file or the remaining total
 * bytes is skipped, and the walk ends at the first candidate file past
 * `files`. What it left unread is reported (`unread`), never dropped
 * silently.
 */
export async function scanProjectImports(vfs, projDir, parse, budget) {
    const bare = new Set();
    const namedImports = new Map();
    const scanExts = new Set(['.ts', '.tsx', '.jsx', '.js', '.mjs']);
    // vite.config.ts/js/mjs/cjs and *.config.{ts,js,mjs,cjs} at the project
    // root. Limited to depth 0 so browser code under e.g. src/config/foo.ts
    // is still read. (@tailwindcss/vite, pre-bundled as a browser module,
    // trips esbuild's fs shim; the dev server never serves these.)
    const isServerOnlyTopLevel = (name) => /^(?:vite|vitest|astro|rollup|tsup|tailwind|postcss|prettier|eslint|stylelint|rolldown)\.config\.[mc]?[jt]s$/.test(name)
        || (/\.config\.[mc]?[jt]s$/.test(name) && name.split('.').length === 3);
    // `import { ... } from 'spec'` and `import D, { ... } from 'spec'`:
    // 1 is the named-import body, 2 the specifier.
    const namedImportRe = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
    const addNamed = (pkgName, name) => {
        let set = namedImports.get(pkgName);
        if (!set) {
            set = new Set();
            namedImports.set(pkgName, set);
        }
        set.add(name);
    };
    // Files the lexer cannot decide, read with the parser once the walk is done.
    const undecided = [];
    // What the budget has left, and what it kept from being read.
    let filesLeft = budget?.files ?? Infinity;
    let bytesLeft = budget?.totalBytes ?? Infinity;
    const tooLarge = [];
    const pastTotal = [];
    let stoppedAt = null;
    const scan = (code, ext) => {
        for (const specifier of importedSpecifiers(code)) {
            if (specifier.startsWith('.') || specifier.startsWith('/'))
                continue;
            const clean = specifier.split('?')[0];
            bare.add(clean);
            bare.add(packageNameFromSpecifier(clean));
        }
        if ((ext === '.tsx' || ext === '.jsx') && bare.has('react')) {
            bare.add('react/jsx-runtime');
            bare.add('react/jsx-dev-runtime');
        }
        for (const m of code.matchAll(namedImportRe)) {
            const specRaw = m[2];
            if (specRaw.startsWith('.') || specRaw.startsWith('/') || specRaw.startsWith('node:'))
                continue;
            const pkgName = packageNameFromSpecifier(specRaw);
            if (specRaw !== pkgName)
                continue;
            // Each item is `X`, `X as Y` or `type X`: the SOURCE name (the
            // package's export) is captured, not the local alias.
            for (const partRaw of m[1].split(',')) {
                const part = partRaw.trim();
                if (!part)
                    continue;
                const named = /^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.exec(part)
                    ?? /^type\s+([A-Za-z_$][\w$]*)/.exec(part);
                if (named)
                    addNamed(pkgName, named[1]);
            }
        }
    };
    const walk = (dir, depth) => {
        if (depth > 6 || stoppedAt !== null)
            return;
        let entries;
        try {
            entries = vfs.readdir(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' ||
                entry.name === 'dist' || entry.name === 'build')
                continue;
            const path = dir + '/' + entry.name;
            if (entry.type === 'directory') {
                walk(path, depth + 1);
                continue;
            }
            if (depth === 0 && isServerOnlyTopLevel(entry.name))
                continue;
            const dot = entry.name.lastIndexOf('.');
            if (dot < 0)
                continue;
            const ext = entry.name.substring(dot);
            if (!scanExts.has(ext))
                continue;
            if (budget) {
                if (filesLeft <= 0) {
                    stoppedAt = path;
                    return;
                }
                filesLeft--;
                let size;
                try {
                    size = vfs.stat(path).size;
                }
                catch {
                    continue;
                }
                if (size > budget.fileBytes) {
                    tooLarge.push(path);
                    continue;
                }
                if (size > bytesLeft) {
                    pastTotal.push(path);
                    continue;
                }
                bytesLeft -= size;
            }
            let source;
            try {
                source = vfs.readFileString(path);
            }
            catch {
                continue;
            }
            const view = lexedImportView(source, path);
            if (view === null)
                undecided.push({ source, path, ext });
            else
                scan(view, ext);
        }
    };
    walk(projDir, 0);
    for (const { source, path, ext } of undecided)
        scan(await parsedImportView(source, path, parse), ext);
    const unread = [
        tooLarge.length > 0 && budget ? `${tooLarge.length} file(s) over ${budget.fileBytes} bytes (${tooLarge.slice(0, 3).join(', ')}${tooLarge.length > 3 ? ', …' : ''})` : '',
        pastTotal.length > 0 && budget ? `${pastTotal.length} file(s) past ${budget.totalBytes} bytes in all (${pastTotal.slice(0, 3).join(', ')}${pastTotal.length > 3 ? ', …' : ''})` : '',
        stoppedAt !== null && budget ? `the files from ${stoppedAt} on, past ${budget.files} files` : '',
    ].filter(Boolean).join('; ');
    return { bareSpecifiers: [...bare], namedImports, unread: unread || null };
}
/**
 * What every scan of a project for a barrel's names reads, at most: the
 * installer's (pre-bundling a barrel from a synthesized entry) and the Vite
 * dev server's (serving one) alike, so that both reach one decision for an
 * unchanged project, and one bundle row serves both. A scan that leaves
 * files unread (`unread`) synthesizes nothing: every barrel is bundled
 * whole, from its own entry.
 */
export const PROJECT_SCAN = { files: 2048, fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 };
/** A SourceParser over a transform service: `.tsx`/`.ts` as TypeScript, anything else as JavaScript with JSX. */
export function transformParser(service) {
    return async (path, source) => {
        const loader = /\.[mc]?tsx$/.test(path) ? 'tsx' : /\.[mc]?ts$/.test(path) ? 'ts' : 'jsx';
        return (await service.transform(source, { loader, format: 'esm' })).code;
    };
}
/** `source`'s import-detection view as the lexer reads it, or null for a file it cannot decide (UndecidableSourceError). */
function lexedImportView(source, path) {
    try {
        return maskSourceForImports(source, path);
    }
    catch (error) {
        if (error instanceof UndecidableSourceError)
            return null;
        throw error;
    }
}
/**
 * The import-detection view of a file the lexer cannot decide: the lexer's
 * view of what `parse` makes of it. A transform drops the imports a
 * TypeScript module names only as types or never uses, which name nothing
 * to bundle.
 */
async function parsedImportView(source, path, parse) {
    // The transform's output holds no JSX: read it as a `.ts` file is read.
    return maskSourceForImports(await parse(path, source), path.replace(/\.[^./]*$/, '') + '.ts');
}
export function buildSyntheticEntry(vfs, nmDir, pkgName, names) {
    if (names.size === 0)
        return null;
    const indexPath = findPackageEsmEntry(vfs, nmDir, pkgName);
    if (!indexPath)
        return null;
    let indexCode;
    try {
        indexCode = vfs.readFileString(indexPath);
    }
    catch {
        return null;
    }
    // Each name the barrel re-exports from a module of its own package: the
    // module's path as written, and the name it has there (null: the module's
    // namespace, `export * as ns`). A name the barrel declares itself is no
    // re-export, but hides a name an `export *` module exports.
    const exportMap = new Map();
    const own = new Set();
    const stars = [];
    const indexRead = eachStatement(indexCode, (statement) => {
        if (statement.type === 'ExportNamedDeclaration') {
            const path = relativeSource(statement.source);
            if (path === null) {
                for (const name of namedExports(statement))
                    own.add(name);
                return;
            }
            for (const specifier of statement.specifiers) {
                exportMap.set(moduleExportName(specifier.exported), { path, sourceName: moduleExportName(specifier.local) });
            }
        }
        else if (statement.type === 'ExportAllDeclaration') {
            const path = relativeSource(statement.source);
            if (path === null)
                return;
            if (statement.exported)
                exportMap.set(moduleExportName(statement.exported), { path, sourceName: null });
            else
                stars.push(path);
        }
    });
    if (!indexRead)
        return null;
    // `export * from './x.js'`: each name the module itself exports but
    // `default`, unless the barrel exports it otherwise. Nested `export *` is
    // not followed, and the walk is capped so a barrel-of-barrels cannot blow
    // the synthesizer's budget (date-fns has ~290 sources).
    const indexDir = indexPath.substring(0, indexPath.lastIndexOf('/'));
    const STAR_SOURCE_CAP = 1500;
    for (const path of stars.slice(0, STAR_SOURCE_CAP)) {
        let starCode;
        try {
            starCode = vfs.readFileString(normalizeJoin(indexDir, path));
        }
        catch {
            continue;
        }
        const starRead = eachStatement(starCode, (statement) => {
            const exported = statement.type === 'ExportNamedDeclaration'
                ? namedExports(statement)
                : statement.type === 'ExportAllDeclaration' && statement.exported ? [moduleExportName(statement.exported)] : [];
            for (const name of exported) {
                if (name !== 'default' && !own.has(name) && !exportMap.has(name))
                    exportMap.set(name, { path, sourceName: name });
            }
        });
        if (!starRead)
            return null;
    }
    if (exportMap.size === 0)
        return null;
    // Match user's requested names against the map. Build per-file
    // groupings so the synthetic entry has one re-export per source
    // file (smaller text, cleaner tree-shake graph).
    const grouped = new Map();
    let matched = 0;
    for (const name of names) {
        const ref = exportMap.get(name);
        if (!ref)
            continue;
        matched++;
        // Resolve relative path against indexDir, then strip the
        // package's nmDir prefix so we can build a `pkgName/...` import.
        const fullPath = normalizeJoin(indexDir, ref.path);
        let arr = grouped.get(fullPath);
        if (!arr) {
            arr = [];
            grouped.set(fullPath, arr);
        }
        arr.push({ exportedName: name, sourceName: ref.sourceName });
    }
    if (matched === 0)
        return null;
    // Emit per-file re-export lines. Use `pkgName/<rel-from-pkg-root>`
    // so esbuild's resolver follows the package's exports field if any.
    const pkgRoot = nmDir + '/' + pkgName;
    const sortedFiles = [...grouped.keys()].sort();
    const lines = [
        `// AUTO-GENERATED synthetic entry for ${pkgName}`,
        `// ${matched} of ${names.size} requested names matched the parsed barrel.`,
        `// esbuild tree-shakes the rest of the package away.`,
    ];
    if (matched < names.size) {
        const missing = [...names].filter(n => !exportMap.has(n));
        lines.push(`// MISSING (not found in barrel index): ${missing.sort().join(', ')}`);
    }
    const referencedFiles = [];
    for (const filePath of sortedFiles) {
        let relFromPkg = filePath.startsWith(pkgRoot + '/')
            ? filePath.substring(pkgRoot.length + 1)
            : filePath;
        // Use the package-rooted form so esbuild's resolver respects
        // the package's exports/main fields. Strip leading slash.
        const importSpec = pkgName + '/' + relFromPkg;
        const items = grouped.get(filePath);
        // Sort items for determinism.
        items.sort((a, b) => a.exportedName.localeCompare(b.exportedName));
        const members = [];
        for (const { exportedName, sourceName } of items) {
            if (sourceName === null)
                lines.push(`export * as ${exportName(exportedName)} from ${JSON.stringify(importSpec)};`);
            else
                members.push(sourceName === exportedName ? exportName(exportedName) : `${exportName(sourceName)} as ${exportName(exportedName)}`);
        }
        if (members.length > 0)
            lines.push(`export { ${members.join(', ')} } from ${JSON.stringify(importSpec)};`);
        referencedFiles.push(filePath);
    }
    return {
        code: lines.join('\n') + '\n',
        referencedFiles,
    };
}
/**
 * Build a SCOPED slice for a synthetic-entry bundle: include only
 * the files the synthetic entry directly references (+ their
 * transitive imports walked via static analysis), plus the package
 * root's `package.json` (esbuild's resolver reads it for exports/main
 * fields). This bypasses the standard `walkDir` over the whole
 * package, which for icon-libraries with thousands of files can
 * exceed the 28 MiB slice cap.
 *
 * Caller still appends the synthetic entry file itself to the slice
 * (we don't include it here because it lives in a synthetic
 * directory the caller already manages).
 *
 * Returns the list of `SliceEntry`-shaped objects to push into the
 * existing slice, plus the total bytes added (for cap-tracking).
 *
 * `transitiveCap`: how many files we'll walk in total. Bounded so a
 * pathological barrel-of-barrels can't blow the cap. Default 800,
 * which empirically covers icon-libraries with up to ~400 imported
 * icons (each pulling 1-2 transitive shared utility files).
 */
export async function buildScopedSliceForSynthetic(vfs, nmDir, pkgName, referencedFiles, parse, transitiveCap = 800) {
    const entries = [];
    let totalBytes = 0;
    const visited = new Set();
    const dirSet = new Set();
    const pkgRoot = nmDir + '/' + pkgName;
    const addDir = (d) => {
        if (dirSet.has(d) || !d)
            return;
        dirSet.add(d);
        entries.push({ path: '/' + d.replace(/^\/+/, ''), isDir: true });
    };
    // Always include the package root + its package.json. esbuild's
    // resolver reads package.json for sideEffects, exports, main, etc.
    addDir(pkgRoot);
    const pkgJsonPath = pkgRoot + '/package.json';
    if (vfs.exists(pkgJsonPath) && !vfs.isDirectory(pkgJsonPath)) {
        try {
            const bytes = vfs.readFile(pkgJsonPath);
            entries.push({ path: '/' + pkgJsonPath.replace(/^\/+/, ''), bytes, isDir: false });
            totalBytes += bytes.length + pkgJsonPath.length;
            visited.add(pkgJsonPath);
        }
        catch { }
    }
    // Walker: BFS over referenced files + their relative imports.
    const queue = [...referencedFiles];
    while (queue.length > 0 && visited.size < transitiveCap) {
        const filePath = queue.shift();
        if (visited.has(filePath))
            continue;
        visited.add(filePath);
        if (!vfs.exists(filePath) || vfs.isDirectory(filePath))
            continue;
        let bytes;
        try {
            bytes = vfs.readFile(filePath);
        }
        catch {
            continue;
        }
        // Track parent dirs so esbuild's plugin's dirSet has them.
        const slash = filePath.lastIndexOf('/');
        if (slash > 0)
            addDir(filePath.substring(0, slash));
        entries.push({ path: '/' + filePath.replace(/^\/+/, ''), bytes, isDir: false });
        totalBytes += bytes.length + filePath.length;
        // Queue the relative imports, read by the project scan's grammar.
        const source = new TextDecoder().decode(bytes);
        const view = lexedImportView(source, filePath) ?? await parsedImportView(source, filePath, parse);
        for (const rel of importedSpecifiers(view)) {
            if (!rel.startsWith('./') && !rel.startsWith('../'))
                continue;
            const dir = filePath.substring(0, slash > 0 ? slash : 0);
            const candidate = normalizeJoin(dir, rel);
            // Try with extensions (.js, .mjs, no-ext-as-dir/index.js).
            for (const ext of ['', '.js', '.mjs', '.cjs', '.jsx']) {
                const tryPath = candidate + ext;
                if (!visited.has(tryPath) && vfs.exists(tryPath) && !vfs.isDirectory(tryPath)) {
                    queue.push(tryPath);
                    break;
                }
            }
            // Also try as directory with index.js.
            const idx = candidate + '/index.js';
            if (!visited.has(idx) && vfs.exists(idx) && !vfs.isDirectory(idx)) {
                queue.push(idx);
            }
        }
    }
    return { entries, totalBytes };
}
/**
 * Each top-level statement of the module `source`, as it is parsed, none of
 * them kept (core javascript-ast.ts parseStatements): a module's whole tree
 * is 17 to 24 times its source, on the path that exists to bound memory.
 * False when it does not parse.
 */
function eachStatement(source, onStatement) {
    try {
        parseStatements(source, MODULE_PARSE_OPTIONS, { onStatement });
        return true;
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return false;
        throw error;
    }
}
/** The specifier of `export … from` when it is relative (a module of the package itself), else null. */
function relativeSource(source) {
    return source && typeof source.value === 'string' && source.value.startsWith('.') ? source.value : null;
}
/** An export name as written, `"a-b"` or `ab`. */
function moduleExportName(node) {
    return node.type === 'Identifier' ? node.name : String(node.value);
}
/** An export name as source text: quoted unless it is a plain identifier. */
function exportName(name) {
    return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
/** The names `export const a = 1, { b } = o`, `export function f`, `export class C` or `export { x as y }` exports. */
function namedExports(statement) {
    const names = statement.specifiers.map((specifier) => moduleExportName(specifier.exported));
    const declaration = statement.declaration;
    if (declaration?.type === 'VariableDeclaration') {
        const identifiers = [];
        for (const declarator of declaration.declarations)
            bindingIdentifiers(declarator.id, identifiers);
        for (const identifier of identifiers)
            names.push(identifier.name);
    }
    else if (declaration) {
        names.push(declaration.id.name);
    }
    return names;
}
/**
 * Resolve the package's root ESM entry file path: its `exports` under the
 * bundle's import conditions, else `module`, else `main`, as a pre-bundle
 * of it resolves (core bundler-resolution.ts). Returns null if the package
 * isn't installed or doesn't expose a JS entry.
 */
function findPackageEsmEntry(vfs, nmDir, pkgName) {
    const pkgRoot = nmDir + '/' + pkgName;
    const pkgJsonPath = pkgRoot + '/package.json';
    if (!vfs.exists(pkgJsonPath))
        return null;
    let pkg;
    try {
        pkg = JSON.parse(vfs.readFileString(pkgJsonPath));
    }
    catch {
        return null;
    }
    // The package's root entry as a bundle's import of it resolves.
    const rel = resolvePackageEntry(pkg, '.', BUNDLER_IMPORT_CONDITIONS);
    if (!rel)
        return null;
    const abs = normalizeJoin(pkgRoot, rel);
    if (vfs.exists(abs) && !vfs.isDirectory(abs))
        return abs;
    const idx = abs + '/index.js';
    return vfs.exists(idx) ? idx : null;
}
/**
 * Normalize-join two paths: `dir + '/' + rel`, resolving `.` and `..`
 * segments. Used when the barrel-index references siblings via
 * relative paths like `./icons/house.js`.
 */
function normalizeJoin(dir, rel) {
    return (dir.startsWith('/') ? '/' : '') + normalizeVfsPath(`${dir}/${rel}`);
}
/**
 * VFS path where synthetic entries are written. Lives under the
 * project's node_modules in a Nimbus-private namespace so package
 * managers don't collide with real package directories.
 *
 * Format: <projDir>/node_modules/.nimbus-synthetic/<safeName>.entry.js
 *
 * Safe name = pkgName with '@' and '/' replaced by '__' so scoped
 * packages produce a valid filesystem path.
 */
export function syntheticEntryPath(projDir, pkgName) {
    const safe = pkgName.replace(/[@/]/g, '__');
    return projDir + '/node_modules/.nimbus-synthetic/' + safe + '.entry.js';
}
