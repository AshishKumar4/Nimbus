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

/* ---- setjmp/longjmp — asyncify-native (PROVEN, see probe-sjlj-asyncify + the
 * m4-sjlj node proof). We REPLACE wasi-libc's setjmp.h (which #errors without
 * wasm-EH) so bash compiles WITHOUT -wasm-enable-sjlj, keeping the module
 * EH-free so wasm-opt --asyncify instruments it. setjmp/longjmp are ordinary
 * imports on the asyncify allowlist; the facet drives capture (unwind into a
 * slot, immediately rewind) and longjmp (unwind current stack, replay the slot).
 * The jmp_buf lives in linear memory so it rides fork's memory copy. */
#define _SETJMP_H  /* suppress wasi-libc <setjmp.h> */
typedef struct { int slot; int retval; int hw; } __nimbus_jmp_buf;
typedef __nimbus_jmp_buf jmp_buf[1];
typedef __nimbus_jmp_buf sigjmp_buf[1];
__attribute__((returns_twice)) int  setjmp(jmp_buf);
__attribute__((returns_twice)) int  _setjmp(jmp_buf);
__attribute__((returns_twice)) int  sigsetjmp(sigjmp_buf, int);
_Noreturn void longjmp(jmp_buf, int);
_Noreturn void _longjmp(jmp_buf, int);
_Noreturn void siglongjmp(sigjmp_buf, int);

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

/* ---- fcntl gap: wasi-libc has F_DUPFD_CLOEXEC but not plain F_DUPFD ---- */
#ifndef F_DUPFD
#define F_DUPFD 0
#endif

/* ---- signal-mask constants (wasi emulated-signal omits these) ---- */
#ifndef SIG_BLOCK
#define SIG_BLOCK   0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif

/* ---- sigaction layer (wasi-libc gates it all out; sigset_t + signal numbers
 * remain). Handlers are stored in a table; delivery routes through
 * nimbus_proc.kill at syscall boundaries (M4/M5). Enough for bash to install
 * its trap/SIGCHLD handlers and compile + run non-interactively. ---- */
#include <signal.h>
#ifndef SA_NOCLDSTOP
typedef struct { int si_signo, si_errno, si_code; pid_t si_pid; uid_t si_uid; int si_status; void *si_addr; } siginfo_t;
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO   4
#define SA_ONSTACK   0x08000000
#define SA_RESTART   0x10000000
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#define SA_INTERRUPT 0x20000000
struct sigaction {
  union { void (*sa_handler)(int); void (*sa_sigaction)(int, siginfo_t *, void *); } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler   __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigsuspend(const sigset_t *);
int siginterrupt(int, int);
#endif

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
