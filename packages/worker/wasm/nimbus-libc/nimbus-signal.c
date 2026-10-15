/* Signals a Nimbus host sends the process. To an image that takes them
 * (git-runner@2), the host answers a wait a signal interrupted
 * NIMBUS_ESIGNAL plus the signal's number (core runtime/wasi/types.ts
 * NIMBUS_SIGNAL_ERRNOS). Linked with
 *   -Wl,--wrap=__wasi_fd_read -Wl,--wrap=__wasi_fd_write
 *   -Wl,--wrap=__wasi_poll_oneoff -Wl,--wrap=__nimbus_wait -Wl,--wrap=raise
 * such an answer raises the signal where the host call returns, as Linux
 * runs a handler before the call it interrupted returns, and the call fails
 * EINTR (read, write, poll, waitpid; nimbus-restart.c passes EINTR on). A
 * signal whose action is still the default one that ends a process ends it
 * at once, quietly, with 128 + its number (wasi-libc's raise prints a line
 * and traps); any other raise is wasi-libc's. */
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <wasi/api.h>

#define NIMBUS_ESIGNAL 1024

/* Signal numbers end below this (musl's and wasi-libc's 65). */
#ifndef _NSIG
#define _NSIG 65
#endif

int __real_raise(int sig);
__wasi_errno_t __real___wasi_fd_read(__wasi_fd_t fd, const __wasi_iovec_t *iovs, size_t iovs_len, __wasi_size_t *nread);
__wasi_errno_t __real___wasi_fd_write(__wasi_fd_t fd, const __wasi_ciovec_t *iovs, size_t iovs_len, __wasi_size_t *nwritten);
__wasi_errno_t __real___wasi_poll_oneoff(const __wasi_subscription_t *in, __wasi_event_t *out, __wasi_size_t nsubscriptions, __wasi_size_t *nevents);
int __real___nimbus_wait(int pid, int options, int *status, int *waited);

/* Whether the default action of `sig` ends a process (POSIX: terminate or core). */
static int ends_process(int sig) {
  switch (sig) {
    case SIGCHLD: case SIGCONT: case SIGURG: case SIGWINCH:
    case SIGSTOP: case SIGTSTP: case SIGTTIN: case SIGTTOU:
      return 0;
    default:
      return sig > 0 && sig < _NSIG;
  }
}

int __wrap_raise(int sig) {
  void (*handler)(int) = signal(sig, SIG_DFL);
  if (handler == SIG_ERR) return __real_raise(sig);
  signal(sig, handler);
  if (handler == SIG_DFL && ends_process(sig)) _Exit(128 + sig);
  return __real_raise(sig);
}

/* A host call's error: a signal the host sent is raised, and the call fails EINTR. */
static int taken(int error) {
  int sig = error - NIMBUS_ESIGNAL;
  if (sig <= 0 || sig >= _NSIG) return error;
  raise(sig);
  return EINTR;
}

__wasi_errno_t __wrap___wasi_fd_read(__wasi_fd_t fd, const __wasi_iovec_t *iovs, size_t iovs_len, __wasi_size_t *nread) {
  return taken(__real___wasi_fd_read(fd, iovs, iovs_len, nread));
}

__wasi_errno_t __wrap___wasi_fd_write(__wasi_fd_t fd, const __wasi_ciovec_t *iovs, size_t iovs_len, __wasi_size_t *nwritten) {
  return taken(__real___wasi_fd_write(fd, iovs, iovs_len, nwritten));
}

__wasi_errno_t __wrap___wasi_poll_oneoff(const __wasi_subscription_t *in, __wasi_event_t *out, __wasi_size_t nsubscriptions, __wasi_size_t *nevents) {
  return taken(__real___wasi_poll_oneoff(in, out, nsubscriptions, nevents));
}

int __wrap___nimbus_wait(int pid, int options, int *status, int *waited) {
  return taken(__real___nimbus_wait(pid, options, status, waited));
}
