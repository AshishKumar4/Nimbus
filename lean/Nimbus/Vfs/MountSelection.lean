/- Longest-prefix mount geometry, independent of each model's backend metadata. -/

namespace Nimbus.Vfs.MountSelection

abbrev Path := List String

variable {α : Type}

/-- A matching mount replaces the current one only when strictly deeper. -/
def pick (point : α → Path) (p : Path) (best m : α) : α :=
  if (point m).isPrefixOf p && decide ((point best).length < (point m).length) then m else best

def select (point : α → Path) (ms : List α) (p : Path) (best : α) : α :=
  ms.foldl (pick point p) best

theorem fold_spec (point : α → Path) (p : Path) :
    ∀ (ms : List α) (best : α), point best <+: p →
    let r := select point ms p best
    point r <+: p ∧ (r = best ∨ r ∈ ms) ∧ (point best).length ≤ (point r).length ∧
      ∀ m ∈ ms, point m <+: p → (point m).length ≤ (point r).length := by
  intro ms
  induction ms with
  | nil => intro best h; exact ⟨h, Or.inl rfl, Nat.le_refl _, fun _ h => by cases h⟩
  | cons m ms ih =>
    intro best hb
    dsimp only [select, List.foldl_cons]
    have hp : point (pick point p best m) <+: p := by
      unfold pick; split
      · rename_i h
        simp only [Bool.and_eq_true, decide_eq_true_eq] at h
        exact List.isPrefixOf_iff_prefix.mp h.1
      · exact hb
    obtain ⟨h1, h2, h3, h4⟩ := ih (pick point p best m) hp
    simp only [select] at h1 h2 h3 h4
    refine ⟨h1, ?_, ?_, ?_⟩
    · rcases h2 with h2 | h2
      · rw [h2]; unfold pick; split
        · exact Or.inr (List.mem_cons_self _ _)
        · exact Or.inl rfl
      · exact Or.inr (List.mem_cons_of_mem _ h2)
    · have : (point best).length ≤ (point (pick point p best m)).length := by
        unfold pick; split
        · rename_i h; simp only [Bool.and_eq_true, decide_eq_true_eq] at h; omega
        · exact Nat.le_refl _
      omega
    · intro m' hm' hpm
      rcases List.mem_cons.mp hm' with rfl | hm'
      · have : (point m').length ≤ (point (pick point p best m')).length := by
          unfold pick; split
          · exact Nat.le_refl _
          · rename_i h
            have hp' := List.isPrefixOf_iff_prefix.mpr hpm
            simp only [hp', Bool.true_and, decide_eq_true_eq] at h
            omega
        omega
      · exact h4 m' hm' hpm

/-- Without an implicit root mount, seed the same selection with the first match. -/
def select? (point : α → Path) (ms : List α) (p : Path) : Option α :=
  match ms.filter (fun m => (point m).isPrefixOf p) with
  | [] => none
  | m :: rest => some (select point rest p m)

theorem optional_spec (point : α → Path) (ms : List α) (p : Path) :
    match select? point ms p with
    | none => ∀ m ∈ ms, ¬ point m <+: p
    | some m => m ∈ ms ∧ point m <+: p ∧
        ∀ x ∈ ms, point x <+: p → (point x).length ≤ (point m).length := by
  cases hm : ms.filter (fun m => (point m).isPrefixOf p) with
  | nil =>
    simp only [select?, hm]
    intro m hmem hp
    exact List.filter_eq_nil_iff.mp hm m hmem (List.isPrefixOf_iff_prefix.mpr hp)
  | cons m rest =>
    simp only [select?, hm]
    have hall : ∀ x ∈ m :: rest, x ∈ ms ∧ point x <+: p := by
      intro x hx
      have hf : x ∈ ms.filter (fun m => (point m).isPrefixOf p) := by rw [hm]; exact hx
      exact ⟨(List.mem_filter.mp hf).1,
        List.isPrefixOf_iff_prefix.mp (by simpa using (List.mem_filter.mp hf).2)⟩
    obtain ⟨hp, hmem, hlen, hmax⟩ := fold_spec point p rest m (hall m (List.mem_cons_self _ _)).2
    refine ⟨?_, hp, ?_⟩
    · rcases hmem with h | h
      · rw [h]; exact (hall m (List.mem_cons_self _ _)).1
      · exact (hall _ (List.mem_cons_of_mem _ h)).1
    · intro x hx hxp
      have hf : x ∈ ms.filter (fun m => (point m).isPrefixOf p) :=
        List.mem_filter.mpr ⟨hx, List.isPrefixOf_iff_prefix.mpr hxp⟩
      rw [hm] at hf
      rcases List.mem_cons.mp hf with rfl | hr
      · exact hlen
      · exact hmax x hr hxp

end Nimbus.Vfs.MountSelection
