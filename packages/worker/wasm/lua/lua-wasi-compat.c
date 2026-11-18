/* These ISO C functions have no wasi-libc implementation. Lua's existing
 * result helpers report the unsupported operation without a guest trap. */
#include <errno.h>
#include <signal.h>
#include <stdio.h>

/* Yield to the JSPI host during bytecode execution, and deliver the signal
 * through the same raise wrapper used by the blocked-I/O path. */
__attribute__((import_module("nimbus_proc"), import_name("signal_check")))
int __nimbus_signal_check(void);

void nimbus_lua_poll_signal(void) {
  const int signal_base = 1024;
  int answer = __nimbus_signal_check();
  if (answer > signal_base) raise(answer - signal_base);
}

int __wrap_system(const char *command) {
  if (command == NULL) return 0;
  errno = ENOTSUP;
  return -1;
}

char *__wrap_tmpnam(char *name) {
  (void)name;
  errno = ENOTSUP;
  return NULL;
}

FILE *__wrap_tmpfile(void) {
  errno = ENOTSUP;
  return NULL;
}
