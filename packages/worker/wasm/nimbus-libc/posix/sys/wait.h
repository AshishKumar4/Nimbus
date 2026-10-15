/* sys/wait.h for wasi-libc, which ships none: bash's process layer
 * (nimbus-proc.c) implements wait and waitpid; BusyBox's answer ENOSYS. */
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H
#include <sys/types.h>
typedef int idtype_t;
pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
pid_t wait3(int *, int, void *);
pid_t wait4(pid_t, int *, int, void *);
#define WNOHANG    1
#define WUNTRACED  2
#define WCONTINUED 8
#define WEXITSTATUS(s)  (((s) >> 8) & 0xff)
#define WTERMSIG(s)     ((s) & 0x7f)
#define WSTOPSIG(s)     WEXITSTATUS(s)
#define WIFEXITED(s)    (WTERMSIG(s) == 0)
#define WIFSIGNALED(s)  (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WIFSTOPPED(s)   (((s) & 0xff) == 0x7f)
#define WIFCONTINUED(s) ((s) == 0xffff)
#define WCOREDUMP(s)    ((s) & 0x80)
#define WCOREFLAG       0x80
#endif
