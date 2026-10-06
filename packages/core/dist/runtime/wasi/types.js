/** The import module of the Nimbus filesystem extension ({@link NimbusFsImports}). */
export const NIMBUS_FS_MODULE = 'nimbus_fs';
/**
 * Bytes of the extension's stat: preview1's filestat (64 bytes, its layout:
 * dev, ino, filetype and padding, nlink, size, atim, mtim, ctim), then
 * st_mode (type and permission bits), uid and gid as u32, and four bytes of
 * zero. Aligned to 8.
 */
export const NIMBUS_STAT_SIZE = 80;
