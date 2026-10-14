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

#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>

#include "nimbus-fs.h"

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

/* The process's umask is the host's live one (nimbus-libc's nimbus_umask):
 * every file and directory the process creates is made under it, as a
 * kernel makes them. pip reads it too, for a wheel's file modes. */
mode_t umask(mode_t mask)
{
	return nimbus_umask(mask & 0777);
}

/* open(2), linked with --wrap=open: nimbus-libc's, which creates a file with
 * the mode asked for under the live umask; preview1 carries no mode. */
int __wrap_open(const char *path, int flags, ...)
{
	if (!(flags & O_CREAT)) {
		return nimbus_open(path, flags);
	}
	va_list ap;
	va_start(ap, flags);
	mode_t mode = (mode_t)va_arg(ap, int);
	va_end(ap);
	return nimbus_open(path, flags, mode);
}
