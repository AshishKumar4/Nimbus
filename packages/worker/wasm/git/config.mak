# git for wasm32-wasi (wasi-sdk), as build-git.sh builds it. build-git.sh
# passes GIT_WASI_DIR (this directory), WASI_SDK and SYSROOT_EXTRA (where it
# installed zlib), and the target's uname, which config.mak.uname reads before
# this file can set it.
GIT_WASI_COMPAT_H = $(GIT_WASI_DIR)/git-wasi-compat.h
CC = $(WASI_SDK)/bin/wasm32-wasi-clang
AR = $(WASI_SDK)/bin/llvm-ar
# NO_FORK: patches/0002-spawn-through-the-host.patch. start_command starts
# a child through the host (wasm/nimbus-libc/nimbus-proc.c), as
# Windows does through mingw_spawnvpe: there is no fork.
# NO_MMAP_PAGED: patches/0001-pack-index-paged.patch. A pack index is read
# in pages as lookups need them instead of whole (NO_MMAP would read all of
# it: 60 MiB for a history of two million objects, in a 128 MiB isolate).
CFLAGS = -O2 -g0 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
  -I$(GIT_WASI_DIR)/include -I$(GIT_WASI_DIR)/../nimbus-libc -I$(SYSROOT_EXTRA)/include -include $(GIT_WASI_COMPAT_H)
LDFLAGS = -L$(SYSROOT_EXTRA)/lib -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
  -Wl,-z,stack-size=8388608 -Wl,--initial-memory=12582912 -Wl,--max-memory=2147483648
COMPAT_OBJS += compat/git-wasi-compat.o compat/nimbus-fs.o compat/nimbus-proc.o
# Git's default prefix is the builder's $HOME, baked into the binary as the
# root of its template, exec and documentation paths. /usr is where a
# session's git claims to live; the system configuration comes from
# GIT_CONFIG_SYSTEM (the runner sets it) and there are no templates.
prefix = /usr
sysconfdir = /etc
NO_PTHREADS = YesPlease
NO_FORK = YesPlease
NO_MMAP = YesPlease
NO_MMAP_PAGED = YesPlease
NO_CURL = YesPlease
NO_EXPAT = YesPlease
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_ICONV = YesPlease
NO_OPENSSL = YesPlease
NO_REGEX = YesPlease
NO_IPV6 = YesPlease
NO_UNIX_SOCKETS = YesPlease
NO_SETITIMER = YesPlease
NO_STRUCT_ITIMERVAL = YesPlease
NO_POSIX_GOODIES = UnfortunatelyYes
NO_SYS_SELECT_H = YesPlease
NO_NSEC = YesPlease
NO_INSTALL_HARDLINKS = YesPlease
NO_PREAD =
NO_POLL_H = YesPlease
NO_SYS_POLL_H = YesPlease
NO_GETPAGESIZE =
NO_FSMONITOR = YesPlease
NO_MKDTEMP =
NEEDS_LIBRT =
HAVE_DEV_TTY =
NO_RUST = YesPlease
CSPRNG_METHOD = getentropy
HAVE_GETDELIM = YesPlease
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
NO_UNCOMPRESS2 =
SANE_TOOL_PATH =
INSTALL_SYMLINKS = YesPlease
DEFAULT_PAGER = cat
DEFAULT_EDITOR = vi
