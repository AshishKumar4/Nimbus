#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include "git-wasi-compat.h"

mode_t guest_umask(mode_t mask) { return umask(mask); }

int guest_create(const char *path, mode_t mode, int exclusive) {
  int fd = open(path, O_WRONLY | O_CREAT | (exclusive ? O_EXCL : 0), mode);
  if (fd < 0) return errno;
  return close(fd) < 0 ? errno : 0;
}
