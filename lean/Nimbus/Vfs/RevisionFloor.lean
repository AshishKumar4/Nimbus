/-
  Nimbus.Vfs.RevisionFloor — `SqliteVFS` per-path revisions under a byte budget
  (`packages/core/src/vfs/sqlite-vfs.ts`: `bumpRevision`, `dropOldestPathRevisions`,
  `dropPathRevisionsThrough`, `pruneTombstones`, `pathRevision`, `revision`).

  Only directories hold stamps. A bump stamps every directory strictly above a
  mutated path, and a mutated path only if it holds a stamp already: the
  transaction that mutated a path wrote its generation to SQLite, a live
  file's row (`files`) or, for anything else, a directory's row or a removed
  path's tombstone (`own`). So a file written or removed costs no memory. A
  path reports its stamp; else, for a live file, `min(row.gen, clock)` (P5,
  6cf3bddd); else `max(floor, min(own, clock))`.

  A path is its list of components; `[]` is the root, whose revision is the
  global clock. `walk` is the code's walk from the directory of a mutated path
  up, including its early exit at a directory this bump already stamped.
  `drop` removes every stamp at or below a cutoff and raises the floor to it;
  the code picks the cutoff from the budget or from the tombstones it prunes,
  and every theorem here holds for any cutoff not above the clock. `forget` is
  what the prune then loses: any generation at or below the floor.

  `last p` is ghost state: the newest bump whose mutated path lies under `p`
  (or is `p`). A bump writes the rows of the files it names at its revision,
  every other path it names stops being a file, and every path it names gets
  its own generation at the revision. A bump never names a path below a file.

  The theorems: a path never reports below `last p` nor above the clock; a
  directory reports at or above everything under it; so every report of a path
  made before a mutation of it is below every report made after
  (`revision_increases_across_mutation`). In the code a single report may
  fall (a file holding a directory's old stamp, rewritten by an operation of
  several transactions, then dropped to its row's generation), so no theorem
  claims it never does.

  One bump is one operation at revision `clock + 1`. The code's multi-transaction
  operations (a row's generation below the operation's revision) and jumping
  revisions are not modeled.
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
  /-- The generation of each live file's row. -/
  files : Path → Option Nat
  /-- The generation SQLite holds for a path that is not a live file: its
      directory row's, or its tombstone's; 0 for none. -/
  own : Path → Nat

/-- `pathRevision`: its stamp; else, for a live file, `min(row.gen, clock)`;
    else the floor or its own generation, whichever is later. The root reports
    the clock. -/
def revision (s : St) (p : Path) : Nat :=
  if p = [] then s.clock else
    match s.stamps p with
    | some v => v
    | none =>
      match s.files p with
      | some g => min g s.clock
      | none => max s.floor (min (s.own p) s.clock)

/-- A stamp table held as a value. The walk returns one rather than a bare
    function so that the fixture generator evaluates each walk once: a function
    result would be re-walked on every lookup, exponentially. -/
structure Tbl where
  get : Path → Option Nat

/-- The code's walk from a directory up to the root: stamp, and stop early at a
    directory this bump already stamped (its ancestors were stamped with it). -/
def walk (rev : Nat) (st : Tbl) : Path → Tbl
  | [] => st
  | x :: xs =>
    if st.get (x :: xs) = some rev then st
    else walk rev ⟨upd st.get (x :: xs) (some rev)⟩ (x :: xs).dropLast
termination_by p => p.length
decreasing_by simp [List.length_dropLast]

/-- The code's step for one mutated path: the walk from its directory, then its
    own stamp, if it holds one, moves to `rev`. -/
def stampOne (rev : Nat) (st : Tbl) (p : Path) : Tbl :=
  let w := walk rev st p.dropLast
  if (w.get p).isSome then ⟨upd w.get p (some rev)⟩ else w

def walkAll (rev : Nat) (st : Tbl) : List Path → Tbl
  | [] => st
  | p :: ps => walkAll rev (stampOne rev st p) ps

/-- One mutation of `paths`: the clock advances once and every directory above
    a path is stamped; the rows of `fs` are written at the new revision, every
    other named path stops being a file, and every named path's own generation
    is the new revision. -/
@[noinline] def bump (s : St) (paths fs : List Path) : St :=
  let rev := s.clock + 1
  { clock := rev
    stamps := (walkAll rev ⟨s.stamps⟩ paths).get
    floor := s.floor
    last := fun q => if paths.any (fun p => decide (Under q p)) then rev else s.last q
    files := fun q => if q ∈ fs then some rev else if q ∈ paths then none else s.files q
    own := fun q => if q ∈ paths then rev else s.own q }

/-- Drop every stamp at or below `cutoff`; the floor rises to it. Not inlined:
    the fixture generator must evaluate `cutoff` once, not inside every lookup. -/
@[noinline] def drop (s : St) (cutoff : Nat) : St :=
  { s with
    stamps := fun q => match s.stamps q with
      | some v => if v ≤ cutoff then none else some v
      | none => none
    floor := max s.floor cutoff }

/-- Pruned tombstones: the generations of any paths (`gone`) at or below the
    floor may be lost. -/
@[noinline] def forget (s : St) (gone : Path → Bool) : St :=
  { s with own := fun q => if gone q = true ∧ s.own q ≤ s.floor then 0 else s.own q }

inductive Step : St → St → Prop
  | bump (s : St) (paths fs : List Path) : (∀ f ∈ fs, f ∈ paths) →
      (∀ p ∈ paths, ∀ a, Under a p → a ≠ p → s.files a = none) → Step s (bump s paths fs)
  | drop (s : St) (cutoff : Nat) : cutoff ≤ s.clock → Step s (drop s cutoff)
  | forget (s : St) (gone : Path → Bool) : Step s (forget s gone)

def init : St :=
  { clock := 0, stamps := fun _ => none, floor := 0, last := fun _ => 0, files := fun _ => none,
    own := fun _ => 0 }

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
  /-- An unstamped path that is not a file: nothing at or under it changed
      after the floor and its own generation. -/
  lastOwn : ∀ q, q ≠ [] → s.stamps q = none → s.files q = none → s.last q ≤ max s.floor (s.own q)
  rootUnstamped : s.stamps [] = none
  lastClock : ∀ q, s.last q ≤ s.clock
  fileClock : ∀ q g, s.files q = some g → g ≤ s.clock
  ownClock : ∀ q, s.own q ≤ s.clock
  fileLast : ∀ q g, s.files q = some g → s.last q ≤ g
  /-- Every directory strictly above a file reports at least its row's generation. -/
  fileUnder : ∀ q g, s.files q = some g → ∀ a, Under a q → a ≠ q →
    (∃ w, s.stamps a = some w ∧ g ≤ w) ∨ g ≤ s.floor
  /-- And strictly above any other path, at least its own generation. -/
  ownUnder : ∀ q, s.files q = none → ∀ a, Under a q → a ≠ q →
    (∃ w, s.stamps a = some w ∧ s.own q ≤ w) ∨ s.own q ≤ s.floor

theorem init_inv : Inv init := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intros <;> simp_all [init]

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

/-- A path is not above itself's directory. -/
theorem not_under_dropLast (p : Path) : ¬ Under p p.dropLast := by
  intro h
  have := under_length h
  have hp := h.1
  cases p with
  | nil => exact hp rfl
  | cons x xs => simp [List.length_dropLast] at this; omega

/-- One path's step: every directory above it at `rev`, and its own stamp,
    if it held one. -/
theorem stampOne_eq {rev : Nat} {st : Tbl} (p : Path) (hc : Closed rev st.get) :
    (stampOne rev st p).get = fun q =>
      if Under q p.dropLast then some rev
      else if q = p ∧ (st.get q).isSome = true then some rev else st.get q := by
  have hw := walk_eq rev p.dropLast st (fun a _ ha b hb => hc a ha b hb)
  have hp : (walk rev st p.dropLast).get p = st.get p := by
    rw [hw]; simp only [walked]; rw [if_neg (not_under_dropLast p)]
  funext q
  unfold stampOne
  simp only
  split
  · rename_i hs
    rw [hp] at hs
    simp only [upd, hw, walked]
    by_cases h1 : Under q p.dropLast
    · have : q ≠ p := fun e => not_under_dropLast p (e ▸ h1)
      simp [h1, this]
    · by_cases h2 : q = p
      · subst h2; simp [h1, hs]
      · simp [h1, h2]
  · rename_i hs
    rw [hp] at hs
    rw [hw]; simp only [walked]
    by_cases h1 : Under q p.dropLast
    · simp [h1]
    · by_cases h2 : q = p
      · subst h2; simp [h1, hs]
      · simp [h1, h2]

theorem stampOne_closed {rev : Nat} {st : Tbl} (p : Path) (hc : Closed rev st.get) :
    Closed rev (stampOne rev st p).get := by
  rw [stampOne_eq p hc]
  intro q hq a ha
  simp only at hq ⊢
  by_cases h1 : Under q p.dropLast
  · rw [if_pos (under_trans ha h1)]
  · rw [if_neg h1] at hq
    by_cases h2 : q = p ∧ (st.get q).isSome = true
    · obtain ⟨e, hs⟩ := h2
      subst e
      rcases under_cases ha with e | h
      · subst e; rw [if_neg h1, if_pos ⟨rfl, hs⟩]
      · rw [if_pos h]
    · rw [if_neg h2] at hq
      have := hc q hq a ha
      split
      · rfl
      · split
        · rfl
        · exact this

/-- What a bump leaves in the stamp table: every directory strictly above a
    mutated path at `rev`, and every mutated path that held a stamp. -/
def bumped (rev : Nat) (st : Path → Option Nat) (paths : List Path) : Path → Option Nat :=
  fun q => if paths.any (fun p => decide (Under q p.dropLast)) = true ∨ (q ∈ paths ∧ (st q).isSome = true)
    then some rev else st q

/-- The whole bump, early exits included, is `bumped`, whatever the order of
    its paths. -/
theorem walkAll_eq (rev : Nat) :
    ∀ (paths : List Path) (st : Tbl), Closed rev st.get →
      (walkAll rev st paths).get = bumped rev st.get paths := by
  intro paths
  induction paths with
  | nil => intro st _; funext q; simp [walkAll, bumped]
  | cons p ps ih =>
    intro st hc
    simp only [walkAll]
    rw [ih _ (stampOne_closed p hc), stampOne_eq p hc]
    funext q
    simp only [bumped, List.any_cons, Bool.or_eq_true, decide_eq_true_eq, List.mem_cons]
    by_cases h1 : Under q p.dropLast
    · simp [h1]
    · by_cases h2 : q = p
      · subst h2
        by_cases hs : (st.get q).isSome = true
        · simp [h1, hs]
        · simp [h1, hs]
      · simp [h1, h2]

/-! ## The invariant holds in every reachable state -/

theorem bump_inv {s : St} (hi : Inv s) (paths fs : List Path) (hfs : ∀ f ∈ fs, f ∈ paths)
    (hnest : ∀ p ∈ paths, ∀ a, Under a p → a ≠ p → s.files a = none) : Inv (bump s paths fs) := by
  have hc : Closed (s.clock + 1) s.stamps := by
    intro q hq; have := hi.belowClock q _ hq; omega
  have hst : (bump s paths fs).stamps = bumped (s.clock + 1) s.stamps paths :=
    walkAll_eq _ paths ⟨s.stamps⟩ hc
  -- A directory strictly above a named path is stamped at the new revision.
  have above : ∀ p ∈ paths, ∀ a, Under a p → a ≠ p → (bump s paths fs).stamps a = some (s.clock + 1) := by
    intro p hp a ha hne
    rw [hst]; simp only [bumped]
    rcases under_cases ha with e | h
    · exact absurd e hne
    · rw [if_pos (Or.inl (List.any_eq_true.mpr ⟨p, hp, decide_eq_true h⟩))]
  -- Every stamp the bump leaves is the new revision or one it found.
  have kept : ∀ q v, (bump s paths fs).stamps q = some v → v = s.clock + 1 ∨ s.stamps q = some v := by
    intro q v hq
    rw [hst] at hq; simp only [bumped] at hq
    split at hq
    · injection hq with hq; exact Or.inl hq.symm
    · exact Or.inr hq
  -- A stamp the bump found survives, at the new revision or its own.
  have grown : ∀ q w, s.stamps q = some w → ∃ w', (bump s paths fs).stamps q = some w' ∧ w ≤ w' := by
    intro q w hq
    rw [hst]; simp only [bumped]
    split
    · refine ⟨_, rfl, ?_⟩; have := hi.belowClock q w hq; omega
    · exact ⟨w, hq, Nat.le_refl _⟩
  -- The bump's `last`: a path is changed iff it is named or above a named path.
  have hlast : ∀ q, (bump s paths fs).last q = if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q :=
    fun _ => rfl
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · -- closed
    intro q a v hq ha
    rw [hst] at hq ⊢
    simp only [bumped] at hq ⊢
    split at hq
    · rename_i h
      injection hq with hq; subst hq
      rcases h with h | ⟨hmem, _⟩
      · obtain ⟨p, hp, hu⟩ := List.any_eq_true.mp h
        rw [if_pos (Or.inl (List.any_eq_true.mpr ⟨p, hp, decide_eq_true (under_trans ha (of_decide_eq_true hu))⟩))]
        exact ⟨_, rfl, Nat.le_refl _⟩
      · rcases under_cases ha with e | h'
        · subst e
          have : (bumped (s.clock + 1) s.stamps paths a) = some (s.clock + 1) := by
            simp only [bumped]; rw [if_pos (Or.inr ⟨hmem, by assumption⟩)]
          simp only [bumped] at this; rw [this]; exact ⟨_, rfl, Nat.le_refl _⟩
        · rw [if_pos (Or.inl (List.any_eq_true.mpr ⟨q, hmem, decide_eq_true h'⟩))]
          exact ⟨_, rfl, Nat.le_refl _⟩
    · obtain ⟨w, hw, hvw⟩ := hi.closed q a v hq ha
      split
      · refine ⟨_, rfl, ?_⟩; have := hi.belowClock a w hw; omega
      · exact ⟨w, hw, hvw⟩
  · -- aboveFloor
    intro q v hq
    show s.floor < v
    rcases kept q v hq with e | h
    · have := hi.floorLe; omega
    · exact hi.aboveFloor q v h
  · -- belowClock
    intro q v hq
    show v ≤ s.clock + 1
    rcases kept q v hq with e | h
    · omega
    · have := hi.belowClock q v h; omega
  · show s.floor ≤ s.clock + 1; have := hi.floorLe; omega
  · -- lastStamped
    intro q v hq
    rw [hlast]
    rcases kept q v hq with e | h
    · subst e; split
      · exact Nat.le_refl _
      · have := hi.lastClock q; omega
    · split
      · rename_i hu
        -- Named or above a named path, and it held `v` before: the bump moved it.
        obtain ⟨p, hp, hup⟩ := List.any_eq_true.mp hu
        have hup := of_decide_eq_true hup
        have hmoved : (bump s paths fs).stamps q = some (s.clock + 1) := by
          rcases under_cases hup with e | h'
          · subst e
            rw [hst]; simp only [bumped]; rw [if_pos (Or.inr ⟨hp, by simp [h]⟩)]
          · exact above p hp q hup (fun e => not_under_dropLast p (e ▸ h'))
        rw [hmoved] at hq; injection hq with hq; omega
      · exact hi.lastStamped q v h
  · -- lastOwn
    intro q hq hn hf
    rw [hlast]
    show (if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q)
      ≤ max s.floor (if q ∈ paths then s.clock + 1 else s.own q)
    split
    · rename_i hu
      obtain ⟨p, hp, hup⟩ := List.any_eq_true.mp hu
      have hup := of_decide_eq_true hup
      rcases under_cases hup with e | h'
      · subst e; rw [if_pos hp]; omega
      · have := above p hp q hup (fun e => not_under_dropLast p (e ▸ h')); rw [hn] at this; cases this
    · rename_i hu
      have hnm : q ∉ paths := fun hm =>
        hu (List.any_eq_true.mpr ⟨q, hm, decide_eq_true (under_refl hq)⟩)
      rw [if_neg hnm]
      have hs : s.stamps q = none := by
        cases h : s.stamps q with
        | none => rfl
        | some w => obtain ⟨w', hw', _⟩ := grown q w h; rw [hn] at hw'; cases hw'
      have hf' : s.files q = none := by
        simp only [bump] at hf
        rw [if_neg (fun h => hnm (hfs q h)), if_neg hnm] at hf; exact hf
      exact hi.lastOwn q hq hs hf'
  · -- rootUnstamped
    rw [hst]; simp only [bumped]
    have h1 : ¬ paths.any (fun p => decide (Under [] p.dropLast)) = true := by
      intro h; obtain ⟨p, _, hu⟩ := List.any_eq_true.mp h
      exact (of_decide_eq_true hu).1 rfl
    have h2 : ¬ (s.stamps []).isSome = true := by rw [hi.rootUnstamped]; simp
    rw [if_neg (fun h => h.elim h1 (fun h' => h2 h'.2))]; exact hi.rootUnstamped
  · -- lastClock
    intro q
    show (if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q) ≤ s.clock + 1
    split
    · exact Nat.le_refl _
    · have := hi.lastClock q; omega
  · -- fileClock
    intro q g hq
    show g ≤ s.clock + 1
    simp only [bump] at hq
    split at hq
    · injection hq with hq; omega
    · split at hq
      · cases hq
      · have := hi.fileClock q g hq; omega
  · -- ownClock
    intro q
    show (if q ∈ paths then s.clock + 1 else s.own q) ≤ s.clock + 1
    split
    · exact Nat.le_refl _
    · have := hi.ownClock q; omega
  · -- fileLast
    intro q g hq
    rw [hlast]
    simp only [bump] at hq
    split at hq
    · injection hq with hq; subst hq
      split
      · exact Nat.le_refl _
      · have := hi.lastClock q; omega
    · rename_i hnf
      split at hq
      · cases hq
      · rename_i hnp
        split
        · rename_i h
          obtain ⟨p, hp, hu⟩ := List.any_eq_true.mp h
          have hne : q ≠ p := fun e => hnp (e ▸ hp)
          rw [hnest p hp q (of_decide_eq_true hu) hne] at hq; cases hq
        · exact hi.fileLast q g hq
  · -- fileUnder
    intro q g hq a ha hne
    simp only [bump] at hq
    split at hq
    · rename_i hf
      injection hq with hq; subst hq
      exact Or.inl ⟨_, above q (hfs q hf) a ha hne, Nat.le_refl _⟩
    · split at hq
      · cases hq
      · rcases hi.fileUnder q g hq a ha hne with ⟨w, hw, hgw⟩ | h
        · obtain ⟨w', hw', hww⟩ := grown a w hw
          exact Or.inl ⟨w', hw', Nat.le_trans hgw hww⟩
        · exact Or.inr h
  · -- ownUnder
    intro q hq a ha hne
    show (∃ w, (bump s paths fs).stamps a = some w ∧ (if q ∈ paths then s.clock + 1 else s.own q) ≤ w)
      ∨ (if q ∈ paths then s.clock + 1 else s.own q) ≤ s.floor
    split
    · rename_i hm
      exact Or.inl ⟨_, above q hm a ha hne, Nat.le_refl _⟩
    · rename_i hnm
      have hf : s.files q = none := by
        simp only [bump] at hq
        rw [if_neg (fun h => hnm (hfs q h)), if_neg hnm] at hq; exact hq
      rcases hi.ownUnder q hf a ha hne with ⟨w, hw, hgw⟩ | h
      · obtain ⟨w', hw', hww⟩ := grown a w hw
        exact Or.inl ⟨w', hw', Nat.le_trans hgw hww⟩
      · exact Or.inr h

theorem drop_inv {s : St} (hi : Inv s) {cutoff : Nat} (hc : cutoff ≤ s.clock) :
    Inv (drop s cutoff) := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, hi.lastClock, hi.fileClock, hi.ownClock, hi.fileLast, ?_, ?_⟩
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
  · intro q hq hn hf
    show s.last q ≤ max (max s.floor cutoff) (s.own q)
    simp only [drop] at hn
    split at hn
    · rename_i v' hv'
      split at hn
      · rename_i hle; have := hi.lastStamped q v' hv'; omega
      · cases hn
    · rename_i hv'; have := hi.lastOwn q hq hv' hf; omega
  · simp only [drop]; rw [hi.rootUnstamped]
  · intro q g hq a ha hne
    show (∃ w, (match s.stamps a with | some v => if v ≤ cutoff then none else some v | none => none) = some w
      ∧ g ≤ w) ∨ g ≤ max s.floor cutoff
    rcases hi.fileUnder q g hq a ha hne with ⟨w, hw, hgw⟩ | h
    · rw [hw]; simp only
      split
      · right; omega
      · left; exact ⟨w, rfl, hgw⟩
    · right; omega
  · intro q hq a ha hne
    show (∃ w, (match s.stamps a with | some v => if v ≤ cutoff then none else some v | none => none) = some w
      ∧ s.own q ≤ w) ∨ s.own q ≤ max s.floor cutoff
    rcases hi.ownUnder q hq a ha hne with ⟨w, hw, hgw⟩ | h
    · rw [hw]; simp only
      split
      · right; omega
      · left; exact ⟨w, rfl, hgw⟩
    · right; omega

theorem forget_inv {s : St} (hi : Inv s) (gone : Path → Bool) : Inv (forget s gone) := by
  refine ⟨hi.closed, hi.aboveFloor, hi.belowClock, hi.floorLe, hi.lastStamped, ?_, hi.rootUnstamped,
    hi.lastClock, hi.fileClock, ?_, hi.fileLast, hi.fileUnder, ?_⟩
  · intro q hq hn hf
    have := hi.lastOwn q hq hn hf
    show s.last q ≤ max s.floor (if gone q = true ∧ s.own q ≤ s.floor then 0 else s.own q)
    split
    · rename_i h; omega
    · exact this
  · intro q
    show (if gone q = true ∧ s.own q ≤ s.floor then 0 else s.own q) ≤ s.clock
    split
    · omega
    · exact hi.ownClock q
  · intro q hq a ha hne
    show (∃ w, s.stamps a = some w ∧ (if gone q = true ∧ s.own q ≤ s.floor then 0 else s.own q) ≤ w)
      ∨ (if gone q = true ∧ s.own q ≤ s.floor then 0 else s.own q) ≤ s.floor
    split
    · right; omega
    · exact hi.ownUnder q hq a ha hne

theorem step_inv {s s' : St} (hi : Inv s) (h : Step s s') : Inv s' := by
  cases h with
  | bump paths fs h1 h2 => exact bump_inv hi paths fs h1 h2
  | drop c hc => exact drop_inv hi hc
  | forget gone => exact forget_inv hi gone

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
  | some v => exact hi.lastStamped p v hq
  | none =>
    simp only
    cases hf : s.files p with
    | some g => have := hi.fileLast p g hf; have := hi.fileClock p g hf; simp only; omega
    | none =>
      simp only
      have := hi.lastOwn p hp hq hf; have := hi.ownClock p; omega

/-- No path reports above the clock. -/
theorem revision_le_clock {s : St} (h : Reachable s) (p : Path) : revision s p ≤ s.clock := by
  have hi := reachable_inv h
  unfold revision
  split
  · exact Nat.le_refl _
  · cases hq : s.stamps p with
    | some v => exact hi.belowClock p v hq
    | none =>
      simp only
      cases hf : s.files p with
      | some g => simp only; omega
      | none => simp only; have := hi.floorLe; omega

/-- A directory reports at or above every path under it. -/
theorem revision_watermark {s : St} (h : Reachable s) {a q : Path} (hu : Under a q)
    (ha : s.files a = none) : revision s q ≤ revision s a := by
  have hi := reachable_inv h
  by_cases e : a = q
  · subst e; exact Nat.le_refl _
  unfold revision
  rw [if_neg (under_ne_nil hu), if_neg hu.1]
  -- What `a` reports is at least the floor.
  have hfl : s.floor ≤ (match s.stamps a with
      | some v => v
      | none => match s.files a with | some g => min g s.clock | none => max s.floor (min (s.own a) s.clock)) := by
    cases hsa : s.stamps a with
    | some w => have := hi.aboveFloor a w hsa; simp only; omega
    | none => simp only [ha]; exact Nat.le_max_left _ _
  cases hq : s.stamps q with
  | some v =>
    obtain ⟨w, hw, hvw⟩ := hi.closed q a v hq hu
    rw [hw]; exact hvw
  | none =>
    simp only
    cases hf : s.files q with
    | some g =>
      simp only
      rcases hi.fileUnder q g hf a hu e with ⟨w, hw, hgw⟩ | hg
      · rw [hw]; simp only; omega
      · have := hfl; omega
    | none =>
      simp only
      rcases hi.ownUnder q hf a hu e with ⟨w, hw, hgw⟩ | hg
      · have := hi.aboveFloor a w hw
        rw [hw]; simp only; omega
      · have := hfl; have := hi.floorLe; omega

theorem last_step {s s' : St} (h : Reachable s) (hs : Step s s') (q : Path) :
    s.last q ≤ s'.last q ∧ s.clock ≤ s'.clock := by
  have hi := reachable_inv h
  cases hs with
  | bump paths fs _ _ =>
    have := hi.lastClock q
    refine ⟨?_, show s.clock ≤ s.clock + 1 by omega⟩
    show s.last q ≤ (if paths.any (fun p => decide (Under q p)) then s.clock + 1 else s.last q)
    split <;> omega
  | drop c _ => exact ⟨Nat.le_refl _, Nat.le_refl _⟩
  | forget _ => exact ⟨Nat.le_refl _, Nat.le_refl _⟩

/-- Any number of steps. -/
inductive Steps : St → St → Prop
  | refl (s : St) : Steps s s
  | tail {s t u : St} : Steps s t → Step t u → Steps s u

theorem steps_facts {s t : St} (h : Reachable s) (hs : Steps s t) :
    Reachable t ∧ (∀ q, s.last q ≤ t.last q) ∧ s.clock ≤ t.clock := by
  induction hs with
  | refl => exact ⟨h, fun _ => Nat.le_refl _, Nat.le_refl _⟩
  | tail _ hst ih =>
    obtain ⟨ht, hl, hc⟩ := ih
    refine ⟨.step ht hst, fun q => Nat.le_trans (hl q) (last_step ht hst q).1, ?_⟩
    exact Nat.le_trans hc (last_step ht hst (default : Path)).2

/-- Every report of `p` made before a mutation of `p` (or of anything under it)
    is below every report of `p` made after it: what a reader that keeps a row
    only while its revision is at or above every report for the path relies on. -/
theorem revision_increases_across_mutation {s s1 s' : St} (h : Reachable s) (h1 : Steps s s1)
    {paths fs : List Path} (hfs : ∀ f ∈ fs, f ∈ paths)
    (hnest : ∀ p ∈ paths, ∀ a, Under a p → a ≠ p → s1.files a = none)
    {p : Path} (hp : paths.any (fun x => decide (Under p x)) = true) (h2 : Steps (bump s1 paths fs) s') :
    revision s p < revision s' p := by
  obtain ⟨hr1, _, hc1⟩ := steps_facts h h1
  have hb : Reachable (bump s1 paths fs) := .step hr1 (.bump s1 paths fs hfs hnest)
  obtain ⟨hr', hl', _⟩ := steps_facts hb h2
  have hpn : p ≠ [] := by
    intro e; subst e; obtain ⟨x, _, hu⟩ := List.any_eq_true.mp hp; exact (of_decide_eq_true hu).1 rfl
  have e1 := revision_le_clock h p
  have e2 : (bump s1 paths fs).last p = s1.clock + 1 := by simp only [bump, hp, if_true]
  have e3 := hl' p
  have e4 := revision_ge_last hr' p hpn
  omega

/-- The floor only rises. -/
theorem floor_monotone {s s' : St} (hs : Step s s') : s.floor ≤ s'.floor := by
  cases hs with
  | bump _ _ _ _ => exact Nat.le_refl _
  | drop c _ => show s.floor ≤ max s.floor c; omega
  | forget _ => exact Nat.le_refl _

/-! ## The known bug: an unheld path reporting 0

Before `d35e88c6` a path without an entry reported 0 rather than the floor
(`resident-revision-floor.mjs` turns red with the floor replaced by 0). Here that
report is `revisionZero`, and a write under a directory and a drop of the
directory's stamp take it below the directory's last write. -/

def revisionZero (s : St) (p : Path) : Nat :=
  if p = [] then s.clock else (s.stamps p).getD 0

theorem a_zero_floor_reports_below_the_last_write :
    ∃ s, Reachable s ∧ revisionZero s ["a"] < s.last ["a"] := by
  let s1 := bump init [["a", "x"]] [["a", "x"]]
  let s2 := drop s1 1
  have hc : Closed 1 init.stamps := by intro q hq; simp [init] at hq
  have hst : s1.stamps = bumped 1 init.stamps [["a", "x"]] :=
    walkAll_eq 1 [["a", "x"]] ⟨init.stamps⟩ hc
  have hnest : ∀ p ∈ [["a", "x"]], ∀ a, Under a p → a ≠ p → init.files a = none := by
    intros; rfl
  refine ⟨s2, .step (.step .init (.bump init [["a", "x"]] [["a", "x"]] (by simp) hnest)) (.drop s1 1 (by decide)), ?_⟩
  have h1 : s1.stamps ["a"] = some 1 := by rw [hst]; decide
  show (if ["a"] = ([] : Path) then s2.clock else (s2.stamps ["a"]).getD 0) < s2.last ["a"]
  simp only [s2, drop, h1]
  decide

end Nimbus.Vfs.RevisionFloor
