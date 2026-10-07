#!/bin/sh
# The unit suite's system, as root, once per armada environment
# (.armada.json), over armada's runner layer on cloudflare/debian-trixie
# (tini, setpriv, git 2.53, curl, procps, psmisc, python3, a compiler).
# Host tools the suite spawns: ruby (REPL differentials), redis-server and
# openssl (TLS workerd tests), bubblewrap (realm-host-pid1 starts itself as
# PID 1 of a namespace), the en_US.UTF-8 locale the GNU fixture recorder
# runs its tools under, and GNU coreutils under the `gnu` prefix Ubuntu's
# gnu-coreutils gives them (gnurealpath next to the default realpath). Then
# the workstation's node 22 and bun 1.4.0 (the version .github/workflows
# pins), ahead of the base image's node on PATH.
set -eu
# root's PATH: armada runs setup under its tasks' PATH, which lacks sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NODE_VERSION=22.22.3
BUN_VERSION=1.4.0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends locales bubblewrap openssl ruby redis-server
sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
locale-gen
for tool in $(dpkg -L coreutils | sed -n 's#^/usr/bin/\([^/]*\)$#\1#p'); do ln -sf "/usr/bin/$tool" "/usr/local/bin/gnu$tool"; done
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt
for bin in node npm npx corepack; do ln -sf "/opt/node-v${NODE_VERSION}-linux-x64/bin/${bin}" "/usr/local/bin/${bin}"; done
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
ln -sf bun /usr/local/bin/bunx
rm -rf /tmp/bun.zip /tmp/bun-linux-x64
apt-get clean
rm -rf /var/lib/apt/lists/*
