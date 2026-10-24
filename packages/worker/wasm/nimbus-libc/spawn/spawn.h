/* spawn.h for wasi-libc, which ships none: posix_spawn over the host's
 * nimbus_proc.spawn (nimbus-libc/nimbus-spawn.c). In a directory of its own,
 * for the images that link it (make): bash's and BusyBox's builds search
 * ../posix, and a spawn.h there would change what their configure finds. A child gets only fds 0, 1
 * and 2, so a file action dup2s one of the parent's descriptors onto one of
 * them, and a close is the child's already; signal attributes are kept and
 * mean nothing to a child that starts with none blocked. */
#ifndef _SPAWN_H
#define _SPAWN_H
#include <signal.h>
#include <sys/types.h>

#define POSIX_SPAWN_RESETIDS      0x01
#define POSIX_SPAWN_SETPGROUP     0x02
#define POSIX_SPAWN_SETSIGDEF     0x04
#define POSIX_SPAWN_SETSIGMASK    0x08
#define POSIX_SPAWN_SETSCHEDPARAM 0x10
#define POSIX_SPAWN_SETSCHEDULER  0x20

typedef struct { short flags; sigset_t mask; sigset_t def; } posix_spawnattr_t;
/* What the child's 0, 1 and 2 are: a descriptor of the parent's, or -1 for closed. */
typedef struct { int fd[3]; } posix_spawn_file_actions_t;

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]);
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]);
int posix_spawn_file_actions_init(posix_spawn_file_actions_t *actions);
int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *actions);
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *actions, int fd, int newfd);
int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *actions, int fd);
int posix_spawnattr_init(posix_spawnattr_t *attr);
int posix_spawnattr_destroy(posix_spawnattr_t *attr);
int posix_spawnattr_setflags(posix_spawnattr_t *attr, short flags);
int posix_spawnattr_getflags(const posix_spawnattr_t *attr, short *flags);
int posix_spawnattr_setsigmask(posix_spawnattr_t *attr, const sigset_t *mask);
int posix_spawnattr_getsigmask(const posix_spawnattr_t *attr, sigset_t *mask);
int posix_spawnattr_setsigdefault(posix_spawnattr_t *attr, const sigset_t *def);
int posix_spawnattr_getsigdefault(const posix_spawnattr_t *attr, sigset_t *def);
#endif
