/* Minimal sys/sysmacros.h overlay for wasi-libc. As-is. */
#ifndef _SYS_SYSMACROS_H
#define _SYS_SYSMACROS_H
#define major(dev) ((unsigned)(((dev) >> 8) & 0xff))
#define minor(dev) ((unsigned)((dev) & 0xff))
#define makedev(maj, min) ((((maj) & 0xff) << 8) | ((min) & 0xff))
#endif
