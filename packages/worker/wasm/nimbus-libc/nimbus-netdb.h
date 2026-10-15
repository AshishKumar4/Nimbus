/* The netdb records and h_errno codes every target's <netdb.h> declares
 * (python/include/netdb.h, bash/coreutils/overlay/netdb.h); each adds what
 * it implements, and its own h_errno. */
#ifndef NIMBUS_NETDB_H
#define NIMBUS_NETDB_H

struct hostent {
	char *h_name;
	char **h_aliases;
	int h_addrtype;
	int h_length;
	char **h_addr_list;
};

struct servent {
	char *s_name;
	char **s_aliases;
	int s_port;
	char *s_proto;
};

#define HOST_NOT_FOUND 1
#define TRY_AGAIN      2
#define NO_RECOVERY    3
#define NO_DATA        4
#define NO_ADDRESS     NO_DATA

#endif
