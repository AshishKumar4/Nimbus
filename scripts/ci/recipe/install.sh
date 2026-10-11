#!/bin/sh
# As the user, in the checkout, once per armada environment (.armada.json):
# the workstation's git defaults that tests reach (a committer identity,
# `main` for a new repository's branch), the Lean toolchain
# tests/unit/lean-proofs.mjs needs, TMPDIR on disk as on the workstation,
# and the locked dependencies with their keyed patches. No source is built.
set -eu
git config --global user.name 'Nimbus CI'
git config --global user.email ci@nimbus.invalid
git config --global init.defaultBranch main
curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  | sh -s -- -y --no-modify-path --default-toolchain "$(cat lean/lean-toolchain)"
mkdir -p "$HOME/tmp"
bun scripts/install-deps.mjs
bun --version
node --version
redis-server --version
"$HOME/.elan/bin/lean" --version
gnurealpath --version > /dev/null
