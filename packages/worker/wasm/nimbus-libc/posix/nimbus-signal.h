/* What bash's process layer (nimbus-proc.h) and BusyBox
 * (overlay/nimbus-wasi-compat.h) both declare of sigaction, which wasi-libc
 * gates out: its flags, the mask operations and the set calls. Each declares
 * its own struct sigaction (bash's handler takes a siginfo_t) before this. */
#ifndef NIMBUS_SIGNAL_H
#define NIMBUS_SIGNAL_H
#include <signal.h>
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO   4
#define SA_ONSTACK   0x08000000
#define SA_RESTART   0x10000000
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#ifndef SIG_BLOCK
#define SIG_BLOCK   0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigsuspend(const sigset_t *);
#endif
