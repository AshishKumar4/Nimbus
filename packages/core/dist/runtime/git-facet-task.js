/** Runs in the facet: hands the compiled image and the capability to the preamble's __gitRun. */
export async function gitFacetCall(args, facetEnv) {
    const modules = Reflect.get(globalThis, '__NIMBUS_WASM');
    const gitMod = modules?.['git.wasm'];
    const run = Reflect.get(globalThis, '__gitRun');
    if (!gitMod || typeof run !== 'function') {
        return { exitCode: 127, stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: 'git-runner: the facet has no git image or no __gitRun' };
    }
    return await run({ ...args, gitMod, supervisor: facetEnv?.SUPERVISOR });
}
