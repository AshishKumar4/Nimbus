/** A package.json's "type", when it declares one. */
export type PackageType = 'module' | 'commonjs' | null;
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
//# sourceMappingURL=module-format.d.ts.map