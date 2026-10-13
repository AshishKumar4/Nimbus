export declare const GIT_FRAMED_HEADER = "x-nimbus-git-framed";
export declare function framedGitBody(options: unknown, pack: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
export declare function readFramedGitBody(request: Request): Promise<{
    options: unknown;
    pack?: ReadableStream<Uint8Array>;
}>;
//# sourceMappingURL=remote-body.d.ts.map