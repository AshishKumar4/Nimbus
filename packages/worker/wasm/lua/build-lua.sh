#!/usr/bin/env bash
# Build shell-only Lua for wasi-cli-runner@1. The armada lane verifies the
# wasi-sdk 27.0 archive's hash before use and compares both outputs with HEAD.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIBC="$HERE/../nimbus-libc"
if [ "${1:-}" = verify ]; then
  shift
  if [ "$#" -eq 0 ]; then set -- "$HERE/lua.wasm"; fi
  exec node "$LIBC/verify-imports.mjs" "$@"
fi
MODE="${1:-wasm}"
if [ "$#" -gt 1 ] || [[ "$MODE" != native && "$MODE" != wasm ]]; then
  echo 'usage: build-lua.sh [native | verify [runtime.wasm ...]]' >&2; exit 64
fi
if [ "$MODE" = wasm ]; then
  : "${WASI_SDK:?set WASI_SDK to the wasi-sdk 27.0 root}"
  grep -qx '27.0' "$WASI_SDK/VERSION" || { echo "build-lua.sh: wasi-sdk 27.0 expected at $WASI_SDK" >&2; exit 64; }
fi

VERSION=5.4.8
SOURCE="$(node "$HERE/../../scripts/runtime-source.mjs" "lua/$VERSION")"
read -r URL SHA256 <<<"$SOURCE"
BUILD="${BUILD:-$HERE/build}"
mkdir -p "$BUILD"
cd "$BUILD"
ARCHIVE="lua-$VERSION.tar.gz"
if [ ! -f "$ARCHIVE" ]; then
  curl --retry 3 -fsSL "$URL" -o "$ARCHIVE.part"
  echo "$SHA256  $ARCHIVE.part" | sha256sum -c --quiet -
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
echo "$SHA256  $ARCHIVE" | sha256sum -c --quiet -
rm -rf "lua-$VERSION"
tar xzf "$ARCHIVE"
cd "lua-$VERSION"
if [ "$MODE" = native ]; then
  # The differential oracle is pristine upstream Lua, not the WASI port.
  exec make -C src -j4 lua
fi
patch -p1 --quiet < "$HERE/no-repl.patch"

# The ISO C build leaves dynamic loading and popen disabled. Wasm-native
# exceptions implement setjmp/longjmp without introducing host imports.
sources=()
for file in src/*.c; do
  if [ "$file" != src/luac.c ]; then sources+=("$file"); fi
done
"$WASI_SDK/bin/wasm32-wasi-clang" -O2 -g0 -mllvm -wasm-enable-sjlj \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
  -DL_tmpnam=32 -Wno-deprecated-declarations \
  "${sources[@]}" "$HERE/lua-wasi-compat.c" \
  "$LIBC/nimbus-fs.c" "$LIBC/nimbus-proc.c" "$LIBC/nimbus-cwd.c" \
  "$LIBC/nimbus-restart.c" "$LIBC/nimbus-signal.c" \
  -lm -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
  -Wl,-z,stack-size=8388608 -Wl,--initial-memory=16777216 -Wl,--max-memory=2147483648 \
  -Wl,--wrap=read -Wl,--wrap=readv -Wl,--wrap=write -Wl,--wrap=writev \
  -Wl,--wrap=__wasi_fd_read -Wl,--wrap=__wasi_fd_write -Wl,--wrap=__wasi_poll_oneoff \
  -Wl,--wrap=__nimbus_wait -Wl,--wrap=raise \
  -Wl,--wrap=system -Wl,--wrap=tmpnam -Wl,--wrap=tmpfile -o lua.wasm

"$WASI_SDK/bin/llvm-strip" -o "$HERE/lua.wasm" lua.wasm
sed -n '/^\* Copyright (C)/,/^\*\*\*\*/{ /^\*\*\*\*/d; s/^\* \?//; p; }' src/lua.h > "$HERE/LICENSE"
node "$LIBC/verify-imports.mjs" "$HERE/lua.wasm"
echo "built $HERE/lua.wasm ($(wc -c < "$HERE/lua.wasm") bytes)"
