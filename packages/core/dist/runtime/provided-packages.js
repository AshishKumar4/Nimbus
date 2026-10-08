// Bundled CommonJS records of the packages the runtime provides (undici, …),
// bound to the runtime's own: a bundle that carries its own copy runs the
// provided one. Run on JavaScript before it is lowered or compiled: in the
// session, and in the transform facet on stripped TypeScript.
import { tokenizer, tokTypes } from 'acorn';
import { FACET_PROVIDED_PACKAGE_ENTRYPOINTS } from '../constants.js';
import { applySourceEdits, nodeList, nodeName, nodeProp, parseJavaScriptModule, walkTopLevelModuleTokens } from './javascript-ast.js';
/** The top-level import and export declarations, each through its `;`; null when one is unterminated or the source does not tokenize. */
function topLevelModuleDeclarationRanges(source) {
    const ranges = [];
    let active = null;
    const walked = walkTopLevelModuleTokens(source, (token, syntax, topLevel) => {
        if (active) {
            if (token.type === tokTypes.semi && topLevel) {
                ranges.push({ ...active, end: token.end });
                active = null;
            }
        }
        else if (syntax === 'import' || syntax === 'export') {
            active = { start: token.start, kind: syntax };
        }
        return false;
    });
    return walked === null || active ? null : ranges;
}
/**
 * The runtime's function a bound record calls for its package: the one the
 * module system serves (node-shims.ts), named apart from the module's own
 * `require`, which an ES module does not have (module-format.ts).
 */
export const PROVIDED_PACKAGE_HOOK = '__nimbusProvidedPackage';
/** Bind canonical esbuild/Bun CommonJS records to the runtime's provided packages. */
export function rewriteProvidedCommonJsModules(source) {
    if (!source.includes('__commonJS'))
        return source;
    const helpers = new Set(['__commonJS']);
    const declarations = topLevelModuleDeclarationRanges(source);
    if (!declarations)
        return source;
    for (const range of declarations) {
        const declaration = source.slice(range.start, range.end);
        if (tokenizer(declaration, { ecmaVersion: 'latest', sourceType: 'module' }).getToken().type !== tokTypes._import)
            continue;
        const parsed = parseJavaScriptModule(declaration);
        for (const statement of nodeList(parsed, 'body')) {
            if (statement.type !== 'ImportDeclaration')
                continue;
            for (const specifier of nodeList(statement, 'specifiers')) {
                if (nodeName(nodeProp(specifier, 'imported')) !== '__commonJS')
                    continue;
                const local = nodeName(nodeProp(specifier, 'local'));
                if (local)
                    helpers.add(local);
            }
        }
    }
    const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    let a = tokens.getToken();
    let b = tokens.getToken();
    let c = tokens.getToken();
    let d = tokens.getToken();
    let e = tokens.getToken();
    let previous = tokTypes.eof;
    const edits = [];
    while (a.type !== tokTypes.eof) {
        const labelValue = 'value' in d ? d.value : undefined;
        const helperValue = 'value' in a ? a.value : undefined;
        const label = d.type === tokTypes.string && typeof labelValue === 'string' ? labelValue : null;
        const entry = label === null ? undefined : Object.entries(FACET_PROVIDED_PACKAGE_ENTRYPOINTS).find(([name, path]) => {
            const suffix = 'node_modules/' + name + '/' + path;
            return label === suffix || label.endsWith('/' + suffix);
        });
        if (a.type === tokTypes.name && typeof helperValue === 'string' && helpers.has(helperValue)
            && previous !== tokTypes.dot && previous !== tokTypes.questionDot
            && b.type === tokTypes.parenL && c.type === tokTypes.braceL && entry
            && e.type === tokTypes.parenL) {
            let parens = 2;
            let braces = 1;
            let singleModule = true;
            let bodySeen = false;
            let last = e;
            let pendingComma = false;
            while (parens > 0) {
                const token = tokens.getToken();
                if (token.type === tokTypes.eof)
                    return source;
                if (pendingComma && token.type !== tokTypes.braceR)
                    singleModule = false;
                pendingComma = false;
                if (token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) {
                    if (braces === 1 && parens === 1)
                        bodySeen = true;
                    braces++;
                }
                else if (token.type === tokTypes.braceR)
                    braces--;
                if (token.type === tokTypes.parenL)
                    parens++;
                else if (token.type === tokTypes.parenR)
                    parens--;
                if (braces === 1 && parens === 1 && token.type === tokTypes.comma)
                    pendingComma = true;
                if (braces === 0 && parens === 1 && token.type !== tokTypes.braceR)
                    singleModule = false;
                last = token;
            }
            if (singleModule && bodySeen && braces === 0) {
                edits.push({ start: a.start, end: last.end, text: `(() => ${PROVIDED_PACKAGE_HOOK}(${JSON.stringify(entry[0])}))` });
            }
            previous = last.type;
            a = tokens.getToken();
            b = tokens.getToken();
            c = tokens.getToken();
            d = tokens.getToken();
            e = tokens.getToken();
            continue;
        }
        previous = a.type;
        a = b;
        b = c;
        c = d;
        d = e;
        e = tokens.getToken();
    }
    return edits.length === 0 ? source : applySourceEdits(source, edits);
}
