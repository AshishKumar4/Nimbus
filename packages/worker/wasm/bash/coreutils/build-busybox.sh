#!/usr/bin/env bash
# Build BusyBox 1.37.0 -> wasm32-wasi: the comprehensive coreutils set the
# bash-runner stages as exec targets (one multicall binary, applet dispatch
# on argv[0]). The published busybox.wasm is built by ../build-in-bwrap.sh,
# which runs this with pinned sources in a sandbox, after build-bash.sh.
#
# Requires: wasi-sdk 25 (WASI_SDK), an extracted BusyBox 1.37.0 tree
# (BUSYBOX_SRC), and a host gcc and make for kconfig.
#
# Route notes (all proven, 2026-07-21):
#  - Plain synchronous WASI command module: exec'd coreutils never fork, so
#    no asyncify/fpcast pass is needed (unlike bash itself).
#  - setjmp (test/[ error recovery, NOFORK plumbing) uses wasm
#    exception-handling SjLj (-mlvm -wasm-enable-sjlj + -lsetjmp). V8
#    executes it natively; the bash binary's asyncify-based setjmp overlay
#    prohibition does NOT apply because this module is never asyncified.
#  - overlay/ and nimbus-libc/posix supply the headers wasi-libc omits
#    (netdb/pwd/grp/paths/mntent/termios/sigaction/...); wasi-shim.c the
#    process-less, signal-free implementations, and nimbus-accounts.c the
#    session's accounts.
#  - libbb/xconnect.c is dead network-helper code (no net applets) that
#    cannot compile against wasi-libc's socket surface; it is gated out.
#  - --wrap=stat family synthesizes st_blocks (du) and default mode bits
#    (ls -l) that WASI preview1 filestat cannot carry. --wrap=chmod routes
#    to the nimbus_proc.chmod runtime import (preview1 has no mode syscall).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NIMBUS_LIBC="$(cd "$HERE/../../nimbus-libc" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
: "${BUSYBOX_SRC:?set BUSYBOX_SRC to an extracted busybox-1.37.0 source tree}"
CC_BASE="$WASI_SDK/bin/wasm32-wasi-clang"
# -std=gnu17: busybox's pre-C23 code under clang 19. The emulated-feature
# defines mirror build-bash.sh. -include: compat decls for every file. The
# overlay comes before nimbus-libc/posix: its termios.h adds to the shared one.
INCLUDES="-isystem $HERE/overlay -isystem $NIMBUS_LIBC/posix"
CC="$CC_BASE -std=gnu17 -mllvm -wasm-enable-sjlj \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  $INCLUDES -include $HERE/overlay/nimbus-wasi-compat.h"

cd "$BUSYBOX_SRC"
# Dead network-helper code: no networking applet is configured, and
# xconnect.c cannot compile against wasi-libc's socket surface. Gate it
# behind a config that is always off here.
sed -i 's/^lib-y += xconnect.o/lib-$(CONFIG_FEATURE_IPV6) += xconnect.o/' libbb/Kbuild.src
# Applet selection: allnoconfig, then flip busybox-wasi.config's =y entries.
# (This kconfig fork's KCONFIG_ALLCONFIG resets fragment values on its
# allnoconfig double-run, so the flip goes through .config directly.)
if [ ! -f .config ]; then
  make -s allnoconfig >/dev/null
  while IFS== read -r k v; do
    case "$k" in
      CONFIG_*)
        if [ "$v" = y ]; then
          sed -i "s/^# $k is not set/$k=y/" .config
          grep -q "^$k=y" .config || echo "$k=y" >> .config
        fi
        ;;
    esac
  done < "$HERE/busybox-wasi.config"
  # allnoconfig's SH_IS_ASH default would drag the ash shell (fork-based) in.
  sed -i 's/^CONFIG_SH_IS_ASH=y/# CONFIG_SH_IS_ASH is not set/; s/^CONFIG_SHELL_ASH=y/# CONFIG_SHELL_ASH is not set/; s/^# CONFIG_SH_IS_NONE is not set/CONFIG_SH_IS_NONE=y/' .config
  { yes "" || true; } | make -s oldconfig >/dev/null
  # x86 SHA assembly cannot target wasm.
  sed -i 's/^CONFIG_SHA1_HWACCEL=y/# CONFIG_SHA1_HWACCEL is not set/; s/^CONFIG_SHA256_HWACCEL=y/# CONFIG_SHA256_HWACCEL is not set/' .config
  { yes "" || true; } | make -s oldconfig >/dev/null
fi

# Compile everything (the kbuild link step needs --start-group, which
# wasm-ld lacks — the final link below is explicit instead).
make -j"$(nproc)" CC="$CC" HOSTCC=gcc SKIP_STRIP=y busybox_unstripped || true
for a in */lib.a libbb/lib.a coreutils/libcoreutils/lib.a; do
  [ -f "$a" ] || { echo "missing $a — compile stage failed; re-run make without -s to see errors" >&2; exit 1; }
done

for unit in "$HERE/wasi-shim.c" "$NIMBUS_LIBC/nimbus-accounts.c"; do
  "$CC_BASE" -std=gnu17 -O2 \
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
    $INCLUDES -c "$unit" -o "$(basename "$unit" .c).o"
done

# Explicit link. -u __main_argc_argv: busybox's main() lives in
# libbb/lib.a (appletlib.c) and nothing else roots it, so lazy archive
# resolution would otherwise drop the whole program (proven: a 117 KB
# _start-only stub). Archives repeated for cross-archive references.
"$CC_BASE" -O2 -o busybox.wasm applets/applets.o wasi-shim.o nimbus-accounts.o \
  -Wl,-u,__main_argc_argv -Wl,--strip-debug \
  -Wl,--wrap=stat -Wl,--wrap=lstat -Wl,--wrap=fstat -Wl,--wrap=fstatat \
  -Wl,--wrap=chmod -Wl,--wrap=fchmod -Wl,--wrap=__main_argc_argv \
  */lib.a */*/lib.a libbb/lib.a \
  -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman

cp busybox.wasm "$HERE/busybox.wasm"
echo "Built: $HERE/busybox.wasm ($(wc -c <"$HERE/busybox.wasm") bytes)"
