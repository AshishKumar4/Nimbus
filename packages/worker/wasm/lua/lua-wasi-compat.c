/* These ISO C functions have no wasi-libc implementation. Lua's existing
 * result helpers report the unsupported operation without a guest trap. */
#include <errno.h>
#include <stdio.h>

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
