#ifndef NIMBUS_SIGNAL_H
#define NIMBUS_SIGNAL_H

#include <errno.h>
#include <signal.h>

/* What a Nimbus host answers a wait that a signal sent to the process
 * interrupted, to an image that takes its signals: NIMBUS_ESIGNAL plus the
 * signal's number (core runtime/wasi/types.ts NIMBUS_SIGNAL_ERRNOS). A
 * program never sees it: nimbus_signal_taken() raises the signal and makes
 * the failure EINTR. */
#define NIMBUS_ESIGNAL 1024

/* Signal numbers end below this (musl's and wasi-libc's 65). */
#ifndef _NSIG
#define _NSIG 65
#endif

/* After a call failed: if its errno is a signal its host sent, raise it (its
 * handler runs, or its default action ends the program: nimbus-signal.c) and
 * make the failure EINTR, as Linux runs a handler before the call it
 * interrupted returns. Whether it was one. */
static inline int nimbus_signal_taken(void) {
  int sig = errno - NIMBUS_ESIGNAL;
  if (sig <= 0 || sig >= _NSIG) return 0;
  raise(sig);
  errno = EINTR;
  return 1;
}

#endif
