/* Declarations for the wasi-libc gaps nimbus-wasi-compat.c and nimbus-libc's
 * nimbus-fs.c (the identity calls: the session's credential) fill. Force-included
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
#else
/* open(2) is nimbus-libc's (nimbus-fs.h): it makes a file with the mode asked
 * for, under the live umask, which preview1 cannot carry. Mapped by name, as
 * git's compat header maps it, with no header in scope; C only, because C++'s
 * own headers name member functions open. */
int nimbus_open(const char *path, int flags, ...);
#define open(...) nimbus_open(__VA_ARGS__)
#endif
#endif /* NIMBUS_WASI_COMPAT_H */
