/* Minimal netdb.h overlay for wasi-libc (no networking applets are built;
 * libbb.h includes this unconditionally). Also supplies the socket type
 * constants absent from wasi-libc's sys/socket.h that libbb.h's
 * compile-time BUG_too_small check references. Maintained by Claude, as-is. */
#ifndef _NETDB_H
#define _NETDB_H
#include <sys/socket.h>
struct hostent { char *h_name; char **h_aliases; int h_addrtype; int h_length; char **h_addr_list; };
struct servent { char *s_name; char **s_aliases; int s_port; char *s_proto; };
#ifndef SOCK_RAW
#define SOCK_RAW 3
#endif
#ifndef SOCK_RDM
#define SOCK_RDM 4
#endif
#ifndef SOCK_SEQPACKET
#define SOCK_SEQPACKET 5
#endif
extern int h_errno;
#define HOST_NOT_FOUND 1
#define TRY_AGAIN 2
#define NO_RECOVERY 3
#define NO_DATA 4
#define NO_ADDRESS NO_DATA
struct hostent *gethostbyname(const char *name);
struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type);
const char *hstrerror(int err);
#endif
