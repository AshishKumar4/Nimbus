/-
  Nimbus.Runtime.PipesTraces — the review's pipelines (reviewer-0924, 5bdfec12) on
  `Nimbus.Runtime.Pipes`, scaled down so the kernel decides them (capacity 4, budget 8
  or 16; the rules do not depend on the sizes). Each is run by the scheduler, under the
  approved rules and under the 5bdfec12 rule the finding names.
-/

import Nimbus.Runtime.Pipes

namespace Nimbus.Runtime.PipesTraces

open Nimbus.Runtime.Pipes

def reps {α : Type} (k : Nat) (a : List α) : List α := (List.replicate k a).flatten

/-- `seq | uniq -c | wc -l`, all children without JSPI: seq writes 4 bytes, uniq reads
    them and writes 12, wc counts. -/
def seqUniqWc : Cmd :=
  { C := 4, B := 16, m := 2, slots := [
      { mode := .plain, prog := [.write 0 2, .write 0 2, .exit 0], writes := [0] },
      { mode := .plain, prog := reps 4 [.read 0 2] ++ reps 6 [.write 1 2] ++ [.exit 0], reads := [0], writes := [1] },
      { mode := .plain, prog := reps 8 [.read 1 2] ++ [.exit 0], reads := [1] }] }

/-- `yes | head -1`: yes (no JSPI) writes 2-byte lines; head takes one and exits. -/
def yesHead (ign : Bool) : Cmd :=
  { C := 4, B := 8, m := 1, slots := [
      { mode := .plain, ign := ign, prog := reps 20 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := [.read 0 2, .exit 0], reads := [0] }] }

/-- `yes | head -c 12 | wc -c` without JSPI and a budget of 8: more than the budget must
    pass between plain stages. -/
def overBudget : Cmd :=
  { C := 4, B := 8, m := 2, slots := [
      { mode := .plain, prog := reps 20 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := reps 6 [.read 0 2, .write 1 2] ++ [.exit 0], reads := [0], writes := [1] },
      { mode := .plain, prog := reps 10 [.read 1 2] ++ [.exit 0], reads := [1] }] }

/-- The loop `while ...; do echo "$(printf ...)"; done | wc -c`: bash forks a child per
    line, the child writes the line to its own pipe, bash reads it and writes it to wc.
    Three 3-byte lines, budget 4: the loop is suspended mid-stream. -/
def forkLoop : Cmd :=
  { C := 4, B := 4, m := 4, slots := [
      { mode := .bash, prog := (List.range 3).flatMap (fun j =>
          [.fork (2 + j), .close (1 + j) false, .read (1 + j) 3, .read (1 + j) 3, .close (1 + j) true, .write 0 3]) ++ [.exit 0],
        writes := [0, 1, 2, 3], reads := [1, 2, 3] },
      { mode := .plain, prog := reps 6 [.read 0 3] ++ [.exit 0], reads := [0] },
      { mode := .plain, prog := [.close 1 true, .write 1 3, .exit 0], started := false },
      { mode := .plain, prog := [.close 2 true, .write 2 3, .exit 0], started := false },
      { mode := .plain, prog := [.close 3 true, .write 3 3, .exit 0], started := false }] }

/-- `yes | while read l; do echo "$l"; done | wc -c` without JSPI: a bash stage between
    a fast plain source and a plain sink, the bash stage copying 3 lines. -/
def bashMiddle : Cmd :=
  { C := 4, B := 8, m := 2, slots := [
      { mode := .plain, prog := reps 20 [.write 0 2] ++ [.exit 0], writes := [0] },
      { mode := .bash, prog := reps 3 [.read 0 2, .write 1 2] ++ [.exit 0], reads := [0], writes := [1] },
      { mode := .plain, prog := reps 10 [.read 1 2] ++ [.exit 0], reads := [1] }] }

/-- A JSPI child writing 3 lines of 3 bytes into a pipe of capacity 4, parking at the
    full pipe; a fork is taken while it is parked (`forkParked`), and wc drains. -/
def parkedFork : Cmd :=
  { C := 4, B := 16, m := 1, slots := [
      { mode := .jspi, prog := reps 3 [.write 0 3] ++ [.exit 0], writes := [0] },
      { mode := .plain, prog := [.exit 0], started := false },
      { mode := .jspi, prog := reps 6 [.read 0 3] ++ [.exit 0], reads := [0] }] }

def statuses (s : St) : List Nat := (List.range s.n).map fun i => status (s.procs i)

def runOk (c : Cmd) : St := (runSched Rules.ok 200 c.init).2
def runWith (R : Rules) (c : Cmd) : St := (runSched R 200 c.init).2

/-- The parked-fork run: parked writer 0 forks slot 1 once, then the scheduler runs. -/
def parkedForkRun (R : Rules) : St :=
  let s1 := (runSched R 3 parkedFork.init).2
  (runSched R 200 (forkParked R s1 0 1)).2

/-! ## Finding 1: a stage SIGPIPE-killed while its reader is alive -/

theorem seq_uniq_wc_whole :
    let s := runOk seqUniqWc
    statuses s = [0, 0, 0] ∧ (s.pipes 1).rd = 12 ∧ (s.pipes 1).lost = 0 ∧ cmdStatus s 2 = 0 := by
  decide

theorem seq_uniq_wc_held_kill_loses :
    let s := runWith { heldKill := true } seqUniqWc
    statuses s = [0, 141, 0] ∧ (s.pipes 1).rd = 4 ∧ (s.pipes 1).lost = 8 ∧ cmdStatus s 2 = 0 := by
  decide

/-! ## Finding 2: a parked write dropped by a fork -/

theorem fork_loop_whole :
    let s := runOk forkLoop
    (s.pipes 0).rd = 9 ∧ statuses s = [0, 0, 0, 0, 0] ∧ s.err = none := by
  decide

theorem parked_fork_keeps_the_write :
    let s := parkedForkRun Rules.ok
    (s.pipes 0).rd = 9 ∧ (s.pipes 0).lost = 0 := by
  decide

theorem parked_fork_drops_the_write :
    let s := parkedForkRun { forkDrops := true }
    (s.pipes 0).rd = 6 ∧ (s.pipes 0).lost = 3 ∧ cmdStatus s 2 = 0 := by
  decide

/-! ## `yes | head`: SIGPIPE ends the writer -/

theorem yes_head :
    let s := runOk (yesHead false)
    statuses s = [141, 0] ∧ (s.pipes 0).rd = 2 := by
  decide

/-! ## Finding 3: more than the budget between plain stages -/

theorem over_budget_fails_named :
    let s := runOk overBudget
    s.err = some abortMsg ∧ cmdStatus s 2 ≠ 0 := by
  decide

theorem over_budget_silent_truncates :
    let s := runWith { spillSilent := true } overBudget
    s.err = none ∧ cmdStatus s 2 = 0 ∧ (s.pipes 1).rd < 12 := by
  decide

/-! ## The rejected global budget -/

/-- With a budget per pipe the bash stage copies its 3 lines and wc gets them. -/
theorem bash_middle_whole :
    let s := runOk bashMiddle
    statuses s = [141, 0, 0] ∧ (s.pipes 1).rd = 6 ∧ s.err = none := by
  decide

/-- With one budget over all pipes the source refills it as soon as the bash stage reads,
    the bash stage's write is suspended above it, and wc finds its only writer beneath
    it: the command fails though only 6 bytes had to reach wc. -/
theorem bash_middle_global_budget_fails :
    let s := runWith { globalBudget := true } bashMiddle
    s.err = some abortMsg ∧ (s.pipes 1).rd = 0 := by
  decide

/-! ## Finding 4: `trap "" PIPE` -/

theorem ignored_sigpipe_is_epipe :
    let s := runOk (yesHead true)
    statuses s = [1, 0] := by
  decide

theorem ignored_sigpipe_killed_by_5bdfec12 :
    let s := runWith { ignoreIgnored := true } (yesHead true)
    statuses s = [141, 0] := by
  decide

end Nimbus.Runtime.PipesTraces
