/**
 * posix-path.ts — node:path's posix half, as Node v22.22.3's lib/path.js
 * computes it, on built-ins captured before any program code runs
 * (primordials.ts): the guest's node:path, which its module loading calls
 * too, answers as Node's does after a program replaced
 * String.prototype.charCodeAt or Array.prototype.join, as Node's own path,
 * written against its primordials, does. Ported line for line; what Node's
 * reads from the process (its working directory) the caller gives.
 * `matchesGlob` (minimatch's) and `win32` are the platform's, which the
 * caller sets where Node's are, in Node's order of keys.
 */
import { invalidArgType } from './node-error.js';
import { arrayIsArray, arrayJoin, FunctionPrototypeBind, reflectApply, stringCharCodeAt, stringLastIndexOf, stringSlice } from './primordials.js';
const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
/** Node's validateString: a program may pass anything its types do not say. */
function validateString(value, name) {
    if (typeof value !== 'string')
        throw invalidArgType(name, 'string', value);
}
function isPosixPathSeparator(code) {
    return code === CHAR_FORWARD_SLASH;
}
/** Resolves . and .. elements in a path with directory names. */
function normalizeString(path, allowAboveRoot, separator, isPathSeparator) {
    let res = '';
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0; i <= path.length; ++i) {
        if (i < path.length)
            code = stringCharCodeAt(path, i);
        else if (isPathSeparator(code))
            break;
        else
            code = CHAR_FORWARD_SLASH;
        if (isPathSeparator(code)) {
            if (lastSlash === i - 1 || dots === 1) {
                // NOOP
            }
            else if (dots === 2) {
                if (res.length < 2 || lastSegmentLength !== 2
                    || stringCharCodeAt(res, res.length - 1) !== CHAR_DOT
                    || stringCharCodeAt(res, res.length - 2) !== CHAR_DOT) {
                    if (res.length > 2) {
                        const lastSlashIndex = res.length - lastSegmentLength - 1;
                        if (lastSlashIndex === -1) {
                            res = '';
                            lastSegmentLength = 0;
                        }
                        else {
                            res = stringSlice(res, 0, lastSlashIndex);
                            lastSegmentLength = res.length - 1 - stringLastIndexOf(res, separator);
                        }
                        lastSlash = i;
                        dots = 0;
                        continue;
                    }
                    else if (res.length !== 0) {
                        res = '';
                        lastSegmentLength = 0;
                        lastSlash = i;
                        dots = 0;
                        continue;
                    }
                }
                if (allowAboveRoot) {
                    res += res.length > 0 ? `${separator}..` : '..';
                    lastSegmentLength = 2;
                }
            }
            else {
                if (res.length > 0)
                    res += `${separator}${stringSlice(path, lastSlash + 1, i)}`;
                else
                    res = stringSlice(path, lastSlash + 1, i);
                lastSegmentLength = i - lastSlash - 1;
            }
            lastSlash = i;
            dots = 0;
        }
        else if (code === CHAR_DOT && dots !== -1) {
            ++dots;
        }
        else {
            dots = -1;
        }
    }
    return res;
}
function formatExt(ext) {
    return ext ? `${ext[0] === '.' ? '' : '.'}${ext}` : '';
}
function _format(sep, pathObject) {
    // Node's validateObject: an object, not null, not an array.
    if (pathObject === null || typeof pathObject !== 'object' || arrayIsArray(pathObject))
        throw invalidArgType('pathObject', 'Object', pathObject);
    const dir = pathObject.dir || pathObject.root;
    const base = pathObject.base || `${pathObject.name || ''}${formatExt(pathObject.ext)}`;
    if (!dir)
        return base;
    return dir === pathObject.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}
/** Node's path.posix, resolving from `cwd()`. */
export function createPosixPath(cwd) {
    const posix = {
        resolve(...args) {
            if (args.length === 0 || (args.length === 1 && (args[0] === '' || args[0] === '.'))) {
                const dir = cwd();
                if (stringCharCodeAt(dir, 0) === CHAR_FORWARD_SLASH)
                    return dir;
            }
            let resolvedPath = '';
            let resolvedAbsolute = false;
            for (let i = args.length - 1; i >= 0 && !resolvedAbsolute; i--) {
                const path = args[i];
                validateString(path, `paths[${i}]`);
                // Skip empty entries
                if (path.length === 0)
                    continue;
                resolvedPath = `${path}/${resolvedPath}`;
                resolvedAbsolute = stringCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            }
            if (!resolvedAbsolute) {
                const dir = cwd();
                resolvedPath = `${dir}/${resolvedPath}`;
                resolvedAbsolute = stringCharCodeAt(dir, 0) === CHAR_FORWARD_SLASH;
            }
            // Normalize the path
            resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, '/', isPosixPathSeparator);
            if (resolvedAbsolute)
                return `/${resolvedPath}`;
            return resolvedPath.length > 0 ? resolvedPath : '.';
        },
        normalize(path) {
            validateString(path, 'path');
            if (path.length === 0)
                return '.';
            const isAbsolute = stringCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            const trailingSeparator = stringCharCodeAt(path, path.length - 1) === CHAR_FORWARD_SLASH;
            // Normalize the path
            path = normalizeString(path, !isAbsolute, '/', isPosixPathSeparator);
            if (path.length === 0) {
                if (isAbsolute)
                    return '/';
                return trailingSeparator ? './' : '.';
            }
            if (trailingSeparator)
                path += '/';
            return isAbsolute ? `/${path}` : path;
        },
        isAbsolute(path) {
            validateString(path, 'path');
            return path.length > 0 && stringCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
        },
        join(...args) {
            if (args.length === 0)
                return '.';
            const path = [];
            for (let i = 0; i < args.length; ++i) {
                const arg = args[i];
                validateString(arg, 'path');
                if (arg.length > 0) {
                    path.push(arg); // as Node's, live: lib/path.js calls the array's own push
                }
            }
            if (path.length === 0)
                return '.';
            return posix.normalize(arrayJoin(path, '/'));
        },
        relative(from, to) {
            validateString(from, 'from');
            validateString(to, 'to');
            if (from === to)
                return '';
            // Trim leading forward slashes.
            from = posix.resolve(from);
            to = posix.resolve(to);
            if (from === to)
                return '';
            const fromStart = 1;
            const fromEnd = from.length;
            const fromLen = fromEnd - fromStart;
            const toStart = 1;
            const toLen = to.length - toStart;
            // Compare paths to find the longest common path from root
            const length = (fromLen < toLen ? fromLen : toLen);
            let lastCommonSep = -1;
            let i = 0;
            for (; i < length; i++) {
                const fromCode = stringCharCodeAt(from, fromStart + i);
                if (fromCode !== stringCharCodeAt(to, toStart + i))
                    break;
                else if (fromCode === CHAR_FORWARD_SLASH)
                    lastCommonSep = i;
            }
            if (i === length) {
                if (toLen > length) {
                    if (stringCharCodeAt(to, toStart + i) === CHAR_FORWARD_SLASH) {
                        // We get here if `from` is the exact base path for `to`.
                        // For example: from='/foo/bar'; to='/foo/bar/baz'
                        return stringSlice(to, toStart + i + 1);
                    }
                    if (i === 0) {
                        // We get here if `from` is the root
                        // For example: from='/'; to='/foo'
                        return stringSlice(to, toStart + i);
                    }
                }
                else if (fromLen > length) {
                    if (stringCharCodeAt(from, fromStart + i) === CHAR_FORWARD_SLASH) {
                        // We get here if `to` is the exact base path for `from`.
                        // For example: from='/foo/bar/baz'; to='/foo/bar'
                        lastCommonSep = i;
                    }
                    else if (i === 0) {
                        // We get here if `to` is the root.
                        // For example: from='/foo/bar'; to='/'
                        lastCommonSep = 0;
                    }
                }
            }
            let out = '';
            // Generate the relative path based on the path difference between `to`
            // and `from`.
            for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
                if (i === fromEnd || stringCharCodeAt(from, i) === CHAR_FORWARD_SLASH) {
                    out += out.length === 0 ? '..' : '/..';
                }
            }
            // Lastly, append the rest of the destination (`to`) path that comes after
            // the common path parts.
            return `${out}${stringSlice(to, toStart + lastCommonSep)}`;
        },
        toNamespacedPath(path) {
            // Non-op on posix systems
            return path;
        },
        dirname(path) {
            validateString(path, 'path');
            if (path.length === 0)
                return '.';
            const hasRoot = stringCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            let end = -1;
            let matchedSlash = true;
            for (let i = path.length - 1; i >= 1; --i) {
                if (stringCharCodeAt(path, i) === CHAR_FORWARD_SLASH) {
                    if (!matchedSlash) {
                        end = i;
                        break;
                    }
                }
                else {
                    // We saw the first non-path separator
                    matchedSlash = false;
                }
            }
            if (end === -1)
                return hasRoot ? '/' : '.';
            if (hasRoot && end === 1)
                return '//';
            return stringSlice(path, 0, end);
        },
        basename(path, suffix) {
            if (suffix !== undefined)
                validateString(suffix, 'suffix');
            validateString(path, 'path');
            let start = 0;
            let end = -1;
            let matchedSlash = true;
            if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
                if (suffix === path)
                    return '';
                let extIdx = suffix.length - 1;
                let firstNonSlashEnd = -1;
                for (let i = path.length - 1; i >= 0; --i) {
                    const code = stringCharCodeAt(path, i);
                    if (code === CHAR_FORWARD_SLASH) {
                        // If we reached a path separator that was not part of a set of path
                        // separators at the end of the string, stop now
                        if (!matchedSlash) {
                            start = i + 1;
                            break;
                        }
                    }
                    else {
                        if (firstNonSlashEnd === -1) {
                            // We saw the first non-path separator, remember this index in case
                            // we need it if the extension ends up not matching
                            matchedSlash = false;
                            firstNonSlashEnd = i + 1;
                        }
                        if (extIdx >= 0) {
                            // Try to match the explicit extension
                            if (code === stringCharCodeAt(suffix, extIdx)) {
                                if (--extIdx === -1) {
                                    // We matched the extension, so mark this as the end of our path
                                    // component
                                    end = i;
                                }
                            }
                            else {
                                // Extension does not match, so our result is the entire path
                                // component
                                extIdx = -1;
                                end = firstNonSlashEnd;
                            }
                        }
                    }
                }
                if (start === end)
                    end = firstNonSlashEnd;
                else if (end === -1)
                    end = path.length;
                return stringSlice(path, start, end);
            }
            for (let i = path.length - 1; i >= 0; --i) {
                if (stringCharCodeAt(path, i) === CHAR_FORWARD_SLASH) {
                    // If we reached a path separator that was not part of a set of path
                    // separators at the end of the string, stop now
                    if (!matchedSlash) {
                        start = i + 1;
                        break;
                    }
                }
                else if (end === -1) {
                    // We saw the first non-path separator, mark this as the end of our
                    // path component
                    matchedSlash = false;
                    end = i + 1;
                }
            }
            if (end === -1)
                return '';
            return stringSlice(path, start, end);
        },
        extname(path) {
            validateString(path, 'path');
            let startDot = -1;
            let startPart = 0;
            let end = -1;
            let matchedSlash = true;
            // Track the state of characters (if any) we see before our first dot and
            // after any path separator we find
            let preDotState = 0;
            for (let i = path.length - 1; i >= 0; --i) {
                const char = path[i];
                if (char === '/') {
                    // If we reached a path separator that was not part of a set of path
                    // separators at the end of the string, stop now
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    // We saw the first non-path separator, mark this as the end of our
                    // extension
                    matchedSlash = false;
                    end = i + 1;
                }
                if (char === '.') {
                    // If this is our first dot, mark it as the start of our extension
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                }
                else if (startDot !== -1) {
                    // We saw a non-dot and non-path separator before our dot, so we should
                    // have a good chance at having a non-empty extension
                    preDotState = -1;
                }
            }
            if (startDot === -1
                || end === -1
                // We saw a non-dot character immediately before the dot
                || preDotState === 0
                // The (right-most) trimmed path component is exactly '..'
                || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
                return '';
            }
            return stringSlice(path, startDot, end);
        },
        // Node's FunctionPrototypeBind(_format, null, '/'): "bound _format".
        format: reflectApply(FunctionPrototypeBind, _format, [null, '/']),
        parse(path) {
            validateString(path, 'path');
            const ret = { root: '', dir: '', base: '', ext: '', name: '' };
            if (path.length === 0)
                return ret;
            const isAbsolute = stringCharCodeAt(path, 0) === CHAR_FORWARD_SLASH;
            let start;
            if (isAbsolute) {
                ret.root = '/';
                start = 1;
            }
            else {
                start = 0;
            }
            let startDot = -1;
            let startPart = 0;
            let end = -1;
            let matchedSlash = true;
            let i = path.length - 1;
            // Track the state of characters (if any) we see before our first dot and
            // after any path separator we find
            let preDotState = 0;
            // Get non-dir info
            for (; i >= start; --i) {
                const code = stringCharCodeAt(path, i);
                if (code === CHAR_FORWARD_SLASH) {
                    // If we reached a path separator that was not part of a set of path
                    // separators at the end of the string, stop now
                    if (!matchedSlash) {
                        startPart = i + 1;
                        break;
                    }
                    continue;
                }
                if (end === -1) {
                    // We saw the first non-path separator, mark this as the end of our
                    // extension
                    matchedSlash = false;
                    end = i + 1;
                }
                if (code === CHAR_DOT) {
                    // If this is our first dot, mark it as the start of our extension
                    if (startDot === -1)
                        startDot = i;
                    else if (preDotState !== 1)
                        preDotState = 1;
                }
                else if (startDot !== -1) {
                    // We saw a non-dot and non-path separator before our dot, so we should
                    // have a good chance at having a non-empty extension
                    preDotState = -1;
                }
            }
            if (end !== -1) {
                const start = startPart === 0 && isAbsolute ? 1 : startPart;
                if (startDot === -1
                    // We saw a non-dot character immediately before the dot
                    || preDotState === 0
                    // The (right-most) trimmed path component is exactly '..'
                    || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
                    ret.base = ret.name = stringSlice(path, start, end);
                }
                else {
                    ret.name = stringSlice(path, start, startDot);
                    ret.base = stringSlice(path, start, end);
                    ret.ext = stringSlice(path, startDot, end);
                }
            }
            if (startPart > 0)
                ret.dir = stringSlice(path, 0, startPart - 1);
            else if (isAbsolute)
                ret.dir = '/';
            return ret;
        },
        matchesGlob: null,
        sep: '/',
        delimiter: ':',
        win32: null,
        posix: null,
        _makeLong: null,
    };
    posix.posix = posix;
    // Legacy internal API, docs-only deprecated: DEP0080.
    posix._makeLong = posix.toNamespacedPath;
    return posix;
}
