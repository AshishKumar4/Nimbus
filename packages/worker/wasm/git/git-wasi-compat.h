/*
 * What git needs of POSIX that wasi-libc lacks: declarations here, bodies in
 * git-wasi-compat.c. There is no fork: git starts a child as it does on
 * Windows (patches/0002, start_command under NO_FORK), through
 * the shared Nimbus libc shim. Its pipes, dup, waitpid and kill are the
 * host's (nimbus_proc imports, core runtime/wasi/processes.ts).
 */
#ifndef GIT_WASI_COMPAT_H
#define GIT_WASI_COMPAT_H
#include <sys/types.h>
#include <stdio.h>
#include <signal.h>
#include <time.h>
pid_t getppid(void);
pid_t getpgid(pid_t);
#include "nimbus-proc.h"
/* Git's portable no-fork backend is provided by the shared libc overlay. */
#define git_spawnvpe nimbus_spawnvpe
pid_t fork(void);
int execv(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int execvp(const char *, char *const[]);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
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
#endif
#ifndef SA_RESTART
#define SA_RESTART 0x10000000
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
/*
 * A file's mode and owner, which WASI preview1's filestat leaves out, chmod,
 * which it has no call for, a created file's execute bits, and the
 * process's credential: the shared Nimbus libc shim (wasm/nimbus-libc).
 */
#include "nimbus-fs.h"
#define stat(path, buf) nimbus_stat(path, buf)
#define lstat nimbus_lstat
#define fstat nimbus_fstat
#define chmod nimbus_chmod
#define fchmod nimbus_fchmod
#define open(...) nimbus_open(__VA_ARGS__)
#define access nimbus_access
#endif
