/-
  Nimbus.Refine.VisibleDeltaCases — `lean/fixtures/vfs-visible-delta.json`: a
  tree built by root (setup), a reader C (uid 1000, not in root's group), a
  cursor, then a window of root's mutations. Directories are mode 0755 (C may
  traverse) or 0700 (it may not). For each case the model gives:

  - `held`: every file C can see at the cursor (what `raw.as(C).list()` yields);
  - `mustEvict`: the held files whose node changed or that C can no longer see
    at answer time (`VisibleDelta.coherence`: nothing else may survive);
  - `forbidden`: every path existing at the cursor or at answer time that C
    cannot see at answer time (`VisibleDelta.no_leak`: no reported name is one).

  VfsLazyInodesLane's `tests/unit/vfs-visible-delta-fixture.mjs` replays setup
  and window through `SqliteVFS`, takes `invalidatedSince` as C, applies the
  eviction rule (a named row; everything at or under a subtree or structural
  entry) to `held`, and checks the evicted set covers `mustEvict` and no reported
  path is in `forbidden`. Paths are written without a leading slash.
-/

import Nimbus.Coherence.VisibleDelta
import Nimbus.Refine.Json

namespace Nimbus.Refine.VisibleDeltaCases

open Nimbus.Coherence.VisibleDelta (Node World)
open Nimbus.Refine

abbrev Path := List String

abbrev Tree := List (Path × Node)

def look (t : Tree) (p : Path) : Option Node := (t.find? (·.1 == p)).map (·.2)

def isDir (t : Tree) (p : Path) : Bool := p == [] || (look t p).any (·.isDir)

def under (a q : Path) : Bool := a.isPrefixOf q && a != q

/-- C can see `p`: every directory strictly above it (the root excepted) is traversable. -/
def visible (t : Tree) (p : Path) : Bool :=
  (List.range p.length).all fun i =>
    let a := p.take i
    a == [] || (look t a).any fun n => n.isDir && n.trav

inductive Op where
  | mkdir (p : Path) (trav : Bool)
  | write (p : Path)
  | chmod (p : Path) (trav : Bool)
  | rmrf (p : Path)
  | rename (a b : Path)

def apply (t : Tree) (ver : Nat) : Op → Option Tree
  | .mkdir p tr =>
    if p != [] && isDir t p.dropLast && look t p == none then some (t ++ [(p, ⟨true, tr, ver⟩)]) else none
  | .write p =>
    if p != [] && isDir t p.dropLast && !(look t p).any (·.isDir) then
      some ((t.filter (·.1 != p)) ++ [(p, ⟨false, true, ver⟩)]) else none
  | .chmod p tr =>
    match look t p with
    | some n => if n.isDir && n.trav != tr then some (t.map fun x => if x.1 == p then (p, { n with trav := tr }) else x)
      else none
    | none => none
  | .rmrf p => if look t p != none then some (t.filter fun x => !(p.isPrefixOf x.1)) else none
  | .rename a b =>
    if look t a != none && look t b == none && b != [] && isDir t b.dropLast && !a.isPrefixOf b then
      some (t.map fun x => if a.isPrefixOf x.1 then (b ++ x.1.drop a.length, x.2) else x)
    else none

def key (p : Path) : String := "/".intercalate p

def opJson : Op → Json
  | .mkdir p tr => .obj [("op", .str "mkdir"), ("path", .str (key p)), ("mode", .ofNat (if tr then 493 else 448))]
  | .write p => .obj [("op", .str "write"), ("path", .str (key p))]
  | .chmod p tr => .obj [("op", .str "chmod"), ("path", .str (key p)), ("mode", .ofNat (if tr then 493 else 448))]
  | .rmrf p => .obj [("op", .str "rmrf"), ("path", .str (key p))]
  | .rename a b => .obj [("op", .str "rename"), ("path", .str (key a)), ("to", .str (key b))]

def names : List String := ["a", "b", "c"]

def genOp (t : Tree) : Gen Op := do
  let dirs := [] :: (t.filter (·.2.isDir)).map (·.1)
  let inDir := (← pick dirs) ++ [← pick names]
  let old ← pick (t.map (·.1))
  let existing := if t.isEmpty then inDir else old
  let k ← below 12
  let r3 ← below 3
  let r2 ← below 2
  if k < 2 then return .mkdir inDir (r3 != 0)
  else if k < 5 then return .write (if r2 == 0 then inDir else existing)
  else if k < 9 then
    let ds := (t.filter (·.2.isDir)).map (·.1)
    let d ← pick ds
    return .chmod (if ds.isEmpty then existing else d) (r2 == 0)
  else if k < 10 then return .rmrf existing
  else return .rename existing inDir

def runOps (t : Tree) (ver : Nat) (n : Nat) : Gen (Tree × Nat × Array Json) := do
  let mut t := t
  let mut ver := ver
  let mut out := #[]
  for _ in [0:n] do
    let op ← genOp t
    if let some t' := apply t (ver + 1) op then
      ver := ver + 1
      t := t'
      out := out.push (opJson op)
  return (t, ver, out)

def sorted (ps : List Path) : List Json :=
  ((ps.map key).mergeSort (· ≤ ·)).map Json.str

def genCase : Gen (Option Json) := do
  let (t0, v0, setup) ← runOps [] 0 ((← below 12) + 6)
  let (t1, _, window) ← runOps t0 v0 ((← below 6) + 1)
  let held := (t0.filter fun x => !x.2.isDir && visible t0 x.1).map (·.1)
  let mustEvict := held.filter fun p => look t1 p != look t0 p || !visible t1 p
  let all := (t0.map (·.1)) ++ (t1.map (·.1))
  let forbidden := (all.filter fun p => !visible t1 p).eraseDups
  if held.isEmpty then return none
  return some (.obj [("setup", .arr setup.toList), ("window", .arr window.toList),
    ("held", .arr (sorted held)), ("mustEvict", .arr (sorted mustEvict)), ("forbidden", .arr (sorted forbidden))])

/-- Directed cases: chmod-only revocation, chmod-then-remove (the e5066041 trace),
    a directory removed and remade, a rename away, and an opened directory. -/
def directed : List Json :=
  let d (setup window : List Op) : Json := Id.run do
    let mut t : Tree := []
    let mut v := 0
    let mut s := #[]
    for op in setup do
      if let some t' := apply t (v + 1) op then
        v := v + 1; t := t'; s := s.push (opJson op)
    let t0 := t
    let mut w := #[]
    for op in window do
      if let some t' := apply t (v + 1) op then
        v := v + 1; t := t'; w := w.push (opJson op)
    let held := (t0.filter fun x => !x.2.isDir && visible t0 x.1).map (·.1)
    let mustEvict := held.filter fun p => look t p != look t0 p || !visible t p
    let forbidden := (((t0.map (·.1)) ++ (t.map (·.1))).filter fun p => !visible t p).eraseDups
    .obj [("setup", .arr s.toList), ("window", .arr w.toList),
      ("held", .arr (sorted held)), ("mustEvict", .arr (sorted mustEvict)), ("forbidden", .arr (sorted forbidden))]
  [ d [.mkdir ["d"] true, .mkdir ["d", "e"] true, .write ["d", "e", "p"], .write ["d", "q"]] [.chmod ["d"] false],
    d [.mkdir ["d"] true, .write ["d", "p"]] [.chmod ["d"] false, .rmrf ["d"]],
    d [.mkdir ["d"] true, .write ["d", "p"]] [.rmrf ["d"], .mkdir ["d"] true, .write ["d", "q"]],
    d [.mkdir ["d"] true, .write ["d", "p"]] [.rename ["d"] ["e"]],
    d [.mkdir ["d"] false, .write ["d", "p"], .write ["q"]] [.chmod ["d"] true, .write ["q"]] ]

def fixture : String :=
  fixtureText [("fixture", .str "vfs-visible-delta"), ("model", .str "Nimbus.Coherence.VisibleDelta"),
      ("reader", .obj [("uid", .ofNat 1000), ("gid", .ofNat 1000), ("groups", .arr [.ofNat 1000]), ("umask", .ofNat 18)]),
      ("note", .str "setup and window run as root (kernel cred); mkdir/chmod modes 493=0755 (reader may traverse) or 448=0700; write puts fresh bytes; cursor is taken between setup and window")]
    (directed ++ runGen 0x564953 (casesOf 150 genCase))

end Nimbus.Refine.VisibleDeltaCases
