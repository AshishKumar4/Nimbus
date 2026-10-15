import type { VfsCred } from '../runtime/os-contracts.js';
export interface UnixAccountReader {
    readFileString(path: string): string | Promise<string>;
}
export interface UnixUser {
    name: string;
    password: string;
    uid: number;
    gid: number;
    gecos: string;
    home: string;
    shell: string;
}
export interface UnixGroup {
    name: string;
    password: string;
    gid: number;
    members: readonly string[];
}
export declare function parseUnixId(value: string): number | null;
/** The accounts /etc/passwd's `text` holds, in its order: the one parser of it, the shell's and the runtimes' (nimbus_proc.account). */
export declare function unixUsers(text: string): UnixUser[];
/** The groups /etc/group's `text` holds, in its order. */
export declare function unixGroups(text: string): UnixGroup[];
export declare function findUnixUser(vfs: UnixAccountReader, identity: string | number): Promise<UnixUser | null>;
export declare function findUnixGroupName(vfs: UnixAccountReader, gid: number): Promise<string | null>;
export declare function findUnixGroup(vfs: UnixAccountReader, identity: string | number): Promise<UnixGroup | null>;
export declare function findUnixUserName(vfs: UnixAccountReader, uid: number): Promise<string | null>;
export declare function parseChownOwnership(vfs: UnixAccountReader, specification: string): Promise<{
    uid: number | null;
    gid: number | null;
}>;
export declare function credForUnixUser(vfs: UnixAccountReader, user: UnixUser, umask: number): Promise<VfsCred>;
//# sourceMappingURL=unix-accounts.d.ts.map