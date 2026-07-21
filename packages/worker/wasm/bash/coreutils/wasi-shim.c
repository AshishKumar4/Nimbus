/* wasi-shim.c — POSIX stubs busybox needs that wasi-libc omits.
 *
 * Semantics are chosen for the Nimbus in-facet runtime: a single-user
 * (uid 0 "user"), process-less, signal-free VFS world. Identity calls
 * answer honestly for that world; process/signal-delivery calls fail
 * with ENOSYS so applets report a real error instead of misbehaving.
 * Maintained by Claude, presented as-is. */
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/statvfs.h>
#include <time.h>
#include "pwd.h"
#include "grp.h"
#include "mntent.h"
#include "sys/statfs.h"
#include "nimbus-wasi-compat.h"

/* ── identity: single user "user", uid/gid 0 ── */
uid_t getuid(void)  { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void)  { return 0; }
gid_t getegid(void) { return 0; }
pid_t getpid(void)  { return 1; }
pid_t getppid(void) { return 0; }
mode_t umask(mode_t mask) { (void)mask; return 022; }
int setuid(uid_t u) { (void)u; return 0; }
int seteuid(uid_t u) { (void)u; return 0; }
int setgid(gid_t g) { (void)g; return 0; }
int setegid(gid_t g) { (void)g; return 0; }
int getgroups(int size, gid_t list[]) { (void)size; (void)list; return 0; }
int setgroups(size_t size, const gid_t *list) { (void)size; (void)list; return 0; }
int initgroups(const char *user, gid_t group) { (void)user; (void)group; return 0; }

static char pw_name[] = "user", pw_dir[] = "/home/user", pw_shell[] = "/bin/bash", pw_empty[] = "";
static struct passwd the_user = { pw_name, pw_empty, 0, 0, pw_empty, pw_dir, pw_shell };
static struct group the_group = { pw_name, pw_empty, 0, 0 };
struct passwd *getpwuid(uid_t uid) { (void)uid; return &the_user; }
struct passwd *getpwnam(const char *name) { return strcmp(name, pw_name) == 0 ? &the_user : 0; }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result) {
  (void)uid; (void)buf; (void)buflen; *pwd = the_user; *result = pwd; return 0;
}
int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen, struct passwd **result) {
  (void)buf; (void)buflen;
  if (strcmp(name, pw_name) != 0) { *result = 0; return 0; }
  *pwd = the_user; *result = pwd; return 0;
}
struct passwd *getpwent(void) { return 0; }
void setpwent(void) {}
void endpwent(void) {}
struct group *getgrgid(gid_t gid) { (void)gid; return &the_group; }
struct group *getgrnam(const char *name) { return strcmp(name, pw_name) == 0 ? &the_group : 0; }
int getgrgid_r(gid_t gid, struct group *grp, char *buf, size_t buflen, struct group **result) {
  (void)gid; (void)buf; (void)buflen; *grp = the_group; *result = grp; return 0;
}
int getgrnam_r(const char *name, struct group *grp, char *buf, size_t buflen, struct group **result) {
  (void)buf; (void)buflen;
  if (strcmp(name, pw_name) != 0) { *result = 0; return 0; }
  *grp = the_group; *result = grp; return 0;
}
struct group *getgrent(void) { return 0; }
void setgrent(void) {}
void endgrent(void) {}

/* ── ownership/permissions the VFS does not model: succeed ── */
int chown(const char *path, uid_t o, gid_t g)  { (void)path; (void)o; (void)g; return 0; }
int fchown(int fd, uid_t o, gid_t g)           { (void)fd; (void)o; (void)g; return 0; }
int lchown(const char *path, uid_t o, gid_t g) { (void)path; (void)o; (void)g; return 0; }
int fsync(int fd)     { (void)fd; return 0; }
int fdatasync(int fd) { (void)fd; return 0; }

/* ── processes/pipes: none inside an exec'd coreutil ── */
pid_t fork(void)  { errno = ENOSYS; return -1; }
pid_t vfork(void) { errno = ENOSYS; return -1; }
int pipe(int fds[2]) { (void)fds; errno = ENOSYS; return -1; }
int execv(const char *p, char *const a[])  { (void)p; (void)a; errno = ENOSYS; return -1; }
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int execve(const char *p, char *const a[], char *const e[]) { (void)p; (void)a; (void)e; errno = ENOSYS; return -1; }
pid_t wait(int *st) { (void)st; errno = ECHILD; return -1; }
pid_t waitpid(pid_t pid, int *st, int opt) { (void)pid; (void)st; (void)opt; errno = ECHILD; return -1; }
int kill(pid_t pid, int sig)  { (void)pid; (void)sig; errno = ESRCH; return -1; }
int killpg(int pgrp, int sig) { (void)pgrp; (void)sig; errno = ESRCH; return -1; }
FILE *popen(const char *cmd, const char *type) { (void)cmd; (void)type; errno = ENOSYS; return 0; }
int pclose(FILE *f) { (void)f; errno = ENOSYS; return -1; }
pid_t setsid(void) { return 1; }
pid_t getsid(pid_t pid) { (void)pid; return 1; }
int setpgid(pid_t pid, pid_t pgid) { (void)pid; (void)pgid; return 0; }
pid_t getpgrp(void) { return 1; }
unsigned int alarm(unsigned int s) { (void)s; return 0; }
int sched_getaffinity(pid_t pid, size_t sz, void *mask) { (void)pid; (void)sz; (void)mask; errno = ENOSYS; return -1; }
int chroot(const char *path) { (void)path; errno = ENOSYS; return -1; }

/* ── fds the runtime WASI layer does not duplicate ── */
int dup(int fd) { (void)fd; errno = ENOSYS; return -1; }
int dup2(int oldfd, int newfd) { (void)oldfd; (void)newfd; errno = ENOSYS; return -1; }
int fchdir(int fd) { (void)fd; errno = ENOSYS; return -1; }

/* ── signals: registration is a no-op (nothing is ever delivered) ── */
int sigaction(int sig, const struct sigaction *act, struct sigaction *oact) {
  (void)sig; (void)act;
  if (oact) memset(oact, 0, sizeof *oact);
  return 0;
}
int sigemptyset(sigset_t *set) { memset(set, 0, sizeof *set); return 0; }
int sigfillset(sigset_t *set)  { memset(set, 0xff, sizeof *set); return 0; }
int sigaddset(sigset_t *set, int sig) { (void)set; (void)sig; return 0; }
int sigdelset(sigset_t *set, int sig) { (void)set; (void)sig; return 0; }
int sigismember(const sigset_t *set, int sig) { (void)set; (void)sig; return 0; }
int sigprocmask(int how, const sigset_t *set, sigset_t *oset) {
  (void)how; (void)set;
  if (oset) memset(oset, 0, sizeof *oset);
  return 0;
}
int sigsuspend(const sigset_t *mask) { (void)mask; errno = EINTR; return -1; }
int sigwait(const sigset_t *set, int *sig) { (void)set; (void)sig; errno = ENOSYS; return -1; }

/* ── tty ── */
char *ttyname(int fd) { return isatty(fd) ? (char *)"/dev/tty" : 0; }
int ttyname_r(int fd, char *buf, size_t buflen) {
  if (!isatty(fd)) return ENOTTY;
  if (buflen < 9) return ERANGE;
  strcpy(buf, "/dev/tty");
  return 0;
}
int tcgetpgrp(int fd) { (void)fd; return 1; }
int tcsetpgrp(int fd, pid_t pgrp) { (void)fd; (void)pgrp; return 0; }

/* ── clock/device writes: not permitted ── */
int clock_settime(clockid_t id, const struct timespec *tp) { (void)id; (void)tp; errno = EPERM; return -1; }
int settimeofday(const struct timeval *tv, const void *tz) { (void)tv; (void)tz; errno = EPERM; return -1; }
int mknod(const char *path, mode_t mode, dev_t dev) { (void)path; (void)mode; (void)dev; errno = EPERM; return -1; }
int mkfifo(const char *path, mode_t mode) { (void)path; (void)mode; errno = EPERM; return -1; }

/* ── temp files over the VFS ── */
static int fill_template(char *tpl) {
  size_t n = strlen(tpl);
  if (n < 6 || strcmp(tpl + n - 6, "XXXXXX") != 0) { errno = EINVAL; return -1; }
  static const char cs[] = "abcdefghijklmnopqrstuvwxyz0123456789";
  static unsigned seed;
  seed = seed * 1103515245 + 12345 + (unsigned)clock();
  unsigned v = seed;
  for (int i = 0; i < 6; i++) { tpl[n - 6 + i] = cs[v % 36]; v /= 36; v += (unsigned)clock(); }
  return 0;
}
int mkstemp(char *tpl) {
  for (int attempt = 0; attempt < 100; attempt++) {
    if (fill_template(tpl) < 0) return -1;
    int fd = open(tpl, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) return fd;
    if (errno != EEXIST) return -1;
  }
  errno = EEXIST;
  return -1;
}
char *mktemp(char *tpl) { return fill_template(tpl) < 0 ? 0 : tpl; }
char *mkdtemp(char *tpl) {
  for (int attempt = 0; attempt < 100; attempt++) {
    if (fill_template(tpl) < 0) return 0;
    if (mkdir(tpl, 0700) == 0) return tpl;
    if (errno != EEXIST) return 0;
  }
  errno = EEXIST;
  return 0;
}

/* ── mounts: one synthetic VFS root for df ── */
static char mnt_fsname[] = "nimbusvfs", mnt_dir[] = "/", mnt_type[] = "nimbusvfs", mnt_opts[] = "rw";
static struct mntent the_mount = { mnt_fsname, mnt_dir, mnt_type, mnt_opts, 0, 0 };
static int mnt_served;
FILE *setmntent(const char *filename, const char *type) { (void)filename; (void)type; mnt_served = 0; return (FILE *)&the_mount; }
struct mntent *getmntent(FILE *stream) { (void)stream; return mnt_served++ ? 0 : &the_mount; }
struct mntent *getmntent_r(FILE *stream, struct mntent *result, char *buffer, int bufsize) {
  (void)buffer; (void)bufsize;
  struct mntent *m = getmntent(stream);
  if (!m) return 0;
  *result = *m;
  return result;
}
int endmntent(FILE *stream) { (void)stream; return 1; }
char *hasmntopt(const struct mntent *mnt, const char *opt) { (void)mnt; (void)opt; return 0; }

int statfs(const char *path, struct statfs *buf) {
  struct statvfs v;
  if (statvfs(path, &v) < 0) return -1;
  memset(buf, 0, sizeof *buf);
  buf->f_bsize = v.f_bsize; buf->f_frsize = v.f_frsize;
  buf->f_blocks = v.f_blocks; buf->f_bfree = v.f_bfree; buf->f_bavail = v.f_bavail;
  buf->f_files = v.f_files; buf->f_ffree = v.f_ffree; buf->f_namelen = v.f_namemax;
  return 0;
}
int fstatfs(int fd, struct statfs *buf) {
  struct statvfs v;
  if (fstatvfs(fd, &v) < 0) return -1;
  memset(buf, 0, sizeof *buf);
  buf->f_bsize = v.f_bsize; buf->f_frsize = v.f_frsize;
  buf->f_blocks = v.f_blocks; buf->f_bfree = v.f_bfree; buf->f_bavail = v.f_bavail;
  buf->f_files = v.f_files; buf->f_ffree = v.f_ffree; buf->f_namelen = v.f_namemax;
  return 0;
}

/* ── dead-code references from libbb network helpers ── */
int h_errno;
struct hostent *gethostbyname(const char *name) { (void)name; return 0; }
struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type) { (void)addr; (void)len; (void)type; return 0; }
const char *hstrerror(int err) { (void)err; return "no network"; }
int getsockname(int fd, struct sockaddr *addr, socklen_t *len) { (void)fd; (void)addr; (void)len; errno = ENOSYS; return -1; }
ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t alen) {
  (void)fd; (void)buf; (void)len; (void)flags; (void)addr; (void)alen; errno = ENOSYS; return -1;
}
ssize_t recv(int fd, void *buf, size_t len, int flags) { (void)fd; (void)buf; (void)len; (void)flags; errno = ENOSYS; return -1; }

/* ── stat facelift (linker --wrap=stat,lstat,fstat,fstatat) ──
 * WASI preview1 filestat carries no block count and no permission bits, so
 * wasi-libc leaves st_blocks 0 (du reports nothing) and st_mode bare
 * (ls -l shows "----------"). Synthesize blocks from the byte size and show
 * the Nimbus VFS default modes (644 files / 755 dirs). Real per-file modes
 * are enforced by the runtime's WASI layer, not readable through preview1. */
int __real_stat(const char *path, struct stat *st);
int __real_lstat(const char *path, struct stat *st);
int __real_fstat(int fd, struct stat *st);
int __real_fstatat(int fd, const char *path, struct stat *st, int flag);
static void nimbus_stat_facelift(struct stat *st) {
  st->st_blocks = (st->st_size + 511) / 512;
  if (S_ISDIR(st->st_mode)) st->st_mode |= 0755;
  else if (S_ISREG(st->st_mode) && (st->st_mode & 07777) == 0) st->st_mode |= 0644;
}
int __wrap_stat(const char *path, struct stat *st) {
  int r = __real_stat(path, st);
  if (r == 0) nimbus_stat_facelift(st);
  return r;
}
int __wrap_lstat(const char *path, struct stat *st) {
  int r = __real_lstat(path, st);
  if (r == 0) nimbus_stat_facelift(st);
  return r;
}
int __wrap_fstat(int fd, struct stat *st) {
  int r = __real_fstat(fd, st);
  if (r == 0) nimbus_stat_facelift(st);
  return r;
}
int __wrap_fstatat(int fd, const char *path, struct stat *st, int flag) {
  int r = __real_fstatat(fd, path, st, flag);
  if (r == 0) nimbus_stat_facelift(st);
  return r;
}

/* ── chmod: threaded to the Nimbus runtime (preview1 has no mode syscall).
 * The runtime updates its in-facet mode table and the post-exit VFS flush
 * applies the durable, S2a-checked chmod. Outside Nimbus (plain WASI hosts)
 * the import is absent and instantiation supplies nothing — the runtime
 * always provides it, and busybox is only ever exec'd inside the runtime.
 * Linker --wrap=chmod,fchmod displaces wasi-libc's ENOSYS stubs. */
__attribute__((import_module("nimbus_proc"), import_name("chmod")))
int nimbus_proc_chmod(const char *path, unsigned path_len, unsigned mode);
int __wrap_chmod(const char *path, mode_t mode) {
  int err = nimbus_proc_chmod(path, (unsigned)strlen(path), (unsigned)mode);
  if (err) { errno = err; return -1; }
  return 0;
}
int __wrap_fchmod(int fd, mode_t mode) { (void)fd; (void)mode; errno = ENOSYS; return -1; }
