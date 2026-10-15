declare const tty: import("./tty-streams.js").TtyModule;
export declare const ReadStream: new (fd: number) => import("node:stream").Readable, WriteStream: new (fd: number) => import("node:stream").Writable, isatty: (fd: number) => boolean;
export default tty;
//# sourceMappingURL=tty.d.ts.map