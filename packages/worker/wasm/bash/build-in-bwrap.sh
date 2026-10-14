#!/usr/bin/env bash
# The recipe bash.async.wasm is built by: build-bash.sh in a bubblewrap sandbox
# where this directory is /src/bash, GNU bash 5.2.37's release (pinned by
# digest) is unpacked afresh at /build/bash-5.2.37, wasi-sdk 25.0 is /wasi-sdk
# and binaryen's wasm-opt is on PATH, with an environment of nothing but what
# the build needs. Every path the build leaves in the module (its DWARF, each
# __FILE__) is under one of those, so the artifact names no machine.
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
fetch "$BINARYEN_URL" "$BINARYEN_SHA" binaryen.tgz
[ -d "$WORK/wasi-sdk-25.0-x86_64-linux" ] || tar xzf "$WORK/wasi-sdk.tgz" -C "$WORK"
[ -d "$WORK/binaryen-version_133" ] || tar xzf "$WORK/binaryen.tgz" -C "$WORK"
rm -rf "$WORK/build"
mkdir -p "$WORK/build"
tar xzf "$WORK/bash.tgz" -C "$WORK/build"

node "$HERE/inputs.mjs" --snapshot "$WORK/inputs.json"
bwrap --unshare-user --tmpfs / \
	--ro-bind /usr /usr --ro-bind /etc /etc --ro-bind-try /run /run \
	--ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
	--proc /proc --dev /dev --tmpfs /tmp \
	--bind "$HERE" /src/bash --bind "$WORK/build" /build \
	--ro-bind "$WORK/wasi-sdk-25.0-x86_64-linux" /wasi-sdk --ro-bind "$WORK/binaryen-version_133" /binaryen \
	--chdir /src/bash --clearenv \
	--setenv HOME /tmp/home --setenv TMPDIR /tmp --setenv PATH /binaryen/bin:/usr/local/bin:/usr/bin:/bin \
	--setenv WASI_SDK /wasi-sdk --setenv BASH_SRC /build/bash-5.2.37 \
	bash -c 'mkdir -p "$HOME" && exec ./build-bash.sh'

node "$HERE/inputs.mjs" --record "$WORK/inputs.json"
