/**
 * dev-stylesheet.ts — a stylesheet as the Vite dev server serves it: its
 * local `@import`s inlined by the CSS layer and rules `vite build` bundles
 * with (core runtime/css-bundle.ts, on css-tree), so dev and build agree on
 * what an import means: its conditions wrap what it imports (`@media`,
 * `@supports`, `@layer`), a sheet imported twice keeps its last place,
 * imports of remote sheets are hoisted, nested imports are followed.
 *
 * Unlike a build, nothing is emitted: each `url()` becomes its file's path
 * from the project root (under the dev server's base), so a `url()` in an
 * inlined sheet still names its file wherever the sheet that imported it is
 * served. An `@import` that names no file in the project stays an `@import`
 * for the browser to fetch and report.
 */
/** The reads a stylesheet needs from the dev server's VFS. */
export interface DevStylesheetFs {
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    readFileString(path: string): string;
}
/**
 * The stylesheet at `vfsPath` (under the project's `root`), its imports
 * inlined, its url()s rooted at `base`. A sheet the CSS layer refuses (an
 * `@import` with no URL) is served as written, the reason in a comment first.
 */
export declare function devStylesheet(fs: DevStylesheetFs, root: string, base: string, vfsPath: string): Promise<string>;
//# sourceMappingURL=dev-stylesheet.d.ts.map