/*
 * What a WASI program's libc needs of Nimbus that WASI preview1 does not
 * give: a file's mode and owner, chmod, and the credential the process runs
 * as. One implementation (nimbus-fs.c) over the host's extension imports
 * (nimbus_fs: core runtime/wasi/types.ts NimbusFsImports; nimbus_proc ids),
 * linked into each image built here: git (wasm/git) and CPython
 * (wasm/python). An image's force-included compat header maps the libc names
 * onto these (stat to nimbus_stat, and so on); a program that is not rebuilt
 * keeps preview1's answers.
 */
#ifndef NIMBUS_FS_H
#define NIMBUS_FS_H
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>

int nimbus_stat(const char *path, struct stat *st);
int nimbus_lstat(const char *path, struct stat *st);
int nimbus_fstat(int fd, struct stat *st);
/* AT_FDCWD or a directory descriptor; flags AT_SYMLINK_NOFOLLOW. */
int nimbus_fstatat(int dirfd, const char *path, struct stat *st, int flags);
int nimbus_chmod(const char *path, mode_t mode);
int nimbus_fchmod(int fd, mode_t mode);
/* AT_SYMLINK_NOFOLLOW is ENOTSUP, as Linux has no lchmod. */
int nimbus_fchmodat(int dirfd, const char *path, mode_t mode, int flags);
/*
 * open(2): a file it creates (O_CREAT with O_EXCL, so certainly new) with
 * execute bits in `mode` gets them, which preview1's create cannot carry:
 * execute wherever the umask let read through.
 */
int nimbus_open(const char *path, int flags, ...);

/* getuid(2) and the rest: the session's credential for this process. */
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);

#endif
