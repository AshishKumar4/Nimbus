/* Minimal termios overlay for wasi-libc (which ships no termios.h). Lets bash's
 * tty code (shtty.c, rltty.c, jobs.c) compile against the termios path instead
 * of the absent BSD sgtty path. tcgetattr/tcsetattr route to the nimbus_proc
 * tty imports (the RuntimeTtyOptions seam); non-interactive `bash -c` / scripts
 * don't exercise them. Maintained by Claude, presented as-is. */
#ifndef _TERMIOS_H
#define _TERMIOS_H
#include <sys/types.h>

typedef unsigned char cc_t;
typedef unsigned int  speed_t;
typedef unsigned int  tcflag_t;

#define NCCS 32
struct termios {
  tcflag_t c_iflag, c_oflag, c_cflag, c_lflag;
  cc_t     c_line;
  cc_t     c_cc[NCCS];
  speed_t  c_ispeed, c_ospeed;
};

/* c_cc indices */
#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define VSWTC 7
#define VSTART 8
#define VSTOP 9
#define VSUSP 10
#define VEOL 11
#define VREPRINT 12
#define VDISCARD 13
#define VWERASE 14
#define VLNEXT 15
#define VEOL2 16

/* c_iflag */
#define IGNBRK 0000001
#define BRKINT 0000002
#define IGNPAR 0000004
#define PARMRK 0000010
#define INPCK  0000020
#define ISTRIP 0000040
#define INLCR  0000100
#define IGNCR  0000200
#define ICRNL  0000400
#define IXON   0002000
#define IXANY  0004000
#define IXOFF  0010000
#define IMAXBEL 0020000
#define IUTF8  0040000
/* c_oflag */
#define OPOST  0000001
#define ONLCR  0000004
#define TAB3   0014000
/* c_cflag */
#define CSIZE  0000060
#define CS5 0000000
#define CS6 0000020
#define CS7 0000040
#define CS8 0000060
#define CSTOPB 0000100
#define CREAD  0000200
#define PARENB 0000400
#define PARODD 0001000
#define HUPCL  0002000
#define CLOCAL 0004000
/* c_lflag */
#define ISIG   0000001
#define ICANON 0000002
#define ECHO   0000010
#define ECHOE  0000020
#define ECHOK  0000040
#define ECHONL 0000100
#define NOFLSH 0000200
#define TOSTOP 0000400
#define IEXTEN 0100000
#define ECHOCTL 0001000
#define ECHOKE  0004000

/* optional_actions */
#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2
/* tcflush */
#define TCIFLUSH  0
#define TCOFLUSH  1
#define TCIOFLUSH 2
/* tcflow */
#define TCOOFF 0
#define TCOON  1
#define TCIOFF 2
#define TCION  3
/* baud */
#define B0 0
#define B9600 0000015
#define B38400 0000017
#define B115200 0010002

int tcgetattr(int, struct termios *);
int tcsetattr(int, int, const struct termios *);
int tcflush(int, int);
int tcdrain(int);
int tcflow(int, int);
int tcsendbreak(int, int);
speed_t cfgetispeed(const struct termios *);
speed_t cfgetospeed(const struct termios *);
int cfsetispeed(struct termios *, speed_t);
int cfsetospeed(struct termios *, speed_t);
int cfsetspeed(struct termios *, speed_t);
pid_t tcgetsid(int);

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
