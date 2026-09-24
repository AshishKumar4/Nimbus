/-
  Nimbus.Coherence.DurableDelta — P5's durable ACQUIRE answer
  (`SqliteVFS.invalidatedFromSql`, work/content-store): when the in-memory log no
  longer reaches back to a cursor, the answer is read from `vfs_inodes` (every
  row written with the generation of its transaction, INSERT OR REPLACE) and
  `vfs_tombstones` (one row per deleted path, in the deleting transaction, INSERT
  OR REPLACE, pruned oldest-first raising the tombstone floor).

  `sql_delta_exact`: from any cursor at or above the tombstone floor, that answer
  names exactly the paths whose last event (write or delete) came after the
  cursor, each at that event's generation — the delta the log would have given,
  which is what `Nimbus.Coherence.Store.delta_complete` asks of an answer. A
  cursor below the floor must poison (`below_tomb_floor_poisons` is the code's
  rule; `a_pruned_tombstone_hides_a_delete` shows why).
-/

namespace Nimbus.Coherence.DurableDelta

abbrev Path := Nat

inductive Ev where
  | write
  | delete
  deriving DecidableEq

structure Db where
  gen : Nat
  live : Path → Option Nat
  tombs : Path → Option Nat
  tombFloor : Nat
  /-- Ghost: each path's newest event. -/
  last : Path → Option (Nat × Ev)

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β := fun y => if y = x then b else f y

/-- `pruneTombstones`: every tombstone at or below `e` goes. -/
def pruneTombs (t : Path → Option Nat) (e : Nat) : Path → Option Nat := fun p =>
  match t p with
  | some g => if g ≤ e then none else some g
  | none => none

def writeAt (s : Db) (p g : Nat) : Db :=
  { s with gen := g, live := upd s.live p (some g), last := upd s.last p (some (g, .write)) }

def deleteAt (s : Db) (p g : Nat) : Db :=
  { s with gen := g, live := upd s.live p none, tombs := upd s.tombs p (some g),
           last := upd s.last p (some (g, .delete)) }

def pruneAt (s : Db) (e : Nat) : Db :=
  { s with tombs := pruneTombs s.tombs e, tombFloor := max s.tombFloor e }

inductive Step : Db → Db → Prop
  /-- A transaction at generation `g` writes `p`'s row. -/
  | write (s : Db) (p g : Nat) : s.gen < g → Step s (writeAt s p g)
  /-- A transaction at generation `g` deletes `p` and tombstones it. -/
  | delete (s : Db) (p g : Nat) : s.gen < g → Step s (deleteAt s p g)
  /-- `pruneTombstones`: every tombstone at or below `e` goes; the floor rises. -/
  | prune (s : Db) (e : Nat) : e ≤ s.gen → Step s (pruneAt s e)

def init (g : Nat) : Db :=
  { gen := g, live := fun _ => none, tombs := fun _ => none, tombFloor := g, last := fun _ => none }

inductive Reachable : Db → Prop
  | init (g : Nat) : Reachable (init g)
  | step {s s' : Db} : Reachable s → Step s s' → Reachable s'

/-- The SQL answer from cursor `c` for one path. -/
def sqlDelta (s : Db) (c : Nat) (p : Path) : Option Nat :=
  let g := max ((s.live p).getD 0) ((s.tombs p).getD 0)
  if c < g then some g else none

/-- What the log would have said: the path's last event, if after `c`. -/
def logDelta (s : Db) (c : Nat) (p : Path) : Option Nat :=
  match s.last p with
  | some (g, _) => if c < g then some g else none
  | none => none

structure Inv (s : Db) : Prop where
  wrote : ∀ p g, s.last p = some (g, .write) → s.live p = some g ∧ ((s.tombs p).getD 0) ≤ g
  deleted : ∀ p g, s.last p = some (g, .delete) → s.live p = none ∧
    (s.tombs p = some g ∨ (g ≤ s.tombFloor ∧ ((s.tombs p).getD 0) ≤ g))
  never : ∀ p, s.last p = none → s.live p = none ∧ s.tombs p = none
  lastLe : ∀ p g e, s.last p = some (g, e) → g ≤ s.gen
  floorLe : s.tombFloor ≤ s.gen

theorem init_inv (g : Nat) : Inv (init g) := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> intros <;> simp_all [init]

theorem step_inv {s s' : Db} (hi : Inv s) (h : Step s s') : Inv s' := by
  cases h with
  | write p g hg =>
    refine ⟨?_, ?_, ?_, ?_, ?_⟩
    · intro q g' hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · rename_i e; subst e; simp at hq; subst hq; simp
        cases ht : s.tombs q with
        | none => simp
        | some t =>
          simp
          cases hl : s.last q with
          | none => rw [(hi.never q hl).2] at ht; cases ht
          | some x =>
            rcases x with ⟨g0, e0⟩
            have := hi.lastLe q g0 e0 hl
            cases e0 with
            | write => have := (hi.wrote q g0 hl).2; rw [ht] at this; simp at this; omega
            | delete =>
              rcases (hi.deleted q g0 hl).2 with h1 | ⟨_, h1⟩
              · rw [ht] at h1; injection h1 with h1; omega
              · rw [ht] at h1; simp at h1; omega
      · rename_i e; rw [if_neg e]; exact hi.wrote q g' hq
    · intro q g' hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · simp at hq
      · rename_i e; rw [if_neg e]; exact hi.deleted q g' hq
    · intro q hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · simp at hq
      · rename_i e; rw [if_neg e]; exact hi.never q hq
    · intro q g' e hq
      simp only [writeAt, deleteAt, upd] at hq
      split at hq
      · simp at hq; show g' ≤ g; omega
      · have := hi.lastLe q g' e hq; show g' ≤ g; omega
    · have := hi.floorLe; show s.tombFloor ≤ g; omega
  | delete p g hg =>
    refine ⟨?_, ?_, ?_, ?_, ?_⟩
    · intro q g' hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · simp at hq
      · rename_i e; rw [if_neg e, if_neg e]; exact hi.wrote q g' hq
    · intro q g' hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · rename_i e; subst e; simp at hq; subst hq; simp
      · rename_i e; rw [if_neg e, if_neg e]; exact hi.deleted q g' hq
    · intro q hq
      simp only [writeAt, deleteAt, upd] at hq ⊢
      split at hq
      · simp at hq
      · rename_i e; rw [if_neg e, if_neg e]; exact hi.never q hq
    · intro q g' e hq
      simp only [writeAt, deleteAt, upd] at hq
      split at hq
      · simp at hq; show g' ≤ g; omega
      · have := hi.lastLe q g' e hq; show g' ≤ g; omega
    · have := hi.floorLe; show s.tombFloor ≤ g; omega
  | prune e he =>
    have pr : ∀ q, (pruneTombs s.tombs e q).getD 0 ≤ (s.tombs q).getD 0 := by
      intro q; unfold pruneTombs; cases s.tombs q with
      | none => simp
      | some t => simp; split <;> simp
    refine ⟨?_, ?_, ?_, ?_, ?_⟩
    · intro q g hq
      obtain ⟨h1, h2⟩ := hi.wrote q g hq
      exact ⟨h1, Nat.le_trans (pr q) h2⟩
    · intro q g hq
      obtain ⟨h1, h2⟩ := hi.deleted q g hq
      refine ⟨h1, ?_⟩
      show pruneTombs s.tombs e q = some g ∨ (g ≤ max s.tombFloor e ∧ (pruneTombs s.tombs e q).getD 0 ≤ g)
      rcases h2 with h2 | ⟨h2, h3⟩
      · unfold pruneTombs; rw [h2]; simp only
        split
        · right; refine ⟨by omega, by simp⟩
        · left; rfl
      · right; exact ⟨by omega, Nat.le_trans (pr q) h3⟩
    · intro q hq
      obtain ⟨h1, h2⟩ := hi.never q hq
      exact ⟨h1, by show pruneTombs s.tombs e q = none; unfold pruneTombs; rw [h2]⟩
    · exact hi.lastLe
    · have := hi.floorLe; show max s.tombFloor e ≤ s.gen; omega

theorem reachable_inv {s : Db} (h : Reachable s) : Inv s := by
  induction h with
  | init g => exact init_inv g
  | step _ hs ih => exact step_inv ih hs

/-- From a cursor at or above the tombstone floor the SQL answer is exactly the
    log's: every path whose last write or delete came after the cursor, at its
    generation, and no other. -/
theorem sql_delta_exact {s : Db} (h : Reachable s) {c : Nat} (hc : s.tombFloor ≤ c) (p : Path) :
    sqlDelta s c p = logDelta s c p := by
  have hi := reachable_inv h
  unfold sqlDelta logDelta
  cases hl : s.last p with
  | none =>
    obtain ⟨h1, h2⟩ := hi.never p hl
    simp [h1, h2]
  | some x =>
    rcases x with ⟨g, e⟩
    cases e with
    | write =>
      obtain ⟨h1, h2⟩ := hi.wrote p g hl
      rw [h1]; simp only [Option.getD_some]
      rw [Nat.max_eq_left h2]
    | delete =>
      obtain ⟨h1, h2⟩ := hi.deleted p g hl
      rw [h1]; simp only [Option.getD_none, Nat.zero_max]
      rcases h2 with h2 | ⟨h2, h3⟩
      · rw [h2]; rfl
      · have hn : ¬ c < g := by omega
        have hn' : ¬ c < (s.tombs p).getD 0 := by omega
        simp only [hn, hn', if_false]

/-- Why a cursor below the floor must poison: a delete whose tombstone was
    pruned is invisible to the SQL answer. -/
theorem a_pruned_tombstone_hides_a_delete :
    let s2 := pruneAt (deleteAt (init 0) 0 1) 1
    Reachable s2 ∧ logDelta s2 0 0 = some 1 ∧ sqlDelta s2 0 0 = none := by
  refine ⟨.step (.step (.init 0) (.delete _ 0 1 (by decide))) (.prune _ 1 (by decide)), ?_, ?_⟩ <;>
    simp [logDelta, sqlDelta, pruneAt, deleteAt, pruneTombs, upd, init]

end Nimbus.Coherence.DurableDelta
