/**
 * Node's `fs`, written once over the file faces (Kinu ask 67): each
 * operation is a generator (node-compat/drive.ts) whose body holds its
 * argument checks, paths, encodings and the shaping of Stats, Dirents and
 * errors, and yields each file call as a step. Its `*Sync` form answers
 * from the synchronous face; its callbacks and `fs.promises` from the
 * asynchronous one, or the synchronous one where there is no other. lifo's
 * Node runs it over its synchronous filesystem; a session client's
 * (createNodeCompat) over the session's asynchronous calls.
 */
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import type { NodeFaces } from './faces.js';
export interface FSWatcher extends EventEmitter {
    close(): void;
    ref(): this;
    unref(): this;
}
export interface WatchOptions {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: string;
}
type WatchListener = (eventType: string, filename: string | Buffer) => void;
export interface Dirent {
    name: string;
    path: string;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
    isBlockDevice: () => boolean;
    isCharacterDevice: () => boolean;
    isFIFO: () => boolean;
    isSocket: () => boolean;
}
export interface NodeStat {
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    uid: number;
    gid: number;
    rdev: number;
    size: number;
    blksize: number;
    blocks: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
    isBlockDevice: () => boolean;
    isCharacterDevice: () => boolean;
    isFIFO: () => boolean;
    isSocket: () => boolean;
}
type Callback<T> = (err: Error | null, result?: T) => void;
type ReadCallback = (err: Error | null, bytesRead?: number, buffer?: Uint8Array) => void;
type WriteCallback = (err: Error | null, written?: number, data?: Uint8Array | string) => void;
/** What Node's ReadStream and WriteStream take; `fs` is the filesystem they open, read, write and close through. */
export interface StreamOptions {
    fs?: object;
    flags?: string;
    encoding?: string;
    fd?: number;
    mode?: number;
    start?: number;
    end?: number;
    highWaterMark?: number;
    autoClose?: boolean;
    emitClose?: boolean;
    /** A WriteStream's: fsync before it closes. */
    flush?: boolean;
}
export interface NodeFsOptions {
    cwd: string;
    /**
     * fd 0 to its end, blocking until it ends, as a synchronous read of it
     * does in Node; what it returned is all fd 0 holds, so a second read finds
     * it at its end. Absent, fd 0 reads as empty.
     */
    stdin?: () => Uint8Array;
    /** Told when the program first reaches the engine's stream classes. */
    reachStreams?: () => void;
}
export declare function createNodeFs(faces: NodeFaces, { cwd, stdin, reachStreams }: NodeFsOptions): {
    readFileSync: (path: string | URL | number, options?: string | {
        encoding?: string;
        flag?: string;
    }) => string | Uint8Array<ArrayBufferLike>;
    writeFileSync: (path: string | URL, data: string | Uint8Array, _options?: string | {
        encoding?: string;
    }) => void;
    appendFileSync: (path: string | URL, data: string | Uint8Array) => void;
    existsSync: (path: string | URL) => boolean;
    statSync: (path: string | URL) => NodeStat;
    lstatSync: (path: string | URL) => NodeStat;
    mkdirSync: (path: string | URL, options?: {
        recursive?: boolean;
        mode?: number | string | null;
    } | number | string | null) => void;
    readdirSync: (path: string | URL, options?: {
        encoding?: string;
        withFileTypes?: boolean;
    }) => string[] | Dirent[];
    unlinkSync: (path: string | URL) => void;
    rmSync: (path: string | URL, options?: {
        recursive?: boolean;
        force?: boolean;
    }) => void;
    rmdirSync: (path: string | URL, options?: {
        recursive?: boolean;
    }) => void;
    renameSync: (oldPath: string | URL, newPath: string | URL) => void;
    copyFileSync: (src: string | URL, dest: string | URL) => void;
    chmodSync: (path: string | URL, mode: number | string) => void;
    chownSync: (path: string | URL, uid: number, gid: number) => void;
    lchownSync: (path: string | URL, uid: number, gid: number) => void;
    fchownSync: (fd: number, uid: number, gid: number) => void;
    accessSync: (path: string | URL, _mode?: number) => void;
    realpathSync: ((path: string | URL) => string) & {
        native: (path: string | URL) => string;
    };
    truncateSync: (path: string | URL | Uint8Array | number, len?: number | null) => void;
    openSync: (path: string | URL, flags?: string | number | null, mode?: number) => number;
    closeSync: (fd: number) => void;
    readSync: (fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => number;
    writeSync: (fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string, position?: number | null) => number;
    fstatSync: (fd: number) => NodeStat;
    ftruncateSync: (fd: number, len?: number | null) => void;
    fsyncSync: (fd: number) => void;
    fdatasyncSync: (fd: number) => void;
    symlinkSync: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null) => void;
    linkSync: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array) => void;
    readlinkSync: (path: string | URL | Uint8Array, options?: string | {
        encoding?: string | null;
    } | null) => string | Buffer;
    readFile: (path: string | URL, optionsOrCb: string | {
        encoding?: string;
    } | Callback<string | Uint8Array>, cb?: Callback<string | Uint8Array>) => void;
    writeFile: (path: string | URL, data: string | Uint8Array, optionsOrCb: string | {
        encoding?: string;
    } | Callback<void>, cb?: Callback<void>) => void;
    stat: (path: string | URL, cb: Callback<NodeStat>) => void;
    lstat: (path: string | URL, cb: Callback<NodeStat>) => void;
    mkdir: (path: string | URL, optionsOrCb: {
        recursive?: boolean;
    } | Callback<void>, cb?: Callback<void>) => void;
    readdir: (path: string | URL, optionsOrCb: {
        encoding?: string;
        withFileTypes?: boolean;
    } | Callback<string[] | Dirent[]>, cb?: Callback<string[] | Dirent[]>) => void;
    unlink: (path: string | URL, cb: Callback<void>) => void;
    rm: (path: string | URL, optionsOrCb: {
        recursive?: boolean;
        force?: boolean;
    } | Callback<void>, cb?: Callback<void>) => void;
    rename: (oldPath: string | URL, newPath: string | URL, cb: Callback<void>) => void;
    access: (path: string | URL, modeOrCb: number | Callback<void>, cb?: Callback<void>) => void;
    exists: (path: string | URL, cb: (exists: boolean) => void) => void;
    symlink: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, ...rest: Array<string | null | undefined | Callback<void>>) => void;
    link: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array, cb?: Callback<void>) => void;
    readlink: (path: string | URL | Uint8Array, optionsOrCb: string | {
        encoding?: string | null;
    } | null | undefined | Callback<string | Buffer>, cb?: Callback<string | Buffer>) => void;
    truncate: (path: string | URL | Uint8Array | number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>) => void;
    ftruncate: (fd: number, lenOrCb?: number | null | Callback<void>, cb?: Callback<void>) => void;
    open: (path: string | URL, flagsOrCb: string | number | Callback<number>, modeOrCb?: number | Callback<number>, cb?: Callback<number>) => void;
    close: (fd: number, cb: Callback<void>) => void;
    read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: ReadCallback) => void;
    write: (fd: number, data: Uint8Array | string, ...rest: (number | string | null | undefined | WriteCallback)[]) => void;
    fsync: (fd: number, cb: Callback<void>) => void;
    fstat: (fd: number, cb: Callback<NodeStat>) => void;
    chown: (path: string | URL, uid: number, gid: number, cb: Callback<void>) => void;
    lchown: (path: string | URL, uid: number, gid: number, cb: Callback<void>) => void;
    fchown: (fd: number, uid: number, gid: number, cb: Callback<void>) => void;
    realpath: ((path: string | URL, optOrCb: (string | {
        encoding?: string | null;
    } | null | undefined) | Callback<string>, cb?: Callback<string>) => void) & {
        native: (path: string | URL, optOrCb: (string | {
            encoding?: string | null;
        } | null | undefined) | Callback<string>, cb?: Callback<string>) => void;
    };
    ReadStream: {
        new (path: string | URL | null | undefined, options?: string | StreamOptions): {
            pipe(destination: import("node:stream").Writable, options?: import("node:stream").PipeOptions): import("node:stream").Writable;
            readonly readable: boolean;
            readonly readableEnded: boolean;
            readonly readableFlowing: boolean | null;
            readonly destroyed: boolean;
            readonly _readableState: {
                reading: boolean;
            };
            _read(size: number): void;
            push(chunk: Uint8Array | string | null, encoding?: string): boolean;
            pause(): /*elided*/ any;
            resume(): /*elided*/ any;
            setEncoding(encoding: string): /*elided*/ any;
            destroy(error?: Error): /*elided*/ any;
            on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeAllListeners(event?: string | symbol): /*elided*/ any;
            emit(event: string | symbol, ...args: unknown[]): boolean;
            listenerCount(event: string | symbol): number;
            listeners(event: string | symbol): import("node:events").Listener[];
            eventNames(): (string | symbol)[];
            setMaxListeners(n: number): /*elided*/ any;
            getMaxListeners(): number;
        };
    };
    WriteStream: {
        new (path: string | URL | null | undefined, options?: string | StreamOptions): {
            readonly writable: boolean;
            write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
            end(callback?: () => void): /*elided*/ any;
            destroy(error?: Error): /*elided*/ any;
            on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
            removeAllListeners(event?: string | symbol): /*elided*/ any;
            emit(event: string | symbol, ...args: unknown[]): boolean;
            listenerCount(event: string | symbol): number;
            listeners(event: string | symbol): import("node:events").Listener[];
            eventNames(): (string | symbol)[];
            setMaxListeners(n: number): /*elided*/ any;
            getMaxListeners(): number;
        };
    };
    createReadStream: (path: string | URL, options?: string | StreamOptions) => {
        pipe(destination: import("node:stream").Writable, options?: import("node:stream").PipeOptions): import("node:stream").Writable;
        readonly readable: boolean;
        readonly readableEnded: boolean;
        readonly readableFlowing: boolean | null;
        readonly destroyed: boolean;
        readonly _readableState: {
            reading: boolean;
        };
        _read(size: number): void;
        push(chunk: Uint8Array | string | null, encoding?: string): boolean;
        pause(): /*elided*/ any;
        resume(): /*elided*/ any;
        setEncoding(encoding: string): /*elided*/ any;
        destroy(error?: Error): /*elided*/ any;
        on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        removeAllListeners(event?: string | symbol): /*elided*/ any;
        emit(event: string | symbol, ...args: unknown[]): boolean;
        listenerCount(event: string | symbol): number;
        listeners(event: string | symbol): import("node:events").Listener[];
        eventNames(): (string | symbol)[];
        setMaxListeners(n: number): /*elided*/ any;
        getMaxListeners(): number;
    };
    createWriteStream: (path: string | URL, options?: string | StreamOptions) => {
        readonly writable: boolean;
        write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
        end(callback?: () => void): /*elided*/ any;
        destroy(error?: Error): /*elided*/ any;
        on(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        addListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        once(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        prependListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        off(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        removeListener(event: string | symbol, listener: import("node:events").Listener): /*elided*/ any;
        removeAllListeners(event?: string | symbol): /*elided*/ any;
        emit(event: string | symbol, ...args: unknown[]): boolean;
        listenerCount(event: string | symbol): number;
        listeners(event: string | symbol): import("node:events").Listener[];
        eventNames(): (string | symbol)[];
        setMaxListeners(n: number): /*elided*/ any;
        getMaxListeners(): number;
    };
    watch: (filename: string | URL, optionsOrListener?: WatchOptions | string | WatchListener, listener?: WatchListener) => FSWatcher;
    promises: {
        readFile: (path: string | URL, options?: string | {
            encoding?: string;
        }) => Promise<string | Uint8Array<ArrayBufferLike>>;
        writeFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
        appendFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
        stat: (path: string | URL) => Promise<NodeStat>;
        lstat: (path: string | URL) => Promise<NodeStat>;
        mkdir: (path: string | URL, options?: {
            recursive?: boolean;
        }) => Promise<void>;
        readdir: (path: string | URL, options?: {
            encoding?: string;
            withFileTypes?: boolean;
        }) => Promise<string[] | Dirent[]>;
        unlink: (path: string | URL) => Promise<void>;
        rmdir: (path: string | URL, options?: {
            recursive?: boolean;
        }) => Promise<void>;
        rename: (oldPath: string | URL, newPath: string | URL) => Promise<void>;
        copyFile: (src: string | URL, dest: string | URL) => Promise<void>;
        access: (path: string | URL, _mode?: number) => Promise<void>;
        realpath: (path: string | URL) => Promise<string>;
        truncate: (path: string | URL | Uint8Array, len?: number | null) => Promise<void>;
        symlink: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null) => Promise<void>;
        link: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array) => Promise<void>;
        readlink: (path: string | URL | Uint8Array, options?: string | {
            encoding?: string | null;
        } | null) => Promise<string | Buffer>;
        chmod: (path: string | URL, mode: number | string) => Promise<void>;
        chown: (path: string | URL, uid: number, gid: number) => Promise<void>;
        lchown: (path: string | URL, uid: number, gid: number) => Promise<void>;
        open: (path: string | URL, flags?: string | number, mode?: number) => Promise<{
            fd: number;
            close: () => Promise<void>;
            read: (buffer: Uint8Array, offset: number, length: number, position: number | null) => Promise<{
                bytesRead: number;
                buffer: Uint8Array<ArrayBufferLike>;
            }>;
            write: (data: Uint8Array | string) => Promise<{
                bytesWritten: number;
            }>;
            stat: () => Promise<NodeStat>;
            chown: (uid: number, gid: number) => Promise<void>;
            truncate: (len?: number | null) => Promise<void>;
        }>;
        rm: (path: string | URL, options?: {
            recursive?: boolean;
            force?: boolean;
        }) => Promise<void>;
    };
    constants: {
        F_OK: number;
        R_OK: number;
        W_OK: number;
        X_OK: number;
        O_RDONLY: number;
        O_WRONLY: number;
        O_RDWR: number;
        O_CREAT: number;
        O_EXCL: number;
        O_TRUNC: number;
        O_APPEND: number;
        O_DIRECTORY: number;
        O_NOFOLLOW: number;
        O_SYNC: number;
        COPYFILE_EXCL: number;
        COPYFILE_FICLONE: number;
        COPYFILE_FICLONE_FORCE: number;
    };
};
export {};
//# sourceMappingURL=fs.d.ts.map