/* Nimbus process/FD overlay for wasi-libc — force-included into every bash TU.
 * wasi-libc guards fork/exec/pipe/wait behind __wasilibc_unmodified_upstream
 * (i.e. absent). We declare them here (implemented in nimbus-proc.c, trapping
 * to the proven env.* host ABI: fork/vfork/execv/waitpid/pipe/dup2/read/write),
 * plus the rlimit/wait header bits bash needs. This is the Nimbus sysroot
 * overlay of REAL-FORK-BASH-PLAN route 2 / WASI-PLAN §3. */
#ifndef NIMBUS_PROC_H
#define NIMBUS_PROC_H

/* wasi-libc's sigset_t is a one-byte placeholder (__typedef_sigset_t.h),
 * too small for SIGCHLD: musl's, which the signal-set ops in nimbus-proc.c
 * index, is put in its place before any wasi-libc header is read. */
#define __wasilibc___typedef_sigset_t_h
#define __DEFINED_sigset_t
typedef struct __sigset_t { unsigned long __bits[128 / sizeof (long)]; } sigset_t;

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
/* Every copy bash makes of a jmp_buf, and every end of a saved one, so the
 * runner knows which buffers can still be jumped through (bash-runner@5:
 * recorded in the module's memory; patches/procenv.patch routes bash's
 * copies here). */
void nimbus_procenv_copy(void *dst, const void *src);
void nimbus_procenv_drop(void *at);

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

/* ---- sys/wait.h, pwd.h (absent in wasi-libc): nimbus-libc/posix ---- */
#include <sys/wait.h>
#include <pwd.h>

/* ---- fcntl gap: wasi-libc has F_DUPFD_CLOEXEC but not plain F_DUPFD ---- */
#ifndef F_DUPFD
#define F_DUPFD 0
#endif

/* ---- sigaction layer (wasi-libc gates it all out; sigset_t + signal numbers
 * remain). Handlers are stored in a table; delivery routes through
 * nimbus_proc.kill at syscall boundaries (M4/M5). Enough for bash to install
 * its trap/SIGCHLD handlers and compile + run non-interactively. ---- */
#include <signal.h>
#ifndef SA_NOCLDSTOP
typedef struct { int si_signo, si_errno, si_code; pid_t si_pid; uid_t si_uid; int si_status; void *si_addr; } siginfo_t;
#define SA_INTERRUPT 0x20000000
struct sigaction {
  union { void (*sa_handler)(int); void (*sa_sigaction)(int, siginfo_t *, void *); } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler   __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction
#include <nimbus-signal.h>
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


#endif /* NIMBUS_PROC_H */
