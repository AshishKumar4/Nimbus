export type Pure<F> = F & {
    readonly __pure: true;
};
export declare function pure<F extends Function>(fn: F): Pure<F>;
export declare function isPure(fn: Function): fn is Pure<typeof fn>;
/**
 * Identity function that signals a value is intended as a serializable
 * constant for remote execution. No-op at runtime.
 */
export declare function constant<T>(value: T): T;
//# sourceMappingURL=primitives.d.ts.map