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
/** The spec's Object type: everything callable or keyed, null excluded. */
function isObject(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}
/** ToPrimitive(value) with the default hint. */
function toPrimitive(value) {
    if (Symbol.toPrimitive in value) {
        const exotic = value[Symbol.toPrimitive];
        if (typeof exotic === 'function')
            return exotic.call(value, 'default');
    }
    for (const method of ['valueOf', 'toString']) {
        if (!(method in value))
            continue;
        const convert = value[method];
        if (typeof convert !== 'function')
            continue;
        const primitive = convert.call(value);
        if (!isObject(primitive))
            return primitive;
    }
    throw new TypeError('Cannot convert object to primitive value');
}
/**
 * A bigint compares against the mathematical value of its counterpart, so a
 * fractional number, a non-finite one, or a string naming no integer can
 * never match one.
 */
function bigIntLooseEqual(big, other) {
    if (typeof other === 'number')
        return Number.isInteger(other) && BigInt(other) === big;
    if (typeof other !== 'string')
        return false;
    try {
        return BigInt(other) === big;
    }
    catch {
        return false;
    }
}
/** IsLooselyEqual — what `a == b` answers. */
export function looseEqual(a, b) {
    if (a === null || a === undefined)
        return b === null || b === undefined;
    if (b === null || b === undefined)
        return false;
    // Two objects match only as the same reference; an object against a
    // primitive matches on the object's own primitive value.
    if (isObject(a)) {
        return isObject(b) ? a === b : looseEqual(toPrimitive(a), b);
    }
    if (isObject(b))
        return looseEqual(a, toPrimitive(b));
    const aType = typeof a;
    const bType = typeof b;
    if (aType === bType)
        return a === b;
    if (aType === 'boolean')
        return looseEqual(Number(a), b);
    if (bType === 'boolean')
        return looseEqual(a, Number(b));
    if (aType === 'symbol' || bType === 'symbol')
        return false;
    if (typeof a === 'bigint')
        return bigIntLooseEqual(a, b);
    if (typeof b === 'bigint')
        return bigIntLooseEqual(b, a);
    return Number(a) === Number(b);
}
/**
 * Whether Node's legacy assertions call these equal: `==`, widened by the
 * both-sides-NaN case Node folded into `assert.equal` in v14. Node reaches
 * for the non-coercing `Number.isNaN`, so a string spelling "NaN" is not it.
 */
export function assertEqualHolds(a, b) {
    if (typeof a === 'number' && typeof b === 'number') {
        if (Number.isNaN(a) && Number.isNaN(b))
            return true;
    }
    return looseEqual(a, b);
}
