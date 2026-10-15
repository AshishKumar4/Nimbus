/**
 * Node's error for a write the output refused: a pipe's as its stream reports
 * it (`write EPIPE`), a file's as fs does (`ENOSPC: no space left on device,
 * write`), each with its fields in Node's order.
 */
export declare function writeFailure(code: string, pipe: boolean): Error;
/** What Node prints of an uncaught `reason`: an error's stack, and its own fields after it (`{ errno: -32, code: 'EPIPE', … }`), each as `inspect` shows it. */
export declare function uncaughtReport(reason: unknown, inspect: (value: unknown) => string): string;
//# sourceMappingURL=output-failure.d.ts.map