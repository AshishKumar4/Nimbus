# The probe environment's addition to setup.sh, which scripts/ci/lib/armada.mjs
# appends to it for scripts/ci/remote-probes.mjs (setup runs before the
# commit is checked out, so it cannot run setup.sh from the checkout): the
# headless browser the browser probes drive, at /usr/bin/chromium, one of
# CHROME_BIN's candidates in tests/behavioral/_runtime-behavioral-template.mjs.
# The unit and build environment stays without it.
apt-get update -qq
apt-get install -y -qq --no-install-recommends chromium fonts-liberation
apt-get clean
rm -rf /var/lib/apt/lists/*
