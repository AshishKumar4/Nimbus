import type { RuntimeFsBridge, VfsCred } from './os-contracts.js';
export declare function makeGitFsmonitor(): {
    query(args: {
        fs: Pick<RuntimeFsBridge, 'acquire' | 'revision'>;
        cwd: string;
        cred: VfsCred;
        token: string;
    }): Promise<Uint8Array>;
};
//# sourceMappingURL=git-fsmonitor.d.ts.map