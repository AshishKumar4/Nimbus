/**
 * tsconfck.ts — the tsconfig a TypeScript module compiles under, found and
 * read as tsconfck 3.1 (https://github.com/dominikg/tsconfck, MIT, Copyright
 * (c) 2021-present dominikg and tsconfck contributors) finds and reads it for
 * Vite 5, 6 and 7's esbuild plugin (`loadTsconfigJsonForFile`), over any
 * synchronous file system rather than node:fs: the closest `tsconfig.json`
 * up from the module (none for a module under node_modules), its text as
 * JSON with comments, trailing commas and a BOM allowed (tsconfck carries
 * strip-json-comments and strip-bom, MIT, Copyright (c) Sindre Sorhus), its
 * `extends` (a path, a package resolved as Node's require.resolve would, or
 * an array: TypeScript 5's later-wins order) merged in, `${configDir}`
 * replaced, and, where it has `references` and does not itself include the
 * module, the referenced config that does (a solution-style tsconfig, as
 * create-vite's templates write). Every path is absolute and POSIX.
 *
 * What the Vite dev server reads of the result is the compiler options
 * Vite's esbuild plugin reads (vite-esbuild-options.ts); `files` names every
 * config read, so an edit of any of them is known to matter.
 */
import { normalizeVfsPath } from '../vfs/path.js';
import { DEFAULT_CJS_CONDITIONS, parseResolvablePackageJson, resolveExports } from '../_shared/exports-resolver.js';
/** A config that could not be read or resolved, as tsconfck's TSConfckParseError. */
export class TsconfckParseError extends Error {
    code;
    tsconfigFile;
    constructor(message, code, tsconfigFile) {
        super(message);
        this.code = code;
        this.tsconfigFile = tsconfigFile;
        this.name = 'TSConfckParseError';
    }
}
const GLOB_ALL_PATTERN = '**/*';
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const TSJS_EXTENSIONS = TS_EXTENSIONS.concat(JS_EXTENSIONS);
const TS_EXTENSIONS_RE_GROUP = `\\.(?:${TS_EXTENSIONS.map((ext) => ext.substring(1)).join('|')})`;
const TSJS_EXTENSIONS_RE_GROUP = `\\.(?:${TSJS_EXTENSIONS.map((ext) => ext.substring(1)).join('|')})`;
// ── POSIX paths ──────────────────────────────────────────────────────────
const normalize = (path) => '/' + normalizeVfsPath(path);
const dirname = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
const resolve = (dir, path) => normalize(path.startsWith('/') ? path : `${dir}/${path}`);
const extname = (path) => {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot) : '';
};
/** Node's path.posix.relative of two absolute paths. */
function relative(from, to) {
    const a = from.split('/').filter(Boolean);
    const b = to.split('/').filter(Boolean);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common])
        common++;
    return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}
/** Node's path.posix.join then normalize, keeping a relative result relative. */
function joinRelative(prefix, value) {
    const out = [];
    let up = 0;
    for (const segment of `${prefix}/${value}`.split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..') {
            if (out.length > 0)
                out.pop();
            else
                up++;
        }
        else {
            out.push(segment);
        }
    }
    const joined = [...Array(up).fill('..'), ...out].join('/');
    return joined === '' ? '.' : joined;
}
const isInNodeModules = (dir) => dir.includes('/node_modules/');
// ── Finding and reading ──────────────────────────────────────────────────
/** The closest tsconfig.json up from `filename`, or null (always, under node_modules). */
export function findTsconfig(filename, fs) {
    let dir = dirname(normalize(filename));
    if (isInNodeModules(dir))
        return null;
    for (;;) {
        const tsconfig = dir === '/' ? '/tsconfig.json' : `${dir}/tsconfig.json`;
        if (fs.isFile(tsconfig))
            return tsconfig;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * The tsconfig `filename` compiles under, as tsconfck's `parse(filename)`
 * gives it: `filename` itself where it is a .json file, else the closest
 * tsconfig.json; extended, tokens replaced, and resolved to the referenced
 * config that includes the file. Throws TsconfckParseError where a config
 * cannot be read or what it extends cannot be resolved.
 */
export function parseTsconfig(filename, fs) {
    const file = normalize(filename);
    const files = [];
    const tsconfigFile = (extname(file) === '.json' && fs.isFile(file) ? file : null) ?? findTsconfig(file, fs);
    if (!tsconfigFile)
        return { tsconfigFile: null, tsconfig: {}, files };
    const result = parseFile(tsconfigFile, fs, files);
    parseExtends(result, fs, files);
    parseReferences(result, fs, files);
    replaceTokens(result);
    const solved = resolveSolutionTSConfig(file, result);
    return { tsconfigFile: solved.tsconfigFile, tsconfig: solved.tsconfig, files };
}
function parseFile(tsconfigFile, fs, files) {
    if (!files.includes(tsconfigFile))
        files.push(tsconfigFile);
    let tsconfig;
    try {
        const parsed = JSON.parse(toJson(fs.readFileString(tsconfigFile)));
        tsconfig = (parsed !== null && typeof parsed === 'object' ? parsed : {});
    }
    catch (e) {
        throw new TsconfckParseError(`parsing ${tsconfigFile} failed: ${e}`, 'PARSE_FILE', tsconfigFile);
    }
    if (basename(tsconfigFile) === 'jsconfig.json') {
        tsconfig.compilerOptions = {
            allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true,
            ...tsconfig.compilerOptions,
        };
    }
    // baseUrl absolute, as ts.parseJsonConfigFileContent gives it.
    const baseUrl = tsconfig.compilerOptions?.baseUrl;
    if (typeof baseUrl === 'string' && baseUrl && !baseUrl.startsWith('${') && !baseUrl.startsWith('/')) {
        tsconfig.compilerOptions.baseUrl = resolve(dirname(tsconfigFile), baseUrl);
    }
    return { tsconfigFile, tsconfig };
}
function parseReferences(result, fs, files) {
    if (!result.tsconfig.references)
        return;
    const dir = dirname(result.tsconfigFile);
    const referenced = result.tsconfig.references.map((ref) => {
        const refPath = ref.path.endsWith('.json') ? ref.path : `${ref.path}/tsconfig.json`;
        return parseFile(resolve(dir, refPath), fs, files);
    });
    for (const ref of referenced)
        parseExtends(ref, fs, files);
    for (const ref of referenced)
        replaceTokens(ref);
    result.referenced = referenced;
}
function parseExtends(result, fs, files) {
    if (!result.tsconfig.extends)
        return;
    // The config itself first, a copy, so merging into it leaves extended[0] as read.
    const extended = [{ tsconfigFile: result.tsconfigFile, tsconfig: JSON.parse(JSON.stringify(result.tsconfig)) }];
    let pos = 0;
    const extendsPath = [];
    let currentBranchDepth = 0;
    while (pos < extended.length) {
        const extending = extended[pos];
        extendsPath.push(extending.tsconfigFile);
        if (extending.tsconfig.extends) {
            currentBranchDepth += 1;
            // TypeScript 5 reads ['a', 'b', 'c'] as c extends b extends a.
            const resolvedExtends = Array.isArray(extending.tsconfig.extends)
                ? extending.tsconfig.extends.reverse().map((ex) => resolveExtends(ex, extending.tsconfigFile, fs))
                : [resolveExtends(extending.tsconfig.extends, extending.tsconfigFile, fs)];
            const circular = resolvedExtends.find((file) => extendsPath.includes(file));
            if (circular) {
                throw new TsconfckParseError(`Circular dependency in "extends": ${extendsPath.concat([circular]).join(' -> ')}`, 'EXTENDS_CIRCULAR', result.tsconfigFile);
            }
            extended.splice(pos + 1, 0, ...resolvedExtends.map((file) => parseFile(file, fs, files)));
        }
        else {
            extendsPath.splice(-currentBranchDepth);
            currentBranchDepth = 0;
        }
        pos = pos + 1;
    }
    for (const ext of extended.slice(1))
        extendTSConfig(result, ext);
}
/** What `extends` names, from `from`: Node's require.resolve, then `<name>/tsconfig.json` for a package. */
function resolveExtends(extended, from, fs) {
    const request = extended === '..' ? '../tsconfig.json' : extended;
    const resolved = requireResolve(request, from, fs)
        ?? (request[0] !== '.' && !request.startsWith('/') ? requireResolve(`${request}/tsconfig.json`, from, fs) : null);
    if (resolved)
        return resolved;
    throw new TsconfckParseError(`failed to resolve "extends":"${request}" in ${from}`, 'EXTENDS_RESOLVE', from);
}
/** Node's require.resolve(request) from the module `from`, or null. */
function requireResolve(request, from, fs) {
    const asFile = (path) => ['', '.js', '.json', '.node'].map((ext) => path + ext).find((candidate) => fs.isFile(candidate)) ?? null;
    const asIndex = (dir) => asFile(`${dir}/index`);
    const asDirectory = (dir) => {
        const pkgPath = `${dir}/package.json`;
        if (fs.isFile(pkgPath)) {
            let text = '';
            try {
                text = fs.readFileString(pkgPath);
            }
            catch { /* unreadable: no main */ }
            const main = parseResolvablePackageJson(text)?.main;
            if (main) {
                const at = resolve(dir, main);
                const found = asFile(at) ?? asIndex(at);
                if (found)
                    return found;
            }
        }
        return asIndex(dir);
    };
    if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/') || request === '.' || request === '..') {
        const at = resolve(dirname(from), request);
        return asFile(at) ?? asDirectory(at);
    }
    const parts = request.split('/');
    const nameLength = request.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, nameLength).join('/');
    const subpath = parts.slice(nameLength).join('/');
    for (let dir = dirname(from);; dir = dirname(dir)) {
        if (basename(dir) !== 'node_modules') {
            const pkgDir = `${dir === '/' ? '' : dir}/node_modules/${name}`;
            const pkgPath = `${pkgDir}/package.json`;
            const pkg = fs.isFile(pkgPath) ? (() => {
                try {
                    return parseResolvablePackageJson(fs.readFileString(pkgPath));
                }
                catch {
                    return null;
                }
            })() : null;
            if (pkg?.exports !== undefined && pkg?.exports !== null) {
                const target = resolveExports(pkg.exports, subpath ? `./${subpath}` : '.', DEFAULT_CJS_CONDITIONS);
                // An exports map answers for its package: what it does not expose is not found.
                if (!target)
                    return null;
                const at = resolve(pkgDir, target);
                return fs.isFile(at) ? at : null;
            }
            const at = subpath ? `${pkgDir}/${subpath}` : pkgDir;
            const found = asFile(at) ?? asDirectory(at);
            if (found)
                return found;
        }
        if (dir === '/')
            return null;
    }
}
/** What `extends` carries over: references, extends and custom keys do not. */
const EXTENDABLE_KEYS = ['compilerOptions', 'files', 'include', 'exclude', 'watchOptions', 'compileOnSave', 'typeAcquisition', 'buildOptions'];
function extendTSConfig(extending, extended) {
    const extendingConfig = extending.tsconfig;
    const extendedConfig = extended.tsconfig;
    const relativePath = relative(dirname(extending.tsconfigFile), dirname(extended.tsconfigFile));
    for (const key of Object.keys(extendedConfig).filter((k) => EXTENDABLE_KEYS.includes(k))) {
        if (key === 'compilerOptions') {
            extendingConfig.compilerOptions ??= {};
            for (const option of Object.keys(extendedConfig.compilerOptions)) {
                if (Object.prototype.hasOwnProperty.call(extendingConfig.compilerOptions, option))
                    continue;
                extendingConfig.compilerOptions[option] = rebaseRelative(option, extendedConfig.compilerOptions[option], relativePath);
            }
        }
        else if (extendingConfig[key] === undefined) {
            if (key === 'watchOptions') {
                extendingConfig.watchOptions = {};
                for (const option of Object.keys(extendedConfig.watchOptions)) {
                    extendingConfig.watchOptions[option] = rebaseRelative(option, extendedConfig.watchOptions[option], relativePath);
                }
            }
            else {
                extendingConfig[key] = rebaseRelative(key, extendedConfig[key], relativePath);
            }
        }
    }
}
/** The path-valued keys an extended config's relative paths are rebased in. */
const REBASE_KEYS = ['files', 'include', 'exclude', 'baseUrl', 'rootDir', 'rootDirs', 'typeRoots', 'outDir', 'outFile', 'declarationDir', 'excludeDirectories', 'excludeFiles'];
function rebaseRelative(key, value, prependPath) {
    if (!REBASE_KEYS.includes(key))
        return value;
    return Array.isArray(value) ? value.map((x) => rebasePath(x, prependPath)) : rebasePath(value, prependPath);
}
function rebasePath(value, prependPath) {
    if (typeof value !== 'string' || value.startsWith('/') || value.startsWith('${configDir}'))
        return value;
    return joinRelative(prependPath, value);
}
/** `${configDir}` at the start of a string value: the config's own directory. */
function replaceTokens(result) {
    result.tsconfig = JSON.parse(JSON.stringify(result.tsconfig).replaceAll(/"\${configDir}/g, `"${dirname(result.tsconfigFile)}`));
}
// ── Solutions ────────────────────────────────────────────────────────────
function resolveSolutionTSConfig(filename, result) {
    const allowJs = result.tsconfig.compilerOptions?.allowJs;
    const extensions = allowJs ? TSJS_EXTENSIONS : TS_EXTENSIONS;
    if (result.referenced && extensions.some((ext) => filename.endsWith(ext)) && !isIncluded(filename, result)) {
        const solution = result.referenced.find((referenced) => isIncluded(filename, referenced));
        if (solution)
            return solution;
    }
    return result;
}
function isIncluded(filename, result) {
    const dir = dirname(result.tsconfigFile);
    const files = (result.tsconfig.files || []).map((file) => resolve(dir, file));
    if (files.includes(filename))
        return true;
    const allowJs = Boolean(result.tsconfig.compilerOptions?.allowJs);
    const included = isGlobMatch(filename, dir, result.tsconfig.include || (result.tsconfig.files ? [] : [GLOB_ALL_PATTERN]), allowJs);
    return included && !isGlobMatch(filename, dir, result.tsconfig.exclude || [], allowJs);
}
const PATTERN_REGEX_CACHE = new Map();
/** Whether `filename` matches one of a tsconfig's glob `patterns`, relative to `dir`, as tsconfck matches them. */
function isGlobMatch(filename, dir, patterns, allowJs) {
    const extensions = allowJs ? TSJS_EXTENSIONS : TS_EXTENSIONS;
    return patterns.some((original) => {
        let pattern = original;
        let lastWildcardIndex = pattern.length;
        let hasWildcard = false;
        let hasExtension = false;
        let hasSlash = false;
        let lastSlashIndex = -1;
        for (let i = pattern.length - 1; i > -1; i--) {
            const c = pattern[i];
            if (!hasWildcard && (c === '*' || c === '?')) {
                lastWildcardIndex = i;
                hasWildcard = true;
            }
            if (!hasSlash) {
                if (c === '.')
                    hasExtension = true;
                else if (c === '/') {
                    lastSlashIndex = i;
                    hasSlash = true;
                }
            }
            if (hasWildcard && hasSlash)
                break;
        }
        if (!hasExtension && (!hasWildcard || lastWildcardIndex < lastSlashIndex)) {
            // A directory: everything under it.
            pattern += `${pattern.endsWith('/') ? '' : '/'}${GLOB_ALL_PATTERN}`;
            lastWildcardIndex = pattern.length - 1;
            hasWildcard = true;
        }
        if (lastWildcardIndex < pattern.length - 1 && !filename.endsWith(pattern.slice(lastWildcardIndex + 1)))
            return false;
        if (pattern.endsWith('*') && !extensions.some((ext) => filename.endsWith(ext)))
            return false;
        if (pattern === GLOB_ALL_PATTERN)
            return filename.startsWith(`${dir}/`);
        const resolvedPattern = resolve(dir, pattern);
        let firstWildcardIndex = -1;
        for (let i = 0; i < resolvedPattern.length; i++) {
            if (resolvedPattern[i] === '*' || resolvedPattern[i] === '?') {
                firstWildcardIndex = i;
                hasWildcard = true;
                break;
            }
        }
        if (firstWildcardIndex > 1 && !filename.startsWith(resolvedPattern.slice(0, firstWildcardIndex - 1)))
            return false;
        if (!hasWildcard)
            return filename === resolvedPattern;
        if (firstWildcardIndex + GLOB_ALL_PATTERN.length === resolvedPattern.length - (pattern.length - 1 - lastWildcardIndex)
            && resolvedPattern.slice(firstWildcardIndex, firstWildcardIndex + GLOB_ALL_PATTERN.length) === GLOB_ALL_PATTERN) {
            return true;
        }
        const cacheKey = `${allowJs}:${resolvedPattern}`;
        let regex = PATTERN_REGEX_CACHE.get(cacheKey);
        if (!regex) {
            regex = pattern2regex(resolvedPattern, allowJs);
            PATTERN_REGEX_CACHE.set(cacheKey, regex);
        }
        return regex.test(filename);
    });
}
function pattern2regex(resolvedPattern, allowJs) {
    let regexStr = '^';
    for (let i = 0; i < resolvedPattern.length; i++) {
        const char = resolvedPattern[i];
        if (char === '?') {
            regexStr += '[^\\/]';
            continue;
        }
        if (char === '*') {
            if (resolvedPattern[i + 1] === '*' && resolvedPattern[i + 2] === '/') {
                i += 2;
                regexStr += '(?:[^\\/]*\\/)*';
                continue;
            }
            regexStr += '[^\\/]*';
            continue;
        }
        if ('/.+^${}()|[]\\'.includes(char))
            regexStr += '\\';
        regexStr += char;
    }
    if (resolvedPattern.endsWith('*'))
        regexStr += allowJs ? TSJS_EXTENSIONS_RE_GROUP : TS_EXTENSIONS_RE_GROUP;
    return new RegExp(regexStr + '$');
}
// ── JSON with comments ───────────────────────────────────────────────────
/** A tsconfig's text as JSON: BOM, comments and dangling commas stripped; `{}` where nothing is left. */
export function toJson(tsconfigJson) {
    const stripped = stripDanglingComma(stripJsonComments(tsconfigJson.charCodeAt(0) === 0xfeff ? tsconfigJson.slice(1) : tsconfigJson));
    return stripped.trim() === '' ? '{}' : stripped;
}
function stripDanglingComma(pseudoJson) {
    let insideString = false;
    let offset = 0;
    let result = '';
    let danglingCommaPos = null;
    for (let i = 0; i < pseudoJson.length; i++) {
        const currentCharacter = pseudoJson[i];
        if (currentCharacter === '"' && !isEscaped(pseudoJson, i))
            insideString = !insideString;
        if (insideString) {
            danglingCommaPos = null;
            continue;
        }
        if (currentCharacter === ',') {
            danglingCommaPos = i;
            continue;
        }
        if (danglingCommaPos) {
            if (currentCharacter === '}' || currentCharacter === ']') {
                result += pseudoJson.slice(offset, danglingCommaPos) + ' ';
                offset = danglingCommaPos + 1;
                danglingCommaPos = null;
            }
            else if (!/\s/.test(currentCharacter)) {
                danglingCommaPos = null;
            }
        }
    }
    return result + pseudoJson.substring(offset);
}
function isEscaped(jsonString, quotePosition) {
    let index = quotePosition - 1;
    let backslashCount = 0;
    while (jsonString[index] === '\\') {
        index -= 1;
        backslashCount += 1;
    }
    return Boolean(backslashCount % 2);
}
const strip = (string, start, end) => string.slice(start, end).replace(/\S/g, ' ');
function stripJsonComments(jsonString) {
    let isInsideString = false;
    let isInsideComment = false;
    let offset = 0;
    let result = '';
    for (let index = 0; index < jsonString.length; index++) {
        const currentCharacter = jsonString[index];
        const nextCharacter = jsonString[index + 1];
        if (!isInsideComment && currentCharacter === '"' && !isEscaped(jsonString, index))
            isInsideString = !isInsideString;
        if (isInsideString)
            continue;
        if (!isInsideComment && currentCharacter + nextCharacter === '//') {
            result += jsonString.slice(offset, index);
            offset = index;
            isInsideComment = 'single';
            index++;
        }
        else if (isInsideComment === 'single' && currentCharacter + nextCharacter === '\r\n') {
            index++;
            isInsideComment = false;
            result += strip(jsonString, offset, index);
            offset = index;
        }
        else if (isInsideComment === 'single' && currentCharacter === '\n') {
            isInsideComment = false;
            result += strip(jsonString, offset, index);
            offset = index;
        }
        else if (!isInsideComment && currentCharacter + nextCharacter === '/*') {
            result += jsonString.slice(offset, index);
            offset = index;
            isInsideComment = 'multi';
            index++;
        }
        else if (isInsideComment === 'multi' && currentCharacter + nextCharacter === '*/') {
            index++;
            isInsideComment = false;
            result += strip(jsonString, offset, index + 1);
            offset = index + 1;
        }
    }
    return result + (isInsideComment ? strip(jsonString.slice(offset)) : jsonString.slice(offset));
}
