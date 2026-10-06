#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <netinet/in.h>
#include <wasi/api.h>
#include <wasi/libc-find-relpath.h>
#include "git-wasi-compat.h"
/* The calls below are wasi-libc's own, not the names the compat header maps. */
#undef stat
#undef lstat
#undef fstat
#undef chmod
#undef fchmod
#undef open
#undef access

pid_t getppid(void) { return 1; }
pid_t getpgid(pid_t p) { (void)p; return 1; }
pid_t fork(void) { errno = ENOSYS; return -1; }
int execv(const char *p, char *const a[]) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execve(const char *p, char *const a[], char *const e[]) { (void)p; (void)a; (void)e; errno = ENOSYS; return -1; }
int execvp(const char *p, char *const a[]) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execl(const char *p, const char *a, ...) { (void)p; (void)a; errno = ENOSYS; return -1; }
int execlp(const char *p, const char *a, ...) { (void)p; (void)a; errno = ENOSYS; return -1; }
mode_t umask(mode_t m) { (void)m; return 022; }
unsigned alarm(unsigned s) { (void)s; return 0; }
char *getpass(const char *p) { (void)p; return NULL; }
pid_t tcgetpgrp(int f) { (void)f; errno = ENOTTY; return -1; }
int mkstemp(char *t) {
  size_t n = strlen(t);
  if (n < 6 || strcmp(t + n - 6, "XXXXXX")) { errno = EINVAL; return -1; }
  static const char abc[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (int tries = 0; tries < 100; tries++) {
    unsigned char r[6];
    if (getentropy(r, 6)) return -1;
    for (int i = 0; i < 6; i++) t[n - 6 + i] = abc[r[i] % 62];
    int fd = open(t, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  errno = EEXIST;
  return -1;
}
char *mkdtemp(char *t) {
  size_t n = strlen(t);
  if (n < 6 || strcmp(t + n - 6, "XXXXXX")) { errno = EINVAL; return NULL; }
  static const char abc[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (int tries = 0; tries < 100; tries++) {
    unsigned char r[6];
    if (getentropy(r, 6)) return NULL;
    for (int i = 0; i < 6; i++) t[n - 6 + i] = abc[r[i] % 62];
    if (!mkdir(t, 0700)) return t;
    if (errno != EEXIST) return NULL;
  }
  return NULL;
}
void flockfile(FILE *f) { (void)f; }
void funlockfile(FILE *f) { (void)f; }
int sigaction(int s, const struct sigaction *a, struct sigaction *o) {
  if (o) { memset(o, 0, sizeof *o); o->sa_handler = SIG_DFL; }
  if (a) signal(s, a->sa_handler);
  return 0;
}
int sigprocmask(int h, const sigset_t *s, sigset_t *o) { (void)h; (void)s; if (o) memset(o, 0, sizeof *o); return 0; }
int sigemptyset(sigset_t *s) { memset(s, 0, sizeof *s); return 0; }
int sigfillset(sigset_t *s) { memset(s, 0xff, sizeof *s); return 0; }
int sigaddset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
struct passwd;
struct passwd *getpwuid(uid_t u) { (void)u; return NULL; }
struct passwd *getpwnam(const char *n) { (void)n; return NULL; }
int tcgetattr(int f, void *t) { (void)f; (void)t; errno = ENOTTY; return -1; }
int tcsetattr(int f, int a, const void *t) { (void)f; (void)a; (void)t; errno = ENOTTY; return -1; }
struct servent *getservbyname(const char *n, const char *p) { (void)n; (void)p; return NULL; }
int h_errno;
const char *hstrerror(int e) { (void)e; return "host lookup is not available"; }
char *inet_ntoa(struct in_addr a) { (void)a; return (char *)"0.0.0.0"; }
int socket(int d, int t, int p) { (void)d; (void)t; (void)p; errno = ENOSYS; return -1; }
int connect(int f, const struct sockaddr *a, unsigned int l) { (void)f; (void)a; (void)l; errno = ENOSYS; return -1; }
int setsockopt(int f, int l, int o, const void *v, unsigned int n) { (void)f; (void)l; (void)o; (void)v; (void)n; errno = ENOSYS; return -1; }
struct hostent;
struct hostent *gethostbyname(const char *n) { (void)n; h_errno = 1; return NULL; }
int gethostname(char *n, size_t l) { if (l) { strncpy(n, "nimbus", l); n[l - 1] = 0; } return 0; }
