/* BusyBox's termios: the shared declarations (nimbus-libc/posix/termios.h)
 * and what BusyBox adds. */
#ifndef _NIMBUS_BUSYBOX_TERMIOS_H
#define _NIMBUS_BUSYBOX_TERMIOS_H
#include_next <termios.h>
/* Baud-rate constants (musl encoding) — busybox libbb/speed_table.c. */
#define B50 1
#define B75 2
#define B110 3
#define B134 4
#define B150 5
#define B200 6
#define B300 7
#define B600 8
#define B1200 9
#define B1800 10
#define B2400 11
#define B4800 12
#define B19200 14
#define B57600 0x1001
#define B115200 0x1002
#define B230400 0x1003
/* Terminal window size (busybox get_terminal_width_height). The Nimbus
 * runtime answers ioctl() with -1, so callers fall back to 80x24. */
struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#endif
#ifndef TIOCSWINSZ
#define TIOCSWINSZ 0x5414
#endif
#endif
