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
/**
 * Whether Node runs `--eval` code or a program read from stdin as an ES
 * module: as `--input-type` says, and without it by its syntax.
 */
export declare function isEsModuleInput(source: string, inputType: string | undefined): boolean;
/**
 * What a free reference to each CommonJS wrapper name becomes in an ES module
 * lowered to the CommonJS a facet runs (commonjs-cell.ts): a name bound
 * nowhere, so `typeof require` is 'undefined' and a call or read throws
 * ReferenceError, as in Node's ES module scope, while the lowering's own
 * require and module.exports still reach the wrapper's. The transform's
 * `define` (and the bounded rewrite's equivalent) applies it.
 */
export declare const ES_MODULE_UNBOUND_NAMES: Readonly<Record<string, string>>;
/**
 * `source`, which Node runs as an ES module, as one to the transform whatever
 * its syntax: strict (a directive after any hashbang, on the first line, so
 * line numbers stay), and a module (an empty export after it), so its
 * top-level `this` is undefined.
 */
export declare function esModuleSource(source: string): string;
//# sourceMappingURL=module-format.d.ts.map