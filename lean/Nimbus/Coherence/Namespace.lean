/-
  Nimbus.Coherence.Namespace — NodeNoMirror's namespace manifest (`__nsApplyEntry`,
  facet-resident-store.ts on work/node-nomirror): the facet's copy of the whole
  tree's names, kept exact by the ACQUIRE delta.

  A tree maps a path (its components; `[]` is the root) to nothing, a
  directory, or a file (with an abstract stat). Applying a delta entry for `p`:
  absent → `p` and everything under it go; a file → `p` is set and everything
  strictly under it goes; a directory → `p` is set.

  I1 (`apply_exact`): if the facet's tree was exact at its cursor and the delta
  names every path whose entry changed since, at its current entry, then after
  applying it the facet's tree is exactly the authority's — in any entry order.
  The subtree drop is what makes an entry for a removed or replaced directory
  cover what was under it; the log must still name every path that changed
  (`a_log_naming_only_the_removed_root_leaves_a_ghost`).

  Not modeled: credential views and traversability (a chmod of a directory
  changing what is visible under it), and the own-effects overlay.
-/

import Nimbus.Vfs.RevisionFloor

namespace Nimbus.Coherence.Namespace

open Nimbus.Vfs.RevisionFloor (Path Under under_refl under_trans under_cases under_dropLast under_ne_nil)

inductive Kind where
  | dir
  | file (stat : Nat)
  deriving DecidableEq, Repr

abbrev Tree := Path → Option Kind

/-- Every entry's directory exists and is a directory. -/
def Closed (T : Tree) : Prop := ∀ q, T q ≠ none → q ≠ [] → q.dropLast ≠ [] → T q.dropLast = some .dir

/-- `q` lies strictly under `a`. -/
def Below (a q : Path) : Prop := Under a q ∧ a ≠ q

instance (a q : Path) : Decidable (Below a q) := inferInstanceAs (Decidable (_ ∧ _))

def applyEntry (NS : Tree) (x : Path × Option Kind) : Tree :=
  match x.2 with
  | none => fun q => if Under x.1 q then none else NS q
  | some (.file st) => fun q => if q = x.1 then some (.file st) else if Below x.1 q then none else NS q
  | some .dir => fun q => if q = x.1 then some .dir else NS q

def applyDelta (NS : Tree) (d : List (Path × Option Kind)) : Tree := d.foldl applyEntry NS

/-- Every directory above an existing entry exists as a directory. -/
theorem closed_above {T : Tree} (hc : Closed T) :
    ∀ (q : Path) (a : Path), T q ≠ none → Below a q → T a = some .dir := by
  intro q
  induction q using (measure List.length).wf.induction with
  | _ q ih =>
  intro a hq hb
  have hq0 : q ≠ [] := under_ne_nil hb.1
  rcases under_cases hb.1 with e | hu
  · exact absurd e hb.2
  · have hd : q.dropLast ≠ [] := under_ne_nil hu
    have hT := hc q hq hq0 hd
    by_cases e : a = q.dropLast
    · rw [e]; exact hT
    · have hlen : q.dropLast.length < q.length := by
        simp [List.length_dropLast]; cases q with
        | nil => exact absurd rfl hq0
        | cons _ _ => simp
      exact ih _ hlen a (by rw [hT]; simp) ⟨hu, e⟩

/-- Under a path that is absent or a file, nothing exists. -/
theorem nothing_below {T : Tree} (hc : Closed T) {p q : Path} (hb : Below p q)
    (hp : T p = none ∨ ∃ st, T p = some (.file st)) : T q = none := by
  apply Classical.byContradiction; intro hq
  have := closed_above hc q p hq hb
  rcases hp with hp | ⟨st, hp⟩ <;> rw [hp] at this <;> cases this

/-- An entry makes its own path exact. -/
theorem applyEntry_self {T : Tree} (NS : Tree) {x : Path × Option Kind} (hx : x.2 = T x.1) (h0 : x.1 ≠ []) :
    applyEntry NS x x.1 = T x.1 := by
  unfold applyEntry
  rcases hk : x.2 with _ | k
  · simp only; rw [if_pos (under_refl h0)]; rw [← hx, hk]
  · cases k with
    | file st => simp only [if_pos rfl, if_true]; rw [← hx, hk]
    | dir => simp only [if_pos rfl, if_true]; rw [← hx, hk]

/-- Elsewhere it changes nothing, or empties a path the authority has not got. -/
theorem applyEntry_other {T : Tree} (hc : Closed T) (NS : Tree) {x : Path × Option Kind} (hx : x.2 = T x.1)
    {q : Path} (hq : q ≠ x.1) : applyEntry NS x q = NS q ∨ applyEntry NS x q = T q := by
  unfold applyEntry
  rcases hk : x.2 with _ | k
  · simp only
    split
    · rename_i hu
      right
      exact (nothing_below hc ⟨hu, fun e => hq e.symm⟩ (Or.inl (by rw [← hx, hk]))).symm
    · left; rfl
  · cases k with
    | file st =>
      simp only [if_neg hq]
      split
      · rename_i hb
        right
        exact (nothing_below hc hb (Or.inr ⟨st, by rw [← hx, hk]⟩)).symm
      · left; rfl
    | dir => simp only [if_neg hq]; left; trivial

/-- I1: a delta naming every changed path at its current entry makes the
    facet's namespace exactly the authority's, in any order. -/
theorem apply_exact (NS T : Tree) (hc : Closed T) (d : List (Path × Option Kind))
    (hd : ∀ x ∈ d, x.2 = T x.1) (hroot : ∀ x ∈ d, x.1 ≠ [])
    (hcov : ∀ q, NS q ≠ T q → ∃ x ∈ d, x.1 = q) :
    applyDelta NS d = T := by
  suffices h : ∀ (l : List (Path × Option Kind)) (cur : Tree), (∀ x ∈ l, x.2 = T x.1) → (∀ x ∈ l, x.1 ≠ []) →
      (∀ q, cur q = T q ∨ ∃ x ∈ l, x.1 = q) → ∀ q, l.foldl applyEntry cur q = T q by
    funext q
    exact h d NS hd hroot (fun q => by
      by_cases e : NS q = T q
      · exact Or.inl e
      · exact Or.inr (hcov q e)) q
  intro l
  induction l with
  | nil =>
    intro cur _ _ h2 q
    rcases h2 q with h | ⟨x, hx, _⟩
    · exact h
    · cases hx
  | cons x l ih =>
    intro cur hl hr h2
    simp only [List.foldl_cons]
    apply ih _ (fun y hy => hl y (List.mem_cons_of_mem _ hy)) (fun y hy => hr y (List.mem_cons_of_mem _ hy))
    intro q
    have hx := hl x (List.mem_cons_self _ _)
    by_cases e : q = x.1
    · subst e; exact Or.inl (applyEntry_self cur hx (hr x (List.mem_cons_self _ _)))
    · rcases applyEntry_other hc cur hx e with h | h
      · rw [h]
        rcases h2 q with h' | ⟨y, hy, hyq⟩
        · exact Or.inl h'
        · rcases List.mem_cons.mp hy with rfl | hy
          · exact absurd hyq.symm e
          · exact Or.inr ⟨y, hy, hyq⟩
      · exact Or.inl h

/-- Why every changed path must be logged, subtree drop or not: `rm -r /d`
    logged as `/d` alone, then `/d` recreated. The delta reports `/d` as a
    directory, so nothing under it is dropped, and `/d/y` stays in the facet's
    namespace after the authority removed it. -/
theorem a_log_naming_only_the_removed_root_leaves_a_ghost :
    let NS : Tree := fun q => if q = ["d"] then some .dir else if q = ["d", "y"] then some (.file 0) else none
    let T : Tree := fun q => if q = ["d"] then some .dir else none
    Closed T ∧ applyDelta NS [(["d"], T ["d"])] ["d", "y"] = some (.file 0) ∧ T ["d", "y"] = none := by
  refine ⟨?_, by decide, by decide⟩
  intro q hq _ hd
  by_cases e : q = ["d"]
  · subst e; simp at hd
  · simp [e] at hq

end Nimbus.Coherence.Namespace
