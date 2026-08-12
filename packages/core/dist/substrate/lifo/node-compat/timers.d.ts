export declare const _setTimeout: typeof setTimeout;
export declare const _setInterval: typeof setInterval;
export declare const _clearTimeout: typeof clearTimeout;
export declare const _clearInterval: typeof clearInterval;
export declare function setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]): ReturnType<typeof setTimeout>;
export declare function clearImmediate(id: ReturnType<typeof setTimeout>): void;
declare const _default: {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    clearTimeout: typeof clearTimeout;
    clearInterval: typeof clearInterval;
    setImmediate: typeof setImmediate;
    clearImmediate: typeof clearImmediate;
};
export default _default;
//# sourceMappingURL=timers.d.ts.map