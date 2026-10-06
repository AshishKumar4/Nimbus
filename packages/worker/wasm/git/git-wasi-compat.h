/*
 * What git needs of POSIX that wasi-libc lacks: declarations here, bodies in
 * git-wasi-compat.c. There is no fork: git starts a child as it does on
 * Windows (patches/0002, start_command under NIMBUS_PROC), through
 * nimbus_spawnvpe, and its pipes, dup, waitpid and kill are the host's
 * (the nimbus_proc imports, worker runtime/wasi/preamble.ts).
 */
#ifndef GIT_WASI_COMPAT_H
#define GIT_WASI_COMPAT_H
#include <sys/types.h>
#include <stdio.h>
#include <signal.h>
#include <time.h>
uid_t geteuid(void);
uid_t getuid(void);
gid_t getgid(void);
gid_t getegid(void);
pid_t getppid(void);
pid_t getpgid(pid_t);
/*
 * Start `file` with `argv` as a child whose descriptors 0, 1 and 2 are
 * `fdin`, `fdout` and `fderr` of this process (-1: none), in `dir` (NULL:
 * this process's directory), with this process's environment changed by
 * `deltaenv` (NAME=value sets, a bare NAME unsets), as mingw_spawnvpe does.
 * The child's pid, or -1 and errno.
 */
pid_t nimbus_spawnvpe(const char *file, const char **argv, char **deltaenv, const char *dir, int fdin, int fdout, int fderr);
pid_t fork(void);
int execv(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int execvp(const char *, char *const[]);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
int pipe(int[2]);
int dup(int);
int dup2(int, int);
int kill(pid_t, int);
mode_t umask(mode_t);
unsigned alarm(unsigned);
char *getpass(const char *);
pid_t tcgetpgrp(int);
int mkstemp(char *);
char *mkdtemp(char *);
void flockfile(FILE *);
void funlockfile(FILE *);
typedef unsigned long sigset_t_compat;
#ifndef SIG_SETMASK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#include <sys/stat.h>
int git_wasi_chmod(const char *, mode_t);
int git_wasi_fchmod(int, mode_t);
#define chmod git_wasi_chmod
#define fchmod git_wasi_fchmod
#endif
#ifndef SA_RESTART
#define SA_RESTART 0x10000000
#include <sys/stat.h>
int git_wasi_chmod(const char *, mode_t);
int git_wasi_fchmod(int, mode_t);
#define chmod git_wasi_chmod
#define fchmod git_wasi_fchmod
#endif
struct sigaction { void (*sa_handler)(int); sigset_t sa_mask; int sa_flags; };
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigprocmask(int, const sigset_t *, sigset_t *);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
#define ITIMER_REAL 0
#define SO_KEEPALIVE 9
struct servent { char *s_name; char **s_aliases; int s_port; char *s_proto; };
struct servent *getservbyname(const char *, const char *);
extern int h_errno;
const char *hstrerror(int);
struct in_addr;
char *inet_ntoa(struct in_addr);
int socket(int, int, int);
struct sockaddr;
int connect(int, const struct sockaddr *, unsigned int);
int setsockopt(int, int, int, const void *, unsigned int);
#include <sys/stat.h>
int git_wasi_chmod(const char *, mode_t);
int git_wasi_fchmod(int, mode_t);
#define chmod git_wasi_chmod
#define fchmod git_wasi_fchmod
#endif
