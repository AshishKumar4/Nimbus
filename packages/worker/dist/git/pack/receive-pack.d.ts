import { type Advertisement, type UploadPackOptions } from './upload-pack.js';
/** One ref update: the remote checks `old` as it applies it; all zeros for `new` deletes. */
export interface ReceiveCommand {
    ref: string;
    old: string;
    new: string;
}
export interface ReceivePackRequest {
    commands: readonly ReceiveCommand[];
    /** What the remote lacks of the new values; null when every command deletes. */
    pack: AsyncIterable<Uint8Array> | null;
    atomic: boolean;
    pushOptions: readonly string[];
}
/** receive-pack's report: the pack's unpacking, and each ref's outcome. */
export interface ReceivePackReport {
    unpack: {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    refs: Array<{
        ref: string;
        ok: boolean;
        reason?: string;
    }>;
}
/** The receive-pack side's refs and capabilities. */
export declare function discoverReceivePack(options: UploadPackOptions): Promise<Advertisement>;
/** Push: the commands, the options and the pack in one request; receive-pack's report. */
export declare function sendPack(options: UploadPackOptions, advertisement: Advertisement, request: ReceivePackRequest): Promise<ReceivePackReport>;
//# sourceMappingURL=receive-pack.d.ts.map