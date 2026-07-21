#!/usr/bin/env bash
# Build BusyBox 1.37.0 -> wasm32-wasi: the comprehensive coreutils set the
# bash-runner stages as exec targets (one multicall binary, applet dispatch
# on argv[0]). Reproducible off-platform recipe, same discipline as
# ../build-bash.sh. Maintained by Claude, presented as-is.
#
# Requires: wasi-sdk >= 25 (WASI_SDK env), host gcc (kconfig tools), node
# (emits busybox.applets via the bundled WASI harness).
#
# Route notes (all proven, 2026-07-21):
#  - Plain synchronous WASI command module: exec'd coreutils never fork, so
#    no asyncify/fpcast pass is needed (unlike bash itself).
#  - setjmp (test/[ error recovery, NOFORK plumbing) uses wasm
#    exception-handling SjLj (-mlvm -wasm-enable-sjlj + -lsetjmp). V8
#    executes it natively; the bash binary's asyncify-based setjmp overlay
#    prohibition does NOT apply because this module is never asyncified.
#  - overlay/ supplies the headers wasi-libc omits (netdb/pwd/grp/paths/
#    mntent/termios/sigaction/...); wasi-shim.c supplies the matching
#    single-user, process-less, signal-free implementations.
#  - libbb/xconnect.c is dead network-helper code (no net applets) that
#    cannot compile against wasi-libc's socket surface; it is gated out.
#  - --wrap=stat family synthesizes st_blocks (du) and default mode bits
#    (ls -l) that WASI preview1 filestat cannot carry. --wrap=chmod routes
#    to the nimbus_proc.chmod runtime import (preview1 has no mode syscall).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
BB=busybox-1.37.0
CC_BASE="$WASI_SDK/bin/wasm32-wasi-clang"
# -std=gnu17: busybox's pre-C23 code under clang 19. The emulated-feature
# defines mirror build-bash.sh. -include: compat decls for every file.
CC="$CC_BASE -std=gnu17 -mllvm -wasm-enable-sjlj \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  -isystem $HERE/overlay -include $HERE/overlay/nimbus-wasi-compat.h"

cd "$HERE"
if [ ! -d "$BB" ]; then
  [ -f "$BB.tar.bz2" ] || curl -fsSLO "https://busybox.net/downloads/$BB.tar.bz2"
  tar xf "$BB.tar.bz2"
  # Dead network-helper code: no networking applet is configured, and
  # xconnect.c cannot compile against wasi-libc's socket surface. Gate it
  # behind a config that is always off here.
  sed -i 's/^lib-y += xconnect.o/lib-$(CONFIG_FEATURE_IPV6) += xconnect.o/' "$BB/libbb/Kbuild.src"
fi

cd "$BB"
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
  yes "" | make -s oldconfig >/dev/null
  # x86 SHA assembly cannot target wasm.
  sed -i 's/^CONFIG_SHA1_HWACCEL=y/# CONFIG_SHA1_HWACCEL is not set/; s/^CONFIG_SHA256_HWACCEL=y/# CONFIG_SHA256_HWACCEL is not set/' .config
  yes "" | make -s oldconfig >/dev/null
fi

# Compile everything (the kbuild link step needs --start-group, which
# wasm-ld lacks — the final link below is explicit instead).
make -j"$(nproc)" CC="$CC" HOSTCC=gcc SKIP_STRIP=y busybox_unstripped 2>/dev/null || true
for a in */lib.a libbb/lib.a coreutils/libcoreutils/lib.a; do
  [ -f "$a" ] || { echo "missing $a — compile stage failed; re-run make without -s to see errors" >&2; exit 1; }
done

"$CC_BASE" -std=gnu17 -O2 \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
  -isystem "$HERE/overlay" -c "$HERE/wasi-shim.c" -o "$HERE/wasi-shim.o"

# Explicit link. -u __main_argc_argv: busybox's main() lives in
# libbb/lib.a (appletlib.c) and nothing else roots it, so lazy archive
# resolution would otherwise drop the whole program (proven: a 117 KB
# _start-only stub). Archives repeated for cross-archive references.
"$CC_BASE" -O2 -o busybox.wasm applets/applets.o "$HERE/wasi-shim.o" \
  -Wl,-u,__main_argc_argv -Wl,--strip-debug \
  -Wl,--wrap=stat -Wl,--wrap=lstat -Wl,--wrap=fstat -Wl,--wrap=fstatat \
  -Wl,--wrap=chmod -Wl,--wrap=fchmod \
  */lib.a */*/lib.a libbb/lib.a \
  -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman

cp busybox.wasm "$HERE/busybox.wasm"

# busybox.applets: the applet manifest the bash-runner aliases onto the
# busybox module ('busybox --list' is the source of truth; it prints the
# list on stderr under this harness).
node - "$HERE/busybox.wasm" <<'EOF' 2>&1 1>/dev/null | grep -vE 'ExperimentalWarning|trace-warnings' > "$HERE/busybox.applets"
const { readFile } = require('node:fs/promises');
const { WASI } = require('node:wasi');
(async () => {
  const wasi = new WASI({ version: 'preview1', args: ['busybox', '--list'], returnOnExit: true });
  const mod = await WebAssembly.compile(await readFile(process.argv[2]));
  const inst = await WebAssembly.instantiate(mod, { ...wasi.getImportObject(), nimbus_proc: { chmod: () => 0 } });
  wasi.start(inst);
})();
EOF

echo "Built: $HERE/busybox.wasm ($(wc -c <"$HERE/busybox.wasm") bytes), $(wc -l <"$HERE/busybox.applets") applets"
echo "Imports: 29 wasi_snapshot_preview1 + nimbus_proc.chmod"
