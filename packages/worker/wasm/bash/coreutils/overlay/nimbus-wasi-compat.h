/* Force-included compat decls for busybox on wasi-libc: POSIX functions the
 * sysroot headers omit. Implementations live in wasi-shim.c (static stubs —
 * no users/devices/clock-setting in the Nimbus VFS). Maintained by Claude, as-is. */
#ifndef _NIMBUS_WASI_COMPAT_H
#define _NIMBUS_WASI_COMPAT_H
#ifndef __ASSEMBLER__
#include <sys/types.h>
#include <time.h>

int mknod(const char *path, mode_t mode, dev_t dev);
int chown(const char *path, uid_t owner, gid_t group);
int fchown(int fd, uid_t owner, gid_t group);
int lchown(const char *path, uid_t owner, gid_t group);
int clock_settime(clockid_t clockid, const struct timespec *tp);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
pid_t getpid(void);
pid_t getppid(void);
mode_t umask(mode_t mask);
int pipe(int fds[2]);
pid_t fork(void);
pid_t vfork(void);
int kill(pid_t pid, int sig);
int execv(const char *path, char *const argv[]);
int execvp(const char *file, char *const argv[]);
int execve(const char *path, char *const argv[], char *const envp[]);
int chroot(const char *path);
int fsync(int fd);
int fdatasync(int fd);
char *ttyname(int fd);
int tcgetpgrp(int fd);
int tcsetpgrp(int fd, pid_t pgrp);
pid_t setsid(void);
pid_t getsid(pid_t pid);
int setpgid(pid_t pid, pid_t pgid);
pid_t getpgrp(void);
unsigned int alarm(unsigned int seconds);
int mkfifo(const char *path, mode_t mode);
#include <stdio.h>
FILE *popen(const char *command, const char *type);
int pclose(FILE *stream);
int dup(int oldfd);
int dup2(int oldfd, int newfd);
char *mktemp(char *template_);
int mkstemp(char *template_);
char *mkdtemp(char *template_);
int sched_getaffinity(pid_t pid, size_t cpusetsize, void *mask);
#include <signal.h>
/* wasi-libc gates struct sigaction behind __wasilibc_unmodified_upstream
 * ("WASI has no sigaction"). No signal is ever delivered inside a Nimbus
 * facet, so record-and-return-0 semantics (wasi-shim.c) are faithful. */
struct sigaction {
  union { void (*sa_handler)(int); void (*sa_sigaction)(int, void *, void *); } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler   __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO   4
#define SA_ONSTACK   0x08000000
#define SA_RESTART   0x10000000
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#define SIG_BLOCK    0
#define SIG_UNBLOCK  1
#define SIG_SETMASK  2
#ifndef NSIG
#define NSIG 65
#endif
int sigaction(int sig, const struct sigaction *act, struct sigaction *oact);
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);
int sigprocmask(int how, const sigset_t *set, sigset_t *oset);
int sigsuspend(const sigset_t *mask);
int sigwait(const sigset_t *set, int *sig);
int killpg(int pgrp, int sig);
#include <sys/socket.h>
int getsockname(int fd, struct sockaddr *addr, socklen_t *len);
int socket(int domain, int type, int protocol);
int connect(int fd, const struct sockaddr *addr, socklen_t len);
int bind(int fd, const struct sockaddr *addr, socklen_t len);
int listen(int fd, int backlog);
int setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen);
int initgroups(const char *user, gid_t group);
int setgroups(size_t size, const gid_t *list);
int setuid(uid_t uid); int seteuid(uid_t uid);
int setgid(gid_t gid); int setegid(gid_t gid);
int ttyname_r(int fd, char *buf, size_t buflen);
int settimeofday(const struct timeval *tv, const void *tz);
ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t alen);
ssize_t recv(int fd, void *buf, size_t len, int flags);
int fchdir(int fd);
#endif /* !__ASSEMBLER__ */
#endif
