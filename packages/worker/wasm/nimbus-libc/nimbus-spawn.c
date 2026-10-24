/* posix_spawn over nimbus_spawnvpe (nimbus-proc.c), the one encoding of a
 * child for nimbus_proc.spawn and the wait for its start: the program
 * `path`, which the host finds by name or path as the shell does, with
 * argv's arguments; the child's whole environment `envp`; its directory
 * this process's; its 0, 1 and 2 as the file actions left them. An error is
 * returned, as posix_spawn returns one, never left in errno. */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <spawn.h>
#include "nimbus-proc.h"

extern char **environ;

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  (void)attr;
  if (!path || !argv || !argv[0]) return EINVAL;
  if (actions && actions->error) return actions->error;
  size_t argc = 0;
  while (argv[argc]) argc++;
  const char **args = calloc(argc + 1, sizeof *args);
  if (!args) return ENOMEM;
  /* The program is `path`, as exec runs it; the host resolves argv[0]. */
  args[0] = path;
  for (size_t i = 1; i < argc; i++) args[i] = argv[i];
  /* nimbus_spawnvpe gives the child this process's environment changed by
   * its delta: with none of its own for the call (one thread), the delta is
   * the whole of envp. */
  char **own = environ;
  environ = NULL;
  int saved = errno;
  pid_t child = nimbus_spawnvpe(path, args, envp ? (char **)envp : own, NULL,
      actions ? actions->fd[0] : 0, actions ? actions->fd[1] : 1, actions ? actions->fd[2] : 2);
  int error = child < 0 ? errno : 0;
  environ = own;
  errno = saved;
  free(args);
  if (error) return error;
  if (pid) *pid = child;
  return 0;
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  return posix_spawn(pid, file, actions, attr, argv, envp);
}

int posix_spawn_file_actions_init(posix_spawn_file_actions_t *actions) {
  for (int i = 0; i < 3; i++) actions->fd[i] = i;
  actions->closed = NULL;
  actions->nclosed = 0;
  actions->error = 0;
  return 0;
}

int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *actions) {
  free(actions->closed);
  actions->closed = NULL;
  actions->nclosed = 0;
  return 0;
}

/* Applied now, in order: `fd` is what the child's fd is after the actions before this one. */
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *actions, int fd, int newfd) {
  if (fd < 0 || newfd < 0) return EBADF;
  if (newfd > 2) return ENOTSUP;
  int source = fd <= 2 ? actions->fd[fd] : fd;
  for (size_t i = 0; fd > 2 && i < actions->nclosed; i++) {
    if (actions->closed[i] == fd && !actions->error) actions->error = EBADF;
  }
  actions->fd[newfd] = source;
  return 0;
}

int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *actions, int fd) {
  if (fd < 0) return EBADF;
  if (fd <= 2) return ENOTSUP;
  int *closed = realloc(actions->closed, (actions->nclosed + 1) * sizeof *closed);
  if (!closed) return ENOMEM;
  closed[actions->nclosed++] = fd;
  actions->closed = closed;
  return 0;
}

int posix_spawnattr_init(posix_spawnattr_t *attr) { memset(attr, 0, sizeof *attr); return 0; }
int posix_spawnattr_destroy(posix_spawnattr_t *attr) { (void)attr; return 0; }
int posix_spawnattr_setflags(posix_spawnattr_t *attr, short flags) { attr->flags = flags; return 0; }
int posix_spawnattr_getflags(const posix_spawnattr_t *attr, short *flags) { *flags = attr->flags; return 0; }
int posix_spawnattr_setsigmask(posix_spawnattr_t *attr, const sigset_t *mask) { attr->mask = *mask; return 0; }
int posix_spawnattr_getsigmask(const posix_spawnattr_t *attr, sigset_t *mask) { *mask = attr->mask; return 0; }
int posix_spawnattr_setsigdefault(posix_spawnattr_t *attr, const sigset_t *def) { attr->def = *def; return 0; }
int posix_spawnattr_getsigdefault(const posix_spawnattr_t *attr, sigset_t *def) { *def = attr->def; return 0; }
