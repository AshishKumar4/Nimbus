// The repo's compiler, tsrs, over a few files for a unit test: a program of
// root files under compiler options, through tsrs's API (tsrs/unstable/sync,
// which runs the pinned tsrs binary), where text a test gives stands in for
// files on disk.
import { API, serverFS } from 'tsrs/unstable/sync';

/**
 * Run `use` with an API whose filesystem is the disk, but for `overlay`
 * (absolute path → text): those files read as given, whether or not they
 * exist. The API's process ends when `use` returns.
 *
 * @template T
 * @param {{ cwd?: string, overlay?: Record<string, string> }} options
 * @param {(api: API) => T} use
 * @returns {T}
 */
export function withTsrs({ cwd = process.cwd(), overlay = {} }, use) {
  const virtual = new Map(Object.entries(overlay));
  const fs = virtual.size === 0 ? undefined : {
    readFile: (/** @type {string} */ name) => virtual.get(name) ?? serverFS.useOS,
    fileExists: (/** @type {string} */ name) => (virtual.has(name) ? true : serverFS.useOS),
    realpath: (/** @type {string} */ name) => (virtual.has(name) ? serverFS.identity : serverFS.useOS),
    stat: (/** @type {string} */ name) => (virtual.has(name) ? serverFS.fakeStat : serverFS.useOS),
    directoryExists: serverFS.useOS,
    getAccessibleEntries: serverFS.useOS,
    writeFile: serverFS.noop,
    removeFile: serverFS.noop,
  };
  const api = new API({ cwd, fs });
  try {
    return use(api);
  } finally {
    api.close();
  }
}

/**
 * A diagnostic's message with its chain, as tsc prints it: each link on its
 * own line, indented two spaces deeper than the one it explains.
 *
 * @param {import('tsrs/unstable/sync').Diagnostic} diagnostic
 * @returns {string}
 */
export function diagnosticMessage(diagnostic, depth = 0) {
  const chain = diagnostic.messageChain ?? [];
  return `${'  '.repeat(depth)}${diagnostic.text}${chain.map((link) => `\n${diagnosticMessage(link, depth + 1)}`).join('')}`;
}

/**
 * The errors tsrs reports for `files` (by default `roots`) in the program of
 * `roots` under `options`: the options' and global ones, then each file's
 * syntactic and semantic ones, as { file, line (0-based), code, message }.
 * `overlay` stands in for files on disk (withTsrs).
 *
 * @param {{ roots: string[], options: object, files?: string[], overlay?: Record<string, string>, cwd?: string }} options
 */
export function programErrors({ roots, options, files = roots, overlay = {}, cwd }) {
  return withTsrs({ cwd, overlay }, (api) => {
    const program = api.createProgram(roots, options);
    return [
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(files),
      ...program.getSemanticDiagnostics(files),
    ].map((diagnostic) => ({
      file: diagnostic.fileName,
      line: diagnostic.startPosition?.line,
      code: diagnostic.code,
      message: diagnosticMessage(diagnostic),
    }));
  });
}

/**
 * A tsconfig's compiler options as tsrs reads them; an error in the config
 * throws.
 *
 * @param {string} configPath
 */
export function configOptions(configPath) {
  return withTsrs({}, (api) => {
    const config = api.parseConfigFile(configPath);
    if (config.errors.length > 0) throw new Error(`${configPath}: ${config.errors.map((error) => diagnosticMessage(error)).join('\n')}`);
    return config.options;
  });
}
