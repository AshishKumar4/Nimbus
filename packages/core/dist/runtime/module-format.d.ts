/** A package.json's "type", when it declares one. */
export type PackageType = 'module' | 'commonjs' | null;
/** The "type" a parsed package.json declares. */
export declare function packageTypeOf(pkg: unknown): PackageType;
/** The "type" a package.json's text declares. */
export declare function declaredPackageType(packageJson: string): PackageType;
/**
 * Whether Node runs the file at `path` as an ES module: `.mjs` always, `.cjs`
 * never, a `.js` or extensionless file as the nearest package.json's "type"
 * says (`packageType`, asked only for those), and otherwise by its syntax
 * (containsModuleSyntax), in node_modules as anywhere.
 */
export declare function isEsModuleFile(path: string, source: string, packageType: () => PackageType): boolean;
/** Node 22.23.4's get_format.js for TypeScript; `stripped` is read only for a typeless `.ts`. */
export declare function typeScriptFormat(path: string, packageType: () => PackageType, stripped: () => string): 'module' | 'commonjs' | null;
/**
 * TypeScript Node does not strip (`--no-experimental-strip-types`) run as the
 * program's entry: Node's ES loader takes it under `--import`, in a type:module
 * package or with module syntax (run_main.js), and refuses its extension;
 * otherwise its CommonJS loader runs it as JavaScript. Required, such a file is
 * the CommonJS loader's whatever its package (its .js handler reads the type of
 * .js alone): an ES module by its syntax.
 */
export declare function typeScriptEntryRefused(packageType: PackageType, source: string, imports: boolean): boolean;
/** Node refuses to strip a file under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). */
export declare function typeScriptUnderNodeModules(path: string): boolean;
/**
 * Whether Node runs `--eval` code or a program read from stdin as an ES
 * module: as `--input-type` says, and without it by its syntax, compiled as
 * Node compiles such code as CommonJS, where no wrapper binds a name.
 */
export declare function isEsModuleInput(source: string, inputType: string | undefined): boolean;
/**
 * Whose scope a runtime runs an ES module in. Node's binds none of
 * CommonJS's wrapper names. Bun's binds `require`, `__filename` and
 * `__dirname` in every module (bun.sh/docs/runtime/modules), which a staged
 * module imports from its meta instance (native-esm.ts EsModuleLink).
 */
export type ModuleScope = 'node' | 'bun';
//# sourceMappingURL=module-format.d.ts.map