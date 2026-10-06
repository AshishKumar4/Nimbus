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
 * entry from "exports" (conditions require, default, import; `./sub` and
 * `./dir/*` subpaths), then "main", then index.js. A module runs once, cached
 * by its path before it runs (so a cycle sees its partial exports); an ES
 * module (.mjs, a .js under "type": "module", or ESM syntax) is lowered to
 * CommonJS and runs as strict code.
 */
import type { NodeFilesystem } from './filesystem.js';
import { createModuleMap, ProcessExitError, type NodeContext } from './index.js';
import { createModuleShim, type RequireFunction } from './module.js';
import { Buffer } from './buffer.js';
import { transformEsmToCjs } from './esm-to-cjs.js';
import { resolve, dirname, join, extname } from '../utils/path.js';

export type PackageType = 'module' | 'commonjs' | null;

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

/** Whether `source` has ESM import/export syntax: at a line start, after `;`, or minified (`import{`, `import*`). */
export function isEsmSource(source: string): boolean {
	return /(?:^|\n|;)\s*(?:import\s*[\w{*('".]|export\s+|export\s*\{)/.test(source);
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

// The wrapper every module runs in: CommonJS's five names, the globals a
// module may find as free variables, and import.meta for lowered ESM.
const WRAPPER_PARAMS = 'exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global, __importMetaUrl, __importMeta, __importMetaResolve';

/** `source`, ESM lowered when `esm`, as the module wrapper's function text. */
export function moduleWrapper(source: string, esm: boolean, async = false): string {
	const body = esm ? `"use strict";\n${transformEsmToCjs(source)}` : `\n${source}`;
	return `(${async ? 'async ' : ''}function(${WRAPPER_PARAMS}) {${body}\n})`;
}

/** What one module's wrapper receives as console and process. */
export interface ModuleScope {
	readonly console: unknown;
	readonly process: unknown;
}

export interface CjsLoader {
	/** The built-ins `require` serves; `module`'s createRequire is this loader's. */
	readonly moduleMap: Record<string, () => unknown>;
	/** `require` as a module in `dir` has it. */
	requireFrom(dir: string): RequireFunction;
	/** The module at `filename`, run once and cached. */
	load(filename: string): unknown;
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
	const cache: Record<string, unknown> = Object.create(null);

	// createRequire(filename) is require as a module at `filename` has it.
	moduleMap.module = () => createModuleShim(moduleMap, (filename) => {
		const path = String(filename).replace(/^file:\/\//, '');
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

	/** A `#` name from the nearest package.json's "imports", as Node reads it (the nearest package.json wins). */
	function resolvePackageImport(name: string, fromDir: string): string | null {
		for (let current = fromDir; ; current = dirname(current)) {
			const pkgPath = join(current, 'package.json');
			if (filesystem().exists(pkgPath)) {
				try {
					const pkg = JSON.parse(filesystem().readFileString(pkgPath));
					if (pkg.imports && typeof pkg.imports === 'object' && name in pkg.imports) {
						const target = resolveExportsCondition(pkg.imports[name]);
						if (target) return resolveFile(target, current);
					}
				} catch { /* ignore parse errors */ }
				return null;
			}
			if (dirname(current) === current) return null;
		}
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

	/** A conditional exports value (string | { require, default, import, ... }): require first, as CommonJS asks. */
	function resolveExportsCondition(value: unknown): string | null {
		if (typeof value === 'string') return value;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const cond = value as Record<string, unknown>;
			if (typeof cond.require === 'string') return cond.require;
			if (typeof cond.default === 'string') return cond.default;
			if (typeof cond.import === 'string') return cond.import;
			// Nested conditions (e.g. { node: { require: ... } }); TS declarations are not code.
			for (const key of Object.keys(cond)) {
				if (key === 'types') continue;
				const nested = resolveExportsCondition(cond[key]);
				if (nested) return nested;
			}
		}
		return null;
	}

	function resolvePackageEntry(pkgDir: string, subpath: string | null): string | null {
		const pkgJsonPath = join(pkgDir, 'package.json');
		let pkgJson: Record<string, unknown> | null = null;
		if (filesystem().exists(pkgJsonPath)) {
			try { pkgJson = JSON.parse(filesystem().readFileString(pkgJsonPath)); } catch { /* ignore */ }
		}

		if (subpath) {
			// The exports map's `./sub` entry, or a `./dir/*` pattern; else the file itself.
			if (pkgJson?.exports && typeof pkgJson.exports === 'object') {
				const exportsMap = pkgJson.exports as Record<string, unknown>;
				const key = `./${subpath}`;
				if (key in exportsMap) {
					const target = resolveExportsCondition(exportsMap[key]);
					const resolved = target ? resolveFile(target, pkgDir) : null;
					if (resolved) return resolved;
				}
				for (const pattern of Object.keys(exportsMap)) {
					if (!pattern.endsWith('/*') || !key.startsWith(pattern.slice(0, -1))) continue;
					const targetPattern = resolveExportsCondition(exportsMap[pattern]);
					if (!targetPattern?.endsWith('/*')) continue;
					const resolved = resolveFile(targetPattern.slice(0, -1) + key.slice(pattern.length - 1), pkgDir);
					if (resolved) return resolved;
				}
			}
			return resolveFile(`./${subpath}`, pkgDir);
		}

		// exports["."] (or an exports that is itself the condition map), then main, then index.js.
		if (pkgJson?.exports) {
			const exportsVal = pkgJson.exports;
			let rootExport: unknown = null;
			if (typeof exportsVal === 'string') {
				rootExport = exportsVal;
			} else if (typeof exportsVal === 'object' && !Array.isArray(exportsVal)) {
				const exportsMap = exportsVal as Record<string, unknown>;
				rootExport = exportsMap['.'] ?? null;
				if (!rootExport && ('require' in exportsMap || 'import' in exportsMap || 'default' in exportsMap)) {
					rootExport = exportsMap;
				}
			}
			const target = rootExport ? resolveExportsCondition(rootExport) : null;
			const resolved = target ? resolveFile(target, pkgDir) : null;
			if (resolved) return resolved;
		}
		if (typeof pkgJson?.main === 'string') {
			const resolved = resolveFile(`./${pkgJson.main}`, pkgDir);
			if (resolved) return resolved;
		}
		const indexPath = join(pkgDir, 'index.js');
		return filesystem().exists(indexPath) ? indexPath : null;
	}

	function wrapperArguments(filename: string, module: { exports: unknown }, moduleScope: ModuleScope): unknown[] {
		const dir = filename === '[eval]' ? context.cwd : dirname(filename);
		const importMetaUrl = `file://${filename}`;
		return [
			module.exports, requireFrom(dir), module, filename, dir,
			moduleScope.console, moduleScope.process, Buffer,
			globalThis.setTimeout, globalThis.setInterval,
			globalThis.clearTimeout, globalThis.clearInterval,
			{ process: moduleScope.process, Buffer, console: moduleScope.console },
			importMetaUrl, { url: importMetaUrl, dirname: dir, filename },
			(specifier: string) => { throw new Error(`import.meta.resolve('${specifier}') is not supported`); },
		];
	}

	function load(filename: string): unknown {
		if (filename in cache) return cache[filename];
		const source = filesystem().readFileString(filename);
		if (filename.endsWith('.json')) return (cache[filename] = JSON.parse(source));

		const module = { exports: {} as unknown };
		const initialExports = module.exports;
		// Cached before it runs, so a cycle sees its partial exports (Node.js behaviour).
		cache[filename] = initialExports;

		const clean = stripShebang(source);
		const wrapped = moduleWrapper(clean, treatAsEsm(clean, filename, () => packageType(filename, filesystem())));
		let fn: (...args: unknown[]) => void;
		try {
			fn = new Function(`return ${wrapped}`)();
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
