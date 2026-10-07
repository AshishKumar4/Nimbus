#!/bin/sh
# The probe environment's setup, as root in the checkout, once per
# environment (scripts/ci/remote-probes.mjs): the unit suite's system
# (setup.sh), then the headless browser the browser probes drive, at
# /usr/bin/chromium, one of CHROME_BIN's candidates in
# tests/behavioral/_runtime-behavioral-template.mjs. The unit and build
# environment stays without it.
set -eu
sh scripts/armada/setup.sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends chromium fonts-liberation
apt-get clean
rm -rf /var/lib/apt/lists/*
