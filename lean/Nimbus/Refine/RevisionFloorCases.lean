/-
  Nimbus.Refine.RevisionFloorCases — `lean/fixtures/revision-floor.json`:
  sequences of `mkdir` and `writeFile` against a small per-path revision
  budget, with the revision the model's `revision` reports for every path seen
  after each step. `execBump` is the model's `bump` followed by the code's own
  cutoff rule (`dropOldestPathRevisions`: drop at the stamp a quarter of the
  way up the sorted stamps, while over budget), which is one `Step.drop` per
  pass. `tests/unit/revision-floor-refinement.mjs` replays each case through
  `SqliteVFS` and compares every report (with P5, a written file whose stamp
  was dropped reports its row's generation).
-/

import Nimbus.Vfs.RevisionFloor
import Nimbus.Refine.Json

namespace Nimbus.Refine.RevisionFloorCases

open Nimbus.Vfs.RevisionFloor
open Nimbus.Refine

/-- The model state plus the stamped paths in first-stamp order: what the code's
    `Map` iterates, needed only to size the budget and pick the cutoff. -/
structure Exec where
  st : St
  keys : List Path

def keyOf (p : Path) : String := "/".intercalate p

/-- `SqliteVFS.entryBytes`: UTF-16 payload plus 48 (every fixture path is ASCII). -/
def entryBytes (p : Path) : Nat := (keyOf p).length * 2 + 48

def heldBytes (e : Exec) : Nat := e.keys.foldl (fun a p => a + entryBytes p) 0

def prefixes (p : Path) : List Path := (List.range p.length).map fun i => p.take (i + 1)

/-- One pass of `dropOldestPathRevisions`. The cutoff is clamped to the clock,
    which it never exceeds, so the pass is `Step.drop` by construction. -/
@[noinline] def dropOnce (e : Exec) : Exec :=
  let stamps := (e.keys.filterMap e.st.stamps).mergeSort (· ≤ ·)
  let cutoff := min (stamps.getD (stamps.length / 4) 0) e.st.clock
  let st := drop e.st cutoff
  { st, keys := e.keys.filter fun p => (st.stamps p).isSome }

def dropWhileOver (budget : Nat) : Nat → Exec → Exec
  | 0, e => e
  | n + 1, e => if heldBytes e > budget then dropWhileOver budget n (dropOnce e) else e

def execBump (budget : Nat) (e : Exec) (paths fs : List Path) : Exec :=
  let st := bump e.st paths fs
  let keys := (paths.flatMap prefixes).foldl
    (fun ks q => if ks.contains q then ks else ks ++ [q]) e.keys
  dropWhileOver budget (keys.length + 1) { st, keys }

theorem dropOnce_step (e : Exec) : Step e.st (dropOnce e).st :=
  Step.drop _ _ (Nat.min_le_right _ _)

theorem dropWhileOver_reach (budget : Nat) :
    ∀ n e, Reachable e.st → Reachable (dropWhileOver budget n e).st := by
  intro n
  induction n with
  | zero => intro e h; exact h
  | succ n ih =>
    intro e h
    simp only [dropWhileOver]
    split
    · exact ih _ (.step h (dropOnce_step e))
    · exact h

/-- Every state a fixture reports is a reachable model state (the generator
    never names a path below a file). -/
theorem execBump_reach (budget : Nat) (e : Exec) (paths fs : List Path) (h : Reachable e.st)
    (hfs : ∀ f ∈ fs, f ∈ paths) (hnest : ∀ p ∈ paths, ∀ a, Under a p → a ≠ p → e.st.files a = none) :
    Reachable (execBump budget e paths fs).st :=
  dropWhileOver_reach budget _ _ (.step h (.bump _ paths fs hfs hnest))

inductive Op where
  | mkdir (p : Path)
  | write (p : Path)

def Op.path : Op → Path
  | .mkdir p => p
  | .write p => p

def budget : Nat := 700

def dirs : List Path := [["pkg"], ["pkg", "a"], ["pkg", "b"], ["pkg", "a", "c"], ["src"]]

def files : List Path :=
  [["pkg", "a", "index.js"], ["pkg", "a", "c", "x.json"], ["pkg", "b", "y.js"], ["pkg", "readme"],
   ["src", "main.ts"], ["src", "util.ts"], ["top.txt"]]

/-- Directories first, in an order that creates parents before children; then
    writes drawn at random, so rewrites of dropped paths are common. -/
def genOps : Gen (List Op) := do
  let n := (← below 40) + 10
  let mut ops := dirs.map Op.mkdir
  for _ in [0:n] do ops := ops ++ [Op.write (← pick files)]
  return ops

def stepJson (e : Exec) (seen : List Path) : Op → Json
  | op =>
    let (name, p) := match op with
      | .mkdir p => ("mkdir", p)
      | .write p => ("write", p)
    .obj [("op", .str name), ("path", .str (keyOf p)),
      ("clock", .ofNat e.st.clock), ("floor", .ofNat e.st.floor),
      ("revisions", .obj (seen.map fun q => (keyOf q, Json.ofNat (revision e.st q))))]

def caseOf (ops : List Op) : Json := Id.run do
  let mut e : Exec := { st := init, keys := [] }
  let mut seen : List Path := []
  let mut out : Array Json := #[]
  for op in ops do
    e := execBump budget e [op.path] (match op with | .mkdir _ => [] | .write p => [p])
    if !seen.contains op.path then seen := seen ++ [op.path]
    out := out.push (stepJson e seen op)
  return .obj [("steps", .arr out.toList)]

def fixture : String :=
  fixtureText [("fixture", .str "revision-floor"), ("model", .str "Nimbus.Vfs.RevisionFloor.Step"),
      ("budget", .ofNat budget)]
    (runGen 0x464C4F4F52 (do
      let mut out := #[]
      for _ in [0:40] do out := out.push (caseOf (← genOps))
      return out.toList))

end Nimbus.Refine.RevisionFloorCases
