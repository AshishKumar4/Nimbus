/-
  Nimbus.Coherence.StoreBugs — what the protocol promises at a resumption, the
  log-floor poison rule, and the model catching defects: three past or
  proposed rules that serve a stale byte, and one open finding in the code.
-/

import Nimbus.Coherence.StoreSteps

namespace Nimbus.Coherence.Store

/-! ## The promise -/

/-- No stale read: every dated row holds the value the authority had at some
    instant at or after the newest barrier answer the facet admitted, so at or
    after the barrier of any resumption that can run. -/
theorem no_stale_read {s : St} (h : Reachable s) {p : Path} {v r : Nat}
    (hr : s.rows p = some ⟨v, .dated r⟩) :
    ∃ t, s.H ≤ t ∧ t ≤ s.rev ∧ valAt s.muts p t = v := by
  have hi := reachable_inv h
  obtain ⟨hv, hno⟩ := hi.rowFresh p v r hr
  have hHle := hi.hLe
  have hvle : v ≤ s.rev := by
    rcases hv with rfl | hv
    · omega
    · exact (hi.mutsLe _ hv).2
  refine ⟨max v s.H, by omega, by omega, ?_⟩
  obtain ⟨h1, h2⟩ := valAt_spec s.muts p (max v s.H)
  rcases hv with rfl | hv
  · rcases h1 with h1 | ⟨hm, hle⟩
    · exact h1
    · have := hi.mutsLe _ hm
      exact absurd ⟨by omega, by omega⟩ (hno _ hm rfl)
  · have hge := h2 _ hv rfl (by omega)
    rcases h1 with h1 | ⟨hm, hle⟩
    · have := (hi.mutsLe _ hv).1; omega
    · by_cases e : v < valAt s.muts p (max v s.H)
      · exact absurd ⟨e, by omega⟩ (hno _ hm rfl)
      · omega

/-- An admitted answer is at most the horizon, so the promise covers it. -/
theorem admitted_below_horizon (s : St) (a : Answer) : a.rev ≤ (admit s a).H ∧ a.rev ≤ (admitM s a).H := by
  simp [admit, admitM]; omega

/-- The log-floor rule: a cursor below the floor is always poisoned, and any
    answer that is not a poison names every commit between its base and its
    revision — so a trimmed log never yields a short or empty delta. -/
theorem below_floor_poisons (s : St) (c : Nat) (h : c < s.logFloor) : poisons s c = true := by
  simp [poisons, h]

theorem delta_complete {s : St} (h : Reachable s) {a : Answer} (ha : a ∈ s.answers) (hp : a.poison = false)
    {x : Path × Nat} (hx : x ∈ s.muts) (hb : a.base < x.2) (hr : x.2 ≤ a.rev) :
    x.2 ≤ repOf a.delta x.1 :=
  covered (reachable_inv h) ha hp hx hb hr

/-! ## Defects the model catches -/

/-- Path 0 holds the initial value (0), dated 0, fetched through a ticketed read. -/
theorem fetched_exists : ∃ s, Reachable s ∧ s.rows 0 = some ⟨0, .dated 0⟩ ∧ s.muts = [] ∧ s.H = 0 ∧
    s.rev = 0 ∧ s.fills = [] ∧ s.cursor = 0 ∧ s.parked 0 = none := by
  have h1 := Reachable.step .init (.issueFill init 0 rfl)
  have h2 := Reachable.step h1 (.serveFill _ ⟨0, 0, 0, 0, false, none⟩ (by simp [init]) rfl)
  have h3 := Reachable.step h2 (.landFill _ ⟨0, 0, 0, 0, false, some 0⟩ 0 (List.mem_singleton.mpr rfl) rfl)
  have hl : ∀ s : St, s.muts = [] → last s 0 = 0 := fun s h => by simp [last, valAt, h]
  exact ⟨_, h3, by simp [upd, accepts, init], rfl, rfl, rfl, by simp [init]; rfl, rfl, rfl⟩

theorem valAt_two (t : Nat) (ht : 2 ≤ t) : valAt [(0, 1), (0, 2)] 0 t = 2 := by
  have : 1 ≤ t := by omega
  simp [valAt, this, ht]

theorem valAt_one (t : Nat) (ht : 1 ≤ t) : valAt [(0, 1)] 0 t = 1 := by
  simp [valAt, ht]

theorem valAt_five (t : Nat) (ht : 5 ≤ t) : valAt [(0, 5)] 0 t = 5 := by
  simp [valAt, ht]

/-- The log dropped the one commit after the facet's cursor. The poison rule
    `cursor < oldest retained - 1` (before the explicit floor) has no oldest
    entry to compare with, answers an empty delta, and the facet keeps its
    stale row past the answer: every instant at or after it has another value.
    The floor rule poisons that cursor. -/
theorem an_empty_log_without_a_floor_serves_a_stale_row :
    ∃ s, Reachable s ∧ retained { commitMut s 0 5 with logFloor := 5 } = [] ∧
      poisons { commitMut s 0 5 with logFloor := 5 } 0 = true ∧
      (admit { commitMut s 0 5 with logFloor := 5 } ⟨0, 0, 5, false, [], false⟩).rows 0 = some ⟨0, .dated 0⟩ ∧
      ∀ t, (admit { commitMut s 0 5 with logFloor := 5 } ⟨0, 0, 5, false, [], false⟩).H ≤ t →
        valAt ({ commitMut s 0 5 with logFloor := 5 }).muts 0 t ≠ 0 := by
  obtain ⟨s, hs, hr, hm, hH, hrev, _, _, _⟩ := fetched_exists
  refine ⟨s, hs, by simp [retained, commitMut, hm], by simp [poisons], by simp [admit, commitMut, hr, repOf], ?_⟩
  intro t ht
  simp [admit, commitMut, hH] at ht
  simp only [commitMut, hm, List.nil_append]
  rw [valAt_five t (by omega)]; omega

/-- The fill ticket: a read served before a commit, whose path a barrier
    reported while it was in flight, installed anyway. The report was consumed
    by the cursor, so nothing evicts the stale row. With the ticket the read's
    `reported` (1) exceeds its cursor (0) and the install is declined. -/
theorem a_read_installed_past_a_report_is_stale :
    let s1 : St := { init with fills := [⟨0, 0, 0, 0, false, some 0⟩], nextId := 1 }
    let s3 := admit (commitMut s1 0 1) ⟨1, 0, 1, false, [(0, 1)], false⟩
    s3.fills = [⟨0, 0, 0, 1, false, some 0⟩] ∧ ∀ t, s3.H ≤ t → valAt s3.muts 0 t ≠ 0 := by
  refine ⟨by simp [admit, commitMut, repOf], ?_⟩
  intro t ht
  simp [admit, commitMut, init] at ht
  show valAt [(0, 1)] 0 t ≠ 0
  rw [valAt_one t (by omega)]; omega

/-- A repair listing that reports an unheld path at 0 instead of the floor
    (the pre-d35e88c6 `fsList`): the reconcile keeps a row the path's commit
    outdated, and the repair publishes a cursor past that commit. -/
theorem a_listing_below_the_last_commit_keeps_a_stale_row :
    ∃ s, Reachable s ∧ s.rows 0 = some ⟨0, .dated 0⟩ ∧ last (commitMut s 0 1) 0 = 1 ∧
      ¬ ((0 : Nat) < (fun _ => 0 : Path → Nat) 0) ∧
      ∀ t, 1 ≤ t → valAt (commitMut s 0 1).muts 0 t ≠ 0 := by
  obtain ⟨s, hs, hr, hm, _, hrev, _, _, _⟩ := fetched_exists
  refine ⟨s, hs, hr, by simp [last, commitMut, hm, valAt], by decide, ?_⟩
  intro t ht
  simp only [commitMut, hm, List.nil_append]
  rw [valAt_one t ht]; omega

/-- NodeNoMirror's pushed bytes must only ride 4c8871bb's admission (entries
    above the cursor). Under integrate/0924's admission an answer served before
    a newer one, admitted after it, pushes the path at its older revision into
    an empty row: stale bytes installed as current. -/
theorem a_push_admitted_out_of_order_is_stale :
    ∃ s a, Reachable s ∧ a ∈ s.answers ∧ a.delta = [(0, 1)] ∧ s.rows 0 = none ∧ 2 ≤ s.H ∧
      (pushRows (admit s a) a.delta (fun _ => true)).rows 0 = some ⟨1, .dated 1⟩ ∧
      ∀ t, s.H ≤ t → valAt s.muts 0 t ≠ 1 := by
  have h1 := Reachable.step .init (.request init)
  have h2 := Reachable.step h1 (.peerWrite _ 0 1 (by decide))
  have h3 := Reachable.step h2 (.serve _ (0, 0) (List.mem_singleton.mpr rfl))
  have h4 := Reachable.step h3 (.peerWrite _ 0 2 (by decide))
  have h5 := Reachable.step h4 (.request _)
  have h6 := Reachable.step h5 (.serve _ (1, 0) (List.mem_singleton.mpr rfl))
  have h7 := Reachable.step h6 (.admitDelta _ _ (List.mem_append_right _ (List.mem_singleton.mpr rfl))
    (by simp [poisons, commitMut, init]) rfl rfl)
  refine ⟨_, ⟨0, 0, 1, false, [(0, 1)], false⟩, h7, ?_, rfl, ?_, ?_, ?_, ?_⟩
  · simp [admit, commitMut, init, poisons, deltaFrom, retained, last, valAt]
  · simp [admit, commitMut, init]
  · simp [admit, commitMut, init]
  · simp [pushRows, admit, commitMut, init, repOf, acceptsPush]
  · intro t ht
    simp [admit, commitMut, init] at ht
    simp only [admit, commitMut, init, List.nil_append, List.append_assoc, List.singleton_append]
    rw [valAt_two t (by omega)]; omega

/-! ## Open finding: a facet's own committed write is served past a peer's -/

/-- `writeFileSync` on path 0; the write-back commits it at revision 1; a peer
    then commits path 0 at 2; a barrier reports path 0 at 2 and is admitted.
    The row is still the facet's own (its flush response has not landed), so
    the resumption behind that barrier reads the bytes committed at 1, though
    the authority held revision 2's bytes before the barrier was answered.
    Read-your-writes holds; no-stale-read does not, until the response lands
    (it then evicts, `__nimbusStampFlushedCell`). -/
theorem own_committed_write_is_served_past_a_peer :
    ∃ s, Reachable s ∧ s.rows 0 = some ⟨0, .own⟩ ∧ ⟨0, 0, some 1⟩ ∈ s.flights ∧ s.parked 0 = some 0 ∧
      2 ≤ s.H ∧ s.muts = [(0, 1), (0, 2)] ∧ ∀ t, s.H ≤ t → valAt s.muts 0 t ≠ 1 := by
  have h1 := Reachable.step .init (.writeSync init 0)
  have h2 := Reachable.step h1 (.flushSend _ 0 0 (by simp [init, upd]) (by simp [init]))
  have h3 := Reachable.step h2 (.flushCommit _ ⟨0, 0, none⟩ 1 (by simp [init]) rfl (by decide))
  have h4 := Reachable.step h3 (.peerWrite _ 0 2 (by decide))
  have h5 := Reachable.step h4 (.request _)
  have h6 := Reachable.step h5 (.serve _ (1, 0) (List.mem_append_right _ (List.mem_singleton.mpr rfl)))
  refine ⟨_, Reachable.step h6 (.admitDelta _ _ (List.mem_append_right _ (List.mem_singleton.mpr rfl)) (by simp [poisons, commitMut, init]) rfl rfl), ?_, ?_, ?_, ?_, ?_, ?_⟩
  · simp [admit, commitMut, upd, init]
  · simp [admit, commitMut, init]
  · simp [admit, commitMut, upd, init]
  · simp [admit, commitMut, init]
  · simp [admit, commitMut, init]
  · intro t ht
    simp [admit, commitMut, init] at ht
    simp only [admit, commitMut, init, List.nil_append, List.append_assoc, List.singleton_append]
    rw [valAt_two t (by omega)]; omega

/-! ## The fix (ResidentCoherenceLane, rule (a)) -/

/-- The resumption guard the fix needs: no own acknowledgement is in flight for
    a path that carries a noted report — from this barrier's answer or from any
    earlier one. -/
def AcksSettled (s : St) : Prop := ∀ g ∈ s.flights, s.parked g.path = some g.w → s.reports g.path = 0

/-- With it, an own row whose write already committed is as fresh as a dated
    row: the authority held its bytes at some instant at or after the horizon. -/
theorem own_fresh_when_acks_settled {s : St} (h : Reachable s) (hs : AcksSettled s) {g : Flight}
    (hg : g ∈ s.flights) {r : Nat} (hr : g.committed = some r) (hp : s.parked g.path = some g.w) :
    Fresh s g.path r r := by
  have hi := reachable_inv h
  obtain ⟨hm, _, hf⟩ := hi.flightOk g hg r hr
  refine ⟨Or.inr hm, ?_⟩
  rcases hf hp with h' | h'
  · rw [hs g hg hp] at h'; omega
  · exact h'

/-- A wait snapshotted per barrier, over only the paths THIS answer names, is not
    enough: after `ownRace` (whose resumption waits), a second barrier from the
    advanced cursor names nothing, so its resumption would not wait, and serves
    the own bytes committed at 1 past the peer's 2. The noted report is still on
    the path; `AcksSettled` catches it. -/
theorem a_per_answer_wait_misses_an_earlier_report :
    ∃ s a, Reachable s ∧ a ∈ s.answers ∧ a.delta = [] ∧ s.rows 0 = some ⟨0, .own⟩ ∧
      ⟨0, 0, some 1⟩ ∈ s.flights ∧ s.parked 0 = some 0 ∧ s.reports 0 = 2 ∧ ¬ AcksSettled s ∧
      ∀ t, (admit s a).H ≤ t → valAt s.muts 0 t ≠ 1 := by
  have h1 := Reachable.step .init (.writeSync init 0)
  have h2 := Reachable.step h1 (.flushSend _ 0 0 (by simp [init, upd]) (by simp [init]))
  have h3 := Reachable.step h2 (.flushCommit _ ⟨0, 0, none⟩ 1 (by simp [init]) rfl (by decide))
  have h4 := Reachable.step h3 (.peerWrite _ 0 2 (by decide))
  have h5 := Reachable.step h4 (.request _)
  have h6 := Reachable.step h5 (.serve _ (1, 0) (List.mem_append_right _ (List.mem_singleton.mpr rfl)))
  have h7 := Reachable.step h6 (.admitDelta _ _ (List.mem_append_right _ (List.mem_singleton.mpr rfl))
    (by simp [poisons, commitMut, init]) rfl rfl)
  have h8 := Reachable.step h7 (.request _)
  have h9 := Reachable.step h8 (.serve _ (2, 2) (List.mem_append_right _ (List.mem_singleton.mpr rfl)))
  refine ⟨_, _, h9, List.mem_append_right _ (List.mem_singleton.mpr rfl), ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · simp [deltaFrom, retained, admit, commitMut, init]
  · simp [admit, commitMut, upd, init]
  · simp [admit, commitMut, init]
  · simp [admit, commitMut, upd, init]
  · simp [admit, commitMut, upd, init, repOf, deltaFrom, retained, last, valAt]
  · intro hs
    have := hs ⟨0, 0, some 1⟩ (by simp [admit, commitMut, init]) (by simp [admit, commitMut, upd, init])
    simp [admit, commitMut, upd, init, repOf, deltaFrom, retained, last, valAt] at this
  · intro t ht
    simp [admit, commitMut, init] at ht
    simp only [admit, commitMut, init, List.nil_append, List.append_assoc, List.singleton_append]
    rw [valAt_two t (by omega)]; omega

end Nimbus.Coherence.Store
