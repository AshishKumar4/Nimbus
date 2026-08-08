/* Declarations for the wasi-libc gaps nimbus-wasi-compat.c fills. Force-included
 * into every translation unit, so that third-party sources see them without
 * edits; the sysroot hides these behind __wasilibc_unmodified_upstream, which
 * cannot be defined selectively.
 *
 * It pulls in no system header. AC_CHECK_FUNCS probes a function by redeclaring
 * it as `char f();`, which fails to compile against a real prototype — so every
 * prototype this header drags into scope is a function configure will report as
 * missing. Including <sys/stat.h> for mode_t was enough to lose lstat, fstatat,
 * mkdirat, futimens and utimensat from the finished interpreter. The types come
 * from wasi-libc's own __NEED_ mechanism instead, which defines the typedef and
 * nothing else. */
#ifndef NIMBUS_WASI_COMPAT_H
#define NIMBUS_WASI_COMPAT_H

#define __NEED_mode_t
#define __NEED_uid_t
#define __NEED_gid_t
#include <bits/alltypes.h>

#ifdef __cplusplus
extern "C" {
#endif

uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
mode_t umask(mode_t);

#ifdef __cplusplus
}
#endif
#endif /* NIMBUS_WASI_COMPAT_H */
