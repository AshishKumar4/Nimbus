/-
  Nimbus.ContentStore.Bugs — the model catches the defects the spec review
  found. Each theorem is a concrete reachable state from which the transaction
  as SPEC.md first wrote it (a guard missing) breaks an invariant a reader
  relies on; the as-built guard is exactly what `Step` requires.

  * SPEC §4.3's in-place probe named inodes, manifests and history but not
    detached descriptors: an in-place rewrite then changes what an unlinked,
    still-open file reads (`an_in_place_rewrite_blind_to_pins_changes_a_descriptor`).
  * The in-place probe run before the transaction's own history insert sees no
    history row for a row a snapshot can see, and rewrites the chunk that
    snapshot reads (`an_in_place_rewrite_a_snapshot_can_see_changes_the_snapshot`).
  * A pinned chunk skipped by GC with its queue row deleted is, once the
    descriptor closes, stored, unreferenced and unqueued: a leak nothing but an
    audit finds (`dropping_a_pinned_queue_row_leaks`).
-/

import Nimbus.ContentStore.Gc

namespace Nimbus.ContentStore.Bugs

open Nimbus.ContentStore

/-- The in-place edit's post-state, whatever guard admitted it. -/
def inPlace (s : St) (p k h : Nat) : St :=
  setView (dirty (commit { s with chunks := upd s.chunks k (some h) } p (some (.chunk k)))) p (some [h])

/-- Paths 0 and 1 share chunk 0 (bytes `[1]`); path 1 is then opened and unlinked. -/
def pinned : St :=
  let s1 := setView (dirty (commit (intern init 1 0) 0 (some (.chunk 0)))) 0 (some [1])
  let r : Row := ⟨1, .chunk 0⟩
  let s2 := setView (dirty (commit s1 1 (some r.ref))) 1 (s1.view 0)
  { setView (dirty (commit s2 1 none)) 1 none with fds := s2.fds ++ [⟨r.ref, (s2.view 1).getD []⟩] }

theorem pinned_reachable : Reachable 2 pinned := by
  have h1 : Reachable 2 (setView (dirty (commit (intern init 1 0) 0 (some (.chunk 0)))) 0 (some [1])) :=
    .step .init (.writeSmall init 0 1 0 (by decide) (Or.inr rfl))
  have h2 := Reachable.step h1 (.copy _ 0 1 ⟨1, .chunk 0⟩ (by decide) rfl)
  exact .step h2 (.detach _ 1 ⟨2, .chunk 0⟩ (by decide) rfl)

/-- Every guard of `editSmallInPlace` but the descriptor probe holds at
    `pinned` for path 0, and the rewrite changes what the descriptor reads. -/
theorem an_in_place_rewrite_blind_to_pins_changes_a_descriptor :
    Reachable 2 pinned ∧
    pinned.live 0 = some ⟨1, .chunk 0⟩ ∧ pinGen pinned < 1 ∧
    (∀ q r', q ≠ 0 → pinned.live q = some r' → r'.ref ≠ .chunk 0) ∧
    ¬ ManRef pinned (.chunk 0) ∧ ¬ HistRef pinned (.chunk 0) ∧ (∀ k', pinned.chunks k' ≠ some 2) ∧
    FdRef pinned (.chunk 0) ∧
    ∃ f ∈ (inPlace pinned 0 0 2).fds, resolve (inPlace pinned 0 0 2) f.ref ≠ some f.view := by
  refine ⟨pinned_reachable, rfl, by decide, ?_, ?_, ?_, ?_, ⟨⟨.chunk 0, [1]⟩, by simp [pinned], rfl⟩, ?_⟩
  · intro q r' hq hl
    by_cases h1 : q = 1
    · subst h1; simp [pinned, commit, setView, dirty, upd] at hl
    · simp [pinned, commit, setView, dirty, upd, h1, hq, intern, init] at hl
  · rintro ⟨c, ct, hc, _⟩; simp [pinned, commit, setView, dirty, intern, init, upd] at hc
  · rintro ⟨h, hh, _⟩; simp [pinned, commit, setView, dirty, intern, init, pinGen] at hh
  · intro k' hk'
    by_cases e : k' = 0
    · subst e; simp [pinned, commit, setView, dirty, intern, init, upd] at hk'
    · simp [pinned, commit, setView, dirty, intern, init, upd, e] at hk'
  · refine ⟨⟨.chunk 0, [1]⟩, by simp [inPlace, pinned], ?_⟩
    simp [inPlace, pinned, resolve, commit, setView, dirty, upd]

/-- Path 0 holds chunk 0 (bytes `[1]`) and snapshot 0 is taken. -/
def snapped : St :=
  let s1 := setView (dirty (commit (intern init 1 0) 0 (some (.chunk 0)))) 0 (some [1])
  { s1 with snaps := s1.snaps ++ [(0, s1.gen)], snapView := upd s1.snapView 0 s1.view }

theorem snapped_reachable : Reachable 1 snapped :=
  .step (.step .init (.writeSmall init 0 1 0 (by decide) (Or.inr rfl)))
    (.snapshot _ 0 (by intro x hx; simp [intern, init, setView, dirty, commit] at hx))

/-- Before this transaction's history insert nothing else references chunk 0,
    so a probe that runs first finds it unshared; the as-built guard
    (`pinGen < gen`) refuses. Rewriting it in place changes what the snapshot
    reads. -/
theorem an_in_place_rewrite_a_snapshot_can_see_changes_the_snapshot :
    Reachable 1 snapped ∧
    (∀ q r', q ≠ 0 → snapped.live q = some r' → r'.ref ≠ .chunk 0) ∧
    ¬ ManRef snapped (.chunk 0) ∧ ¬ HistRef snapped (.chunk 0) ∧ ¬ FdRef snapped (.chunk 0) ∧
    ¬ pinGen snapped < 1 ∧
    readRef (inPlace snapped 0 0 2) (atRef (inPlace snapped 0 0 2) 1 0) ≠
      some ((inPlace snapped 0 0 2).snapView 0 0) := by
  refine ⟨snapped_reachable, ?_, ?_, ?_, ?_, by decide, ?_⟩
  · intro q r' hq hl
    simp [snapped, commit, setView, dirty, upd, hq, intern, init] at hl
  · rintro ⟨c, ct, hc, _⟩; simp [snapped, commit, setView, dirty, intern, init, upd] at hc
  · rintro ⟨h, hh, _⟩; simp [snapped, commit, setView, dirty, intern, init, pinGen] at hh
  · rintro ⟨f, hf, _⟩; simp [snapped, commit, setView, dirty, intern, init] at hf
  · decide

/-- Path 0 holds chunk 0, and is then opened and unlinked: only the
    descriptor holds the chunk, and the unlink queued it. -/
def lone : St :=
  let s1 := setView (dirty (commit (intern init 1 0) 0 (some (.chunk 0)))) 0 (some [1])
  { setView (dirty (commit s1 0 none)) 0 none with fds := s1.fds ++ [⟨.chunk 0, (s1.view 0).getD []⟩] }

theorem lone_reachable : Reachable 1 lone :=
  .step (.step .init (.writeSmall init 0 1 0 (by decide) (Or.inr rfl))) (.detach _ 0 ⟨1, .chunk 0⟩ (by decide) rfl)

/-- `lone`, then a GC skip of the pinned chunk that deletes its queue row, then
    the descriptor closes. -/
def leaked : St := { lone with queue := lone.queue.erase (.chunk 0), fds := [] }

theorem dropping_a_pinned_queue_row_leaks :
    Reachable 1 lone ∧ Ref.chunk 0 ∈ lone.queue ∧ FdRef lone (.chunk 0) ∧
    Stored leaked (.chunk 0) ∧ ¬ StrongRef leaked (.chunk 0) ∧ ¬ WriterHeld leaked (.chunk 0) ∧
    Ref.chunk 0 ∉ leaked.queue := by
  refine ⟨lone_reachable, by decide, ⟨⟨.chunk 0, [1]⟩, by simp [lone], rfl⟩,
    by simp [Stored, leaked, lone, commit, setView, dirty, intern, init, upd], ?_, id, by decide⟩
  rintro (⟨q, r, hl, he⟩ | ⟨h, hh, _⟩ | ⟨c, ct, hc, _⟩)
  · by_cases e : q = 0
    · subst e; simp [leaked, lone, commit, setView, dirty, upd] at hl
    · simp [leaked, lone, commit, setView, dirty, upd, e, intern, init] at hl
  · simp [leaked, lone, commit, setView, dirty, intern, init, pinGen] at hh
  · simp [leaked, lone, commit, setView, dirty, intern, init, upd] at hc

end Nimbus.ContentStore.Bugs
