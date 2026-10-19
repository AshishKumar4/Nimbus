// The launch's captures (core _shared/primordials.ts), as commonjs-cell holds
// them for every launch (__nimbusLaunchCaptures): the resident library and the
// shims read them by that name. A test that evaluates them standalone binds
// it from here, taken in the test's realm before any factory runs.
globalThis.__nimbusTestLaunchCaptures ??= await import('../../../packages/core/src/_shared/primordials.ts');
