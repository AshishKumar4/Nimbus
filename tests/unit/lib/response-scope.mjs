/** The scope of a caller done with a response's body once it has it (RouteableFacetTarget). */
export const settledScope = () => ({ signal: new AbortController().signal, settled: Promise.resolve() });
