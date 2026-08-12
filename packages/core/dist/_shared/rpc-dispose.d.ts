export declare function disposeRpcResource(value: unknown): boolean;
export declare function disposeRpcResources(values: Iterable<unknown>): void;
export declare function useRpcResource<T, R>(promise: Promise<T>, use: (value: T) => R | Promise<R>): Promise<R>;
//# sourceMappingURL=rpc-dispose.d.ts.map