#!/usr/bin/env bash
# The recipe bash.async.wasm and coreutils/busybox.wasm are built by:
# build-bash.sh, then coreutils/build-busybox.sh, in a bubblewrap sandbox
# where this directory is /src/bash and ../nimbus-libc is /src/nimbus-libc,
# GNU bash 5.2.37's and BusyBox 1.37.0's releases (pinned by digest) are
# unpacked afresh under /build, wasi-sdk 25.0 is /wasi-sdk and binaryen's
# wasm-opt is on PATH, with an environment of nothing but what the build
# needs (BusyBox's build stamp is its release day). Every path the build
# leaves in a module (its DWARF, each __FILE__) is under one of those, so the
# artifacts name no machine. Then busybox.applets is listed from the module.
#
#   ./build-in-bwrap.sh <work dir>
#
# Needs bwrap (unprivileged user namespaces), curl, a host gcc and make, and
# network access for the pinned sources. The work directory keeps the
# downloads; each run builds from a fresh source tree.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?usage: build-in-bwrap.sh <work dir>}"
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
WASI_SDK_SHA=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c
# GNU's release, its signature by Chet Ramey checked when the digest was pinned.
BASH_URL=https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz
BASH_SHA=9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff
# BusyBox's release, its digest the one busybox.net publishes beside it.
BUSYBOX_URL=https://busybox.net/downloads/busybox-1.37.0.tar.bz2
BUSYBOX_SHA=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
# The repository's one binaryen (packages/worker/scripts/oxc-wasm/build.mjs).
BINARYEN_URL=https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz
BINARYEN_SHA=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
fetch() { # <url> <sha256> <file>
	[ -f "$WORK/$3" ] || curl -sSLf -o "$WORK/$3" "$1"
	echo "$2  $WORK/$3" | sha256sum -c --quiet
}
fetch "$WASI_SDK_URL" "$WASI_SDK_SHA" wasi-sdk.tgz
fetch "$BASH_URL" "$BASH_SHA" bash.tgz
fetch "$BUSYBOX_URL" "$BUSYBOX_SHA" busybox.tbz2
fetch "$BINARYEN_URL" "$BINARYEN_SHA" binaryen.tgz
[ -d "$WORK/wasi-sdk-25.0-x86_64-linux" ] || tar xzf "$WORK/wasi-sdk.tgz" -C "$WORK"
[ -d "$WORK/binaryen-version_133" ] || tar xzf "$WORK/binaryen.tgz" -C "$WORK"
rm -rf "$WORK/build"
mkdir -p "$WORK/build"
tar xzf "$WORK/bash.tgz" -C "$WORK/build"
tar xjf "$WORK/busybox.tbz2" -C "$WORK/build"

node "$HERE/inputs.mjs" --snapshot "$WORK/inputs.json"
bwrap --unshare-user --tmpfs / \
	--ro-bind /usr /usr --ro-bind /etc /etc --ro-bind-try /run /run \
	--ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
	--proc /proc --dev /dev --tmpfs /tmp \
	--bind "$HERE" /src/bash --ro-bind "$HERE/../nimbus-libc" /src/nimbus-libc --bind "$WORK/build" /build \
	--ro-bind "$WORK/wasi-sdk-25.0-x86_64-linux" /wasi-sdk --ro-bind "$WORK/binaryen-version_133" /binaryen \
	--chdir /src/bash --clearenv \
	--setenv HOME /tmp/home --setenv TMPDIR /tmp --setenv PATH /binaryen/bin:/usr/local/bin:/usr/bin:/bin \
	--setenv WASI_SDK /wasi-sdk --setenv BASH_SRC /build/bash-5.2.37 \
	--setenv BUSYBOX_SRC /build/busybox-1.37.0 --setenv SOURCE_DATE_EPOCH 1727308800 --setenv TZ UTC \
	bash -c 'mkdir -p "$HOME" && ./build-bash.sh && exec ./coreutils/build-busybox.sh'

node "$HERE/coreutils/list-applets.mjs" "$HERE/coreutils/busybox.wasm" > "$HERE/coreutils/busybox.applets"

node "$HERE/inputs.mjs" --record "$WORK/inputs.json"
