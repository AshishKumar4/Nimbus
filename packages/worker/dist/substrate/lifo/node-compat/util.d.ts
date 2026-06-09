export declare function format(fmt: string, ...args: unknown[]): string;
export declare function inspect(obj: unknown, opts?: {
    depth?: number;
    colors?: boolean;
}): string;
export declare function promisify<T>(fn: (...args: [...unknown[], (err: unknown, result: T) => void]) => void): (...args: unknown[]) => Promise<T>;
export declare function inherits(ctor: {
    prototype: object;
    super_?: unknown;
}, superCtor: {
    prototype: object;
} | null | undefined): void;
export declare function deprecate<T extends (...args: unknown[]) => unknown>(fn: T, msg: string): T;
export declare function types(): {
    isDate: (v: unknown) => v is Date;
    isRegExp: (v: unknown) => v is RegExp;
    isArray: (arg: any) => arg is any[];
};
/** Strip ANSI/VT control sequences from a string (ESC[...m, etc.) */
export declare function stripVTControlCharacters(str: string): string;
declare const RuntimeTextDecoder: new (label?: string, options?: {
    fatal?: boolean;
    ignoreBOM?: boolean;
}) => TextDecoder;
declare const RuntimeTextEncoder: new () => TextEncoder;
export { RuntimeTextDecoder as TextDecoder, RuntimeTextEncoder as TextEncoder, };
declare const _default: {
    format: typeof format;
    inspect: typeof inspect;
    promisify: typeof promisify;
    inherits: typeof inherits;
    deprecate: typeof deprecate;
    types: typeof types;
    stripVTControlCharacters: typeof stripVTControlCharacters;
    TextDecoder: new (label?: string, options?: {
        fatal?: boolean;
        ignoreBOM?: boolean;
    }) => TextDecoder;
    TextEncoder: new () => TextEncoder;
};
export default _default;
//# sourceMappingURL=util.d.ts.map