/* Shadows the wasi-sysroot header of the same name, which declares
 * `struct sockaddr_un` with only `sun_family` because WASI has no AF_UNIX.
 * OpenSSL's bio_addr.c and CPython's socketmodule.c both compile references to
 * `sun_path`, so the member has to exist. Nothing in libc consumes this struct
 * on wasm32-wasi, so widening it is layout-safe: AF_UNIX operations fail at the
 * syscall, not at the struct. */
#ifndef __wasilibc___struct_sockaddr_un_h
#define __wasilibc___struct_sockaddr_un_h

#include <__typedef_sa_family_t.h>

struct sockaddr_un {
	sa_family_t sun_family;
	char sun_path[108];
};

#endif
