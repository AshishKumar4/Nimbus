/* grp.h for wasi-libc, which ships none: the session's groups, read from
 * /etc/group at each call (nimbus-libc/nimbus-accounts.c). */
#ifndef _GRP_H
#define _GRP_H
#include <stddef.h>
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
