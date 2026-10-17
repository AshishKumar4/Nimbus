/**
 * The parser of a node launch's map (nimbus/parser.js): acorn, bundled to
 * reach only the built-ins the launch captured at its start
 * (parser-realm.ts), and what a fatal report and Node's error_source read
 * with it. The interpreter requires it from beside it (worker
 * scripts/interpreter-bundle.mjs); a fatal report's arrow, Node's format
 * detection of a typeless file and an assertion's source read it alone,
 * without loading the interpreter.
 */
import { Parser, parse, tokTypes } from 'acorn';
import { own } from './parser-realm.js';
import { objectCreate, objectKeys, reflectGet, reflectSet, stringSlice } from './intrinsics.js';
// The interpreter's acorn (worker scripts/interpreter-bundle.mjs checks it imports nothing else).
export { parse };
const MODULE_OPTIONS = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'module' });
const COMMONJS_OPTIONS = own({ ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', allowReturnOutsideFunction: true });
const SCRIPT_OPTIONS = own({ ecmaVersion: 'latest', sourceType: 'script' });
// The end of acorn's message (and V8's) for a name declared twice.
const REDECLARED = ' has already been declared';
const AcornParserClass = Parser;
const FOUND = objectCreate(null);
/**
 * acorn keeping no statement once parsed, at the top level or in a block (a
 * fatal error may come from a multi-MiB bundle, and acorn's tree is 17 to 24
 * times its source): what is held is the chain of open nodes. It stops at the
 * innermost throw whose argument holds `offset`, which finishes before any
 * throw around it.
 */
class ThrowFinder extends AcornParserClass {
    offset = -1;
    found = null;
    // The token a syntax error is at, as V8 marks it: the parser's current or
    // last token where one starts there (a reserved word is raised past it).
    raisedToken = null;
    // The binding a declarator just parsed, which V8 marks where its initializer is missing.
    declared = null;
    parseVarId(decl, kind) {
        this.declared = null;
        super.parseVarId(decl, kind);
        this.declared = { start: decl.id.start, end: decl.id.end, required: kind === 'const' || decl.id.type !== 'Identifier' };
    }
    raise(pos, message) {
        const declared = this.declared;
        const missingInitializer = declared !== null && declared.required && declared.end === this.lastTokEnd
            && this.type !== tokTypes.eq && (pos === this.start || pos === this.lastTokEnd);
        // V8 marks a redeclared name by its first character.
        const redeclared = stringSlice(message, -REDECLARED.length) === REDECLARED;
        this.raisedToken = missingInitializer ? [declared.start, declared.end]
            : redeclared ? [pos, pos + 1]
                : pos === this.start ? [pos, this.end] : pos === this.lastTokStart ? [pos, this.lastTokEnd] : null;
        return super.raise(pos, message);
    }
    // acorn's is its raise, not a call of it.
    raiseRecoverable(pos, message) {
        return this.raise(pos, message);
    }
    parseTopLevel(node) {
        const exports = objectCreate(null);
        while (this.type !== tokTypes.eof)
            this.parseStatement(null, true, exports);
        if (this.inModule) {
            const names = objectKeys(this.undefinedExports);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const { start, end } = this.undefinedExports[name];
                this.raisedToken = [start, end];
                super.raise(start, "Export '" + name + "' is not defined");
            }
        }
        this.next();
        return this.finishNode(node, 'Program');
    }
    parseBlock(createNewLexicalScope = true, node = this.startNode(), exitStrict = false) {
        reflectSet(node, 'body', []);
        this.expect(tokTypes.braceL);
        if (createNewLexicalScope)
            this.enterScope(0);
        while (this.type !== tokTypes.braceR)
            this.parseStatement(null);
        if (exitStrict)
            this.strict = false;
        this.next();
        if (createNewLexicalScope)
            this.exitScope();
        return this.finishNode(node, 'BlockStatement');
    }
    finishNode(node, type) {
        const finished = super.finishNode(node, type);
        if (type === 'ThrowStatement') {
            const argument = reflectGet(finished, 'argument');
            if (this.offset >= reflectGet(argument, 'start') && this.offset < reflectGet(finished, 'end')) {
                const start = reflectGet(finished, 'start');
                this.found = [start, start + 1];
                throw FOUND;
            }
        }
        return finished;
    }
}
/**
 * A ThrowFinder that notes where the braces it reads first close all they
 * opened: as the parser moves past that `}`, before the lexer reads on (what
 * follows may not lex in a declaration's place).
 */
class ClosingBrace extends ThrowFinder {
    depth = 0;
    closedAt = -1;
    next() {
        if (this.type === tokTypes.braceL || this.type === tokTypes.dollarBraceL)
            this.depth++;
        else if (this.type === tokTypes.braceR && --this.depth === 0 && this.closedAt === -1)
            this.closedAt = this.start;
        super.next();
    }
}
// A CommonJS module's body as Node compiles it (wrapSafe): in a function of the wrapper's names.
const BODY_HEAD = 'function f(exports, require, module, __filename, __dirname) {';
/**
 * The brace in `body`, a CommonJS module's, that closes the function it is
 * the body of before its end (text after it goes on outside), as
 * [start, end]: null when it is one function body, or stops parsing before
 * the function closes (V8, which compiled it, is its judge).
 */
export function strayClosingBrace(body) {
    const text = BODY_HEAD + body + '\n}';
    const finder = new ClosingBrace(SCRIPT_OPTIONS, text);
    try {
        finder.parse();
    }
    catch { /* where the function closed is known, or V8 is the judge */ }
    if (finder.closedAt === -1 || finder.closedAt === text.length - 1)
        return null;
    const at = finder.closedAt - BODY_HEAD.length;
    return [at, at + 1];
}
/**
 * Where module `text` imports `name` from the specifier `requested` (an
 * import's imported name, a default import's binding, an export-from's local
 * name), and that specifier's string literal, as [nameStart, nameEnd,
 * specifierStart, specifierEnd]: the missing-export report's arrow and the
 * specifier as written (node-shims.ts __nimbusEsmExportError). Null where no
 * declaration does, or the text does not parse.
 */
export function importedName(text, requested, name) {
    let program;
    try {
        program = parse(text, MODULE_OPTIONS);
    }
    catch {
        return null;
    }
    const body = reflectGet(program, 'body');
    for (let i = 0; i < body.length; i++) {
        const statement = body[i];
        const type = reflectGet(statement, 'type');
        if (type !== 'ImportDeclaration' && type !== 'ExportNamedDeclaration')
            continue;
        const source = reflectGet(statement, 'source');
        if (source === null || reflectGet(source, 'value') !== requested)
            continue;
        const specifiers = reflectGet(statement, 'specifiers');
        for (let j = 0; j < specifiers.length; j++) {
            const specifier = specifiers[j];
            const kind = reflectGet(specifier, 'type');
            const node = (kind === 'ImportSpecifier' ? reflectGet(specifier, 'imported')
                : kind === 'ImportDefaultSpecifier' || kind === 'ExportSpecifier' ? reflectGet(specifier, 'local') : null);
            if (node === null)
                continue;
            const named = kind === 'ImportDefaultSpecifier' ? 'default'
                : reflectGet(node, 'type') === 'Identifier' ? reflectGet(node, 'name') : reflectGet(node, 'value');
            if (named !== name)
                continue;
            return [reflectGet(node, 'start'), reflectGet(node, 'end'),
                reflectGet(source, 'start'), reflectGet(source, 'end')];
        }
    }
    return null;
}
/** acorn's tokenizer, which Node's error_source.js reads an assert.ok() call's expression with. */
export function tokenizer(code, options) {
    return Parser.tokenizer(code, options);
}
/**
 * Where V8 would place a fatal error's report in `text`, a module's whole
 * text (a `{ cjs }` cell's wrapper included) as `goal` parses it, for the
 * process's fatal report (node-shims.ts __nimbusFatalArrow), which has a
 * frame's offset and not V8's message:
 *   - `offset` given: the innermost `throw` statement whose argument holds
 *     it, as [start, start + 1], V8's location of a throw; null for none;
 *   - `offset` -1: the syntax error that stops the parse, as [start, end]
 *     of the token it stops at; null when the text parses.
 */
export function fatalLocation(text, goal, offset) {
    const finder = new ThrowFinder(goal === 'module' ? MODULE_OPTIONS : COMMONJS_OPTIONS, text);
    finder.offset = offset;
    try {
        finder.parse();
    }
    catch (error) {
        if (error === FOUND)
            return finder.found;
        if (offset !== -1 || ((typeof error !== 'object' || error === null) && typeof error !== 'function'))
            return null;
        const token = finder.raisedToken;
        if (token !== null && token[1] > token[0])
            return token;
        const at = reflectGet(error, 'pos');
        const end = reflectGet(error, 'raisedAt');
        if (typeof at !== 'number')
            return null;
        return [at, typeof end === 'number' && end > at ? end : at + 1];
    }
    return null;
}
