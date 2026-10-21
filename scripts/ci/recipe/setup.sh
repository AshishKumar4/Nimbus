#!/bin/sh
# The unit suite's system, as root, once per armada environment
# (.armada.json), over armada's runner layer on cloudflare/debian-trixie
# (tini, setpriv, git 2.53, curl, procps, psmisc, python3, a compiler).
# Host tools the suite spawns: ruby (REPL differentials), redis-server and
# openssl (TLS workerd tests), bubblewrap (realm-host-pid1 starts itself as
# PID 1 of a namespace), the en_US.UTF-8 locale the GNU fixture recorder
# runs its tools under, and GNU coreutils under the `gnu` prefix Ubuntu's
# gnu-coreutils gives them (gnurealpath next to the default realpath). Then
# the node release Nimbus's node reports (core/constants.ts NODE_RELEASE)
# and bun 1.4.0, ahead of the base image's node on PATH, each checked
# against its release's published sha256. And trust:
# ca-certificates at least trixie's 20250419+deb13u1, which distrusts the
# roots of the eMudhra intermediates found compromised on 2026-10-20; armada
# keys an environment on this file, so a change here prepares a new one.
set -eu
# root's PATH: armada runs setup under its tasks' PATH, which lacks sbin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NODE_VERSION=22.23.4
# nodejs.org/dist/v22.23.4/SHASUMS256.txt
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
BUN_VERSION=1.4.0
# github.com/oven-sh/bun/releases/download/bun-v1.4.0/SHASUMS256.txt
BUN_SHA256=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452
CA_CERTIFICATES_FLOOR=20250419+deb13u1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends locales bubblewrap openssl ruby redis-server ca-certificates
ca_version=$(dpkg-query -W -f '${Version}' ca-certificates)
if ! dpkg --compare-versions "$ca_version" ge "$CA_CERTIFICATES_FLOOR"; then
  echo "ca-certificates $ca_version is older than $CA_CERTIFICATES_FLOOR" >&2
  exit 1
fi
sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
locale-gen
for tool in $(dpkg -L coreutils | sed -n 's#^/usr/bin/\([^/]*\)$#\1#p'); do ln -sf "/usr/bin/$tool" "/usr/local/bin/gnu$tool"; done
curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /opt
rm -f /tmp/node.tar.xz
for bin in node npm npx corepack; do ln -sf "/opt/node-v${NODE_VERSION}-linux-x64/bin/${bin}" "/usr/local/bin/${bin}"; done
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -
unzip -q /tmp/bun.zip -d /tmp
install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun
ln -sf bun /usr/local/bin/bunx
rm -rf /tmp/bun.zip /tmp/bun-linux-x64
apt-get clean
rm -rf /var/lib/apt/lists/*
