/* Minimal mntent.h overlay for wasi-libc. wasi-shim.c serves one synthetic
 * rootfs entry so `df` reports the VFS root. Maintained by Claude, as-is. */
#ifndef _MNTENT_H
#define _MNTENT_H
#include <stdio.h>
#define MOUNTED "/etc/mtab"
#define MNTTYPE_IGNORE "ignore"
struct mntent {
  char *mnt_fsname; char *mnt_dir; char *mnt_type;
  char *mnt_opts; int mnt_freq; int mnt_passno;
};
FILE *setmntent(const char *filename, const char *type);
struct mntent *getmntent(FILE *stream);
struct mntent *getmntent_r(FILE *stream, struct mntent *result, char *buffer, int bufsize);
int endmntent(FILE *stream);
char *hasmntopt(const struct mntent *mnt, const char *opt);
#endif
