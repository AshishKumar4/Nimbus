// The launch's captures (core _shared/primordials.ts), as commonjs-cell holds
// them for every launch (__nimbusLaunchCaptures): the write ledger, the
// resident library and the shims read them by that name. A test that
// evaluates them standalone finds them as a global, taken in the test's realm
// before any factory runs, so a ledger spliced ahead of the store's prelude
// has them too.
globalThis.__nimbusTestLaunchCaptures ??= await import('../../../packages/core/src/_shared/primordials.ts');
globalThis.__nimbusLaunchCaptures ??= globalThis.__nimbusTestLaunchCaptures;
