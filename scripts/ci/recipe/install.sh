#!/bin/sh
# As the user, in the checkout, once per armada environment (.armada.json):
# the workstation's git defaults that tests reach (a committer identity,
# `main` for a new repository's branch), the Lean toolchain
# tests/unit/lean-proofs.mjs needs, TMPDIR on disk as on the workstation,
# and the locked install with its postinstall bundles.
set -eu
git config --global user.name 'Nimbus CI'
git config --global user.email ci@nimbus-ci.invalid
git config --global init.defaultBranch main
curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  | sh -s -- -y --no-modify-path --default-toolchain "$(cat lean/lean-toolchain)"
mkdir -p "$HOME/tmp"
# Once more on failure: a registry download can fail on its own (a sharp
# tarball did, once).
bun install --frozen-lockfile || bun install --frozen-lockfile
