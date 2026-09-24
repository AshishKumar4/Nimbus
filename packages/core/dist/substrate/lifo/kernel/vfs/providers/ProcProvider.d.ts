import type { VirtualProvider, Stat, Dirent, KernelMountDescription } from '../types.js';
import type { VfsCred } from '../../../../../runtime/os-contracts.js';
/** A /proc file's content, for the credential of the process reading it. */
export type ProcGenerator = (cred: VfsCred | undefined) => string;
export declare class ProcProvider implements VirtualProvider {
    private generators;
    private cred;
    constructor();
    /** Add or replace `/proc/<name>`. */
    register(name: string, generator: ProcGenerator): void;
    /** The same files, generated for `cred`; shares the generator table. */
    as(cred: VfsCred): ProcProvider;
    describeMount(): KernelMountDescription;
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