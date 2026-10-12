/-
  Nimbus.Vfs.HydrationAsync — N17's job with an in-flight fetch (NodeNoMirrorBuild's
  refinement note on `Nimbus.Vfs.Hydration`, whose `job` event is atomic).

  In the engine (Hydrator.step) a job is two events: `start` takes the first ready
  hash in the queue and fetches it; reads, launches, ticks and retries may reorder the
  queue while the fetch is in flight, and no other job runs; `done` ends the fetch with
  its outcome, as the atomic job ends it (`complete`: stored, or failed with a backoff,
  or failed for good) for the hash it took, wherever the queue has it by then. The
  engine removes the entry it took by identity; removing by position (`donePos`, the
  queue's head at completion) was the defect n17-lazy-import caught.

  Proved:
  - `covers_async`: in every reachable state, with any events between a fetch's start
    and its end and any outcome, every remote chunk neither stored nor failed for good
    is still queued (so a job will fetch it); `complete_keeps`: an end removes nothing
    but the hash it took.
  - `a_failed_fetch_after_a_reprioritization` (decided): a read reorders the queue
    under a fetch that then fails; the hash taken goes to the back with its backoff,
    and the one the read moved forward stays first.
  - `removal_by_position_loses_a_chunk` (decided): with removal by position, a read
    that reprioritizes during a fetch drops the chunk it asked for from the queue: it
    is remote, unhydrated and no longer queued, and the path it backs never becomes
    local however many jobs run.
-/

import Nimbus.Vfs.Hydration

namespace Nimbus.Vfs.Hydration

/-- Completion by position, the defect: the fetched hash is stored, the queue's current head removed. -/
def donePos (s : H) (x : Nat) : H := { s with hyd := s.hyd ++ [x], queue := s.queue.tail }

/-- Whether an event is the atomic job (which the split job replaces here). -/
def Ev.isJob : Ev → Bool
  | .job _ => true
  | _ => false

structure A where
  s : H
  inflight : Option Nat

inductive AStep : A → A → Prop
  /-- Any event but a job, with or without a fetch in flight. -/
  | ev (a : A) (e : Ev) (hj : e.isJob = false) : AStep a ⟨(step a.s e).2, a.inflight⟩
  /-- A fetch of the first ready hash, when none is in flight. -/
  | start (a : A) (x : Nat) (hp : pick a.s = some x) (hn : a.inflight = none) : AStep a ⟨a.s, some x⟩
  /-- The fetch in flight ends with `o`, for the hash it took; readers and gates settle. -/
  | done (a : A) (x o : Nat) (hi : a.inflight = some x) : AStep a ⟨settle (complete a.s x o).2, none⟩

inductive AReach : A → Prop
  | init (cfg : Cfg) (files : List (Nat × List Nat)) (remote : List Nat) : AReach ⟨start cfg files remote, none⟩
  | step {a b : A} : AReach a → AStep a b → AReach b

theorem complete_keeps (s : H) (x o c : Nat) (hc : c ∈ s.queue) (hne : c ≠ x) : c ∈ (complete s x o).2.queue := by
  unfold complete
  split
  · exact (List.mem_erase_of_ne hne).mpr hc
  · split
    · exact (List.mem_erase_of_ne hne).mpr hc
    · split
      · exact List.mem_filter.mpr ⟨hc, by simpa using hne⟩
      · exact List.mem_append_left _ (List.mem_filter.mpr ⟨hc, by simpa using hne⟩)

/-- Every remote chunk neither stored nor failed for good stays queued, whatever runs during a fetch and however it ends. -/
theorem covers_async {a : A} (h : AReach a) : Covers a.s := by
  induction h with
  | init cfg files remote => intro c hc _ _; exact hc
  | step _ hs ih =>
    cases hs with
    | ev e _ => exact step_covers _ ih e
    | start x hp hn => exact ih
    | done x o hi =>
      intro c hc hn hf
      exact complete_covers _ ih x o c hc hn hf

/-- Path 1 is chunk 5, path 2 chunk 6; both remote, job order [5, 6]. A fetch of 5 starts;
    a sync read of path 2 moves 6 to the front; the fetch fails. Chunk 5 goes to the back
    with one attempt and its backoff; 6 stays first. -/
theorem a_failed_fetch_after_a_reprioritization :
    let s0 := start { D := 30, RD := 30 } [(1, [5]), (2, [6])] [5, 6]
    let s1 := (step s0 (.syncRead 2)).2
    let failed := settle (complete s1 5 1).2
    pick s0 = some 5 ∧ s1.queue = [6, 5] ∧ failed.queue = [6, 5] ∧ 5 ∉ failed.hyd ∧ 5 ∉ failed.failed ∧
      failed.attempts 5 = 1 ∧ failed.attempts 6 = 0 ∧ failed.notBefore 5 = 1 := by
  decide

/-- Path 1 is chunk 5, path 2 chunk 6; both remote, job order [5, 6]. A fetch of 5 starts;
    a sync read of path 2 moves 6 to the front; completing by position removes 6, not 5.
    Chunk 6 is then remote, unhydrated and unqueued, and path 2 stays remote through any
    number of jobs. By identity the queue keeps 6 and path 2 becomes local. -/
theorem removal_by_position_loses_a_chunk :
    let s0 := start { D := 30, RD := 30 } [(1, [5]), (2, [6])] [5, 6]
    let s1 := (step s0 (.syncRead 2)).2
    let bad := settle (donePos s1 5)
    let good := settle (complete s1 5 0).2
    s1.queue = [6, 5] ∧ bad.queue = [5] ∧ (6 ∈ bad.remote ∧ 6 ∉ bad.hyd ∧ 6 ∉ bad.queue) ∧
      isLocal (jobs 5 bad) 2 = false ∧ good.queue = [6] ∧ isLocal (jobs 1 good) 2 = true := by
  decide

end Nimbus.Vfs.Hydration
