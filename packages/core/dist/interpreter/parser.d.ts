/**
 * The parser of a node launch's map (nimbus/parser.js): acorn, bundled to
 * reach only the built-ins the launch captured at its start
 * (parser-realm.ts), and what a fatal report and Node's error_source read
 * with it. The interpreter requires it from beside it (worker
 * scripts/interpreter-bundle.mjs); a fatal report's arrow, Node's format
 * detection of a typeless file and an assertion's source read it alone,
 * without loading the interpreter.
 */
import { parse, type Options, type Token } from 'acorn';
export { parse };
/**
 * The brace in `body`, a CommonJS module's, that closes the function it is
 * the body of before its end (text after it goes on outside), as
 * [start, end]: null when it is one function body, or stops parsing before
 * the function closes (V8, which compiled it, is its judge).
 */
export declare function strayClosingBrace(body: string): [number, number] | null;
/**
 * Where module `text` imports `name` from the specifier `requested` (an
 * import's imported name, a default import's binding, an export-from's local
 * name), and that specifier's string literal, as [nameStart, nameEnd,
 * specifierStart, specifierEnd]: the missing-export report's arrow and the
 * specifier as written (node-shims.ts __nimbusEsmExportError). Null where no
 * declaration does, or the text does not parse.
 */
export declare function importedName(text: string, requested: string, name: string): [number, number, number, number] | null;
/** acorn's tokens of a text: read one at a time, or iterated. */
export type Tokens = Iterable<Token> & {
    getToken(): Token;
};
/** acorn's tokenizer, which Node's error_source.js reads an assert.ok() call's expression with. */
export declare function tokenizer(code: string, options: Options): Tokens;
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
/**
 * The last token of `text` (as CommonJS reads it) that ends at or before
 * `offset`, as [start, end]: where V8 places an argument list's missing `)`
 * at the end of the input. Null for none.
 */
export declare function lastTokenBefore(text: string, offset: number): [number, number] | null;
export declare function fatalLocation(text: string, goal: 'script' | 'module', offset: number): [number, number] | null;
//# sourceMappingURL=parser.d.ts.map