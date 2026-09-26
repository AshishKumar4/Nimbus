/-
  Writes every refinement fixture into the directory named by the first
  argument: `lake env lean --run RefinementFixtures.lean fixtures`.
  `scripts/verify-lean.sh` writes them afresh and fails when `lean/fixtures/`
  differs.
-/

import Nimbus.Refine

open Nimbus.Refine

def fixtures : List (String × String) :=
  [("revision-floor.json", RevisionFloorCases.fixture),
   ("content-store.json", ContentStoreCases.fixture),
   ("node-namespace.json", NamespaceCases.fixture),
   ("fastcdc.json", FastCdcCases.fixture),
   ("content-store-tier.json", TierCases.fixture),
   ("vfs-visible-delta.json", VisibleDeltaCases.fixture),
   ("node-visible-namespace.json", NodeCases.nsFixture),
   ("node-overlay.json", NodeCases.overlayFixture),
   ("composite-vfs.json", CompositeCases.fixture),
   -- process-files.json (ProcessFilesCases.fixture): emitted again when the cutover adds its bridge (VFS-PF-001)
   ("composite-feed.json", CompositeFeedCases.fixture),
   ("composite-perm.json", CompositePermCases.fixture)]
   -- n18-ledger.json (LedgerCases.fixture) and n17-hydration.json (HydrationCases.fixture):
   -- emitted again when their bridges exist (N18-001, N17-001)

def main (args : List String) : IO UInt32 := do
  let dir := args.headD "fixtures"
  IO.FS.createDirAll dir
  for (name, text) in fixtures do
    IO.FS.writeFile (dir ++ "/" ++ name) text
  return 0
