// Nimbus build stub, the OpenTUI parser's own worker_threads. The parser runs
// as a Worker that the facet's in-isolate polyfill (opencode-facet-runner.ts)
// hosts on the facet's one thread, so the platform's module says the main
// thread; to the parser it is a worker, its parent port the context the
// bundle's banner claimed. Only what a worker is told: a name the parser
// imports beyond these fails its build.
declare const __nimbusWorker: object

export const isMainThread = false
export const parentPort = __nimbusWorker
export const workerData = null
export const threadId = 1
