/-
  Writes every refinement fixture into the directory named by the first
  argument: `lake env lean --run RefinementFixtures.lean fixtures`.
  `scripts/verify-lean.sh` writes them afresh and fails when `lean/fixtures/`
  differs.
-/

import Nimbus.Refine

open Nimbus.Refine

/-! Resolving-mount additions live at the fixture entrypoint so the original
    unflagged generators, their seeds, field order and case bytes stay intact. -/
namespace ResolvingFixtures

open Nimbus.Vfs.CompositePerm
open Nimbus.Vfs.CompositeBeneath
open Nimbus.Refine.CompositePermCases

def mounts (S : St) : Json := .arr (S.mounts.map fun m =>
  .obj ([ ("point", .str (key m.point)), ("backend", .str s!"b{m.bk}") ] ++
    if resolvesAt S m.point then [("resolvesPaths", .bool true)] else []))

/-- New options are omitted unless true; every old unflagged case is untouched. -/
def options (S : St) (root : Bool) : Json → Json
  | .obj fields => .obj ((fields.map fun (k, v) => (k, if k = "mounts" then mounts S else v)) ++
      if root then [("rootResolvesPaths", .bool true)] else [])
  | j => j

def permCase (S : St) (ks : List Nat) (steps : List (Cred × Op × Path)) (root : Bool := false) : Json :=
  options S root (traceCase S ks steps)

def perm : List Json :=
  [permCase operandTrace [0, 1, 2, 3]
    [(kernel, .readFile, ["m", "missing", "..", "f"]),
     (kernel, .readFile, ["m", "..", "m", "missing", "..", "f"]),
     (kernel, .stat, ["m", "missing", "..", "f"]),
     (kernel, .readFile, ["m", "f", ""]), (kernel, .readFile, ["m", "f", "."]),
     (kernel, .stat, ["m", "f", ""]), (kernel, .stat, ["m", "f", "."]),
     (kernel, .readFile, ["m", ".", "f"]), (kernel, .readFile, ["m", "", "f"]),
     (kernel, .readFile, ["m", "link", "..", "f"]),
     (kernel, .readFile, ["m", "n", "..", "f"]),
     (kernel, .readFile, ["m", "n", "..", "missing", "..", "f"]),
     (kernel, .readFile, ["m", "a", "x", "missing", "..", "f"]),
     (kernel, .readFile, ["m", "missing", "..", "n", "f"]),
     (kernel, .readFile, ["m", "n", "..", "missing", "..", "n", "f"]),
     (kernel, .readFile, ["m", "a", "n", "..", "x", "f"]),
     (kernel, .readFile, ["m", "n", "..", "..", "x"]),
     (kernel, .stat, ["m", "dir", ".."]),
     (kernel, .mkdir, ["m", "link"]), (kernel, .readFile, ["m", "loop"]),
     (kernel, .writeFile 7, ["m", "link", "new"]),
     (kernel, .readFile, ["m", "a", "b", "new"]),
     (kernel, .writeFile 8, ["m", "link", "..", "made"]),
     (kernel, .readFile, ["m", "a", "made"]), (kernel, .stat, ["m", "made"]),
     (kernel, .writeFile 9, ["m", "missing", "..", "notMade"]),
     (kernel, .writeFile 9, ["m", "f", ""]), (kernel, .writeFile 9, ["m", "f", "."]),
     (kernel, .unlink, ["m", "toF", ""]), (kernel, .unlink, ["m", "toF"]),
     (kernel, .readFile, ["m", "f"])],
   permCase (operandTrace true) [0, 1, 2, 3]
    [(kernel, .readFile, ["m", "missing", "..", "n", "f"]),
     (kernel, .readFile, ["m", "n", "missing", "..", "f"]),
     (kernel, .readFile, ["m", "n", "f", ""]),
     (kernel, .readFile, ["m", "n", "..", "f"])],
   permCase rootOperandTrace [0, 1, 2]
    [(kernel, .readFile, ["missing", "..", "f"]),
     (kernel, .readFile, ["f", ""]), (kernel, .readFile, ["f", "."]),
     (kernel, .readFile, [".", "f"]), (kernel, .readFile, ["", "f"]),
     (kernel, .readFile, ["link", "..", "f"]),
     (kernel, .readFile, ["n", "..", "f"]),
     (kernel, .readFile, ["n", "..", "missing", "..", "f"]),
     (kernel, .readFile, ["missing", "..", "n", "f"]),
     (kernel, .writeFile 7, ["link", "new"]),
     (kernel, .readFile, ["a", "b", "new"]),
     (kernel, .writeFile 8, ["link", "..", "made"]),
     (kernel, .readFile, ["a", "made"]), (kernel, .stat, ["made"])] true]

/-- Both rename operands keep their own physical parent. Failed source/target
    walks leave every backend unchanged, as the final tree also records. -/
def renameCase : Json := Id.run do
  let S0 := operandTrace
  let mut S := S0
  let mut out := #[]
  for (a, b) in [(["m", "link", "..", "f"], ["m", "link", "..", "renamed"]),
      (["m", "missing", "..", "f"], ["m", "dir", "other"]),
      (["m", "f"], ["m", "missing", "..", "other"])] do
    let (o, T) := cRename S kernel a b
    S := T
    out := out.push (.obj [("as", .ofNat 0), ("op", .str "rename"), ("path", .str (key a)),
      ("to", .str (key b)), ("expect", outJson o)])
  for (op, p) in [(Op.readFile, ["m", "a", "renamed"]), (.readFile, ["m", "f"]),
      (.stat, ["m", "a", "f"])] do
    out := out.push (opJson kernel op p (cOp S kernel op p).1)
  let ks := [0, 1, 2, 3]
  return options S0 false (.obj [("mounts", mounts S0),
    ("backends", .obj (ks.map fun k => (s!"b{k}", backendJson (S0.bks k)))),
    ("steps", .arr out.toList), ("final", .obj (ks.map fun k => (s!"b{k}", entsJson (S.bks k))))])

def beneathStep (S : St) (c : Cred) (R : Path) (follow abs : Bool) (raw : Path) : Json :=
  .obj [("as", .ofNat c.uid), ("root", .str (key R)),
    ("path", .str (BeneathCases.pathStr abs raw)), ("follow", .bool follow),
    ("expect", BeneathCases.ansJson (resolveBDispatch S c follow R abs raw))]

def beneathCase (S : St) (ks : List Nat) (steps : List (Path × Bool × Bool × Path)) (root : Bool := false) : Json :=
  options S root (.obj [("mounts", mounts S),
    ("backends", .obj (ks.map fun k => (s!"b{k}", backendJson (S.bks k)))),
    ("steps", .arr (steps.map fun (R, f, abs, raw) => beneathStep S kernel R f abs raw))])

def beneath : List Json :=
  [beneathCase operandTrace [0, 1, 2, 3]
    [([], true, false, ["m", "missing", "..", "f"]),
     (["m"], true, false, ["missing", "..", "f"]),
     (["m"], true, false, ["f", ""]), (["m"], true, false, ["f", "."]),
     (["m"], true, false, [".", "f"]), ([], true, false, ["m", "", "f"]),
     (["m"], true, false, ["link", "..", "f"]),
     (["m"], true, false, ["n", "..", "f"]),
     (["m"], true, false, ["n", "..", "missing", "..", "f"]),
     (["m"], true, false, ["a", "x", "missing", "..", "f"]),
     (["m"], true, false, ["missing", "..", "n", "f"]),
     (["m"], true, false, ["n", "..", "missing", "..", "n", "f"]),
     (["m"], true, false, ["a", "n", "..", "x", "f"]),
     (["m"], true, false, ["n", "..", "..", "x"]),
     (["m"], true, false, ["link", "..", "..", "f"]),
     ([], true, false, ["m", "n", "..", "..", "x"]),
     (["m"], true, false, ["dir", ".."]),
     (["m"], true, false, ["link", "new"]),
     (["m"], true, false, ["link", "..", "made"]),
     (["m"], false, false, ["toF"]), (["m"], false, false, ["toF", ""]),
     (["m"], true, false, ["loop"]),
     (["m", "a", "b"], true, false, ["..", "f"]),
     (["m", "a"], true, false, ["b", "..", "f"]),
     (["m"], true, true, ["f"])],
   beneathCase (operandTrace true) [0, 1, 2, 3]
    [(["m"], true, false, ["missing", "..", "n", "f"]),
     (["m"], true, false, ["n", "missing", "..", "f"]),
     (["m"], true, false, ["n", "f", ""]),
     (["m"], true, false, ["n", "..", "f"])]]

def field (fields : List (String × Json)) (k : String) : Json :=
  ((fields.find? (·.1 == k)).map (·.2)).getD .null

def stringField (fields : List (String × Json)) (k : String) : String :=
  match field fields k with | .str s => s | _ => ""

/-- Re-evaluate the old flagged device case through the dispatch model. Its
    unflagged neighbours and every generated case remain byte-identical. -/
def device : Json :=
  let S := deviceTrace true
  let step : Json → Json := fun j => match j with
    | .obj fields =>
      let uid := match field fields "as" with | .int n => n.toNat | _ => 0
      let c := (creds.find? (·.uid == uid)).getD kernel
      let R := lex [] ((stringField fields "root").splitOn "/")
      let path := stringField fields "path"
      let abs := path.startsWith "/"
      let raw := (path.splitOn "/").drop (if abs then 1 else 0)
      let follow := match field fields "follow" with | .bool f => f | _ => true
      .obj (fields.map fun (k, v) => (k, if k = "expect" then
        BeneathCases.ansJson (resolveBDispatch S c follow R abs raw) else v))
    | _ => j
  match BeneathCases.device with
  | .obj fields => .obj (fields.map fun (k, v) => (k, if k = "steps" then
      match v with
      | .arr steps => .arr (steps.map step ++ [beneathStep S u2 [] true false ["pc", "vault", "mine", "g"]])
      | _ => v else v))
  | j => j

def append (base : String) (cases : List Json) : String :=
  base.dropRight 4 ++ ",\n" ++ ",\n".intercalate (cases.map Json.render) ++ "\n]}\n"

def note : String := "resolvesPaths mounts receive design section 3 raw operands (empty components, dots and final slash preserved after the namespace-owned cut), interpreted physically by the backend-local unflagged walker; public spelling stays lexical unless an operand contains .., when its raw spelling preserves the physical parent; composite-perm's optional case rootResolvesPaths enables the same rule at /; otherwise the original unflagged rules apply: "

def permFixture : String :=
  append (CompositePermCases.fixture.replace "\"note\":\"" ("\"note\":\"" ++ note)) (perm ++ [renameCase])

def beneathFixture : String :=
  append ((BeneathCases.fixture.replace BeneathCases.device.render device.render).replace
    "\"model\":\"Nimbus.Vfs.CompositeBeneath.resolveB\""
    "\"model\":\"Nimbus.Vfs.CompositeBeneath.resolveBDispatch\"" |>.replace
    "\"note\":\"" ("\"note\":\"" ++ note)) beneath

end ResolvingFixtures

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
   ("composite-feed.json", CompositeFeedCases.fixture),
   ("composite-perm.json", ResolvingFixtures.permFixture),
   ("n17-hydration.json", HydrationCases.fixture),
   ("quiesce.json", QuiesceCases.fixture),
   ("resident-poison-reconcile.json", HeldCases.fixture),
   ("beneath.json", ResolvingFixtures.beneathFixture),
   ("n18-ledger.json", LedgerCases.fixture),
   ("pipes.json", PipesCases.fixture)]

def main (args : List String) : IO UInt32 := do
  let dir := args.headD "fixtures"
  IO.FS.createDirAll dir
  for (name, text) in fixtures do
    IO.FS.writeFile (dir ++ "/" ++ name) text
  return 0
