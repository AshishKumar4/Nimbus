/-
  Nimbus.Vfs.RevisionFloor — `SqliteVFS` per-path revisions under a byte budget
  (`packages/core/src/vfs/path-revisions.ts`: `PathRevisions.stamp`,
  `dropThrough` and `report`; `packages/core/src/vfs/sqlite-vfs.ts`:
  `bumpRevision`, `pruneTombstones`, `pathRevision`, `revision`).

  Only directories hold stamps. A bump stamps every directory strictly above a
  mutated path, and a mutated path only if it holds a stamp already: the
  transaction that mutated a path wrote its generation to SQLite, a live
  file's row (`files`) or, for anything else, a directory's row or a removed
  path's tombstone (`own`). So a file written or removed costs no memory. A
  path reports its stamp; else, for a live file, `min(row.gen, clock)` (P5,
  6cf3bddd); else `max(floor, min(own, clock))`.

  A bump is one operation, of one transaction or several: it publishes at
  revision `rev`, past the clock, and each path it names holds the generation
  of the transaction that last wrote it, `gen p`, in `(clock, rev]`. So a
  rename (the destination in the first transaction, the source's tombstone in
  the second) and an embedder's `withTransaction` of several operations are
  single bumps, and so is a revision that jumps.

  A path is its list of components; `[]` is the root, whose revision is the
  global clock. `walk` is the code's walk from the directory of a mutated path
  up, including its early exit at a directory this bump already stamped.
  `drop` removes every stamp at or below a cutoff and raises the floor to it;
  the code picks the cutoff from the budget or from the tombstones it prunes,
  and every theorem here holds for any cutoff not above the clock. `forget` is
  what the prune then loses: any generation at or below the floor.

  `last p` is ghost state: the newest mutation at or under `p`, which for a
  directory above a mutated path is the bump's revision. A bump writes the
  rows of the files it names, every other path it names stops being a file,
  and every path it names gets its own generation. A bump never names a path
  below a file, and names no file above another path it names.

  The theorems: a path never reports below `last p` nor above the clock; a
  directory reports at or above everything under it; so every report of a path
  made before a mutation of it is below every report made after
  (`revision_increases_across_mutation`). And what the invalidation log names
  a path at, `logRev` (the code's `bumpRevision`), is what the path reports
  after the bump and the drops it triggers (`log_eq_revision`,
  `parent_log_eq_revision`): a reader that dates what it holds by the log
  fetches at the path's revision. In the code a single report may fall (a
  file holding a directory's old stamp, dropped to its row's generation), so
  no theorem claims it never does.
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

/-- `q` is a directory strictly above a path of `paths`. -/
def above (paths : List Path) (q : Path) : Bool := paths.any fun p => decide (Under q p.dropLast)

/-- One operation publishing `paths` at `rev`: the clock moves to `rev` and
    every directory above a path is stamped at it; each path's row (the files
    `fs`) or own generation is `gen p`, every other named path stops being a
    file. -/
@[noinline] def bump (s : St) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) : St :=
  { clock := rev
    stamps := (walkAll rev ⟨s.stamps⟩ paths).get
    floor := s.floor
    last := fun q => if above paths q then rev else if q ∈ paths then gen q else s.last q
    files := fun q => if q ∈ fs then some (gen q) else if q ∈ paths then none else s.files q
    own := fun q => if q ∈ paths then gen q else s.own q }

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

/-- What a bump may be: past the clock, each path at a generation in
    `(clock, rev]`, its files among its paths, no path named below a file, and
    no file named above another path. -/
structure BumpOk (s : St) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) : Prop where
  past : s.clock < rev
  gens : ∀ p ∈ paths, s.clock < gen p ∧ gen p ≤ rev
  sub : ∀ f ∈ fs, f ∈ paths
  nest : ∀ p ∈ paths, ∀ a, Under a p → a ≠ p → s.files a = none
  leaf : ∀ f ∈ fs, ∀ p ∈ paths, Under f p → f = p

inductive Step : St → St → Prop
  | bump (s : St) (paths fs : List Path) (gen : Path → Nat) (rev : Nat) :
      BumpOk s paths fs gen rev → Step s (bump s paths fs gen rev)
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

/-- `above` is "strictly above a named path". -/
theorem above_iff {paths : List Path} {q : Path} :
    above paths q = true ↔ ∃ p ∈ paths, Under q p ∧ q ≠ p := by
  unfold above
  constructor
  · intro h
    obtain ⟨p, hp, hu⟩ := List.any_eq_true.mp h
    have hu := of_decide_eq_true hu
    exact ⟨p, hp, under_dropLast hu, fun e => by subst e; exact not_under_dropLast _ hu⟩
  · rintro ⟨p, hp, hu, hne⟩
    rcases under_cases hu with e | h
    · exact absurd e hne
    · exact List.any_eq_true.mpr ⟨p, hp, decide_eq_true h⟩

theorem bump_stamps {s : St} (hi : Inv s) {paths fs : List Path} {gen : Path → Nat} {rev : Nat}
    (ok : BumpOk s paths fs gen rev) :
    (bump s paths fs gen rev).stamps = bumped rev s.stamps paths :=
  walkAll_eq _ paths ⟨s.stamps⟩ (by intro q hq; have := hi.belowClock q _ hq; have := ok.past; omega)

/-- A directory strictly above a named path is stamped at the revision. -/
theorem bump_stamps_above {s : St} (hi : Inv s) {paths fs : List Path} {gen : Path → Nat} {rev : Nat}
    (ok : BumpOk s paths fs gen rev) {q : Path} (h : above paths q = true) :
    (bump s paths fs gen rev).stamps q = some rev := by
  rw [bump_stamps hi ok]; simp only [bumped]; exact if_pos (Or.inl h)

theorem bump_inv {s : St} (hi : Inv s) {paths fs : List Path} {gen : Path → Nat} {rev : Nat}
    (ok : BumpOk s paths fs gen rev) : Inv (bump s paths fs gen rev) := by
  have hst := bump_stamps hi ok
  have stampedAbove : ∀ q, above paths q = true → (bump s paths fs gen rev).stamps q = some rev :=
    fun _ h => bump_stamps_above hi ok h
  -- A named path that held a stamp moves to the revision.
  have stampedNamed : ∀ q v, q ∈ paths → s.stamps q = some v → (bump s paths fs gen rev).stamps q = some rev := by
    intro q v hm hv
    rw [hst]; simp only [bumped]; rw [if_pos (Or.inr ⟨hm, by simp [hv]⟩)]
  -- Every stamp the bump leaves is the revision or one it found.
  have kept : ∀ q v, (bump s paths fs gen rev).stamps q = some v → v = rev ∨ s.stamps q = some v := by
    intro q v hq
    rw [hst] at hq; simp only [bumped] at hq
    split at hq
    · injection hq with hq; exact Or.inl hq.symm
    · exact Or.inr hq
  -- A stamp the bump found survives, at the revision or its own.
  have grown : ∀ q w, s.stamps q = some w → ∃ w', (bump s paths fs gen rev).stamps q = some w' ∧ w ≤ w' := by
    intro q w hq
    rw [hst]; simp only [bumped]
    split
    · refine ⟨_, rfl, ?_⟩; have := hi.belowClock q w hq; have := ok.past; omega
    · exact ⟨w, hq, Nat.le_refl _⟩
  have lastLe : ∀ q, (bump s paths fs gen rev).last q ≤ rev := by
    intro q
    show (if above paths q then rev else if q ∈ paths then gen q else s.last q) ≤ rev
    split
    · exact Nat.le_refl _
    · split
      · rename_i hm; exact (ok.gens q hm).2
      · have := hi.lastClock q; have := ok.past; omega
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, lastLe, ?_, ?_, ?_, ?_, ?_⟩
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
          have : (bumped rev s.stamps paths a) = some rev := by
            simp only [bumped]; rw [if_pos (Or.inr ⟨hmem, by assumption⟩)]
          simp only [bumped] at this; rw [this]; exact ⟨_, rfl, Nat.le_refl _⟩
        · rw [if_pos (Or.inl (List.any_eq_true.mpr ⟨q, hmem, decide_eq_true h'⟩))]
          exact ⟨_, rfl, Nat.le_refl _⟩
    · obtain ⟨w, hw, hvw⟩ := hi.closed q a v hq ha
      split
      · refine ⟨_, rfl, ?_⟩; have := hi.belowClock a w hw; have := ok.past; omega
      · exact ⟨w, hw, hvw⟩
  · -- aboveFloor
    intro q v hq
    show s.floor < v
    rcases kept q v hq with e | h
    · have := hi.floorLe; have := ok.past; omega
    · exact hi.aboveFloor q v h
  · -- belowClock
    intro q v hq
    show v ≤ rev
    rcases kept q v hq with e | h
    · omega
    · have := hi.belowClock q v h; have := ok.past; omega
  · show s.floor ≤ rev; have := hi.floorLe; have := ok.past; omega
  · -- lastStamped
    intro q v hq
    rcases kept q v hq with e | h
    · rw [e]; exact lastLe q
    · by_cases ha : above paths q = true
      · rw [stampedAbove q ha] at hq; injection hq with hq; rw [← hq]; exact lastLe q
      · by_cases hm : q ∈ paths
        · rw [stampedNamed q v hm h] at hq; injection hq with hq; rw [← hq]; exact lastLe q
        · show (if above paths q then rev else if q ∈ paths then gen q else s.last q) ≤ v
          rw [if_neg ha, if_neg hm]; exact hi.lastStamped q v h
  · -- lastOwn
    intro q hq hn hf
    show (if above paths q then rev else if q ∈ paths then gen q else s.last q)
      ≤ max s.floor (if q ∈ paths then gen q else s.own q)
    by_cases ha : above paths q = true
    · rw [stampedAbove q ha] at hn; cases hn
    · rw [if_neg ha]
      by_cases hm : q ∈ paths
      · rw [if_pos hm, if_pos hm]; exact Nat.le_max_right _ _
      · rw [if_neg hm, if_neg hm]
        have hs : s.stamps q = none := by
          cases h : s.stamps q with
          | none => rfl
          | some w => obtain ⟨w', hw', _⟩ := grown q w h; rw [hn] at hw'; cases hw'
        have hf' : s.files q = none := by
          have : (bump s paths fs gen rev).files q = s.files q := by
            show (if q ∈ fs then some (gen q) else if q ∈ paths then none else s.files q) = s.files q
            rw [if_neg (fun h => hm (ok.sub q h)), if_neg hm]
          rw [← this]; exact hf
        exact hi.lastOwn q hq hs hf'
  · -- rootUnstamped
    rw [hst]; simp only [bumped]
    have h1 : ¬ paths.any (fun p => decide (Under [] p.dropLast)) = true := by
      intro h; obtain ⟨p, _, hu⟩ := List.any_eq_true.mp h
      exact (of_decide_eq_true hu).1 rfl
    have h2 : ¬ (s.stamps []).isSome = true := by rw [hi.rootUnstamped]; simp
    rw [if_neg (fun h => h.elim h1 (fun h' => h2 h'.2))]; exact hi.rootUnstamped
  · -- fileClock
    intro q g hq
    show g ≤ rev
    simp only [bump] at hq
    split at hq
    · rename_i hf; injection hq with hq; rw [← hq]; exact (ok.gens q (ok.sub q hf)).2
    · split at hq
      · cases hq
      · have := hi.fileClock q g hq; have := ok.past; omega
  · -- ownClock
    intro q
    show (if q ∈ paths then gen q else s.own q) ≤ rev
    split
    · rename_i hm; exact (ok.gens q hm).2
    · have := hi.ownClock q; have := ok.past; omega
  · -- fileLast
    intro q g hq
    show (if above paths q then rev else if q ∈ paths then gen q else s.last q) ≤ g
    simp only [bump] at hq
    split at hq
    · rename_i hf
      injection hq with hq
      have hna : ¬ above paths q = true := by
        intro h
        obtain ⟨p, hp, hu, hne⟩ := above_iff.mp h
        exact hne (ok.leaf q hf p hp hu)
      rw [if_neg hna, if_pos (ok.sub q hf)]; exact Nat.le_of_eq hq
    · split at hq
      · cases hq
      · rename_i hnp
        have hna : ¬ above paths q = true := by
          intro h
          obtain ⟨p, hp, hu, hne⟩ := above_iff.mp h
          rw [ok.nest p hp q hu hne] at hq; cases hq
        rw [if_neg hna, if_neg hnp]; exact hi.fileLast q g hq
  · -- fileUnder
    intro q g hq a ha hne
    simp only [bump] at hq
    split at hq
    · rename_i hf
      injection hq with hq
      refine Or.inl ⟨_, stampedAbove a (above_iff.mpr ⟨q, ok.sub q hf, ha, hne⟩), ?_⟩
      rw [← hq]; exact (ok.gens q (ok.sub q hf)).2
    · split at hq
      · cases hq
      · rcases hi.fileUnder q g hq a ha hne with ⟨w, hw, hgw⟩ | h
        · obtain ⟨w', hw', hww⟩ := grown a w hw
          exact Or.inl ⟨w', hw', Nat.le_trans hgw hww⟩
        · exact Or.inr h
  · -- ownUnder
    intro q hq a ha hne
    show (∃ w, (bump s paths fs gen rev).stamps a = some w ∧ (if q ∈ paths then gen q else s.own q) ≤ w)
      ∨ (if q ∈ paths then gen q else s.own q) ≤ s.floor
    split
    · rename_i hm
      exact Or.inl ⟨_, stampedAbove a (above_iff.mpr ⟨q, hm, ha, hne⟩), (ok.gens q hm).2⟩
    · rename_i hnm
      have hf : s.files q = none := by
        simp only [bump] at hq
        rw [if_neg (fun h => hnm (ok.sub q h)), if_neg hnm] at hq; exact hq
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
  | bump paths fs gen rev ok => exact bump_inv hi ok
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
  | bump paths fs gen rev ok =>
    have := hi.lastClock q
    have := ok.past
    refine ⟨?_, Nat.le_of_lt ok.past⟩
    show s.last q ≤ (if above paths q then rev else if q ∈ paths then gen q else s.last q)
    split
    · omega
    · split
      · rename_i hm; have := (ok.gens q hm).1; omega
      · exact Nat.le_refl _
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
    {paths fs : List Path} {gen : Path → Nat} {rev : Nat} (ok : BumpOk s1 paths fs gen rev)
    {p : Path} (hp : paths.any (fun x => decide (Under p x)) = true)
    (h2 : Steps (bump s1 paths fs gen rev) s') :
    revision s p < revision s' p := by
  obtain ⟨hr1, _, hc1⟩ := steps_facts h h1
  have hb : Reachable (bump s1 paths fs gen rev) := .step hr1 (.bump s1 paths fs gen rev ok)
  obtain ⟨hr', hl', _⟩ := steps_facts hb h2
  obtain ⟨x, hx, hu⟩ := List.any_eq_true.mp hp
  have hu := of_decide_eq_true hu
  have e1 := revision_le_clock h p
  have e2 : s1.clock < (bump s1 paths fs gen rev).last p := by
    show s1.clock < (if above paths p then rev else if p ∈ paths then gen p else s1.last p)
    split
    · exact ok.past
    · rename_i hna
      rcases under_cases hu with e | h'
      · subst e; rw [if_pos hx]; exact (ok.gens _ hx).1
      · exact absurd (above_iff.mpr ⟨x, hx, under_dropLast h', fun e => by subst e; exact not_under_dropLast _ h'⟩) hna
  have e3 := hl' p
  have e4 := revision_ge_last hr' p hu.1
  omega

/-- The floor only rises. -/
theorem floor_monotone {s s' : St} (hs : Step s s') : s.floor ≤ s'.floor := by
  cases hs with
  | bump _ _ _ _ _ => exact Nat.le_refl _
  | drop c _ => show s.floor ≤ max s.floor c; omega
  | forget _ => exact Nat.le_refl _

/-! ## The log names what a path reports

`bumpRevision` logs each path a bump named at `logRev`, read after the drops the
bump's budget triggers, and each named path's directory at the revision. A
reader that dates what it holds by the log and fetches with that as its
expected revision compares it with `revision`: the two are equal. -/

/-- What `bumpRevision` logs for a path the bump named: its stamp, else its
    row's generation for a file, else the later of the floor and its own
    generation. -/
def logRev (t : St) (fs : List Path) (gen : Path → Nat) (p : Path) : Nat :=
  match t.stamps p with
  | some v => v
  | none => if p ∈ fs then gen p else max t.floor (gen p)

/-- Drops only: what the stamp budget does right after a bump. -/
inductive Drops (s : St) : St → Prop
  | refl : Drops s s
  | drop (t : St) (c : Nat) : Drops s t → c ≤ t.clock → Drops s (drop t c)

theorem drops_reachable {s t : St} (hr : Reachable s) (h : Drops s t) : Reachable t := by
  induction h with
  | refl => exact hr
  | drop t c _ hc ih => exact .step ih (.drop t c hc)

theorem drops_trans {a b c : St} (h1 : Drops a b) (h2 : Drops b c) : Drops a c := by
  induction h2 with
  | refl => exact h1
  | drop t k _ hk ih => exact .drop t k ih hk

theorem drops_facts {s t : St} (h : Drops s t) :
    t.files = s.files ∧ t.own = s.own ∧ t.clock = s.clock
      ∧ (∀ q v, t.stamps q = some v → s.stamps q = some v)
      ∧ (∀ q v, s.stamps q = some v → t.stamps q = some v ∨ v ≤ t.floor) := by
  induction h with
  | refl => exact ⟨rfl, rfl, rfl, fun _ _ h => h, fun _ _ h => Or.inl h⟩
  | drop t c _ _ ih =>
    obtain ⟨hf, ho, hcl, hsub, hkeep⟩ := ih
    refine ⟨hf, ho, hcl, ?_, ?_⟩
    · intro q v hq
      simp only [drop] at hq
      split at hq
      · rename_i v' hv'
        split at hq
        · cases hq
        · injection hq with hq; rw [← hq]; exact hsub q v' hv'
      · cases hq
    · intro q v hq
      show (match t.stamps q with | some v => if v ≤ c then none else some v | none => none) = some v
        ∨ v ≤ max t.floor c
      rcases hkeep q v hq with h | h
      · rw [h]; simp only
        split
        · right; omega
        · left; rfl
      · right; omega

/-- A path the bump named reports what the log names it at. -/
theorem log_eq_revision {s t : St} {paths fs : List Path} {gen : Path → Nat} {rev : Nat}
    (ok : BumpOk s paths fs gen rev) (ht : Drops (bump s paths fs gen rev) t)
    {p : Path} (hp : p ∈ paths) (hne : p ≠ []) : logRev t fs gen p = revision t p := by
  obtain ⟨hf, ho, hcl, _, _⟩ := drops_facts ht
  have hle : gen p ≤ t.clock := by rw [hcl]; exact (ok.gens p hp).2
  have hfp : t.files p = if p ∈ fs then some (gen p) else none := by
    rw [hf]
    show (if p ∈ fs then some (gen p) else if p ∈ paths then none else s.files p) = _
    by_cases hfs : p ∈ fs <;> simp [hfs, hp]
  have hop : t.own p = gen p := by
    rw [ho]
    show (if p ∈ paths then gen p else s.own p) = gen p
    rw [if_pos hp]
  unfold logRev revision
  rw [if_neg hne]
  cases hs : t.stamps p with
  | some v => rfl
  | none =>
    simp only
    rw [hfp, hop]
    by_cases hfs : p ∈ fs
    · rw [if_pos hfs, if_pos hfs]; simp only; omega
    · rw [if_neg hfs, if_neg hfs]; simp only; omega

/-- The directory of a path the bump named reports the revision, which is what
    the log names it at. -/
theorem parent_log_eq_revision {s t : St} (hr : Reachable s) {paths fs : List Path} {gen : Path → Nat}
    {rev : Nat} (ok : BumpOk s paths fs gen rev) (ht : Drops (bump s paths fs gen rev) t)
    {a : Path} (ha : above paths a = true) : revision t a = rev := by
  have hb := bump_stamps_above (reachable_inv hr) ok ha
  have hit := reachable_inv (drops_reachable (.step hr (.bump s paths fs gen rev ok)) ht)
  obtain ⟨hf, _, hcl, hsub, hkeep⟩ := drops_facts ht
  obtain ⟨p, hp, hu, hne⟩ := above_iff.mp ha
  have hfa : t.files a = none := by
    rw [hf]
    show (if a ∈ fs then some (gen a) else if a ∈ paths then none else s.files a) = none
    rw [if_neg (fun h => hne (ok.leaf a h p hp hu))]
    split
    · rfl
    · exact ok.nest p hp a hu hne
  have hclock : t.clock = rev := hcl
  unfold revision
  rw [if_neg hu.1]
  cases hs : t.stamps a with
  | some v =>
    have := hsub a v hs
    rw [hb] at this; injection this with this; exact this.symm
  | none =>
    simp only [hfa]
    rcases hkeep a rev hb with h | h
    · rw [hs] at h; cases h
    · have := hit.floorLe; omega

/-! ## The known bug: an unheld path reporting 0

Before `d35e88c6` a path without an entry reported 0 rather than the floor
(`resident-revision-floor.mjs` turns red with the floor replaced by 0). Here that
report is `revisionZero`, and a write under a directory and a drop of the
directory's stamp take it below the directory's last write. -/

def revisionZero (s : St) (p : Path) : Nat :=
  if p = [] then s.clock else (s.stamps p).getD 0

theorem a_zero_floor_reports_below_the_last_write :
    ∃ s, Reachable s ∧ revisionZero s ["a"] < s.last ["a"] := by
  let s1 := bump init [["a", "x"]] [["a", "x"]] (fun _ => 1) 1
  let s2 := drop s1 1
  have hc : Closed 1 init.stamps := by intro q hq; simp [init] at hq
  have hst : s1.stamps = bumped 1 init.stamps [["a", "x"]] :=
    walkAll_eq 1 [["a", "x"]] ⟨init.stamps⟩ hc
  have ok : BumpOk init [["a", "x"]] [["a", "x"]] (fun _ => 1) 1 :=
    ⟨by simp [init], by intro p _; simp [init], by simp, by intros; rfl,
     by intro f hf p hp _; simp at hf hp; rw [hf, hp]⟩
  refine ⟨s2, .step (.step .init (.bump init [["a", "x"]] [["a", "x"]] (fun _ => 1) 1 ok)) (.drop s1 1 (by decide)), ?_⟩
  have h1 : s1.stamps ["a"] = some 1 := by rw [hst]; decide
  show (if ["a"] = ([] : Path) then s2.clock else (s2.stamps ["a"]).getD 0) < s2.last ["a"]
  simp only [s2, drop, h1]
  decide

end Nimbus.Vfs.RevisionFloor
