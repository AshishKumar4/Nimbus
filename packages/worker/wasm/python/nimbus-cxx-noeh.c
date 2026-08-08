/* The C++ throw path, for a sysroot that has no unwinder.
 *
 * numpy's C++ — pocketfft above all — throws to report bad input, and expects
 * the module's own catch block to turn that into a Python exception. wasi-sdk 25
 * cannot do that: its libc++abi defines no __cxa_throw, no __cxa_allocate_
 * exception and no __wasm_lpad_context, so neither the default model nor
 * -fwasm-exceptions links. Compiling with -fno-exceptions instead does not help,
 * because pocketfft_hdronly.h then fails to compile at all — 207 errors, every
 * one of them a `throw`.
 *
 * So the throw is kept compilable and made fatal, loudly. An exception here
 * takes the interpreter down with a message naming the cause instead of
 * unwinding to a handler that cannot run. That is a real difference from
 * CPython on a native platform, where numpy raises ValueError for the same
 * input; it is confined to numpy's C++ error paths, and it fails closed rather
 * than silently.
 *
 * This goes away when the interpreter moves to a wasi-sdk whose libc++abi is
 * built with exception support — at which point these definitions must be
 * dropped, or they will silently shadow the real ones.
 */
#include <stdio.h>
#include <stdlib.h>

void *__cxa_allocate_exception(size_t thrown_size)
{
	void *p = malloc(thrown_size);
	if (p == NULL) {
		fputs("nimbus: out of memory allocating a C++ exception\n", stderr);
		abort();
	}
	return p;
}

void __cxa_free_exception(void *thrown_exception)
{
	free(thrown_exception);
}

_Noreturn void __cxa_throw(void *thrown_exception, void *tinfo, void (*dest)(void *))
{
	(void)tinfo;
	if (dest != NULL) {
		dest(thrown_exception);
	}
	fputs("nimbus: a C++ exception was thrown, and this build has no unwinder "
	      "to catch it (see nimbus-cxx-noeh.c)\n", stderr);
	abort();
}
