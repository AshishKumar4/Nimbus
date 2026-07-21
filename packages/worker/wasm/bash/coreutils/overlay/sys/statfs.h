/* Minimal sys/statfs.h overlay mapping onto wasi-libc's statvfs. As-is. */
#ifndef _SYS_STATFS_H
#define _SYS_STATFS_H
#include <sys/statvfs.h>
struct statfs {
  unsigned long f_type, f_bsize;
  unsigned long long f_blocks, f_bfree, f_bavail, f_files, f_ffree;
  unsigned long f_fsid, f_namelen, f_frsize, f_flags, f_spare[4];
};
int statfs(const char *path, struct statfs *buf);
int fstatfs(int fd, struct statfs *buf);
#endif
