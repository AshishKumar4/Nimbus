#!/usr/bin/env bash
# Build unmodified GNU bash 5.2 -> wasm32-wasi + the Nimbus fork/exec/pipe layer.
# Reproducible off-platform recipe (REAL-FORK-BASH-PLAN §3 route 2). Presented
# as-is, maintained by Claude. Requires: wasi-sdk >= 24, a host cc (build tools).
#
# Status (2026-07-20): configure SUCCEEDS; bash core objects compile to wasm
# (general.o, eval.o verified; shell/execute_cmd/subst compile once generated
# headers exist). Remaining to a running bash.wasm: (1) let the real Makefile
# drive the target build with these flags (build tools native, target with
# SjLj+overlay); (2) link with nimbus-proc.o + __wasm_setjmp/__wasm_longjmp;
# (3) wasm-opt --asyncify the nimbus_proc blocking imports. See BRINGUP.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
: "${BASH_SRC:?set BASH_SRC to an extracted bash-5.2.x source tree}"
CC="$WASI_SDK/bin/wasm32-wasi-clang"

# The one std that keeps GCC-15/clang-19 (C23 default) from rejecting bash 5.2's
# K&R prototypes; the SjLj lowering for setjmp/longjmp (bash's error recovery);
# the emulated-feature libs; and the Nimbus process/rlimit/pwd overlay header.
TARGET_CFLAGS="-std=gnu17 -mllvm -wasm-enable-sjlj -O2 \
  -D_GNU_SOURCE -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN \
  -include $HERE/nimbus-proc.h \
  -Wno-implicit-function-declaration -Wno-incompatible-function-pointer-types \
  -Wno-incompatible-pointer-types -Wno-int-conversion"
TARGET_LDFLAGS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman"

cd "$BASH_SRC"
if [ ! -f config.status ]; then
  CC="$CC" \
  CFLAGS="-std=gnu17 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -O2" \
  CPPFLAGS="-D_GNU_SOURCE" LDFLAGS="$TARGET_LDFLAGS" \
  ./configure --host=wasm32-wasi --without-bash-malloc --disable-nls \
    --cache-file="$HERE/cross.cache"
  # config.h fixes: wasi-libc has gethostname; struct passwd comes from the
  # overlay (no <pwd.h> file), so keep HAVE_PWD_H off but HAVE_GETPWNAM on.
  sed -i 's|/\* #undef HAVE_GETHOSTNAME \*/|#define HAVE_GETHOSTNAME 1|; \
          s|/\* #undef HAVE_GETPWNAM \*/|#define HAVE_GETPWNAM 1|' config.h
fi

# Build tools NATIVE (gcc), target with the Nimbus flags. mkbuiltins et al. run
# on the host, so they must NOT get the wasi flags or the overlay.
make -j"$(nproc)" \
  CC_FOR_BUILD=gcc CCFLAGS_FOR_BUILD='-std=gnu17 -O2' \
  CFLAGS="$TARGET_CFLAGS" LOCAL_LIBS="$HERE/nimbus-proc.o" \
  || echo "make stopped — see BRINGUP.md for the remaining orchestration items"

# nimbus-proc.o: the process-ABI trap layer linked into bash.
"$CC" -std=gnu17 -D_GNU_SOURCE -O2 -c "$HERE/nimbus-proc.c" -o "$HERE/nimbus-proc.o"

# Final link + asyncify (once bash links):
#   wasm-opt --asyncify \
#     --pass-arg=asyncify-imports@nimbus_proc.fork,nimbus_proc.vfork,nimbus_proc.execve,nimbus_proc.waitpid \
#     bash.wasm -o bash.async.wasm
echo "Overlay object: $HERE/nimbus-proc.o"
