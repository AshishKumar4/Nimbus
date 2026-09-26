/-
  Nimbus.Runtime.PipesHeld — the held exit status (Main's rule, for writers that cannot
  park: any process on a local host).

  A writer that exits while a pipe it writes holds more than `C` unread bytes, with a
  reader left, would on Linux still be blocked writing. Its exit status is held. It
  settles once every such pipe's read ends are all gone: 141 if any of them still held
  more than `C` unread bytes when its last reader left, else the writer's own status.
  The hold is an overlay on the run: the scheduler, the pipes and every other process
  run exactly as without it.

  Proved:
  - `hstep_core` (a): a step with the rule runs exactly the step without it (same
    process, same answer, same pipes, same bytes read, same EOFs, same other
    statuses); `hrun_core`: so does a whole run.
  - `settles_only_readerless`: a held status settles only when every pipe it is held on
    has no read end.
  - `all_settle` (c): once no process is alive (every pipeline ends so), no status is
    still held.
  - `settle_value`: it settles to 141 exactly when some held pipe had more than `C`
    unread bytes at its last reader's close, else to the writer's own status.
  Traces (`seq_head`, `seq_uniq_wc_held`, `yes_head_held`, `seq_small_head`):
  `seq 1000000 | head -2` is 141 0; `seq | uniq -c | wc -l` stays 0 0 0;
  `yes | head -2` is 141 0; `seq 1000 | head -1` stays 0 0.
  With one writer per pipe the settled status is Linux's (the writer completes once
  the unread bytes fall to `C`, else is SIGPIPEd); with several writers another
  writer's bytes can count against it (not modeled as Linux does).
-/

import Nimbus.Runtime.PipesProofs
import Nimbus.Runtime.PipesTraces

namespace Nimbus.Runtime.Pipes

variable (R : Rules)

structure Hold where
  pid : Nat
  code : Nat
  pipes : List Nat
  deriving DecidableEq, Repr

structure HSt where
  core : St
  holds : List Hold := []
  settled : List (Nat × Nat) := []

/-- The pipes a process that just exited leaves with more than `C` unread and a reader:
    on a local host its status is held on them. -/
def holdOf (s s' : St) (i : Nat) (o : Out) : Option Hold :=
  match o with
  | .exited c =>
    if (s.procs i).mode = .jspi then none
    else
      let ps := (List.range s'.m).filter fun p =>
        decide (0 < (s.procs i).wEnds p) && decide (0 < rs s' p) && decide (s'.C < (s'.pipes p).q)
      if ps.isEmpty then none else some ⟨i, c, ps⟩
  | _ => none

/-- A hold settles once every pipe it is on has no read end: 141 if one of them had more
    than `C` unread bytes when its last reader left (what was discarded then), else the
    writer's own status. -/
def resolve (s : St) (h : Hold) : Option Nat :=
  if h.pipes.all (fun p => rs s p == 0) then
    some (if h.pipes.any (fun p => decide (s.C < (s.pipes p).drop)) then 141 else h.code)
  else none

def settleHolds (s : St) (hs : List Hold) : List Hold × List (Nat × Nat) :=
  (hs.filter (fun h => (resolve s h).isNone), hs.filterMap fun h => (resolve s h).map (h.pid, ·))

/-- One scheduler step with the rule: the step without it, then holds are taken and
    settled. -/
def hstep (H : HSt) : Option (Nat × Out × HSt × List (Nat × Nat)) :=
  match schedStep R H.core with
  | some (i, o, s') =>
    let hs := H.holds ++ (holdOf H.core s' i o).toList
    let r := settleHolds s' hs
    some (i, o, { core := s', holds := r.1, settled := H.settled ++ r.2 }, r.2)
  | none => none

def hrun : Nat → HSt → HSt
  | 0, H => H
  | f + 1, H => match hstep R H with
    | some (_, _, H', _) => hrun f H'
    | none => H

def runCore : Nat → St → St
  | 0, s => s
  | f + 1, s => match schedStep R s with
    | some (_, _, s') => runCore f s'
    | none => s

/-- The status the rule reports: settled, held (`none`), or the process's own. -/
def hstatus (H : HSt) (i : Nat) : Option Nat :=
  match H.settled.find? (·.1 == i) with
  | some (_, v) => some v
  | none => if H.holds.any (·.pid == i) then none else some (status (H.core.procs i))

/-! ## (a) The rule changes nothing but statuses -/

theorem hstep_core (H : HSt) :
    (hstep R H).map (fun r => (r.1, r.2.1, r.2.2.1.core)) = schedStep R H.core := by
  unfold hstep
  split <;> simp_all

theorem hrun_core : ∀ f (H : HSt), (hrun R f H).core = runCore R f H.core := by
  intro f
  induction f with
  | zero => intro H; rfl
  | succ f ih =>
    intro H
    simp only [hrun, runCore]
    have := hstep_core R H
    revert this
    unfold hstep
    split
    · rename_i i o s' h; intro _; exact ih _
    · rename_i h; intro _; rfl

/-! ## When it settles -/

theorem settles_only_readerless (s : St) (h : Hold) (v : Nat) (hr : resolve s h = some v) :
    ∀ p ∈ h.pipes, rs s p = 0 := by
  intro p hp
  unfold resolve at hr
  split at hr
  · rename_i ha; exact by simpa using List.all_eq_true.mp ha p hp
  · cases hr

theorem settle_value (s : St) (h : Hold) (hall : ∀ p ∈ h.pipes, rs s p = 0) :
    resolve s h = some (if h.pipes.any (fun p => decide (s.C < (s.pipes p).drop)) then 141 else h.code) := by
  unfold resolve
  rw [if_pos (List.all_eq_true.mpr fun p hp => by simp [hall p hp])]

theorem rs_zero_of_dead (s : St) (hd : ∀ i < s.n, alive (s.procs i) = false) (p : Nat) : rs s p = 0 :=
  sumTo_eq_zero.mpr fun i hi => by simp [hd i hi]

/-- (c) Once no process is alive, no status is still held. -/
theorem all_settle (H : HSt) (i : Nat) (o : Out) (H' : HSt) (nw : List (Nat × Nat))
    (hs : hstep R H = some (i, o, H', nw)) (hd : ∀ j < H'.core.n, alive (H'.core.procs j) = false) :
    H'.holds = [] := by
  unfold hstep at hs
  split at hs
  · rename_i j o' s' _
    simp only [Option.some.injEq, Prod.mk.injEq] at hs
    obtain ⟨-, -, rfl, -⟩ := hs
    simp only [settleHolds, List.filter_eq_nil_iff]
    intro h _
    have hall : ∀ p ∈ h.pipes, rs s' p = 0 := fun p _ => rs_zero_of_dead s' hd p
    simp [settle_value s' h hall]
  · cases hs

/-! ## Traces (capacity 4) -/

open Nimbus.Runtime.PipesTraces

def hrunOk (c : Cmd) : HSt := hrun Rules.ok 200 { core := c.init }

def hstatuses (H : HSt) : List (Option Nat) := (List.range H.core.n).map (hstatus H)

/-- `seq 1000000 | head -2`: seq writes 12 bytes and exits with 12 unread; head reads 4
    and exits with 8 unread. -/
def seqHead : Cmd :=
  { C := 4, B := 16, m := 1, slots := [
      { mode := .plain, prog := reps 6 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := [.read 0 2, .read 0 2, .exit 0], reads := [0] }] }

/-- `seq 1000 | head -1`: seq writes 4 bytes, not more than the capacity. -/
def seqSmallHead : Cmd :=
  { C := 4, B := 16, m := 1, slots := [
      { mode := .plain, prog := reps 2 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := [.read 0 2, .exit 0], reads := [0] }] }

/-- `seq 20000 | uniq -c | wc -l`: both writers exit past the capacity; their readers
    drain every byte. -/
def seqUniqWcBig : Cmd :=
  { C := 4, B := 16, m := 2, slots := [
      { mode := .plain, prog := reps 6 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := reps 6 [.read 0 2] ++ reps 6 [.write 1 2] ++ [.exit 0], reads := [0], writes := [1] },
      { mode := .plain, prog := reps 7 [.read 1 2] ++ [.exit 0], reads := [1] }] }

/-- `yes | head -2`. -/
def yesHead2 : Cmd :=
  { C := 4, B := 8, m := 1, slots := [
      { mode := .plain, prog := reps 20 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := [.read 0 2, .read 0 2, .exit 0], reads := [0] }] }

theorem seq_head : hstatuses (hrunOk seqHead) = [some 141, some 0] := by
  decide

theorem seq_head_without_the_rule : statuses (runCore Rules.ok 200 seqHead.init) = [0, 0] := by
  decide

theorem seq_small_head : hstatuses (hrunOk seqSmallHead) = [some 0, some 0] := by
  decide

theorem seq_uniq_wc_held : hstatuses (hrunOk seqUniqWcBig) = [some 0, some 0, some 0] ∧
    ((hrunOk seqUniqWcBig).core.pipes 1).rd = 12 := by
  decide

theorem yes_head_held : hstatuses (hrunOk yesHead2) = [some 141, some 0] := by
  decide

end Nimbus.Runtime.Pipes
