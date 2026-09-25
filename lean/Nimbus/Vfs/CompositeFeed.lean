/-
  Nimbus.Vfs.CompositeFeed — the composite's change feed for a node facet's staged
  namespace (ProcessFs over `CompositeVFS`; the review's P2 repro: SQLite holds
  `/pc/shadowed` under a live `/pc` mount, `readdir('/pc')` is `[]`, the root feed
  still names it).

  A principal's mount table is a list of live points with, per point, whether its
  backend offers `changes`. The staged view of a world is what the facet may hold:
  a live mount point and each ancestor of one is a directory; a path under a mount
  with `changes` is that backend's entry at the relative path; a path strictly under
  a mount without `changes` is not staged (never_cached); any other path is the root
  backend's.

  (1) `feed_exact`: with the table unchanged over the window, the root feed filtered
      to paths the composite routes to the root backend (not under a live mount,
      not a mount point or synthesized ancestor), plus each `changes` mount's feed
      re-rooted under its point and filtered to paths the composite routes to that
      mount, applied in any order, turns the staged view at the cursor into the
      staged view at answer time. Unfiltered, the shadowed row is staged
      (`an_unfiltered_root_feed_stages_a_shadowed_row`).
  (2) `step_exact`: a table change (a mount appearing, disappearing, or a
      per-principal source switching between null and live) poisons, and the relist
      yields the new view; the feeds alone would miss it
      (`a_mount_appearing_is_not_in_any_feed`).
  (3) mounts without `changes` contribute no entries and nothing under them is staged.
  (4) CAS: revisions `(epoch, gen)`, a fresh epoch per incarnation, gens increasing
      within one: two writes with one revision are one write (`revision_unique`),
      so a stale expected revision from before a recovery that regressed gens never
      matches a different write; gens alone do (`gen_only_revisions_collide`).
-/

import Nimbus.Coherence.Namespace

namespace Nimbus.Vfs.CompositeFeed

open Nimbus.Coherence.Namespace (Kind Tree Closed applyDelta apply_exact)

abbrev Path := List String

/-! ## The table and the staged view -/

structure Table where
  pts : List Path
  ch : Path → Bool

/-- The longest live mount point that is a prefix of `p`. -/
def ownerPt (pts : List Path) (p : Path) : Option Path :=
  (pts.filter (·.isPrefixOf p)).foldl
    (fun acc m => match acc with
      | none => some m
      | some a => if a.length < m.length then some m else some a) none

theorem ownerPt_mem (pts : List Path) (p : Path) {m : Path} (h : ownerPt pts p = some m) :
    m ∈ pts ∧ m <+: p := by
  unfold ownerPt at h
  suffices ∀ (l : List Path) (acc : Option Path), (∀ a, acc = some a → a ∈ pts ∧ a <+: p) →
      (∀ x ∈ l, x ∈ pts ∧ x <+: p) →
      ∀ m, l.foldl (fun acc m => match acc with
        | none => some m
        | some a => if a.length < m.length then some m else some a) acc = some m → m ∈ pts ∧ m <+: p from
    this _ none (fun _ h => by cases h)
      (fun x hx => ⟨(List.mem_filter.mp hx).1, List.isPrefixOf_iff_prefix.mp (by simpa using (List.mem_filter.mp hx).2)⟩) m h
  intro l
  induction l with
  | nil => intro acc ha _ m h; exact ha m h
  | cons x xs ih =>
    intro acc ha hl m h
    simp only [List.foldl_cons] at h
    apply ih _ _ (fun y hy => hl y (List.mem_cons_of_mem _ hy)) m h
    intro a ha'
    cases acc with
    | none => simp at ha'; subst ha'; exact hl x (List.mem_cons_self _ _)
    | some b =>
      simp only at ha'
      split at ha'
      · injection ha' with e; subst e; exact hl x (List.mem_cons_self _ _)
      · injection ha' with e; subst e; exact ha _ rfl

/-- `p` is a proper ancestor of a live mount point (a synthesized directory). -/
def synthAnc (pts : List Path) (p : Path) : Bool := p != [] && pts.any fun m => p.isPrefixOf m && p != m

structure World where
  root : Tree
  bt : Path → Tree

def view (T : Table) (W : World) (q : Path) : Option Kind :=
  if q = [] then some .dir else
  match ownerPt T.pts q with
  | some m => if q = m then some .dir else if T.ch m then W.bt m (q.drop m.length) else none
  | none => if synthAnc T.pts q then some .dir else W.root q

/-! ## (1) The composite feed -/

/-- The root backend's feed: every changed path at its current entry. -/
def rootFeed (log : List Path) (W1 : World) : List (Path × Option Kind) := log.map fun p => (p, W1.root p)

/-- A mount's feed re-rooted under its point. -/
def mountFeed (m : Path) (log : List Path) (W1 : World) : List (Path × Option Kind) :=
  log.map fun r => (m ++ r, W1.bt m r)

/-- Keep a root entry only where the composite routes to the root backend. -/
def keepRoot (T : Table) (x : Path × Option Kind) : Bool :=
  x.1 != [] && ownerPt T.pts x.1 == none && !synthAnc T.pts x.1

/-- Keep a mount entry only where the composite routes to that mount. -/
def keepMount (T : Table) (m : Path) (x : Path × Option Kind) : Bool :=
  x.1 != m && ownerPt T.pts x.1 == some m

def feed (T : Table) (rlog : List Path) (mlog : Path → List Path) (W1 : World) : List (Path × Option Kind) :=
  (rootFeed rlog W1).filter (keepRoot T) ++
    T.pts.flatMap fun m => if T.ch m then (mountFeed m (mlog m) W1).filter (keepMount T m) else []

/-- The logs are complete for the window. -/
def Complete (W0 W1 : World) (T : Table) (rlog : List Path) (mlog : Path → List Path) : Prop :=
  (∀ p, W0.root p ≠ W1.root p → p ∈ rlog) ∧ (∀ m ∈ T.pts, T.ch m = true → ∀ r, W0.bt m r ≠ W1.bt m r → r ∈ mlog m)

theorem feed_values (T : Table) (rlog : List Path) (mlog : Path → List Path) (W1 : World) :
    ∀ x ∈ feed T rlog mlog W1, x.2 = view T W1 x.1 ∧ x.1 ≠ [] := by
  intro x hx
  rcases List.mem_append.mp hx with hx | hx
  · obtain ⟨hm, hk⟩ := List.mem_filter.mp hx
    obtain ⟨p, _, rfl⟩ := List.mem_map.mp hm
    simp only [keepRoot, Bool.and_eq_true, bne_iff_ne, ne_eq, beq_iff_eq, Bool.not_eq_true'] at hk
    obtain ⟨⟨h0, ho⟩, hs⟩ := hk
    refine ⟨?_, h0⟩
    simp [view, h0, ho, hs]
  · obtain ⟨m, _, hm⟩ := List.mem_flatMap.mp hx
    split at hm
    · rename_i hch
      obtain ⟨hm', hk⟩ := List.mem_filter.mp hm
      obtain ⟨r, _, rfl⟩ := List.mem_map.mp hm'
      simp only [keepMount, Bool.and_eq_true, bne_iff_ne, ne_eq, beq_iff_eq] at hk
      obtain ⟨hne, ho⟩ := hk
      have hr : r ≠ [] := by intro e; subst e; simp at hne
      refine ⟨?_, by simp [hr]⟩
      simp [view, hr, ho, hne, hch]
    · cases hm

/-- (1) The composite feed is exact for the staged view, in any order. -/
theorem feed_exact (T : Table) (W0 W1 : World) (rlog : List Path) (mlog : Path → List Path)
    (hc : Closed (view T W1)) (hcomp : Complete W0 W1 T rlog mlog) :
    applyDelta (view T W0) (feed T rlog mlog W1) = view T W1 := by
  apply apply_exact _ _ hc _ (fun x hx => (feed_values T rlog mlog W1 x hx).1)
    (fun x hx => (feed_values T rlog mlog W1 x hx).2)
  intro q hq
  have hq0 : q ≠ [] := by intro e; subst e; simp [view] at hq
  unfold view at hq
  rw [if_neg hq0, if_neg hq0] at hq
  cases ho : ownerPt T.pts q with
  | some m =>
    rw [ho] at hq
    simp only at hq
    obtain ⟨hmp, hpre⟩ := ownerPt_mem T.pts q ho
    have hqm : q ≠ m := by intro e; subst e; simp at hq
    rw [if_neg hqm, if_neg hqm] at hq
    cases hch : T.ch m
    · simp [hch] at hq
    · rw [if_pos hch, if_pos hch] at hq
      obtain ⟨t, rfl⟩ := hpre
      have ht : (m ++ t).drop m.length = t := by simp
      rw [ht] at hq
      have hr := hcomp.2 m hmp hch t hq
      refine ⟨(m ++ t, W1.bt m t), List.mem_append_right _ (List.mem_flatMap.mpr ⟨m, hmp, ?_⟩), rfl⟩
      rw [if_pos hch]
      refine List.mem_filter.mpr ⟨List.mem_map.mpr ⟨t, hr, rfl⟩, ?_⟩
      simp [keepMount, ho, hqm]
  | none =>
    rw [ho] at hq
    simp only at hq
    cases hs : synthAnc T.pts q
    · simp only [hs, Bool.false_eq_true, if_false] at hq
      have hr := hcomp.1 q hq
      refine ⟨(q, W1.root q), List.mem_append_left _ (List.mem_filter.mpr ⟨List.mem_map.mpr ⟨q, hr, rfl⟩, ?_⟩), rfl⟩
      simp [keepRoot, hq0, ho, hs]
    · simp [hs] at hq

/-- The review's repro: SQLite holds `pc/shadowed` (written in the window) under a
    live `/pc` mount whose backend is empty. The unfiltered root feed stages it;
    the composite shows nothing there. -/
theorem an_unfiltered_root_feed_stages_a_shadowed_row :
    let T : Table := ⟨[["pc"]], fun _ => true⟩
    let W0 : World := ⟨fun _ => none, fun _ _ => none⟩
    let W1 : World := ⟨fun q => if q = ["pc", "shadowed"] then some (.file 1) else none, fun _ _ => none⟩
    applyDelta (view T W0) (rootFeed [["pc", "shadowed"]] W1) ["pc", "shadowed"] = some (.file 1) ∧
      view T W1 ["pc", "shadowed"] = none ∧ feed T [["pc", "shadowed"]] (fun _ => []) W1 = [] := by
  decide

/-! ## (2) Mount-table changes poison -/

def sameTable (T0 T1 : Table) : Prop := T0.pts = T1.pts ∧ ∀ m ∈ T0.pts, T0.ch m = T1.ch m

/-- The facet's step: a table change poisons and relists; otherwise the feed applies. -/
def step (T0 T1 : Table) (changed : Bool) (W0 W1 : World) (rlog : List Path) (mlog : Path → List Path) : Tree :=
  if changed then view T1 W1 else applyDelta (view T0 W0) (feed T1 rlog mlog W1)

theorem view_table_congr {T0 T1 : Table} (h : sameTable T0 T1) (W : World) : view T0 W = view T1 W := by
  funext q
  unfold view
  rw [h.1]
  split
  · rfl
  · split
    · rename_i m hm
      have hmp := (ownerPt_mem T1.pts q hm).1
      rw [← h.1] at hmp
      rw [h.2 m hmp]
    · rfl

/-- Poison exactly when the table changed: the staged namespace is always the
    composite's staged view at answer time. -/
theorem step_exact (T0 T1 : Table) (W0 W1 : World) (rlog : List Path) (mlog : Path → List Path)
    (hc : Closed (view T1 W1)) (hcomp : Complete W0 W1 T1 rlog mlog) (changed : Bool)
    (hpoison : changed = false → sameTable T0 T1) :
    step T0 T1 changed W0 W1 rlog mlog = view T1 W1 := by
  unfold step
  cases changed
  · simp only [Bool.false_eq_true, if_false]
    rw [view_table_congr (hpoison rfl) W0]
    exact feed_exact T1 W0 W1 rlog mlog hc hcomp
  · rfl

/-- A mount appearing over a root directory changes no backend, so no feed names
    anything; without the poison the root's `pc/a` stays staged. -/
theorem a_mount_appearing_is_not_in_any_feed :
    let T0 : Table := ⟨[], fun _ => true⟩
    let T1 : Table := ⟨[["pc"]], fun _ => true⟩
    let W : World := ⟨fun q => if q = ["pc"] then some .dir else if q = ["pc", "a"] then some (.file 1) else none,
      fun _ _ => none⟩
    feed T1 [] (fun _ => []) W = [] ∧ view T0 W ["pc", "a"] = some (.file 1) ∧ view T1 W ["pc", "a"] = none := by
  decide

/-! ## (3) Mounts without `changes` -/

/-- A mount without `changes` contributes no entries, and nothing strictly under
    it is staged. -/
theorem no_changes_never_staged (T : Table) (W : World) (rlog : List Path) (mlog : Path → List Path)
    {m : Path} (hm : T.ch m = false) {q : Path} (ho : ownerPt T.pts q = some m) (hq : q ≠ m) :
    view T W q = none ∧ ∀ x ∈ feed T rlog mlog W, x.1 = q → x.2 = none := by
  have hv : view T W q = none := by
    have hq0 : q ≠ [] := by
      intro e; subst e
      obtain ⟨_, hp⟩ := ownerPt_mem T.pts [] ho
      exact hq (List.prefix_nil.mp hp).symm
    simp [view, hq0, ho, hq, hm]
  refine ⟨hv, fun x hx he => ?_⟩
  rw [(feed_values T rlog mlog W x hx).1, he, hv]

/-! ## (4) Epoch-qualified revisions -/

structure Wr where
  inc : Nat
  gen : Nat
  id : Nat
  deriving DecidableEq

structure Cas where
  inc : Nat
  last : Nat
  hist : List Wr

inductive CasStep : Cas → Cas → Prop
  /-- A write in the current incarnation: its gen exceeds every earlier one of it. -/
  | write (s : Cas) (g : Nat) : s.last < g →
      CasStep s { s with last := g, hist := s.hist ++ [⟨s.inc, g, s.hist.length⟩] }
  /-- Recovery: a new incarnation, gens may regress to anything. -/
  | recover (s : Cas) (g : Nat) : CasStep s { s with inc := s.inc + 1, last := g }

inductive CasReach : Cas → Prop
  | init : CasReach ⟨0, 0, []⟩
  | step {s s' : Cas} : CasReach s → CasStep s s' → CasReach s'

def Before (a b : Wr) : Prop := a.inc < b.inc ∨ (a.inc = b.inc ∧ a.gen < b.gen)

theorem cas_inv {s : Cas} (h : CasReach s) :
    (∀ w ∈ s.hist, w.inc < s.inc ∨ (w.inc = s.inc ∧ w.gen ≤ s.last)) ∧ s.hist.Pairwise Before := by
  induction h with
  | init => exact ⟨(fun _ h => by cases h), List.Pairwise.nil⟩
  | step _ hs ih =>
    obtain ⟨h1, h2⟩ := ih
    cases hs with
    | write g hg =>
      refine ⟨fun w hw => ?_, ?_⟩
      · rcases List.mem_append.mp hw with hw | hw
        · rcases h1 w hw with h | ⟨h, h'⟩
          · exact Or.inl h
          · exact Or.inr ⟨h, by show w.gen ≤ g; omega⟩
        · simp at hw; subst hw; exact Or.inr ⟨rfl, Nat.le_refl _⟩
      · rw [List.pairwise_append]
        refine ⟨h2, List.pairwise_singleton _ _, fun a ha b hb => ?_⟩
        simp at hb; subst hb
        rcases h1 a ha with h | ⟨h, h'⟩
        · exact Or.inl h
        · exact Or.inr ⟨h, show a.gen < g by omega⟩
    | recover g =>
      refine ⟨fun w hw => Or.inl ?_, h2⟩
      rcases h1 w hw with h | ⟨h, _⟩ <;> (show w.inc < _ + 1; omega)

/-- The epoch of an incarnation: injective (a fresh one per recovery). -/
theorem revision_unique (epoch : Nat → String) (hinj : ∀ a b, epoch a = epoch b → a = b) {s : Cas} (h : CasReach s)
    {w1 w2 : Wr} (h1 : w1 ∈ s.hist) (h2 : w2 ∈ s.hist) (he : (epoch w1.inc, w1.gen) = (epoch w2.inc, w2.gen)) :
    w1 = w2 := by
  simp only [Prod.mk.injEq] at he
  have hi := hinj _ _ he.1
  have hg := he.2
  have hp := (cas_inv h).2
  suffices ∀ l : List Wr, l.Pairwise Before → ∀ x ∈ l, ∀ y ∈ l, x.inc = y.inc → x.gen = y.gen → x = y from
    this _ hp w1 h1 w2 h2 hi hg
  intro l
  induction l with
  | nil => intro _ x hx; cases hx
  | cons a t ih =>
    intro hl x hx y hy hxi hxg
    rw [List.pairwise_cons] at hl
    rcases List.mem_cons.mp hx with ex | hx <;> rcases List.mem_cons.mp hy with ey | hy
    · rw [ex, ey]
    · rw [ex] at hxi hxg; rcases hl.1 y hy with h | ⟨_, h⟩ <;> omega
    · rw [ey] at hxi hxg; rcases hl.1 x hx with h | ⟨_, h⟩ <;> omega
    · exact ih hl.2 x hx y hy hxi hxg

/-- Gens alone: a recovery regresses the counter and a later write reuses a gen. -/
theorem gen_only_revisions_collide :
    ∃ s, CasReach s ∧ ∃ w1 ∈ s.hist, ∃ w2 ∈ s.hist, w1 ≠ w2 ∧ w1.gen = w2.gen := by
  have h1 := CasReach.step .init (.write ⟨0, 0, []⟩ 5 (by decide))
  have h2 := CasReach.step h1 (.recover _ 0)
  have h3 := CasReach.step h2 (.write _ 5 (by decide))
  exact ⟨_, h3, ⟨0, 5, 0⟩, by simp, ⟨1, 5, 1⟩, by simp, by decide, rfl⟩

end Nimbus.Vfs.CompositeFeed
