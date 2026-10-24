#!/usr/bin/env bash
# Build GNU make for wasm32-wasi: upstream make 4.4.1 with patches/ (its
# recipes spawned through the host, wasi-libc's dirent, a main of two
# arguments) and without output sync (upstream's NO_OUTPUT_SYNC: it holds a
# job's output in a file the host cannot hand a child, so --output-sync is
# taken and does nothing), over the shared Nimbus libc shim
# (../nimbus-libc): posix_spawn, waitpid, pipe and dup2 through the host
# (nimbus-spawn.c, nimbus-proc.c), a file's mode and owner (nimbus-fs.c),
# the directory the process starts in (nimbus-cwd.c), a wait its host gave
# up on asked again (nimbus-restart.c) and the signals its host sends raised
# (nimbus-signal.c), as wasi-cli-runner@1 asks (core runtime/os-contracts.ts
# WASI_CLI_RUNNER); and make-wasi-compat.{h,c}. Requires wasi-sdk 27, node
# (the spec's pin), and network access for the pinned source tarball.
#
#   WASI_SDK=~/toolchains/wasi-sdk-27.0-x86_64-linux ./build-make.sh
#
# Output, next to this script: make.wasm, stripped, and make's license
# (COPYING). The build tree is build/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIBC="$HERE/../nimbus-libc"
if [ "${1:-}" = verify ]; then
  shift
  if [ "$#" -eq 0 ]; then set -- "$HERE/make.wasm"; fi
  exec node "$LIBC/verify-imports.mjs" "$@"
fi
if [ "$#" -ne 0 ]; then echo 'usage: build-make.sh [verify [runtime.wasm ...]]' >&2; exit 64; fi
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
grep -qx '27.0' "$WASI_SDK/VERSION" || { echo "build-make.sh: wasi-sdk 27.0 expected at $WASI_SDK" >&2; exit 64; }
BUILD="${BUILD:-$HERE/build}"
JOBS="${MAKE_BUILD_JOBS:-8}"
# GNU's release, as its spec pins it (runtime-specs.mjs `source`; its
# signature by Paul D. Smith checked when the digest was pinned).
MAKE_VERSION=4.4.1
MAKE_SOURCE="$(node "$HERE/../../scripts/runtime-source.mjs" "make/$MAKE_VERSION")"
read -r MAKE_URL MAKE_SHA256 <<<"$MAKE_SOURCE"

fetch() { # url sha256 file
  if [ ! -f "$3" ]; then curl -fsSL "$1" -o "$3.part" && mv "$3.part" "$3"; fi
  echo "$2  $3" | sha256sum -c --quiet -
}

mkdir -p "$BUILD/src"
cd "$BUILD/src"
fetch "$MAKE_URL" "$MAKE_SHA256" "make-$MAKE_VERSION.tar.gz"

# The compiler by name, from PATH. The shim is one archive, linked whole for
# its constructor and wrappers (the wrappers as nimbus-restart.c and
# nimbus-signal.c name them), so configure finds what it provides.
export PATH="$WASI_SDK/bin:$PATH"
CFLAGS="-O2 -g0 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
rm -rf "$BUILD/nimbus" && mkdir -p "$BUILD/nimbus"
for source in "$LIBC"/nimbus-fs.c "$LIBC"/nimbus-proc.c "$LIBC"/nimbus-spawn.c "$LIBC"/nimbus-cwd.c "$LIBC"/nimbus-restart.c "$LIBC"/nimbus-signal.c "$HERE"/make-wasi-compat.c; do
  wasm32-wasi-clang $CFLAGS -I"$LIBC/spawn" -I"$LIBC/posix" -I"$LIBC" -I"$HERE" -c "$source" -o "$BUILD/nimbus/$(basename "$source" .c).o"
done
llvm-ar rcs "$BUILD/nimbus/libnimbus-make.a" "$BUILD"/nimbus/*.o
WRAP="-Wl,--wrap=read -Wl,--wrap=readv -Wl,--wrap=write -Wl,--wrap=writev -Wl,--wrap=__wasi_fd_read -Wl,--wrap=__wasi_fd_write \
  -Wl,--wrap=__wasi_poll_oneoff -Wl,--wrap=__nimbus_wait -Wl,--wrap=raise"

# A fresh tree every time: the patches apply to pristine sources only.
rm -rf "make-$MAKE_VERSION" && tar xzf "make-$MAKE_VERSION.tar.gz"
cd "make-$MAKE_VERSION"
for patch in "$HERE"/patches/*.patch; do patch -p1 --quiet < "$patch"; done
# umask is the shim's (make-wasi-compat.h maps it); bsd_signal is signal.
# No job server: -jN runs its jobs in this make, not across sub-makes.
ac_cv_func_umask=yes ac_cv_have_decl_bsd_signal=no \
  CC=wasm32-wasi-clang AR=llvm-ar RANLIB=llvm-ranlib CFLAGS="$CFLAGS" CPPFLAGS="-I$LIBC/spawn -I$LIBC/posix -I$LIBC" \
  LDFLAGS="$WRAP -Wl,-z,stack-size=8388608" \
  LIBS="-Wl,--whole-archive $BUILD/nimbus/libnimbus-make.a -Wl,--no-whole-archive -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid" \
  ./configure --host=wasm32-wasi --prefix=/usr --disable-nls --disable-load --without-guile --disable-job-server >/dev/null
# The compat header for make's own sources only: configure's checks declare
# the functions it would declare.
make -j"$JOBS" CPPFLAGS="-DNO_OUTPUT_SYNC -I$LIBC/spawn -I$LIBC/posix -I$LIBC -include $HERE/make-wasi-compat.h" >/dev/null
"$WASI_SDK/bin/llvm-strip" -o "$HERE/make.wasm" make
cp COPYING "$HERE/COPYING"
node "$LIBC/verify-imports.mjs" "$HERE/make.wasm"
echo "built $HERE/make.wasm ($(wc -c < "$HERE/make.wasm") bytes)"
