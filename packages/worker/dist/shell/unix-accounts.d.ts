import type { VfsCred } from '../runtime/os-contracts.js';
export interface UnixAccountReader {
    readFileString(path: string): string;
}
export interface UnixUser {
    name: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
}
export interface UnixGroup {
    name: string;
    gid: number;
    members: readonly string[];
}
export declare function parseUnixId(value: string): number | null;
export declare function findUnixUser(vfs: UnixAccountReader, identity: string | number): UnixUser | null;
export declare function findUnixGroupName(vfs: UnixAccountReader, gid: number): string | null;
export declare function findUnixGroup(vfs: UnixAccountReader, identity: string | number): UnixGroup | null;
export declare function findUnixUserName(vfs: UnixAccountReader, uid: number): string | null;
export declare function parseChownOwnership(vfs: UnixAccountReader, specification: string): {
    uid: number | null;
    gid: number | null;
};
export declare function credForUnixUser(vfs: UnixAccountReader, user: UnixUser, umask: number): VfsCred;
//# sourceMappingURL=unix-accounts.d.ts.map