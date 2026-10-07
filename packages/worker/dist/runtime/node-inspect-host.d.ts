/**
 * What Node's util.inspect (node-inspect-source.ts) is given in a Worker in
 * place of Node's internal modules and bindings. createNodeInspect is
 * serialized into the shims (node-shims.ts, "util.inspect"), so it reads
 * nothing outside itself: its platform is passed in.
 *
 * Node's own functions are ported: lib/internal/util.js join, removeColors
 * and isError; lib/internal/errors.js isStackOverflowError and the message
 * of ERR_INVALID_ARG_TYPE; lib/internal/validators.js validateObject and
 * validateString; src/node_i18n.cc GetStringWidth. Of the util binding, the
 * property and constructor-name readers are JavaScript. What only V8's
 * internals can read (a promise's state, a proxy's target, an iterator's or
 * a weak collection's entries), and a workerd API object's properties, a
 * value needing them is formatted by the platform's own inspect for,
 * workerd's port of Node's, which reads them:
 * inspect.js reaches every object through getProxyDetails first, and formats
 * what that answers in the value's place, through its inspect hook. With
 * customInspect false the hook is not called, so such a value is formatted
 * with none of them: a promise is `<pending>`, an iterator's entries empty,
 * a proxy through its traps; Node reads them there too.
 */
/** A function of the platform's node:util, or of Node's inspect.js. */
type Fn = (...args: never[]) => unknown;
export interface NodeInspectPlatform {
    /** The platform's node:util: its inspect, for what only V8 reads, and its types. */
    util: {
        inspect(value: unknown, options?: object): string;
        types: Record<string, (value: unknown) => boolean>;
    };
    Buffer: unknown;
    url: {
        pathToFileURL: Fn;
        URL: unknown;
    };
    process: unknown;
    /** Node's public builtin module names (node:module builtinModules). */
    builtinModules: readonly string[];
    /** Whether a code point is East Asian Wide or Fullwidth (node-inspect-source.ts). */
    eastAsianWide(code: number): boolean;
    /** Runs lib/internal/per_context/primordials.js, filling `primordials`. */
    primordialsOf(primordials: object, global: typeof globalThis): void;
    /** Runs lib/internal/util/inspect.js as Node's loader runs a builtin. */
    inspectOf(exports: object, require: (id: string) => unknown, module: {
        exports: object;
    }, process: unknown, internalBinding: (name: string) => unknown, primordials: object): void;
}
/** What lib/internal/util/inspect.js exports, as the shims use it. */
export interface NodeInspectExports {
    inspect: ((value: unknown, options?: unknown) => string) & {
        defaultOptions: {
            customInspect: boolean;
        };
    };
    inspectDefaultOptions: {
        customInspect: boolean;
    };
    format(...args: unknown[]): string;
    formatWithOptions(options: unknown, ...args: unknown[]): string;
    getStringWidth(str: string, removeControlChars?: boolean): number;
    stripVTControlCharacters(str: string): string;
}
export declare function createNodeInspect(platform: NodeInspectPlatform): NodeInspectExports;
export {};
//# sourceMappingURL=node-inspect-host.d.ts.map