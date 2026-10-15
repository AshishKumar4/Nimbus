/* Signals a Nimbus host sends the process (nimbus-signal.h). Linked with
 *   -Wl,--wrap=raise -Wl,--wrap=poll
 * every raise comes here, the program's own and libc's: a signal whose
 * action is still the default one that ends a process ends it as Linux's
 * does, at once, quietly, with 128 + its number (wasi-libc's prints a line
 * and traps); any other is wasi-libc's. And a poll a signal interrupted
 * raises it (read, write and waitpid do: nimbus-restart.c, nimbus-proc.c). */
#include <poll.h>
#include <stdlib.h>
#include "nimbus-signal.h"

int __real_raise(int sig);
int __real_poll(struct pollfd *fds, nfds_t nfds, int timeout);

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

int __wrap_poll(struct pollfd *fds, nfds_t nfds, int timeout) {
  int ready = __real_poll(fds, nfds, timeout);
  if (ready < 0) nimbus_signal_taken();
  return ready;
}
