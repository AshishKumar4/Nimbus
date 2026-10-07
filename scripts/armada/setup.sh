#!/bin/sh
# The unit suite's system, as root, once per armada environment
# (.armada.json), over armada's runner layer (which has tini, setpriv, git
# 2.53, curl, procps, psmisc, python3 and a compiler already). Host tools
# the suite spawns: ruby (REPL differentials), redis-server and openssl (TLS
# workerd tests), gnu-coreutils (gnurealpath: GNU realpath next to the
# default uutils one), bubblewrap (realm-host-pid1 starts itself as PID 1 of
# a namespace), and the en_US.UTF-8 locale the GNU fixture recorder runs its
# tools under. Then the workstation's node 22 and bun 1.4.0 (the version
# .github/workflows pins).
set -eu
NODE_VERSION=22.22.3
BUN_VERSION=1.4.0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends locales bubblewrap openssl ruby redis-server gnu-coreutils
locale-gen en_US.UTF-8
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt
for bin in node npm npx corepack; do ln -sf "/opt/node-v${NODE_VERSION}-linux-x64/bin/${bin}" "/usr/local/bin/${bin}"; done
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
ln -sf bun /usr/local/bin/bunx
rm -rf /tmp/bun.zip /tmp/bun-linux-x64
apt-get clean
rm -rf /var/lib/apt/lists/*
