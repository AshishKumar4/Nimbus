/* Minimal sys/wait.h overlay for wasi-libc (no processes; wait shims in
 * wasi-shim.c fail with ENOSYS). Maintained by Claude, as-is. */
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H
#include <sys/types.h>
#define WNOHANG 1
#define WUNTRACED 2
#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WIFSIGNALED(s) (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WTERMSIG(s) ((s) & 0x7f)
#define WIFSTOPPED(s) (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s) WEXITSTATUS(s)
pid_t wait(int *status);
pid_t waitpid(pid_t pid, int *status, int options);
#endif
