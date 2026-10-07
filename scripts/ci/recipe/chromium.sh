# The probe environment's addition to setup.sh, which scripts/ci/lib/armada.mjs
# appends to it for scripts/ci/remote-probes.mjs (setup runs before the
# commit is checked out, so it cannot run setup.sh from the checkout): the
# headless browser the browser probes drive, at /usr/bin/chromium, one of
# CHROME_BIN's candidates in tests/behavioral/_runtime-behavioral-template.mjs.
# The unit and build environment stays without it.
# armada can start setup again while a first run is still installing (job
# 20261007043447-ca30a6f7: the dpkg lock "held by process 9545 (apt-get)"):
# wait for the lock rather than fail, and the second run finds it done.
apt-get -o DPkg::Lock::Timeout=900 update -qq
apt-get -o DPkg::Lock::Timeout=900 install -y -qq --no-install-recommends chromium fonts-liberation
apt-get clean
rm -rf /var/lib/apt/lists/*
