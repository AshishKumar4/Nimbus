/-
  Nimbus.Coherence.Visibility — which reported names reach a principal
  (work/vfs-lazy-inodes 7c53d244, `vfs-view-and-visibility-rules.md` §3).

  An entry (path, rev R) is named to C when each ancestor passes, deepest first:
  a directory with a removal record at rev ≥ R is judged by the first such
  record's mode; a directory standing since R, and everything above it, by its
  current mode. The log names each path at its newest revision in range.

  The rule has one reachable gap against property (ii), "every path C could
  list is named, even after removal": when a directory is made untraversable and
  then removed, the removal's entry for each path under it carries the removal
  revision, the record carries the untraversable mode, and the name is withheld
  from C — although C could list the path before the chmod and may hold a row
  for it. A store that evicts exact names keeps that row
  (`a_chmod_then_remove_hides_a_listed_path`). A facet that drops the subtree
  when a directory's own entry reports it absent or untraversable is not
  affected; the directory's own entries are named (its parent stands).

  A concrete trace on one directory `/d` holding `/d/p`, owner 0 and a reader 1;
  modes are reduced to "others may traverse".
-/

namespace Nimbus.Coherence.Visibility

inductive Ev where
  | write (path : String)
  | chmod (dir : String) (othersTraverse : Bool)
  | rmrf (dir : String) (under : List String)

/-- A removal record: the directory, whether others could traverse it, the
    removing revision. -/
structure Record where
  dir : String
  othersTraverse : Bool
  rev : Nat

structure Log where
  /-- (path, newest revision) in range. -/
  entries : List (String × Nat)
  records : List Record

/-- Revisions 1.. for `hist`; `/d` starts traversable by others. -/
def replay (hist : List Ev) : Log × (String → Bool) := Id.run do
  let mut entries : List (String × Nat) := []
  let mut records : List Record := []
  let mut mode : String → Bool := fun _ => true
  let mut rev := 0
  for e in hist do
    rev := rev + 1
    let named := match e with
      | .write p => [p]
      | .chmod d _ => [d]
      | .rmrf d under => d :: under
    for p in named do entries := (entries.filter (·.1 != p)) ++ [(p, rev)]
    match e with
    | .chmod d t => mode := fun x => if x == d then t else mode x
    | .rmrf d _ => records := records ++ [⟨d, mode d, rev⟩]
    | .write _ => pure ()
  return (⟨entries, records⟩, mode)

/-- The rule, for a path directly under `d`, for a reader that is not the owner. -/
def named (log : Log) (d : String) (e : String × Nat) : Bool :=
  match log.records.find? (fun r => r.dir == d && decide (e.2 ≤ r.rev)) with
  | some r => r.othersTraverse
  | none => true

def hist : List Ev := [.write "/d/p", .chmod "/d" false, .rmrf "/d" ["/d/p"]]

/-- After `/d/p` is written while `/d` is traversable (the reader may list and
    fill it), `/d` is made untraversable and removed: the delta's only entry for
    `/d/p` is the removal's, and the rule withholds it from the reader. -/
theorem a_chmod_then_remove_hides_a_listed_path :
    let log := (replay hist).1
    ("/d/p", 3) ∈ log.entries ∧ named log "/d" ("/d/p", 3) = false ∧
    named (replay [.write "/d/p"]).1 "/d" ("/d/p", 1) = true := by
  decide

end Nimbus.Coherence.Visibility
