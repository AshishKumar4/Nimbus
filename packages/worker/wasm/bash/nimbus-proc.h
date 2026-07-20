/* Nimbus process/FD overlay for wasi-libc — force-included into every bash TU.
 * wasi-libc guards fork/exec/pipe/wait behind __wasilibc_unmodified_upstream
 * (i.e. absent). We declare them here (implemented in nimbus-proc.c, trapping
 * to the proven env.* host ABI: fork/vfork/execv/waitpid/pipe/dup2/read/write),
 * plus the rlimit/wait header bits bash needs. This is the Nimbus sysroot
 * overlay of REAL-FORK-BASH-PLAN route 2 / WASI-PLAN §3. */
#ifndef NIMBUS_PROC_H
#define NIMBUS_PROC_H

#include <sys/types.h>
#include <stddef.h>

/* ---- process control (unistd gaps) ---- */
pid_t fork(void);
pid_t vfork(void);
int execve(const char *, char *const [], char *const []);
int execv(const char *, char *const []);
int execvp(const char *, char *const []);
int execvpe(const char *, char *const [], char *const []);
int execl(const char *, const char *, ...);
int execle(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
pid_t getppid(void);
pid_t setsid(void);
int setpgid(pid_t, pid_t);
pid_t getpgid(pid_t);
pid_t getpgrp(void);
int setpgrp(void);
pid_t tcgetpgrp(int);
int tcsetpgrp(int, pid_t);
unsigned alarm(unsigned);
int kill(pid_t, int);
int killpg(pid_t, int);
char *ttyname(int);
int ttyname_r(int, char *, size_t);

/* ---- sys/wait.h (absent in wasi-libc) ---- */
typedef int idtype_t;
pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
pid_t wait3(int *, int, void *);
pid_t wait4(pid_t, int *, int, void *);
#define WNOHANG    1
#define WUNTRACED  2
#define WCONTINUED 8
#define WEXITSTATUS(s)  (((s) >> 8) & 0xff)
#define WTERMSIG(s)     ((s) & 0x7f)
#define WSTOPSIG(s)     WEXITSTATUS(s)
#define WIFEXITED(s)    (WTERMSIG(s) == 0)
#define WIFSIGNALED(s)  (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WIFSTOPPED(s)   (((s) & 0xff) == 0x7f)
#define WIFCONTINUED(s) ((s) == 0xffff)
#define WCOREDUMP(s)    ((s) & 0x80)
#define WCOREFLAG       0x80

/* ---- rlimit (bash general.h wants rlim_t / struct rlimit) ---- */
#ifndef RLIM_INFINITY
typedef unsigned long long rlim_t;
struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; };
#define RLIM_INFINITY (~0ULL)
#define RLIM_SAVED_MAX RLIM_INFINITY
#define RLIM_SAVED_CUR RLIM_INFINITY
#define RLIMIT_CPU     0
#define RLIMIT_FSIZE   1
#define RLIMIT_DATA    2
#define RLIMIT_STACK   3
#define RLIMIT_CORE    4
#define RLIMIT_RSS     5
#define RLIMIT_NOFILE  7
#define RLIMIT_AS      9
#define RLIMIT_NPROC   6
#define RLIMIT_MEMLOCK 8
#define RLIMIT_NLIMITS 16
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#endif


/* ---- pwd.h (absent in wasi-libc) ---- */
struct passwd { char *pw_name; char *pw_passwd; uid_t pw_uid; gid_t pw_gid; char *pw_gecos; char *pw_dir; char *pw_shell; };
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
struct passwd *getpwent(void);
void setpwent(void);
void endpwent(void);

#endif /* NIMBUS_PROC_H */
