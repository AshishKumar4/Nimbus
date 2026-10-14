import realm from 'node:process';
// The engine's own path and url (X-3) against a program's working directory:
// Node's resolve from process.cwd(), the engine's own process's, which is not
// the program's.
/** The engine's path, whose resolve and relative (posix and win32) start from `cwd`. */
export function createPath(cwd) {
    const engine = realm.getBuiltinModule('node:path');
    const against = (platform) => ({
        ...platform,
        resolve: (...paths) => platform.resolve(cwd, ...paths),
        relative: (from, to) => platform.relative(platform.resolve(cwd, from), platform.resolve(cwd, to)),
    });
    const posix = against(engine.posix);
    const win32 = against(engine.win32);
    // Each platform's posix and win32 are these, as Node's are one another.
    Object.assign(posix, { posix, win32 });
    Object.assign(win32, { posix, win32 });
    return posix;
}
/**
 * The engine's url, whose pathToFileURL of a relative path starts from `cwd`,
 * in the path platform the call asks for (Windows mode: drive and UNC paths
 * are absolute, a drive-relative one is its drive's).
 */
export function createUrl(cwd) {
    const engine = realm.getBuiltinModule('node:url');
    const { posix, win32 } = realm.getBuiltinModule('node:path');
    return {
        ...engine,
        pathToFileURL: (path, options) => {
            if (typeof path !== 'string')
                return engine.pathToFileURL(path, options);
            // Resolved as Node resolves it, from the program's cwd (a drive-relative
            // Windows path by its drive); a trailing separator kept, as Node keeps it.
            const platform = options?.windows ? win32 : posix;
            const resolved = platform.resolve(cwd, path);
            const trailing = path.endsWith('/') || (platform === win32 && path.endsWith('\\'));
            return engine.pathToFileURL(trailing && !resolved.endsWith(platform.sep) ? resolved + platform.sep : resolved, options);
        },
    };
}
