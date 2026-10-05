/**
 * rolldown-compat.ts - what a rolldown build (rolldown-build.ts) does for one
 * module so that it comes out as esbuild 0.24 made it, where rolldown's own
 * transform cannot: its options are the whole build's, and a few of
 * esbuild's settings are per file or need what rolldown's transform does not
 * do. The load hook asks compileForBuild once per module and gets back null
 * (rolldown compiles the module itself), a refusal that fails the build, or
 * the module compiled here.
 *
 * Nothing here rewrites language source as text. Modules are read through
 * rolldown's binding parser (parseSync: ESTree, UTF-16 offsets, comments
 * apart from code) and compiled by its transform (transformSync, rolldown's
 * own Oxc), given the module's absolute path and the build's options except
 * for what each function names. The only edits are to that transform's
 * output, at nodes the parser placed, each as long as what it replaces, so
 * the transform's source map (which maps to the module as written) stays
 * the map.
 *
 * Self-contained but for types: the build facet's runtime bundles it.
 */
function isNode(value) {
    return typeof value === 'object' && value !== null
        && 'type' in value && typeof value.type === 'string'
        && 'start' in value && typeof value.start === 'number'
        && 'end' in value && typeof value.end === 'number';
}
/** `node[key]` when it is a node. */
function child(node, key) {
    const value = node?.[key];
    return isNode(value) ? value : null;
}
/** The nodes of the list `node[key]`. */
function list(node, key) {
    const value = node?.[key];
    return Array.isArray(value) ? value.filter(isNode) : [];
}
/** `node[key]` when it is a string. */
function stringOf(node, key) {
    const value = node?.[key];
    return typeof value === 'string' ? value : null;
}
/** Every node under `value`, each before its children. */
function* nodes(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* nodes(item);
        return;
    }
    if (typeof value !== 'object' || value === null)
        return;
    if (isNode(value))
        yield value;
    for (const [key, item] of Object.entries(value))
        if (key !== 'parent')
            yield* nodes(item);
}
function transformOf(api) {
    if (!api.transformSync)
        throw new Error('Nimbus\'s bundler has no transform of rolldown\'s for this module');
    return api.transformSync;
}
/**
 * `source` (the module's text unless given) parsed as `lang`: its program
 * with its comments' ranges, or null where it does not parse (rolldown
 * reports that itself).
 */
function parseWithComments(api, module, source = module.text, lang = module.loader) {
    if (!api.parseSync)
        throw new Error('Nimbus\'s bundler has no parser of rolldown\'s for this module');
    const typescript = lang === 'ts' || lang === 'tsx';
    const parsed = api.parseSync(module.path, source, { lang, sourceType: 'unambiguous', astType: typescript ? 'ts' : 'js' });
    if (parsed.errors.length !== 0 || !isNode(parsed.program))
        return null;
    return { program: parsed.program, comments: parsed.comments.filter(isNode) };
}
function parse(api, module, source = module.text, lang = module.loader) {
    return parseWithComments(api, module, source, lang)?.program ?? null;
}
/**
 * Whether an import with no specifiers has a clause (`import {} from "x"`,
 * not `import "x"`): a `{` in its code between `import` and its source, its
 * comments (by the parser) left out. Nothing else can stand there.
 */
function hasEmptyClause(source, node, comments) {
    if (node.type !== 'ImportDeclaration' || list(node, 'specifiers').length > 0)
        return false;
    const from = child(node, 'source');
    if (!from)
        return false;
    for (let at = node.start; at < from.start; at++) {
        const comment = comments.find((c) => c.start <= at && at < c.end);
        if (comment)
            at = comment.end - 1;
        else if (source[at] === '{')
            return true;
    }
    return false;
}
/** rolldown's (Oxc's) JSX and TypeScript options for the settings; `fragment` names the classic fragment in place of theirs. */
export function jsxAndTypescriptOf(settings, fragment = settings.jsx.fragment) {
    const { jsx } = settings;
    const classic = !jsx.preserve && !jsx.automatic;
    return {
        jsx: jsx.preserve
            ? 'preserve'
            : jsx.automatic
                ? { runtime: 'automatic', importSource: jsx.importSource ?? 'react', development: jsx.development }
                : { runtime: 'classic', pragma: jsx.factory ?? 'React.createElement', pragmaFrag: fragment ?? 'React.Fragment' },
        typescript: {
            // The import the classic factory keeps for the JSX that calls it. The
            // automatic runtime and preserved JSX call nothing the file imports,
            // so (as for esbuild) an import of React they leave unused is
            // dropped: an empty pragma names no import.
            jsxPragma: classic ? jsx.factory ?? 'React.createElement' : '',
            jsxPragmaFrag: classic ? fragment ?? 'React.Fragment' : '',
            // rolldown has one option for esbuild's two unused-import flags, both
            // at once (verbatimModuleSyntax); with either alone a module is
            // compiled keeping every import, then each is made what esbuild keeps
            // of it (ownCompile).
            onlyRemoveTypeImports: settings.keepValues || settings.keepStatements,
        },
    };
}
/**
 * The module as a build must compile it: null for rolldown's own transform
 * (which then makes it as esbuild did), a refusal, or the compiled module.
 * Throws where it needs rolldown's transform or parser and the build has none.
 */
export function compileForBuild(api, settings, module) {
    if (module.loader === 'ts' || module.loader === 'tsx') {
        const refusal = refusedTypeScript(api, settings, module);
        if (refusal)
            return refusal;
    }
    return ownCompile(api, settings, module);
}
/**
 * esbuild's decorators and class fields under a tsconfig that the engines
 * do not compile as esbuild did (tsconfig-raw.ts, TsSettings.refuse): the
 * first decorator, or the first class with a public or static field, in a
 * TypeScript module, with the refusal. A class's private fields alone stay
 * fields, as in esbuild. A module whose text has no `@`, or no `class`,
 * is not parsed for it.
 */
function refusedTypeScript(api, settings, module) {
    const decorators = settings.refuse.decorators && module.text.includes('@') ? settings.refuse.decorators : null;
    const classFields = settings.refuse.classFields && /\bclass\b/.test(module.text) ? settings.refuse.classFields : null;
    if (!decorators && !classFields)
        return null;
    const program = parse(api, module);
    for (const node of nodes(program)) {
        if (decorators && node.type === 'Decorator')
            return { refused: decorators, start: node.start, end: node.end };
        if (classFields && node.type === 'PropertyDefinition' && node.declare !== true && child(node, 'key')?.type !== 'PrivateIdentifier') {
            return { refused: classFields, start: node.start, end: node.end };
        }
    }
    return null;
}
/** `code` with each edit; overlapping edits after the first are dropped. */
function applyEdits(code, edits) {
    let out = '';
    let at = 0;
    for (const { start, end, replacement } of [...edits].sort((a, b) => a.start - b.start)) {
        if (start < at)
            continue;
        if (replacement.length !== end - start)
            throw new Error('rolldown-compat: an edit must keep its length');
        out += code.slice(at, start) + replacement;
        at = end;
    }
    return out + code.slice(at);
}
/** `code[start, end)` blanked: spaces, but its line terminators. */
const blanked = (code, start, end) => ({
    start, end, replacement: code.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, ' '),
});
/**
 * A module rolldown's own transform cannot make as esbuild did, compiled by
 * that transform with the build's options except for what follows; a module
 * that does not compile is left to rolldown to report. Null for every other
 * module.
 *
 * - A TypeScript module's imports, where esbuild's unused-import flags
 *   (tsconfig-raw.ts: KeepValues, KeepStmt) keep what rolldown's elision
 *   would not, or drop what it would keep. Oxc's elision drops imports and
 *   specifiers but keeps the rest in order, so each output import is matched
 *   to the source's by its module in order (matchImports), and becomes what
 *   esbuild keeps of it:
 *   - an import with an empty clause (`import {} from "x"`, printed
 *     `import "x"`) is blanked without KeepStmt, as esbuild drops it;
 *   - with KeepValues alone (compiled keeping every import), so is an import
 *     whose every specifier is a type;
 *   - with KeepStmt alone (compiled keeping every import), an import is what
 *     the build's elision without the flags keeps of it (a second
 *     compilation's import, matched the same way), or `import "x"` where that
 *     drops it, as esbuild keeps it. Either is shorter than the import it
 *     replaces, and is padded to its length on its first line.
 * - The automatic runtime's development variant: jsxDEV's `fileName` is the
 *   path the transform is given, and rolldown gives its own the module's id
 *   relative to its cwd (`home/user/…`), where this one is given the module's
 *   absolute path (esbuild wrote its namespace before it, `nimbus-vfs:/…`).
 *   Its createElement fallback (a key after a spread) gets no `__self` and
 *   `__source` props, as from esbuild: Oxc's are blanked.
 * - A constant fragment (`jsxFragment: '"frag"'`), which Oxc's pragma cannot
 *   name: a name that no node of the module's has (by the parser, however
 *   the source spells it), at least as long as the constant, names it. Each
 *   identifier of that name in the output is then the transform's, and
 *   becomes the constant, padded to the name's length.
 */
function ownCompile(api, settings, module) {
    const { jsx } = settings;
    const jsxModule = module.loader === 'jsx' || module.loader === 'tsx';
    const typescript = module.loader === 'ts' || module.loader === 'tsx';
    const classic = !jsx.preserve && !jsx.automatic;
    const constant = jsxModule && classic && jsx.fragmentConstant ? jsx.fragmentConstant.value : undefined;
    const development = jsxModule && jsx.automatic && jsx.development;
    const oneFlag = settings.keepValues !== settings.keepStatements;
    // Without a flag only an empty clause needs it, looked for in the text before parsing.
    const imports = typescript && /\bimport\b/.test(module.text)
        && (oneFlag || (!settings.keepStatements && EMPTY_CLAUSE.test(module.text)));
    if (!development && constant === undefined && !imports)
        return null;
    const parsed = parseWithComments(api, module);
    if (!parsed)
        return null;
    // Each import of the source, in order (`import type` TypeScript drops whole).
    const sourceImports = list(parsed.program, 'body')
        .filter((node) => node.type === 'ImportDeclaration' && node.importKind !== 'type')
        .map((node) => {
        const specifiers = list(node, 'specifiers');
        return {
            from: stringOf(child(node, 'source'), 'value'),
            empty: hasEmptyClause(module.text, node, parsed.comments),
            typesOnly: specifiers.length > 0 && specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type'),
        };
    });
    const fixImports = imports && (oneFlag || (!settings.keepStatements && sourceImports.some((i) => i.empty)));
    if (!development && constant === undefined && !fixImports)
        return null;
    let placeholder;
    let constantText = '';
    if (constant !== undefined) {
        const program = parsed.program;
        const taken = new Set();
        for (const node of nodes(program)) {
            const name = stringOf(node, 'name');
            if (name !== null)
                taken.add(name);
        }
        constantText = typeof constant === 'string' ? JSON.stringify(constant) : Object.is(constant, -0) ? '-0' : String(constant);
        placeholder = '__nimbusJsxFragment'.padEnd(constantText.length, '_');
        while (taken.has(placeholder))
            placeholder += '_';
    }
    const out = transformOf(api)(module.path, module.text, {
        lang: module.loader, sourceType: 'unambiguous', sourcemap: module.sourcemap, ...jsxAndTypescriptOf(settings, placeholder),
    });
    if (out.errors.length)
        return null;
    const output = parse(api, module, out.code, 'js');
    if (!output)
        return null;
    const edits = [];
    if (placeholder) {
        for (const node of nodes(output)) {
            if (node.type === 'Identifier' && node.name === placeholder) {
                edits.push({ start: node.start, end: node.end, replacement: constantText.padEnd(node.end - node.start) });
            }
        }
    }
    if (development) {
        for (const [start, end] of devFallbackProps(output, jsx.importSource ?? 'react'))
            edits.push(blanked(out.code, start, end));
    }
    if (fixImports) {
        const importEdits = esbuildImports(api, settings, module, sourceImports, out.code, output);
        if (!importEdits)
            return null;
        edits.push(...importEdits);
    }
    return { code: applyEdits(out.code, edits), map: module.sourcemap ? out.map : undefined };
}
/**
 * `import {}`, whitespace or comments anywhere between: an empty import
 * clause, or text that looks like one (the parser decides).
 */
const EMPTY_CLAUSE = /\bimport(?:\s|\/\*[^]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*\{(?:\s|\/\*[^]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*\}/;
/** The imports of a compiled module's program. */
const importsOf = (program) => list(program, 'body').filter((node) => node.type === 'ImportDeclaration');
/**
 * The edits that make a compiled module's imports what esbuild keeps of the
 * source's (ownCompile says how). Null where the output's imports do not
 * match the source's, or a replacement would not fit: then rolldown compiles
 * the module itself.
 */
function esbuildImports(api, settings, module, sourceImports, code, output) {
    const matched = matchImports(sourceImports, importsOf(output));
    if (!matched)
        return null;
    const edits = [];
    if (!settings.keepStatements) {
        for (const [node, index] of matched) {
            if (sourceImports[index].empty || (settings.keepValues && sourceImports[index].typesOnly))
                edits.push(blanked(code, node.start, node.end));
        }
        return edits;
    }
    if (settings.keepValues)
        return edits;
    // KeepStmt alone: what the build's elision without the flags keeps of each import.
    const plain = { ...settings, keepValues: false, keepStatements: false };
    const out = transformOf(api)(module.path, module.text, { lang: module.loader, sourceType: 'unambiguous', ...jsxAndTypescriptOf(plain) });
    if (out.errors.length)
        return null;
    const plainOutput = parse(api, module, out.code, 'js');
    const plainMatched = plainOutput ? matchImports(sourceImports, importsOf(plainOutput)) : null;
    if (!plainMatched)
        return null;
    const kept = new Map(plainMatched.map(([node, index]) => [index, out.code.slice(node.start, node.end)]));
    for (const [node, index] of matched) {
        const current = code.slice(node.start, node.end);
        const replacement = kept.get(index) ?? `import ${JSON.stringify(sourceImports[index].from)};`;
        if (replacement === current)
            continue;
        const firstLine = current.search(/[\n\r\u2028\u2029]/);
        if (/[\n\r\u2028\u2029]/.test(replacement) || replacement.length > (firstLine < 0 ? current.length : firstLine))
            return null;
        edits.push({ start: node.start, end: node.end, replacement: replacement + blanked(code, node.start + replacement.length, node.end).replacement });
    }
    return edits;
}
/**
 * The output's imports matched to the source's, by module in order (Oxc's
 * elision drops imports, never reorders them): each output import with the
 * index of its source import. An output import of a
 * module the source does not import is the transform's own (the automatic
 * runtime's), and is left; null where one has no source import left to be,
 * whose match then would be a guess.
 */
function matchImports(sourceImports, outputImports) {
    const out = [];
    let at = 0;
    for (const node of outputImports) {
        const from = stringOf(child(node, 'source'), 'value');
        let found = at;
        while (found < sourceImports.length && sourceImports[found].from !== from)
            found++;
        if (found === sourceImports.length) {
            // The transform's own (the automatic runtime's), unless the source imports it too.
            if (sourceImports.some((i) => i.from === from))
                return null;
            continue;
        }
        out.push([node, found]);
        at = found + 1;
    }
    return out;
}
/**
 * The automatic runtime falls back to `createElement` for a key after a
 * spread; in development Oxc gives that call `__self` and `__source` props,
 * where esbuild passes the props alone (the Oxc crate's
 * strip_dev_fallback_props). Each such prop's range in the output, with the
 * comma that joins it to the rest, overlapping ranges merged.
 */
function devFallbackProps(program, importSource) {
    let local = null;
    for (const node of list(program, 'body')) {
        if (node.type !== 'ImportDeclaration' || stringOf(child(node, 'source'), 'value') !== importSource)
            continue;
        for (const specifier of list(node, 'specifiers')) {
            if (specifier.type === 'ImportSpecifier' && stringOf(child(specifier, 'imported'), 'name') === 'createElement') {
                local = stringOf(child(specifier, 'local'), 'name');
            }
        }
    }
    if (!local)
        return [];
    const ranges = [];
    for (const node of nodes(program)) {
        const callee = child(node, 'callee');
        const props = list(node, 'arguments')[1];
        if (node.type !== 'CallExpression' || callee?.type !== 'Identifier' || callee.name !== local || props?.type !== 'ObjectExpression')
            continue;
        const properties = list(props, 'properties');
        properties.forEach((property, i) => {
            const key = stringOf(child(property, 'key'), 'name');
            if (property.type !== 'Property' || (key !== '__self' && key !== '__source'))
                return;
            if (i + 1 < properties.length)
                ranges.push([property.start, properties[i + 1].start]);
            else if (i > 0)
                ranges.push([properties[i - 1].end, property.end]);
            else
                ranges.push([property.start, property.end]);
        });
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of ranges) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1])
            last[1] = Math.max(last[1], end);
        else
            merged.push([start, end]);
    }
    return merged;
}
