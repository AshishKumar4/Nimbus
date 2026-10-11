/**
 * esm-stage.ts — a launch's ES modules as its process's registry evaluates
 * them (core runtime/native-esm.ts): each static specifier resolved as Node's
 * ESM loader resolves it, and the module staged to name what that resolution
 * loads in the map: another staged ES module, the facade of a CommonJS module
 * or a builtin, a JSON module, or a module the map does not have for a
 * specifier Node's loader refuses, so the whole graph fails to link before
 * any of it runs, as Node's does, and the process names the refusal Node
 * would (EsmStage.missing).
 *
 * The facades, JSON modules and meta instances join the map beside the
 * staged modules, and the process reads the launch's table of them
 * (EsmModuleRow) by each meta instance's id.
 */
import { commonJsCellModuleName } from '@nimbus-sh/core/_shared/commonjs-cell.js';
import { createEsmResolver } from '@nimbus-sh/core/_shared/esm-resolver.js';
import { FACET_PROVIDED_PACKAGES } from '@nimbus-sh/core/constants.js';
import { cjsModuleExportNamesAsync } from '@nimbus-sh/core/runtime/cjs-module-exports.js';
import { builtinFacadeModule, commonJsFacadeModule, ESM_FACADE_DIR, ESM_HOST_MODULE, ESM_HOST_SOURCE, ESM_META_MODULE, metaModuleSource, stageEsModule, } from '@nimbus-sh/core/runtime/native-esm.js';
import { NODE_BUILTIN_EXPORTS } from '@nimbus-sh/core/runtime/node-builtin-exports.js';
import { resolveRequireEx } from '@nimbus-sh/core/runtime/require-resolution.js';
import { typeScriptUnderNodeModules } from '@nimbus-sh/core/runtime/module-format.js';
import { nodeModulesRefusal } from '@nimbus-sh/core/runtime/typescript-refusal.js';
import { stripsTypeScript } from '@nimbus-sh/core/_shared/typescript-specifiers.js';
import { stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';
/** Where a refused specifier points, by its number: a name no map member has, so the graph fails to link. */
export const ESM_MISSING_DIR = 'nimbus/missing/';
/**
 * The code a refusal carries for a module Node's loader would load but the
 * launch did not stage (its closure was cut at the map's bound): the
 * process evaluates the importer's graph with the interpreter instead,
 * which loads the module as a file outside the map.
 */
export const ESM_NOT_STAGED = 'ERR_NIMBUS_NOT_STAGED';
/** Builtins Node names only with their scheme (module.isBuiltin('test') is false). */
const SCHEME_ONLY_BUILTINS = { sea: true, sqlite: true, test: true, 'test/reporters': true };
/** module.isBuiltin, by Node 22.22.3's builtin table. */
function isNodeBuiltin(specifier) {
    if (specifier.startsWith('node:'))
        return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier.slice(5));
    return Object.hasOwn(NODE_BUILTIN_EXPORTS, specifier) && !SCHEME_ONLY_BUILTINS[specifier];
}
/** A refusal's error, as the process rebuilds it. */
function refusal(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = Reflect.get(failure, 'code');
    const url = Reflect.get(failure, 'url');
    return { name: failure.name, code: typeof code === 'string' ? code : '', message: failure.message, ...(typeof url === 'string' ? { url } : {}) };
}
/**
 * Stage `cells`, the launch's ES modules (their code and import sites, by VFS
 * key), resolving under the program's `conditions`. `isCode(key)` is whether
 * the launch carries the cell at a key as code.
 */
export async function stageEsModules(fs, cells, { conditions, cwd, isCode, gate, scope = 'node', stripsTypes = false }) {
    const table = [];
    const members = {
        [ESM_HOST_MODULE]: ESM_HOST_SOURCE,
        [ESM_META_MODULE]: metaModuleSource(gate),
    };
    const missing = [];
    // A cell's id is its place among `cells`: the table's first rows, its targets filled as it is staged.
    const targetIds = [];
    for (const [key, { sites }] of cells) {
        const targets = [];
        targetIds.push(targets);
        table.push(sites.commonJsNames?.length ? ['module', key, commonJsCellModuleName(key), targets, 1] : ['module', key, commonJsCellModuleName(key), targets]);
    }
    const ids = new Map();
    for (let id = 0; id < table.length; id++)
        ids.set(`module:${table[id][1]}`, id);
    const names = new Map();
    /** The row of a facade or JSON module, added the first time it is named. */
    const member = (kind, key, source) => {
        let id = ids.get(`${kind}:${key}`);
        if (id === undefined) {
            id = table.length;
            const name = `${ESM_FACADE_DIR}${id}.js`;
            table.push([kind, key, name]);
            members[name] = source(id, name);
            ids.set(`${kind}:${key}`, id);
        }
        return id;
    };
    const readText = async (path) => {
        try {
            return await fs.files.readFileString(stripLeadingSlashes(path));
        }
        catch {
            return null;
        }
    };
    const requireResolve = async (specifier, fromPath) => {
        const fromDir = stripLeadingSlashes(fromPath.slice(0, fromPath.lastIndexOf('/')));
        const found = await resolveRequireEx(fs.files, specifier, fromDir, undefined, undefined, conditions);
        return found === null ? null : '/' + stripLeadingSlashes(found.resolved);
    };
    const resolver = createEsmResolver({
        async kind(path) {
            const key = stripLeadingSlashes(path);
            if (!(await fs.files.exists(key)))
                return null;
            return (await fs.files.isDirectory(key)) ? 'directory' : 'file';
        },
        realpath: (path) => fs.realpath(path),
        readText,
        isBuiltin: (specifier) => isNodeBuiltin(specifier) || FACET_PROVIDED_PACKAGES.includes(specifier),
        cjsResolve: requireResolve,
    }, { conditions, cwd: () => cwd });
    const exportNames = async (path) => [...await cjsModuleExportNamesAsync(path, { source: readText, resolve: requireResolve }, names)];
    const notStaged = (path) => Object.assign(new Error(`Cannot find module '${path}': it was resolved, and this launch did not stage it`), { code: ESM_NOT_STAGED });
    /** The row an import with `attributes`, from the module at `importer`, of what `resolution` names loads. */
    const target = async (resolution, attributes, importer) => {
        resolver.validateAttributes(resolution.url, resolution.format, attributes);
        resolver.assertLoadable(resolution);
        if (resolution.format === 'builtin') {
            const builtin = (resolution.builtin ?? resolution.url).replace(/^node:/, '');
            if (!FACET_PROVIDED_PACKAGES.includes(builtin)) {
                return member('builtin', builtin, (id, name) => builtinFacadeModule(name, id, NODE_BUILTIN_EXPORTS[builtin] ?? []));
            }
            // A package the process provides loads as the process's own, with the names Node finds in its installed copy.
            const installed = await requireResolve(builtin, importer);
            const exported = installed === null ? [] : await exportNames(installed);
            return member('builtin', builtin, (id, name) => builtinFacadeModule(name, id, exported));
        }
        if (resolution.path === undefined)
            throw new Error(`Nimbus: ${resolution.url} has no file to stage`);
        const key = stripLeadingSlashes(resolution.path);
        // Node's loader refuses to strip a TypeScript file under node_modules when it loads it.
        if (stripsTypes && stripsTypeScript(key) && typeScriptUnderNodeModules(key)) {
            const refused = nodeModulesRefusal(resolution.path);
            throw Object.assign(new Error(refused.message), { code: refused.code });
        }
        const staged = ids.get(`module:${key}`);
        if (staged !== undefined)
            return staged;
        if (resolution.format === 'json') {
            const text = await readText(resolution.path);
            if (text === null)
                throw notStaged(resolution.path);
            // JSON.parse's value, as Node's: an object literal would make `__proto__` the prototype.
            return member('json', key, () => `export default JSON.parse(${JSON.stringify(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)});\n`);
        }
        // CommonJS by Node's format for it, loaded by require().
        if (!isCode(key))
            throw notStaged(resolution.path);
        const exported = await exportNames(resolution.path);
        return member('commonjs', key, (id, name) => commonJsFacadeModule(name, id, exported));
    };
    const modules = new Map();
    let id = 0;
    for (const [key, { code, sites }] of cells) {
        const parentUrl = new URL('file://');
        parentUrl.pathname = '/' + key;
        const targets = [];
        const rowTargets = targetIds[id];
        for (const site of sites.statics) {
            try {
                // A provided package by its bare name is the process's own, never an installed copy.
                const resolution = FACET_PROVIDED_PACKAGES.includes(site.specifier)
                    ? { url: site.specifier, format: 'builtin', builtin: site.specifier }
                    : await resolver.resolve(site.specifier, parentUrl.href).catch(async (error) => {
                        // Bun's resolution probes what Node's refuses (a `.js` naming its `.ts`, an extensionless path).
                        const probed = scope === 'bun' ? await requireResolve(site.specifier, parentUrl.pathname) : null;
                        if (probed === null)
                            throw error;
                        const url = new URL('file://');
                        url.pathname = probed;
                        return { url: url.href, path: probed, format: cells.has(stripLeadingSlashes(probed)) ? 'module' : 'commonjs' };
                    });
                const row = await target(resolution, site.attributes, parentUrl.pathname);
                rowTargets.push(row);
                targets.push(table[row][2]);
            }
            catch (error) {
                rowTargets.push(-1);
                targets.push(`${ESM_MISSING_DIR}${missing.length}.js`);
                missing.push(refusal(error));
            }
        }
        modules.set(key, stageEsModule(code, sites, {
            id, name: commonJsCellModuleName(key), targets, ...(sites.commonJsNames ? { commonJsNames: sites.commonJsNames } : {}),
        }));
        id++;
    }
    return { modules, members, table, missing };
}
