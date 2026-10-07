# Appended to setup.sh for the probe environment only (scripts/ci/remote-probes.mjs):
# the headless browser the browser probes drive, at /usr/bin/chromium, one of
# CHROME_BIN's candidates in tests/behavioral/_runtime-behavioral-template.mjs.
# The unit and build environment stays without it.
apt-get update -qq
apt-get install -y -qq --no-install-recommends chromium fonts-liberation
apt-get clean
rm -rf /var/lib/apt/lists/*
