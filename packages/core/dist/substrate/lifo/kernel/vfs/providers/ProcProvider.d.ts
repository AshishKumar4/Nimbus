import type { VirtualProvider, Stat, Dirent } from '../types.js';
export declare class ProcProvider implements VirtualProvider {
    private generators;
    constructor();
    private isNetPath;
    private getNetInfo;
    private generate;
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
}
//# sourceMappingURL=ProcProvider.d.ts.map