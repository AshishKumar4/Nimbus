/**
 * rolldown-compat.ts - what a rolldown build (rolldown-build.ts) does for one
 * module so that it comes out as esbuild 0.24 made it, where rolldown's own
 * transform cannot: its options are the whole build's, and a few of
 * esbuild's settings are per file or need what rolldown's transform does not
 * do. The load hook asks compileForBuild once per module and gets back null
 * (rolldown compiles the module itself) or the module compiled here.
 *
 * Nothing here rewrites language source as text. Modules are read through
 * rolldown's binding parser (parseSync: ESTree, UTF-16 offsets, comments
 * apart from code) and compiled by its transform (transformSync, rolldown's
 * own Oxc), given the module's absolute path and the build's options except
 * for what each function names. The only edits are to that transform's
 * output, at nodes the parser placed, each as long as what it replaces, so
 * the transform's source map (which maps to the module as written) stays
 * the map; and one that moves whole lines of it (decorators into tsc's
 * order), moving the map's lines with them.
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
 * (which then makes it as esbuild did), or the compiled module. Throws where
 * it needs rolldown's transform or parser and the build has none.
 */
export function compileForBuild(api, settings, module) {
    return ownCompile(api, settings, module);
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
 * - A TypeScript class with parameter properties (`constructor(public q)`),
 *   where fields are defined: Oxc declares a field for each (`q;`, first in
 *   the class), as tsc does, where esbuild only assigns it in the
 *   constructor; those declarations are blanked
 *   (parameterPropertyDeclarations), so its objects' own keys are in
 *   esbuild's order.
 * - A TypeScript module under `experimentalDecorators`: legacy decorators,
 *   whose calls are then put in tsc's order (decorateInTscOrder); or under
 *   `useDefineForClassFields` false: class fields lowered at es2021, the
 *   public ones assigned, one without an initializer removed. rolldown's
 *   transform options are its whole build's, and esbuild changes only
 *   TypeScript files for either. The helpers the output imports
 *   (`@oxc-project/runtime/helpers/…`) rolldown bundles from its own copy
 *   (builtin:oxc-runtime, ahead of every plugin).
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
    const decorators = typescript && settings.experimentalDecorators;
    const assign = typescript && settings.assignClassFields;
    const parameterProperties = typescript && !assign && PARAMETER_PROPERTY.test(module.text);
    const oneFlag = settings.keepValues !== settings.keepStatements;
    // Without a flag only an empty clause needs it, looked for in the text before parsing.
    const imports = typescript && /\bimport\b/.test(module.text)
        && (oneFlag || (!settings.keepStatements && EMPTY_CLAUSE.test(module.text)));
    if (!development && constant === undefined && !imports && !decorators && !assign && !parameterProperties)
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
            locals: localsOf(node),
        };
    });
    const fixImports = imports && (oneFlag || (!settings.keepStatements && sourceImports.some((i) => i.empty)));
    const classes = parameterProperties ? parameterPropertiesOf(parsed.program) : null;
    if (!development && constant === undefined && !fixImports && !decorators && !assign && !classes)
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
        // A line or paragraph separator escaped: raw, it would end a line, and the map's lines with it.
        constantText = typeof constant === 'string'
            ? JSON.stringify(constant).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
            : Object.is(constant, -0) ? '-0' : String(constant);
        placeholder = '__nimbusJsxFragment'.padEnd(constantText.length, '_');
        while (taken.has(placeholder))
            placeholder += '_';
    }
    const out = transformOf(api)(module.path, module.text, { ...transformOptions(settings, module, placeholder), sourcemap: module.sourcemap });
    if (out.errors.length)
        return null;
    const output = parse(api, module, out.code, outputLang(settings, module));
    if (!output)
        throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
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
    if (classes) {
        for (const [start, end] of parameterPropertyDeclarations(output, classes))
            edits.push(blanked(out.code, start, end));
    }
    if (assign)
        shadowedLowering(module, parsed.program, output);
    const code = applyEdits(out.code, edits);
    const map = module.sourcemap ? out.map : undefined;
    const moduleType = outputLang(settings, module);
    if (!decorators)
        return { code, map, moduleType };
    const edited = parse(api, module, code, moduleType);
    if (!edited)
        throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
    return { ...decorateInTscOrder(edited, code, map, new Set(sourceImports.flatMap((i) => i.locals))), moduleType };
}
/** What a compiled module is: JSX where the build preserves it, else JavaScript. */
function outputLang(settings, module) {
    return settings.jsx.preserve && (module.loader === 'jsx' || module.loader === 'tsx') ? 'jsx' : 'js';
}
/**
 * The options a module is compiled with here: the build's JSX and
 * TypeScript (`fragment` naming a constant fragment), and, for a TypeScript
 * module, legacy decorators (experimentalDecorators) and class fields
 * assigned (useDefineForClassFields false), which the build cannot set for
 * TypeScript files alone.
 */
function transformOptions(settings, module, fragment) {
    const typescriptModule = module.loader === 'ts' || module.loader === 'tsx';
    const assign = typescriptModule && settings.assignClassFields;
    const { jsx, typescript } = jsxAndTypescriptOf(settings, fragment);
    return {
        lang: module.loader,
        sourceType: 'unambiguous',
        jsx,
        typescript: assign ? { ...typescript, removeClassFieldsWithoutInitializer: true } : typescript,
        ...(typescriptModule && settings.experimentalDecorators ? { decorator: { legacy: true } } : {}),
        ...(assign ? { target: 'es2021', assumptions: { setPublicClassFields: true } } : {}),
    };
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
    const blanks = (i) => !settings.keepStatements && (i.empty || (settings.keepValues && i.typesOnly));
    const keptTypes = settings.keepValues || settings.keepStatements;
    const matched = matchImports(module, sourceImports, importsOf(output), keptTypes, (a, b) => blanks(a) === blanks(b));
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
    const out = transformOf(api)(module.path, module.text, transformOptions(plain, module));
    if (out.errors.length)
        return null;
    const plainOutput = parse(api, module, out.code, outputLang(settings, module));
    if (!plainOutput)
        throw new Error(`Nimbus's bundler could not read back its own compilation of ${module.path}`);
    // Every bare import of a module comes out \`import "x"\` here, whichever source import it was.
    const plainMatched = matchImports(module, sourceImports, importsOf(plainOutput), false, () => true);
    const kept = new Map(plainMatched.map(([node, index]) => [index, out.code.slice(node.start, node.end)]));
    for (const [node, index] of matched) {
        const current = code.slice(node.start, node.end);
        const replacement = kept.get(index) ?? `import ${JSON.stringify(sourceImports[index].from)};`;
        if (replacement === current)
            continue;
        const firstLine = current.search(/[\n\r\u2028\u2029]/);
        if (/[\n\r\u2028\u2029]/.test(replacement) || replacement.length > (firstLine < 0 ? current.length : firstLine)) {
            throw new Error(`Nimbus's bundler cannot fit esbuild's import of ${JSON.stringify(sourceImports[index].from)} in ${module.path} where it compiled one`);
        }
        edits.push({ start: node.start, end: node.end, replacement: replacement + blanked(code, node.start + replacement.length, node.end).replacement });
    }
    return edits;
}
/** The local names an import binds. */
function localsOf(node) {
    return list(node, 'specifiers').map((specifier) => stringOf(child(specifier, 'local'), 'name')).filter((name) => name !== null);
}
/**
 * Each of a compiled module's imports paired with the source import it came
 * from (its index), by provenance:
 *
 * - An import with names is the source import whose bindings it binds
 *   (elision drops specifiers, never renames them). One binding none of the
 *   source's is the transform's own (the automatic runtime's, its
 *   createElement fallback's), and is left out of the pairing; so are the
 *   names a transform adds to a source import.
 * - A bare import (\`import "x"\`) is one of the source's imports of that
 *   module that can come out bare, in order: one with no specifiers, or,
 *   where the compilation kept type-only imports (\`keptTypes\`), one whose
 *   every specifier is a type (Oxc's elision otherwise keeps a name of an
 *   import or drops it whole). Where there are more such imports than bare
 *   ones, which were dropped is not known: if \`alike\` says they would all
 *   be edited the same, any pairing will do; else this throws, and the
 *   build fails saying so, rather than guess.
 */
function matchImports(module, sourceImports, outputImports, keptTypes, alike) {
    const ambiguous = (from) => new Error(`Nimbus's bundler cannot tell which import of ${JSON.stringify(from)} in ${module.path} its compilation kept, to keep it as esbuild would`);
    const paired = [];
    const taken = new Set();
    const bare = [];
    for (const node of outputImports) {
        const locals = localsOf(node);
        if (locals.length === 0) {
            bare.push(node);
            continue;
        }
        const owners = new Set(locals.map((name) => sourceImports.findIndex((i) => i.locals.includes(name))).filter((index) => index >= 0));
        if (owners.size === 0)
            continue;
        const [owner] = owners;
        if (owners.size > 1 || taken.has(owner) || sourceImports[owner].from !== stringOf(child(node, 'source'), 'value')) {
            throw ambiguous(stringOf(child(node, 'source'), 'value'));
        }
        taken.add(owner);
        paired.push([node, owner]);
    }
    const byModule = new Map();
    for (const node of bare) {
        const from = stringOf(child(node, 'source'), 'value');
        byModule.set(from, [...(byModule.get(from) ?? []), node]);
    }
    for (const [from, nodes] of byModule) {
        const candidates = sourceImports.map((i, index) => index).filter((index) => !taken.has(index) && sourceImports[index].from === from
            && (sourceImports[index].locals.length === 0 || (keptTypes && sourceImports[index].typesOnly)));
        if (nodes.length > candidates.length)
            throw ambiguous(from);
        if (nodes.length < candidates.length && !candidates.every((index) => alike(sourceImports[index], sourceImports[candidates[0]])))
            throw ambiguous(from);
        nodes.forEach((node, k) => paired.push([node, candidates[k]]));
    }
    return paired;
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
/** A constructor parameter with a modifier, roughly: a module whose text has none has no parameter property. */
const PARAMETER_PROPERTY = /\bconstructor\s*\([^]*?\b(public|private|protected|readonly|override)\s+[A-Za-z_$]/;
/** Every class (declaration or expression) under `program`, in the order a visit meets them. */
const classesOf = (program) => [...nodes(program)].filter((node) => node.type === 'ClassDeclaration' || node.type === 'ClassExpression');
/** Each class's name and parameter properties, in the order classesOf meets them; null without any. */
function parameterPropertiesOf(program) {
    const classes = classesOf(program).map((node) => {
        const constructor = list(child(node, 'body'), 'body').find((member) => member.type === 'MethodDefinition' && member.kind === 'constructor');
        // A field the class writes of the same name is its own (Oxc adds none
        // beside it, and esbuild keeps it): only the others are Oxc's.
        const written = new Set(list(child(node, 'body'), 'body')
            .filter((member) => member.type === 'PropertyDefinition' && member.declare !== true && member.static !== true)
            .map((member) => stringOf(child(member, 'key'), 'name')));
        const properties = list(child(constructor ?? null, 'value'), 'params')
            .filter((param) => param.type === 'TSParameterProperty')
            .map((param) => {
            const parameter = child(param, 'parameter');
            return stringOf(parameter?.type === 'AssignmentPattern' ? child(parameter, 'left') : parameter, 'name');
        })
            .filter((name) => name !== null && !written.has(name));
        return { name: stringOf(child(node, 'id'), 'name'), properties };
    });
    return classes.some((c) => c.properties.length) ? classes : null;
}
/**
 * The field declarations Oxc adds for parameter properties, in a compiled
 * module (the Oxc crate's drop_parameter_property_fields): value-less
 * instance fields named by `classes`' properties, which leave out any the
 * class writes itself. Classes are matched to the source's by order and
 * name; were they not to match, none is taken.
 */
function parameterPropertyDeclarations(output, classes) {
    const compiled = classesOf(output);
    if (compiled.length !== classes.length)
        return [];
    const ranges = [];
    for (let i = 0; i < compiled.length; i++) {
        const name = stringOf(child(compiled[i], 'id'), 'name');
        if (name !== null && classes[i].name !== null && name !== classes[i].name)
            return [];
        for (const member of list(child(compiled[i], 'body'), 'body')) {
            const key = stringOf(child(member, 'key'), 'name');
            if (member.type === 'PropertyDefinition' && member.value === null && member.static !== true && member.computed !== true
                && key !== null && classes[i].properties.includes(key)) {
                ranges.push([member.start, member.end]);
            }
        }
    }
    return ranges;
}
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** A source map's `mappings`: each generated line's segments, every field absolute. */
function decodeMappings(mappings) {
    const state = [0, 0, 0, 0];
    return mappings.split(';').map((line) => {
        let column = 0;
        return line.split(',').filter(Boolean).map((segment) => {
            const fields = [];
            let value = 0;
            let shift = 0;
            for (const char of segment) {
                const digit = BASE64.indexOf(char);
                value += (digit & 31) << shift;
                if (digit & 32) {
                    shift += 5;
                }
                else {
                    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
                    value = 0;
                    shift = 0;
                }
            }
            column += fields[0];
            const out = [column];
            for (let i = 1; i < fields.length; i++)
                out.push((state[i - 1] += fields[i]));
            return out;
        });
    });
}
/** decodeMappings undone. */
function encodeMappings(lines) {
    const state = [0, 0, 0, 0];
    const vlq = (n) => {
        let value = n < 0 ? (-n << 1) | 1 : n << 1;
        let out = '';
        do {
            let digit = value & 31;
            value >>>= 5;
            if (value)
                digit |= 32;
            out += BASE64[digit];
        } while (value);
        return out;
    };
    return lines.map((segments) => {
        let column = 0;
        return segments.map((segment) => {
            let out = vlq(segment[0] - column);
            column = segment[0];
            for (let i = 1; i < segment.length; i++) {
                out += vlq(segment[i] - state[i - 1]);
                state[i - 1] = segment[i];
            }
            return out;
        }).join(',');
    }).join(';');
}
/** A decorator call's place in tsc's order (0 an instance member, 1 a static member, 2 the class) and its class's name. */
function decorateKind(statement, decorate) {
    const isDecorate = (node) => node?.type === 'CallExpression' && stringOf(child(node, 'callee'), 'name') === decorate;
    if (statement.type !== 'ExpressionStatement')
        return null;
    const expression = child(statement, 'expression');
    if (expression && isDecorate(expression)) {
        const target = list(expression, 'arguments')[1];
        if (target?.type === 'Identifier') {
            const name = stringOf(target, 'name');
            return name === null ? null : [1, name];
        }
        const object = child(target ?? null, 'object');
        if (target?.type === 'MemberExpression' && target.computed !== true && stringOf(child(target, 'property'), 'name') === 'prototype' && object?.type === 'Identifier') {
            const name = stringOf(object, 'name');
            return name === null ? null : [0, name];
        }
        return null;
    }
    const left = child(expression, 'left');
    if (expression?.type === 'AssignmentExpression' && left?.type === 'Identifier' && isDecorate(child(expression, 'right'))) {
        const name = stringOf(left, 'name');
        return name === null ? null : [2, name];
    }
    return null;
}
/**
 * tsc applies a class's decorators to its instance members first, then to
 * its static members, then to the class (its constructor's parameters with
 * it), each group in source order; esbuild too. Oxc's legacy transform calls
 * them in source order, one statement each after the class:
 * \`_decorate([..], A.prototype, "m", null)\`, \`_decorate([..], A, "s", ..)\`,
 * \`A = _decorate([..], A)\`. In a compiled module, each class's run of them is
 * put in tsc's order (the Oxc crate's decorate_in_tsc_order). Each sits on
 * lines of its own there: whole lines move, and the source map's lines with
 * them; a run that does not is left.
 */
function decorateInTscOrder(program, code, map, written) {
    // The transformer's import of the helper: not one the module wrote (`written`, its imports' bindings).
    let decorate = null;
    for (const node of list(program, 'body')) {
        if (node.type !== 'ImportDeclaration' || stringOf(child(node, 'source'), 'value') !== '@oxc-project/runtime/helpers/decorate')
            continue;
        const specifier = list(node, 'specifiers')[0];
        const local = specifier?.type === 'ImportDefaultSpecifier' ? stringOf(child(specifier, 'local'), 'name') : null;
        if (local !== null && !written.has(local))
            decorate = local;
    }
    if (decorate === null)
        return { code, map };
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++)
        if (code[i] === '\n')
            lineStarts.push(i + 1);
    const lineOf = (offset) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset)
                low = mid;
            else
                high = mid - 1;
        }
        return low;
    };
    const lineEnd = (line) => (line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : code.length);
    // Each run to reorder: its first and last lines, and its statements' line blocks in tsc's order.
    const moves = [];
    const runs = (statements) => {
        for (let i = 0; i < statements.length;) {
            const head = decorateKind(statements[i], decorate);
            if (!head) {
                i++;
                continue;
            }
            const run = [];
            let kind = head;
            while (kind && kind[1] === head[1]) {
                run.push({ statement: statements[i], rank: kind[0], first: lineOf(statements[i].start), last: lineOf(statements[i].end - 1) });
                i++;
                kind = i < statements.length ? decorateKind(statements[i], decorate) : null;
            }
            const alone = run.every(({ statement, first, last }, k) => code.slice(lineStarts[first], statement.start).trim() === ''
                && code.slice(statement.end, lineEnd(last)).trim() === '' && (k === 0 || run[k - 1].last + 1 === first));
            const sorted = [...run].sort((a, b) => a.rank - b.rank);
            if (!alone || sorted.every((entry, k) => entry === run[k]))
                continue;
            moves.push({ first: run[0].first, last: run[run.length - 1].last, order: sorted.map(({ first, last }) => [first, last]) });
        }
    };
    for (const node of nodes(program)) {
        if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock')
            runs(list(node, 'body'));
        if (node.type === 'SwitchCase')
            runs(list(node, 'consequent'));
    }
    if (!moves.length)
        return { code, map };
    const lines = code.split('\n');
    const mappingsText = typeof map === 'object' && map !== null && 'mappings' in map && typeof map.mappings === 'string' ? map.mappings : null;
    const mappings = mappingsText === null ? null : decodeMappings(mappingsText);
    while (mappings && mappings.length < lines.length)
        mappings.push([]);
    // Innermost first: a run nested in a statement of another (a decorated
    // class in a decorator factory's callback) permutes lines within that
    // statement's, so the outer run's line numbers stay right; the other way
    // round, the outer move would leave the inner one's stale.
    moves.sort((a, b) => (a.last - a.first) - (b.last - b.first));
    for (const { first, last, order } of moves) {
        lines.splice(first, last - first + 1, ...order.flatMap(([from, to]) => lines.slice(from, to + 1)));
        if (mappings)
            mappings.splice(first, last - first + 1, ...order.flatMap(([from, to]) => mappings.slice(from, to + 1)));
    }
    return { code: lines.join('\n'), map: mappings ? Object.assign({}, map, { mappings: encodeMappings(mappings) }) : map };
}
/** What the class-field lowering keeps private members in, read as globals. */
const LOWERING_GLOBALS = ['WeakMap', 'WeakSet'];
/** The names a binding binds: an identifier, or what the parts of a pattern bind. */
function* patternNames(node) {
    switch (node?.type) {
        case 'Identifier': {
            const name = stringOf(node, 'name');
            if (name !== null)
                yield name;
            return;
        }
        case 'ObjectPattern':
            for (const property of list(node, 'properties'))
                yield* patternNames(child(property, property.type === 'RestElement' ? 'argument' : 'value'));
            return;
        case 'ArrayPattern':
            for (const element of list(node, 'elements'))
                yield* patternNames(element);
            return;
        case 'RestElement':
            yield* patternNames(child(node, 'argument'));
            return;
        case 'AssignmentPattern':
            yield* patternNames(child(node, 'left'));
            return;
        case 'TSParameterProperty':
            yield* patternNames(child(node, 'parameter'));
            return;
        // `namespace A.B {}` binds A.
        case 'TSQualifiedName':
            yield* patternNames(child(node, 'left'));
            return;
    }
}
/** Where a node keeps types, which bind nothing at run time. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeParameters', 'returnType', 'typeArguments', 'superTypeArguments', 'implements', 'parent']);
/** Nodes that bind nothing at run time: ambient declarations, type-only imports, types and signatures. */
const TYPE_LEVEL = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSEmptyBodyFunctionExpression', 'TSIndexSignature']);
/**
 * Every name `value` binds at run time, in every binding position: variable
 * declarations and their patterns, function and class declarations and
 * expressions, parameters (and parameter properties), catch clauses,
 * imports, enums and namespaces. An ambient declaration (`declare const
 * WeakMap: ...`) is the global itself, and binds nothing.
 */
function* boundNames(value) {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* boundNames(item);
        return;
    }
    if (!isNode(value) || value.declare === true || value.importKind === 'type' || TYPE_LEVEL.has(value.type))
        return;
    switch (value.type) {
        case 'VariableDeclarator':
            yield* patternNames(child(value, 'id'));
            break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            yield* patternNames(child(value, 'id'));
            for (const parameter of list(value, 'params'))
                yield* patternNames(parameter);
            break;
        case 'ClassDeclaration':
        case 'ClassExpression':
        case 'TSEnumDeclaration':
        case 'TSModuleDeclaration':
        case 'TSImportEqualsDeclaration':
            yield* patternNames(child(value, 'id'));
            break;
        case 'CatchClause':
            yield* patternNames(child(value, 'param'));
            break;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
            yield* patternNames(child(value, 'local'));
            break;
    }
    for (const [key, item] of Object.entries(value))
        if (!TYPE_KEYS.has(key))
            yield* boundNames(item);
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** The names a list of statements binds lexically: let, const, class, function and import. */
function* lexicalNames(statements) {
    for (const statement of statements) {
        const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? child(statement, 'declaration') : statement;
        if (node?.type === 'VariableDeclaration' && node.kind !== 'var') {
            for (const declarator of list(node, 'declarations'))
                yield* patternNames(child(declarator, 'id'));
        }
        if (node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration')
            yield* patternNames(child(node, 'id'));
        if (node?.type === 'ImportDeclaration')
            for (const specifier of list(node, 'specifiers'))
                yield* patternNames(child(specifier, 'local'));
    }
}
/**
 * The names `var` binds in `value` for the function (or program, or static
 * block) it is in, not entering nested ones; in sloppy code, a function
 * declared in a block is one of them too (Annex B).
 */
function* varNames(value, sloppy, top = true) {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* varNames(item, sloppy, top);
        return;
    }
    if (!isNode(value))
        return;
    if (value.type === 'FunctionDeclaration' && sloppy && !top)
        yield* patternNames(child(value, 'id'));
    if (FUNCTIONS.has(value.type) || value.type === 'StaticBlock')
        return;
    if (value.type === 'VariableDeclaration' && value.kind === 'var') {
        for (const declarator of list(value, 'declarations'))
            yield* patternNames(child(declarator, 'id'));
    }
    for (const [key, item] of Object.entries(value))
        if (key !== 'parent')
            yield* varNames(item, sloppy, false);
}
/**
 * The scope `node`'s children are in, given the one it is in. A function's
 * parameters are in a scope of their own, its body's `var`s in its body's
 * (a parameter's default value does not see them).
 */
function scopeOf(node, scope, sloppy, functionBody) {
    const within = (names) => ({ names: new Set(names), parent: scope });
    switch (node.type) {
        case 'Program':
        case 'StaticBlock':
            return within([...varNames(list(node, 'body'), sloppy), ...lexicalNames(list(node, 'body'))]);
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            return within([
                ...(node.type === 'FunctionExpression' ? patternNames(child(node, 'id')) : []),
                ...list(node, 'params').flatMap((parameter) => [...patternNames(parameter)]),
            ]);
        case 'BlockStatement':
            return within([...(functionBody ? varNames(list(node, 'body'), sloppy) : []), ...lexicalNames(list(node, 'body'))]);
        case 'SwitchStatement':
            return within(lexicalNames(list(node, 'cases').flatMap((c) => list(c, 'consequent'))));
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement': {
            const head = child(node, node.type === 'ForStatement' ? 'init' : 'left');
            return within(head?.type === 'VariableDeclaration' && head.kind !== 'var'
                ? list(head, 'declarations').flatMap((declarator) => [...patternNames(child(declarator, 'id'))])
                : []);
        }
        case 'CatchClause':
            return within(patternNames(child(node, 'param')));
        // A class's name is its body's too (an expression's, only its body's).
        case 'ClassDeclaration':
        case 'ClassExpression':
            return within(patternNames(child(node, 'id')));
        default:
            return scope;
    }
}
/** Every node under `value`, each with the scope it is in. */
function* scoped(value, scope, sloppy, functionBody = false) {
    if (Array.isArray(value)) {
        for (const item of value)
            yield* scoped(item, scope, sloppy);
        return;
    }
    if (!isNode(value))
        return;
    yield [value, scope];
    const inner = scopeOf(value, scope, sloppy, functionBody);
    const isFunction = FUNCTIONS.has(value.type);
    for (const [key, item] of Object.entries(value))
        if (key !== 'parent')
            yield* scoped(item, inner, sloppy, isFunction && key === 'body');
}
function binds(scope, name) {
    for (let at = scope; at; at = at.parent)
        if (at.names.has(name))
            return true;
    return false;
}
/**
 * The global a `new WeakMap()` or `new WeakSet()` of the lowering's reads,
 * where `node` stores one: the lowering keeps each in a name of its own
 * (`var _p = new WeakMap()`, or `_p = new WeakMap()` beside a class
 * expression, `var _p` hoisted), which no binding of the source has (Oxc
 * makes its names apart from the module's) and the compiled module binds.
 */
function loweringStore(node, sourceNames, outputNames) {
    const [store, value] = node.type === 'VariableDeclarator' ? [child(node, 'id'), child(node, 'init')]
        : node.type === 'AssignmentExpression' && node.operator === '=' ? [child(node, 'left'), child(node, 'right')]
            : [null, null];
    const callee = child(value, 'callee');
    const global = callee?.type === 'Identifier' ? stringOf(callee, 'name') : null;
    const name = store?.type === 'Identifier' ? stringOf(store, 'name') : null;
    if (value?.type !== 'NewExpression' || list(value, 'arguments').length !== 0 || global === null || !LOWERING_GLOBALS.includes(global))
        return null;
    return name !== null && !sourceNames.has(name) && outputNames.has(name) ? global : null;
}
/** Whether a program's code is sloppy: a script without "use strict". */
function isSloppy(program) {
    if (program.sourceType === 'module')
        return false;
    return !list(program, 'body').some((statement) => statement.type === 'ExpressionStatement' && statement.directive === 'use strict');
}
/**
 * A TypeScript module whose class fields are lowered (useDefineForClassFields
 * false) keeps lowered private members in `new WeakMap()` and `new WeakSet()`,
 * read as globals, which the lowering puts beside the class (before a class
 * declaration, inline with a class expression). A binding of the module's
 * by either name in scope there takes them (the Oxc crate renames that
 * binding, `WeakMap2`, by its symbol; here the compiled module is rolldown's
 * transform's text). So each the lowering made is resolved in the compiled
 * module's scopes, and where a binding of the module's reaches it, the
 * module is refused, naming the binding, rather than compiled to code that
 * calls the module's own WeakMap; a binding elsewhere (a function's
 * parameter, a block's, a class expression's name) is left alone. Were the
 * compiled module to create more of them than the source and those
 * recognised (a lowering this does not know), it is refused rather than
 * guessed.
 */
function shadowedLowering(module, source, output) {
    const sourceNames = new Set(boundNames(source));
    if (!LOWERING_GLOBALS.some((name) => sourceNames.has(name)))
        return;
    const outputNames = new Set(boundNames(output));
    const made = new Map();
    for (const [node, scope] of scoped(output, { names: new Set(), parent: null }, isSloppy(output))) {
        const name = loweringStore(node, sourceNames, outputNames);
        if (name === null)
            continue;
        made.set(name, (made.get(name) ?? 0) + 1);
        if (binds(scope, name)) {
            throw new Error(`Nimbus's bundler does not support a TypeScript module that declares its own ${name} where a class with private members `
                + `sees it and useDefineForClassFields is false (${module.path}): lowering them reads the global ${name}, which the module's binding shadows there`);
        }
    }
    const created = (program, name) => [...nodes(program)].filter((node) => node.type === 'NewExpression' && stringOf(child(node, 'callee'), 'name') === name).length;
    for (const name of LOWERING_GLOBALS) {
        if (created(output, name) - created(source, name) > (made.get(name) ?? 0)) {
            throw new Error(`Nimbus's bundler cannot tell the ${name} the lowering of private members creates from the module's own (${module.path}), `
                + `which declares its own ${name}, with useDefineForClassFields false`);
        }
    }
}
