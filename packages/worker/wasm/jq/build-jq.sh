#!/usr/bin/env bash
# Build jq for wasm32-wasi: upstream jq 1.7.1 with its bundled Oniguruma,
# unpatched, over the shared Nimbus libc shim (../nimbus-libc): a file's
# mode and owner (jq-wasi-compat.h), the directory the process starts in
# (nimbus-cwd.c), a wait its host gave up on asked again (nimbus-restart.c)
# and the signals its host sends raised (nimbus-signal.c), as
# wasi-cli-runner@1 asks (core runtime/os-contracts.ts WASI_CLI_RUNNER).
# Requires wasi-sdk 27 and network access for the pinned source tarball.
#
#   WASI_SDK=~/toolchains/wasi-sdk-27.0-x86_64-linux ./build-jq.sh
#
# Output, next to this script: jq.wasm, stripped, and the license notices
# of jq and Oniguruma (COPYING, COPYING.oniguruma). The build tree is build/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = verify ]; then
  shift
  if [ "$#" -eq 0 ]; then set -- "$HERE/jq.wasm"; fi
  exec node "$HERE/../nimbus-libc/verify-imports.mjs" "$@"
fi
if [ "$#" -ne 0 ]; then echo 'usage: build-jq.sh [verify [runtime.wasm ...]]' >&2; exit 64; fi
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
grep -qx '27.0' "$WASI_SDK/VERSION" || { echo "build-jq.sh: wasi-sdk 27.0 expected at $WASI_SDK" >&2; exit 64; }
BUILD="${BUILD:-$HERE/build}"
JOBS="${JQ_BUILD_JOBS:-8}"
# jq's release, its digest the one jqlang publishes beside it (sha256sum.txt).
JQ_VERSION=1.7.1
JQ_SHA256=478c9ca129fd2e3443fe27314b455e211e0d8c60bc8ff7df703873deeee580c2

fetch() { # url sha256 file
  if [ ! -f "$3" ]; then curl -fsSL "$1" -o "$3.part" && mv "$3.part" "$3"; fi
  echo "$2  $3" | sha256sum -c --quiet -
}

mkdir -p "$BUILD/src" "$BUILD/nimbus"
cd "$BUILD/src"
fetch "https://github.com/jqlang/jq/releases/download/jq-$JQ_VERSION/jq-$JQ_VERSION.tar.gz" "$JQ_SHA256" "jq-$JQ_VERSION.tar.gz"

# The compiler by name, from PATH, and nothing of this machine in what
# configure is given: jq prints it (--build-configuration), so a path there
# would make the image this machine's. What is machine-local (the shim's
# headers and objects) is given to make, not configure.
export PATH="$WASI_SDK/bin:$PATH"
CFLAGS="-O2 -g0 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
NIMBUS_OBJS=()
for source in nimbus-fs nimbus-proc nimbus-cwd nimbus-restart nimbus-signal; do
  wasm32-wasi-clang $CFLAGS -c "$HERE/../nimbus-libc/$source.c" -o "$BUILD/nimbus/$source.o"
  NIMBUS_OBJS+=("$BUILD/nimbus/$source.o")
done

# A fresh tree every time.
rm -rf "jq-$JQ_VERSION" && tar xzf "jq-$JQ_VERSION.tar.gz"
cd "jq-$JQ_VERSION"
# wasi-libc's pthread keys and once work single-threaded; -pthread would ask
# for shared memory. PTHREAD_LIBS set keeps AX_PTHREAD from adding it.
CC=wasm32-wasi-clang AR=llvm-ar RANLIB=llvm-ranlib CFLAGS="$CFLAGS" PTHREAD_LIBS=-lc \
  ./configure --host=wasm32-wasi --with-oniguruma=builtin --disable-docs --disable-shared --enable-static \
  --disable-maintainer-mode >/dev/null
# jq linked with the shim's objects whole, for its constructor and wrappers
# (the wrappers as nimbus-restart.c and nimbus-signal.c name them).
make -j"$JOBS" CPPFLAGS="-I$HERE/../nimbus-libc -include $HERE/jq-wasi-compat.h" jq_LDADD="libjq.la -lm ${NIMBUS_OBJS[*]}" \
  LDFLAGS="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
  -Wl,-z,stack-size=8388608 -Wl,--initial-memory=16777216 -Wl,--max-memory=2147483648 \
  -Wl,--wrap=read -Wl,--wrap=readv -Wl,--wrap=write -Wl,--wrap=writev \
  -Wl,--wrap=__wasi_fd_read -Wl,--wrap=__wasi_fd_write -Wl,--wrap=__wasi_poll_oneoff -Wl,--wrap=__nimbus_wait -Wl,--wrap=raise" >/dev/null
"$WASI_SDK/bin/llvm-strip" -o "$HERE/jq.wasm" jq
# The notices the image's licenses ask to go with it (runtime-specs.mjs ships them).
cp COPYING "$HERE/COPYING"
cp modules/oniguruma/COPYING "$HERE/COPYING.oniguruma"
node "$HERE/../nimbus-libc/verify-imports.mjs" "$HERE/jq.wasm"
echo "built $HERE/jq.wasm ($(wc -c < "$HERE/jq.wasm") bytes)"
