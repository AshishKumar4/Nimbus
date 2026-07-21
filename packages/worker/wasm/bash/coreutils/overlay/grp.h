/* Minimal grp.h overlay for wasi-libc. Backed by wasi-shim.c. As-is. */
#ifndef _GRP_H
#define _GRP_H
#include <sys/types.h>
struct group { char *gr_name; char *gr_passwd; gid_t gr_gid; char **gr_mem; };
struct group *getgrgid(gid_t gid);
struct group *getgrnam(const char *name);
int getgrnam_r(const char *name, struct group *grp, char *buf, size_t buflen, struct group **result);
int getgrgid_r(gid_t gid, struct group *grp, char *buf, size_t buflen, struct group **result);
struct group *getgrent(void);
void setgrent(void);
void endgrent(void);
int getgroups(int size, gid_t list[]);
#endif
