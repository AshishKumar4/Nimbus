import type { VFS } from '../kernel/vfs/index.js';
import { Readable, Writable } from './stream.js';
import { EventEmitter } from './events.js';
interface Dirent {
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
interface NodeStat {
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
interface NodeError extends Error {
    code: string;
    errno: number;
    syscall: string;
    path: string;
}
type Callback<T> = (err: NodeError | null, result?: T) => void;
export declare function createFs(vfs: VFS, cwd: string): {
    readFileSync: (path: string | URL, options?: string | {
        encoding?: string;
        flag?: string;
    }) => string | Uint8Array;
    writeFileSync: (path: string | URL, data: string | Uint8Array, _options?: string | {
        encoding?: string;
    }) => void;
    appendFileSync: (path: string | URL, data: string | Uint8Array) => void;
    existsSync: (path: string | URL) => boolean;
    statSync: (path: string | URL) => NodeStat;
    lstatSync: (path: string | URL) => NodeStat;
    mkdirSync: (path: string | URL, options?: {
        recursive?: boolean;
        mode?: number;
    } | number) => void;
    readdirSync: (path: string | URL, options?: {
        encoding?: string;
        withFileTypes?: boolean;
    }) => string[] | Dirent[];
    unlinkSync: (path: string | URL) => void;
    rmdirSync: (path: string | URL, options?: {
        recursive?: boolean;
    }) => void;
    renameSync: (oldPath: string | URL, newPath: string | URL) => void;
    copyFileSync: (src: string | URL, dest: string | URL) => void;
    chmodSync: (path: string | URL, mode: number) => void;
    chownSync: (_path: string | URL, _uid: number, _gid: number) => void;
    accessSync: (path: string | URL, _mode?: number) => void;
    realpathSync: ((path: string | URL) => string) & {
        native: (path: string | URL) => string;
    };
    truncateSync: (path: string | URL, len?: number) => void;
    openSync: (path: string | URL, flags?: string | number, _mode?: number) => number;
    closeSync: (fd: number) => void;
    readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => number;
    writeSync: (fd: number, bufferOrString: Uint8Array | string, offsetOrPosition?: number, lengthOrEncoding?: number | string, position?: number | null) => number;
    fstatSync: (fd: number) => NodeStat;
    ftruncateSync: (fd: number, len?: number) => void;
    fsyncSync: (_fd: number) => void;
    fdatasyncSync: (_fd: number) => void;
    symlinkSync: (_target: string, _path: string, _type?: string) => void;
    linkSync: (_existingPath: string, _newPath: string) => void;
    readlinkSync: (path: string | URL) => string;
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
    rename: (oldPath: string | URL, newPath: string | URL, cb: Callback<void>) => void;
    access: (path: string | URL, modeOrCb: number | Callback<void>, cb?: Callback<void>) => void;
    exists: (path: string | URL, cb: (exists: boolean) => void) => void;
    open: (path: string | URL, flagsOrCb: string | number | Callback<number>, modeOrCb?: number | Callback<number>, cb?: Callback<number>) => void;
    close: (fd: number, cb: Callback<void>) => void;
    read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: Callback<number>) => void;
    fstat: (fd: number, cb: Callback<NodeStat>) => void;
    realpath: ((path: string | URL, optOrCb: unknown, cb?: Callback<string>) => void) & {
        native: (path: string | URL, optOrCb: unknown, cb?: Callback<string>) => void;
    };
    createReadStream: (path: string | URL, options?: {
        encoding?: string;
        start?: number;
        end?: number;
        highWaterMark?: number;
    }) => Readable;
    createWriteStream: (path: string | URL, options?: {
        flags?: string;
        encoding?: string;
    }) => Writable;
    watch: (filename: string | URL, optionsOrListener?: {
        persistent?: boolean;
        recursive?: boolean;
        encoding?: string;
    } | ((eventType: string, filename: string) => void), listener?: (eventType: string, filename: string) => void) => EventEmitter;
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
        access: (path: string | URL, mode?: number) => Promise<void>;
        realpath: (path: string | URL) => Promise<string>;
        truncate: (path: string | URL, len?: number) => Promise<void>;
        chmod: (path: string | URL, mode: number) => Promise<void>;
        chown: (_path: string | URL, _uid: number, _gid: number) => Promise<void>;
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
            truncate: (len?: number) => Promise<void>;
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
        O_TRUNC: number;
        O_APPEND: number;
        COPYFILE_EXCL: number;
        COPYFILE_FICLONE: number;
        COPYFILE_FICLONE_FORCE: number;
    };
};
export {};
//# sourceMappingURL=fs.d.ts.map