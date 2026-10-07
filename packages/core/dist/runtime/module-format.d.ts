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
 * The global the guest defines (node-shims.ts) with an accessor for each
 * CommonJS wrapper name, which throws the ReferenceError V8 throws for a name
 * bound nowhere ("require is not defined"), from the frame that named it.
 */
export declare const ES_MODULE_SCOPE_GLOBAL = "__nimbusEsmScope";
/**
 * What a free reference to each CommonJS wrapper name becomes in an ES module
 * lowered to the CommonJS a facet runs (commonjs-cell.ts): its accessor on
 * ES_MODULE_SCOPE_GLOBAL, so reading, calling or assigning it throws as in
 * Node's ES module scope, which binds none of them, while the lowering's own
 * require and module.exports still reach the wrapper's. `typeof` of one is
 * 'undefined' (esModuleScopeTypeofs). The transform's `define` (and the
 * bounded rewrite's equivalent) applies it.
 */
export declare const ES_MODULE_UNBOUND_NAMES: Readonly<Record<string, string>>;
/**
 * A lowered ES module's code with `typeof` of each wrapper name 'undefined',
 * as `typeof` of a name bound nowhere is, where the define made the name an
 * accessor that throws when read.
 */
export declare function esModuleScopeTypeofs(code: string): string;
/**
 * `source`, which Node runs as an ES module, as one to the transform whatever
 * its syntax: strict (a directive after any hashbang, on the first line, so
 * line numbers stay), and a module (an empty export after it), so its
 * top-level `this` is undefined.
 */
export declare function esModuleSource(source: string): string;
//# sourceMappingURL=module-format.d.ts.map