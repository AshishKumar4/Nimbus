/-
  Nimbus.Vfs.CompositeFeed — the composite's change feed for a node facet's staged
  namespace (ProcessFs over `CompositeVFS`; the review's P2 repro: SQLite holds
  `/pc/shadowed` under a live `/pc` mount, `readdir('/pc')` is `[]`, the root feed
  still names it).

  A principal's mount table is a list of live points with, per point, whether its
  backend offers `changes`. The staged view of a world is what the facet may hold:
  a live mount point and each directory above one is the composite's directory,
  whichever backend holds that path (structural first, as `isStructural` in
  composite.ts); otherwise a path under a mount with `changes` is that backend's
  entry at the relative path, one under a mount without `changes` is not staged
  (never_cached), and any other path is the root backend's.

  (0) `view_closed`: the staged view is a tree whenever the backends are, and
      `fs_inv`/`staged_closed`: in every reachable ProcessFs state (boot relist,
      answers, poison + relist, own mutations, pushed content) the staged namespace
      is that view, so `feed_exact`'s closedness premise always holds. Routing the
      owning mount first breaks it (`owner_first_routing_is_not_a_tree`).
  (1) `feed_exact`: with the table unchanged over the window, the root feed filtered
      to paths the composite routes to the root backend (not under a live mount,
      not structural), plus each `changes` mount's feed re-rooted under its point
      and filtered to non-structural paths the composite routes to that mount,
      applied in any order, turns the staged view at the cursor into the staged
      view at answer time. Unfiltered, the shadowed row is staged
      (`an_unfiltered_root_feed_stages_a_shadowed_row`).
  (1b) `feedOps_exact`: the same for the feed as a credentialed reader gets it, where
      a change may be reported only at a directory above it, flagged `sub`
      (subtree/structural): a shown `sub` entry relists that subtree from its
      backend, and a `sub` entry at a composite directory from the backend it routes
      to poisons (`a_subtree_entry_at_a_composite_directory_must_poison`). A plain
      entry there, a file written or removed, only hides. Only the table at the two
      ends matters (`an_aba_window_needs_no_poison`).
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

open Nimbus.Coherence.Namespace (Kind Tree Closed applyDelta apply_exact applyEntry applyEntry_self applyEntry_other)

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

/-- A live mount point or a directory above one: the composite's own directory,
    whichever backend would otherwise serve the path (`isStructural` in composite.ts). -/
def structural (pts : List Path) (q : Path) : Bool := pts.contains q || synthAnc pts q

def view (T : Table) (W : World) (q : Path) : Option Kind :=
  if q = [] then some .dir else
  if structural T.pts q then some .dir else
  match ownerPt T.pts q with
  | some m => if T.ch m then W.bt m (q.drop m.length) else none
  | none => W.root q

/-- Every backend a principal reaches is a POSIX tree. -/
def BackendsClosed (T : Table) (W : World) : Prop :=
  Closed W.root ∧ ∀ m ∈ T.pts, T.ch m = true → Closed (W.bt m)

/-! ### Routing facts -/

theorem ownerPt_fold_max : ∀ (l : List Path) (acc : Option Path) (m : Path),
    l.foldl (fun acc m => match acc with
      | none => some m
      | some a => if a.length < m.length then some m else some a) acc = some m →
    (∀ x ∈ l, x.length ≤ m.length) ∧ (∀ a, acc = some a → a.length ≤ m.length) := by
  intro l
  induction l with
  | nil => intro acc m h; exact ⟨fun _ hx => (by cases hx), fun a ha => (by rw [ha] at h; cases h; exact Nat.le_refl _)⟩
  | cons x xs ih =>
    intro acc m h
    simp only [List.foldl_cons] at h
    obtain ⟨h1, h2⟩ := ih _ m h
    cases acc with
    | none =>
      have := h2 x rfl
      exact ⟨fun y hy => by rcases List.mem_cons.mp hy with rfl | hy; exact this; exact h1 y hy, fun _ h => by cases h⟩
    | some a =>
      simp only at h2
      by_cases hl : a.length < x.length
      · rw [if_pos hl] at h2
        have := h2 x rfl
        exact ⟨fun y hy => by rcases List.mem_cons.mp hy with rfl | hy; exact this; exact h1 y hy,
          fun b hb => by cases hb; omega⟩
      · rw [if_neg hl] at h2
        have := h2 a rfl
        exact ⟨fun y hy => by rcases List.mem_cons.mp hy with rfl | hy; exact (by omega); exact h1 y hy,
          fun b hb => by cases hb; exact this⟩

theorem ownerPt_fold_none : ∀ (l : List Path) (acc : Option Path),
    l.foldl (fun acc m => match acc with
      | none => some m
      | some a => if a.length < m.length then some m else some a) acc = none → acc = none ∧ l = [] := by
  intro l
  induction l with
  | nil => intro acc h; exact ⟨h, rfl⟩
  | cons x xs ih =>
    intro acc h
    simp only [List.foldl_cons] at h
    have := (ih _ h).1
    cases acc with
    | none => simp at this
    | some a => simp only at this; split at this <;> cases this

theorem ownerPt_max {pts : List Path} {p m : Path} (h : ownerPt pts p = some m) :
    ∀ x ∈ pts, x <+: p → x.length ≤ m.length := by
  intro x hx hxp
  unfold ownerPt at h
  exact (ownerPt_fold_max _ none m h).1 x
    (List.mem_filter.mpr ⟨hx, List.isPrefixOf_iff_prefix.mpr hxp⟩)

theorem ownerPt_none {pts : List Path} {p : Path} (h : ownerPt pts p = none) :
    ∀ x ∈ pts, ¬ x <+: p := by
  intro x hx hxp
  unfold ownerPt at h
  have := (ownerPt_fold_none _ none h).2
  exact List.filter_eq_nil_iff.mp this x hx (List.isPrefixOf_iff_prefix.mpr hxp)

/-- The owner of a path owns every path between its point and the path. -/
theorem ownerPt_between {pts : List Path} {p p' m : Path} (h : ownerPt pts p = some m)
    (hm : m <+: p') (hp : p' <+: p) : ownerPt pts p' = some m := by
  have hmp := (ownerPt_mem pts p h).1
  cases h' : ownerPt pts p' with
  | none => exact absurd hm (ownerPt_none h' m hmp)
  | some m' =>
    obtain ⟨hm'p, hm'⟩ := ownerPt_mem pts p' h'
    have l1 := ownerPt_max h m' hm'p (hm'.trans hp)
    have l2 := ownerPt_max h' m hmp hm
    have hpre := List.prefix_of_prefix_length_le hm hm' (by omega)
    rw [hpre.eq_of_length (by omega)]

theorem synthAnc_iff {pts : List Path} {p : Path} :
    synthAnc pts p = true ↔ p ≠ [] ∧ ∃ m ∈ pts, p <+: m ∧ p ≠ m := by
  simp [synthAnc, List.any_eq_true, List.isPrefixOf_iff_prefix]

theorem dropLast_length_lt {q : Path} (h : q ≠ []) : q.dropLast.length < q.length := by
  cases q with
  | nil => exact absurd rfl h
  | cons _ _ => simp [List.length_dropLast]

/-- The directory of a structural path is structural. -/
theorem structural_dropLast {pts : List Path} {q : Path} (hq : q ≠ []) (hs : structural pts q = true)
    (hd : q.dropLast ≠ []) : synthAnc pts q.dropLast = true := by
  have hlt := dropLast_length_lt hq
  refine synthAnc_iff.mpr ⟨hd, ?_⟩
  simp only [structural, Bool.or_eq_true, List.contains_iff_mem] at hs
  rcases hs with hm | hs
  · exact ⟨q, hm, List.dropLast_prefix q, fun e => by rw [e] at hlt; omega⟩
  · obtain ⟨_, m, hm, hqm, _⟩ := synthAnc_iff.mp hs
    exact ⟨m, hm, (List.dropLast_prefix q).trans hqm, fun e => by
      have := hqm.length_le; rw [← e] at this; omega⟩

/-- The staged view is a POSIX tree whenever the backends are: every staged
    entry's directory is staged as a directory. -/
theorem view_closed {T : Table} {W : World} (hW : BackendsClosed T W) : Closed (view T W) := by
  intro q hq hq0 hd
  have hdir : structural T.pts q.dropLast = true → view T W q.dropLast = some .dir := fun h => by
    simp [view, hd, h]
  by_cases hs : structural T.pts q = true
  · exact hdir (by simp [structural, structural_dropLast hq0 hs hd])
  by_cases hsd : structural T.pts q.dropLast = true
  · exact hdir hsd
  have hsd' : structural T.pts q.dropLast = false := by simpa using hsd
  have hs' : structural T.pts q = false := by simpa using hs
  unfold view at hq ⊢
  rw [if_neg hq0, hs'] at hq
  rw [if_neg hd, hsd']
  simp only [Bool.false_eq_true, if_false] at hq ⊢
  cases ho : ownerPt T.pts q with
  | none =>
    rw [ho] at hq
    have ho' : ownerPt T.pts q.dropLast = none := by
      cases h : ownerPt T.pts q.dropLast with
      | none => rfl
      | some m =>
        obtain ⟨hm, hmp⟩ := ownerPt_mem _ _ h
        exact absurd (hmp.trans (List.dropLast_prefix q)) (ownerPt_none ho m hm)
    rw [ho']
    exact hW.1 q hq hq0 hd
  | some m =>
    rw [ho] at hq
    obtain ⟨hmp, t, rfl⟩ := ownerPt_mem _ _ ho
    have hmq : m ≠ m ++ t := fun e => by
      simp [structural, List.contains_iff_mem, ← e, hmp] at hs'
    have ht : t ≠ [] := by rintro rfl; simp at hmq
    have hdl : (m ++ t).dropLast = m ++ t.dropLast := List.dropLast_append_of_ne_nil _ ht
    have ho' : ownerPt T.pts (m ++ t).dropLast = some m :=
      ownerPt_between ho (by rw [hdl]; exact List.prefix_append _ _) (List.dropLast_prefix _)
    rw [ho']
    cases hch : T.ch m
    · simp [hch] at hq
    · simp only [hch, if_true] at hq ⊢
      rw [hdl, List.drop_left]
      rw [List.drop_left] at hq
      have htd : t.dropLast ≠ [] := by
        intro e
        rw [hdl, e, List.append_nil] at hsd'
        simp [structural, List.contains_iff_mem, hmp] at hsd'
      exact hW.2 m hmp hch t hq ht htd

/-! ## (1) The composite feed -/

/-- The root backend's feed: every changed path at its current entry. -/
def rootFeed (log : List Path) (W1 : World) : List (Path × Option Kind) := log.map fun p => (p, W1.root p)

/-- A mount's feed re-rooted under its point. -/
def mountFeed (m : Path) (log : List Path) (W1 : World) : List (Path × Option Kind) :=
  log.map fun r => (m ++ r, W1.bt m r)

/-- Keep a root entry only where the composite routes to the root backend. -/
def keepRoot (T : Table) (x : Path × Option Kind) : Bool :=
  x.1 != [] && ownerPt T.pts x.1 == none && !structural T.pts x.1

/-- Keep a mount entry only where the composite routes to that mount. -/
def keepMount (T : Table) (m : Path) (x : Path × Option Kind) : Bool :=
  !structural T.pts x.1 && ownerPt T.pts x.1 == some m

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
      simp only [keepMount, Bool.and_eq_true, Bool.not_eq_true', beq_iff_eq] at hk
      obtain ⟨hs, ho⟩ := hk
      have hmp := (ownerPt_mem _ _ ho).1
      have hr : r ≠ [] := by
        rintro rfl; simp [structural, List.contains_iff_mem, hmp] at hs
      refine ⟨?_, by simp [hr]⟩
      simp [view, hr, ho, hs, hch]
    · cases hm

/-- (1) The composite feed is exact for the staged view, in any order. -/
theorem feed_exact (T : Table) (W0 W1 : World) (rlog : List Path) (mlog : Path → List Path)
    (hW : BackendsClosed T W1) (hcomp : Complete W0 W1 T rlog mlog) :
    applyDelta (view T W0) (feed T rlog mlog W1) = view T W1 := by
  apply apply_exact _ _ (view_closed hW) _ (fun x hx => (feed_values T rlog mlog W1 x hx).1)
    (fun x hx => (feed_values T rlog mlog W1 x hx).2)
  intro q hq
  have hq0 : q ≠ [] := by intro e; subst e; simp [view] at hq
  have hs : structural T.pts q = false := by
    cases h : structural T.pts q
    · rfl
    · simp [view, hq0, h] at hq
  unfold view at hq
  rw [if_neg hq0, if_neg hq0, hs] at hq
  simp only [Bool.false_eq_true, if_false] at hq
  cases ho : ownerPt T.pts q with
  | some m =>
    rw [ho] at hq
    simp only at hq
    obtain ⟨hmp, hpre⟩ := ownerPt_mem T.pts q ho
    cases hch : T.ch m
    · simp [hch] at hq
    · rw [if_pos hch, if_pos hch] at hq
      obtain ⟨t, rfl⟩ := hpre
      rw [List.drop_left] at hq
      have hr := hcomp.2 m hmp hch t hq
      refine ⟨(m ++ t, W1.bt m t), List.mem_append_right _ (List.mem_flatMap.mpr ⟨m, hmp, ?_⟩), rfl⟩
      rw [if_pos hch]
      refine List.mem_filter.mpr ⟨List.mem_map.mpr ⟨t, hr, rfl⟩, ?_⟩
      simp [keepMount, ho, hs]
  | none =>
    rw [ho] at hq
    have hr := hcomp.1 q hq
    refine ⟨(q, W1.root q), List.mem_append_left _ (List.mem_filter.mpr ⟨List.mem_map.mpr ⟨q, hr, rfl⟩, ?_⟩), rfl⟩
    simp [keepRoot, hq0, ho, hs]

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

/-! ## (1b) The feed as the backends report it: subtree entries

  A credentialed feed does not always name every changed path. A change under a
  directory removed in the window (or one the caller may not enter) is reported at
  that directory, flagged `subtree`; a directory removed, replaced or re-moded is
  flagged `structural`. Either way the reader must relist at or under that path. A
  log entry here is a path and one `sub` bit for both flags. -/

structure LEnt where
  path : Path
  sub : Bool
  deriving DecidableEq

/-- Every changed path is named, or lies at or under a `sub` entry. -/
def Covers (log : List LEnt) (q : Path) : Prop :=
  (∃ e ∈ log, e.path = q) ∨ ∃ e ∈ log, e.sub = true ∧ e.path <+: q

def CompleteSub (W0 W1 : World) (T : Table) (rlog : List LEnt) (mlog : Path → List LEnt) : Prop :=
  (∀ p, W0.root p ≠ W1.root p → Covers rlog p) ∧
    (∀ m ∈ T.pts, T.ch m = true → ∀ r, W0.bt m r ≠ W1.bt m r → Covers (mlog m) r)

/-- What the facet does with one entry: stage a path's current value, or relist a
    subtree from the backend that serves it. -/
inductive FOp
  | set (x : Path × Option Kind)
  | relist (p : Path) (vals : Tree)

def applyOp (NS : Tree) : FOp → Tree
  | .set x => applyEntry NS x
  | .relist p vals => fun q => if p.isPrefixOf q then vals q else NS q

/-- The staged value of `q` if `b` (none = the root backend) serves it. -/
def served (W : World) (b : Option Path) (q : Path) : Option Kind :=
  match b with
  | none => W.root q
  | some m => W.bt m (q.drop m.length)

def shown (T : Table) (b : Option Path) (p : Path) : Bool :=
  p != [] && !structural T.pts p && ownerPt T.pts p == b

def entOp (W1 : World) (b : Option Path) (e : LEnt) : FOp :=
  if e.sub then .relist e.path (served W1 b) else .set (e.path, served W1 b e.path)

def reroot (m : Path) (e : LEnt) : LEnt := ⟨m ++ e.path, e.sub⟩

/-- Entries shown to the reader, each as its op: the root's under `none`, each
    `changes` mount's re-rooted under its point. -/
def feedOps (T : Table) (rlog : List LEnt) (mlog : Path → List LEnt) (W1 : World) : List FOp :=
  (rlog.filter (fun e => shown T none e.path)).map (entOp W1 none) ++
    T.pts.flatMap fun m => if T.ch m then
      (((mlog m).map (reroot m)).filter (fun e => shown T (some m) e.path)).map (entOp W1 (some m)) else []

/-- Poison: a `sub` entry at one of the composite's own directories, from the
    backend the path routes to. Its relist would be the composite's, not a backend's. -/
def subPoison (T : Table) (rlog : List LEnt) (mlog : Path → List LEnt) : Bool :=
  rlog.any (fun e => e.sub && !shown T none e.path && ownerPt T.pts e.path == none) ||
    T.pts.any fun m => T.ch m && (mlog m).any fun e =>
      e.sub && !shown T (some m) (m ++ e.path) && ownerPt T.pts (m ++ e.path) == some m

/-- Below a shown path nothing is structural and the owner does not change. -/
theorem shown_below {T : Table} {b : Option Path} {p q : Path} (hp : shown T b p = true) (hq : p <+: q) :
    shown T b q = true := by
  simp only [shown, Bool.and_eq_true, bne_iff_ne, ne_eq, Bool.not_eq_true', beq_iff_eq] at hp ⊢
  obtain ⟨⟨hp0, hs⟩, ho⟩ := hp
  have hq0 : q ≠ [] := fun e => hp0 (List.prefix_nil.mp (e ▸ hq))
  have hsq : structural T.pts q = false := by
    cases h : structural T.pts q
    · rfl
    · exfalso
      simp only [structural, Bool.or_eq_true, List.contains_iff_mem] at h
      have hanc : ∀ m ∈ T.pts, q <+: m → structural T.pts p = true := by
        intro m hm hqm
        by_cases e : p = m
        · subst e; simp [structural, List.contains_iff_mem, hm]
        · simp [structural, synthAnc_iff.mpr ⟨hp0, m, hm, hq.trans hqm, e⟩]
      rcases h with hm | ha
      · rw [hanc q hm (List.prefix_refl q)] at hs; cases hs
      · obtain ⟨_, m, hm, hqm, _⟩ := synthAnc_iff.mp ha
        rw [hanc m hm hqm] at hs; cases hs
  refine ⟨⟨hq0, hsq⟩, ?_⟩
  rw [← ho]
  cases h : ownerPt T.pts q with
  | none =>
    cases h' : ownerPt T.pts p with
    | none => rfl
    | some m =>
      exact absurd ((ownerPt_mem _ _ h').2.trans hq) (ownerPt_none h m (ownerPt_mem _ _ h').1)
  | some m =>
    obtain ⟨hm, hmq⟩ := ownerPt_mem _ _ h
    rcases List.prefix_or_prefix_of_prefix hmq hq with hmp | hpm
    · exact (ownerPt_between h hmp hq).symm
    · -- a mount point strictly below p would make p structural
      exfalso
      by_cases e : p = m
      · subst e; simp [structural, List.contains_iff_mem, hm] at hs
      · simp [structural, synthAnc_iff.mpr ⟨hp0, m, hm, hpm, e⟩] at hs

theorem shown_view {T : Table} {W : World} {b : Option Path} {q : Path} (hq : shown T b q = true)
    (hb : ∀ m, b = some m → T.ch m = true) : served W b q = view T W q := by
  simp only [shown, Bool.and_eq_true, bne_iff_ne, ne_eq, Bool.not_eq_true', beq_iff_eq] at hq
  obtain ⟨⟨hq0, hs⟩, ho⟩ := hq
  cases b with
  | none => simp [served, view, hq0, hs, ho]
  | some m => simp [served, view, hq0, hs, ho, hb m rfl]

/-- A sound op leaves every path at its old value or its current one, and a set or
    relist of `q` (or above it) leaves `q` current. -/
def OpSound (V : Tree) : FOp → Prop
  | .set x => x.2 = V x.1 ∧ x.1 ≠ []
  | .relist p vals => ∀ q, p <+: q → vals q = V q

def OpCovers : FOp → Path → Prop
  | .set x, q => x.1 = q
  | .relist p _, q => p <+: q

theorem op_covered {V : Tree} (cur : Tree) {o : FOp} (ho : OpSound V o) {q : Path} (hc : OpCovers o q) :
    applyOp cur o q = V q := by
  cases o with
  | set x =>
    simp only [OpCovers] at hc; subst hc
    exact applyEntry_self cur ho.1 ho.2
  | relist p vals =>
    simp only [OpCovers] at hc
    simp only [applyOp, List.isPrefixOf_iff_prefix.mpr hc, if_true]
    exact ho q hc

theorem op_other {V : Tree} (hV : Closed V) (cur : Tree) {o : FOp} (ho : OpSound V o) {q : Path}
    (hc : ¬ OpCovers o q) : applyOp cur o q = cur q ∨ applyOp cur o q = V q := by
  cases o with
  | set x =>
    simp only [OpCovers] at hc
    exact applyEntry_other hV cur ho.1 (fun e => hc e.symm)
  | relist p vals =>
    simp only [OpCovers] at hc
    left
    have : p.isPrefixOf q = false := by
      cases h : p.isPrefixOf q
      · rfl
      · exact absurd (List.isPrefixOf_iff_prefix.mp h) hc
    simp [applyOp, this]

theorem apply_ops_exact (V NS : Tree) (hV : Closed V) (ops : List FOp) (hs : ∀ o ∈ ops, OpSound V o)
    (hcov : ∀ q, NS q ≠ V q → ∃ o ∈ ops, OpCovers o q) : ops.foldl applyOp NS = V := by
  suffices h : ∀ (l : List FOp) (cur : Tree), (∀ o ∈ l, OpSound V o) →
      (∀ q, cur q = V q ∨ ∃ o ∈ l, OpCovers o q) → ∀ q, l.foldl applyOp cur q = V q by
    funext q
    exact h ops NS hs (fun q => by
      by_cases e : NS q = V q
      · exact Or.inl e
      · exact Or.inr (hcov q e)) q
  intro l
  induction l with
  | nil =>
    intro cur _ h2 q
    rcases h2 q with h | ⟨_, h, _⟩
    · exact h
    · cases h
  | cons o l ih =>
    intro cur hl h2
    simp only [List.foldl_cons]
    apply ih _ (fun y hy => hl y (List.mem_cons_of_mem _ hy))
    intro q
    have ho := hl o (List.mem_cons_self _ _)
    by_cases hc : OpCovers o q
    · exact Or.inl (op_covered cur ho hc)
    · rcases op_other hV cur ho hc with h | h
      · rw [h]
        rcases h2 q with h' | ⟨o', ho', hc'⟩
        · exact Or.inl h'
        · rcases List.mem_cons.mp ho' with rfl | ho'
          · exact absurd hc' hc
          · exact Or.inr ⟨o', ho', hc'⟩
      · exact Or.inl h

/-- (1b) With the table unchanged and no poison, the shown entries, applied in
    any order, make the staged namespace exact. -/
theorem feedOps_exact (T : Table) (W0 W1 : World) (rlog : List LEnt) (mlog : Path → List LEnt)
    (hW : BackendsClosed T W1) (hcomp : CompleteSub W0 W1 T rlog mlog) (hp : subPoison T rlog mlog = false) :
    (feedOps T rlog mlog W1).foldl applyOp (view T W0) = view T W1 := by
  apply apply_ops_exact _ _ (view_closed hW)
  · intro o ho
    rcases List.mem_append.mp ho with ho | ho
    · obtain ⟨e, he, rfl⟩ := List.mem_map.mp ho
      have hsh := (List.mem_filter.mp he).2
      have hb : ∀ m, (none : Option Path) = some m → T.ch m = true := fun _ h => by cases h
      unfold entOp; split
      · intro q hq; exact shown_view (shown_below hsh hq) hb
      · refine ⟨shown_view hsh hb, ?_⟩
        simp only [shown, Bool.and_eq_true, bne_iff_ne] at hsh; exact hsh.1.1
    · obtain ⟨m, _, hm⟩ := List.mem_flatMap.mp ho
      split at hm
      · rename_i hch
        obtain ⟨e, he, rfl⟩ := List.mem_map.mp hm
        have hsh := (List.mem_filter.mp he).2
        have hb : ∀ m', some m = some m' → T.ch m' = true := fun _ h => by cases h; exact hch
        unfold entOp; split
        · intro q hq; exact shown_view (shown_below hsh hq) hb
        · refine ⟨shown_view hsh hb, ?_⟩
          simp only [shown, Bool.and_eq_true, bne_iff_ne] at hsh; exact hsh.1.1
      · cases hm
  · intro q hq
    have hq0 : q ≠ [] := by intro e; subst e; simp [view] at hq
    have hs : structural T.pts q = false := by
      cases h : structural T.pts q
      · rfl
      · simp [view, hq0, h] at hq
    simp only [subPoison, Bool.or_eq_false_iff, List.any_eq_false, Bool.and_eq_true, Bool.not_eq_true',
      beq_iff_eq, not_and, Bool.not_eq_false] at hp
    obtain ⟨hpr, hpm⟩ := hp
    unfold view at hq
    rw [if_neg hq0, if_neg hq0, hs] at hq
    simp only [Bool.false_eq_true, if_false] at hq
    cases ho : ownerPt T.pts q with
    | none =>
      rw [ho] at hq
      have hshq : shown T none q = true := by simp [shown, hq0, hs, ho]
      rcases hcomp.1 q hq with ⟨e, he, rfl⟩ | ⟨e, he, hsub, hpre⟩
      · refine ⟨entOp W1 none e, List.mem_append_left _ (List.mem_map.mpr ⟨e, List.mem_filter.mpr ⟨he, hshq⟩, rfl⟩), ?_⟩
        unfold entOp; split
        · exact List.prefix_refl _
        · rfl
      · have hoe : ownerPt T.pts e.path = none := by
          cases h : ownerPt T.pts e.path with
          | none => rfl
          | some m =>
            obtain ⟨hm, hmp⟩ := ownerPt_mem _ _ h
            exact absurd (hmp.trans hpre) (ownerPt_none ho m hm)
        have hsh : shown T none e.path = true := by
          have := hpr e he
          cases h : shown T none e.path
          · simp [hsub, h, hoe] at this
          · rfl
        refine ⟨entOp W1 none e, List.mem_append_left _ (List.mem_map.mpr ⟨e, List.mem_filter.mpr ⟨he, hsh⟩, rfl⟩), ?_⟩
        simp only [entOp, hsub, if_true, OpCovers]; exact hpre
    | some m =>
      rw [ho] at hq
      obtain ⟨hmp, t, rfl⟩ := ownerPt_mem _ _ ho
      cases hch : T.ch m
      · simp [hch] at hq
      simp only [hch, if_true, List.drop_left] at hq
      have hshq : shown T (some m) (m ++ t) = true := by simp [shown, hq0, hs, ho]
      have mem : ∀ e ∈ mlog m, shown T (some m) (m ++ e.path) = true →
          entOp W1 (some m) (reroot m e) ∈ feedOps T rlog mlog W1 := fun e he hsh =>
        List.mem_append_right _ (List.mem_flatMap.mpr ⟨m, hmp, by
          rw [if_pos hch]
          exact List.mem_map.mpr ⟨reroot m e, List.mem_filter.mpr ⟨List.mem_map.mpr ⟨e, he, rfl⟩, hsh⟩, rfl⟩⟩)
      rcases hcomp.2 m hmp hch t hq with ⟨e, he, rfl⟩ | ⟨e, he, hsub, hpre⟩
      · refine ⟨_, mem e he hshq, ?_⟩
        unfold entOp; split
        · exact List.prefix_refl _
        · rfl
      · have hpre' : m ++ e.path <+: m ++ t := (List.prefix_append_right_inj m).mpr hpre
        have hoe : ownerPt T.pts (m ++ e.path) = some m :=
          ownerPt_between ho (List.prefix_append _ _) hpre'
        have hsh : shown T (some m) (m ++ e.path) = true := by
          have := hpm m hmp
          simp only [hch, Bool.true_and, List.any_eq_true, Bool.and_eq_true, Bool.not_eq_true', beq_iff_eq] at this
          cases h : shown T (some m) (m ++ e.path)
          · have := this; simp at this; exact absurd hoe (this e he hsub h)
          · rfl
        refine ⟨_, mem e he hsh, ?_⟩
        simp only [entOp, reroot, hsub, if_true, OpCovers]; exact hpre'

/-- NodeNoMirrorBuild's rule (2): `rm -r /m` in the root, reported to a
    credentialed reader as one `sub` entry at `/m`, a directory the composite makes
    above the live mount `/m/pc`. The composite still showed the root's `/m/a`,
    which is gone; the entry is not shown, so without the poison `/m/a` stays. -/
theorem a_subtree_entry_at_a_composite_directory_must_poison :
    let T : Table := ⟨[["m", "pc"]], fun _ => true⟩
    let W0 : World := ⟨fun q => if q = ["m"] then some .dir else if q = ["m", "a"] then some (.file 1) else none,
      fun _ _ => none⟩
    let W1 : World := ⟨fun _ => none, fun _ _ => none⟩
    let rlog : List LEnt := [⟨["m"], true⟩]
    view T W0 ["m", "a"] = some (.file 1) ∧ view T W1 ["m", "a"] = none ∧
      (feedOps T rlog (fun _ => []) W1).isEmpty = true ∧ subPoison T rlog (fun _ => []) = true := by
  decide

/-- NodeNoMirrorBuild's rule (1), an ABA window: `/pc` is mounted, and within the
    window unmounted and mounted again from the same source. The ends agree, so no
    poison; the root's `pc/a`, written while `/pc` was not mounted, is covered at
    both ends and the filtered feed drops it. (The theorem needs only the ends:
    `feedOps_exact` takes the answer's table and the backends' own logs.) -/
theorem an_aba_window_needs_no_poison :
    let T : Table := ⟨[["pc"]], fun _ => true⟩
    let W0 : World := ⟨fun _ => none, fun _ _ => none⟩
    let W1 : World := ⟨fun q => if q = ["pc", "a"] then some (.file 1) else none, fun _ _ => none⟩
    let rlog : List LEnt := [⟨["pc", "a"], false⟩]
    (feedOps T rlog (fun _ => []) W1).isEmpty = true ∧ subPoison T rlog (fun _ => []) = false ∧
      view T W0 = view T W1 := by
  refine ⟨by decide, by decide, ?_⟩
  funext q
  by_cases h : q = ["pc", "a"]
  · subst h; decide
  · simp [view, h]

/-- The first routing rule this model had: the owning mount first, the synthesized
    directory only outside every mount. -/
def ownerFirstView (T : Table) (W : World) (q : Path) : Option Kind :=
  if q = [] then some .dir else
  match ownerPt T.pts q with
  | some m => if q = m then some .dir else if T.ch m then W.bt m (q.drop m.length) else none
  | none => if synthAnc T.pts q then some .dir else W.root q

def ownerFirstKeep (T : Table) (m : Path) (x : Path × Option Kind) : Bool :=
  x.1 != m && ownerPt T.pts x.1 == some m

/-- A live mount `/a/b/c` nested in a mount `/a` whose backend has no `b`: owner
    first, `/a/b/c` is staged as a directory and `/a/b` is not, so the staged tree
    is not a tree; and mount `a`'s feed entry removing its `b` is kept and drops the
    nested mount point. Structural first (`view`, `keepMount`), `/a/b` is the
    composite's directory and the entry is filtered out. -/
theorem owner_first_routing_is_not_a_tree :
    let T : Table := ⟨[["a"], ["a", "b", "c"]], fun _ => true⟩
    let W0 : World := ⟨fun _ => none, fun m r => if m = ["a"] ∧ r = ["b"] then some (.file 1) else none⟩
    let W1 : World := ⟨fun _ => none, fun _ _ => none⟩
    ownerFirstView T W1 ["a", "b", "c"] = some .dir ∧ ownerFirstView T W1 ["a", "b"] = none ∧
      (mountFeed ["a"] [["b"]] W1).filter (ownerFirstKeep T ["a"]) = [(["a", "b"], none)] ∧
      applyDelta (view T W0) [(["a", "b"], none)] ["a", "b", "c"] = none ∧
      view T W1 ["a", "b", "c"] = some .dir ∧ view T W1 ["a", "b"] = some .dir ∧
      feed T [] (fun m => if m = ["a"] then [["b"]] else []) W1 = [] := by
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
    (hW : BackendsClosed T1 W1) (hcomp : Complete W0 W1 T1 rlog mlog) (changed : Bool)
    (hpoison : changed = false → sameTable T0 T1) :
    step T0 T1 changed W0 W1 rlog mlog = view T1 W1 := by
  unfold step
  cases changed
  · simp only [Bool.false_eq_true, if_false]
    rw [view_table_congr (hpoison rfl) W0]
    exact feed_exact T1 W0 W1 rlog mlog hW hcomp
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
    it is staged but the composite's own directories (a nested live mount and the
    directories above it). -/
theorem no_changes_never_staged (T : Table) (W : World) (rlog : List Path) (mlog : Path → List Path)
    {m : Path} (hm : T.ch m = false) {q : Path} (ho : ownerPt T.pts q = some m) (hq : q ≠ m)
    (hs : structural T.pts q = false) :
    view T W q = none ∧ ∀ x ∈ feed T rlog mlog W, x.1 = q → x.2 = none := by
  have hv : view T W q = none := by
    have hq0 : q ≠ [] := by
      intro e; subst e
      obtain ⟨_, hp⟩ := ownerPt_mem T.pts [] ho
      exact hq (List.prefix_nil.mp hp).symm
    simp [view, hq0, ho, hs, hm]
  refine ⟨hv, fun x hx he => ?_⟩
  rw [(feed_values T rlog mlog W x hx).1, he, hv]

/-! ## The staged namespace in every reachable state -/

/-- What the facet holds: its table, the backends at its cursor, its staged names. -/
structure Fs where
  T : Table
  W : World
  NS : Tree

/-- ProcessFs's steps. `answer`: an ACQUIRE with the table the same at both ends
    and no `sub` entry at a composite directory applies the shown entries.
    `poison`: otherwise the facet relists. `own`: the
    facet's own mutation succeeded at the composite, and its own delta names every
    staged path the mutation changed, at the new value (a rename names both sides
    and every moved path; a removal names the removed root, and the subtree drop
    covers the rest only if every removed path is named). `push`: pushed bytes change
    content, never names. Backends stay POSIX trees in every world. -/
inductive FsStep : Fs → Fs → Prop
  | answer (s : Fs) (W1 : World) (rlog : List LEnt) (mlog : Path → List LEnt)
      (hW : BackendsClosed s.T W1) (hc : CompleteSub s.W W1 s.T rlog mlog) (hp : subPoison s.T rlog mlog = false) :
      FsStep s { s with W := W1, NS := (feedOps s.T rlog mlog W1).foldl applyOp s.NS }
  | poison (s : Fs) (T1 : Table) (W1 : World) (hW : BackendsClosed T1 W1) :
      FsStep s ⟨T1, W1, view T1 W1⟩
  | own (s : Fs) (W1 : World) (d : List (Path × Option Kind)) (hW : BackendsClosed s.T W1)
      (hd : ∀ x ∈ d, x.2 = view s.T W1 x.1 ∧ x.1 ≠ [])
      (hcov : ∀ q, view s.T s.W q ≠ view s.T W1 q → ∃ x ∈ d, x.1 = q) :
      FsStep s { s with W := W1, NS := applyDelta s.NS d }
  | push (s : Fs) : FsStep s s

inductive FsReach : Fs → Prop
  | boot (T : Table) (W : World) (hW : BackendsClosed T W) : FsReach ⟨T, W, view T W⟩
  | step {s s' : Fs} : FsReach s → FsStep s s' → FsReach s'

/-- In every reachable state the staged namespace is the composite's staged view of
    the backends at the cursor, and so a tree: `feed_exact`'s closedness premise
    holds wherever it is used. -/
theorem fs_inv {s : Fs} (h : FsReach s) : BackendsClosed s.T s.W ∧ s.NS = view s.T s.W := by
  induction h with
  | boot T W hW => exact ⟨hW, rfl⟩
  | step _ hs ih =>
    obtain ⟨hW0, hNS⟩ := ih
    cases hs with
    | answer W1 rlog mlog hW hc hp =>
      refine ⟨hW, ?_⟩
      simp only at hNS ⊢
      rw [hNS]; exact feedOps_exact _ _ _ _ _ hW hc hp
    | poison T1 W1 hW => exact ⟨hW, rfl⟩
    | own W1 d hW hd hcov =>
      refine ⟨hW, ?_⟩
      simp only at hNS ⊢
      rw [hNS]
      exact apply_exact _ _ (view_closed hW) d (fun x hx => (hd x hx).1) (fun x hx => (hd x hx).2) hcov
    | push => exact ⟨hW0, hNS⟩

theorem staged_closed {s : Fs} (h : FsReach s) : Closed s.NS := by
  obtain ⟨hW, hNS⟩ := fs_inv h
  rw [hNS]; exact view_closed hW

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
