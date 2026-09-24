/-
  Nimbus.Coherence.Refetch — the wait a resumption takes on a refetch in
  flight (`_refetch`'s `done`, node-shims.ts), before and after eb542b0b.

  A schedule is what the platform decides: when each refetch of the path was
  issued and when its read landed, which refetch is the newest in
  `_refetching` at each instant, and whether the path is held (installed) at
  each instant. Fairness is that every issued read lands. A resumption that
  waits on refetch `i` runs when `done i` settles.

  * Before eb542b0b (`Old`): `done` loops while the path is unheld, awaiting
    the NEWEST refetch's `done` each time — so it follows every refetch any
    later barrier issues.
  * After (`New`): `done` waits once, on the read of the refetch that was
    newest when its own read settled, and then settles whether or not the path
    is held.

  The livelock schedule is 'a peer rewrites the file faster than one read round
  trip': every barrier reports the path, so each refetch is declined and a newer
  one is issued before its read lands, and the path is never held.
-/

namespace Nimbus.Coherence.Refetch

structure Schedule where
  /-- When refetch `i`'s read landed (every read lands: fairness). -/
  landed : Nat → Nat
  /-- The newest refetch in `_refetching` at an instant. -/
  newest : Nat → Option Nat
  /-- The path is held (a refetch's install was made) at an instant. -/
  held : Nat → Bool

/-- Before eb542b0b: `done i` has settled by `n` if its read landed by `n` and
    either the path was held then, nothing newer was in flight, or the newest
    refetch's own `done` has settled by `n`. -/
inductive Old (σ : Schedule) : Nat → Nat → Prop
  | held (i n : Nat) : σ.landed i ≤ n → σ.held (σ.landed i) = true → Old σ i n
  | alone (i n : Nat) : σ.landed i ≤ n → σ.newest (σ.landed i) = none → Old σ i n
  | follow (i j n : Nat) : σ.landed i ≤ n → σ.held (σ.landed i) = false →
      σ.newest (σ.landed i) = some j → j ≠ i → Old σ j n → Old σ i n

/-- After eb542b0b: `done i` has settled by `n` once its read landed and, if
    the path was not held then, the read of the refetch newest at that instant
    landed too. -/
def New (σ : Schedule) (i n : Nat) : Prop :=
  σ.landed i ≤ n ∧ (σ.held (σ.landed i) = true ∨ ∀ j, σ.newest (σ.landed i) = some j → σ.landed j ≤ n)

/-- After the fix, under fairness alone, `done i` settles within the later of
    two landings: its own read's and the read that was newest when it landed.
    No property of the writer enters. -/
theorem new_settles (σ : Schedule) (i : Nat) :
    New σ i (max (σ.landed i) (match σ.newest (σ.landed i) with | some j => σ.landed j | none => 0)) := by
  refine ⟨Nat.le_max_left _ _, Or.inr fun j hj => ?_⟩
  rw [hj]; exact Nat.le_max_right _ _

/-- Before the fix: in any schedule where the path is never held and, when
    each read lands, a newer refetch is in flight, `done` never settles — the
    wait follows the writer forever. -/
theorem old_never_settles (σ : Schedule) (hheld : ∀ t, σ.held t = false)
    (hnewer : ∀ i, ∃ j, σ.newest (σ.landed i) = some j ∧ j ≠ i) : ∀ i n, ¬ Old σ i n := by
  intro i n h
  induction h with
  | held i n _ hh => rw [hheld] at hh; cases hh
  | alone i n _ hn => obtain ⟨j, hj, _⟩ := hnewer i; rw [hj] at hn; cases hn
  | follow _ _ _ _ _ _ _ _ ih => exact ih

/-- The measured schedule (the red test in resident-store-provenance.mjs,
    'a peer that keeps rewriting a held file'): a resumption every tick, a read
    taking three ticks, every resumption reporting the path, so refetch `i`
    (issued at `2i`) lands at `2i + 3`, after refetch `i+1` was issued at
    `2i + 2` and declined it. -/
def peerOutpacesReads : Schedule where
  landed i := 2 * i + 3
  newest t := some (t / 2)
  held _ := false

theorem livelock_before_eb542b0b : ∀ i n, ¬ Old peerOutpacesReads i n :=
  old_never_settles _ (fun _ => rfl) fun i => ⟨i + 1, by simp [peerOutpacesReads]; omega, by omega⟩

/-- The same schedule after the fix: the resumption waiting on refetch `i` runs
    at `2i + 5`, while the writer is still writing. -/
theorem settles_after_eb542b0b (i : Nat) : New peerOutpacesReads i (2 * i + 5) := by
  refine ⟨by simp [peerOutpacesReads], Or.inr fun j hj => ?_⟩
  simp only [peerOutpacesReads, Option.some.injEq] at hj
  subst hj
  show 2 * ((2 * i + 3) / 2) + 3 ≤ 2 * i + 5
  omega

end Nimbus.Coherence.Refetch
