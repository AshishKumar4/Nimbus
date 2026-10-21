import type { SessionDirectoryEntry, SessionFileStat, SessionFollowOptions, SessionMkdirOptions } from '../runtime/session-protocol.js';
import type { NodeFiles } from './faces.js';
export type { FilesFace, NodeFaces, NodeFiles, NodeFilesystem, NodeWatch } from './faces.js';
export { createNodeFs } from './fs.js';
/** `fs` and `fs/promises` over `files`, relative paths taken from `cwd`. */
export declare function createNodeCompat({ files }: {
    files: NodeFiles;
}, { cwd }: {
    cwd: string;
}): {
    fs: {
        readFileSync: (path: string | URL | number, options?: string | {
            encoding?: string;
            flag?: string;
        }) => string | Uint8Array<ArrayBufferLike>;
        writeFileSync: (path: string | URL, data: string | Uint8Array, _options?: string | {
            encoding?: string;
        }) => void;
        appendFileSync: (path: string | URL, data: string | Uint8Array) => void;
        existsSync: (path: string | URL) => boolean;
        statSync: (path: string | URL) => import("./fs.js").NodeStat;
        lstatSync: (path: string | URL) => import("./fs.js").NodeStat;
        mkdirSync: (path: string | URL, options?: {
            recursive?: boolean;
            mode?: number | string | null;
        } | number | string | null) => void;
        readdirSync: (path: string | URL, options?: {
            encoding?: string;
            withFileTypes?: boolean;
        }) => string[] | import("./fs.js").Dirent[];
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
        fstatSync: (fd: number) => import("./fs.js").NodeStat;
        ftruncateSync: (fd: number, len?: number | null) => void;
        fsyncSync: (fd: number) => void;
        fdatasyncSync: (fd: number) => void;
        symlinkSync: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, _type?: string | null) => void;
        linkSync: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array) => void;
        readlinkSync: (path: string | URL | Uint8Array, options?: string | {
            encoding?: string | null;
        } | null) => string | import("node:buffer").Buffer;
        readFile: (path: string | URL, optionsOrCb: string | {
            encoding?: string;
        } | ((err: Error | null, result?: string | Uint8Array<ArrayBufferLike> | undefined) => void), cb?: (err: Error | null, result?: string | Uint8Array<ArrayBufferLike> | undefined) => void) => void;
        writeFile: (path: string | URL, data: string | Uint8Array, optionsOrCb: string | {
            encoding?: string;
        } | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        stat: (path: string | URL, cb: (err: Error | null, result?: import("./fs.js").NodeStat | undefined) => void) => void;
        lstat: (path: string | URL, cb: (err: Error | null, result?: import("./fs.js").NodeStat | undefined) => void) => void;
        mkdir: (path: string | URL, optionsOrCb: {
            recursive?: boolean;
        } | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        readdir: (path: string | URL, optionsOrCb: {
            encoding?: string;
            withFileTypes?: boolean;
        } | ((err: Error | null, result?: string[] | import("./fs.js").Dirent[] | undefined) => void), cb?: (err: Error | null, result?: string[] | import("./fs.js").Dirent[] | undefined) => void) => void;
        unlink: (path: string | URL, cb: (err: Error | null, result?: void | undefined) => void) => void;
        rm: (path: string | URL, optionsOrCb: {
            recursive?: boolean;
            force?: boolean;
        } | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        rename: (oldPath: string | URL, newPath: string | URL, cb: (err: Error | null, result?: void | undefined) => void) => void;
        access: (path: string | URL, modeOrCb: number | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        exists: (path: string | URL, cb: (exists: boolean) => void) => void;
        symlink: (target: string | URL | Uint8Array, path: string | URL | Uint8Array, ...rest: Array<string | null | undefined | ((err: Error | null, result?: void | undefined) => void)>) => void;
        link: (existingPath: string | URL | Uint8Array, newPath: string | URL | Uint8Array, cb?: (err: Error | null, result?: void | undefined) => void) => void;
        readlink: (path: string | URL | Uint8Array, optionsOrCb: string | {
            encoding?: string | null;
        } | null | undefined | ((err: Error | null, result?: string | import("node:buffer").Buffer | undefined) => void), cb?: (err: Error | null, result?: string | import("node:buffer").Buffer | undefined) => void) => void;
        truncate: (path: string | URL | Uint8Array | number, lenOrCb?: number | null | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        ftruncate: (fd: number, lenOrCb?: number | null | ((err: Error | null, result?: void | undefined) => void), cb?: (err: Error | null, result?: void | undefined) => void) => void;
        open: (path: string | URL, flagsOrCb: string | number | ((err: Error | null, result?: number | undefined) => void), modeOrCb?: number | ((err: Error | null, result?: number | undefined) => void), cb?: (err: Error | null, result?: number | undefined) => void) => void;
        close: (fd: number, cb: (err: Error | null, result?: void | undefined) => void) => void;
        read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: (err: Error | null, bytesRead?: number, buffer?: Uint8Array) => void) => void;
        write: (fd: number, data: Uint8Array | string, ...rest: (number | string | null | undefined | ((err: Error | null, written?: number, data?: Uint8Array | string) => void))[]) => void;
        fsync: (fd: number, cb: (err: Error | null, result?: void | undefined) => void) => void;
        fstat: (fd: number, cb: (err: Error | null, result?: import("./fs.js").NodeStat | undefined) => void) => void;
        chown: (path: string | URL, uid: number, gid: number, cb: (err: Error | null, result?: void | undefined) => void) => void;
        lchown: (path: string | URL, uid: number, gid: number, cb: (err: Error | null, result?: void | undefined) => void) => void;
        fchown: (fd: number, uid: number, gid: number, cb: (err: Error | null, result?: void | undefined) => void) => void;
        realpath: ((path: string | URL, optOrCb: (string | {
            encoding?: string | null;
        } | null | undefined) | ((err: Error | null, result?: string | undefined) => void), cb?: (err: Error | null, result?: string | undefined) => void) => void) & {
            native: (path: string | URL, optOrCb: (string | {
                encoding?: string | null;
            } | null | undefined) | ((err: Error | null, result?: string | undefined) => void), cb?: (err: Error | null, result?: string | undefined) => void) => void;
        };
        ReadStream: {
            new (path: string | URL | null | undefined, options?: string | import("./fs.js").StreamOptions): {
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
            new (path: string | URL | null | undefined, options?: string | import("./fs.js").StreamOptions): {
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
        createReadStream: (path: string | URL, options?: string | import("./fs.js").StreamOptions) => {
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
        createWriteStream: (path: string | URL, options?: string | import("./fs.js").StreamOptions) => {
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
        watch: (filename: string | URL, optionsOrListener?: import("./fs.js").WatchOptions | string | ((eventType: string, filename: string | import("node:buffer").Buffer) => void), listener?: (eventType: string, filename: string | import("node:buffer").Buffer) => void) => import("./fs.js").FSWatcher;
        promises: {
            readFile: (path: string | URL, options?: string | {
                encoding?: string;
            }) => Promise<string | Uint8Array<ArrayBufferLike>>;
            writeFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
            appendFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
            stat: (path: string | URL) => Promise<import("./fs.js").NodeStat>;
            lstat: (path: string | URL) => Promise<import("./fs.js").NodeStat>;
            mkdir: (path: string | URL, options?: {
                recursive?: boolean;
            }) => Promise<void>;
            readdir: (path: string | URL, options?: {
                encoding?: string;
                withFileTypes?: boolean;
            }) => Promise<string[] | import("./fs.js").Dirent[]>;
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
            } | null) => Promise<string | import("node:buffer").Buffer>;
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
                stat: () => Promise<import("./fs.js").NodeStat>;
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
    fsPromises: {
        readFile: (path: string | URL, options?: string | {
            encoding?: string;
        }) => Promise<string | Uint8Array<ArrayBufferLike>>;
        writeFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
        appendFile: (path: string | URL, data: string | Uint8Array) => Promise<void>;
        stat: (path: string | URL) => Promise<import("./fs.js").NodeStat>;
        lstat: (path: string | URL) => Promise<import("./fs.js").NodeStat>;
        mkdir: (path: string | URL, options?: {
            recursive?: boolean;
        }) => Promise<void>;
        readdir: (path: string | URL, options?: {
            encoding?: string;
            withFileTypes?: boolean;
        }) => Promise<string[] | import("./fs.js").Dirent[]>;
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
        } | null) => Promise<string | import("node:buffer").Buffer>;
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
            stat: () => Promise<import("./fs.js").NodeStat>;
            chown: (uid: number, gid: number) => Promise<void>;
            truncate: (len?: number | null) => Promise<void>;
        }>;
        rm: (path: string | URL, options?: {
            recursive?: boolean;
            force?: boolean;
        }) => Promise<void>;
    };
};
/** A Nimbus session's file calls, as its client (the SDK's `sandbox.files`) makes them. */
export interface SessionFilesClient {
    read(path: string): Promise<string | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
    write(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<SessionFileStat | null>;
    lstat(path: string): Promise<SessionFileStat | null>;
    readlink(path: string): Promise<string | null>;
    rename(from: string, to: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    list(path?: string): Promise<SessionDirectoryEntry[]>;
    mkdir(path: string, options?: SessionMkdirOptions): Promise<void>;
    exists(path: string): Promise<boolean>;
    delete(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    appendFile(path: string, content: string | Uint8Array): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    realpath(path: string): Promise<string>;
    truncate(path: string, size: number): Promise<void>;
    chown(path: string, uid: number | null, gid: number | null, options?: SessionFollowOptions): Promise<void>;
}
/** Node's `fs` calls over a Nimbus session's (`sandbox.files`); its absences are Node's ENOENT. */
export declare function nodeFacesOf(session: {
    files: SessionFilesClient;
}): {
    files: NodeFiles;
};
//# sourceMappingURL=index.d.ts.map