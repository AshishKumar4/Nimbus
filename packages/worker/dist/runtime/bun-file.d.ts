/**
 * Bun.file and Bun.write over a process's Node `fs`. The `bun` preamble
 * (bun-runner.ts) and opencode's Bun polyfill (opencode-facet-runner.ts) are
 * generated text: each evaluates this module's compiled body
 * (BUN_FILE_API_SOURCE, scripts/compile-facet-bodies.mjs) over its own fs.
 *
 * Every read and write goes through fs.promises, which reaches a file the
 * process does not hold; a sync read refuses one.
 */
/** What of Node's fs Bun.file and Bun.write use. */
export interface BunFileFs {
    promises: {
        readFile(path: string): Promise<Uint8Array>;
        writeFile(path: string, data: Uint8Array): Promise<void>;
        stat(path: string): Promise<{
            isDirectory(): boolean;
        }>;
    };
    statSync(path: string): {
        size: number;
    };
}
type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
export interface BunFile {
    readonly name: string;
    readonly size: number;
    readonly type: string;
    bytes(): Promise<Uint8Array>;
    text(): Promise<string>;
    json(): Promise<Json>;
    arrayBuffer(): Promise<ArrayBuffer>;
    exists(): Promise<boolean>;
    stream(): ReadableStream<Uint8Array>;
}
/** What Bun.write takes: bytes, or any other value, written as its string. */
export type BunWriteData = string | number | bigint | boolean | null | undefined | object;
export declare function bunFileApi(fs: BunFileFs): {
    file(path: string): BunFile;
    write(dest: string | BunFile, data: BunWriteData): Promise<number>;
};
export {};
//# sourceMappingURL=bun-file.d.ts.map