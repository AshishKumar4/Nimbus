/-
  Nimbus.ContentStore.Lemmas — facts about the model's building blocks that
  every preservation proof uses: `upd`, `enq`, `mapM` over `Option`, and the
  frame lemmas saying which state changes leave a reference's bytes alone.
-/

import Nimbus.ContentStore.Model

namespace Nimbus.ContentStore

@[simp] theorem upd_same {β : Type} (f : Nat → β) (x : Nat) (b : β) : upd f x b x = b := by
  simp [upd]

@[simp] theorem upd_ne {β : Type} (f : Nat → β) {x y : Nat} (b : β) (h : y ≠ x) : upd f x b y = f y := by
  simp [upd, h]

theorem mem_enq {q : List Ref} {x y : Ref} : x ∈ enq q y ↔ x ∈ q ∨ x = y := by
  unfold enq; split
  · constructor
    · exact Or.inl
    · rintro (h | rfl) <;> assumption
  · simp

theorem mem_enq_of_mem {q : List Ref} {x : Ref} (y : Ref) (h : x ∈ q) : x ∈ enq q y :=
  mem_enq.mpr (Or.inl h)

theorem mem_enq_self (q : List Ref) (y : Ref) : y ∈ enq q y := mem_enq.mpr (Or.inr rfl)

theorem mem_foldl_enq {q : List Ref} {x : Ref} (l : List Nat) (f : Nat → Ref) :
    x ∈ l.foldl (fun q c => enq q (f c)) q ↔ x ∈ q ∨ ∃ c ∈ l, x = f c := by
  induction l generalizing q with
  | nil => simp
  | cons c l ih =>
    simp only [List.foldl_cons]
    rw [ih, mem_enq]
    constructor
    · rintro ((h | h) | ⟨c', hc', rfl⟩)
      · exact Or.inl h
      · exact Or.inr ⟨c, List.mem_cons_self _ _, h⟩
      · exact Or.inr ⟨c', List.mem_cons_of_mem _ hc', rfl⟩
    · rintro (h | ⟨c', hc', rfl⟩)
      · exact Or.inl (Or.inl h)
      · rcases List.mem_cons.mp hc' with rfl | h
        · exact Or.inl (Or.inr rfl)
        · exact Or.inr ⟨c', h, rfl⟩

/-! ## `mapM` over `Option` -/

theorem mapM_mono {f g : Nat → Option Nat} (hfg : ∀ k v, f k = some v → g k = some v) :
    ∀ {l : List Nat} {r : List Nat}, l.mapM f = some r → l.mapM g = some r := by
  intro l
  induction l with
  | nil => intro r h; simpa using h
  | cons a l ih =>
    intro r h
    simp only [List.mapM_cons, Option.bind_eq_bind, Option.pure_def] at h ⊢
    cases ha : f a with
    | none => simp [ha] at h
    | some va =>
      simp only [ha, Option.some_bind] at h
      cases hl : l.mapM f with
      | none => simp [hl] at h
      | some vl =>
        simp only [hl, Option.some_bind] at h
        rw [hfg a va ha, ih hl]
        simpa using h

theorem mapM_congr {f g : Nat → Option Nat} :
    ∀ {l : List Nat}, (∀ k ∈ l, f k = g k) → l.mapM f = l.mapM g := by
  intro l
  induction l with
  | nil => intro _; rfl
  | cons a l ih =>
    intro h
    simp only [List.mapM_cons]
    rw [h a (List.mem_cons_self _ _), ih (fun k hk => h k (List.mem_cons_of_mem _ hk))]

theorem mapM_some_mem {f : Nat → Option Nat} :
    ∀ {l : List Nat} {r : List Nat}, l.mapM f = some r → ∀ k ∈ l, f k ≠ none := by
  intro l
  induction l with
  | nil => intro _ _ k hk; cases hk
  | cons a l ih =>
    intro r h k hk
    simp only [List.mapM_cons, Option.bind_eq_bind, Option.pure_def] at h
    cases ha : f a with
    | none => simp [ha] at h
    | some va =>
      simp only [ha, Option.some_bind] at h
      cases hl : l.mapM f with
      | none => simp [hl] at h
      | some vl =>
        rcases List.mem_cons.mp hk with rfl | hk
        · simp [ha]
        · exact ih hl k hk

theorem mapM_append {f : Nat → Option Nat} {l : List Nat} {r : List Nat} {k v : Nat}
    (hl : l.mapM f = some r) (hk : f k = some v) : (l ++ [k]).mapM f = some (r ++ [v]) := by
  rw [List.mapM_append, hl]
  simp [hk]

theorem mapM_set {f : Nat → Option Nat} {k v : Nat} (hk : f k = some v) :
    ∀ {l : List Nat} {r : List Nat} (i : Nat), l.mapM f = some r → (l.set i k).mapM f = some (r.set i v) := by
  intro l
  induction l with
  | nil => intro r i h; simp at h; subst h; simp
  | cons a l ih =>
    intro r i h
    simp only [List.mapM_cons, Option.bind_eq_bind, Option.pure_def] at h
    cases ha : f a with
    | none => simp [ha] at h
    | some va =>
      simp only [ha, Option.some_bind] at h
      cases hl : l.mapM f with
      | none => simp [hl] at h
      | some vl =>
        simp only [hl, Option.some_bind, Option.some.injEq] at h
        subst h
        cases i with
        | zero => simp [List.mapM_cons, hk, hl]
        | succ i => simp [List.mapM_cons, ha, ih i hl]

theorem mapM_length {f : Nat → Option Nat} :
    ∀ {l : List Nat} {r : List Nat}, l.mapM f = some r → r.length = l.length := by
  intro l
  induction l with
  | nil => intro r h; simp at h; subst h; rfl
  | cons a l ih =>
    intro r h
    simp only [List.mapM_cons, Option.bind_eq_bind, Option.pure_def] at h
    cases ha : f a with
    | none => simp [ha] at h
    | some va =>
      simp only [ha, Option.some_bind] at h
      cases hl : l.mapM f with
      | none => simp [hl] at h
      | some vl =>
        simp only [hl, Option.some_bind, Option.some.injEq] at h
        subst h; simp [ih hl]

/-! ## Frames: what leaves a reference's bytes alone -/

/-- Existing chunks keep their hashes and live contents stay as they are. -/
def Ext (s s' : St) : Prop :=
  (∀ k h, s.chunks k = some h → s'.chunks k = some h) ∧
  (∀ c ct, s.contents c = some ct → ct.state = .live → s'.contents c = some ct)

theorem Ext.refl (s : St) : Ext s s := ⟨fun _ _ h => h, fun _ _ h _ => h⟩

theorem Ext.trans {s1 s2 s3 : St} (h12 : Ext s1 s2) (h23 : Ext s2 s3) : Ext s1 s3 :=
  ⟨fun k h hk => h23.1 k h (h12.1 k h hk), fun c ct hc hl => h23.2 c ct (h12.2 c ct hc hl) hl⟩

theorem resolve_ext {s s' : St} (he : Ext s s') {r : Ref} {v : List Hash}
    (h : resolve s r = some v) : resolve s' r = some v := by
  cases r with
  | chunk k =>
    simp only [resolve] at h ⊢
    cases hk : s.chunks k with
    | none => simp [hk] at h
    | some x => rw [he.1 k x hk]; simpa [hk] using h
  | content c =>
    simp only [resolve] at h ⊢
    cases hc : s.contents c with
    | none => simp [hc] at h
    | some ct =>
      simp only [hc] at h
      split at h
      · rename_i hl
        rw [he.2 c ct hc hl]; simp only [hl, if_true]
        exact mapM_mono he.1 h
      · cases h

theorem readRef_ext {s s' : St} (he : Ext s s') {o : Option Ref} {v : Option (List Hash)}
    (h : readRef s o = some v) : readRef s' o = some v := by
  cases o with
  | none => exact h
  | some r =>
    simp only [readRef] at h ⊢
    cases hr : resolve s r with
    | none => simp [hr] at h
    | some x => rw [resolve_ext he hr]; simpa [hr] using h

/-- Resolution only looks at chunks and contents. -/
theorem resolve_congr {s s' : St} (hc : s'.chunks = s.chunks) (hk : s'.contents = s.contents) (r : Ref) :
    resolve s' r = resolve s r := by
  cases r <;> simp [resolve, hc, hk]

theorem readRef_congr {s s' : St} (hc : s'.chunks = s.chunks) (hk : s'.contents = s.contents)
    (o : Option Ref) : readRef s' o = readRef s o := by
  cases o <;> simp [readRef, resolve_congr hc hk]

theorem resolve_live_content {s : St} {c : Nat} {v : List Hash} (h : resolve s (.content c) = some v) :
    ∃ ct, s.contents c = some ct ∧ ct.state = .live ∧ ct.chunks.mapM s.chunks = some v := by
  simp only [resolve] at h
  cases hc : s.contents c with
  | none => simp [hc] at h
  | some ct =>
    simp only [hc] at h
    split at h
    · exact ⟨ct, rfl, by assumption, h⟩
    · cases h

theorem resolve_chunk {s : St} {k : Nat} {v : List Hash} (h : resolve s (.chunk k) = some v) :
    ∃ x, s.chunks k = some x ∧ v = [x] := by
  simp only [resolve] at h
  cases hk : s.chunks k with
  | none => simp [hk] at h
  | some x => simp [hk] at h; exact ⟨x, rfl, h.symm⟩

theorem intern_ext {s : St} {h k : Nat} (hf : s.chunks k = some h ∨ s.chunks k = none) :
    Ext s (intern s h k) := by
  unfold intern
  split
  · exact Ext.refl s
  · rename_i hne
    refine ⟨fun k' x hk' => ?_, fun c ct hc _ => hc⟩
    show upd s.chunks k (some h) k' = some x
    by_cases e : k' = k
    · subst e; rcases hf with hf | hf
      · exact absurd hf hne
      · rw [hf] at hk'; cases hk'
    · rw [upd_ne _ _ e]; exact hk'

theorem intern_chunks_self (s : St) (h k : Nat) : (intern s h k).chunks k = some h := by
  unfold intern; split
  · assumption
  · simp

/-! ## `commit` -/

theorem commit_chunks (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).chunks = s.chunks := rfl
theorem commit_contents (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).contents = s.contents := rfl
theorem commit_snaps (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).snaps = s.snaps := rfl

theorem pinGen_ge {snaps : List (Nat × Nat)} : ∀ x ∈ snaps, x.2 ≤ snaps.foldr (fun x m => max x.2 m) 0 := by
  induction snaps with
  | nil => intro x hx; cases hx
  | cons y ys ih =>
    intro x hx
    simp only [List.foldr_cons]
    rcases List.mem_cons.mp hx with rfl | hx
    · omega
    · have := ih x hx; omega

theorem le_pinGen {s : St} {x : Nat × Nat} (hx : x ∈ s.snaps) : x.2 ≤ pinGen s := pinGen_ge x hx

theorem commit_find_ne {s : St} {p q : Path} {nr : Option Ref} (g : Nat) (hpq : p ≠ q) :
    (commit s q nr).hist.find? (covers g p) = s.hist.find? (covers g p) := by
  unfold commit
  simp only
  cases hl : s.live q with
  | none => rfl
  | some r =>
    simp only
    split
    · rw [List.find?_append]
      have : covers g p ⟨q, r.gen, s.gen + 1, r.ref⟩ = false := by
        simp [covers]; intro h; exact absurd h.symm hpq
      simp [this]
    · rfl

theorem commit_live_ne {s : St} {p q : Path} {nr : Option Ref} (hpq : p ≠ q) :
    (commit s q nr).live p = s.live p := by
  simp [commit, upd, hpq]

/-- The history row a write appends is found only by a snapshot that saw the
    old row, and it answers what the old row answered: every snapshot reads the
    same reference after a write as before it. -/
theorem commit_atRef {s : St} {q : Path} {nr : Option Ref} {g : Nat} (hg : g ≤ pinGen s)
    (hgen : g ≤ s.gen) (p : Path) : atRef (commit s q nr) g p = atRef s g p := by
  by_cases hpq : p = q
  · subst hpq
    unfold atRef commit
    simp only
    cases hl : s.live p with
    | none =>
      simp only [upd_same]
      cases hf : s.hist.find? (covers g p) with
      | some h => rfl
      | none => cases nr <;> simp <;> omega
    | some r =>
      simp only [upd_same]
      by_cases hr : r.gen ≤ pinGen s
      · simp only [hr, if_true, List.find?_append]
        cases hf : s.hist.find? (covers g p) with
        | some h => rfl
        | none =>
          simp only [Option.none_or, List.find?_cons, List.find?_nil]
          by_cases hrg : r.gen ≤ g
          · have : covers g p ⟨p, r.gen, s.gen + 1, r.ref⟩ = true := by
              simp [covers, hrg]; omega
            simp [this, hrg]
          · have : covers g p ⟨p, r.gen, s.gen + 1, r.ref⟩ = false := by
              simp [covers, hrg]
            simp only [this, hrg, if_false]
            cases nr <;> simp; omega
      · simp only [hr, if_false]
        cases hf : s.hist.find? (covers g p) with
        | some h => rfl
        | none =>
          have : ¬ r.gen ≤ g := by omega
          simp only [this, if_false]
          cases nr <;> simp; omega
  · unfold atRef
    rw [commit_find_ne g hpq, commit_live_ne hpq]

end Nimbus.ContentStore
