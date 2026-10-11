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
export declare function fatalLocation(text: string, goal: 'script' | 'module', offset: number): [number, number] | null;
//# sourceMappingURL=parser.d.ts.map