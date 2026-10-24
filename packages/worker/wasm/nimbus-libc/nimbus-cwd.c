/* The working directory a process starts in. wasi-libc starts every process
 * at "/", resolving relative paths against its own cwd over the "/" preopen;
 * this changes to the directory its host started it in
 * (nimbus_proc.startup_dir, core runtime/wasi/processes.ts) before main, as
 * exec leaves a process in its parent's. A directory it cannot enter ends
 * the process, as a shell's `cd` failing before exec would. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((import_module("nimbus_proc"), import_name("startup_dir")))
int __nimbus_startup_dir(char *buf, size_t capacity, size_t *length);

__attribute__((constructor)) static void nimbus_startup_cwd(void) {
  size_t length = 0;
  char *dir = NULL;
  int error = __nimbus_startup_dir(NULL, 0, &length);
  if (!error && !(dir = calloc(length + 1, 1))) error = ENOMEM;
  if (!error) error = __nimbus_startup_dir(dir, length + 1, &length);
  if (!error && chdir(dir) != 0) error = errno;
  if (!error) { free(dir); return; }
  fprintf(stderr, "cannot start in %s: %s\n", dir && dir[0] ? dir : "the startup directory", strerror(error));
  _Exit(127);
}
