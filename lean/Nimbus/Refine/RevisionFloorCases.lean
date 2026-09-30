/-
  Nimbus.Refine.RevisionFloorCases — `lean/fixtures/revision-floor.json`:
  sequences of `mkdir`, `writeFile`, `unlink`, `rename` and embedder
  transactions of several writes and removals against a small revision
  budget, with the revision the model's `revision` reports for every path seen
  after each step and what the invalidation log names each published path at
  (`logRev`, and the revision for its directory). `execBump` is the model's
  `bump` followed by the code's own cutoff rule (`PathRevisions.stamp`: drop
  at the stamp a quarter of the way up the sorted stamps, while over budget),
  which is one `Step.drop` per pass. A rename is two transactions (the
  destination, then the source's tombstone) and a transaction of `k`
  operations is `k`, each operation's paths at its own generation.
  `tests/unit/revision-floor-refinement.mjs` replays each case through
  `SqliteVFS` and compares every report and the log. No case prunes a
  tombstone: the code keeps 65,536.
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

/-- A bump inserts a stamp for each directory strictly above a path; one it
    moves to a mutated path was held already. -/
def execBump (budget : Nat) (e : Exec) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) : Exec :=
  let st := bump e.st paths fs gen rev
  let keys := (paths.flatMap fun p => prefixes p.dropLast).foldl
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
    never names a path below a file, nor a file above another path). -/
theorem execBump_reach (budget : Nat) (e : Exec) (paths fs : List Path) (gen : Path → Nat) (rev : Nat)
    (h : Reachable e.st) (ok : BumpOk e.st paths fs gen rev) :
    Reachable (execBump budget e paths fs gen rev).st :=
  dropWhileOver_reach budget _ _ (.step h (.bump _ paths fs gen rev ok))

theorem dropOnce_drops (e : Exec) : Drops e.st (dropOnce e).st :=
  Drops.drop _ _ .refl (Nat.min_le_right _ _)

theorem dropWhileOver_drops (budget : Nat) : ∀ n e, Drops e.st (dropWhileOver budget n e).st := by
  intro n
  induction n with
  | zero => intro e; exact .refl
  | succ n ih =>
    intro e
    simp only [dropWhileOver]
    split
    · exact drops_trans (dropOnce_drops e) (ih _)
    · exact .refl

/-- What a fixture step records for the log is `logRev` of a state the bump's
    drops reach, so `log_eq_revision` and `parent_log_eq_revision` apply to it. -/
theorem execBump_drops (budget : Nat) (e : Exec) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) :
    Drops (bump e.st paths fs gen rev) (execBump budget e paths fs gen rev).st := by
  exact dropWhileOver_drops budget _ { st := bump e.st paths fs gen rev, keys := _ }

/-- One operation of a case. -/
inductive Op where
  | mkdir (p : Path)
  | write (p : Path)
  | rm (p : Path)
  /-- The destination in one transaction, the source's tombstone in the next. -/
  | rename (src dst : Path)
  /-- An embedder transaction of writes (`true`) and removals, each operation its own transaction. -/
  | tx (ops : List (Bool × Path))

/-- The paths an operation publishes, its files, each path's generation and
    the revision it publishes at, from the clock before it. -/
def Op.plan (c : Nat) : Op → List Path × List Path × (Path → Nat) × Nat
  | .mkdir p => ([p], [], fun _ => c + 1, c + 1)
  | .write p => ([p], [p], fun _ => c + 1, c + 1)
  | .rm p => ([p], [], fun _ => c + 1, c + 1)
  | .rename src dst => ([dst, src], [dst], fun q => if q = dst then c + 1 else c + 2, c + 2)
  | .tx ops => Id.run do
    let mut paths : List Path := []
    let mut fs : List Path := []
    let mut gen : Path → Nat := fun _ => c
    let mut i := c
    for op in ops do
      let p := op.2
      i := i + 1
      if !paths.contains p then paths := paths ++ [p]
      fs := if op.1 then (if fs.contains p then fs else fs ++ [p]) else fs.erase p
      gen := upd gen p i
    return (paths, fs, gen, i)

/-- Below the five directories' stamps together, so every case drops some. -/
def budget : Nat := 160

def dirs : List Path := [["pkg"], ["pkg", "a"], ["pkg", "b"], ["pkg", "a", "c"], ["src"]]

def files : List Path :=
  [["pkg", "a", "index.js"], ["pkg", "a", "c", "x.json"], ["pkg", "b", "y.js"], ["pkg", "readme"],
   ["src", "main.ts"], ["src", "util.ts"], ["top.txt"]]

/-- Directories first, in an order that creates parents before children; then
    writes, removals, renames and transactions drawn at random, so rewrites of
    dropped paths, removals of written ones and renames over live files are
    common. A removal or a rename's source names a live file. -/
def genOps : Gen (List Op) := do
  let n := (← below 30) + 10
  let mut ops := dirs.map Op.mkdir
  let mut live : List Path := []
  for _ in [0:n] do
    let f ← pick files
    let kind ← below 6
    if kind == 0 && !live.isEmpty then
      let src ← pick live
      let dst ← pick (files.filter (· != src))
      ops := ops ++ [Op.rename src dst]
      live := (live.erase src).erase dst ++ [dst]
    else if kind == 1 then
      let k := (← below 3) + 2
      let mut inner : List (Bool × Path) := []
      for _ in [0:k] do
        let g ← pick files
        if live.contains g && (← chance 1 3) then
          inner := inner ++ [(false, g)]
          live := live.erase g
        else
          inner := inner ++ [(true, g)]
          if !live.contains g then live := live ++ [g]
      ops := ops ++ [Op.tx inner]
    else if live.contains f && (← chance 1 3) then
      ops := ops ++ [Op.rm f]
      live := live.erase f
    else
      ops := ops ++ [Op.write f]
      if !live.contains f then live := live ++ [f]
  return ops

/-- The log's entries for one bump, merged per path at the newest, as
    `invalidatedSince` answers them: each named path at `logRev`, and its
    directory at the revision. -/
def logOf (st : St) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) : List (Path × Nat) := Id.run do
  let mut out : List (Path × Nat) := []
  for p in paths do
    for (q, r) in [(p, logRev st fs gen p)] ++ (if p.dropLast = [] then [] else [(p.dropLast, rev)]) do
      out := match out.find? (·.1 == q) with
        | some _ => out.map fun (k, v) => if k == q then (k, max v r) else (k, v)
        | none => out ++ [(q, r)]
  return out

def opJson : Op → List (String × Json)
  | .mkdir p => [("op", .str "mkdir"), ("path", .str (keyOf p))]
  | .write p => [("op", .str "write"), ("path", .str (keyOf p))]
  | .rm p => [("op", .str "rm"), ("path", .str (keyOf p))]
  | .rename src dst => [("op", .str "rename"), ("from", .str (keyOf src)), ("path", .str (keyOf dst))]
  | .tx ops => [("op", .str "tx"), ("ops", .arr (ops.map fun (w, p) =>
      .obj [("op", .str (if w then "write" else "rm")), ("path", .str (keyOf p))]))]

def caseOf (ops : List Op) : Json := Id.run do
  let mut e : Exec := { st := init, keys := [] }
  let mut seen : List Path := []
  let mut out : Array Json := #[]
  for op in ops do
    let (paths, fs, gen, rev) := op.plan e.st.clock
    e := execBump budget e paths fs gen rev
    for p in paths do if !seen.contains p then seen := seen ++ [p]
    out := out.push (.obj (opJson op ++ [
      ("clock", .ofNat e.st.clock), ("floor", .ofNat e.st.floor),
      ("revisions", .obj (seen.map fun q => (keyOf q, Json.ofNat (revision e.st q)))),
      ("log", .obj ((logOf e.st paths fs gen rev).map fun (q, r) => (keyOf q, Json.ofNat r)))]))
  return .obj [("steps", .arr out.toList)]

def fixture : String :=
  fixtureText [("fixture", .str "revision-floor"), ("model", .str "Nimbus.Vfs.RevisionFloor.Step"),
      ("budget", .ofNat budget)]
    (runGen 0x464C4F4F52 (do
      let mut out := #[]
      for _ in [0:40] do out := out.push (caseOf (← genOps))
      return out.toList))

end Nimbus.Refine.RevisionFloorCases
