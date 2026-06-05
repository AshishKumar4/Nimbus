/**
 * router-basename.ts — Auto-inject React Router `basename` for the /preview/
 * base path so `<NavLink to="/docs">` lands at `/preview/docs` with no
 * additional config in the user's source.
 *
 * Applied at VFS serve time inside vite-dev-server.ts `serveTransformed()`,
 * BEFORE esbuild's TS/JSX transform (source is easier to regex on).
 *
 * Patterns handled:
 *   A. createBrowserRouter(routes)                    → inject { basename }
 *   B. createBrowserRouter(routes, { ... })           → merge if no basename
 *   C. <BrowserRouter ...>                            → add basename attr
 *   D. <BrowserRouter basename="x">                   → leave alone
 *
 * Never overrides user-set values. Opt-out:
 *   - Explicit basename in source (per pattern)
 *   - Comment `// nimbus-no-basename` anywhere in the file
 *   - `nimbusInjectBasename: false` in vite.config.ts (plumbed by caller)
 *
 * Scope guard: only transforms likely router entry files (main.tsx, index.tsx,
 * App.tsx, root.tsx, router.tsx). node_modules is excluded by the caller.
 */
/**
 * Should this VFS path be considered for router-basename injection?
 * Fast filter before we pay for regex scans on the file body.
 */
export declare function shouldProcessForRouter(vfsPath: string): boolean;
/**
 * Inject a `basename` into React Router `createBrowserRouter` / <BrowserRouter>
 * calls in the source, unless the user has set one or opted out.
 *
 * Returns the transformed source. Always safe — if no pattern matches,
 * returns the input unchanged.
 */
export declare function injectRouterBasename(src: string, basePath: string): string;
//# sourceMappingURL=router-basename.d.ts.map