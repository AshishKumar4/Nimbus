/** npm's CommonJS libraries, compiled once to neutral ESM with real builtin imports. */
import * as compiled from './npm-libs.generated.js';

export const npa: typeof import('npm-package-arg').default = compiled.npa;
export const hostedGitInfo: typeof import('hosted-git-info').default = compiled.hostedGitInfo;
export const npmDefinitions: typeof import('@npmcli/config/lib/definitions/index.js').default = compiled.npmDefinitions;
export const envReplace: typeof import('@npmcli/config/lib/env-replace.js').default = compiled.envReplace;
export const parseField: typeof import('@npmcli/config/lib/parse-field.js').default = compiled.parseField;
export const typeDefs: typeof import('@npmcli/config/lib/type-defs.js').default = compiled.typeDefs;
export const typeDescription: typeof import('@npmcli/config/lib/type-description.js').default = compiled.typeDescription;
export const ini: typeof import('ini').default = compiled.ini;
export const nopt: typeof import('nopt').default = compiled.nopt;
export const validateName: typeof import('validate-npm-package-name').default = compiled.validateName;
/** npm-install-checks' checkEngine: throws npm's EBADENGINE where `target.engines` excludes `nodeVer` (unless `force`) or `npmVer`. */
export const checkEngine: (target: { readonly engines?: unknown; readonly _id?: string }, npmVer: string, nodeVer: string, force?: boolean) => void = compiled.npmInstallChecks.checkEngine;
/** npm-install-checks' checkDevEngines: each of `wanted`'s engines `current` fails, as npm's devEngines preflight reads them; throws for a devEngines it cannot read. */
export const checkDevEngines: (wanted: unknown, current: Readonly<Record<string, unknown>>) => DevEnginesFailure[] = compiled.npmInstallChecks.checkDevEngines;
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
