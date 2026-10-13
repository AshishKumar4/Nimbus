/* Shared WASI process libc: pipe/dup/wait/kill and spawn over nimbus_proc.
 * argv/env/cwd and descriptors are encoded once here, not in Git sources. */
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "nimbus-proc.h"

/* ---- processes and pipes: the host's (nimbus_proc imports) ---- */

#define NIMBUS_PROC_IMPORT(name) __attribute__((import_module("nimbus_proc"), import_name(name)))
NIMBUS_PROC_IMPORT("pipe") int __nimbus_pipe(int *fds);
NIMBUS_PROC_IMPORT("dup") int __nimbus_dup(int fd, int *out);
NIMBUS_PROC_IMPORT("dup2") int __nimbus_dup2(int from, int to);
NIMBUS_PROC_IMPORT("spawn") int __nimbus_spawn(const char *argv, size_t argv_len, const char *env, size_t env_len,
    const char *dir, size_t dir_len, int fdin, int fdout, int fderr, int *pid);
NIMBUS_PROC_IMPORT("start") int __nimbus_start(int pid);
NIMBUS_PROC_IMPORT("wait") int __nimbus_wait(int pid, int options, int *status, int *waited);
NIMBUS_PROC_IMPORT("kill") int __nimbus_kill(int pid, int signal);

/* The imports answer 0 or a positive errno, as WASI calls do. */
static int nimbus_result(int error, int value) {
  if (error) { errno = error; return -1; }
  return value;
}

int pipe(int fds[2]) { return nimbus_result(__nimbus_pipe(fds), 0); }
int dup(int fd) { int out = -1; int error = __nimbus_dup(fd, &out); return nimbus_result(error, out); }
int dup2(int from, int to) { return nimbus_result(__nimbus_dup2(from, to), to); }
int kill(pid_t pid, int signal) { return nimbus_result(__nimbus_kill(pid, signal), 0); }

pid_t waitpid(pid_t pid, int *status, int options) {
  int st = 0, waited = -1;
  int error = __nimbus_wait(pid, options, &st, &waited);
  if (error) { errno = error; return -1; }
  if (status && waited > 0) *status = st;
  return waited;
}

/* `strings` (NULL-terminated) as one buffer of NUL-terminated strings. */
static char *joined(const char *const *strings, size_t *len) {
  size_t n = 0;
  for (size_t i = 0; strings[i]; i++) n += strlen(strings[i]) + 1;
  char *buf = malloc(n ? n : 1);
  if (!buf) return NULL;
  char *at = buf;
  for (size_t i = 0; strings[i]; i++) { size_t l = strlen(strings[i]) + 1; memcpy(at, strings[i], l); at += l; }
  *len = n;
  return buf;
}

/* Whether `entry` (NAME=value) is the variable `name` (NAME or NAME=...). */
static int same_variable(const char *entry, const char *name) {
  size_t n = strcspn(name, "=");
  return strncmp(entry, name, n) == 0 && entry[n] == '=';
}

extern char **environ;

pid_t nimbus_spawnvpe(const char *file, const char **argv, char **deltaenv, const char *dir, int fdin, int fdout, int fderr) {
  (void)file; /* argv[0] names the program; the host resolves it as the shell does */
  size_t count = 0, delta = 0;
  for (char **e = environ; e && *e; e++) count++;
  for (char **d = deltaenv; d && *d; d++) delta++;
  const char **env = calloc(count + delta + 1, sizeof *env);
  if (!env) { errno = ENOMEM; return -1; }
  size_t used = 0;
  for (char **e = environ; e && *e; e++) {
    int changed = 0;
    for (char **d = deltaenv; d && *d; d++) if (same_variable(*e, *d)) { changed = 1; break; }
    if (!changed) env[used++] = *e;
  }
  for (char **d = deltaenv; d && *d; d++) if (strchr(*d, '=')) env[used++] = *d;
  env[used] = NULL;

  /* The child's directory, absolute: the host has no cwd of this process's. */
  char cwd[4096];
  if (!dir || dir[0] != '/') {
    if (!getcwd(cwd, sizeof cwd)) { free(env); return -1; }
    if (dir && dir[0]) {
      size_t n = strlen(cwd);
      if (n + 1 + strlen(dir) + 1 > sizeof cwd) { free(env); errno = ENAMETOOLONG; return -1; }
      if (n > 1) cwd[n++] = '/';
      strcpy(cwd + n, dir);
    }
    dir = cwd;
  }
  size_t argv_len = 0, env_len = 0;
  char *argv_buf = joined(argv, &argv_len);
  char *env_buf = joined(env, &env_len);
  free(env);
  if (!argv_buf || !env_buf) { free(argv_buf); free(env_buf); errno = ENOMEM; return -1; }
  int pid = -1;
  int error = __nimbus_spawn(argv_buf, argv_len, env_buf, env_len, dir, strlen(dir), fdin, fdout, fderr, &pid);
  free(argv_buf);
  free(env_buf);
  if (error) { errno = error; return -1; }
  /*
   * As posix_spawn reports a program that is not there (ENOENT, which git
   * takes as "not a command") or no room to run it (EAGAIN): the host
   * answers once the child started, or was refused. A wait it gives up on
   * (EINTR) is asked again.
   */
  do error = __nimbus_start(pid); while (error == EINTR);
  return nimbus_result(error, pid);
}
