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
import { parse } from 'acorn';
import { full } from 'acorn-walk';
const PATH_MODULES = new Set(['path', 'node:path', 'path/posix', 'node:path/posix']);
/** Calls whose first argument is a path the call reads, stats or lists. */
const FS_SINKS = new Set([
    'readFileSync', 'readFile', 'existsSync', 'exists', 'statSync', 'stat', 'lstatSync', 'lstat',
    'readdirSync', 'readdir', 'accessSync', 'access', 'openSync', 'open', 'createReadStream',
    'realpathSync', 'realpath', 'opendirSync', 'opendir', 'readlinkSync', 'readlink',
]);
const LIST_SINKS = new Set(['readdirSync', 'readdir', 'opendirSync', 'opendir']);
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
                if (init && init.type === 'CallExpression' && calleeName(init) === 'createRequire')
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
                const name = calleeName(node);
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
        const name = calleeName(node);
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
        if (path && 'exact' in path && !path.exact.startsWith('/')) {
            if (path.exact)
                refs.cwdRelative.push(path.exact);
            return;
        }
        record(path);
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
        return obj.type === 'CallExpression' && calleeName(obj) === 'createRequire';
    }
    function record(value) {
        if (!value)
            return;
        if ('exact' in value) {
            if (value.exact.startsWith('/'))
                refs.exact.push(normalize(value.exact));
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
    refs.exact = [...new Set(refs.exact)];
    refs.listed = [...new Set(refs.listed)];
    refs.cwdRelative = [...new Set(refs.cwdRelative)];
    return refs;
}
function calleeName(call) {
    let c = call.callee;
    if (c.type === 'SequenceExpression')
        c = c.expressions.at(-1);
    if (c.type === 'Identifier')
        return String(c.name);
    if (c.type === 'MemberExpression' && !c.computed)
        return String(c.property.name);
    return null;
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
