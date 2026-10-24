/*
 * What jq needs of Nimbus that WASI preview1 does not give: a file's mode
 * and owner (its module search and input files), and access(2) as the
 * session's credential may: the shared Nimbus libc shim (wasm/nimbus-libc).
 */
#ifndef JQ_WASI_COMPAT_H
#define JQ_WASI_COMPAT_H
#include "nimbus-fs.h"
#define stat(path, buf) nimbus_stat(path, buf)
#define lstat nimbus_lstat
#define fstat nimbus_fstat
#define access nimbus_access
#endif
