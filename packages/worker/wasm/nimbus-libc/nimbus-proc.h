#ifndef NIMBUS_PROC_H
#define NIMBUS_PROC_H
#include <sys/types.h>

/* The no-fork spawn backend: fdin/fdout/fderr become 0/1/2; -1 is closed.
 * deltaenv contains NAME=value to set and NAME to unset; dir may be NULL.
 * The current import's argv[0] names the executable, so file must equal it.
 * Returns the child pid after start acknowledgement, or -1 with errno. */
pid_t nimbus_spawnvpe(const char *file, const char **argv, char **deltaenv,
                     const char *dir, int fdin, int fdout, int fderr);
int pipe(int fds[2]);
int dup(int fd);
int dup2(int from, int to);
int kill(pid_t pid, int signal);
pid_t waitpid(pid_t pid, int *status, int options);
#endif
