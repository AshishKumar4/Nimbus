/**
 * Not preview1's: what a host answers a read or write it gave up waiting on
 * (a suspended wasm stack outliving its bound never resumes), to an image
 * whose libc asks again (wasm/nimbus-libc/nimbus-restart.{h,c}), as Linux
 * restarts a call its ERESTARTSYS interrupted. Only to such an image
 * (WasiMakeImportsOptions.restartsWaits); any other is answered EINTR, and a
 * signal is EINTR to both.
 */
export const NIMBUS_ERESTART = 512;
/** The import module of the Nimbus filesystem extension ({@link NimbusFsImports}). */
export const NIMBUS_FS_MODULE = 'nimbus_fs';
/**
 * Bytes of the extension's stat: preview1's filestat (64 bytes, its layout:
 * dev, ino, filetype and padding, nlink, size, atim, mtim, ctim), then
 * st_mode (type and permission bits), uid and gid as u32, and four bytes of
 * zero. Aligned to 8.
 */
export const NIMBUS_STAT_SIZE = 80;
