/* nimbus-wasi-compat.c — the places wasi-libc and CPython disagree.
 *
 * CPython builds for WASI with posix_threads=stub, so Python/thread.c defines
 * its own no-op pthread_mutex_*, pthread_cond_* and TLS. wasi-libc ships the
 * same no-ops. Overlapping definitions are harmless right up until something
 * references a symbol CPython's set omits: OpenSSL calls pthread_cond_broadcast,
 * that pulls wasi-libc's condvar.o into the link, and condvar.o arrives carrying
 * pthread_cond_init/destroy/signal/wait, which CPython has already defined.
 *
 * Defining the one missing symbol here keeps condvar.o out of the link, so
 * CPython's stubs stay the only definitions. A broadcast is genuinely a no-op:
 * with no threads there is never a waiter to wake.
 *
 * It has to be weak. configure links dozens of probe programs that contain
 * OpenSSL but not Python/thread.c, so condvar.o is pulled in after all and a
 * strong definition here becomes a duplicate-symbol error. That error is
 * invisible — configure just records the probe as a failure — and the build
 * silently comes out without _ssl and _hashlib. Weak means condvar.o wins
 * wherever it is present and this definition is used only when it is not. */

#include <pthread.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>

__attribute__((weak)) int pthread_cond_broadcast(pthread_cond_t *cond)
{
	(void)cond;
	return 0;
}

/* pthread_once has the same shape of problem and one extra twist: wasi-libc's
 * lives in an object that also defines pthread_exit, with a different signature
 * from CPython's, so pulling it in leaves the link with two incompatible
 * pthread_exits and a trapping stub between them. Supplying it here keeps that
 * object out. It cannot be a no-op the way broadcast can — OpenSSL does its
 * one-time initialisation through it, and skipping that would leave the library
 * unusable rather than merely unsynchronised. */
__attribute__((weak)) int pthread_once(pthread_once_t *control, void (*init)(void))
{
	if (control == NULL || init == NULL) {
		return 0;
	}
	if (*control == 0) {
		*control = 1;
		init();
	}
	return 0;
}

/* WASI has no notion of a user, so wasi-libc omits the identity calls
 * entirely — and a great deal of ordinary Python assumes they are there.
 * pip is the case that forced this: its vendored platformdirs does a bare
 * `from os import getuid` at import time, so every pip invocation died before
 * reaching a wheel. The value matches what Nimbus's other WASI guest reports
 * (bash, runtime/bash/preamble.ts). */
uid_t getuid(void)
{
	return 0;
}

uid_t geteuid(void)
{
	return 0;
}

gid_t getgid(void)
{
	return 0;
}

gid_t getegid(void)
{
	return 0;
}

/* -lwasi-emulated-mman declares msync but does not define it, so linking
 * CPython's mmap module fails. Every mapping that can exist here is anonymous —
 * wasi-libc's mmap refuses a file descriptor — and flushing an anonymous
 * mapping has nothing to write back. */
int msync(void *addr, size_t length, int flags)
{
	(void)addr;
	(void)length;
	(void)flags;
	return 0;
}

/* WASI has no umask because it has no permission enforcement to apply one to.
 * Python still reads it — pip computes a wheel's file modes as 0o666 & ~umask —
 * so the value has to be somewhere. Holding it in the process is not a
 * simplification: a umask is process state everywhere, and the only part WASI
 * is missing is a kernel that consults it. */
static mode_t nimbus_umask = 022;

mode_t umask(mode_t mask)
{
	mode_t previous = nimbus_umask;
	nimbus_umask = mask & 0777;
	return previous;
}
