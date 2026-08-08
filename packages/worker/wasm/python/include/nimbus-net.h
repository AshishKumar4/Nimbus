/* Force-included into every wasm32-wasi translation unit that touches sockets.
 *
 * wasi-libc declares only the four calls WASI preview1 can express — accept,
 * send, recv, shutdown — and hides the rest behind `__wasilibc_use_wasip2`.
 * That macro cannot simply be defined: it also renumbers MSG_PEEK/MSG_WAITALL/
 * MSG_TRUNC away from the __WASI_RIFLAGS_* values the prebuilt libc.a compares
 * against, so the headers would stop agreeing with the archive.
 *
 * So the missing BSD surface is declared here instead and implemented in
 * nimbus-net.c, which routes it through the Nimbus WASI host's socket paths
 * (/dev/tcp/<host>/<port>, /dev/nimbus/listen/<port>). */
#ifndef NIMBUS_NET_H
#define NIMBUS_NET_H

/* Deliberately does not define _GNU_SOURCE. wasi-libc's strerror_r is the
 * POSIX one whatever the feature macros say, and OpenSSL picks its
 * GNU-returns-char* branch off _GNU_SOURCE alone. Callers that want the GNU
 * surface must set the macro on the command line, ahead of this header. */
#include <sys/socket.h>
#include <netinet/in.h>
#include <sys/types.h>

/* Socket-option names. wasi-libc defines only SO_TYPE and SOL_SOCKET outside
 * its wasip2 branch; the values below are that branch's, so both agree. */
#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif
#ifndef SOL_IP
#define SOL_IP 0
#endif
#ifndef SOL_TCP
#define SOL_TCP 6
#endif
#ifndef SOL_UDP
#define SOL_UDP 17
#endif
#ifndef SOL_IPV6
#define SOL_IPV6 41
#endif
#ifndef SO_DEBUG
#define SO_DEBUG 1
#endif
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_DONTROUTE
#define SO_DONTROUTE 5
#endif
#ifndef SO_BROADCAST
#define SO_BROADCAST 6
#endif
#ifndef SO_SNDBUF
#define SO_SNDBUF 7
#endif
#ifndef SO_RCVBUF
#define SO_RCVBUF 8
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef SO_OOBINLINE
#define SO_OOBINLINE 10
#endif
#ifndef SO_LINGER
#define SO_LINGER 13
#endif
#ifndef SO_REUSEPORT
#define SO_REUSEPORT 15
#endif
#ifndef SO_RCVLOWAT
#define SO_RCVLOWAT 18
#endif
#ifndef SO_SNDLOWAT
#define SO_SNDLOWAT 19
#endif
#ifndef SO_RCVTIMEO
#define SO_RCVTIMEO 20
#endif
#ifndef SO_SNDTIMEO
#define SO_SNDTIMEO 21
#endif
#ifndef SO_ACCEPTCONN
#define SO_ACCEPTCONN 30
#endif
#ifndef SO_PROTOCOL
#define SO_PROTOCOL 38
#endif
#ifndef SO_DOMAIN
#define SO_DOMAIN 39
#endif
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0x0040
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0x4000
#endif

#ifdef __cplusplus
extern "C" {
#endif

int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int bind(int, const struct sockaddr *, socklen_t);
int listen(int, int);
int getsockname(int, struct sockaddr *__restrict, socklen_t *__restrict);
int getpeername(int, struct sockaddr *__restrict, socklen_t *__restrict);
int setsockopt(int, int, int, const void *, socklen_t);
ssize_t sendto(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
ssize_t recvfrom(int, void *__restrict, size_t, int, struct sockaddr *__restrict,
                 socklen_t *__restrict);

in_addr_t inet_addr(const char *);
char *inet_ntoa(struct in_addr);

#ifdef __cplusplus
}
#endif
#endif /* NIMBUS_NET_H */
