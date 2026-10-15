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
#include <stdint.h>
#include <stdarg.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <wasi/api.h>

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
IMPORT("startup_cwd") extern int __np_startup_cwd(char *buf, unsigned capacity);
IMPORT("capture_cwd") extern int __np_capture_cwd(const char *buf, unsigned length);

static int capture_cwd(void) {
  char *cwd = getcwd(NULL, 0);
  if (!cwd) return -1;
  int err = __np_capture_cwd(cwd, strlen(cwd));
  free(cwd);
  if (err) { errno = err; return -1; }
  return 0;
}

/* bash's main() is K&R 3-arg `main(argc, argv, env)`, but the wasi crt calls a
 * 2-arg `__main_argc_argv` (weak-aliased to main) — a wasm signature mismatch
 * that traps. Provide a strong 2-arg entry that calls the real 3-arg main with
 * `environ` (which wasi-libc populates from environ_get). No bash source edit. */
extern int main(int, char **, char **);
extern char **environ;
int __main_argc_argv(int argc, char **argv) {
  int length = __np_startup_cwd(NULL, 0);
  if (length < 0) return 1;
  char *cwd = malloc((size_t)length + 1);
  if (!cwd) return 1;
  int copied = __np_startup_cwd(cwd, (unsigned)length + 1);
  int rc = copied < 0 ? -1 : chdir(cwd);
  free(cwd);
  if (rc || capture_cwd()) return 1;
  return main(argc, argv, environ);
}

pid_t fork(void)  { if (capture_cwd()) return -1; int r = __np_fork(); if (r < 0) { errno = -r; return -1; } return r; }
pid_t vfork(void) { if (capture_cwd()) return -1; int r = __np_vfork(); if (r < 0) { errno = -r; return -1; } return r; }

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
  if (capture_cwd()) return -1;
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

/* dup/dup2 must operate on the nimbus_proc fd table (where pipe ends live), not
 * wasi-libc's fd_renumber (a separate namespace that EBADFs on pipe fds). Linked
 * with -Wl,--wrap=dup,--wrap=dup2 so every bash dup/dup2 routes here; wasi-libc's
 * originals become __real_* (unused). One fd namespace — the M3 FdTable. */
int __wrap_dup2(int o, int n) { int r = __np_dup2(o, n); if (r < 0) { errno = -r; return -1; } return r; }
int __wrap_dup(int o)         { int r = __np_dup(o);     if (r < 0) { errno = -r; return -1; } return r; }
int __wrap_fcntl(int fd, int cmd, ...) {
  /* F_DUPFD (0) — bash saves/restores fds via fcntl; route to the fd table. */
  if (cmd == F_DUPFD) { int r = __np_dup(fd); if (r < 0) { errno = -r; return -1; } return r; }
  /* bash probes F_GETFD to learn whether `exec N>file` must save fd N first;
   * a closed fd has to answer EBADF or bash dups a descriptor that is not there. */
  __wasi_fdstat_t st;
  if (__wasi_fd_fdstat_get(fd, &st) != 0) { errno = EBADF; return -1; }
  return 0; /* F_GETFD/F_SETFD/F_GETFL/F_SETFL: flags are tracked host-side */
}

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

/* Accounts (~user, $HOME's fallback) are the session's: nimbus-libc/nimbus-accounts.c. */

/* preview1 has no FIFO type: a pipe, or a stdin that is not a terminal, is
 * "unknown" to stat, as is a path naming one (/dev/stdin, /dev/fd/N). Such a
 * stat asks the runner for its mode and owner (bash-runner@6); one preview1
 * typed costs nothing more. */
IMPORT("stat_metadata") extern int __np_stat_metadata(int fd, const char *path, unsigned len, unsigned follow, unsigned out[3]);
int __real_stat(const char *path, struct stat *st);
int __real_lstat(const char *path, struct stat *st);
int __real_fstat(int fd, struct stat *st);
int __real_fstatat(int fd, const char *path, struct stat *st, int flag);
static int typed(int failed, int fd, const char *path, unsigned follow, struct stat *st)
{
	if (failed || (st->st_mode & S_IFMT)) return failed;
	unsigned out[3];
	if (__np_stat_metadata(fd == AT_FDCWD ? -1 : fd, path, path ? strlen(path) : 0, follow, out) == 0) {
		st->st_mode = out[0]; st->st_uid = out[1]; st->st_gid = out[2];
	}
	return 0;
}
int __wrap_stat(const char *p, struct stat *s) { return typed(__real_stat(p, s), AT_FDCWD, p, 1, s); }
int __wrap_lstat(const char *p, struct stat *s) { return typed(__real_lstat(p, s), AT_FDCWD, p, 0, s); }
int __wrap_fstat(int fd, struct stat *s) { return typed(__real_fstat(fd, s), fd, 0, 1, s); }
int __wrap_fstatat(int fd, const char *p, struct stat *s, int flag) { return typed(__real_fstatat(fd, p, s, flag), fd, p, !(flag & AT_SYMLINK_NOFOLLOW), s); }

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

/* The hooks only record what they saw, here, in the module's own memory: a
 * copy as (dst, src), a drop as (at, 0). The runner applies the records, in
 * order, before it is next asked anything (setjmp's capture, longjmp, every
 * unwind), so a hook is a store, not a call into the runner: thousands of
 * them a run cost a cold runner a microsecond or more each as calls. A full
 * log is handed over at once (nimbus_procenv.full, off asyncify's import
 * list: it never unwinds). The record is the log's only writer here; the
 * runner empties it. */
#define NIMBUS_PROCENV_RECORDS 512
static struct { uint32_t logged; uint32_t records[NIMBUS_PROCENV_RECORDS * 2]; } nimbus_procenv_log;
__attribute__((import_module("nimbus_procenv"), import_name("full"))) extern void __np_procenv_full(void);
/* Where the log is, for the runner: its count, then the records. */
__attribute__((export_name("nimbus_procenv_log"))) void *nimbus_procenv_log_at(void) { return &nimbus_procenv_log; }
static void nimbus_procenv_record(const void *at, const void *src) {
  if (nimbus_procenv_log.logged == NIMBUS_PROCENV_RECORDS) { __np_procenv_full(); nimbus_procenv_log.logged = 0; }
  uint32_t i = nimbus_procenv_log.logged++ * 2;
  nimbus_procenv_log.records[i] = (uint32_t)(uintptr_t)at;
  nimbus_procenv_log.records[i + 1] = (uint32_t)(uintptr_t)src;
}
void nimbus_procenv_copy(void *dst, const void *src) { memcpy(dst, src, sizeof(jmp_buf)); nimbus_procenv_record(dst, src); }
void nimbus_procenv_drop(void *at) { nimbus_procenv_record(at, 0); }

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
 * sigset ops operate on musl's sigset_t (array of unsigned long bit words),
 * which nimbus-proc.h puts in place of wasi-libc's one-byte placeholder. */
#ifndef NSIG
#define NSIG 65
#endif
static void (*__np_handlers[NSIG])(int);

/* Runner contract @3: query this instance's disposition, without exposing
 * guest addresses or invoking a handler. The host must refuse custom
 * delivery it does not implement, rather than converting it to SIG_DFL. */
__attribute__((export_name("__nimbus_signal_disposition")))
int __nimbus_signal_disposition(int sig) {
  if (sig < 1 || sig >= NSIG) return -1;
  if (sig == SIGKILL) return 0;
  if (__np_handlers[sig] == SIG_IGN) return 1;
  if (__np_handlers[sig] == SIG_DFL) return 0;
  return 2;
}

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

