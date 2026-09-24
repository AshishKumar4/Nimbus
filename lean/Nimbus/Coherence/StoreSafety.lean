/-
  Nimbus.Coherence.StoreSafety — no stale read: in every reachable state every
  row the facet holds dated carries a value the authority held at some instant
  at or after the newest barrier answer the facet has admitted.
-/

import Nimbus.Coherence.Store

namespace Nimbus.Coherence.Store

/-! ## The authority's history -/

theorem valAt_fold (p : Path) (t : Nat) :
    ∀ (l : List (Path × Nat)) (m : Nat),
      let r := l.foldl (fun m x => if x.1 = p ∧ x.2 ≤ t ∧ m < x.2 then x.2 else m) m
      m ≤ r ∧ (r = m ∨ ∃ x ∈ l, x.1 = p ∧ x.2 ≤ t ∧ r = x.2) ∧ ∀ x ∈ l, x.1 = p → x.2 ≤ t → x.2 ≤ r := by
  intro l
  induction l with
  | nil => intro m; simp
  | cons y l ih =>
    intro m
    simp only [List.foldl_cons]
    split
    · rename_i hy
      obtain ⟨h1, h2, h3⟩ := ih y.2
      refine ⟨by omega, ?_, ?_⟩
      · rcases h2 with h2 | ⟨x, hx, h⟩
        · exact Or.inr ⟨y, List.mem_cons_self _ _, hy.1, hy.2.1, h2⟩
        · exact Or.inr ⟨x, List.mem_cons_of_mem _ hx, h⟩
      · intro x hx hp ht
        rcases List.mem_cons.mp hx with rfl | hx
        · exact h1
        · exact h3 x hx hp ht
    · rename_i hy
      obtain ⟨h1, h2, h3⟩ := ih m
      refine ⟨h1, ?_, ?_⟩
      · rcases h2 with h2 | ⟨x, hx, h⟩
        · exact Or.inl h2
        · exact Or.inr ⟨x, List.mem_cons_of_mem _ hx, h⟩
      · intro x hx hp ht
        rcases List.mem_cons.mp hx with rfl | hx
        · have : ¬ m < x.2 := fun hlt => hy ⟨hp, ht, hlt⟩
          omega
        · exact h3 x hx hp ht

/-- `valAt` is the newest commit of `p` at or before `t`. -/
theorem valAt_spec (muts : List (Path × Nat)) (p : Path) (t : Nat) :
    (valAt muts p t = 0 ∨ ((p, valAt muts p t) ∈ muts ∧ valAt muts p t ≤ t)) ∧
    ∀ x ∈ muts, x.1 = p → x.2 ≤ t → x.2 ≤ valAt muts p t := by
  obtain ⟨_, h2, h3⟩ := valAt_fold p t muts 0
  refine ⟨?_, h3⟩
  rcases h2 with h2 | ⟨x, hx, hp, ht, he⟩
  · exact Or.inl h2
  · right; unfold valAt; rw [he]; exact ⟨by rw [← hp]; exact hx, ht⟩

/-- Nothing of `p` was committed after its newest commit up to `t`. -/
theorem noMut_valAt (muts : List (Path × Nat)) (p : Path) (t : Nat) :
    NoMut muts p (valAt muts p t) t := by
  intro x hx hp ⟨h1, h2⟩
  have := (valAt_spec muts p t).2 x hx hp h2
  omega

theorem noMut_mono {muts : List (Path × Nat)} {p : Path} {a b a' b' : Nat} (h : NoMut muts p a b)
    (ha : a ≤ a') (hb : b' ≤ b) : NoMut muts p a' b' := by
  intro x hx hp ⟨h1, h2⟩; exact h x hx hp ⟨by omega, by omega⟩

theorem noMut_append {muts : List (Path × Nat)} {p q : Path} {a b n : Nat} (h : NoMut muts p a b)
    (hb : b < n) : NoMut (muts ++ [(q, n)]) p a b := by
  intro x hx hp ⟨h1, h2⟩
  rcases List.mem_append.mp hx with hx | hx
  · exact h x hx hp ⟨h1, h2⟩
  · simp at hx; subst hx; simp at h2; omega

/-- Two stretches with no commit make one. -/
theorem noMut_join {muts : List (Path × Nat)} {p : Path} {a b c : Nat} (h1 : NoMut muts p a b)
    (h2 : NoMut muts p b c) : NoMut muts p a c := by
  intro x hx hp ⟨l, r⟩
  by_cases e : x.2 ≤ b
  · exact h1 x hx hp ⟨l, e⟩
  · exact h2 x hx hp ⟨by omega, r⟩

theorem valAt_append_le {muts : List (Path × Nat)} {p q : Path} {t n : Nat} (hn : t < n) :
    valAt (muts ++ [(q, n)]) p t = valAt muts p t := by
  unfold valAt
  rw [List.foldl_append]
  simp only [List.foldl_cons, List.foldl_nil]
  split
  · rename_i h; omega
  · rfl

theorem repOf_ge {d : List (Path × Nat)} {p : Path} {e : Nat} (h : (p, e) ∈ d) : e ≤ repOf d p := by
  unfold repOf
  suffices ∀ (l : List (Path × Nat)) m, ((p, e) ∈ l → e ≤ l.foldl (fun m x => if x.1 = p then max m x.2 else m) m) ∧
      m ≤ l.foldl (fun m x => if x.1 = p then max m x.2 else m) m from (this d 0).1 h
  intro l
  induction l with
  | nil => intro m; simp
  | cons y l ih =>
    intro m
    simp only [List.foldl_cons]
    constructor
    · intro hm
      rcases List.mem_cons.mp hm with rfl | hm
      · simp only [if_true]
        have := (ih (max m e)).2; omega
      · exact (ih _).1 hm
    · split
      · have := (ih (max m y.2)).2; omega
      · exact (ih m).2

/-- The delta names every path committed after its base, at the path's last commit. -/
theorem deltaFrom_covers (s : St) (c : Nat) (hf : ¬ c < s.logFloor) {x : Path × Nat} (hx : x ∈ s.muts)
    (hc : c < x.2) : (x.1, last s x.1) ∈ deltaFrom s c := by
  unfold deltaFrom
  have hmem : x.1 ∈ ((retained s).filter fun y => c < y.2).map (·.1) :=
    List.mem_map.mpr ⟨x, List.mem_filter.mpr ⟨List.mem_filter.mpr ⟨hx, by simp; omega⟩, by simpa using hc⟩, rfl⟩
  suffices ∀ (l : List Path) (acc : List (Path × Nat)), (∀ y ∈ acc, y.2 = last s y.1) →
      (∀ p ∈ l, (p, last s p) ∈ l.foldl (fun acc p => if acc.any (·.1 == p) then acc else acc ++ [(p, last s p)]) acc) ∧
      (∀ y ∈ acc, y ∈ l.foldl (fun acc p => if acc.any (·.1 == p) then acc else acc ++ [(p, last s p)]) acc) ∧
      (∀ y ∈ l.foldl (fun acc p => if acc.any (·.1 == p) then acc else acc ++ [(p, last s p)]) acc, y.2 = last s y.1) from
    (this _ [] (fun _ h => by cases h)).1 _ hmem
  intro l
  induction l with
  | nil => intro acc h; exact ⟨(fun _ hp => by cases hp), (fun _ hy => hy), h⟩
  | cons p l ih =>
    intro acc hacc
    simp only [List.foldl_cons]
    split
    · rename_i hany
      obtain ⟨h1, h2, h3⟩ := ih acc hacc
      refine ⟨?_, h2, h3⟩
      intro q hq
      rcases List.mem_cons.mp hq with rfl | hq
      · obtain ⟨y, hy, hyq⟩ := List.any_eq_true.mp hany
        have e1 : y.1 = q := by simpa using hyq
        have := hacc y hy
        have : y = (q, last s q) := by ext <;> simp [e1, this]
        exact h2 _ (this ▸ hy)
      · exact h1 q hq
    · have hacc' : ∀ y ∈ acc ++ [(p, last s p)], y.2 = last s y.1 := by
        intro y hy; rcases List.mem_append.mp hy with hy | hy
        · exact hacc y hy
        · simp at hy; subst hy; rfl
      obtain ⟨h1, h2, h3⟩ := ih _ hacc'
      refine ⟨?_, fun y hy => h2 y (List.mem_append_left _ hy), h3⟩
      intro q hq
      rcases List.mem_cons.mp hq with rfl | hq
      · exact h2 _ (List.mem_append_right _ (by simp))
      · exact h1 q hq

/-! ## The invariant -/

def IsVer (s : St) (p : Path) (v : Nat) : Prop := v = 0 ∨ (p, v) ∈ s.muts

/-- A dated row, or a read about to be installed, is good if no commit of its
    path lies between its value and the later of its date and the horizon. -/
def Fresh (s : St) (p : Path) (v r : Nat) : Prop := IsVer s p v ∧ NoMut s.muts p v (max r s.H)

structure Inv (s : St) : Prop where
  mutsLe : ∀ x ∈ s.muts, 0 < x.2 ∧ x.2 ≤ s.rev
  hLe : s.H ≤ s.rev
  cursorLe : s.cursor ≤ s.H
  rowStamp : ∀ p v r, s.rows p = some ⟨v, .dated r⟩ → r ≤ s.rev
  rowFresh : ∀ p v r, s.rows p = some ⟨v, .dated r⟩ → Fresh s p v r
  fillRev : ∀ f ∈ s.fills, f.rev ≤ s.H
  fillFresh : ∀ f ∈ s.fills, ∀ v, f.served = some v →
    f.spoiled = true ∨ f.rev < f.reported ∨ Fresh s f.path v f.rev
  repairSpoiled : s.repair ≠ none → ∀ f ∈ s.fills, f.spoiled = true
  requestLe : ∀ q ∈ s.requests, q.2 ≤ s.H
  answerOk : ∀ a ∈ s.answers, (a.routed = false → a.base ≤ s.H) ∧ a.rev ≤ s.rev ∧
    (a.poison = false → ∀ x ∈ s.muts, a.base < x.2 → x.2 ≤ a.rev → x.2 ≤ repOf a.delta x.1)
  listingOk : ∀ L, s.repair = some (some L) → L.cursor ≤ s.rev ∧ (L.reconciled = false → s.H ≤ L.cursor) ∧
    (L.reconciled = true → L.cursor ≤ s.H) ∧
    (∀ p, valAt s.muts p L.cursor ≤ L.listed p) ∧ (∀ p, L.listed p ≤ L.cursor)
  flightOk : ∀ g ∈ s.flights, ∀ r, g.committed = some r → (g.path, r) ∈ s.muts ∧ r ≤ s.rev ∧
    (s.parked g.path = some g.w → r < s.reports g.path ∨ NoMut s.muts g.path r (max r s.H))
  flightLt : ∀ g ∈ s.flights, g.w < s.nextId
  parkedLt : ∀ p w, s.parked p = some w → w < s.nextId

theorem init_inv : Inv init := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> intros <;> simp_all [init]

/-! ## Each event keeps it -/

theorem fresh_ext {s s' : St} {p : Path} {v r : Nat} (h : Fresh s p v r) (hm : ∀ x ∈ s.muts, x ∈ s'.muts)
    (hno : NoMut s'.muts p v (max r s.H)) (hH : s'.H = s.H) : Fresh s' p v r := by
  refine ⟨?_, by rw [hH]; exact hno⟩
  rcases h.1 with h | h
  · exact Or.inl h
  · exact Or.inr (hm _ h)

/-- An authority commit keeps every fact about the past. -/
theorem commit_inv {s : St} (hi : Inv s) (p : Path) {n : Nat} (hn : s.rev < n) :
    Inv { commitMut s p n with flights := s.flights } := by
  have hmem : ∀ x ∈ s.muts, x ∈ (commitMut s p n).muts := fun x hx => List.mem_append_left _ hx
  have hno : ∀ q a b, b ≤ s.rev → NoMut s.muts q a b → NoMut (commitMut s p n).muts q a b :=
    fun q a b hb h => noMut_append h (by omega)
  have hrev : (commitMut s p n).rev = n := rfl
  refine ⟨?_, ?_, hi.cursorLe, ?_, ?_, hi.fillRev, ?_, hi.repairSpoiled, hi.requestLe, ?_, ?_, ?_,
    hi.flightLt, hi.parkedLt⟩
  · intro x hx
    rcases List.mem_append.mp hx with hx | hx
    · have := hi.mutsLe x hx; exact ⟨this.1, by show x.2 ≤ n; omega⟩
    · simp at hx; subst hx; exact ⟨by simp; omega, by show n ≤ n; omega⟩
  · have := hi.hLe; show s.H ≤ n; omega
  · intro q v r h; have := hi.rowStamp q v r h; show r ≤ n; omega
  · intro q v r h
    have hf := hi.rowFresh q v r h
    have := hi.rowStamp q v r h; have := hi.hLe
    exact fresh_ext hf hmem (hno _ _ _ (by omega) hf.2) rfl
  · intro f hf v hv
    rcases hi.fillFresh f hf v hv with h | h | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · have := hi.fillRev f hf; have := hi.hLe
      exact Or.inr (Or.inr (fresh_ext h hmem (hno _ _ _ (by omega) h.2) rfl))
  · intro a ha
    obtain ⟨h1, h2, h3⟩ := hi.answerOk a ha
    refine ⟨h1, by show a.rev ≤ n; omega, fun hp x hx hb hr => ?_⟩
    rcases List.mem_append.mp hx with hx | hx
    · exact h3 hp x hx hb hr
    · simp at hx; subst hx; simp at hr; omega
  · intro L hL
    obtain ⟨h1, h2, h3, h4, h5⟩ := hi.listingOk L hL
    refine ⟨by show L.cursor ≤ n; omega, h2, h3, fun q => ?_, h5⟩
    show valAt (s.muts ++ [(p, n)]) q L.cursor ≤ L.listed q
    rw [valAt_append_le (by omega)]; exact h4 q
  · intro g hg r hr
    obtain ⟨h1, h2, h3⟩ := hi.flightOk g hg r hr
    refine ⟨hmem _ h1, by show r ≤ n; omega, fun hp => ?_⟩
    rcases h3 hp with h | h
    · exact Or.inl h
    · have := hi.hLe
      exact Or.inr (show NoMut (commitMut s p n).muts g.path r (max r s.H) from hno _ _ _ (by omega) h)

end Nimbus.Coherence.Store
