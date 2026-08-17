/**
 * @nimbus-sh/fabric — the Cloudflare-specific DO/facet machinery of Nimbus.
 *
 * Root export for workerd contexts. `bindings.ts` imports
 * `cloudflare:workers`, so importing this root module outside workerd fails
 * at resolution; non-workerd consumers (tests, tooling) import the subpath
 * modules they need instead.
 */

export {};
