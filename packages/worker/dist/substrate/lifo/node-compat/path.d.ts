import { normalize, isAbsolute, join, resolve, dirname, basename, extname } from '../utils/path.js';
export declare function relative(from: string, to: string): string;
export interface ParsedPath {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
}
export declare function parse(path: string): ParsedPath;
export declare function format(pathObj: Partial<ParsedPath>): string;
export declare const sep = "/";
export declare const delimiter = ":";
export declare const posix: {
    normalize: typeof normalize;
    isAbsolute: typeof isAbsolute;
    join: typeof join;
    resolve: (...args: string[]) => string;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    relative: typeof relative;
    parse: typeof parse;
    format: typeof format;
    sep: string;
    delimiter: string;
};
export declare const win32: {
    normalize: typeof normalize;
    isAbsolute: typeof isAbsolute;
    join: typeof join;
    resolve: (...args: string[]) => string;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    relative: typeof relative;
    parse: typeof parse;
    format: typeof format;
    sep: string;
    delimiter: string;
};
export { normalize, isAbsolute, join, resolve, dirname, basename, extname };
declare const _default: {
    normalize: typeof normalize;
    isAbsolute: typeof isAbsolute;
    join: typeof join;
    resolve: (...args: string[]) => string;
    dirname: typeof dirname;
    basename: typeof basename;
    extname: typeof extname;
    relative: typeof relative;
    parse: typeof parse;
    format: typeof format;
    sep: string;
    delimiter: string;
    posix: {
        normalize: typeof normalize;
        isAbsolute: typeof isAbsolute;
        join: typeof join;
        resolve: (...args: string[]) => string;
        dirname: typeof dirname;
        basename: typeof basename;
        extname: typeof extname;
        relative: typeof relative;
        parse: typeof parse;
        format: typeof format;
        sep: string;
        delimiter: string;
    };
    win32: {
        normalize: typeof normalize;
        isAbsolute: typeof isAbsolute;
        join: typeof join;
        resolve: (...args: string[]) => string;
        dirname: typeof dirname;
        basename: typeof basename;
        extname: typeof extname;
        relative: typeof relative;
        parse: typeof parse;
        format: typeof format;
        sep: string;
        delimiter: string;
    };
};
export default _default;
//# sourceMappingURL=path.d.ts.map