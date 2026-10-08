/**
 * module-requests.ts — the modules a parsed module asks for, and how.
 *
 * One analysis over an ESTree program, whichever parser produced it: the
 * import() prefetch's (moduleRequests, over this interpreter's parser) and
 * the supervisor's walk (core/runtime/require-resolver.ts
 * requireWrapperCalls, over acorn) read the same calls with it. It reaches
 * nodes only through the interpreter's captured intrinsics, as the rest of
 * the interpreter does (intrinsics.ts), since the prefetch runs it in the
 * program's realm.
 */
import { arrayIsArray, objectCreate, objectKeys, reflectGet } from './intrinsics.js';
/** A string literal, or a template with no substitutions: the specifier a request spells. */
function spelledString(node) {
    if (typeof node !== 'object' || node === null)
        return undefined;
    const type = reflectGet(node, 'type');
    if (type === 'Literal') {
        const value = reflectGet(node, 'value');
        return typeof value === 'string' ? value : undefined;
    }
    if (type !== 'TemplateLiteral')
        return undefined;
    const expressions = reflectGet(node, 'expressions');
    const quasis = reflectGet(node, 'quasis');
    if (!arrayIsArray(expressions) || expressions.length !== 0 || !arrayIsArray(quasis) || quasis.length !== 1)
        return undefined;
    const value = reflectGet(quasis[0], 'value');
    const cooked = typeof value === 'object' && value !== null ? reflectGet(value, 'cooked') : undefined;
    return typeof cooked === 'string' ? cooked : undefined;
}
/** An Identifier's name, else undefined. */
function identifierName(node) {
    if (typeof node !== 'object' || node === null || reflectGet(node, 'type') !== 'Identifier')
        return undefined;
    const name = reflectGet(node, 'name');
    return typeof name === 'string' ? name : undefined;
}
/** `createRequire(…)` or `<x>.createRequire(…)`: a require of its own. */
function makesRequire(node) {
    if (typeof node !== 'object' || node === null || reflectGet(node, 'type') !== 'CallExpression')
        return false;
    const callee = reflectGet(node, 'callee');
    if (identifierName(callee) === 'createRequire')
        return true;
    return typeof callee === 'object' && callee !== null && reflectGet(callee, 'type') === 'MemberExpression'
        && reflectGet(callee, 'computed') !== true && identifierName(reflectGet(callee, 'property')) === 'createRequire';
}
/** A function's first parameter, when it is a name (with or without a default). */
function firstParameter(fn) {
    if (typeof fn !== 'object' || fn === null)
        return undefined;
    const type = reflectGet(fn, 'type');
    if (type !== 'FunctionDeclaration' && type !== 'FunctionExpression' && type !== 'ArrowFunctionExpression')
        return undefined;
    const params = reflectGet(fn, 'params');
    if (!arrayIsArray(params) || params.length === 0)
        return undefined;
    const first = params[0];
    if (typeof first === 'object' && first !== null && reflectGet(first, 'type') === 'AssignmentPattern')
        return identifierName(reflectGet(first, 'left'));
    return identifierName(first);
}
/**
 * The require a call makes, by its callee: `x(…)` is x's, `x.resolve(…)` is
 * x's too (it resolves as x loads). Undefined for any other callee.
 */
function requireCallee(callee) {
    const name = identifierName(callee);
    if (name !== undefined)
        return name;
    if (typeof callee !== 'object' || callee === null || reflectGet(callee, 'type') !== 'MemberExpression')
        return undefined;
    if (reflectGet(callee, 'computed') === true || identifierName(reflectGet(callee, 'property')) !== 'resolve')
        return undefined;
    return identifierName(reflectGet(callee, 'object'));
}
/** Whether `body` passes `param` as the first argument of a call `isRequire` names. */
function passesToRequire(body, param, isRequire) {
    const pending = [body];
    while (pending.length > 0) {
        const node = pending[pending.length - 1];
        pending.length -= 1;
        if (typeof node !== 'object' || node === null)
            continue;
        if (arrayIsArray(node)) {
            for (let i = 0; i < node.length; i++)
                pending[pending.length] = node[i];
            continue;
        }
        const type = reflectGet(node, 'type');
        if (typeof type !== 'string' || type === 'Literal' || type === 'TemplateElement')
            continue;
        if (type === 'CallExpression') {
            const callee = requireCallee(reflectGet(node, 'callee'));
            const args = reflectGet(node, 'arguments');
            if (callee !== undefined && isRequire(callee) && arrayIsArray(args) && args.length > 0 && identifierName(args[0]) === param)
                return true;
        }
        const keys = objectKeys(node);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
                continue;
            pending[pending.length] = reflectGet(node, key);
        }
    }
    return false;
}
function analyze(program) {
    const requests = [];
    const add = (specifier, kind) => {
        if (specifier !== undefined)
            requests[requests.length] = { specifier, kind };
    };
    // Read as the walk goes, decided once it has seen every declaration: the
    // requires createRequire made, the named functions with a named first
    // parameter, the names passed first to a call, and the calls of a name
    // (other than require) with a string.
    const made = objectCreate(null);
    const functions = [];
    const passed = [];
    const calls = [];
    const candidate = (name, fn) => {
        const param = firstParameter(fn);
        if (name !== undefined && param !== undefined && typeof fn === 'object' && fn !== null)
            functions[functions.length] = { name, param, body: reflectGet(fn, 'body') };
    };
    const pending = [program];
    while (pending.length > 0) {
        const node = pending[pending.length - 1];
        pending.length -= 1;
        if (typeof node !== 'object' || node === null)
            continue;
        if (arrayIsArray(node)) {
            for (let i = 0; i < node.length; i++)
                pending[pending.length] = node[i];
            continue;
        }
        const type = reflectGet(node, 'type');
        if (typeof type !== 'string')
            continue;
        if (type === 'ImportDeclaration' || type === 'ExportAllDeclaration' || type === 'ExportNamedDeclaration') {
            add(spelledString(reflectGet(node, 'source')), 'static');
        }
        else if (type === 'ImportExpression') {
            add(spelledString(reflectGet(node, 'source')), 'dynamic');
        }
        else if (type === 'CallExpression') {
            const callee = reflectGet(node, 'callee');
            const args = reflectGet(node, 'arguments');
            if (arrayIsArray(args) && args.length > 0) {
                const name = identifierName(callee);
                const specifier = spelledString(args[0]);
                if (name === 'require')
                    add(specifier, 'require');
                else if (name !== undefined && specifier !== undefined)
                    calls[calls.length] = { callee: name, specifier };
                const from = requireCallee(callee);
                const param = identifierName(args[0]);
                if (from !== undefined && param !== undefined)
                    passed[passed.length] = { callee: from, param };
            }
        }
        else if (type === 'VariableDeclarator') {
            const name = identifierName(reflectGet(node, 'id'));
            const init = reflectGet(node, 'init');
            if (name !== undefined && makesRequire(init))
                made[name] = true;
            candidate(name, init);
        }
        else if (type === 'AssignmentExpression') {
            if (reflectGet(node, 'operator') === '=')
                candidate(identifierName(reflectGet(node, 'left')), reflectGet(node, 'right'));
        }
        else if (type === 'FunctionDeclaration') {
            candidate(identifierName(reflectGet(node, 'id')), node);
        }
        const keys = objectKeys(node);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
                continue;
            // A literal's or template element's value is data; elsewhere `value` holds a node (a property's).
            if ((key === 'value' || key === 'regex') && (type === 'Literal' || type === 'TemplateElement'))
                continue;
            pending[pending.length] = reflectGet(node, key);
        }
    }
    const isRequire = (name) => name === 'require' || made[name] === true;
    // Only a function whose parameter's name some require is passed is read again.
    const reaching = objectCreate(null);
    for (let i = 0; i < passed.length; i++)
        if (isRequire(passed[i].callee))
            reaching[passed[i].param] = true;
    const wrappers = objectCreate(null);
    for (let i = 0; i < functions.length; i++) {
        const { name, param, body } = functions[i];
        if (reaching[param] === true && !isRequire(name) && passesToRequire(body, param, isRequire))
            wrappers[name] = true;
    }
    const wrapperCalls = [];
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        if (wrappers[call.callee] === true)
            wrapperCalls[wrapperCalls.length] = call.specifier;
        if (made[call.callee] === true || wrappers[call.callee] === true)
            add(call.specifier, 'require');
    }
    return { requests, wrapperCalls };
}
/**
 * The modules a parsed module asks for: import and export-from sources,
 * `import()` of a string, and `require()` of a string: any call of a
 * `require` binding, the module's own or one createRequire made, by any
 * name. A call of a require wrapper with a string asks for it too: a
 * function whose own body passes its first parameter to such a require, or
 * to its `.resolve` (@vitejs/plugin-vue's `tryRequire(id, from)`, which
 * loads the project's vue/compiler-sfc as `tryRequire("vue/compiler-sfc",
 * root)`). A specifier spelled with escapes or in a template is read as the
 * language reads it; one in a comment or a string is not a request.
 */
export function programRequests(program) {
    return analyze(program).requests;
}
/** Of programRequests, the specifiers a require wrapper's calls name, each once. */
export function programWrapperCalls(program) {
    const calls = analyze(program).wrapperCalls;
    const seen = objectCreate(null);
    const unique = [];
    for (let i = 0; i < calls.length; i++) {
        if (seen[calls[i]] === true)
            continue;
        seen[calls[i]] = true;
        unique[unique.length] = calls[i];
    }
    return unique;
}
