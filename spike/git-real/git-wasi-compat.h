/*
 * What git needs of POSIX that wasi-libc lacks: declarations here, bodies in
 * git-wasi-compat.c. Spike only: process creation answers ENOSYS, so any git
 * command that spawns (pager, editor, hooks, transports) fails at the spawn.
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
