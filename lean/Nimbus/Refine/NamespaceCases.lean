/-
  Nimbus.Refine.NamespaceCases — `lean/fixtures/node-namespace.json`: random
  tree mutations at the authority, with a facet acquiring between them. Each
  acquire's delta names every path whose entry changed since the facet's last
  one, at its current entry, and the facet applies it with the model's
  `applyDelta`; the fixture records the namespace the facet must then hold
  (`apply_exact` proves it is the authority's). NodeNoMirrorBuild's
  `tests/unit/node-namespace-refinement.mjs` replays the mutations through
  `SqliteVFS` and the facet's `__nsApplyEntry`.
-/

import Nimbus.Coherence.Namespace
import Nimbus.Refine.Json

namespace Nimbus.Refine.NamespaceCases

open Nimbus.Coherence.Namespace
open Nimbus.Refine

abbrev Path := List String

/-- A tree as its entries (the root is implicit). -/
abbrev Entries := List (Path × Kind)

def lookup (t : Entries) (p : Path) : Option Kind := (t.find? (·.1 == p)).map (·.2)

def tree (t : Entries) : Tree := lookup t

def isDirOrRoot (t : Entries) (p : Path) : Bool := p == [] || lookup t p == some .dir

def under (a q : Path) : Bool := a.isPrefixOf q && a != []

inductive Op where
  | mkdir (p : Path)
  | write (p : Path) (n : Nat)
  | rm (p : Path)
  | rmrf (p : Path)
  | rename (a b : Path)

def step (t : Entries) : Op → Option Entries
  | .mkdir p =>
    if p != [] && isDirOrRoot t p.dropLast && lookup t p == none then some (t ++ [(p, .dir)]) else none
  | .write p n =>
    if p != [] && isDirOrRoot t p.dropLast && (lookup t p).all (fun k => match k with | .file _ => true | .dir => false)
    then some ((t.filter (·.1 != p)) ++ [(p, .file n)]) else none
  | .rm p => match lookup t p with
    | some (.file _) => some (t.filter (·.1 != p))
    | _ => none
  | .rmrf p => if lookup t p != none then some (t.filter fun x => !(under p x.1)) else none
  | .rename a b =>
    if lookup t a != none && lookup t b == none && b != [] && isDirOrRoot t b.dropLast && !(under a b) then
      some (t.map fun x => if under a x.1 then (b ++ x.1.drop a.length, x.2) else x)
    else none

/-- Every path whose entry differs between two trees. -/
def changed (t t' : Entries) : List Path :=
  ((t.map (·.1)) ++ (t'.map (·.1))).foldl (fun acc p =>
    if acc.contains p || lookup t p == lookup t' p then acc else acc ++ [p]) []

def key (p : Path) : String := "/" ++ "/".intercalate p

def kindJson : Kind → Json
  | .dir => .obj [("kind", .str "dir")]
  | .file n => .obj [("kind", .str "file"), ("bytes", .str s!"v{n}")]

def opJson : Op → Json
  | .mkdir p => .obj [("auth", .str "mkdir"), ("path", .str (key p))]
  | .write p n => .obj [("auth", .str "write"), ("path", .str (key p)), ("bytes", .str s!"v{n}")]
  | .rm p => .obj [("auth", .str "rm"), ("path", .str (key p))]
  | .rmrf p => .obj [("auth", .str "rmrf"), ("path", .str (key p))]
  | .rename a b => .obj [("auth", .str "rename"), ("path", .str (key a)), ("to", .str (key b))]

def names : List String := ["a", "b", "c"]

def genPath : Gen Path := do
  let n := (← below 3) + 1
  let mut p := []
  for _ in [0:n] do p := p ++ [← pick names]
  return p

/-- A mutation, aimed at what exists often enough to remove and rename. -/
def genOp (t : Entries) : Gen Op := do
  let k ← below 10
  let fresh ← genPath
  let dirs := [] :: (t.filter (·.2 == .dir)).map (·.1)
  let inDir := (← pick dirs) ++ [← pick names]
  let pickOld ← pick (t.map (·.1))
  let old := if t.isEmpty then fresh else pickOld
  if k < 3 then return .mkdir inDir
  else if k < 5 then return .write inDir (← below 4)
  else if k < 6 then return .write old (← below 4)
  else if k < 7 then return .rm old
  else if k < 8 then return .rmrf old
  else return .rename old inDir

/-- The authority's tree (sorted, so the fixture is stable). -/
def entriesJson (t : Entries) : Json :=
  .obj ((t.mergeSort fun x y => decide (key x.1 ≤ key y.1)).map fun x => (key x.1, kindJson x.2))

def genCase : Gen (Option Json) := do
  let n := (← below 20) + 5
  let mut t : Entries := []
  let mut ns : Tree := fun _ => none
  let mut pending : List Path := []
  let mut out : Array Json := #[]
  for _ in [0:n] do
    if (← below 5) == 0 then
      -- ACQUIRE: every path changed since the last one, at its entry now
      let d := pending.map fun p => (p, lookup t p)
      ns := applyDelta ns d
      pending := []
      out := out.push (.obj [("facet", .str "acquire"),
        ("expect", .obj ((t.mergeSort fun x y => decide (key x.1 ≤ key y.1)).filterMap fun x =>
          (ns x.1).map fun k => (key x.1, kindJson k)))])
    else
      let op ← genOp t
      if let some t' := step t op then
        pending := pending ++ (changed t t').filter (fun p => !pending.contains p)
        t := t'
        out := out.push (opJson op)
  let d := pending.map fun p => (p, lookup t p)
  ns := applyDelta ns d
  out := out.push (.obj [("facet", .str "acquire"),
    ("expect", .obj ((t.mergeSort fun x y => decide (key x.1 ≤ key y.1)).filterMap fun x =>
      (ns x.1).map fun k => (key x.1, kindJson k)))])
  return some (.obj [("steps", .arr out.toList)])

def fixture : String :=
  fixtureText [("fixture", .str "node-namespace"), ("model", .str "Nimbus.Coherence.Namespace.applyDelta"),
      ("note", .str "facet starts empty at cursor 0; each acquire must leave the facet namespace equal to expect (every path, kind, and file bytes)")]
    (runGen 0x4E53 (casesOf 120 genCase))

end Nimbus.Refine.NamespaceCases
