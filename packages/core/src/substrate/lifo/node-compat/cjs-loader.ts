/**
 * The lifo node's CommonJS loader: how `require` resolves a name, runs the
 * module it names and caches it, for the node command's programs and the
 * lifo command runtime's packages alike.
 *
 * A name is a built-in (`fs`, `node:fs`), a `#` import of the nearest
 * package.json's "imports", a relative or absolute file (Node's exact, `.js`,
 * `.json`, `.node` and main/index probing), or a package: the nearest
 * node_modules up from the requiring module's directory, then the global
 * /usr/lib/node_modules and the legacy /usr/share/pkg/node_modules, its
 * entry from "exports" (by the shared resolver, _shared/exports-resolver.ts,
 * under require's conditions), else "main", then
 * index.js; a `#` name likewise from "imports". A module runs once, cached
 * by its path before it runs (so a cycle sees its partial exports); an ES
 * module (.mjs, a .js under "type": "module", or ESM syntax) goes to the
 * realm's native ES module loader, not the CommonJS wrapper.
 */
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { createModuleMap, ProcessExitError, type NodeContext } from './index.js';
import { createModuleShim, servedName, type RequireFunction } from './module.js';
import { pathToFileURL } from './file-url.js';
import { rewriteDynamicImports, unusedIdentifier } from '../../../runtime/dynamic-import-rewrite.js';
import { isEsModuleFile, type PackageType } from '../../../runtime/module-format.js';
import { resolve, dirname } from '../utils/path.js';
import { invalidArgType } from '../../../_shared/node-error.js';
import { createRequireResolver, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, requireNodeModulePaths, type RequireResolverOptions, type RequireResolveOptions } from '../../../runtime/require-resolution.js';

/** Lifo's product package registry folders; intentionally not Node's globals. */
const LIFO_REQUIRE_POLICY = {
	...NIMBUS_TYPESCRIPT_REQUIRE_POLICY,
	name: 'lifo-typescript-and-product-global-folders',
	globalFolders: ['/usr/lib/node_modules', '/usr/share/pkg/node_modules'],
};

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

// The wrapper every module runs in: CommonJS's five names and the globals a
// module may find as free variables, then import()'s loader under a name the
// source does not hold (wrapperArguments passes them in this order).
const WRAPPER_PARAMS = 'exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global';

/**
 * A CommonJS body as written, but for import() calls routed to the native
 * loader. The extra parameter cannot collide with a source's own name,
 * including a Unicode-escaped spelling.
 */
export function moduleWrapper(source: string, parentUrl: string): string {
	const loader = unusedIdentifier(source, '__lifoImport');
	const body = rewriteDynamicImports(source, parentUrl, loader);
	return `(function(${WRAPPER_PARAMS}, ${loader}) {\n${body}\n})`;
}

/** What one module's wrapper receives as console, process and global. */
export interface ModuleScope {
	readonly console: unknown;
	readonly process: unknown;
	/** Every module's `global`: a program's realm's globalThis, as Node's is. */
	readonly global: unknown;
}

/** The native loader installed for this CommonJS loader's module graph. */
export interface NativeModuleLoader {
	importModule(specifier: string, parentUrl: string, options?: unknown): Promise<unknown>;
	requireModule(filename: string, parentFilename?: string): unknown;
	/** module.syncBuiltinESMExports: each builtin's ES module namespace takes its exports' current values. */
	syncBuiltinESMExports(): void;
}

export interface CjsLoader {
	/** The built-ins `require` serves; `module`'s createRequire is this loader's. */
	readonly moduleMap: Record<string, () => unknown>;
	/** `require` as a module in `dir` has it. */
	requireFrom(dir: string): RequireFunction;
	/** A resolver or facade uses the same cache and builtins as require(). */
	resolveFilename(specifier: string, dir: string): string | null;
	/** Installed before a node program runs; lifo commands install it in their own URL scope. */
	setNativeLoader(loader: NativeModuleLoader): void;
	/**
	 * The module at `filename`, run once and cached. `preread` is its source,
	 * and whether it is an ES module, when the caller has read it already (a
	 * lifo entry, read through the async view a mount may require).
	 */
	load(filename: string, preread?: { readonly source: string; readonly esm: boolean }): unknown;
	/** The arguments a module's wrapper is called with, `require` its own. */
	wrapperArguments(filename: string, module: { exports: unknown }): unknown[];
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
 * A loader over `context`'s filesystem. `scope` is the program's console and
 * process, every module's, as Node has one process; require('process') and
 * require('console') are them.
 */
export function createCjsLoader(context: NodeContext, scope: ModuleScope, options: RequireResolverOptions = {}): CjsLoader {
	const filesystem = context.filesystem;
	const moduleMap = createModuleMap(context);
	moduleMap.process = () => scope.process;
	moduleMap.console = () => scope.console;
	const builtins = new Map<string, unknown>();
	let native: NativeModuleLoader | undefined;
	const cache: Record<string, unknown> = Object.create(null);
	const classified = new Map<string, PackageType>();
	const resolver = createRequireResolver({
		kind(path) {
			const fs = filesystem();
			return !fs.exists(path) ? null : fs.isDirectory(path) ? 'directory' : fs.isFile(path) ? 'file' : null;
		},
		readText(path) { return filesystem().readFileString(path); },
		realpath(path) { return filesystem().realpath(path); },
		isBuiltin(id) { return servedName(moduleMap, id) !== null; },
	}, { ...options, policy: options.policy ?? LIFO_REQUIRE_POLICY });

	// createRequire(filename) is require as a module at `filename` has it: a path, or a file: URL's decoded path.
	moduleMap.module = () => {
		const shim = createModuleShim(moduleMap, (filename) => {
			const path = filename instanceof URL || String(filename).startsWith('file:') ? fileURLToPath(filename) : String(filename);
			return requireFrom(dirname(path), path);
		});
		return Object.assign(shim, {
			_resolveFilename(id: string, parent?: { filename?: string }, _isMain?: boolean, request?: { paths?: string[] }) {
				return requireFrom(dirname(parent?.filename ?? context.filename)).resolve(id, request);
			},
			_resolveLookupPaths(id: string, parent?: { filename?: string }) {
				return requireFrom(dirname(parent?.filename ?? context.filename)).resolve.paths!(id);
			},
			_nodeModulePaths: requireNodeModulePaths,
			globalPaths: [...((options.policy ?? LIFO_REQUIRE_POLICY).globalFolders ?? [])],
			syncBuiltinESMExports() { native?.syncBuiltinESMExports(); },
		});
	};

	function requireFrom(dir: string, parentFilename?: string): RequireFunction {
		const req = ((id: string) => requireModule(id, dir, parentFilename)) as RequireFunction;
		req.resolve = (id: string, options?: { paths?: string[] }) => {
			if (typeof id !== 'string') throw invalidArgType('request', 'string', id);
			if (servedName(moduleMap, id) !== null) return id;
			if (options?.paths !== undefined && !Array.isArray(options.paths)) {
				throw Object.assign(new TypeError('The property "options.paths" must be an Array'), { code: 'ERR_INVALID_ARG_VALUE' });
			}
			const origin = (path: string) => {
				if (typeof path !== 'string') throw invalidArgType('paths[0]', 'string', path);
				return resolve(context.cwd, path);
			};
			const relative = id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../');
			if (relative && options?.paths) {
				for (const from of options.paths) {
					const path = resolveFilename(id, dir, { paths: [origin(from)] });
					if (path !== null) return path;
				}
				throw moduleNotFound(id);
			}
			const paths = options?.paths?.map(origin);
			const path = resolveFilename(id, dir, { paths });
			if (path === null) throw moduleNotFound(id);
			return path;
		};
		req.resolve.paths = (id: string) => {
			if (typeof id !== 'string') throw invalidArgType('request', 'string', id);
			if (servedName(moduleMap, id) !== null) return null;
			return id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../')
				? [dir] : [...requireNodeModulePaths(dir), ...((options.policy ?? LIFO_REQUIRE_POLICY).globalFolders ?? [])];
		};
		req.cache = cache;
		return req;
	}

	function requireModule(id: string, dir: string, parentFilename?: string): unknown {
		const served = servedName(moduleMap, id);
		if (served !== null) {
			if (!builtins.has(served)) builtins.set(served, moduleMap[served]());
			return builtins.get(served);
		}
		const name = id.startsWith('node:') ? id.slice(5) : id;
		if (id.startsWith('node:')) throw Object.assign(new Error('No such built-in module: ' + id), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
		const path = resolveFilename(id, dir);
		if (path !== null) return path.startsWith('node:') ? requireModule(path, dir, parentFilename) : load(path, undefined, parentFilename);
		if (name.startsWith('@rollup/rollup-')) return rollupNativeStub;
		throw moduleNotFound(name);
	}

	function resolveFilename(name: string, dir: string, request?: RequireResolveOptions): string | null {
		const found = resolver.resolveSync(name, dir, request);
		if (!found) return null;
		if (found.builtin) return name.startsWith('#') ? 'node:' + found.builtin : name;
		if (!found.path) return null;
		classified.set(found.path, found.packageType);
		return found.path;
	}

	function wrapperArguments(filename: string, module: { exports: unknown }): unknown[] {
		const dir = filename === '[eval]' ? context.cwd : dirname(filename);
		const require = requireFrom(dir, filename);
		// Resolution failures reject import()'s promise; none are thrown by the call itself.
		const importDynamic = (parentUrl: string, specifier: string, options?: unknown) => Promise.resolve().then(() => {
			if (!native) throw new Error('Native ES modules require a lifo native module loader');
			return native.importModule(specifier, parentUrl, options);
		});
		return [
			module.exports, require, module, filename, dir,
			scope.console, scope.process, Buffer,
			globalThis.setTimeout, globalThis.setInterval,
			globalThis.clearTimeout, globalThis.clearInterval,
			scope.global,
			importDynamic,
		];
	}

	function load(filename: string, preread?: { readonly source: string; readonly esm: boolean }, parentFilename?: string): unknown {
		if (filename in cache) return cache[filename];
		const source = preread?.source ?? filesystem().readFileString(filename);
		if (filename.endsWith('.json')) {
			cache[filename] = JSON.parse(source);
			return cache[filename];
		}

		const clean = stripShebang(source);
		const esm = preread?.esm ?? isEsModuleFile(filename, clean, () => classified.has(filename)
			? classified.get(filename)! : resolver.packageScopeSync(dirname(filename))?.type ?? null);
		if (esm) {
			if (!native) throw new Error('Native ES modules require a lifo native module loader');
			return native.requireModule(filename, parentFilename);
		}

		const module = { exports: {} as unknown };
		const initialExports = module.exports;
		// Cached before it runs, so a cycle sees its partial exports (Node.js behaviour).
		cache[filename] = initialExports;

		let fn: (...args: unknown[]) => void;
		try {
			fn = new Function(`return ${moduleWrapper(clean, pathToFileURL(filename).href)}`)();
		} catch (e) {
			delete cache[filename];
			const err = e instanceof Error ? e : new Error(String(e));
			err.message = `[${filename}] ${err.message}`;
			throw err;
		}
		try {
			// Node's: the wrapper runs with `this` the module's exports.
			fn.call(module.exports, ...wrapperArguments(filename, module));
		} catch (e) {
			delete cache[filename];
			if (e instanceof ProcessExitError) throw e;
			const err = e instanceof Error ? e : new Error(String(e));
			if (Reflect.get(err, 'code') === 'ERR_REQUIRE_ASYNC_MODULE' || Reflect.get(err, 'code') === 'ERR_REQUIRE_CYCLE_MODULE') throw err;
			if (!err.message.includes('[/')) err.message = `[${filename}] ${err.message}`;
			throw err;
		}
		// module.exports reassigned (not just mutated): the cache holds what it became.
		if (module.exports !== initialExports) cache[filename] = module.exports;
		return module.exports;
	}

	return { moduleMap, requireFrom, resolveFilename, load, wrapperArguments, setNativeLoader: (loader) => { native = loader; } };
}
