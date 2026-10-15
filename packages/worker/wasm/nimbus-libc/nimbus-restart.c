/* Restartable reads and writes: the guest half of NIMBUS_ERESTART
 * (nimbus-restart.h). Linked with
 *   -Wl,--wrap=read -Wl,--wrap=readv -Wl,--wrap=write -Wl,--wrap=writev
 * every call to them, wasi-libc's own included (stdio's __stdio_read and
 * __stdio_write), comes here: a call the host gave up waiting on is asked
 * again, with errno as it was, and any other result, EINTR included, is the
 * caller's. */
#include <errno.h>
#include <sys/types.h>
#include <sys/uio.h>
#include "nimbus-restart.h"

ssize_t __real_read(int fd, void *buf, size_t count);
ssize_t __real_readv(int fd, const struct iovec *iov, int iovcnt);
ssize_t __real_write(int fd, const void *buf, size_t count);
ssize_t __real_writev(int fd, const struct iovec *iov, int iovcnt);

#define RESTARTING(call)                                  \
  do {                                                    \
    int saved = errno;                                    \
    for (;;) {                                            \
      ssize_t n = (call);                                 \
      if (n >= 0 || errno != NIMBUS_ERESTART) return n;   \
      errno = saved;                                      \
    }                                                     \
  } while (0)

ssize_t __wrap_read(int fd, void *buf, size_t count) { RESTARTING(__real_read(fd, buf, count)); }
ssize_t __wrap_readv(int fd, const struct iovec *iov, int iovcnt) { RESTARTING(__real_readv(fd, iov, iovcnt)); }
ssize_t __wrap_write(int fd, const void *buf, size_t count) { RESTARTING(__real_write(fd, buf, count)); }
ssize_t __wrap_writev(int fd, const struct iovec *iov, int iovcnt) { RESTARTING(__real_writev(fd, iov, iovcnt)); }
