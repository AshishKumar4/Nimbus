/*
 * exec, which WASI has none of, as make uses it: to run itself again after
 * remaking a makefile (main.c), and as exec_command's last resort. The
 * program runs as this process's child, through posix_spawn, with its
 * stdio, and this process waits for it and ends as it ended: what the
 * caller sees is one process that became the program. wait is waitpid on
 * any child; mkstemp and tmpfile, which wasi-libc leaves out, make their
 * file with the session's own modes (nimbus_open). No account is looked up:
 * getpwnam finds none and getlogin names none. The signal mask is kept for
 * sigprocmask to report, and applies to nothing: a signal is raised where a
 * host call returns.
 */
#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <spawn.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include "make-wasi-compat.h"

extern char **environ;

int execve(const char *path, char *const argv[], char *const envp[]) {
  pid_t child;
  int error = posix_spawn(&child, path, NULL, NULL, argv, envp);
  if (error) { errno = error; return -1; }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) if (errno != EINTR) _Exit(127);
  _Exit(WIFSIGNALED(status) ? 128 + WTERMSIG(status) : WEXITSTATUS(status));
}

int execv(const char *path, char *const argv[]) { return execve(path, argv, environ); }
int execvp(const char *file, char *const argv[]) { return execve(file, argv, environ); }

pid_t wait(int *status) { return waitpid(-1, status, 0); }

/* A new file of the caller's alone, named by `template` with its XXXXXX made unique (a makefile read from stdin). */
int mkstemp(char *template) {
  static const char letters[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  size_t n = strlen(template);
  if (n < 6 || strcmp(template + n - 6, "XXXXXX") != 0) { errno = EINVAL; return -1; }
  for (int attempt = 0; attempt < 100; attempt++) {
    unsigned char random[6];
    if (getentropy(random, sizeof random) != 0) return -1;
    for (size_t i = 0; i < 6; i++) template[n - 6 + i] = letters[random[i] % (sizeof letters - 1)];
    int fd = open(template, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  errno = EEXIST;
  return -1;
}

/* An anonymous file: one mkstemp made, its name gone at once, as make's own fallback makes one. */
FILE *tmpfile(void) {
  const char *dir = getenv("TMPDIR");
  char name[4096];
  if (snprintf(name, sizeof name, "%s/tmpfileXXXXXX", dir && *dir ? dir : "/tmp") >= (int)sizeof name) { errno = ENAMETOOLONG; return NULL; }
  int fd = mkstemp(name);
  if (fd < 0) return NULL;
  unlink(name);
  FILE *file = fdopen(fd, "w+");
  if (!file) close(fd);
  return file;
}

/* No account lookups reach this host: `~user` stays as written, and `~` is $HOME. */
struct passwd *getpwnam(const char *name) { (void)name; errno = ENOENT; return NULL; }
char *getlogin(void) { errno = ENXIO; return NULL; }

static sigset_t mask;

static int signal_bit(int sig, unsigned char **byte, unsigned char *bit, const sigset_t *set) {
  if (sig < 1 || (size_t)(sig - 1) >= 8 * sizeof *set) { errno = EINVAL; return -1; }
  *byte = (unsigned char *)set + (sig - 1) / 8;
  *bit = (unsigned char)(1u << ((sig - 1) % 8));
  return 0;
}
int sigemptyset(sigset_t *set) { memset(set, 0, sizeof *set); return 0; }
int sigfillset(sigset_t *set) { memset(set, 0xff, sizeof *set); return 0; }
int sigaddset(sigset_t *set, int sig) {
  unsigned char *byte, bit;
  if (signal_bit(sig, &byte, &bit, set)) return -1;
  *byte |= bit;
  return 0;
}
int sigdelset(sigset_t *set, int sig) {
  unsigned char *byte, bit;
  if (signal_bit(sig, &byte, &bit, set)) return -1;
  *byte &= (unsigned char)~bit;
  return 0;
}
int sigismember(const sigset_t *set, int sig) {
  unsigned char *byte, bit;
  if (signal_bit(sig, &byte, &bit, set)) return -1;
  return (*byte & bit) != 0;
}
int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
  if (old) *old = mask;
  if (!set) return 0;
  const unsigned char *in = (const unsigned char *)set;
  unsigned char *now = (unsigned char *)&mask;
  for (size_t i = 0; i < sizeof mask; i++) {
    if (how == SIG_BLOCK) now[i] |= in[i];
    else if (how == SIG_UNBLOCK) now[i] &= (unsigned char)~in[i];
    else if (how == SIG_SETMASK) now[i] = in[i];
    else { errno = EINVAL; return -1; }
  }
  return 0;
}
