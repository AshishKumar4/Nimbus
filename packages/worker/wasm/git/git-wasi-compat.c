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
/* This file defines what those name; the calls below are wasi-libc's own. */
#undef stat
#undef lstat
#undef fstat
#undef chmod
#undef fchmod
#undef open

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

/* ---- processes and pipes: the host's (nimbus_proc imports) ---- */

#define NIMBUS_PROC_IMPORT(name) __attribute__((import_module("nimbus_proc"), import_name(name)))
NIMBUS_PROC_IMPORT("pipe") int __nimbus_pipe(int *fds);
NIMBUS_PROC_IMPORT("dup") int __nimbus_dup(int fd, int *out);
NIMBUS_PROC_IMPORT("dup2") int __nimbus_dup2(int from, int to);
NIMBUS_PROC_IMPORT("spawn") int __nimbus_spawn(const char *argv, size_t argv_len, const char *env, size_t env_len,
    const char *dir, size_t dir_len, int fdin, int fdout, int fderr, int *pid);
NIMBUS_PROC_IMPORT("start") int __nimbus_start(int pid);
NIMBUS_PROC_IMPORT("wait") int __nimbus_wait(int pid, int options, int *status, int *waited);
NIMBUS_PROC_IMPORT("kill") int __nimbus_kill(int pid, int signal);

/* The imports answer 0 or a positive errno, as WASI calls do. */
static int nimbus_result(int error, int value) {
  if (error) { errno = error; return -1; }
  return value;
}

/* The credential the session runs this process as: git's repository ownership check compares it with a stat's st_uid. */
NIMBUS_PROC_IMPORT("ids") int __nimbus_ids(uint32_t *ids);
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

int pipe(int fds[2]) { return nimbus_result(__nimbus_pipe(fds), 0); }
int dup(int fd) { int out = -1; int error = __nimbus_dup(fd, &out); return nimbus_result(error, out); }
int dup2(int from, int to) { return nimbus_result(__nimbus_dup2(from, to), to); }
int kill(pid_t pid, int signal) { return nimbus_result(__nimbus_kill(pid, signal), 0); }

pid_t waitpid(pid_t pid, int *status, int options) {
  int st = 0, waited = -1;
  int error = __nimbus_wait(pid, options, &st, &waited);
  if (error) { errno = error; return -1; }
  if (status && waited > 0) *status = st;
  return waited;
}

/* `strings` (NULL-terminated) as one buffer of NUL-terminated strings. */
static char *joined(const char *const *strings, size_t *len) {
  size_t n = 0;
  for (size_t i = 0; strings[i]; i++) n += strlen(strings[i]) + 1;
  char *buf = malloc(n ? n : 1);
  if (!buf) return NULL;
  char *at = buf;
  for (size_t i = 0; strings[i]; i++) { size_t l = strlen(strings[i]) + 1; memcpy(at, strings[i], l); at += l; }
  *len = n;
  return buf;
}

/* Whether `entry` (NAME=value) is the variable `name` (NAME or NAME=...). */
static int same_variable(const char *entry, const char *name) {
  size_t n = strcspn(name, "=");
  return strncmp(entry, name, n) == 0 && entry[n] == '=';
}

extern char **environ;

pid_t nimbus_spawnvpe(const char *file, const char **argv, char **deltaenv, const char *dir, int fdin, int fdout, int fderr) {
  (void)file; /* argv[0] names the program; the host resolves it as the shell does */
  size_t count = 0, delta = 0;
  for (char **e = environ; e && *e; e++) count++;
  for (char **d = deltaenv; d && *d; d++) delta++;
  const char **env = calloc(count + delta + 1, sizeof *env);
  if (!env) { errno = ENOMEM; return -1; }
  size_t used = 0;
  for (char **e = environ; e && *e; e++) {
    int changed = 0;
    for (char **d = deltaenv; d && *d; d++) if (same_variable(*e, *d)) { changed = 1; break; }
    if (!changed) env[used++] = *e;
  }
  for (char **d = deltaenv; d && *d; d++) if (strchr(*d, '=')) env[used++] = *d;
  env[used] = NULL;

  /* The child's directory, absolute: the host has no cwd of this process's. */
  char cwd[4096];
  if (!dir || dir[0] != '/') {
    if (!getcwd(cwd, sizeof cwd)) { free(env); return -1; }
    if (dir && dir[0]) {
      size_t n = strlen(cwd);
      if (n + 1 + strlen(dir) + 1 > sizeof cwd) { free(env); errno = ENAMETOOLONG; return -1; }
      if (n > 1) cwd[n++] = '/';
      strcpy(cwd + n, dir);
    }
    dir = cwd;
  }
  size_t argv_len = 0, env_len = 0;
  char *argv_buf = joined(argv, &argv_len);
  char *env_buf = joined(env, &env_len);
  free(env);
  if (!argv_buf || !env_buf) { free(argv_buf); free(env_buf); errno = ENOMEM; return -1; }
  int pid = -1;
  int error = __nimbus_spawn(argv_buf, argv_len, env_buf, env_len, dir, strlen(dir), fdin, fdout, fderr, &pid);
  free(argv_buf);
  free(env_buf);
  if (error) { errno = error; return -1; }
  /*
   * As posix_spawn reports a program that is not there (ENOENT, which git
   * takes as "not a command") or no room to run it (EAGAIN): the host
   * answers once the child started, or was refused. A wait it gives up on
   * (EINTR) is asked again.
   */
  do error = __nimbus_start(pid); while (error == EINTR);
  return nimbus_result(error, pid);
}

/* ---- file status and modes: the Nimbus filesystem extension (nimbus_fs imports) ---- */

#define NIMBUS_FS_IMPORT(name) __attribute__((import_module("nimbus_fs"), import_name(name)))
/* preview1's filestat, then st_mode, uid and gid (core runtime/wasi/types.ts NIMBUS_STAT_SIZE). */
struct nimbus_stat {
  __wasi_filestat_t filestat;
  uint32_t mode, uid, gid, zero;
};
_Static_assert(sizeof(struct nimbus_stat) == 80, "nimbus_stat is the host's 80 bytes");
NIMBUS_FS_IMPORT("path_stat") int __nimbus_path_stat(int fd, int lookupflags, const char *path, size_t len, struct nimbus_stat *out);
NIMBUS_FS_IMPORT("fd_stat") int __nimbus_fd_stat(int fd, struct nimbus_stat *out);
NIMBUS_FS_IMPORT("path_chmod") int __nimbus_path_chmod(int fd, int lookupflags, const char *path, size_t len, uint32_t mode);
NIMBUS_FS_IMPORT("fd_chmod") int __nimbus_fd_chmod(int fd, uint32_t mode);

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

static struct timespec from_ns(uint64_t ns) {
  return (struct timespec){ .tv_sec = (time_t)(ns / 1000000000ull), .tv_nsec = (long)(ns % 1000000000ull) };
}

static void to_stat(const struct nimbus_stat *in, struct stat *out) {
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

static int path_stat(const char *path, int follow, struct stat *st) {
  char *relative;
  int dirfd = beneath(path, &relative);
  if (dirfd < 0) return -1;
  struct nimbus_stat ns;
  int error = __nimbus_path_stat(dirfd, follow ? __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW : 0, relative, strlen(relative), &ns);
  if (error) { errno = error; return -1; }
  to_stat(&ns, st);
  return 0;
}

int git_wasi_stat(const char *path, struct stat *st) { return path_stat(path, 1, st); }
int git_wasi_lstat(const char *path, struct stat *st) { return path_stat(path, 0, st); }

int git_wasi_fstat(int fd, struct stat *st) {
  struct nimbus_stat ns;
  int error = __nimbus_fd_stat(fd, &ns);
  if (error) { errno = error; return -1; }
  to_stat(&ns, st);
  return 0;
}

int git_wasi_chmod(const char *path, mode_t mode) {
  char *relative;
  int dirfd = beneath(path, &relative);
  if (dirfd < 0) return -1;
  return nimbus_result(__nimbus_path_chmod(dirfd, __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW, relative, strlen(relative), mode), 0);
}

int git_wasi_fchmod(int fd, mode_t mode) { return nimbus_result(__nimbus_fd_chmod(fd, mode), 0); }

/*
 * open(2), and for a file it creates with execute bits (a checkout's
 * executable, a template hook) those bits, which preview1's create cannot
 * carry: execute wherever the umask let read through, as mode & ~umask
 * gives for any umask that masks a class's read and execute together.
 */
int git_wasi_open(const char *path, int flags, ...) {
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
  if (git_wasi_fstat(fd, &st) == 0) {
    mode_t readable = st.st_mode & 0444;
    if (git_wasi_fchmod(fd, (st.st_mode & 07777) | ((readable >> 2) & mode & 0111)) == 0) return fd;
  }
  int error = errno;
  close(fd);
  unlink(path);
  errno = error;
  return -1;
}
