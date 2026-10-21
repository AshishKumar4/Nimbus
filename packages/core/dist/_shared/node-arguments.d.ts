/**
 * node-arguments.ts — Node's argument validators (lib/internal/validators.js
 * and lib/internal/fs/utils.js, v22.23.4) that both Node fronts take: the
 * shell's node imports them, and scripts/bundle-facet-workers.mjs compiles
 * them into the guest's shims (NODE_ARGUMENTS_PREAMBLE), beside node-error.ts,
 * whose errors they throw.
 */
/** Linux's open(2) bits, as fs.constants has them. */
export declare const O_RDONLY = 0;
export declare const O_WRONLY = 1;
export declare const O_RDWR = 2;
export declare const O_ACCMODE = 3;
export declare const O_CREAT = 64;
export declare const O_EXCL = 128;
export declare const O_TRUNC = 512;
export declare const O_APPEND = 1024;
export declare const O_DIRECTORY = 65536;
export declare const O_NOFOLLOW = 131072;
export declare const O_SYNC = 1052672;
/** validateInt32: an integer from `min` to `max`, by default an int32. */
export declare function validateInt32(value: unknown, name: string, min?: number, max?: number): number;
/** validateUint32: an integer from 0 (from 1 when `positive`) to 2 ** 32 - 1. */
export declare function validateUint32(value: unknown, name: string, positive?: boolean): number;
/**
 * A uid or gid as Node's chown reads it (an integer from -1 to 2 ** 32 - 1):
 * -1, and 2 ** 32 - 1, which Node's binding converts to the same uid_t, keep
 * the file's (null).
 */
export declare function nodeOwnerId(value: unknown, name: string): number | null;
/** stringToFlags: an open's flags, a flag string from Node's table or an int32 of bits; none is 'r'. */
export declare function stringToFlags(flags: unknown, name?: string): number;
/** parseFileMode: a mode, an octal string of digits alone or a uint32; none is `def`. */
export declare function parseFileMode(value: unknown, name: string, def?: number): number;
//# sourceMappingURL=node-arguments.d.ts.map