#!/usr/bin/env bash
# The Lean corpus end to end: build, the negative gate, the fixtures are the
# models' own output, the traceability manifest and kernel-axiom audit, and the
# deployed code on every fixture (exactly the tests lean/traceability.yaml names).
set -euo pipefail

cd "$(dirname "$0")/../lean"
LAKE="${LAKE:-lake}"
command -v "$LAKE" >/dev/null 2>&1 || LAKE="$HOME/.elan/bin/lake"
export LAKE

"$LAKE" build
bash check-no-false.sh

# The refinement fixtures are the models' own output: write them afresh and refuse drift.
rm -rf .lake/fixtures-check
"$LAKE" build fixtures
.lake/build/bin/fixtures .lake/fixtures-check
if ! diff -r fixtures .lake/fixtures-check >&2; then
  echo 'verify-lean: lean/fixtures is not what the models generate. In lean/, run' \
    '`lake build fixtures && .lake/build/bin/fixtures fixtures` and review the diff.' >&2
  exit 1
fi

PATH="$(dirname "$(command -v "$LAKE")"):$PATH" node check-traceability.mjs

mapfile -t refinement_tests < <(node check-traceability.mjs --list-refinement-tests)
cd ..
for test in "${refinement_tests[@]}"; do bun "$test"; done
