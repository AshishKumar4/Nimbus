/-
  Nimbus.Vfs.HydrationAsync — N17's job with an in-flight fetch (NodeNoMirrorBuild's
  refinement note on `Nimbus.Vfs.Hydration`, whose `job` event is atomic).

  In the engine a job is two events: `start` takes the hash at the front of the queue
  and fetches it; reads, launches and other events may reprioritize the queue while the
  fetch is in flight; `done` hydrates the hash and removes it from the queue. The
  engine removes the entry it took by identity (`doneId`); removing by position
  (`donePos`, the queue's head at completion) was the defect n17-lazy-import caught.

  Proved:
  - `covers_async`: in every reachable state, with any interleaving of events during a
    fetch, every remote chunk neither hydrated nor failed for good is still in the queue (so a job will
    fetch it); `doneId_keeps`: completion removes nothing but the fetched hash.
  - `removal_by_position_loses_a_chunk` (decided): with removal by position, a read
    that reprioritizes during a fetch drops the chunk it asked for from the queue: it
    is remote, unhydrated and no longer queued, and the path it backs never becomes
    local however many jobs run.
-/

import Nimbus.Vfs.Hydration

namespace Nimbus.Vfs.Hydration

/-- Completion by identity: the fetched hash is hydrated and its entry removed. -/
def doneId (s : H) (x : Nat) : H := { s with hyd := s.hyd ++ [x], queue := s.queue.erase x }

/-- Completion by position: the fetched hash is hydrated, the queue's current head removed. -/
def donePos (s : H) (x : Nat) : H := { s with hyd := s.hyd ++ [x], queue := s.queue.tail }

structure A where
  s : H
  inflight : Option Nat

inductive AStep : A → A → Prop
  /-- Any event but a job, with or without a fetch in flight. -/
  | ev (a : A) (e : Ev) : AStep a ⟨(step a.s e).2, a.inflight⟩
  | start (a : A) (x : Nat) (r : List Nat) (hq : a.s.queue = x :: r) (hn : a.inflight = none) :
      AStep a ⟨a.s, some x⟩
  | done (a : A) (x : Nat) (hi : a.inflight = some x) : AStep a ⟨settle (doneId a.s x), none⟩

inductive AReach : A → Prop
  | init (cfg : Cfg) (files : List (Nat × List Nat)) (remote : List Nat) : AReach ⟨start cfg files remote, none⟩
  | step {a b : A} : AReach a → AStep a b → AReach b

theorem doneId_keeps (s : H) (x c : Nat) (hc : c ∈ s.queue) (hne : c ≠ x) : c ∈ (doneId s x).queue :=
  (List.mem_erase_of_ne hne).mpr hc

theorem covers_doneId (s : H) (hs : Covers s) (x : Nat) : Covers (settle (doneId s x)) := by
  intro c hc hn hf
  show c ∈ s.queue.erase x
  have hn' : c ∉ s.hyd ++ [x] := hn
  simp only [List.mem_append, List.mem_singleton, not_or] at hn'
  exact (List.mem_erase_of_ne hn'.2).mpr (hs c hc hn'.1 hf)

/-- Every remote chunk not yet hydrated stays queued, whatever runs during a fetch. -/
theorem covers_async {a : A} (h : AReach a) : Covers a.s := by
  induction h with
  | init cfg files remote => intro c hc _ _; exact hc
  | step _ hs ih =>
    cases hs with
    | ev e => exact step_covers _ ih e
    | start x r hq hn => exact ih
    | done x hi => exact covers_doneId _ ih x

/-- Path 1 is chunk 5, path 2 chunk 6; both remote, job order [5, 6]. A fetch of 5 starts;
    a sync read of path 2 moves 6 to the front; completing by position removes 6, not 5.
    Chunk 6 is then remote, unhydrated and unqueued, and path 2 stays remote through any
    number of jobs. By identity the queue keeps 6 and path 2 becomes local. -/
theorem removal_by_position_loses_a_chunk :
    let s0 := start { D := 30, RD := 30 } [(1, [5]), (2, [6])] [5, 6]
    let s1 := (step s0 (.syncRead 2)).2
    let bad := settle (donePos s1 5)
    let good := settle (doneId s1 5)
    s1.queue = [6, 5] ∧ bad.queue = [5] ∧ (6 ∈ bad.remote ∧ 6 ∉ bad.hyd ∧ 6 ∉ bad.queue) ∧
      isLocal (jobs 5 bad) 2 = false ∧ good.queue = [6] ∧ isLocal (jobs 1 good) 2 = true := by
  decide

end Nimbus.Vfs.Hydration
