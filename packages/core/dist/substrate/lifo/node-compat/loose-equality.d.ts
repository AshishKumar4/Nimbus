/**
 * loose-equality.ts — the `==` coercions, spelled out.
 *
 * `assert.equal`/`assert.notEqual` are specified against the `==` operator —
 * Node's own docs call it "shallow, coercive equality between the actual and
 * expected parameters using the == operator" — and since Node 14 both also
 * treat two NaNs as identical, which `==` on its own does not. Guest code
 * inside the sandbox sees those semantics, so the shim carries them here
 * instead of the strict comparison a reader would expect of new code.
 */
/** IsLooselyEqual — what `a == b` answers. */
export declare function looseEqual(a: unknown, b: unknown): boolean;
/**
 * Whether Node's legacy assertions call these equal: `==`, widened by the
 * both-sides-NaN case Node folded into `assert.equal` in v14. Node reaches
 * for the non-coercing `Number.isNaN`, so a string spelling "NaN" is not it.
 */
export declare function assertEqualHolds(a: unknown, b: unknown): boolean;
//# sourceMappingURL=loose-equality.d.ts.map