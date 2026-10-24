/** Runs in the facet: hands the compiled image and the capability to the preamble's __wasiCliRun. */
export async function wasiCliFacetCall(args, facetEnv) {
    const program = globalThis.__NIMBUS_WASM?.['program.wasm'];
    const run = globalThis.__wasiCliRun;
    if (program === undefined || run === undefined) {
        return { exitCode: 127, error: 'wasi-cli-runner: the facet has no program image or no __wasiCliRun' };
    }
    return await run({ ...args, program, supervisor: facetEnv.SUPERVISOR });
}
