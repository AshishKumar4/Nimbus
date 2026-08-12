declare const NativeURL: typeof URL;
declare const NativeURLSearchParams: typeof URLSearchParams;
export { NativeURL as URL, NativeURLSearchParams as URLSearchParams };
export declare function parse(urlString: string): {
    protocol: string | null;
    hostname: string | null;
    port: string | null;
    pathname: string;
    search: string | null;
    hash: string | null;
    host: string | null;
    href: string;
    path: string;
    query: string | null;
};
export declare function format(urlObj: {
    protocol?: string;
    hostname?: string;
    port?: string | number;
    pathname?: string;
    search?: string;
    hash?: string;
}): string;
export declare function resolve(from: string, to: string): string;
export declare function fileURLToPath(url: string | URL): string;
export declare function pathToFileURL(path: string): URL;
declare const _default: {
    URL: typeof URL;
    URLSearchParams: typeof URLSearchParams;
    parse: typeof parse;
    format: typeof format;
    resolve: typeof resolve;
    fileURLToPath: typeof fileURLToPath;
    pathToFileURL: typeof pathToFileURL;
};
export default _default;
//# sourceMappingURL=url.d.ts.map