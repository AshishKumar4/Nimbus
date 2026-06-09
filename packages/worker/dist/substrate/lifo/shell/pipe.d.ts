import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
export declare class PipeChannel {
    private buffer;
    private closed;
    private waiting;
    readonly writer: CommandOutputStream;
    readonly reader: CommandInputStream;
    private read;
    private readAll;
    private readLine;
    private readBytes;
    close(): void;
    private deliver;
}
//# sourceMappingURL=pipe.d.ts.map