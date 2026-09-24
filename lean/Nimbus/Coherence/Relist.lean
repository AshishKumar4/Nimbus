/-
  Nimbus.Coherence.Relist — NodeNoMirror's namespace under the visibility rule
  (`VisibleDelta`): the facet holds the caller-visible tree; an entry reported as
  itself sets that path to the answer's entry (and, when it is absent or a file,
  drops what was under it); a subtree or structural entry relists that directory,
  and the relist is exact: everything at or under it becomes exactly what the
  caller can see there, so names no longer listed are dropped.

  `relist_exact`: from the visible tree at the cursor, applying the reported
  delta in any order yields exactly the visible tree at answer time, for any log
  complete for the window whose non-subtree reports never name the root. The relist is read at the
  answer's instant (the answer and its relists are one exchange).

  Also, the node shims' own-effect overlay: a process serves its own unflushed
  namespace effects over the admitted namespace. `overlay_exact`: a path the
  process has no pending effect on reads the visible tree at answer time; one it
  has reads its own effect (read-your-writes).
-/

import Nimbus.Coherence.VisibleDelta

namespace Nimbus.Coherence.Relist

open Nimbus.Coherence.VisibleDelta

/-- What the caller can list: a node where its name is visible, nothing elsewhere. -/
def tv (V : Path → Bool) (W : World) : World := fun p => if V p then W p else none

/-- The entry for `p` reports it absent or a file: nothing below it stays. -/
def Drops (V : Path → Bool) (W1 : World) (p : Path) : Prop := ∀ n, tv V W1 p = some n → n.isDir = false

open Classical in
/-- Applying one reported entry with the answer's world `W1`. -/
noncomputable def applyR (V : Path → Bool) (W1 : World) (NS : World) (x : Entry) : World := fun q =>
  if x.2 = true then (if x.1 <+: q then tv V W1 q else NS q)
  else if q = x.1 then tv V W1 q
  else if Drops V W1 x.1 ∧ x.1 <+: q then none
  else NS q

/-- Below an absent or file entry nothing is visible. -/
theorem tv_below_none {W : World} {V : Path → Bool} (hV : ∀ p, V p = true ↔ Visible W p) {p q : Path}
    (hp0 : p ≠ []) (hpq : p <+: q) (hne : q ≠ p) (hn : Drops V W p)
    (hvp : V p = true) : tv V W q = none := by
  unfold tv
  split
  · rename_i hq
    obtain ⟨n, h1, h2, _⟩ := (hV q).mp hq p ⟨hpq, fun e => hne e.symm⟩ hp0
    have := hn n (by unfold tv; rw [if_pos hvp]; exact h1)
    rw [this] at h2; cases h2
  · rfl

/-- The relist makes the caller's namespace exact, in any order. -/
theorem relist_exact (W0 W1 : World) (V0 V1 : Path → Bool) (hV0 : ∀ p, V0 p = true ↔ Visible W0 p)
    (hV1 : ∀ p, V1 p = true ↔ Visible W1 p) (d : List Entry) (hc : Complete W0 W1 d)
    (rep : List Entry) (ha : Answers V1 d rep) (hroot' : ∀ x ∈ rep, x.2 = false → x.1 ≠ []) :
    rep.foldl (applyR V1 W1) (tv V0 W0) = tv V1 W1 := by
  funext q
  -- every step writes the answer's values or leaves a path alone
  have hstep : ∀ NS x, x ∈ rep → ∀ q, applyR V1 W1 NS x q = tv V1 W1 q ∨ applyR V1 W1 NS x q = NS q := by
    intro NS x hx q
    unfold applyR
    by_cases hb : x.2 = true
    · rw [if_pos hb]
      by_cases hp : x.1 <+: q
      · rw [if_pos hp]; exact Or.inl rfl
      · rw [if_neg hp]; exact Or.inr rfl
    · rw [if_neg hb]
      have hb' : x.2 = false := by simpa using hb
      by_cases e : q = x.1
      · rw [if_pos e]; exact Or.inl rfl
      · rw [if_neg e]
        by_cases h : Drops V1 W1 x.1 ∧ x.1 <+: q
        · rw [if_pos h]
          exact Or.inl (tv_below_none hV1 (hroot' x hx hb') h.2 e h.1 (ha.2 x hx)).symm
        · rw [if_neg h]; exact Or.inr rfl
  have htouch : ∀ x, x ∈ rep → (x.1 = q ∨ (x.2 = true ∧ x.1 <+: q)) → ∀ NS, applyR V1 W1 NS x q = tv V1 W1 q := by
    intro x hx hxq NS
    unfold applyR
    rcases hxq with rfl | ⟨hb, hp⟩
    · by_cases hb : x.2 = true
      · rw [if_pos hb, if_pos (List.prefix_refl _)]
      · rw [if_neg hb, if_pos rfl]
    · rw [if_pos hb, if_pos hp]
  suffices h : ∀ (l : List Entry) (NS : World), (∀ x ∈ l, x ∈ rep) →
      (NS q = tv V1 W1 q ∨ ∃ x ∈ l, x.1 = q ∨ (x.2 = true ∧ x.1 <+: q)) → l.foldl (applyR V1 W1) NS q = tv V1 W1 q by
    apply h rep _ (fun _ h => h)
    by_cases e : tv V0 W0 q = tv V1 W1 q
    · exact Or.inl e
    · right
      -- the path's own node changed, or one above it changed shape
      by_cases hw : W0 q = W1 q
      · -- visibility changed: some directory above changed shape
        have hvis : V0 q ≠ V1 q := by
          intro hv; apply e; unfold tv; rw [hv, hw]
        have : ∃ a, Above a q ∧ a ≠ [] ∧ shape (W0 a) ≠ shape (W1 a) := by
          apply Classical.byContradiction
          intro hno
          apply hvis
          have key : ∀ a, Above a q → a ≠ [] → shape (W0 a) = shape (W1 a) := by
            intro a h1 h2; apply Classical.byContradiction; intro h3; exact hno ⟨a, h1, h2, h3⟩
          have iff : Visible W0 q ↔ Visible W1 q := by
            constructor
            · intro hv a h1 h2
              obtain ⟨n, hn, hd, ht⟩ := hv a h1 h2
              have hs := key a h1 h2
              rw [hn] at hs
              cases hw1 : W1 a with
              | none => rw [hw1] at hs; simp [shape] at hs
              | some m => rw [hw1] at hs; simp [shape, hd, ht] at hs; exact ⟨m, rfl, hs.1, hs.2⟩
            · intro hv a h1 h2
              obtain ⟨n, hn, hd, ht⟩ := hv a h1 h2
              have hs := key a h1 h2
              rw [hn] at hs
              cases hw0 : W0 a with
              | none => rw [hw0] at hs; simp [shape] at hs
              | some m => rw [hw0] at hs; simp [shape, hd, ht] at hs; exact ⟨m, rfl, hs.1, hs.2⟩
          cases h0 : V0 q <;> cases h1 : V1 q
          · rfl
          · exact absurd ((hV0 q).mpr (iff.mpr ((hV1 q).mp h1))) (by simp [h0])
          · exact absurd ((hV1 q).mpr (iff.mp ((hV0 q).mp h0))) (by simp [h1])
          · rfl
        obtain ⟨a, hab, _, hs⟩ := this
        obtain ⟨b, hb, hbs⟩ := hc a (fun h => hs (by rw [h]))
        rcases ha.1 _ hb with ⟨_, hm⟩ | ⟨a', ha', _, hm⟩
        · exact ⟨_, hm, Or.inr ⟨hbs hs, hab.1⟩⟩
        · exact ⟨_, hm, Or.inr ⟨rfl, ha'.trans hab.1⟩⟩
      · obtain ⟨b, hb, _⟩ := hc q hw
        rcases ha.1 _ hb with ⟨_, hm⟩ | ⟨a', ha', _, hm⟩
        · exact ⟨_, hm, Or.inl rfl⟩
        · exact ⟨_, hm, Or.inr ⟨rfl, ha'⟩⟩
  intro l
  induction l with
  | nil =>
    intro NS _ h
    rcases h with h | ⟨x, hx, _⟩
    · exact h
    · cases hx
  | cons x l ih =>
    intro NS hl h
    simp only [List.foldl_cons]
    apply ih _ (fun y hy => hl y (List.mem_cons_of_mem _ hy))
    have hx := hl x (List.mem_cons_self _ _)
    rcases h with h | ⟨y, hy, hyq⟩
    · left
      rcases hstep NS x hx q with e | e
      · exact e
      · rw [e]; exact h
    · rcases List.mem_cons.mp hy with rfl | hy
      · left; exact htouch y hx hyq NS
      · rcases hstep NS x hx q with e | e
        · left; exact e
        · right; exact ⟨y, hy, hyq⟩

/-! ## The own-effect overlay -/

/-- A process's pending namespace effects: a path it created, rewrote or removed
    and has not yet flushed, with what it made of it. -/
def overlay (own : Path → Option (Option Node)) (NS : World) : World :=
  fun p => match own p with
    | some e => e
    | none => NS p

theorem overlay_exact (W0 W1 : World) (V0 V1 : Path → Bool) (hV0 : ∀ p, V0 p = true ↔ Visible W0 p)
    (hV1 : ∀ p, V1 p = true ↔ Visible W1 p) (d : List Entry) (hc : Complete W0 W1 d)
    (rep : List Entry) (ha : Answers V1 d rep) (hroot' : ∀ x ∈ rep, x.2 = false → x.1 ≠ [])
    (own : Path → Option (Option Node)) (p : Path) :
    overlay own (rep.foldl (applyR V1 W1) (tv V0 W0)) p = match own p with
      | some e => e
      | none => tv V1 W1 p := by
  unfold overlay
  rw [relist_exact W0 W1 V0 V1 hV0 hV1 d hc rep ha hroot']

end Nimbus.Coherence.Relist
