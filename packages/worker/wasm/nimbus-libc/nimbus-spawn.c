/* posix_spawn over nimbus_proc.spawn (core runtime/wasi/processes.ts): the
 * program by name or path, which the host finds as the shell does; the
 * child's whole environment and argv; its directory this process's (there
 * is no fork to inherit it from); its 0, 1 and 2 the descriptors the file
 * actions name. An error is returned, as posix_spawn returns one, never set
 * in errno. */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>

#define NIMBUS_PROC_IMPORT(name) __attribute__((import_module("nimbus_proc"), import_name(name)))
NIMBUS_PROC_IMPORT("spawn") int __nimbus_spawn(const char *argv, size_t argv_len, const char *env, size_t env_len,
    const char *dir, size_t dir_len, int fdin, int fdout, int fderr, int *pid);
NIMBUS_PROC_IMPORT("start") int __nimbus_start(int pid);

extern char **environ;

/* `strings` (NULL-terminated), `first` in place of the first, as one buffer of NUL-terminated strings. */
static char *joined(const char *first, char *const strings[], size_t *len) {
  size_t n = 0;
  for (size_t i = 0; strings && strings[i]; i++) n += strlen(i == 0 && first ? first : strings[i]) + 1;
  char *buf = malloc(n ? n : 1);
  if (!buf) return NULL;
  char *at = buf;
  for (size_t i = 0; strings && strings[i]; i++) {
    const char *s = i == 0 && first ? first : strings[i];
    size_t l = strlen(s) + 1;
    memcpy(at, s, l);
    at += l;
  }
  *len = n;
  return buf;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  (void)attr;
  if (!argv || !argv[0]) return EINVAL;
  char dir[4096];
  if (!getcwd(dir, sizeof dir)) return errno;
  size_t argv_len = 0, env_len = 0;
  /* The program is `path`, as exec runs it; argv[0] is only its name, which the host resolves. */
  char *argv_buf = joined(path, argv, &argv_len);
  char *env_buf = joined(NULL, envp ? envp : environ, &env_len);
  if (!argv_buf || !env_buf) { free(argv_buf); free(env_buf); return ENOMEM; }
  int fds[3] = { 0, 1, 2 };
  if (actions) memcpy(fds, actions->fd, sizeof fds);
  int child = -1;
  int error = __nimbus_spawn(argv_buf, argv_len, env_buf, env_len, dir, strlen(dir), fds[0], fds[1], fds[2], &child);
  free(argv_buf);
  free(env_buf);
  if (error) return error;
  /* The host answers once the child started, or was refused; a wait it gave up on is asked again. */
  do error = __nimbus_start(child); while (error == EINTR);
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
  return 0;
}
int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *actions) { (void)actions; return 0; }
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *actions, int fd, int newfd) {
  if (fd < 0 || newfd < 0) return EBADF;
  if (newfd > 2) return ENOTSUP;
  actions->fd[newfd] = fd;
  return 0;
}
int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *actions, int fd) {
  if (fd < 0) return EBADF;
  if (fd <= 2) actions->fd[fd] = -1;
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
