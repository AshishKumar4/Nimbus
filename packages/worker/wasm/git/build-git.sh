#!/usr/bin/env bash
# Build git for wasm32-wasi: upstream git, the patches in patches/, and what
# wasi-libc lacks (include/, git-wasi-compat.{h,c}). Requires wasi-sdk and
# network access for the pinned source tarballs.
#
#   WASI_SDK=~/toolchains/wasi-sdk-27.0-x86_64-linux ./build-git.sh
#
# Output, next to this script: git.wasm, stripped. The build tree is build/.
#
# What does not work without a process: anything that runs a child (stash,
# a real merge, am, add -p, bisect, worktree add, submodule, gc, hooks, an
# editor or a pager) answers ENOSYS at the spawn; see git-wasi-compat.c.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WASI_SDK:?set WASI_SDK to the wasi-sdk root (bin/wasm32-wasi-clang)}"
BUILD="${BUILD:-$HERE/build}"
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
    ./configure --static --prefix="$BUILD/sysroot" >/dev/null && make -j"$(nproc)" libz.a >/dev/null && make install >/dev/null)
fi

# A fresh tree every time: the patches apply to pristine sources only.
rm -rf "git-$GIT_VERSION" && tar xf "git-$GIT_VERSION.tar.xz"
cd "git-$GIT_VERSION"
for patch in "$HERE"/patches/*.patch; do patch -p1 --quiet < "$patch"; done
cp "$HERE/config.mak" config.mak
cp "$HERE/git-wasi-compat.c" "$HERE/git-wasi-compat.h" "$HERE/../nimbus-libc/nimbus-fs.c" compat/
make -j"$(nproc)" GIT_WASI_DIR="$HERE" WASI_SDK="$WASI_SDK" SYSROOT_EXTRA="$BUILD/sysroot" \
  uname_S=WASI uname_M=wasm32 uname_O=WASI uname_R=1 uname_V=1 git
"$WASI_SDK/bin/llvm-strip" -o "$HERE/git.wasm" git
echo "built $HERE/git.wasm ($(wc -c < "$HERE/git.wasm") bytes)"
