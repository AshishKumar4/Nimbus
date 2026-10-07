/**
 * The lifo node's CommonJS loader: how `require` resolves a name, runs the
 * module it names and caches it, for the node command's programs and the
 * lifo command runtime's packages alike.
 *
 * A name is a built-in (`fs`, `node:fs`), a `#` import of the nearest
 * package.json's "imports", a relative or absolute file (exact, then `.js`,
 * `.mjs`, `.json`; a directory's index.js), or a package: the nearest
 * node_modules up from the requiring module's directory, then the global
 * /usr/lib/node_modules and the legacy /usr/share/pkg/node_modules, its
 * entry from "exports" (by the shared resolver, _shared/exports-resolver.ts,
 * under require's conditions and then `import`), else "main", then
 * index.js; a `#` name likewise from "imports". A module runs once, cached
 * by its path before it runs (so a cycle sees its partial exports); an ES
 * module (.mjs, a .js under "type": "module", or ESM syntax) is lowered to
 * CommonJS and runs as strict code.
 */
import type { NodeFilesystem } from './filesystem.js';
import { createModuleMap, ProcessExitError, type NodeContext } from './index.js';
import { createModuleShim, type RequireFunction } from './module.js';
import { Buffer } from './buffer.js';
import type { AnyNode } from 'acorn';
import { emitCommonJs, generatedNames, readEsmRecords } from '../../../runtime/async-module-lowering.js';
import { applySourceEdits, forEachNode, hasTopLevelModuleSyntax, parseJavaScriptModule, parseJavaScriptProgram } from '../../../runtime/javascript-ast.js';
import { fileURLToPath } from './url.js';
import { scanCjsExports } from '../../../runtime/cjs-export-names.js';
import { resolve, dirname, join, extname } from '../utils/path.js';
import {
	DEFAULT_CJS_CONDITIONS,
	parseResolvablePackageJson,
	resolveExports,
	type ResolvablePackageJson,
} from '../../../_shared/exports-resolver.js';

export type PackageType = 'module' | 'commonjs' | null;

/**
 * The conditions this loader resolves "exports" and "imports" with: require's,
 * then `import`, since it also requires what a lowered ES module imports (an
 * ESM-only package declares only `import`).
 */
const REQUIRE_CONDITIONS = [...DEFAULT_CJS_CONDITIONS, 'import'];

/** Node's error for a module `require` cannot find: its message and its code. */
export function moduleNotFound(name: string): Error {
	return Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
}

/** Strip a shebang line (`#!/usr/bin/env node`), leaving a blank line so line numbers hold. */
export function stripShebang(src: string): string {
	if (src.charCodeAt(0) === 0x23 /* # */ && src.charCodeAt(1) === 0x21 /* ! */) {
		const nl = src.indexOf('\n');
		if (nl === -1) return '';
		return '\n' + src.slice(nl + 1);
	}
	return src;
}

/**
 * The `import.meta` and dynamic `import()` expressions of `source`, as acorn
 * parses it: as a module, or for CommonJS (`esm` false) as Node would run it,
 * a script whose top level may `return`. A CommonJS source that does not
 * parse has none here; compiling it reports the SyntaxError.
 */
function moduleOnlyExpressions(source: string, esm = true): { meta: AnyNode[]; dynamic: AnyNode[] } {
	const found = { meta: [] as AnyNode[], dynamic: [] as AnyNode[] };
	// Neither can occur without the keyword followed by `.` or `(`: a source without one needs no parse.
	if (!/\bimport\s*[.(]/.test(source)) return found;
	const program = esm ? parseJavaScriptModule(source) : parseJavaScriptProgram(source);
	if (program === null) return found;
	forEachNode(program, (node) => {
		if (node.type === 'MetaProperty' && node.meta.name === 'import') found.meta.push(node);
		else if (node.type === 'ImportExpression') found.dynamic.push(node);
	});
	return found;
}

/**
 * Whether `source` is an ES module by its syntax, as Node's detection reads
 * it: a top-level import or export declaration (not `import(`, not one
 * inside a string), or an `import.meta`.
 */
export function isEsmSource(source: string): boolean {
	if (hasTopLevelModuleSyntax(source)) return true;
	if (!source.includes('import.meta')) return false;
	try {
		return moduleOnlyExpressions(source).meta.length > 0;
	} catch {
		return false;
	}
}

/** A package.json's "type", when it declares one. */
export function declaredPackageType(packageJson: string): PackageType {
	try {
		const pkg: unknown = JSON.parse(packageJson);
		const type = typeof pkg === 'object' && pkg !== null && 'type' in pkg ? pkg.type : undefined;
		return type === 'module' || type === 'commonjs' ? type : null;
	} catch { return null; }
}

/** Nearest package.json "type" walking up from a .js file (Node.js semantics), read synchronously inside `require`. */
function packageType(filename: string, vfs: NodeFilesystem): PackageType {
	for (let dir = dirname(filename); ; dir = dirname(dir)) {
		const pkgPath = join(dir, 'package.json');
		if (vfs.exists(pkgPath)) return declaredPackageType(vfs.readFileString(pkgPath));
		if (dirname(dir) === dir) return null;
	}
}

/** Whether a module runs as an ES module: .mjs always, .cjs never, a .js by its package's type, else by its syntax. */
export function treatAsEsm(source: string, filename: string, declared: () => PackageType): boolean {
	const ext = extname(filename);
	if (ext === '.mjs') return true;
	if (ext === '.cjs') return false;
	const type = ext === '.js' ? declared() : null;
	return type === null ? isEsmSource(source) : type === 'module';
}

// The wrapper every module runs in: CommonJS's five names and the globals a
// module may find as free variables, then the loader's own values, under
// names moduleWrapper draws for each module (wrapperArguments passes them in
// this order).
const WRAPPER_PARAMS = 'exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global';

/**
 * `source` as the module wrapper's function text: a CommonJS body as written
 * but for its import() calls, or an ES module lowered (ESM when `esm`).
 *
 * The loader's values reach the body under names drawn, with the emitter's
 * own, from one generatedNames over the source, so none is a name the
 * source holds: import.meta, import() (which loads through this loader, from
 * the workspace, in either body), and the require and module the lowering's
 * lines use. A lowered module is one block, so its own bindings (`const
 * __dirname`, `import process from`, `const require = createRequire(...)`)
 * shadow the wrapper's parameters as module scope does.
 *
 * Throws a SyntaxError for an ES module that does not parse.
 */
export function moduleWrapper(source: string, esm: boolean, async = false): string {
	const names = generatedNames(source);
	const loader = { importMeta: names(), importDynamic: names(), require: names(), module: names() };
	const { meta, dynamic } = moduleOnlyExpressions(source, esm);
	const rewritten = applySourceEdits(source, [
		...(esm ? meta.map((node) => ({ start: node.start, end: node.end, text: loader.importMeta })) : []),
		...dynamic.map((node) => ({ start: node.start, end: node.start + 'import'.length, text: loader.importDynamic })),
	]);
	const body = esm
		? `"use strict";\n{\n${emitCommonJs(rewritten, readEsmRecords(rewritten), {
			body: 'sync',
			names,
			requireFunction: loader.require,
			exportsObject: `${loader.module}.exports`,
		})}\n}`
		: `\n${rewritten}`;
	const params = `${WRAPPER_PARAMS}, ${loader.importMeta}, ${loader.importDynamic}, ${loader.require}, ${loader.module}`;
	return `(${async ? 'async ' : ''}function(${params}) {${body}\n})`;
}

/** What one module's wrapper receives as console and process. */
export interface ModuleScope {
	readonly console: unknown;
	readonly process: unknown;
}

/**
 * A module namespace as Node builds one for a CommonJS module or a built-in:
 * `default` is `exports`, each other name its value on `exports` when it
 * has one as its own (undefined otherwise, and when reading it throws), in
 * code-unit order, on a frozen null-prototype object tagged `Module`.
 */
function namespaceObject(exports: unknown, names: readonly string[]): object {
	const namespace: Record<string | symbol, unknown> = Object.create(null);
	const values = new Map<string, unknown>([['default', exports]]);
	for (const name of names) {
		if (name === 'default' || values.has(name)) continue;
		let value: unknown;
		const holder = (typeof exports === 'object' && exports !== null) || typeof exports === 'function' ? exports : null;
		try {
			if (holder !== null && Object.hasOwn(holder, name)) value = Reflect.get(holder, name);
		} catch { /* a throwing getter reads as undefined, as Node's does */ }
		values.set(name, value);
	}
	for (const name of [...values.keys()].sort()) namespace[name] = values.get(name);
	Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
	return Object.freeze(namespace);
}

export interface CjsLoader {
	/** The built-ins `require` serves; `module`'s createRequire is this loader's. */
	readonly moduleMap: Record<string, () => unknown>;
	/** `require` as a module in `dir` has it. */
	requireFrom(dir: string): RequireFunction;
	/**
	 * The module at `filename`, run once and cached. `preread` is its source,
	 * and whether it is an ES module, when the caller has read it already (a
	 * lifo entry, read through the async view a mount may require).
	 */
	load(filename: string, preread?: { readonly source: string; readonly esm: boolean }): unknown;
	/** The arguments a module's wrapper is called with, `require` its own. */
	wrapperArguments(filename: string, module: { exports: unknown }, scope: ModuleScope): unknown[];
}

// @rollup/rollup-* are platform-specific NAPI addons, which no realm here can
// load. Vite's dev server uses es-module-lexer, not rollup's parser, so these
// may never be called; if they are, the hashes return stable stand-ins and
// the parsers throw.
function stubHash(radix: number) {
	return (data: unknown): string => {
		const s = typeof data === 'string' ? data : String(data);
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(radix);
	};
}
const rollupNativeStub = {
	parse: () => { throw new Error('[lifo] rollup native parser is not available in browser'); },
	parseAsync: () => Promise.reject(new Error('[lifo] rollup native parser is not available in browser')),
	xxhashBase64Url: stubHash(36),
	xxhashBase36: stubHash(36),
	xxhashBase16: stubHash(16),
};

/**
 * A loader over `context`'s filesystem. `scope` gives each module its
 * console and process (each module has its own, as the node command's
 * modules always have had).
 */
export function createCjsLoader(context: NodeContext, scope: (filename: string) => ModuleScope): CjsLoader {
	const filesystem = context.filesystem;
	const moduleMap = createModuleMap(context);
	const builtins = new Map<string, unknown>();
	/** The files this loader ran as ES modules: their exports are their namespaces. */
	const lowered = new Set<string>();
	/** import()'s namespace of each CommonJS module and built-in, by its filename or `node:` name. */
	const namespaces = new Map<string, object>();
	const cache: Record<string, unknown> = Object.create(null);

	// createRequire(filename) is require as a module at `filename` has it: a path, or a file: URL's decoded path.
	moduleMap.module = () => createModuleShim(moduleMap, (filename) => {
		const path = filename instanceof URL || String(filename).startsWith('file:') ? fileURLToPath(filename) : String(filename);
		return requireFrom(dirname(path));
	});

	function requireFrom(dir: string): RequireFunction {
		const req = ((id: string) => requireModule(id, dir)) as RequireFunction;
		req.resolve = (id: string) => {
			const name = id.startsWith('node:') ? id.slice(5) : id;
			if (moduleMap[name]) return name;
			const path = resolveFilename(name, dir);
			if (path === null) throw moduleNotFound(id);
			return path;
		};
		req.cache = cache;
		return req;
	}

	function requireModule(id: string, dir: string): unknown {
		const name = id.startsWith('node:') ? id.slice(5) : id;
		if (moduleMap[name]) {
			if (!builtins.has(name)) builtins.set(name, moduleMap[name]());
			return builtins.get(name);
		}
		const path = resolveFilename(name, dir);
		if (path !== null) return load(path);
		if (name.startsWith('@rollup/rollup-')) return rollupNativeStub;
		throw moduleNotFound(name);
	}

	function resolveFilename(name: string, dir: string): string | null {
		if (name.startsWith('#')) return resolvePackageImport(name, dir);
		if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) return resolveFile(name, dir);
		return resolveNodeModule(name, dir);
	}

	function resolveFile(name: string, fromDir: string): string | null {
		const absPath = resolve(fromDir, name);
		if (filesystem().exists(absPath)) {
			try {
				if (filesystem().stat(absPath).type === 'file') return absPath;
				const indexPath = join(absPath, 'index.js');
				if (filesystem().exists(indexPath)) return indexPath;
			} catch { /* fall through */ }
		}
		if (!extname(absPath)) {
			for (const ext of ['.js', '.mjs', '.json']) {
				if (filesystem().exists(absPath + ext)) return absPath + ext;
			}
		}
		return null;
	}

	/** The nearest package.json at or above `dir`, its directory and its entry fields. */
	function nearestPackage(dir: string): { dir: string; pkg: ResolvablePackageJson | null } | null {
		for (let current = dir; ; current = dirname(current)) {
			const pkgPath = join(current, 'package.json');
			if (filesystem().exists(pkgPath)) return { dir: current, pkg: parseResolvablePackageJson(filesystem().readFileString(pkgPath)) };
			if (dirname(current) === current) return null;
		}
	}

	/** A `#` name from the nearest package.json's "imports", as Node reads it (the nearest package.json wins). */
	function resolvePackageImport(name: string, fromDir: string): string | null {
		const nearest = nearestPackage(fromDir);
		const target = nearest?.pkg ? resolveExports(nearest.pkg.imports, name, REQUIRE_CONDITIONS) : null;
		return target && nearest ? resolveFile(target, nearest.dir) : null;
	}

	function resolveNodeModule(name: string, fromDir: string): string | null {
		const parts = name.split('/');
		const scoped = name.startsWith('@');
		if (scoped && parts.length < 2) return null;
		const packageName = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
		const rest = parts.slice(scoped ? 2 : 1);
		const subpath = rest.length > 0 ? rest.join('/') : null;

		for (let current = fromDir; ; current = dirname(current)) {
			const candidate = join(current, 'node_modules', packageName);
			if (filesystem().exists(candidate)) {
				const resolved = resolvePackageEntry(candidate, subpath);
				if (resolved) return resolved;
			}
			if (dirname(current) === current) break;
		}
		for (const base of ['/usr/lib/node_modules', '/usr/share/pkg/node_modules']) {
			const candidate = join(base, packageName);
			if (filesystem().exists(candidate)) {
				const resolved = resolvePackageEntry(candidate, subpath);
				if (resolved) return resolved;
			}
		}
		return null;
	}

	/**
	 * A package's file for `subpath` (null for its root), as Node's require
	 * finds it: where the package declares "exports", they decide (a subpath
	 * they do not export, or export as null, is not found); else the subpath
	 * as a file, or for the root its "main", then its index.js.
	 */
	function resolvePackageEntry(pkgDir: string, subpath: string | null): string | null {
		const pkgJsonPath = join(pkgDir, 'package.json');
		const pkg = filesystem().exists(pkgJsonPath) ? parseResolvablePackageJson(filesystem().readFileString(pkgJsonPath)) : null;
		const relative = (target: string) => (target.startsWith('.') || target.startsWith('/') ? target : `./${target}`);
		if (pkg?.exports !== undefined && pkg.exports !== null) {
			const target = resolveExports(pkg.exports, subpath ? `./${subpath}` : '.', REQUIRE_CONDITIONS);
			return target ? resolveFile(relative(target), pkgDir) : null;
		}
		if (subpath) return resolveFile(`./${subpath}`, pkgDir);
		const main = pkg?.main ? resolveFile(relative(pkg.main), pkgDir) : null;
		const indexPath = join(pkgDir, 'index.js');
		return main ?? (filesystem().exists(indexPath) ? indexPath : null);
	}

	function wrapperArguments(filename: string, module: { exports: unknown }, moduleScope: ModuleScope): unknown[] {
		const dir = filename === '[eval]' ? context.cwd : dirname(filename);
		const require = requireFrom(dir);
		const importMeta = {
			url: `file://${filename}`,
			dirname: dir,
			filename,
			require,
			resolve: (specifier: string) => { throw new Error(`import.meta.resolve('${specifier}') is not supported`); },
		};
		// import() as Node's: a promise of the module's namespace, rejected (never thrown) when it cannot load.
		const importDynamic = (specifier: string) => Promise.resolve().then(() => importNamespace(specifier, dir));
		return [
			module.exports, require, module, filename, dir,
			moduleScope.console, moduleScope.process, Buffer,
			globalThis.setTimeout, globalThis.setInterval,
			globalThis.clearTimeout, globalThis.clearInterval,
			{ process: moduleScope.process, Buffer, console: moduleScope.console },
			importMeta, importDynamic, require, module,
		];
	}

	/**
	 * What import() of `id` from `dir` answers, as Node's: an ES module's own
	 * namespace (its lowered exports); for a built-in or a CommonJS module, a
	 * namespace whose `default` is module.exports, with the names Node gives
	 * it, read off module.exports once it has run (a built-in's own keys; a
	 * CommonJS module's statically detected exports, its reexports' followed).
	 */
	function importNamespace(id: string, dir: string): unknown {
		const exports = requireModule(id, dir);
		const name = id.startsWith('node:') ? id.slice(5) : id;
		const filename = moduleMap[name] ? null : resolveFilename(name, dir);
		if (!moduleMap[name] && (filename === null || lowered.has(filename))) return exports;
		// One namespace per module, however import() names it, as Node's module map keeps it.
		const key = filename ?? `node:${name}`;
		const cached = namespaces.get(key);
		if (cached) return cached;
		const names = filename === null
			? (typeof exports === 'object' && exports !== null ? Object.keys(exports) : [])
			: filename.endsWith('.json') ? [] : [...cjsExportNames(filename, new Set())];
		const namespace = namespaceObject(exports, names);
		namespaces.set(key, namespace);
		return namespace;
	}

	/** A CommonJS module's export names as Node's ESM loader detects them (cjs-module-lexer), reexports followed. */
	function cjsExportNames(filename: string, seen: Set<string>): Set<string> {
		const names = new Set<string>();
		if (seen.has(filename)) return names;
		seen.add(filename);
		const found = scanCjsExports(filesystem().readFileString(filename));
		for (const specifier of found.reexports) {
			const resolved = resolveFilename(specifier, dirname(filename));
			if (resolved === null || resolved.endsWith('.json') || resolved.endsWith('.node')) continue;
			for (const reexported of cjsExportNames(resolved, seen)) names.add(reexported);
		}
		for (const exported of found.names) names.add(exported);
		return names;
	}

	function load(filename: string, preread?: { readonly source: string; readonly esm: boolean }): unknown {
		if (filename in cache) return cache[filename];
		const source = preread?.source ?? filesystem().readFileString(filename);
		if (filename.endsWith('.json')) {
			cache[filename] = JSON.parse(source);
			return cache[filename];
		}

		const module = { exports: {} as unknown };
		const initialExports = module.exports;
		// Cached before it runs, so a cycle sees its partial exports (Node.js behaviour).
		cache[filename] = initialExports;

		const clean = stripShebang(source);
		const esm = preread?.esm ?? treatAsEsm(clean, filename, () => packageType(filename, filesystem()));
		if (esm) lowered.add(filename);
		let fn: (...args: unknown[]) => void;
		try {
			// A module that does not compile, lowered or as written, names its file.
			fn = new Function(`return ${moduleWrapper(clean, esm)}`)();
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			err.message = `[${filename}] ${err.message}`;
			throw err;
		}
		try {
			fn(...wrapperArguments(filename, module, scope(filename)));
		} catch (e) {
			if (e instanceof ProcessExitError) throw e;
			const err = e instanceof Error ? e : new Error(String(e));
			if (!err.message.includes('[/')) err.message = `[${filename}] ${err.message}`;
			throw err;
		}
		// module.exports reassigned (not just mutated): the cache holds what it became.
		if (module.exports !== initialExports) cache[filename] = module.exports;
		return module.exports;
	}

	return { moduleMap, requireFrom, load, wrapperArguments };
}
