#!/usr/bin/env bash
# Spike: build stock git for wasm32-wasi with wasi-sdk, no source patches.
# What wasi-libc lacks comes from include/ (headers) and git-wasi-compat.{h,c};
# process creation answers ENOSYS, so commands that spawn fail at the spawn.
# Usage: WORK=/mnt/local/nimbus/tmp/git-real ./build-git.sh   → $WORK/git.wasm
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${WORK:?set WORK to a scratch directory}"
: "${WASI_SDK:=$HOME/toolchains/wasi-sdk-27.0-x86_64-linux}"
GIT_VERSION=2.53.0
ZLIB_VERSION=1.3.1
mkdir -p "$WORK/src" "$WORK/sysroot"
cd "$WORK/src"
[ -d "git-$GIT_VERSION" ] || { curl -fsSLO "https://www.kernel.org/pub/software/scm/git/git-$GIT_VERSION.tar.xz"; tar xf "git-$GIT_VERSION.tar.xz"; }
[ -d "zlib-$ZLIB_VERSION" ] || { curl -fsSLO "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz"; tar xzf "zlib-$ZLIB_VERSION.tar.gz"; }
if [ ! -f "$WORK/sysroot/lib/libz.a" ]; then
  (cd "zlib-$ZLIB_VERSION" && CC="$WASI_SDK/bin/wasm32-wasi-clang" AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" CFLAGS=-O2 \
    ./configure --static --prefix="$WORK/sysroot" && make -j"$(nproc)" libz.a && make install)
fi
cd "git-$GIT_VERSION"
cp "$HERE/config.mak" config.mak
cp "$HERE/git-wasi-compat.c" "$HERE/git-wasi-compat.h" compat/
# config.mak.uname reads uname before config.mak can override it, so the
# target's identity goes on the command line.
make -j"$(nproc)" GIT_WASI_DIR="$HERE" WASI_SDK="$WASI_SDK" SYSROOT_EXTRA="$WORK/sysroot" \
  uname_S=WASI uname_M=wasm32 uname_O=WASI uname_R=1 uname_V=1 git
cp git "$WORK/git.wasm"
echo "built $WORK/git.wasm ($(wc -c < "$WORK/git.wasm") bytes)"
