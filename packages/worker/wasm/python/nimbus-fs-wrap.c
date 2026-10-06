/* nimbus-fs-wrap.c: CPython's calls for a file's status, mode and access, onto the
 * shared Nimbus libc shim (wasm/nimbus-libc/nimbus-fs.c), so os.stat reports
 * st_mode, st_uid and st_gid and os.chmod changes the session's mode, as git
 * built here does. wasi-libc defines these names itself (stat and the rest
 * from preview1's filestat, which has no mode; chmod as a stub), so the
 * reactor link wraps them (-Wl,--wrap=stat and so on, build-python.sh
 * link_reactor) rather than redefining them. */

#include <sys/stat.h>
#include "nimbus-fs.h"

int __wrap_stat(const char *path, struct stat *st);
int __wrap_lstat(const char *path, struct stat *st);
int __wrap_fstat(int fd, struct stat *st);
int __wrap_fstatat(int dirfd, const char *path, struct stat *st, int flags);
int __wrap_chmod(const char *path, mode_t mode);
int __wrap_fchmod(int fd, mode_t mode);
int __wrap_fchmodat(int dirfd, const char *path, mode_t mode, int flags);
int __wrap_access(const char *path, int mode);
int __wrap_faccessat(int dirfd, const char *path, int mode, int flags);

int __wrap_stat(const char *path, struct stat *st) { return nimbus_stat(path, st); }
int __wrap_lstat(const char *path, struct stat *st) { return nimbus_lstat(path, st); }
int __wrap_fstat(int fd, struct stat *st) { return nimbus_fstat(fd, st); }
int __wrap_fstatat(int dirfd, const char *path, struct stat *st, int flags) { return nimbus_fstatat(dirfd, path, st, flags); }
int __wrap_chmod(const char *path, mode_t mode) { return nimbus_chmod(path, mode); }
int __wrap_fchmod(int fd, mode_t mode) { return nimbus_fchmod(fd, mode); }
int __wrap_fchmodat(int dirfd, const char *path, mode_t mode, int flags) { return nimbus_fchmodat(dirfd, path, mode, flags); }
int __wrap_access(const char *path, int mode) { return nimbus_access(path, mode); }
int __wrap_faccessat(int dirfd, const char *path, int mode, int flags) { return nimbus_faccessat(dirfd, path, mode, flags); }
