/**
 * The files a module names by a path it can compute before it runs.
 *
 * A node process cannot block on a synchronous read, so what it reads
 * synchronously has to be in its facet before it starts. Rules cover the
 * common shapes (package.json, the project, configs); this covers what a
 * package's own code spells out: `readFileSync(join(__dirname, "x.json"))`,
 * `new URL("../y.js", import.meta.url)`, `fileURLToPath(...)`,
 * `require.resolve("pkg/file")`, `readdirSync(resolve(__dirname, "tpl"))`.
 *
 * Each module is parsed (acorn) and every path-shaped expression is
 * evaluated by constant folding over string literals, template literals,
 * `+`, `__dirname`, `__filename`, `import.meta.url|dirname|filename`,
 * single-assignment bindings, `path.join|resolve|dirname`, `new URL(x, base)`,
 * `.pathname`, `.href`, `fileURLToPath` and `pathToFileURL`. A value with an
 * unknown hole keeps its known prefix and suffix, so `join(__dirname,
 * \`locales/${lang}.json\`)` still names `locales/*.json`.
 *
 * What folding cannot reach: a path computed from runtime data (argv, env,
 * config contents, a readdir result fed through arbitrary code, a network
 * answer), a value passed through a function parameter, a property of an
 * object, or a binding reassigned more than once.
 */
import { parse, tokenizer, tokTypes } from 'acorn';
import { full } from 'acorn-walk';
import { calleeName } from './javascript-ast.js';
const PATH_MODULES = new Set(['path', 'node:path', 'path/posix', 'node:path/posix']);
/** Calls whose first argument is a path the call reads, stats or lists. */
const FS_SINKS = new Set([
    'readFileSync', 'readFile', 'existsSync', 'exists', 'statSync', 'stat', 'lstatSync', 'lstat',
    'readdirSync', 'readdir', 'accessSync', 'access', 'openSync', 'open', 'createReadStream',
    'realpathSync', 'realpath', 'opendirSync', 'opendir', 'readlinkSync', 'readlink',
]);
const LIST_SINKS = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir']);
/** `openSync` flags that open for reading only. */
const READ_ONLY_FLAGS = new Set(['r', 'rs']);
/** Whether a sink call with this flags argument reads the file's content synchronously. */
function syncRead(sink, flags) {
    if (sink === 'readFileSync')
        return true;
    // Absent flags are 'r'; a flag that cannot be folded may write.
    return sink === 'openSync' && (flags === undefined || (flags !== null && READ_ONLY_FLAGS.has(flags)));
}
/** One entry per path; a path any site reads synchronously is a synchronous read. */
function mergeRefs(list) {
    const merged = new Map();
    for (const r of list)
        merged.set(r.path, merged.get(r.path) === true || r.sync);
    return [...merged].map(([path, sync]) => ({ path, sync }));
}
/** `pkg/sub/file.ext` or `@scope/pkg/sub/file.ext`: a bare specifier naming a file. */
const BARE_SUBPATH = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@-]+)+\.[a-z0-9]+$/i;
function parseAny(source) {
    for (const sourceType of ['module', 'script']) {
        try {
            return parse(source, {
                ecmaVersion: 'latest',
                sourceType,
                allowHashBang: true,
                allowReturnOutsideFunction: sourceType === 'script',
                allowAwaitOutsideFunction: true,
            });
        }
        catch { /* try the other goal */ }
    }
    return null;
}
function normalize(path) {
    const out = [];
    for (const seg of path.split('/')) {
        if (seg === '' || seg === '.')
            continue;
        if (seg === '..')
            out.pop();
        else
            out.push(seg);
    }
    return '/' + out.join('/');
}
function dirnameOf(path) {
    const n = normalize(path);
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
}
function isNode(value) {
    return typeof value === 'object' && value !== null && typeof value.type === 'string';
}
/**
 * Every statically named path in `source`, a module whose own path is
 * `filename` (absolute). Unparseable sources name nothing.
 */
export function findStaticFsReferences(source, filename) {
    if (source.length > STATIC_AST_MAX_SOURCE)
        return scanStaticFsTokens(source, filename);
    const refs = { exact: [], listed: [], patterns: [], cwdRelative: [], resolves: [] };
    const ast = parseAny(source);
    if (ast === null)
        return refs;
    const file = normalize(filename);
    const dir = dirnameOf(file);
    const fileUrl = 'file://' + file;
    // Bindings: name → initializer, when the name is bound exactly once and
    // never assigned. Anything else is not a constant.
    const inits = new Map();
    const pathBindings = new Set();
    const pathFunctions = new Map();
    const resolvers = new Set();
    const bind = (name, init) => {
        inits.set(name, inits.has(name) ? null : init);
    };
    const requiresPath = (node) => {
        for (let n = node; isNode(n);) {
            if (n.type === 'CallExpression') {
                const callee = n.callee;
                const args = n.arguments;
                if (callee.type === 'Identifier' && callee.name === 'require' && args.length === 1) {
                    const a = args[0];
                    return a.type === 'Literal' && typeof a.value === 'string' && PATH_MODULES.has(a.value);
                }
                n = args.length === 1 ? args[0] : undefined;
                continue;
            }
            if (n.type === 'MemberExpression') {
                n = n.object;
                continue;
            }
            return false;
        }
        return false;
    };
    full(ast, (raw) => {
        const node = raw;
        if (node.type === 'VariableDeclarator') {
            const id = node.id;
            const init = node.init ?? null;
            if (id.type === 'Identifier') {
                bind(String(id.name), init);
                if (requiresPath(init))
                    pathBindings.add(String(id.name));
                if (init && init.type === 'CallExpression' && calleeName(init.callee) === 'createRequire')
                    resolvers.add(String(id.name));
            }
            else if (id.type === 'ObjectPattern' && requiresPath(init)) {
                for (const prop of id.properties) {
                    if (prop.type !== 'Property')
                        continue;
                    const key = prop.key;
                    const value = prop.value;
                    if (key.type === 'Identifier' && value.type === 'Identifier')
                        pathFunctions.set(String(value.name), String(key.name));
                }
            }
        }
        else if (node.type === 'AssignmentExpression') {
            const left = node.left;
            if (left.type === 'Identifier')
                inits.set(String(left.name), null);
        }
        else if (node.type === 'ImportDeclaration') {
            const from = node.source.value;
            if (typeof from !== 'string' || !PATH_MODULES.has(from))
                return;
            for (const spec of node.specifiers) {
                const local = String(spec.local.name);
                if (spec.type === 'ImportSpecifier')
                    pathFunctions.set(local, String(spec.imported.name));
                else
                    pathBindings.add(local);
            }
        }
    });
    /** The path-module function a callee denotes: "join", "resolve", "dirname", or null. */
    function pathCall(callee) {
        let c = callee;
        if (c.type === 'SequenceExpression')
            c = c.expressions.at(-1);
        if (c.type === 'Identifier')
            return pathFunctions.get(String(c.name)) ?? null;
        if (c.type !== 'MemberExpression' || c.computed)
            return null;
        const method = String(c.property.name);
        let obj = c.object;
        if (obj.type === 'MemberExpression' && !obj.computed
            && ['default', 'posix'].includes(String(obj.property.name)))
            obj = obj.object;
        if (obj.type === 'Identifier' && pathBindings.has(String(obj.name)))
            return method;
        if (obj.type === 'CallExpression' && requiresPath(obj))
            return method;
        return null;
    }
    const visiting = new Set();
    function evaluate(node) {
        if (!isNode(node))
            return undefined;
        switch (node.type) {
            case 'Literal':
                return typeof node.value === 'string' ? { exact: node.value } : undefined;
            case 'TemplateLiteral': {
                const quasis = node.quasis.map((q) => String(q.value.cooked ?? ''));
                const parts = [quasis[0]];
                node.expressions.forEach((e, i) => {
                    const v = evaluate(e);
                    parts.push(v && 'exact' in v ? v.exact : null, quasis[i + 1]);
                });
                return fold(parts);
            }
            case 'BinaryExpression': {
                if (node.operator !== '+')
                    return undefined;
                const l = evaluate(node.left);
                const r = evaluate(node.right);
                return fold([...flatten(l), ...flatten(r)]);
            }
            case 'Identifier': {
                const name = String(node.name);
                if (name === '__dirname')
                    return { exact: dir };
                if (name === '__filename')
                    return { exact: file };
                const init = inits.get(name);
                if (!init || visiting.has(name))
                    return undefined;
                visiting.add(name);
                try {
                    return evaluate(init);
                }
                finally {
                    visiting.delete(name);
                }
            }
            case 'MetaProperty':
                return undefined;
            case 'MemberExpression': {
                const obj = node.object;
                const prop = node.computed ? null : String(node.property.name);
                if (obj.type === 'MetaProperty' && prop !== null) {
                    if (prop === 'url')
                        return { exact: fileUrl };
                    if (prop === 'dirname')
                        return { exact: dir };
                    if (prop === 'filename')
                        return { exact: file };
                    return undefined;
                }
                if (prop === 'pathname' || prop === 'href') {
                    const v = evaluate(obj);
                    if (!v)
                        return undefined;
                    return prop === 'pathname' ? urlToPath(v) : v;
                }
                return undefined;
            }
            case 'NewExpression': {
                const callee = node.callee;
                if (callee.type !== 'Identifier' || callee.name !== 'URL')
                    return undefined;
                const args = node.arguments;
                return resolveUrl(evaluate(args[0]), args.length > 1 ? evaluate(args[1]) : undefined);
            }
            case 'CallExpression': {
                const callee = node.callee;
                const args = node.arguments.map((a) => evaluate(a));
                const name = calleeName(node.callee);
                if (name === 'fileURLToPath')
                    return args[0] ? urlToPath(args[0]) : undefined;
                if (name === 'pathToFileURL') {
                    const v = args[0];
                    if (!v)
                        return undefined;
                    return 'exact' in v ? { exact: 'file://' + v.exact } : { partial: { prefix: 'file://' + v.partial.prefix, suffix: v.partial.suffix } };
                }
                const fn = pathCall(callee);
                if (fn === 'join' || fn === 'resolve')
                    return joinValues(args, fn === 'resolve');
                if (fn === 'dirname' && args[0] && 'exact' in args[0])
                    return { exact: dirnameOf(args[0].exact) };
                return undefined;
            }
            case 'ChainExpression':
            case 'ParenthesizedExpression':
                return evaluate(node.expression);
            case 'AwaitExpression':
                return undefined;
            default:
                return undefined;
        }
    }
    full(ast, (raw) => {
        const node = raw;
        if (node.type === 'Literal') {
            // A package subpath spelled as data ("astro/runtime/client/x.js" in a
            // bundler's include list) is read by whatever resolves it.
            if (typeof node.value === 'string' && BARE_SUBPATH.test(node.value)) {
                refs.resolves.push({ from: dir, spec: node.value });
            }
            return;
        }
        if (node.type === 'NewExpression') {
            const v = evaluate(node);
            if (v)
                record(urlToPath(v));
            return;
        }
        if (node.type !== 'CallExpression')
            return;
        const name = calleeName(node.callee);
        const args = node.arguments;
        if (name === 'resolve' && args.length >= 1 && isResolver(node.callee)) {
            const spec = evaluate(args[0]);
            if (spec && 'exact' in spec)
                refs.resolves.push({ from: dir, spec: spec.exact });
            return;
        }
        const fn = pathCall(node.callee);
        if (fn === 'join' || fn === 'resolve' || name === 'fileURLToPath') {
            record(evaluate(node));
            return;
        }
        if (name === null || !FS_SINKS.has(name) || args.length === 0)
            return;
        const target = evaluate(args[0]);
        if (!target)
            return;
        const path = 'exact' in target && target.exact.startsWith('file:') ? urlToPath(target) : target;
        let flags;
        if (args.length > 1) {
            const folded = evaluate(args[1]);
            flags = folded && 'exact' in folded ? folded.exact : null;
        }
        const sync = syncRead(name, flags);
        if (path && 'exact' in path && !path.exact.startsWith('/')) {
            if (path.exact)
                refs.cwdRelative.push({ path: path.exact, sync });
            return;
        }
        record(path, sync);
        if (path && 'exact' in path && LIST_SINKS.has(name))
            refs.listed.push(normalize(path.exact));
    });
    function isResolver(callee) {
        let c = callee;
        if (c.type === 'SequenceExpression')
            c = c.expressions.at(-1);
        if (c.type !== 'MemberExpression')
            return false;
        const obj = c.object;
        if (obj.type === 'Identifier')
            return obj.name === 'require' || resolvers.has(String(obj.name));
        return obj.type === 'CallExpression' && calleeName(obj.callee) === 'createRequire';
    }
    function record(value, sync = false) {
        if (!value)
            return;
        if ('exact' in value) {
            if (value.exact.startsWith('/'))
                refs.exact.push({ path: normalize(value.exact), sync });
            return;
        }
        const { prefix, suffix } = value.partial;
        if (!prefix.startsWith('/') || suffix.includes('/'))
            return;
        const slash = prefix.lastIndexOf('/');
        const base = normalize(prefix.slice(0, slash + 1));
        // The unknown part may span directories only when the prefix's last
        // segment is empty; a hole mid-segment names siblings in one directory.
        refs.patterns.push({ dir: base, prefix: prefix.slice(slash + 1), suffix });
    }
    const seen = new Set();
    refs.resolves = refs.resolves.filter((r) => !seen.has(r.spec) && seen.add(r.spec) !== undefined);
    const patternKeys = new Set();
    refs.patterns = refs.patterns.filter((q) => {
        const key = q.dir + '\0' + q.prefix + '\0' + q.suffix;
        return !patternKeys.has(key) && patternKeys.add(key) !== undefined;
    });
    refs.exact = mergeRefs(refs.exact);
    refs.listed = [...new Set(refs.listed)];
    refs.cwdRelative = mergeRefs(refs.cwdRelative);
    return refs;
}
/**
 * Sources larger than this are scanned token by token instead of parsed.
 *
 * An AST costs the heap a multiple of its source — measured with acorn: 13 MB
 * for a 1.5 MB module, 94 MB for a 4.3 MB one — and the analysis runs in the
 * session's Durable Object, whose isolate has 128 MiB for everything. A
 * single-file CLI bundle past a few megabytes reset the session outright.
 */
export const STATIC_AST_MAX_SOURCE = 1024 * 1024;
/**
 * The same references, found in a token stream with O(1) memory: the
 * literal shapes that need no bindings. `join|resolve(__dirname | import.meta.
 * dirname, 'lit', ...)`, `new URL('lit', import.meta.url)`, a read call on an
 * absolute literal, and package-subpath literals. What folding through
 * bindings would add is not found here.
 */
export function scanStaticFsTokens(source, filename) {
    const refs = { exact: [], listed: [], patterns: [], cwdRelative: [], resolves: [] };
    const file = normalize(filename);
    const dir = dirnameOf(file);
    const recent = [];
    const at = (back) => recent[recent.length - 1 - back];
    const isPunct = (t, label) => t !== undefined && t.type === label;
    const scan = (sourceType) => {
        const tokens = tokenizer(source, {
            ecmaVersion: 'latest', sourceType, allowHashBang: true,
            allowReturnOutsideFunction: sourceType === 'script', allowAwaitOutsideFunction: true,
        });
        for (;;) {
            const token = tokens.getToken();
            if (token.type === tokTypes.eof)
                return;
            const type = token.type.label;
            // acorn's typings omit Token.value; it is the literal's or name's value.
            const value = token.value;
            recent.push({ type, value });
            if (recent.length > 64)
                recent.splice(0, recent.length - 32);
            if (type === 'string' && typeof value === 'string' && BARE_SUBPATH.test(value)) {
                refs.resolves.push({ from: dir, spec: value });
            }
            if (type !== ')')
                continue;
            // new URL('lit', import.meta.url)
            if (at(1)?.value === 'url' && isPunct(at(2), '.') && at(3)?.value === 'meta' && isPunct(at(4), '.')
                && at(5)?.type === 'import' && isPunct(at(6), ',') && at(7)?.type === 'string' && isPunct(at(8), '(')
                && at(9)?.value === 'URL' && at(10)?.type === 'new') {
                try {
                    refs.exact.push({ path: decodeURIComponent(new URL(String(at(7).value), 'file://' + file).pathname), sync: false });
                }
                catch { /* not a URL */ }
                continue;
            }
            // Walk back over `'a', 'b', ...` to what precedes the literal run.
            const lits = [];
            let i = 1;
            while (at(i)?.type === 'string' && isPunct(at(i + 1), ',')) {
                lits.unshift(String(at(i).value));
                i += 2;
            }
            // readFileSync('/abs') and friends, with at most one more literal
            // argument (an encoding, or openSync's flags).
            const sinkAt = lits.length === 0 ? 1 : lits.length === 1 ? i : -1;
            if (sinkAt > 0 && at(sinkAt)?.type === 'string' && isPunct(at(sinkAt + 1), '(')
                && at(sinkAt + 2)?.type === 'name' && FS_SINKS.has(String(at(sinkAt + 2).value))) {
                const lit = String(at(sinkAt).value);
                const sink = String(at(sinkAt + 2).value);
                if (lit.startsWith('/')) {
                    refs.exact.push({ path: normalize(lit), sync: syncRead(sink, lits[0]) });
                    if (LIST_SINKS.has(sink))
                        refs.listed.push(normalize(lit));
                }
                continue;
            }
            if (lits.length === 0)
                continue;
            // join|resolve(__dirname, ...) and (import.meta.dirname, ...)
            const dirnameArg = at(i)?.type === 'name' && at(i).value === '__dirname' ? i
                : at(i)?.value === 'dirname' && isPunct(at(i + 1), '.') && at(i + 2)?.value === 'meta'
                    && isPunct(at(i + 3), '.') && at(i + 4)?.type === 'import' ? i + 4 : -1;
            if (dirnameArg >= 0 && isPunct(at(dirnameArg + 1), '('))
                refs.exact.push({ path: normalize(dir + '/' + lits.join('/')), sync: false });
        }
    };
    try {
        scan('module');
    }
    catch {
        recent.length = 0;
        try {
            scan('script');
        }
        catch { /* names nothing more */ }
    }
    refs.exact = mergeRefs(refs.exact);
    refs.listed = [...new Set(refs.listed)];
    return refs;
}
function flatten(v) {
    if (!v)
        return [null];
    return 'exact' in v ? [v.exact] : [v.partial.prefix, null, v.partial.suffix];
}
/** Concatenate known strings and unknown holes (null) into one value. */
function fold(parts) {
    const first = parts.indexOf(null);
    if (first < 0)
        return { exact: parts.join('') };
    const last = parts.lastIndexOf(null);
    const prefix = parts.slice(0, first).join('');
    const suffix = parts.slice(last + 1).join('');
    if (!prefix && !suffix)
        return undefined;
    return { partial: { prefix, suffix } };
}
function joinValues(args, absolute) {
    let acc = '';
    for (let i = 0; i < args.length; i++) {
        const v = args[i];
        if (!v)
            return undefined;
        if ('partial' in v) {
            // Only the last argument may carry the hole.
            if (i !== args.length - 1)
                return undefined;
            if (absolute && v.partial.prefix.startsWith('/'))
                acc = '';
            const joined = normalize((acc ? acc + '/' : '') + v.partial.prefix);
            const keepSlash = v.partial.prefix === '' || v.partial.prefix.endsWith('/');
            return { partial: { prefix: joined + (keepSlash && joined !== '/' ? '/' : ''), suffix: v.partial.suffix } };
        }
        if (absolute && v.exact.startsWith('/'))
            acc = v.exact;
        else
            acc = acc ? acc + '/' + v.exact : v.exact;
    }
    if (!acc)
        return undefined;
    return { exact: acc.startsWith('/') ? normalize(acc) : acc.replace(/\/+/g, '/') };
}
function urlToPath(v) {
    if ('exact' in v) {
        if (!v.exact.startsWith('file:'))
            return v.exact.startsWith('/') ? v : undefined;
        try {
            return { exact: decodeURIComponent(new URL(v.exact).pathname) };
        }
        catch {
            return undefined;
        }
    }
    if (!v.partial.prefix.startsWith('file://'))
        return undefined;
    return { partial: { prefix: v.partial.prefix.slice('file://'.length), suffix: v.partial.suffix } };
}
function resolveUrl(rel, base) {
    if (!rel)
        return undefined;
    if (!base) {
        if ('exact' in rel && rel.exact.startsWith('file:'))
            return rel;
        return undefined;
    }
    if (!('exact' in base) || !base.exact.startsWith('file:'))
        return undefined;
    if ('exact' in rel) {
        try {
            return { exact: new URL(rel.exact, base.exact).href };
        }
        catch {
            return undefined;
        }
    }
    // Resolve the known prefix against the base, keep the hole.
    try {
        const at = new URL(rel.partial.prefix || '.', base.exact).href;
        const prefix = rel.partial.prefix === '' || rel.partial.prefix.endsWith('/') || at.endsWith('/') ? at : at;
        return { partial: { prefix, suffix: rel.partial.suffix } };
    }
    catch {
        return undefined;
    }
}
