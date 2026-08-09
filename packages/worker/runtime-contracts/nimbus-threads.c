/*
 * nimbus-threads.c — the guest half of Nimbus pthread support.
 *
 * Link this into any wasm32-wasip1-threads program that should run on Nimbus:
 *
 *   clang --target=wasm32-wasip1-threads --sysroot=<wasi-sysroot> -pthread \
 *     -Wl,--import-memory,--shared-memory,--max-memory=67108864 \
 *     -o prog.wasm prog.c nimbus-threads.c
 *
 * Requires wasi-sdk 27 or newer. Older wasi-libc has no
 * __wasilibc_futex_wait_maybe_busy hook, so nothing calls the definition below,
 * the linker drops it as unreachable, and the build succeeds silently — leaving
 * a binary Nimbus refuses at load. Measured: 25 has no hook, 27 does.
 *
 * Why it is needed:
 *
 * wasi-libc implements every blocking pthread primitive — mutex, condvar,
 * pthread_join, barriers, semaphores — on top of one futex wait, and compiles
 * that wait to the `memory.atomic.wait32` INSTRUCTION. Workers construct their
 * isolates with atomics-wait disabled, so that instruction traps with
 * "Atomics.wait cannot be called in this context" the first time a lock is
 * actually contended. Nothing in the program is wrong; there is simply no
 * agent to be woken by, because a Nimbus process is one isolate.
 *
 * wasi-libc anticipates exactly this. `__wasilibc_futex_wait` calls the weak
 * symbol `__wasilibc_futex_wait_maybe_busy` when something defines it, and
 * only falls back to the instruction when nothing does. Defining it here
 * routes every libc futex wait to the host, which parks the calling thread on
 * its green-thread scheduler and resumes it when the word changes.
 *
 * There is deliberately no wake half. The matching `memory.atomic.notify` is
 * inlined throughout libc and cannot be hooked — and does not need to be: the
 * host futex is level-triggered, re-testing every waiter's word at every
 * scheduling point. See packages/worker/src/runtime/wasi-threads.ts.
 *
 * Return contract, matching wasi-libc's own `__wasilibc_futex_wait_atomic_wait`
 * so callers up the stack are unchanged: 0 woken, -EAGAIN if the word already
 * differs, -ETIMEDOUT when a finite deadline expires.
 */

#include <stdint.h>

extern int32_t __nimbus_futex_wait(volatile void *addr, int32_t expected, int64_t max_wait_ns)
	__attribute__((__import_module__("nimbus_threads"), __import_name__("futex_wait")));

int __wasilibc_futex_wait_maybe_busy(volatile void *addr, int op, int val, int64_t max_wait_ns)
{
	/* `op` distinguishes FUTEX_WAIT from its private variant, which only ever
	 * mattered for cross-process futexes on Linux. A wasm process is one
	 * address space. */
	(void)op;
	return __nimbus_futex_wait(addr, val, max_wait_ns);
}
