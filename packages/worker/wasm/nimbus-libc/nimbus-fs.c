/*
 * nimbus-fs.c: file modes, owners, chmod and the process's credential for a
 * WASI program, over the Nimbus extension imports. See nimbus-fs.h.
 */

/* An image's compat header maps the libc names onto ours; here they are libc's. */
#undef stat
#undef lstat
#undef fstat
#undef fstatat
#undef chmod
#undef fchmod
#undef fchmodat
#undef open

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wasi/api.h>
#include <wasi/libc-find-relpath.h>
#include "nimbus-fs.h"

#define NIMBUS_FS_IMPORT(name) __attribute__((import_module("nimbus_fs"), import_name(name)))
#define NIMBUS_PROC_IMPORT(name) __attribute__((import_module("nimbus_proc"), import_name(name)))

/* preview1's filestat, then st_mode, uid and gid (core runtime/wasi/types.ts NIMBUS_STAT_SIZE). */
struct nimbus_stat_record {
  __wasi_filestat_t filestat;
  uint32_t mode, uid, gid, zero;
};
_Static_assert(sizeof(struct nimbus_stat_record) == 80, "the host's stat is 80 bytes");

NIMBUS_FS_IMPORT("path_stat") int __nimbus_path_stat(int fd, int lookupflags, const char *path, size_t len, struct nimbus_stat_record *out);
NIMBUS_FS_IMPORT("fd_stat") int __nimbus_fd_stat(int fd, struct nimbus_stat_record *out);
NIMBUS_FS_IMPORT("path_chmod") int __nimbus_path_chmod(int fd, int lookupflags, const char *path, size_t len, uint32_t mode);
NIMBUS_FS_IMPORT("fd_chmod") int __nimbus_fd_chmod(int fd, uint32_t mode);
NIMBUS_PROC_IMPORT("ids") int __nimbus_ids(uint32_t *ids);

/* The imports answer 0 or a positive errno, as WASI calls do; wasi-libc's errno values are WASI's. */
static int answered(int error) {
  if (error) { errno = error; return -1; }
  return 0;
}

/* Present when the program changes directory (git does, for -C). */
int __wasilibc_find_relpath_alloc(const char *path, const char **abs, char **relative, size_t *relative_len, int can_realloc) __attribute__((__weak__));

/* The preopen `path` is beneath and the path relative to it, as wasi-libc's own path calls find them. */
static int beneath(const char *path, char **relative) {
  static char *buf = NULL;
  static size_t len = 0;
  const char *abs;
  if (__wasilibc_find_relpath_alloc) {
    int fd = __wasilibc_find_relpath_alloc(path, &abs, &buf, &len, 1);
    *relative = buf;
    return fd;
  }
  if (!buf) {
    buf = malloc(PATH_MAX);
    if (!buf) { errno = ENOMEM; return -1; }
    len = PATH_MAX;
  }
  *relative = buf;
  return __wasilibc_find_relpath(path, &abs, relative, len);
}

/* `path` against `dirfd` as the *at calls take it: the descriptor and the path the host resolves beneath it. */
static int at(int dirfd, const char *path, char **relative) {
  if (dirfd == AT_FDCWD || path[0] == '/') return beneath(path, relative);
  *relative = (char *)path;
  return dirfd;
}

static struct timespec from_ns(uint64_t ns) {
  return (struct timespec){ .tv_sec = (time_t)(ns / 1000000000ull), .tv_nsec = (long)(ns % 1000000000ull) };
}

static void to_stat(const struct nimbus_stat_record *in, struct stat *out) {
  memset(out, 0, sizeof *out);
  out->st_dev = in->filestat.dev;
  out->st_ino = in->filestat.ino;
  out->st_nlink = in->filestat.nlink;
  out->st_size = in->filestat.size;
  out->st_atim = from_ns(in->filestat.atim);
  out->st_mtim = from_ns(in->filestat.mtim);
  out->st_ctim = from_ns(in->filestat.ctim);
  out->st_mode = in->mode;
  out->st_uid = in->uid;
  out->st_gid = in->gid;
}

int nimbus_fstatat(int dirfd, const char *path, struct stat *st, int flags) {
  if (path[0] == '\0') { errno = ENOENT; return -1; }
  char *relative;
  int fd = at(dirfd, path, &relative);
  if (fd < 0) return -1;
  struct nimbus_stat_record record;
  int follow = (flags & AT_SYMLINK_NOFOLLOW) ? 0 : __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW;
  if (answered(__nimbus_path_stat(fd, follow, relative, strlen(relative), &record))) return -1;
  to_stat(&record, st);
  return 0;
}

int nimbus_stat(const char *path, struct stat *st) { return nimbus_fstatat(AT_FDCWD, path, st, 0); }
int nimbus_lstat(const char *path, struct stat *st) { return nimbus_fstatat(AT_FDCWD, path, st, AT_SYMLINK_NOFOLLOW); }

int nimbus_fstat(int fd, struct stat *st) {
  struct nimbus_stat_record record;
  if (answered(__nimbus_fd_stat(fd, &record))) return -1;
  to_stat(&record, st);
  return 0;
}

int nimbus_fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
  if (flags & AT_SYMLINK_NOFOLLOW) { errno = ENOTSUP; return -1; }
  char *relative;
  int fd = at(dirfd, path, &relative);
  if (fd < 0) return -1;
  return answered(__nimbus_path_chmod(fd, __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW, relative, strlen(relative), mode));
}

int nimbus_chmod(const char *path, mode_t mode) { return nimbus_fchmodat(AT_FDCWD, path, mode, 0); }
int nimbus_fchmod(int fd, mode_t mode) { return answered(__nimbus_fd_chmod(fd, mode)); }

int nimbus_open(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  int fd = open(path, flags, mode);
  if (fd < 0 || !(flags & O_CREAT) || !(flags & O_EXCL) || !(mode & 0111)) return fd;
  struct stat st;
  if (nimbus_fstat(fd, &st) == 0) {
    mode_t readable = st.st_mode & 0444;
    if (nimbus_fchmod(fd, (st.st_mode & 07777) | ((readable >> 2) & mode & 0111)) == 0) return fd;
  }
  int error = errno;
  close(fd);
  unlink(path);
  errno = error;
  return -1;
}

static uint32_t process_ids[2];
static int ids_known;
static void know_ids(void) {
  if (ids_known) return;
  uint32_t ids[2] = { 0, 0 };
  if (__nimbus_ids(ids) == 0) { process_ids[0] = ids[0]; process_ids[1] = ids[1]; }
  ids_known = 1;
}
uid_t getuid(void) { know_ids(); return process_ids[0]; }
uid_t geteuid(void) { know_ids(); return process_ids[0]; }
gid_t getgid(void) { know_ids(); return process_ids[1]; }
gid_t getegid(void) { know_ids(); return process_ids[1]; }
