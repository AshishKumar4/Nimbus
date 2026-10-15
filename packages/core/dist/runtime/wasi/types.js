/**
 * Not preview1's: what a host answers a read or write it gave up waiting on
 * (a suspended wasm stack outliving its bound never resumes), to an image
 * whose libc asks again (wasm/nimbus-libc/nimbus-restart.{h,c}), as Linux
 * restarts a call its ERESTARTSYS interrupted. Only to such an image
 * (WasiMakeImportsOptions.restartsWaits); any other is answered EINTR, and a
 * signal is EINTR to both.
 */
export const NIMBUS_ERESTART = 512;
/**
 * Not preview1's either: what a host answers a wait that a signal sent to
 * the process interrupted, to an image that takes its signals
 * (WasiMakeImportsOptions.takesSignals): NIMBUS_ESIGNAL plus the signal's
 * number. Its libc raises the signal, so that the program's own handling
 * runs (or the default ends it, 128 + the number), then the call answers
 * EINTR (wasm/nimbus-libc/nimbus-signal.c), as Linux runs a handler before
 * the call it interrupted returns.
 */
export const NIMBUS_ESIGNAL = 1024;
/** The signals a host sends such an image, numbered as wasi-libc and Linux number them, and the errno each is answered with. */
export const NIMBUS_SIGNAL_ERRNOS = {
    SIGHUP: 1025, SIGINT: 1026, SIGQUIT: 1027, SIGUSR1: 1034, SIGUSR2: 1036, SIGPIPE: 1037, SIGALRM: 1038, SIGTERM: 1039,
};
/** The import module of the Nimbus filesystem extension ({@link NimbusFsImports}). */
export const NIMBUS_FS_MODULE = 'nimbus_fs';
/**
 * Bytes of the extension's stat: preview1's filestat (64 bytes, its layout:
 * dev, ino, filetype and padding, nlink, size, atim, mtim, ctim), then
 * st_mode (type and permission bits), uid and gid as u32, and four bytes of
 * zero. Aligned to 8.
 */
export const NIMBUS_STAT_SIZE = 80;
