/-
  Nimbus.Coherence.VisibleDelta — the visibility rule Main set for reported names
  (after `Visibility.a_chmod_then_remove_hides_a_listed_path`): no delta entry is
  dropped. A path the caller cannot see is reported as its nearest caller-visible
  ancestor, marked subtree-scope. The consumer evicts the named row, and everything
  at or under the name when the entry is subtree-scope or is a structural change of
  a directory (removed, renamed away, a changed mode, uid or gid).

  A world maps a path to a node: file or directory, whether the caller may
  traverse it, and a version. The caller can see a name when every directory above
  it exists and is traversable by it. The log names every path whose node changed
  in the window, flagged structural when its kind, existence or traversability
  changed.

  Proved: (i) `no_leak`: every name reported is one the caller can see at answer
  time; (ii) `coherence`: a row the caller filled while it could see the path, and
  that survives the eviction, is still visible and still current — whether the
  path's content or its visibility changed. The chmod-only revocation is (ii)
  applied to an ancestor whose traversability alone changed
  (`chmod_revokes_rows_below`).
-/

namespace Nimbus.Coherence.VisibleDelta

abbrev Path := List String

structure Node where
  isDir : Bool
  trav : Bool
  ver : Nat
  deriving DecidableEq

abbrev World := Path → Option Node

/-- `a` is strictly above `p`. -/
def Above (a p : Path) : Prop := a <+: p ∧ a ≠ p

/-- The caller can see the name `p`: every directory above it (the root excepted)
    exists, is a directory and is traversable. -/
def Visible (W : World) (p : Path) : Prop :=
  ∀ a, Above a p → a ≠ [] → ∃ n, W a = some n ∧ n.isDir = true ∧ n.trav = true

/-- The part of a node the caller's visibility of what is below depends on. -/
def shape (o : Option Node) : Option (Bool × Bool) := o.map fun n => (n.isDir, n.trav)

/-- A logged change: the path, and whether it was structural. -/
abbrev Entry := Path × Bool

/-- The log is complete for the window from `W0` to `W1`. -/
def Complete (W0 W1 : World) (d : List Entry) : Prop :=
  ∀ p, W0 p ≠ W1 p → ∃ b, (p, b) ∈ d ∧ (shape (W0 p) ≠ shape (W1 p) → b = true)

/-- The nearest ancestor the caller can see (the root at worst). -/
def nva (V : Path → Bool) : Path → Path
  | [] => []
  | x :: xs =>
    let up := (x :: xs).dropLast
    if V up then up else nva V up
termination_by p => p.length
decreasing_by simp [List.length_dropLast]

/-- The rule: a visible path is reported as itself; any other as its nearest
    visible ancestor, subtree-scope. -/
def report (V : Path → Bool) (d : List Entry) : List Entry :=
  d.map fun x => if V x.1 then x else (nva V x.1, true)

/-- The consumer keeps a row unless an entry names it, or names a directory at or
    above it with subtree scope. -/
def Kept (rep : List Entry) (q : Path) : Prop := ∀ x ∈ rep, x.1 ≠ q ∧ (x.2 = true → ¬ x.1 <+: q)

theorem nva_spec (V : Path → Bool) (hroot : V [] = true) :
    ∀ p, V (nva V p) = true ∧ nva V p <+: p := by
  intro p
  induction p using (measure List.length).wf.induction with
  | _ p ih =>
  match p, ih with
  | [], _ => simp [nva, hroot]
  | x :: xs, ih =>
    unfold nva
    simp only
    have hlen : (x :: xs).dropLast.length < (x :: xs).length := by simp [List.length_dropLast]
    split
    · exact ⟨by assumption, List.dropLast_prefix _⟩
    · obtain ⟨h1, h2⟩ := ih _ hlen
      exact ⟨h1, h2.trans (List.dropLast_prefix _)⟩

theorem visible_root (W : World) : Visible W [] := by
  intro a ha hne
  exact absurd (List.prefix_nil.mp ha.1) hne

/-- (i) Every name reported is one the caller can see at answer time. -/
theorem no_leak (W1 : World) (V : Path → Bool) (hV : ∀ p, V p = true ↔ Visible W1 p) (d : List Entry) :
    ∀ x ∈ report V d, Visible W1 x.1 := by
  intro x hx
  obtain ⟨y, _, rfl⟩ := List.mem_map.mp hx
  have hroot : V [] = true := (hV []).mpr (visible_root W1)
  split
  · exact (hV _).mp (by assumption)
  · exact (hV _).mp (nva_spec V hroot y.1).1

/-- An entry for `p`, reported, evicts `p`; and evicts everything under `p` when
    it is structural. -/
theorem entry_evicts (V : Path → Bool) (hroot : V [] = true) {d : List Entry} {p q : Path} {b : Bool}
    (hx : (p, b) ∈ d) (hpq : p <+: q) (hb : p = q ∨ b = true) (hk : Kept (report V d) q) : False := by
  have hm : (if V p then (p, b) else (nva V p, true)) ∈ report V d :=
    List.mem_map.mpr ⟨(p, b), hx, rfl⟩
  have := hk _ hm
  split at this
  · rcases hb with rfl | hb
    · exact this.1 rfl
    · exact this.2 hb hpq
  · exact this.2 rfl ((nva_spec V hroot p).2.trans hpq)

/-- (ii) A row filled while the caller could see its path, current at the cursor,
    that survives the eviction is still visible and still current. -/
theorem coherence (W0 W1 : World) (V : Path → Bool) (hV : ∀ p, V p = true ↔ Visible W1 p)
    (d : List Entry) (hc : Complete W0 W1 d) {q : Path} (hq0 : Visible W0 q)
    (hk : Kept (report V d) q) : Visible W1 q ∧ W1 q = W0 q := by
  have hroot : V [] = true := (hV []).mpr (visible_root W1)
  refine ⟨?_, ?_⟩
  · intro a ha hne
    obtain ⟨n, h1, h2, h3⟩ := hq0 a ha hne
    by_cases e : W1 a = W0 a
    · exact ⟨n, by rw [e]; exact h1, h2, h3⟩
    · obtain ⟨b, hb, hs⟩ := hc a (Ne.symm e)
      apply Classical.byContradiction
      intro hn
      have hshape : shape (W0 a) ≠ shape (W1 a) := by
        intro hsh
        apply hn
        rw [h1] at hsh
        cases hw : W1 a with
        | none => rw [hw] at hsh; simp [shape] at hsh
        | some m =>
          rw [hw] at hsh
          simp [shape, h2, h3] at hsh
          exact ⟨m, rfl, hsh.1, hsh.2⟩
      exact entry_evicts V hroot hb ha.1 (Or.inr (hs hshape)) hk
  · apply Classical.byContradiction
    intro e
    obtain ⟨b, hb, _⟩ := hc q (Ne.symm e)
    exact entry_evicts V hroot hb (List.prefix_refl q) (Or.inl rfl) hk

/-- Revocation by `chmod` alone: when a directory above a row stops being
    traversable and nothing else changes, the row does not survive. -/
theorem chmod_revokes_rows_below (W0 W1 : World) (V : Path → Bool) (hV : ∀ p, V p = true ↔ Visible W1 p)
    (d : List Entry) (hc : Complete W0 W1 d) {q a : Path} (hq0 : Visible W0 q) (ha : Above a q) (hne : a ≠ [])
    {n : Node} (hw : W1 a = some n) (hn : n.trav = false) : ¬ Kept (report V d) q := by
  intro hk
  obtain ⟨m, hm, _, ht⟩ := (coherence W0 W1 V hV d hc hq0 hk).1 a ha hne
  rw [hw] at hm; cases hm; rw [hn] at ht; cases ht

end Nimbus.Coherence.VisibleDelta
