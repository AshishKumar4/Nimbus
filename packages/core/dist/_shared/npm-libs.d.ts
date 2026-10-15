export declare const npa: typeof import('npm-package-arg').default;
export declare const hostedGitInfo: typeof import('hosted-git-info').default;
export declare const npmDefinitions: typeof import('@npmcli/config/lib/definitions/index.js').default;
export declare const envReplace: typeof import('@npmcli/config/lib/env-replace.js').default;
export declare const parseField: typeof import('@npmcli/config/lib/parse-field.js').default;
export declare const typeDefs: typeof import('@npmcli/config/lib/type-defs.js').default;
export declare const typeDescription: typeof import('@npmcli/config/lib/type-description.js').default;
export declare const ini: typeof import('ini').default;
export declare const nopt: typeof import('nopt').default;
export declare const validateName: typeof import('validate-npm-package-name').default;
/** npm-install-checks' checkEngine: throws npm's EBADENGINE where `target.engines` excludes `nodeVer` (unless `force`) or `npmVer`. */
export declare const checkEngine: (target: {
    readonly engines?: unknown;
    readonly _id?: string;
}, npmVer: string, nodeVer: string, force?: boolean) => void;
/** npm-install-checks' checkDevEngines: each of `wanted`'s engines `current` fails, as npm's devEngines preflight reads them; throws for a devEngines it cannot read. */
export declare const checkDevEngines: (wanted: unknown, current: Readonly<Record<string, unknown>>) => DevEnginesFailure[];
/** One engine checkDevEngines fails: its message, why each wanted entry failed, and npm's verdict from its onFail. */
export interface DevEnginesFailure {
    readonly message: string;
    readonly errors: readonly Error[];
    readonly engine: string;
    readonly isWarn: boolean;
    readonly isError: boolean;
    readonly current: unknown;
    readonly required: unknown;
}
//# sourceMappingURL=npm-libs.d.ts.map