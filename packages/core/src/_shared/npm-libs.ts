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
