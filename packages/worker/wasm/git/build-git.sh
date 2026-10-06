#!/usr/bin/env bash
# Build git for wasm32-wasi: upstream git, the patches in patches/, and what
# wasi-libc lacks (include/, git-wasi-compat.{h,c}, ../nimbus-libc), plus
# the NO_MMAP paging overlay. Requires wasi-sdk and
# network access for the pinned source tarballs.
#
#   WASI_SDK=~/toolchains/wasi-sdk-27.0-x86_64-linux ./build-git.sh
#
# Output, next to this script: git.wasm, stripped. The build tree is build/.
#
# Children use the shared process shim; without a nimbus_proc host, spawn
# answers ENOSYS. Stdin-dependent commands still require the shared input
# channel. Audit and upstream paths: PATCHES.md. Default build parallelism
# is bounded at eight jobs; GIT_BUILD_JOBS overrides it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = verify ]; then
  shift
  if [ "$#" -eq 0 ]; then set -- "$HERE/git.wasm"; fi
  exec node "$HERE/../nimbus-libc/verify-imports.mjs" "$@"
fi
if [ "$#" -ne 0 ]; then echo 'usage: build-git.sh [verify [runtime.wasm ...]]' >&2; exit 64; fi
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
BUILD="${BUILD:-$HERE/build}"
GIT_BUILD_JOBS="${GIT_BUILD_JOBS:-8}"
case "$GIT_BUILD_JOBS" in ''|*[!0-9]*|0) echo 'GIT_BUILD_JOBS must be a positive integer' >&2; exit 64;; esac
GIT_VERSION=2.53.0
GIT_SHA256=5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653
ZLIB_VERSION=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

fetch() { # url sha256 file
  if [ ! -f "$3" ]; then curl -fsSL "$1" -o "$3.part" && mv "$3.part" "$3"; fi
  echo "$2  $3" | sha256sum -c --quiet -
}

mkdir -p "$BUILD/src" "$BUILD/sysroot"
cd "$BUILD/src"
fetch "https://www.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz" "$GIT_SHA256" "git-$GIT_VERSION.tar.xz"
fetch "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256" "zlib-$ZLIB_VERSION.tar.gz"

if [ ! -f "$BUILD/sysroot/lib/libz.a" ]; then
  rm -rf "zlib-$ZLIB_VERSION" && tar xzf "zlib-$ZLIB_VERSION.tar.gz"
  (cd "zlib-$ZLIB_VERSION" && CC="$WASI_SDK/bin/wasm32-wasi-clang" AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" CFLAGS=-O2 \
    ./configure --static --prefix="$BUILD/sysroot" >/dev/null && make -j"$GIT_BUILD_JOBS" libz.a >/dev/null && make install >/dev/null)
fi

# A fresh tree every time: the patches apply to pristine sources only.
rm -rf "git-$GIT_VERSION" && tar xf "git-$GIT_VERSION.tar.xz"
cd "git-$GIT_VERSION"
for patch in "$HERE"/patches/*.patch; do patch -p1 --quiet < "$patch"; done
cp "$HERE/config.mak" config.mak
cp "$HERE/git-wasi-compat.c" "$HERE/git-wasi-compat.h" "$HERE/../nimbus-libc/nimbus-fs.c" compat/
cp "$HERE/../nimbus-libc/nimbus-proc.c" compat/
cp "$HERE/git-mmap-paged.c" compat/mmap-paged.c
make -j"$GIT_BUILD_JOBS" GIT_WASI_DIR="$HERE" WASI_SDK="$WASI_SDK" SYSROOT_EXTRA="$BUILD/sysroot" \
  uname_S=WASI uname_M=wasm32 uname_O=WASI uname_R=1 uname_V=1 git
"$WASI_SDK/bin/llvm-strip" -o "$HERE/git.wasm" git
node "$HERE/../nimbus-libc/verify-imports.mjs" "$HERE/git.wasm"
echo "built $HERE/git.wasm ($(wc -c < "$HERE/git.wasm") bytes)"
