/**
 * The body of the async function a REPL line runs as, called with the global
 * object as `this`; it returns `{ value }` when the line ends in an
 * expression statement. Null when the line is incomplete (more lines may
 * finish it, as Node's REPL reads them). Throws the SyntaxError of a line no
 * more input can complete.
 */
export declare function replLineBody(text: string): string | null;
//# sourceMappingURL=repl-line.d.ts.map