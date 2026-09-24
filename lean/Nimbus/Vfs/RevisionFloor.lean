/-
  Nimbus.Vfs.RevisionFloor — `SqliteVFS` per-path revisions under a byte budget
  (`packages/core/src/vfs/sqlite-vfs.ts`: `bumpRevision`, `dropOldestPathRevisions`,
  `pathRevision`, `revision`).

  A path is its list of components; `[]` is the root, whose revision is the
  global clock. `bump` is the code's walk, including its early exit at a path
  this bump already stamped. `drop` removes every stamp at or below a cutoff
  and raises the floor to it; the code picks the cutoff from the budget, and
  every theorem here holds for any cutoff not above the clock.

  `last p` is ghost state: the newest bump whose mutated path lies under `p`
  (or is `p`). The theorems: a path never reports below `last p`; a report
  never falls; a directory reports at or above everything under it.
-/

namespace Nimbus.Vfs.RevisionFloor

abbrev Path := List String

/-- `a` is a directory on the way down to `q` (or `q` itself). -/
def Under (a q : Path) : Prop := a ≠ [] ∧ a <+: q

instance (a q : Path) : Decidable (Under a q) := inferInstanceAs (Decidable (_ ∧ _))

def upd {β : Type} (f : Path → β) (p : Path) (b : β) : Path → β :=
  fun q => if q = p then b else f q

structure St where
  clock : Nat
  stamps : Path → Option Nat
  floor : Nat
  /-- Ghost: the newest bump that mutated `p` or a path under it. -/
  last : Path → Nat

def revision (s : St) (p : Path) : Nat :=
  if p = [] then s.clock else (s.stamps p).getD s.floor

/-- A stamp table held as a value. The walk returns one rather than a bare
    function so that the fixture generator evaluates each walk once: a function
    result would be re-walked on every lookup, exponentially. -/
structure Tbl where
  get : Path → Option Nat

/-- The code's walk from a mutated path up to the root: stamp, and stop early at
    a path this bump already stamped (its ancestors were stamped with it). -/
def walk (rev : Nat) (st : Tbl) : Path → Tbl
  | [] => st
  | x :: xs =>
    if st.get (x :: xs) = some rev then st
    else walk rev ⟨upd st.get (x :: xs) (some rev)⟩ (x :: xs).dropLast
termination_by p => p.length
decreasing_by simp [List.length_dropLast]

def walkAll (rev : Nat) (st : Tbl) : List Path → Tbl
  | [] => st
  | p :: ps => walkAll rev (walk rev st p) ps

/-- One mutation of `paths`: the clock advances once and every path, with every
    directory above it, is stamped. -/
@[noinline] def bump (s : St) (paths : List Path) : St :=
  let rev := s.clock + 1
  { clock := rev
    stamps := (walkAll rev ⟨s.stamps⟩ paths).get
    floor := s.floor
    last := fun q => if paths.any (fun p => decide (Under q p)) then rev else s.last q }

/-- Drop every stamp at or below `cutoff`; the floor rises to it. Not inlined:
    the fixture generator must evaluate `cutoff` once, not inside every lookup. -/
@[noinline] def drop (s : St) (cutoff : Nat) : St :=
  { s with
    stamps := fun q => match s.stamps q with
      | some v => if v ≤ cutoff then none else some v
      | none => none
    floor := max s.floor cutoff }

inductive Step : St → St → Prop
  | bump (s : St) (paths : List Path) : Step s (bump s paths)
  | drop (s : St) (cutoff : Nat) : cutoff ≤ s.clock → Step s (drop s cutoff)

def init : St := { clock := 0, stamps := fun _ => none, floor := 0, last := fun _ => 0 }

inductive Reachable : St → Prop
  | init : Reachable init
  | step {s s' : St} : Reachable s → Step s s' → Reachable s'

/-! ## The invariant -/

structure Inv (s : St) : Prop where
  /-- A stamped path's directories are stamped at least as new. -/
  closed : ∀ q a v, s.stamps q = some v → Under a q → ∃ w, s.stamps a = some w ∧ v ≤ w
  aboveFloor : ∀ q v, s.stamps q = some v → s.floor < v
  belowClock : ∀ q v, s.stamps q = some v → v ≤ s.clock
  floorLe : s.floor ≤ s.clock
  lastStamped : ∀ q v, s.stamps q = some v → s.last q ≤ v
  lastDropped : ∀ q, q ≠ [] → s.stamps q = none → s.last q ≤ s.floor
  rootUnstamped : s.stamps [] = none

theorem init_inv : Inv init := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intros <;> simp_all [init]

/-! ### Prefix facts -/

theorem under_refl {p : Path} (h : p ≠ []) : Under p p := ⟨h, List.prefix_refl p⟩

theorem under_trans {a b c : Path} (hab : Under a b) (hbc : Under b c) : Under a c :=
  ⟨hab.1, hab.2.trans hbc.2⟩

theorem under_ne_nil {a p : Path} (h : Under a p) : p ≠ [] := by
  intro hp; subst hp
  exact h.1 (List.prefix_nil.mp h.2)

/-- A directory above `p` is `p` or above `p.dropLast`. -/
theorem under_cases {a p : Path} (h : Under a p) : a = p ∨ Under a p.dropLast := by
  have hp := under_ne_nil h
  have h2 := h.2
  rw [← List.dropLast_concat_getLast hp] at h2 ⊢
  rcases List.prefix_concat_iff.mp h2 with e | e
  · exact Or.inl e
  · right; rw [List.dropLast_concat]; exact ⟨h.1, e⟩

theorem under_dropLast {a p : Path} (h : Under a p.dropLast) : Under a p :=
  ⟨h.1, h.2.trans (List.dropLast_prefix p)⟩

theorem under_length {a p : Path} (h : Under a p) : a.length ≤ p.length := h.2.length_le

/-! ### The walk -/

/-- What a walk from `p` leaves: every directory above `p` stamped `rev`. -/
def walked (rev : Nat) (st : Path → Option Nat) (p : Path) : Path → Option Nat :=
  fun q => if Under q p then some rev else st q

/-- Every directory of `p` this bump already stamped has its own directories
    stamped too: what makes the walk's early exit sound. -/
def StopSound (rev : Nat) (st : Path → Option Nat) (p : Path) : Prop :=
  ∀ a, Under a p → st a = some rev → ∀ b, Under b a → st b = some rev

theorem walk_eq (rev : Nat) :
    ∀ (p : Path) (st : Tbl), StopSound rev st.get p →
      (walk rev st p).get = walked rev st.get p := by
  intro p
  induction p using (measure List.length).wf.induction with
  | _ p ih =>
  intro st hs
  match p, ih with
  | [], _ =>
    funext q
    unfold walk walked
    rw [if_neg (fun h => under_ne_nil h rfl)]
  | x :: xs, ih =>
    unfold walk
    have hp : (x :: xs) ≠ [] := by simp
    split
    · rename_i hst
      funext q
      simp only [walked]
      split
      · rename_i hq
        rcases under_cases hq with h | h
        · rw [h]; exact hst
        · exact hs _ (under_refl hp) hst _ (under_dropLast h)
      · rfl
    · rename_i hst
      have hlen : (x :: xs).dropLast.length < (x :: xs).length := by
        simp [List.length_dropLast]
      have hs' : StopSound rev (⟨upd st.get (x :: xs) (some rev)⟩ : Tbl).get (x :: xs).dropLast := by
        intro a ha hsa b hb
        have hne : a ≠ x :: xs := by
          intro h; subst h
          have := under_length ha
          simp [List.length_dropLast] at this
          omega
        simp only [upd, if_neg hne] at hsa
        have := hs a (under_dropLast ha) hsa b hb
        simp only [upd]; split <;> simp_all
      rw [ih _ hlen _ hs']
      funext q
      simp only [walked, upd]
      by_cases h1 : Under q (x :: xs).dropLast
      · rw [if_pos h1, if_pos (under_dropLast h1)]
      · rw [if_neg h1]
        by_cases h2 : q = x :: xs
        · subst h2; rw [if_pos rfl, if_pos (under_refl hp)]
        · rw [if_neg h2]
          have : ¬ Under q (x :: xs) := by
            intro h; rcases under_cases h with h | h <;> contradiction
          rw [if_neg this]

/-- Every path stamped `rev` has its directories stamped `rev`. -/
def Closed (rev : Nat) (st : Path → Option Nat) : Prop :=
  ∀ q, st q = some rev → ∀ a, Under a q → st a = some rev

theorem walked_closed {rev : Nat} {st : Path → Option Nat} {p : Path} (hc : Closed rev st) :
    Closed rev (walked rev st p) := by
  intro q hq a ha
  simp only [walked] at hq ⊢
  split at hq
  · rename_i h; rw [if_pos (under_trans ha h)]
  · split
    · rfl
    · exact hc q hq a ha

/-- The whole bump, early exits included, stamps exactly the directories above
    every mutated path. -/
theorem walkAll_eq (rev : Nat) :
    ∀ (paths : List Path) (st : Tbl), Closed rev st.get →
      (walkAll rev st paths).get =
        fun q => if paths.any (fun p => decide (Under q p)) then some rev else st.get q := by
  intro paths
  induction paths with
  | nil => intro st _; funext q; simp [walkAll]
  | cons p ps ih =>
    intro st hc
    simp only [walkAll]
    have hw := walk_eq rev p st (fun a _ ha b hb => hc a ha b hb)
    have hc' : Closed rev (walk rev st p).get := by rw [hw]; exact walked_closed hc
    rw [ih _ hc', hw]
    funext q
    simp only [walked, List.any_cons, Bool.or_eq_true, decide_eq_true_eq]
    by_cases h1 : Under q p
    · simp [h1]
    · simp [h1]

/-! ## The invariant holds in every reachable state -/

theorem bump_inv {s : St} (hi : Inv s) (paths : List Path) : Inv (bump s paths) := by
  have hc : Closed (s.clock + 1) s.stamps := by
    intro q hq; have := hi.belowClock q _ hq; omega
  have hst : (bump s paths).stamps =
      fun q => if paths.any (fun p => decide (Under q p)) then some (s.clock + 1) else s.stamps q :=
    walkAll_eq _ paths ⟨s.stamps⟩ hc
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro q a v hq ha
    rw [hst] at hq ⊢
    simp only at hq ⊢
    split at hq
    · rename_i h
      obtain ⟨p, hp, hu⟩ := List.any_eq_true.mp h
      have : paths.any (fun p => decide (Under a p)) = true :=
        List.any_eq_true.mpr ⟨p, hp, decide_eq_true (under_trans ha (of_decide_eq_true hu))⟩
      rw [if_pos this]; injection hq with hq; exact ⟨_, rfl, Nat.le_of_eq hq.symm⟩
    · obtain ⟨w, hw, hvw⟩ := hi.closed q a v hq ha
      split
      · refine ⟨_, rfl, ?_⟩; have := hi.belowClock a w hw; omega
      · exact ⟨w, hw, hvw⟩
  · intro q v hq
    rw [hst] at hq; simp only at hq
    show s.floor < v
    split at hq
    · injection hq with hq; have := hi.floorLe; omega
    · exact hi.aboveFloor q v hq
  · intro q v hq
    rw [hst] at hq; simp only at hq
    show v ≤ s.clock + 1
    split at hq
    · injection hq with hq; omega
    · have := hi.belowClock q v hq; omega
  · show s.floor ≤ s.clock + 1; have := hi.floorLe; omega
  · intro q v hq
    rw [hst] at hq; simp only at hq
    show (if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q) ≤ v
    split at hq
    · rename_i h; rw [if_pos h]; injection hq with hq; omega
    · rename_i h; rw [if_neg h]; exact hi.lastStamped q v hq
  · intro q hq hn
    rw [hst] at hn; simp only at hn
    show (if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q) ≤ s.floor
    split at hn
    · cases hn
    · rename_i h; rw [if_neg h]; exact hi.lastDropped q hq hn
  · rw [hst]; simp only
    have : ¬ paths.any (fun p => decide (Under [] p)) = true := by
      intro h; obtain ⟨p, _, hu⟩ := List.any_eq_true.mp h
      exact (of_decide_eq_true hu).1 rfl
    rw [if_neg this]; exact hi.rootUnstamped

theorem drop_inv {s : St} (hi : Inv s) {cutoff : Nat} (hc : cutoff ≤ s.clock) :
    Inv (drop s cutoff) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro q a v hq ha
    simp only [drop] at hq ⊢
    split at hq
    · rename_i v' hv'
      split at hq
      · cases hq
      · rename_i hgt
        injection hq with hq; subst hq
        obtain ⟨w, hw, hvw⟩ := hi.closed q a v' hv' ha
        rw [hw]; simp only
        rw [if_neg (by omega)]; exact ⟨w, rfl, hvw⟩
    · cases hq
  · intro q v hq
    simp only [drop] at hq ⊢
    split at hq
    · rename_i v' hv'
      split at hq
      · cases hq
      · rename_i hgt; injection hq with hq; subst hq
        have := hi.aboveFloor q v' hv'; omega
    · cases hq
  · intro q v hq
    simp only [drop] at hq ⊢
    split at hq
    · rename_i v' hv'
      split at hq
      · cases hq
      · injection hq with hq; subst hq; exact hi.belowClock q v' hv'
    · cases hq
  · show max s.floor cutoff ≤ s.clock; have := hi.floorLe; omega
  · intro q v hq
    simp only [drop] at hq ⊢
    split at hq
    · rename_i v' hv'
      split at hq
      · cases hq
      · injection hq with hq; subst hq; exact hi.lastStamped q v' hv'
    · cases hq
  · intro q hq hn
    simp only [drop] at hn ⊢
    split at hn
    · rename_i v' hv'
      split at hn
      · rename_i hle; have := hi.lastStamped q v' hv'; omega
      · cases hn
    · rename_i hv'; have := hi.lastDropped q hq hv'; omega
  · simp only [drop]; rw [hi.rootUnstamped]

theorem step_inv {s s' : St} (hi : Inv s) (h : Step s s') : Inv s' := by
  cases h with
  | bump paths => exact bump_inv hi paths
  | drop c hc => exact drop_inv hi hc

theorem reachable_inv {s : St} (h : Reachable s) : Inv s := by
  induction h with
  | init => exact init_inv
  | step _ hs ih => exact step_inv ih hs

/-! ## What consumers rely on -/

/-- A path never reports a revision below its own last mutation, or the last
    mutation of anything under it: a resident row, a write receipt or an
    `expectedRevision` compared against it can never be vouched for by a
    smaller number. -/
theorem revision_ge_last {s : St} (h : Reachable s) (p : Path) (hp : p ≠ []) :
    s.last p ≤ revision s p := by
  have hi := reachable_inv h
  unfold revision
  rw [if_neg hp]
  cases hq : s.stamps p with
  | none => simpa using hi.lastDropped p hp hq
  | some v => simpa using hi.lastStamped p v hq

/-- A directory reports at or above every path under it. -/
theorem revision_watermark {s : St} (h : Reachable s) {a q : Path} (hu : Under a q) :
    revision s q ≤ revision s a := by
  have hi := reachable_inv h
  unfold revision
  rw [if_neg (under_ne_nil hu), if_neg hu.1]
  cases hq : s.stamps q with
  | none =>
    cases ha : s.stamps a with
    | none => simp
    | some w => have := hi.aboveFloor a w ha; simp; omega
  | some v =>
    obtain ⟨w, hw, hvw⟩ := hi.closed q a v hq hu
    rw [hw]; simpa using hvw

/-- No step lowers any path's report. -/
theorem revision_monotone {s s' : St} (h : Reachable s) (hs : Step s s') (p : Path) :
    revision s p ≤ revision s' p := by
  have hi := reachable_inv h
  cases hs with
  | bump paths =>
    have hc : Closed (s.clock + 1) s.stamps := by
      intro q hq; have := hi.belowClock q _ hq; omega
    unfold revision
    by_cases hp : p = []
    · simp [hp, bump]
    · rw [if_neg hp, if_neg hp]
      simp only [bump]
      rw [walkAll_eq _ paths ⟨s.stamps⟩ hc]
      simp only
      split
      · cases hq : s.stamps p with
        | none => simp; have := hi.floorLe; omega
        | some v => simp; have := hi.belowClock p v hq; omega
      · exact Nat.le_refl _
  | drop c hc =>
    unfold revision
    by_cases hp : p = []
    · simp [hp, drop]
    · rw [if_neg hp, if_neg hp]
      simp only [drop]
      cases hq : s.stamps p with
      | none => simp; omega
      | some v =>
        simp only
        split
        · simp; omega
        · simp

/-- The floor only rises. -/
theorem floor_monotone {s s' : St} (hs : Step s s') : s.floor ≤ s'.floor := by
  cases hs with
  | bump _ => exact Nat.le_refl _
  | drop c _ => show s.floor ≤ max s.floor c; omega

/-! ## The known bug: an unheld path reporting 0

Before `d35e88c6` a path without an entry reported 0 rather than the floor
(`resident-revision-floor.mjs` turns red with the floor replaced by 0). Here that
report is `revisionZero`, and one bump and one drop take it below the path's
last write. -/

def revisionZero (s : St) (p : Path) : Nat :=
  if p = [] then s.clock else (s.stamps p).getD 0

theorem a_zero_floor_reports_below_the_last_write :
    ∃ s, Reachable s ∧ revisionZero s ["a"] < s.last ["a"] := by
  let s1 := bump init [["a"]]
  let s2 := drop s1 1
  have hc : Closed 1 init.stamps := by intro q hq; simp [init] at hq
  have hst : s1.stamps = fun q => if [["a"]].any (fun p => decide (Under q p)) then some 1 else none :=
    walkAll_eq 1 [["a"]] ⟨init.stamps⟩ hc
  refine ⟨s2, .step (.step .init (.bump init [["a"]])) (.drop s1 1 (by decide)), ?_⟩
  have h1 : s1.stamps ["a"] = some 1 := by rw [hst]; decide
  show (if ["a"] = ([] : Path) then s2.clock else (s2.stamps ["a"]).getD 0) < s2.last ["a"]
  simp only [s2, drop, h1]
  decide

end Nimbus.Vfs.RevisionFloor
