// The `node:module` surface lifo's native ES module loader uses
// (substrate/lifo/node-compat/native-esm-loader.ts): Node's synchronous
// in-thread loader hooks (Node >= 22.15) and createRequire. Bun provides
// createRequire, and its own loader plugins instead of the hooks.
declare module 'node:module' {
  interface ResolveContext {
    readonly conditions: readonly string[];
    readonly importAttributes: Readonly<Record<string, string>>;
    readonly parentURL: string | undefined;
  }
  interface ResolveResult {
    readonly url: string;
    readonly format?: string | null;
    readonly importAttributes?: Readonly<Record<string, string>>;
    readonly shortCircuit?: boolean;
  }
  interface LoadContext {
    readonly conditions: readonly string[];
    readonly format: string | null | undefined;
    readonly importAttributes: Readonly<Record<string, string>>;
  }
  interface LoadResult {
    readonly format: string;
    readonly source?: string | Uint8Array;
    readonly shortCircuit?: boolean;
  }
  export function registerHooks(hooks: {
    resolve?(specifier: string, context: ResolveContext, nextResolve: (specifier: string, context?: Partial<ResolveContext>) => ResolveResult): ResolveResult;
    load?(url: string, context: LoadContext, nextLoad: (url: string, context?: Partial<LoadContext>) => LoadResult): LoadResult;
  }): { deregister(): void };
  export function createRequire(filename: string | URL): (id: string) => unknown;
}
