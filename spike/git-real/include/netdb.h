#pragma once
#include <sys/socket.h>
struct hostent { char *h_name; char **h_aliases; int h_addrtype; int h_length; char **h_addr_list; };
#define h_addr h_addr_list[0]
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
#define AI_CANONNAME 2
#define NI_MAXHOST 1025
struct hostent *gethostbyname(const char *name);
int getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r);
void freeaddrinfo(struct addrinfo *a);
const char *gai_strerror(int e);
