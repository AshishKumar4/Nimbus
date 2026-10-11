export declare function webSocketConstructor(input: unknown, options: unknown): {
    url: URL;
    headers: Headers;
};
export declare function webSocketSend(value: unknown): {
    data: string | Uint8Array | Promise<Uint8Array>;
    length: number;
};
export declare function webSocketClose(code: unknown, reason: unknown): {
    code: number | undefined;
    reason: string;
};
//# sourceMappingURL=websocket-arguments.d.ts.map