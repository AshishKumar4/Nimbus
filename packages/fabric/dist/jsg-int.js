/**
 * jsg-int.ts — an option workerd's API takes as an `int` (jsg's int
 * wrapper, value.h), as it converts it: ToNumber (unary plus: valueOf is
 * called, and a BigInt, given or made by valueOf, is a TypeError), 0 for a
 * number that is not finite, truncated; out of int32's range, the TypeError
 * workerd throws. A leaf: the guest adapter (inner-storage-env.ts) and the
 * session's KV store both convert by it.
 */
export function jsgInt(value) {
    if (value === undefined)
        return undefined;
    const number = +value;
    if (!Number.isFinite(number))
        return 0;
    if (number < -2147483648 || number > 2147483647) {
        throw new TypeError('Value out of range. Must be between -2147483648 and 2147483647 (inclusive).');
    }
    return Math.trunc(number);
}
