/*
 * What GNU make needs of POSIX that wasi-libc lacks, from the shared Nimbus
 * libc shim (wasm/nimbus-libc): posix_spawn (nimbus-spawn.c) for its
 * recipes, waitpid, pipe and dup2 (nimbus-proc.c), and a file's mode and
 * owner, and a created file's mode (nimbus-fs.c); and of its own
 * (make-wasi-compat.c): exec as a child it waits for (make re-execs itself
 * after remaking a makefile), wait, mkstemp and tmpfile (a makefile read
 * from stdin), the signal mask, and no account lookups.
 */
#ifndef MAKE_WASI_COMPAT_H
#define MAKE_WASI_COMPAT_H
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include "nimbus-proc.h"
/* Signal sets and the mask, which wasi-libc gates out: kept, not applied
 * (make-wasi-compat.c). A signal the host sends is raised where a host call
 * returns (nimbus-signal.c), whatever the mask. */
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);
int execv(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int execvp(const char *, char *const[]);
int mkstemp(char *);
char *getlogin(void);
#include "nimbus-fs.h"
#define stat(path, buf) nimbus_stat(path, buf)
#define lstat nimbus_lstat
#define fstat nimbus_fstat
#define access nimbus_access
#define umask nimbus_umask
#define open(...) nimbus_open(__VA_ARGS__)
#endif
