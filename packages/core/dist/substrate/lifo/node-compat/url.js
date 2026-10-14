import realm from 'node:process';
// The engine's own url (X-3). What does not depend on a working directory is
// the engine's as it is; the module a program requires is createUrl's.
export * from 'node:url';
export { default } from 'node:url';
/**
 * The engine's url against the program's working directory: pathToFileURL of
 * a relative path starts from `cwd`, as Node's starts from process.cwd(), the
 * engine's own process's, which is not the program's.
 */
export function createUrl(cwd) {
    const engine = realm.getBuiltinModule('node:url');
    const { posix } = realm.getBuiltinModule('node:path');
    return {
        ...engine,
        pathToFileURL: (path, options) => engine.pathToFileURL(posix.isAbsolute(path) ? path : posix.join(cwd, path), options),
    };
}
