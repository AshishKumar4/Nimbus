#!/usr/bin/env bash
# The recipe the published CPython artifacts are built by: build-python.sh in a
# bubblewrap sandbox where this directory is /src/python and wasi-sdk 25.0 is
# /wasi-sdk, with an environment of nothing but what the build needs. Every
# path the build leaves in its output (OpenSSL's directories, each .pyc's
# source, __FILE__) is under one of those two, so the artifacts name no
# machine, and build-python.sh refuses any other layout.
#
#   ./build-in-bwrap.sh <work dir> [stage ...]    # default: every stage but verify
#
# Needs bwrap (unprivileged user namespaces), curl, a host cc, make, perl,
# pkg-config and python3, and network access for the pinned sources. The work
# directory keeps the downloaded wasi-sdk. verify runs the repository's tests,
# which the sandbox does not hold: run `./build-python.sh verify` from the tree.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?usage: build-in-bwrap.sh <work dir> [stage ...]}"
shift
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
WASI_SDK_SHA=52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
if [ ! -d "$WORK/wasi-sdk-25.0-x86_64-linux" ]; then
	curl -sSLf -o "$WORK/wasi-sdk.tgz" "$WASI_SDK_URL"
	echo "$WASI_SDK_SHA  $WORK/wasi-sdk.tgz" | sha256sum -c --quiet
	tar xzf "$WORK/wasi-sdk.tgz" -C "$WORK"
	rm "$WORK/wasi-sdk.tgz"
fi
[ $# -gt 0 ] || set -- fetch deps nimbus hostpy wasi extenv ext sci assets

exec bwrap --unshare-user --tmpfs / \
	--ro-bind /usr /usr --ro-bind /etc /etc --ro-bind-try /run /run \
	--ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
	--proc /proc --dev /dev --tmpfs /tmp \
	--bind "$HERE" /src/python --ro-bind "$WORK/wasi-sdk-25.0-x86_64-linux" /wasi-sdk \
	--chdir /src/python --clearenv \
	--setenv HOME /tmp/home --setenv TMPDIR /tmp --setenv PATH /usr/local/bin:/usr/bin:/bin \
	--setenv WASI_SDK /wasi-sdk \
	bash -c 'mkdir -p "$HOME" && exec ./build-python.sh "$@"' build-python "$@"
