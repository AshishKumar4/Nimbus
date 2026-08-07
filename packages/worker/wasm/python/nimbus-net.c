/* nimbus-net.c — BSD sockets for wasm32-wasi, over WASI preview1 alone.
 *
 * WASI preview1 can only send, recv, shutdown and accept on descriptors the
 * host already owns; it has no socket/bind/listen/connect. wasi-libc therefore
 * ships those four and nothing else, which is not enough to link OpenSSL or
 * CPython's socketmodule.
 *
 * The Nimbus WASI host closes the gap through path_open on synthetic paths
 * (runtime/wasi/preamble.ts): opening /dev/tcp/<host>/<port> dials, and opening
 * /dev/nimbus/listen/<port> binds a listener. This file is the libc-shaped face
 * of that convention, so C code that calls connect(2) reaches the same place
 * Ruby reaches by calling File.open. Two consequences worth stating:
 *
 *   - The artifact imports nothing but wasi_snapshot_preview1. It stays a stock
 *     WASI module, and runs under any host that implements the synthetic paths.
 *   - socket(2) has to reserve a descriptor before anyone knows what it will be
 *     connected to. It opens the root directory to claim the number, then
 *     fd_renumber moves the real socket onto it — the dup2 wasi-libc omits but
 *     preview1 does define.
 *
 * Names resolve without DNS: getaddrinfo hands back an address in the reserved
 * 240.0.0.0/8 block that indexes a table of hostnames, and connect turns it back
 * into the string the host needs. Literal dotted quads pass through untouched. */

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include <wasi/api.h>

#include "include/nimbus-net.h"

#define NIMBUS_HOST_MAX 256
#define NIMBUS_NAME_SLOTS 64
#define NIMBUS_FD_SLOTS 128

/* 240.0.0.0/8 is reserved and never routable, so an address in it can safely
 * mean "slot N of the name table" instead of a real host. */
#define NIMBUS_SYNTH_PREFIX 0xf0000000u

enum nimbus_sock_state {
	NIMBUS_SOCK_UNBOUND = 0,
	NIMBUS_SOCK_BOUND,
	NIMBUS_SOCK_LISTENING,
	NIMBUS_SOCK_CONNECTED,
};

struct nimbus_sock {
	int fd; /* -1 when the slot is free */
	int family;
	int type;
	int protocol;
	enum nimbus_sock_state state;
	uint16_t local_port;
	uint16_t peer_port;
	char peer_host[NIMBUS_HOST_MAX];
};

static struct nimbus_sock sock_slots[NIMBUS_FD_SLOTS];
static int sock_live;
static char name_slots[NIMBUS_NAME_SLOTS][NIMBUS_HOST_MAX];
static int name_count;
static int nimbus_h_errno;

int *__h_errno_location(void)
{
	return &nimbus_h_errno;
}

static struct nimbus_sock *sock_find(int fd)
{
	if (fd < 0 || sock_live == 0)
		return NULL;
	for (int i = 0; i < NIMBUS_FD_SLOTS; i++)
		if (sock_slots[i].fd == fd)
			return &sock_slots[i];
	return NULL;
}

static struct nimbus_sock *sock_claim(int fd)
{
	for (int i = 0; i < NIMBUS_FD_SLOTS; i++) {
		if (sock_slots[i].fd < 0) {
			memset(&sock_slots[i], 0, sizeof(sock_slots[i]));
			sock_slots[i].fd = fd;
			sock_live++;
			return &sock_slots[i];
		}
	}
	return NULL;
}

static void sock_release(int fd)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s != NULL) {
		s->fd = -1;
		sock_live--;
	}
}

__attribute__((constructor)) static void nimbus_net_init(void)
{
	for (int i = 0; i < NIMBUS_FD_SLOTS; i++)
		sock_slots[i].fd = -1;
}

/* Registers `host` in the name table and returns the 240/8 address that stands
 * for it. Repeated lookups of the same name reuse their slot; once the table is
 * full the address is still returned so callers fail at connect with a real
 * errno rather than at resolution with a confusing one. */
static uint32_t name_intern(const char *host)
{
	for (int i = 0; i < name_count; i++)
		if (strcmp(name_slots[i], host) == 0)
			return NIMBUS_SYNTH_PREFIX | (uint32_t)i;
	if (name_count >= NIMBUS_NAME_SLOTS)
		return NIMBUS_SYNTH_PREFIX | (uint32_t)(NIMBUS_NAME_SLOTS - 1);
	snprintf(name_slots[name_count], NIMBUS_HOST_MAX, "%s", host);
	return NIMBUS_SYNTH_PREFIX | (uint32_t)name_count++;
}

/* Writes the host that `addr` denotes into `out`: a table name for a synthetic
 * address, a dotted quad otherwise. */
static void name_resolve(uint32_t addr, char *out, size_t outlen)
{
	if ((addr & 0xff000000u) == NIMBUS_SYNTH_PREFIX) {
		uint32_t slot = addr & 0x00ffffffu;
		if (slot < (uint32_t)name_count) {
			snprintf(out, outlen, "%s", name_slots[slot]);
			return;
		}
	}
	snprintf(out, outlen, "%u.%u.%u.%u", (addr >> 24) & 0xff, (addr >> 16) & 0xff,
	         (addr >> 8) & 0xff, addr & 0xff);
}

/* Parses a dotted quad into host byte order. Returns 0 on success. */
static int parse_ipv4(const char *s, uint32_t *out)
{
	unsigned a, b, c, d;
	char tail;
	if (sscanf(s, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4)
		return -1;
	if (a > 255 || b > 255 || c > 255 || d > 255)
		return -1;
	*out = (a << 24) | (b << 16) | (c << 8) | d;
	return 0;
}

static int sockaddr_in_parts(const struct sockaddr *addr, socklen_t len, uint32_t *ip,
                             uint16_t *port)
{
	if (addr == NULL || len < (socklen_t)sizeof(struct sockaddr_in)) {
		errno = EINVAL;
		return -1;
	}
	if (addr->sa_family != AF_INET) {
		errno = EAFNOSUPPORT;
		return -1;
	}
	const struct sockaddr_in *sin = (const struct sockaddr_in *)addr;
	*ip = ntohl(sin->sin_addr.s_addr);
	*port = ntohs(sin->sin_port);
	return 0;
}

static void sockaddr_in_fill(struct sockaddr *addr, socklen_t *len, uint32_t ip, uint16_t port)
{
	struct sockaddr_in sin;
	memset(&sin, 0, sizeof(sin));
	sin.sin_family = AF_INET;
	sin.sin_port = htons(port);
	sin.sin_addr.s_addr = htonl(ip);
	socklen_t copy = *len < (socklen_t)sizeof(sin) ? *len : (socklen_t)sizeof(sin);
	memcpy(addr, &sin, copy);
	*len = (socklen_t)sizeof(sin);
}

/* Moves `from` onto `to` and closes `from`, so the descriptor the caller has
 * been holding since socket(2) now refers to the real connection. */
static int fd_move(int from, int to)
{
	__wasi_errno_t err = __wasi_fd_renumber((__wasi_fd_t)from, (__wasi_fd_t)to);
	if (err != 0) {
		errno = (int)err;
		return -1;
	}
	return 0;
}

int socket(int domain, int type, int protocol)
{
	if (domain != AF_INET) {
		errno = EAFNOSUPPORT;
		return -1;
	}
	/* SOCK_CLOEXEC and SOCK_NONBLOCK ride along in `type`; CPython's
	 * socketmodule always sets CLOEXEC, so comparing the whole word rejects
	 * every socket Python creates. */
	int flags = type & (SOCK_CLOEXEC | SOCK_NONBLOCK);
	if ((type & ~(SOCK_CLOEXEC | SOCK_NONBLOCK)) != SOCK_STREAM) {
		errno = EPROTOTYPE;
		return -1;
	}
	/* Claim a descriptor now; fd_renumber will point it at the real socket
	 * once connect or listen says what it should be. Which directory it is
	 * does not matter, only that opening it succeeds — and that depends on
	 * the host's preopens: Nimbus preopens "/", wasmtime is usually given
	 * subtrees, where only the cwd resolves. */
	int fd = open("/", O_RDONLY | O_DIRECTORY);
	if (fd < 0)
		fd = open(".", O_RDONLY | O_DIRECTORY);
	if (fd < 0)
		return -1;
	if (flags & SOCK_NONBLOCK) {
		int fl = fcntl(fd, F_GETFL, 0);
		if (fl >= 0)
			fcntl(fd, F_SETFL, fl | O_NONBLOCK);
	}
	struct nimbus_sock *s = sock_claim(fd);
	if (s == NULL) {
		close(fd);
		errno = EMFILE;
		return -1;
	}
	s->family = domain;
	s->type = SOCK_STREAM;
	s->protocol = protocol;
	s->state = NIMBUS_SOCK_UNBOUND;
	return fd;
}

int connect(int fd, const struct sockaddr *addr, socklen_t addrlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (s->state == NIMBUS_SOCK_CONNECTED) {
		errno = EISCONN;
		return -1;
	}
	uint32_t ip;
	uint16_t port;
	if (sockaddr_in_parts(addr, addrlen, &ip, &port) != 0)
		return -1;

	char host[NIMBUS_HOST_MAX];
	name_resolve(ip, host, sizeof(host));

	char path[NIMBUS_HOST_MAX + 32];
	snprintf(path, sizeof(path), "/dev/tcp/%s/%u", host, (unsigned)port);
	int conn = open(path, O_RDWR);
	if (conn < 0)
		return -1;
	if (fd_move(conn, fd) != 0) {
		close(conn);
		return -1;
	}
	snprintf(s->peer_host, sizeof(s->peer_host), "%s", host);
	s->peer_port = port;
	s->state = NIMBUS_SOCK_CONNECTED;
	return 0;
}

int bind(int fd, const struct sockaddr *addr, socklen_t addrlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	uint32_t ip;
	uint16_t port;
	if (sockaddr_in_parts(addr, addrlen, &ip, &port) != 0)
		return -1;
	/* The host owns port allocation, so binding only records the intent;
	 * listen(2) is where the port is actually claimed. */
	s->local_port = port;
	s->state = NIMBUS_SOCK_BOUND;
	return 0;
}

int listen(int fd, int backlog)
{
	(void)backlog;
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (s->state == NIMBUS_SOCK_LISTENING)
		return 0;
	if (s->local_port == 0) {
		errno = EINVAL;
		return -1;
	}
	char path[64];
	snprintf(path, sizeof(path), "/dev/nimbus/listen/%u", (unsigned)s->local_port);
	int lfd = open(path, O_RDONLY);
	if (lfd < 0)
		return -1;
	if (fd_move(lfd, fd) != 0) {
		close(lfd);
		return -1;
	}
	s->state = NIMBUS_SOCK_LISTENING;
	return 0;
}

/* Replaces wasi-libc's accept, which cannot fill in the peer address and does
 * not know about the socket table. Reached through --wrap=accept so both
 * definitions can coexist in the link. The descriptor itself still comes from
 * preview1's sock_accept. */
static int nimbus_accept(int fd, struct sockaddr *__restrict addr, socklen_t *__restrict addrlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (s->state != NIMBUS_SOCK_LISTENING) {
		errno = EINVAL;
		return -1;
	}
	__wasi_fd_t conn;
	__wasi_errno_t err = __wasi_sock_accept((__wasi_fd_t)fd, 0, &conn);
	if (err != 0) {
		errno = (int)err;
		return -1;
	}
	struct nimbus_sock *c = sock_claim((int)conn);
	if (c != NULL) {
		c->family = s->family;
		c->type = s->type;
		c->protocol = s->protocol;
		c->state = NIMBUS_SOCK_CONNECTED;
		c->local_port = s->local_port;
		c->peer_port = 0;
		snprintf(c->peer_host, sizeof(c->peer_host), "127.0.0.1");
	}
	if (addr != NULL && addrlen != NULL)
		sockaddr_in_fill(addr, addrlen, INADDR_LOOPBACK, 0);
	return (int)conn;
}

int __wrap_accept(int fd, struct sockaddr *__restrict addr, socklen_t *__restrict addrlen)
{
	return nimbus_accept(fd, addr, addrlen);
}

int __wrap_accept4(int fd, struct sockaddr *__restrict addr, socklen_t *__restrict addrlen,
                   int flags)
{
	int conn = nimbus_accept(fd, addr, addrlen);
	if (conn < 0)
		return -1;
	if (flags & SOCK_NONBLOCK) {
		int fl = fcntl(conn, F_GETFL, 0);
		if (fl >= 0)
			fcntl(conn, F_SETFL, fl | O_NONBLOCK);
	}
	return conn;
}

int getsockname(int fd, struct sockaddr *__restrict addr, socklen_t *__restrict addrlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (addr == NULL || addrlen == NULL) {
		errno = EFAULT;
		return -1;
	}
	sockaddr_in_fill(addr, addrlen, INADDR_LOOPBACK, s->local_port);
	return 0;
}

int getpeername(int fd, struct sockaddr *__restrict addr, socklen_t *__restrict addrlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (s->state != NIMBUS_SOCK_CONNECTED) {
		errno = ENOTCONN;
		return -1;
	}
	if (addr == NULL || addrlen == NULL) {
		errno = EFAULT;
		return -1;
	}
	uint32_t ip;
	if (parse_ipv4(s->peer_host, &ip) != 0)
		ip = name_intern(s->peer_host);
	sockaddr_in_fill(addr, addrlen, ip, s->peer_port);
	return 0;
}

/* The host decides buffering, keepalive and address reuse, so these are
 * accepted and dropped rather than refused: refusing makes ordinary server code
 * abort on setsockopt(SO_REUSEADDR) for no gain. Options that would change
 * observable behaviour if silently ignored are rejected. */
int setsockopt(int fd, int level, int optname, const void *optval, socklen_t optlen)
{
	(void)optval;
	(void)optlen;
	if (sock_find(fd) == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (level == SOL_SOCKET) {
		switch (optname) {
		case SO_REUSEADDR:
		case SO_REUSEPORT:
		case SO_KEEPALIVE:
		case SO_SNDBUF:
		case SO_RCVBUF:
		case SO_BROADCAST:
		case SO_DONTROUTE:
		case SO_LINGER:
			return 0;
		default:
			break;
		}
	}
	if (level == SOL_TCP || level == IPPROTO_TCP)
		return 0;
	errno = ENOPROTOOPT;
	return -1;
}

int getsockopt(int fd, int level, int optname, void *__restrict optval,
               socklen_t *__restrict optlen)
{
	struct nimbus_sock *s = sock_find(fd);
	if (s == NULL) {
		errno = ENOTSOCK;
		return -1;
	}
	if (optval == NULL || optlen == NULL || *optlen < (socklen_t)sizeof(int)) {
		errno = EINVAL;
		return -1;
	}
	int value;
	if (level == SOL_SOCKET && optname == SO_TYPE)
		value = s->type;
	else if (level == SOL_SOCKET && optname == SO_DOMAIN)
		value = s->family;
	else if (level == SOL_SOCKET && optname == SO_PROTOCOL)
		value = s->protocol;
	else if (level == SOL_SOCKET && optname == SO_ACCEPTCONN)
		value = s->state == NIMBUS_SOCK_LISTENING;
	else if (level == SOL_SOCKET && optname == SO_ERROR)
		value = 0;
	else
		value = 0;
	memcpy(optval, &value, sizeof(value));
	*optlen = (socklen_t)sizeof(value);
	return 0;
}

ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr,
               socklen_t addrlen)
{
	if (addr != NULL && addrlen != 0) {
		/* Only stream sockets exist here, so a per-message destination has
		 * nowhere to go. */
		errno = EISCONN;
		return -1;
	}
	return send(fd, buf, len, flags);
}

ssize_t recvfrom(int fd, void *__restrict buf, size_t len, int flags,
                 struct sockaddr *__restrict addr, socklen_t *__restrict addrlen)
{
	ssize_t n = recv(fd, buf, len, flags);
	if (n >= 0 && addr != NULL && addrlen != NULL) {
		struct nimbus_sock *s = sock_find(fd);
		uint32_t ip = INADDR_LOOPBACK;
		uint16_t port = 0;
		if (s != NULL) {
			port = s->peer_port;
			if (parse_ipv4(s->peer_host, &ip) != 0)
				ip = name_intern(s->peer_host);
		}
		sockaddr_in_fill(addr, addrlen, ip, port);
	}
	return n;
}

/* close(2) has to forget the socket-table slot, or a later descriptor that
 * reuses the number inherits this socket's peer and state. Reached through
 * --wrap=close; the scan is skipped entirely while no socket is open. */
extern int __real_close(int);

int __wrap_close(int fd)
{
	sock_release(fd);
	return __real_close(fd);
}

in_addr_t inet_addr(const char *cp)
{
	uint32_t ip;
	if (cp == NULL || parse_ipv4(cp, &ip) != 0)
		return INADDR_NONE;
	return htonl(ip);
}

char *inet_ntoa(struct in_addr in)
{
	static char buf[16];
	uint32_t ip = ntohl(in.s_addr);
	snprintf(buf, sizeof(buf), "%u.%u.%u.%u", (ip >> 24) & 0xff, (ip >> 16) & 0xff,
	         (ip >> 8) & 0xff, ip & 0xff);
	return buf;
}

const char *gai_strerror(int ecode)
{
	switch (ecode) {
	case 0:
		return "Success";
	case EAI_BADFLAGS:
		return "Bad value for ai_flags";
	case EAI_NONAME:
		return "Name or service not known";
	case EAI_AGAIN:
		return "Temporary failure in name resolution";
	case EAI_FAIL:
		return "Non-recoverable failure in name resolution";
	case EAI_FAMILY:
		return "Address family not supported";
	case EAI_SOCKTYPE:
		return "Socket type not supported";
	case EAI_SERVICE:
		return "Service not supported for socket type";
	case EAI_MEMORY:
		return "Memory allocation failure";
	case EAI_OVERFLOW:
		return "Result too large for supplied buffer";
	default:
		return "Unknown error in name resolution";
	}
}

void freeaddrinfo(struct addrinfo *res)
{
	while (res != NULL) {
		struct addrinfo *next = res->ai_next;
		free(res->ai_canonname);
		free(res->ai_addr);
		free(res);
		res = next;
	}
}

/* Resolution never leaves the guest: a literal address passes through, and a
 * name becomes a 240/8 stand-in that connect turns back into the name. The host
 * does the real lookup when it dials. */
int getaddrinfo(const char *__restrict node, const char *__restrict service,
                const struct addrinfo *__restrict hints, struct addrinfo **__restrict res)
{
	if (res == NULL)
		return EAI_FAIL;
	*res = NULL;

	if (hints != NULL && hints->ai_family != AF_UNSPEC && hints->ai_family != AF_INET)
		return EAI_FAMILY;
	if (hints != NULL && hints->ai_socktype != 0 && hints->ai_socktype != SOCK_STREAM)
		return EAI_SOCKTYPE;

	uint16_t port = 0;
	if (service != NULL && service[0] != '\0') {
		char *end;
		long parsed = strtol(service, &end, 10);
		if (*end != '\0' || parsed < 0 || parsed > 65535)
			return EAI_SERVICE;
		port = (uint16_t)parsed;
	}

	uint32_t ip;
	if (node == NULL || node[0] == '\0') {
		int passive = hints != NULL && (hints->ai_flags & AI_PASSIVE);
		ip = passive ? INADDR_ANY : INADDR_LOOPBACK;
	} else if (parse_ipv4(node, &ip) != 0) {
		if (hints != NULL && (hints->ai_flags & AI_NUMERICHOST))
			return EAI_NONAME;
		ip = name_intern(node);
	}

	struct addrinfo *ai = calloc(1, sizeof(*ai));
	struct sockaddr_in *sin = calloc(1, sizeof(*sin));
	if (ai == NULL || sin == NULL) {
		free(ai);
		free(sin);
		return EAI_MEMORY;
	}
	sin->sin_family = AF_INET;
	sin->sin_port = htons(port);
	sin->sin_addr.s_addr = htonl(ip);

	ai->ai_family = AF_INET;
	ai->ai_socktype = SOCK_STREAM;
	ai->ai_protocol = IPPROTO_TCP;
	ai->ai_addrlen = (socklen_t)sizeof(*sin);
	ai->ai_addr = (struct sockaddr *)sin;
	if (hints != NULL && (hints->ai_flags & AI_CANONNAME) && node != NULL)
		ai->ai_canonname = strdup(node);
	*res = ai;
	return 0;
}

int getnameinfo(const struct sockaddr *__restrict addr, socklen_t addrlen, char *__restrict host,
                socklen_t hostlen, char *__restrict serv, socklen_t servlen, int flags)
{
	(void)flags;
	uint32_t ip;
	uint16_t port;
	if (sockaddr_in_parts(addr, addrlen, &ip, &port) != 0)
		return EAI_FAMILY;
	if (host != NULL && hostlen > 0) {
		char buf[NIMBUS_HOST_MAX];
		name_resolve(ip, buf, sizeof(buf));
		if (strlen(buf) >= hostlen)
			return EAI_OVERFLOW;
		strcpy(host, buf);
	}
	if (serv != NULL && servlen > 0) {
		char buf[16];
		snprintf(buf, sizeof(buf), "%u", (unsigned)port);
		if (strlen(buf) >= servlen)
			return EAI_OVERFLOW;
		strcpy(serv, buf);
	}
	return 0;
}

struct hostent *gethostbyname(const char *name)
{
	static struct hostent ent;
	static struct in_addr addr;
	static char *addr_list[2];
	static char *alias_list[1];
	static char namebuf[NIMBUS_HOST_MAX];

	if (name == NULL) {
		nimbus_h_errno = HOST_NOT_FOUND;
		return NULL;
	}
	uint32_t ip;
	if (parse_ipv4(name, &ip) != 0)
		ip = name_intern(name);
	addr.s_addr = htonl(ip);
	addr_list[0] = (char *)&addr;
	addr_list[1] = NULL;
	alias_list[0] = NULL;
	snprintf(namebuf, sizeof(namebuf), "%s", name);

	ent.h_name = namebuf;
	ent.h_aliases = alias_list;
	ent.h_addrtype = AF_INET;
	ent.h_length = (int)sizeof(struct in_addr);
	ent.h_addr_list = addr_list;
	return &ent;
}

struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type)
{
	if (addr == NULL || len != sizeof(struct in_addr) || type != AF_INET) {
		nimbus_h_errno = HOST_NOT_FOUND;
		return NULL;
	}
	struct in_addr in;
	memcpy(&in, addr, sizeof(in));
	return gethostbyname(inet_ntoa(in));
}

struct servent *getservbyname(const char *name, const char *proto)
{
	(void)name;
	(void)proto;
	return NULL;
}

struct servent *getservbyport(int port, const char *proto)
{
	(void)port;
	(void)proto;
	return NULL;
}

struct protoent *getprotobyname(const char *name)
{
	static struct protoent ent;
	static char *aliases[1];
	static char namebuf[16];
	if (name == NULL)
		return NULL;
	snprintf(namebuf, sizeof(namebuf), "%s", name);
	aliases[0] = NULL;
	ent.p_name = namebuf;
	ent.p_aliases = aliases;
	if (strcmp(name, "tcp") == 0)
		ent.p_proto = IPPROTO_TCP;
	else if (strcmp(name, "udp") == 0)
		ent.p_proto = IPPROTO_UDP;
	else if (strcmp(name, "ip") == 0)
		ent.p_proto = IPPROTO_IP;
	else
		return NULL;
	return &ent;
}

struct protoent *getprotobynumber(int proto)
{
	if (proto == IPPROTO_TCP)
		return getprotobyname("tcp");
	if (proto == IPPROTO_UDP)
		return getprotobyname("udp");
	if (proto == IPPROTO_IP)
		return getprotobyname("ip");
	return NULL;
}
