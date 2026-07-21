/* Minimal pwd.h overlay for wasi-libc. Backed by wasi-shim.c's static
 * single-user table (uid 0 -> "user"). Maintained by Claude, as-is. */
#ifndef _PWD_H
#define _PWD_H
#include <sys/types.h>
struct passwd {
  char *pw_name; char *pw_passwd;
  uid_t pw_uid; gid_t pw_gid;
  char *pw_gecos; char *pw_dir; char *pw_shell;
};
struct passwd *getpwuid(uid_t uid);
struct passwd *getpwnam(const char *name);
int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result);
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result);
struct passwd *getpwent(void);
void setpwent(void);
void endpwent(void);
#endif
