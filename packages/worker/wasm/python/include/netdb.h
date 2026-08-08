/* wasi-libc ships no <netdb.h> because WASI preview1 has no name resolution.
 * OpenSSL's include/internal/sockets.h and CPython's Modules/socketmodule.c
 * both include it unconditionally, so the header has to exist for the target
 * to compile at all. The declarations below are the POSIX ones; the symbols
 * are supplied by nimbus-net.c, which forwards them to the host. */
#ifndef _NETDB_H
#define _NETDB_H

#include <stddef.h>
#include <sys/socket.h>
#include <netinet/in.h>

#ifdef __cplusplus
extern "C" {
#endif

struct addrinfo {
	int ai_flags;
	int ai_family;
	int ai_socktype;
	int ai_protocol;
	socklen_t ai_addrlen;
	struct sockaddr *ai_addr;
	char *ai_canonname;
	struct addrinfo *ai_next;
};

struct hostent {
	char *h_name;
	char **h_aliases;
	int h_addrtype;
	int h_length;
	char **h_addr_list;
};
#define h_addr h_addr_list[0]

struct servent {
	char *s_name;
	char **s_aliases;
	int s_port;
	char *s_proto;
};

struct protoent {
	char *p_name;
	char **p_aliases;
	int p_proto;
};

#define AI_PASSIVE      0x01
#define AI_CANONNAME    0x02
#define AI_NUMERICHOST  0x04
#define AI_V4MAPPED     0x08
#define AI_ALL          0x10
#define AI_ADDRCONFIG   0x20
#define AI_NUMERICSERV  0x400

#define NI_NUMERICHOST  0x01
#define NI_NUMERICSERV  0x02
#define NI_NOFQDN       0x04
#define NI_NAMEREQD     0x08
#define NI_DGRAM        0x10
#define NI_MAXHOST      255
#define NI_MAXSERV      32

#define EAI_BADFLAGS   (-1)
#define EAI_NONAME     (-2)
#define EAI_AGAIN      (-3)
#define EAI_FAIL       (-4)
#define EAI_FAMILY     (-6)
#define EAI_SOCKTYPE   (-7)
#define EAI_SERVICE    (-8)
#define EAI_MEMORY     (-10)
#define EAI_SYSTEM     (-11)
#define EAI_OVERFLOW   (-12)

#define HOST_NOT_FOUND 1
#define TRY_AGAIN      2
#define NO_RECOVERY    3
#define NO_DATA        4
#define NO_ADDRESS     NO_DATA

int getaddrinfo(const char *__restrict, const char *__restrict,
                const struct addrinfo *__restrict, struct addrinfo **__restrict);
void freeaddrinfo(struct addrinfo *);
const char *gai_strerror(int);
int getnameinfo(const struct sockaddr *__restrict, socklen_t,
                char *__restrict, socklen_t, char *__restrict, socklen_t, int);

struct hostent *gethostbyname(const char *);
struct hostent *gethostbyaddr(const void *, socklen_t, int);
int gethostbyname_r(const char *, struct hostent *, char *, size_t,
                    struct hostent **, int *);
int gethostbyaddr_r(const void *, socklen_t, int, struct hostent *, char *,
                    size_t, struct hostent **, int *);

struct servent *getservbyname(const char *, const char *);
struct servent *getservbyport(int, const char *);
struct protoent *getprotobyname(const char *);
struct protoent *getprotobynumber(int);

int *__h_errno_location(void);
#define h_errno (*__h_errno_location())

#ifdef __cplusplus
}
#endif
#endif /* _NETDB_H */
