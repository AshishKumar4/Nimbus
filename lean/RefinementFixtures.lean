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
   ("process-files.json", ProcessFilesCases.fixture),
   ("composite-feed.json", CompositeFeedCases.fixture)]

def main (args : List String) : IO UInt32 := do
  let dir := args.headD "fixtures"
  IO.FS.createDirAll dir
  for (name, text) in fixtures do
    IO.FS.writeFile (dir ++ "/" ++ name) text
  return 0
