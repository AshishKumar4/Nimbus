/* Nimbus process-ABI implementation for wasi-libc — the link-time counterpart
 * of nimbus-proc.h. wasi-libc has NO fork/exec/wait/pipe (all guarded out), so
 * these are our own, trapping to the `nimbus_proc` host import namespace which
 * the facet preamble (wasi-instance.ts) implements over the supervisor — the
 * SAME mechanism proven live in fork M1/M2 (fork/exec/waitpid over asyncify)
 * and M3 (pipe/dup2/FdTable). This is REAL-FORK-BASH-PLAN route 2 / WASI-PLAN
 * §3, the Nimbus sysroot overlay.
 *
 * The blocking calls (fork/execv/waitpid) are on the asyncify import allowlist
 * so wasm-opt --asyncify instruments them to unwind→copy-memory→rewind. pipe/
 * dup2 are 0-RPC facet-local FD math (the FdTable/OFD layer, M3). read/write on
 * pipe fds are handled by the WASI fd_read/fd_write shim (dispatch-by-kind, as
 * sockets already are), NOT here — so bash's ordinary libc I/O is untouched. */
#include "nimbus-proc.h"
#include <errno.h>
#include <string.h>
#include <stdarg.h>

#define IMPORT(name) __attribute__((import_module("nimbus_proc"), import_name(name)))

IMPORT("fork")    extern int  __np_fork(void);
IMPORT("vfork")   extern int  __np_vfork(void);
/* execv: host reads a NUL-separated flat argv/env blob from linear memory. */
IMPORT("execve")  extern int  __np_execve(const char *path, const char *argv_flat, int argv_len,
                                          const char *env_flat, int env_len);
IMPORT("waitpid") extern int  __np_waitpid(int pid, int *status, int options);
IMPORT("pipe")    extern int  __np_pipe(int fds[2]);
IMPORT("dup2")    extern int  __np_dup2(int oldfd, int newfd);
IMPORT("dup")     extern int  __np_dup(int oldfd);
IMPORT("kill")    extern int  __np_kill(int pid, int sig);
IMPORT("setpgid") extern int  __np_setpgid(int pid, int pgid);
IMPORT("getpgid") extern int  __np_getpgid(int pid);
IMPORT("getppid") extern int  __np_getppid(void);
IMPORT("tcsetpgrp") extern int __np_tcsetpgrp(int fd, int pgid);
IMPORT("tcgetpgrp") extern int __np_tcgetpgrp(int fd);

/* bash's main() is K&R 3-arg `main(argc, argv, env)`, but the wasi crt calls a
 * 2-arg `__main_argc_argv` (weak-aliased to main) — a wasm signature mismatch
 * that traps. Provide a strong 2-arg entry that calls the real 3-arg main with
 * `environ` (which wasi-libc populates from environ_get). No bash source edit. */
extern int main(int, char **, char **);
extern char **environ;
int __main_argc_argv(int argc, char **argv) { return main(argc, argv, environ); }

pid_t fork(void)  { int r = __np_fork();  if (r < 0) { errno = -r; return -1; } return r; }
pid_t vfork(void) { int r = __np_vfork(); if (r < 0) { errno = -r; return -1; } return r; }

/* Flatten a NULL-terminated char*[] into a NUL-separated blob; return length. */
static int flatten(char *const v[], char *buf, int cap) {
  int o = 0;
  for (int i = 0; v && v[i]; i++) {
    int n = (int)strlen(v[i]);
    if (o + n + 1 > cap) return -1;
    memcpy(buf + o, v[i], n);
    o += n;
    buf[o++] = '\0';
  }
  return o;
}

static char __np_argbuf[65536];
static char __np_envbuf[65536];

int execve(const char *path, char *const argv[], char *const envp[]) {
  int al = flatten(argv, __np_argbuf, sizeof __np_argbuf);
  int el = flatten(envp, __np_envbuf, sizeof __np_envbuf);
  if (al < 0 || el < 0) { errno = E2BIG; return -1; }
  int r = __np_execve(path, __np_argbuf, al, __np_envbuf, el);
  /* execve only returns on error (POSIX). */
  errno = (r < 0) ? -r : ENOEXEC;
  return -1;
}

int execv(const char *path, char *const argv[]) {
  extern char **environ;
  return execve(path, argv, environ);
}

int execvp(const char *file, char *const argv[]) {
  /* PATH resolution is delegated to the supervisor's exec dispatch (it already
   * owns the resolve hook / exec-bit ladder); pass the bare name through. */
  return execv(file, argv);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  return execve(file, argv, envp);
}

pid_t waitpid(pid_t pid, int *status, int options) {
  int st = 0;
  int r = __np_waitpid(pid, &st, options);
  if (r < 0) { errno = -r; return -1; }
  if (status) *status = st;
  return r;
}

pid_t wait(int *status)   { return waitpid(-1, status, 0); }
pid_t wait3(int *status, int options, void *rusage) { (void)rusage; return waitpid(-1, status, options); }
pid_t wait4(pid_t pid, int *status, int options, void *rusage) { (void)rusage; return waitpid(pid, status, options); }

int pipe(int fds[2]) { int r = __np_pipe(fds); if (r < 0) { errno = -r; return -1; } return 0; }
int dup(int o)         { int r = __np_dup(o);     if (r < 0) { errno = -r; return -1; } return r; }

int   kill(pid_t pid, int sig)    { int r = __np_kill(pid, sig); if (r < 0) { errno = -r; return -1; } return 0; }
pid_t getppid(void)               { return __np_getppid(); }
int   setpgid(pid_t p, pid_t g)   { int r = __np_setpgid(p, g); if (r < 0) { errno = -r; return -1; } return 0; }
pid_t getpgid(pid_t p)            { int r = __np_getpgid(p); if (r < 0) { errno = -r; return -1; } return r; }
pid_t getpgrp(void)               { return getpgid(0); }
int   setpgrp(void)               { return setpgid(0, 0); }
pid_t tcgetpgrp(int fd)           { int r = __np_tcgetpgrp(fd); if (r < 0) { errno = -r; return -1; } return r; }
int   tcsetpgrp(int fd, pid_t pg) { int r = __np_tcsetpgrp(fd, pg); if (r < 0) { errno = -r; return -1; } return 0; }

/* Process-group session stubs bash tolerates as no-ops in a single session. */
pid_t setsid(void) { return getpgrp(); }
unsigned alarm(unsigned s) { (void)s; return 0; } /* SIGALRM timers: M5 */

/* getrlimit/setrlimit: report "unlimited" (the facet budget is enforced by the
 * supervisor ProcessTable, not per-process rlimits — M5 wires ulimit through). */
int getrlimit(int res, struct rlimit *rl) { (void)res; if (rl) { rl->rlim_cur = RLIM_INFINITY; rl->rlim_max = RLIM_INFINITY; } return 0; }
int setrlimit(int res, const struct rlimit *rl) { (void)res; (void)rl; return 0; }

/* pwd: minimal single-user resolution (the session runs as one uid; S2a owns
 * real uid/gid). bash uses this for ~ expansion and $HOME fallback. */
static struct passwd __np_pw = { "nimbus", "x", 1000, 1000, "Nimbus", "/root", "/bin/bash" };
struct passwd *getpwnam(const char *name) { (void)name; return &__np_pw; }
struct passwd *getpwuid(uid_t uid) { (void)uid; return &__np_pw; }
struct passwd *getpwent(void) { return 0; }
void setpwent(void) {}
void endpwent(void) {}

char *ttyname(int fd) { (void)fd; return (char *)"/dev/tty"; }
int ttyname_r(int fd, char *buf, size_t len) { (void)fd; if (len < 9) return ERANGE; memcpy(buf, "/dev/tty", 9); return 0; }

/* ---- asyncify-native setjmp/longjmp (proven mechanism) ----
 * setjmp: __np_setjmp captures the stack into a facet slot (unwind+rewind) and
 * writes {slot,retval=0,hw} into the jmp_buf; on a later longjmp the facet
 * replays that slot. The `returns_twice` attribute keeps the optimizer honest
 * across the capture point. retval is read fresh from the jmp_buf each landing:
 * 0 on capture, the injected value on longjmp. */
IMPORT("setjmp")  extern void __np_setjmp(void *env);
IMPORT("longjmp") extern void __np_longjmp(void *env, int val);

__attribute__((returns_twice, noinline))
int setjmp(jmp_buf env) { __np_setjmp((void *)env); return env->retval; }
__attribute__((returns_twice, noinline))
int _setjmp(jmp_buf env) { __np_setjmp((void *)env); return env->retval; }
__attribute__((returns_twice, noinline))
int sigsetjmp(sigjmp_buf env, int savesigs) { (void)savesigs; __np_setjmp((void *)env); return env->retval; }

_Noreturn void longjmp(jmp_buf env, int val) { __np_longjmp((void *)env, val ? val : 1); __builtin_unreachable(); }
_Noreturn void _longjmp(jmp_buf env, int val) { __np_longjmp((void *)env, val ? val : 1); __builtin_unreachable(); }
_Noreturn void siglongjmp(sigjmp_buf env, int val) { __np_longjmp((void *)env, val ? val : 1); __builtin_unreachable(); }

/* ---- termios (the RuntimeTtyOptions seam; non-interactive bash never calls
 * these — stubbed to a sane cooked-mode default. tcget/set route to the
 * nimbus_proc tty imports when interactive job control lands, M5). ---- */
#include <termios.h>
IMPORT("tcgetattr") extern int __np_tcgetattr(int fd, void *t);
IMPORT("tcsetattr") extern int __np_tcsetattr(int fd, int act, const void *t);
int tcgetattr(int fd, struct termios *t) {
  if (__np_tcgetattr(fd, t) == 0) return 0;
  memset(t, 0, sizeof *t);
  t->c_iflag = ICRNL | IXON; t->c_oflag = OPOST | ONLCR;
  t->c_cflag = CS8 | CREAD | CLOCAL; t->c_lflag = ISIG | ICANON | ECHO | ECHOE | IEXTEN;
  t->c_cc[VEOF] = 4; t->c_cc[VMIN] = 1; return 0;
}
int tcsetattr(int fd, int act, const struct termios *t) { __np_tcsetattr(fd, act, t); return 0; }
int tcflush(int fd, int q) { (void)fd; (void)q; return 0; }
int tcdrain(int fd) { (void)fd; return 0; }
int tcflow(int fd, int a) { (void)fd; (void)a; return 0; }
int tcsendbreak(int fd, int d) { (void)fd; (void)d; return 0; }
speed_t cfgetispeed(const struct termios *t) { return t->c_ispeed; }
speed_t cfgetospeed(const struct termios *t) { return t->c_ospeed; }
int cfsetispeed(struct termios *t, speed_t s) { t->c_ispeed = s; return 0; }
int cfsetospeed(struct termios *t, speed_t s) { t->c_ospeed = s; return 0; }
int cfsetspeed(struct termios *t, speed_t s) { t->c_ispeed = t->c_ospeed = s; return 0; }
pid_t tcgetsid(int fd) { (void)fd; return getpgrp(); }

/* ---- sigaction layer ----
 * Handlers stored per-signal; sigaction is the install point the supervisor's
 * pending-signal delivery (nimbus_proc.kill) will invoke at syscall boundaries.
 * sigset ops operate on musl's sigset_t (array of unsigned long bit words). */
#ifndef NSIG
#define NSIG 65
#endif
static void (*__np_handlers[NSIG])(int);

static unsigned long *__ss_words(sigset_t *s) { return (unsigned long *)s; }
int sigemptyset(sigset_t *s) { memset(s, 0, sizeof *s); return 0; }
int sigfillset(sigset_t *s) { memset(s, 0xff, sizeof *s); return 0; }
int sigaddset(sigset_t *s, int sig) { if (sig < 1 || sig >= NSIG) { errno = EINVAL; return -1; } __ss_words(s)[(sig-1)/(8*sizeof(long))] |= 1UL << ((sig-1)%(8*sizeof(long))); return 0; }
int sigdelset(sigset_t *s, int sig) { if (sig < 1 || sig >= NSIG) { errno = EINVAL; return -1; } __ss_words(s)[(sig-1)/(8*sizeof(long))] &= ~(1UL << ((sig-1)%(8*sizeof(long)))); return 0; }
int sigismember(const sigset_t *s, int sig) { if (sig < 1 || sig >= NSIG) return 0; return (__ss_words((sigset_t*)s)[(sig-1)/(8*sizeof(long))] >> ((sig-1)%(8*sizeof(long)))) & 1; }
int sigprocmask(int how, const sigset_t *set, sigset_t *old) { (void)how; (void)set; if (old) memset(old, 0, sizeof *old); return 0; }
int sigsuspend(const sigset_t *m) { (void)m; errno = EINTR; return -1; }
int siginterrupt(int sig, int f) { (void)sig; (void)f; return 0; }

int sigaction(int sig, const struct sigaction *act, struct sigaction *old) {
  if (sig < 1 || sig >= NSIG) { errno = EINVAL; return -1; }
  if (old) { memset(old, 0, sizeof *old); old->sa_handler = __np_handlers[sig]; }
  if (act) __np_handlers[sig] = act->sa_handler;
  return 0;
}

