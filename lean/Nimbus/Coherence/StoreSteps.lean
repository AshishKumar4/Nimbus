/-
  Nimbus.Coherence.StoreSteps — every event keeps `Inv`, and what it means at a
  resumption.
-/

import Nimbus.Coherence.StoreSafety

namespace Nimbus.Coherence.Store

theorem repOf_fold (p : Path) : ∀ (l : List (Path × Nat)) (m : Nat),
    let r := l.foldl (fun m x => if x.1 = p then max m x.2 else m) m
    m ≤ r ∧ (r = m ∨ (p, r) ∈ l) := by
  intro l
  induction l with
  | nil => intro m; simp
  | cons y l ih =>
    intro m
    simp only [List.foldl_cons]
    split
    · rename_i hy
      obtain ⟨h1, h2⟩ := ih (max m y.2)
      refine ⟨by omega, ?_⟩
      rcases h2 with h2 | h2
      · by_cases e : m ≤ y.2
        · right; rw [h2, Nat.max_eq_right e]; rw [← hy]; exact List.mem_cons_self _ _
        · left; rw [h2]; omega
      · exact Or.inr (List.mem_cons_of_mem _ h2)
    · obtain ⟨h1, h2⟩ := ih m
      exact ⟨h1, h2.elim Or.inl (fun h => Or.inr (List.mem_cons_of_mem _ h))⟩

/-- A positive report is one of the delta's entries. -/
theorem repOf_mem {d : List (Path × Nat)} {p : Path} (h : 0 < repOf d p) : (p, repOf d p) ∈ d := by
  obtain ⟨_, h2⟩ := repOf_fold p d 0
  rcases h2 with h2 | h2
  · unfold repOf at h; omega
  · exact h2

theorem mem_map_eq {α : Type} {l : List α} {f : α → α} {y : α} (h : y ∈ l.map f) : ∃ x ∈ l, y = f x := by
  obtain ⟨x, hx, rfl⟩ := List.mem_map.mp h; exact ⟨x, hx, rfl⟩

/-- A commit above `lo`, at or below the answer, is reported at or above itself. -/
theorem covered {s : St} (hi : Inv s) {a : Answer} (ha : a ∈ s.answers) (hp : a.poison = false)
    {x : Path × Nat} (hx : x ∈ s.muts) (hb : a.base < x.2) (hr : x.2 ≤ a.rev) : x.2 ≤ repOf a.delta x.1 :=
  (hi.answerOk a ha).2.2 hp x hx hb hr

/-! ## Admission -/

theorem admit_rows {s : St} {a : Answer} {p : Path} {v r : Nat}
    (h : (admit s a).rows p = some ⟨v, .dated r⟩) :
    s.rows p = some ⟨v, .dated r⟩ ∧ ¬ r < repOf a.delta p := by
  simp only [admit] at h
  cases hs : s.rows p with
  | none => rw [hs] at h; cases h
  | some row =>
    rcases row with ⟨v', st⟩
    cases st with
    | own => rw [hs] at h; simp at h
    | dated r' =>
      rw [hs] at h
      simp only at h
      split at h
      · cases h
      · rename_i hk; injection h with h; injection h with h1 h2; injection h2 with h2; subst h1 h2
        exact ⟨rfl, hk⟩

theorem admit_inv {s : St} (hi : Inv s) (a : Answer) (ha : a ∈ s.answers)
    (hrep : s.repair = none)
    (d : List (Path × Nat))
    (hd : ∀ x ∈ s.muts, s.H < x.2 → x.2 ≤ a.rev → x.2 ≤ repOf d x.1)
    (C : Nat) (hC : C ≤ max s.H a.rev) :
    Inv { admit s { a with delta := d } with answers := s.answers.erase a, cursor := C } := by
  have hrev := (hi.answerOk a ha).2.1
  have hHle := hi.hLe
  -- every commit between the horizon and the answer is reported
  have hcov : ∀ p lo, s.H ≤ lo → ∀ x ∈ s.muts, x.1 = p → lo < x.2 → x.2 ≤ max lo (max s.H a.rev) →
      x.2 ≤ repOf d p := by
    intro p lo hlo x hx hxp h1 h2
    have := hd x hx (by omega) (by omega)
    rw [hxp] at this; exact this
  refine ⟨hi.mutsLe, by show max s.H a.rev ≤ s.rev; omega, hC, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_,
    hi.flightLt, hi.parkedLt⟩
  · intro p v r h
    exact hi.rowStamp p v r (admit_rows h).1
  · intro p v r h
    obtain ⟨hr, hkeep⟩ := admit_rows h
    have hf := hi.rowFresh p v r hr
    refine ⟨hf.1, ?_⟩
    show NoMut s.muts p v (max r (max s.H a.rev))
    apply noMut_join hf.2
    intro x hx hxp ⟨h1, h2⟩
    have := hcov p (max r s.H) (by omega) x hx hxp h1 (by omega)
    simp at hkeep
    omega
  · intro f hf
    obtain ⟨g, hg, rfl⟩ := mem_map_eq hf
    have := hi.fillRev g hg; show g.rev ≤ max s.H a.rev; omega
  · intro f hf v hv
    obtain ⟨g, hg, rfl⟩ := mem_map_eq hf
    rcases hi.fillFresh g hg v hv with h | h | h
    · exact Or.inl h
    · exact Or.inr (Or.inl (by show g.rev < max g.reported (repOf d g.path); omega))
    · by_cases hr : g.rev < repOf d g.path
      · exact Or.inr (Or.inl (by show g.rev < max g.reported (repOf d g.path); omega))
      · right; right
        refine ⟨h.1, ?_⟩
        show NoMut s.muts g.path v (max g.rev (max s.H a.rev))
        apply noMut_join h.2
        intro x hx hxp ⟨h1, h2⟩
        have := hcov g.path (max g.rev s.H) (by omega) x hx hxp h1 (by omega)
        omega
  · intro hr; exact absurd hrep hr
  · intro q hq; have := hi.requestLe q hq; show q.2 ≤ max s.H a.rev; omega
  · intro b hb'
    obtain ⟨h1, h2, h3⟩ := hi.answerOk b (List.mem_of_mem_erase hb')
    exact ⟨fun h => by have := h1 h; show b.base ≤ max s.H a.rev; omega, h2, h3⟩
  · intro L hL; simp only [admit] at hL; rw [hrep] at hL; cases hL
  · intro g hg r hr
    obtain ⟨h1, h2, h3⟩ := hi.flightOk g hg r hr
    refine ⟨h1, h2, fun hpk0 => ?_⟩
    have hpk : s.parked g.path = some g.w := hpk0
    have hpk' : s.parked g.path ≠ none := by rw [hpk]; simp
    show r < (if s.parked g.path ≠ none then max (s.reports g.path) (repOf d g.path) else s.reports g.path) ∨
      NoMut s.muts g.path r (max r (max s.H a.rev))
    rw [if_pos hpk']
    rcases h3 hpk with h | h
    · left; omega
    · by_cases hr' : r < repOf d g.path
      · left; omega
      · right
        apply noMut_join h
        intro x hx hxp ⟨l1, l2⟩
        have := hcov g.path (max r s.H) (by omega) x hx hxp l1 (by omega)
        omega

theorem admitDelta_inv {s : St} (hi : Inv s) {a : Answer} (ha : a ∈ s.answers) (hp : a.poison = false)
    (hro : a.routed = false) (hrep : s.repair = none) : Inv (admit s a) := by
  have hb := (hi.answerOk a ha).1 hro
  have := admit_inv hi a ha hrep a.delta (fun x hx h1 hr => covered hi ha hp hx (by omega) hr)
    a.rev (by omega)
  exact this

theorem admitMono_inv {s : St} (hi : Inv s) {a : Answer} (ha : a ∈ s.answers) (hp : a.poison = false)
    (hb : a.base ≤ s.cursor) (hrep : s.repair = none) : Inv (admitM s a) := by
  have hcur := hi.cursorLe
  have hd : ∀ x ∈ s.muts, a.base < x.2 → x.2 ≤ a.rev → s.cursor < x.2 →
      x.2 ≤ repOf (a.delta.filter fun y => s.cursor < y.2) x.1 := by
    intro x hx h1 h2 h3
    have hc := covered hi ha hp hx h1 h2
    have hpos : 0 < repOf a.delta x.1 := by omega
    have hm := repOf_mem hpos
    have : (x.1, repOf a.delta x.1) ∈ a.delta.filter fun y => s.cursor < y.2 :=
      List.mem_filter.mpr ⟨hm, by simp; omega⟩
    have := repOf_ge this; omega
  -- the base check: what the answer does not report was already below the cursor
  have := admit_inv hi a ha hrep (a.delta.filter fun y => s.cursor < y.2)
    (fun x hx h1 h2 => hd x hx (by omega) h2 (by omega))
    (max s.cursor a.rev) (by omega)
  exact this

/-! ## Every other event -/

/-- What a landing flush leaves in the rows: what was there, or its own
    commit dated at itself. -/
theorem flush_rows {s : St} {g : Flight} {r : Nat} {q : Path} {v r' : Nat}
    (h : (if r < s.reports g.path then upd s.rows g.path none
      else match s.rows g.path with
        | some ⟨_, .own⟩ => upd s.rows g.path (some ⟨r, .dated r⟩)
        | o => upd s.rows g.path o) q = some ⟨v, .dated r'⟩) :
    s.rows q = some ⟨v, .dated r'⟩ ∨ (q = g.path ∧ v = r ∧ r' = r ∧ ¬ r < s.reports g.path) := by
  by_cases hr : r < s.reports g.path
  · rw [if_pos hr] at h
    by_cases e : q = g.path
    · subst e; simp [upd] at h
    · left; simpa [upd, e] using h
  · rw [if_neg hr] at h
    cases hs : s.rows g.path with
    | none =>
      rw [hs] at h
      by_cases e : q = g.path
      · subst e; simp [upd] at h
      · left; simpa [upd, e] using h
    | some row =>
      rcases row with ⟨v0, st⟩
      cases st with
      | own =>
        rw [hs] at h
        by_cases e : q = g.path
        · subst e; simp [upd] at h; right; exact ⟨rfl, h.1.symm, h.2.symm, hr⟩
        · left; simpa [upd, e] using h
      | dated r0 =>
        rw [hs] at h
        by_cases e : q = g.path
        · subst e; simp [upd] at h; left; rw [hs]; simp [h]
        · left; simpa [upd, e] using h

theorem step_inv {s s' : St} (hi : Inv s) (h : Step s s') : Inv s' := by
  have hHle := hi.hLe
  have hcur := hi.cursorLe
  cases h with
  | peerWrite p n hn => exact commit_inv hi p hn
  | trim f _ =>
    exact ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, hi.requestLe, hi.answerOk, hi.listingOk, hi.flightOk, hi.flightLt, hi.parkedLt⟩
  | request =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, ?_, hi.answerOk, hi.listingOk, hi.flightOk, ?_, ?_⟩
    · intro q hq
      rcases List.mem_append.mp hq with hq | hq
      · exact hi.requestLe q hq
      · simp at hq; subst hq; exact hcur
    · intro g hg; have := hi.flightLt g hg; show g.w < s.nextId + 1; omega
    · intro p w hw; have := hi.parkedLt p w hw; show w < s.nextId + 1; omega
  | serve q hq =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, fun q' hq' => hi.requestLe q' (List.mem_of_mem_erase hq'), ?_, hi.listingOk,
      hi.flightOk, hi.flightLt, hi.parkedLt⟩
    intro a ha
    rcases List.mem_append.mp ha with ha | ha
    · exact hi.answerOk a ha
    · simp at ha; subst ha
      refine ⟨fun _ => hi.requestLe q hq, Nat.le_refl _, fun hp x hx hb hr => ?_⟩
      simp only at hp hb hr ⊢
      have hf : ¬ q.2 < s.logFloor := by simpa [poisons] using hp
      have h1 := repOf_ge (deltaFrom_covers s q.2 hf hx hb)
      have h2 := (valAt_spec s.muts x.1 s.rev).2 x hx rfl hr
      unfold last at h1; omega
  | route =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, hi.requestLe, ?_, hi.listingOk, hi.flightOk, ?_, ?_⟩
    · intro a ha
      rcases List.mem_append.mp ha with ha | ha
      · exact hi.answerOk a ha
      · simp at ha; subst ha
        refine ⟨fun h => by simp at h, Nat.le_refl _, fun _ x hx hb hr => ?_⟩
        simp at hb hr; omega
    · intro g hg; have := hi.flightLt g hg; show g.w < s.nextId + 1; omega
    · intro p w hw; have := hi.parkedLt p w hw; show w < s.nextId + 1; omega
  | admitDelta a ha hp hro hrep => exact admitDelta_inv hi ha hp hro hrep
  | admitMono a ha hp hb hrep => exact admitMono_inv hi ha hp hb hrep
  | admitPoison a ha _ hrep =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, ?_, ?_, ?_, hi.requestLe,
      fun b hb => hi.answerOk b (List.mem_of_mem_erase hb), ?_, hi.flightOk, hi.flightLt, hi.parkedLt⟩
    · intro f hf; obtain ⟨g, hg, rfl⟩ := mem_map_eq hf; exact hi.fillRev g hg
    · intro f hf v _; obtain ⟨g, hg, rfl⟩ := mem_map_eq hf; exact Or.inl rfl
    · intro _ f hf; obtain ⟨g, hg, rfl⟩ := mem_map_eq hf; rfl
    · intro L hL; simp at hL
  | join a ha _ =>
    exact ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, hi.requestLe, fun b hb => hi.answerOk b (List.mem_of_mem_erase hb), hi.listingOk,
      hi.flightOk, hi.flightLt, hi.parkedLt⟩
  | list listed hr hl hle =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      fun _ => hi.repairSpoiled (by rw [hr]; simp), hi.requestLe, hi.answerOk, ?_, hi.flightOk, hi.flightLt,
      hi.parkedLt⟩
    intro L hL; simp at hL; subst hL
    exact ⟨Nat.le_refl _, fun _ => hHle, fun h => by simp at h, fun p => hl p, hle⟩
  | reconcile L hr hnr =>
    obtain ⟨l1, l2, _, l4, l5⟩ := hi.listingOk L hr
    have hHL := l2 hnr
    have hsp := hi.repairSpoiled (by rw [hr]; simp)
    -- nothing of `p` was committed after the listing's own revision of it, up to its cursor
    have hlist : ∀ p r, L.listed p ≤ r → NoMut s.muts p r L.cursor := by
      intro p r hlr x hx hxp ⟨a1, a2⟩
      have := (valAt_spec s.muts p L.cursor).2 x hx hxp a2
      have := l4 p; omega
    refine ⟨hi.mutsLe, by show max s.H L.cursor ≤ s.rev; omega, by show s.cursor ≤ max s.H L.cursor; omega,
      ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, hi.flightLt, hi.parkedLt⟩
    · intro p v r h
      simp only at h
      cases hs : s.rows p with
      | none => rw [hs] at h; cases h
      | some row =>
        rcases row with ⟨v', st⟩; cases st with
        | own => rw [hs] at h; simp at h
        | dated r' =>
          rw [hs] at h; simp only at h; split at h
          · cases h
          · injection h with h; injection h with h1 h2; injection h2 with h2; subst h1 h2
            exact hi.rowStamp p v' r' hs
    · intro p v r h
      simp only at h
      cases hs : s.rows p with
      | none => rw [hs] at h; cases h
      | some row =>
        rcases row with ⟨v', st⟩; cases st with
        | own => rw [hs] at h; simp at h
        | dated r' =>
          rw [hs] at h; simp only at h; split at h
          · cases h
          · rename_i hk
            injection h with h; injection h with h1 h2; injection h2 with h2; subst h1 h2
            have hf := hi.rowFresh p v' r' hs
            refine ⟨hf.1, ?_⟩
            show NoMut s.muts p v' (max r' (max s.H L.cursor))
            apply noMut_join hf.2
            have := hlist p r' (by omega)
            intro x hx hxp ⟨a1, a2⟩
            exact this x hx hxp ⟨by omega, by omega⟩
    · intro f hf; have := hi.fillRev f hf; show f.rev ≤ max s.H L.cursor; omega
    · intro f hf v _; exact Or.inl (hsp f hf)
    · intro _ f hf; exact hsp f hf
    · intro q hq; have := hi.requestLe q hq; show q.2 ≤ max s.H L.cursor; omega
    · intro a ha; obtain ⟨h1, h2, h3⟩ := hi.answerOk a ha
      exact ⟨fun h => by have := h1 h; show a.base ≤ max s.H L.cursor; omega, h2, h3⟩
    · intro L' hL'; simp at hL'; subst hL'
      exact ⟨l1, fun h => by simp at h, fun _ => by show L.cursor ≤ max s.H L.cursor; omega, l4, l5⟩
    · intro g hg r hrr
      obtain ⟨h1, h2, h3⟩ := hi.flightOk g hg r hrr
      refine ⟨h1, h2, fun hpk0 => ?_⟩
      have hpk : s.parked g.path = some g.w := hpk0
      have hpk' : s.parked g.path ≠ none := by rw [hpk]; simp
      show r < (if s.parked g.path ≠ none ∧ s.reports g.path < L.listed g.path then L.listed g.path
          else s.reports g.path) ∨ NoMut s.muts g.path r (max r (max s.H L.cursor))
      by_cases hlr : r < L.listed g.path
      · left; split
        · exact hlr
        · rename_i hn; have : ¬ s.reports g.path < L.listed g.path := fun h => hn ⟨hpk', h⟩
          omega
      · rcases h3 hpk with h | h
        · left; split <;> omega
        · right
          apply noMut_join h
          have := hlist g.path r (by omega)
          intro x hx hxp ⟨a1, a2⟩
          exact this x hx hxp ⟨by omega, by omega⟩
  | refill L p hr hrc hnone =>
    obtain ⟨l1, _, _, _, l5⟩ := hi.listingOk L hr
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, ?_, ?_, hi.fillRev, hi.fillFresh, hi.repairSpoiled, hi.requestLe,
      hi.answerOk, hi.listingOk, hi.flightOk, hi.flightLt, hi.parkedLt⟩
    · intro q v r h
      simp only [upd] at h; split at h
      · injection h with h; injection h with h1 h2; injection h2 with h2; subst h2
        have := l5 p; show L.listed p ≤ s.rev; omega
      · exact hi.rowStamp q v r h
    · intro q v r h
      simp only [upd] at h; split at h
      · rename_i e; subst e
        injection h with h; injection h with h1 h2; injection h2 with h2; subst h1 h2
        refine ⟨?_, ?_⟩
        · rcases (valAt_spec s.muts q s.rev).1 with h | h
          · exact Or.inl h
          · exact Or.inr h.1
        · have := l5 q
          show NoMut s.muts q (valAt s.muts q s.rev) (max (L.listed q) s.H)
          exact noMut_mono (noMut_valAt s.muts q s.rev) (Nat.le_refl _) (by omega)
      · exact hi.rowFresh q v r h
  | publish L hr hrc =>
    obtain ⟨_, _, l3, _, _⟩ := hi.listingOk L hr
    exact ⟨hi.mutsLe, hi.hLe, l3 hrc, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      fun h => absurd rfl h, hi.requestLe, hi.answerOk, fun L' h => by simp at h, hi.flightOk, hi.flightLt,
      hi.parkedLt⟩
  | issueFill p hr =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, ?_, ?_, fun h => absurd hr h,
      hi.requestLe, hi.answerOk, hi.listingOk, hi.flightOk, ?_, ?_⟩
    · intro f hf; rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillRev f hf
      · simp at hf; subst hf; exact hcur
    · intro f hf v hv; rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillFresh f hf v hv
      · simp at hf; subst hf; simp at hv
    · intro g hg; have := hi.flightLt g hg; show g.w < s.nextId + 1; omega
    · intro q w hw; have := hi.parkedLt q w hw; show w < s.nextId + 1; omega
  | serveFill f hf hns =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, ?_, ?_, ?_, hi.requestLe,
      hi.answerOk, hi.listingOk, hi.flightOk, hi.flightLt, hi.parkedLt⟩
    · intro g hg; obtain ⟨g0, hg0, rfl⟩ := mem_map_eq hg
      split
      · rename_i e; subst e; exact hi.fillRev g0 hf
      · exact hi.fillRev g0 hg0
    · intro g hg v hv; obtain ⟨g0, hg0, rfl⟩ := mem_map_eq hg
      by_cases e : g0 = f
      · subst e
        simp only [if_pos rfl] at hv ⊢
        simp at hv; subst hv
        right; right
        refine ⟨?_, ?_⟩
        · rcases (valAt_spec s.muts g0.path s.rev).1 with h | h
          · exact Or.inl h
          · exact Or.inr h.1
        · have := hi.fillRev g0 hf
          show NoMut s.muts g0.path (valAt s.muts g0.path s.rev) (max g0.rev s.H)
          exact noMut_mono (noMut_valAt s.muts g0.path s.rev) (Nat.le_refl _) (by omega)
      · simp only [if_neg e] at hv ⊢
        exact hi.fillFresh g0 hg0 v hv
    · intro hr g hg; obtain ⟨g0, hg0, rfl⟩ := mem_map_eq hg
      split
      · rename_i e; subst e; exact hi.repairSpoiled hr g0 hf
      · exact hi.repairSpoiled hr g0 hg0
  | landFill f v hf hv =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, ?_, ?_, fun g hg => hi.fillRev g (List.mem_of_mem_erase hg),
      fun g hg => hi.fillFresh g (List.mem_of_mem_erase hg), fun hr g hg => hi.repairSpoiled hr g (List.mem_of_mem_erase hg),
      hi.requestLe, hi.answerOk, hi.listingOk, hi.flightOk, hi.flightLt, hi.parkedLt⟩
    · intro q w r h
      simp only at h; split at h
      · simp only [upd] at h; split at h
        · injection h with h; injection h with h1 h2; injection h2 with h2; subst h2
          have := hi.fillRev f hf; show f.rev ≤ s.rev; omega
        · exact hi.rowStamp q w r h
      · exact hi.rowStamp q w r h
    · intro q w r h
      simp only at h; split at h
      · rename_i hc
        simp only [upd] at h; split at h
        · rename_i e; subst e
          injection h with h; injection h with h1 h2; injection h2 with h2; subst h1 h2
          rcases hi.fillFresh f hf v hv with h' | h' | h'
          · rw [hc.1] at h'; cases h'
          · exact absurd hc.2.1 (by omega)
          · exact h'
        · exact hi.rowFresh q w r h
      · exact hi.rowFresh q w r h
  | writeSync p =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, ?_, ?_, hi.fillRev, hi.fillFresh, hi.repairSpoiled,
      hi.requestLe, hi.answerOk, hi.listingOk, ?_, ?_, ?_⟩
    · intro q v r h; simp only [upd] at h; split at h
      · simp at h
      · exact hi.rowStamp q v r h
    · intro q v r h; simp only [upd] at h; split at h
      · simp at h
      · exact hi.rowFresh q v r h
    · intro g hg r hr
      obtain ⟨h1, h2, h3⟩ := hi.flightOk g hg r hr
      refine ⟨h1, h2, fun hpk => ?_⟩
      simp only [upd] at hpk; split at hpk
      · injection hpk with hpk; have := hi.flightLt g hg; omega
      · exact h3 hpk
    · intro g hg; have := hi.flightLt g hg; show g.w < s.nextId + 1; omega
    · intro q w hw; simp only [upd] at hw; split at hw
      · injection hw with hw; subst hw; show s.nextId < s.nextId + 1; omega
      · have := hi.parkedLt q w hw; show w < s.nextId + 1; omega
  | flushSend p w hw _ =>
    refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
      hi.repairSpoiled, hi.requestLe, hi.answerOk, hi.listingOk, ?_, ?_, hi.parkedLt⟩
    · intro g hg r hr; rcases List.mem_append.mp hg with hg | hg
      · exact hi.flightOk g hg r hr
      · simp at hg; subst hg; simp at hr
    · intro g hg; rcases List.mem_append.mp hg with hg | hg
      · exact hi.flightLt g hg
      · simp at hg; subst hg; exact hi.parkedLt p w hw
  | flushCommit g n hg hnc hn =>
    have hc := commit_inv hi g.path hn
    refine ⟨hc.mutsLe, hc.hLe, hc.cursorLe, hc.rowStamp, hc.rowFresh, hc.fillRev, hc.fillFresh,
      hc.repairSpoiled, hc.requestLe, hc.answerOk, hc.listingOk, ?_, ?_, hc.parkedLt⟩
    · intro x hx r hr
      obtain ⟨x0, hx0, rfl⟩ := mem_map_eq hx
      split at hr
      · rename_i e; subst e
        simp at hr; subst hr
        refine ⟨List.mem_append_right _ (by simp), Nat.le_refl _, fun _ => Or.inr ?_⟩
        intro y _ _ ⟨a1, a2⟩; have := hi.hLe; simp only [commitMut] at a1 a2; omega
      · rename_i e
        have hx0' : x0 ∈ ({ commitMut s g.path n with flights := s.flights } : St).flights := hx0
        split
        · rename_i e'; exact absurd e' e
        · exact hc.flightOk x0 hx0' r hr
    · intro x hx; obtain ⟨x0, hx0, rfl⟩ := mem_map_eq hx
      split
      · rename_i e; subst e; exact hi.flightLt x0 hg
      · exact hi.flightLt x0 hx0
  | flushLand g r hg hr =>
    obtain ⟨hm, hrle, hfl⟩ := hi.flightOk g hg r hr
    split
    · rename_i hpk
      refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, ?_, ?_, hi.fillRev, hi.fillFresh, hi.repairSpoiled,
        hi.requestLe, hi.answerOk, hi.listingOk, ?_, fun x hx => hi.flightLt x (List.mem_of_mem_erase hx), ?_⟩
      · intro q v r' h
        rcases flush_rows h with h | ⟨_, _, rfl, _⟩
        · exact hi.rowStamp q v r' h
        · exact hrle
      · intro q v r' h
        rcases flush_rows h with h | ⟨e, rfl, rfl, hnot⟩
        · exact hi.rowFresh q v r' h
        · subst e
          refine ⟨Or.inr hm, ?_⟩
          rcases hfl hpk with h' | h'
          · exact absurd h' hnot
          · exact h'
      · intro x hx r' hr'
        have hx0 := List.mem_of_mem_erase hx
        obtain ⟨h1, h2, h3⟩ := hi.flightOk x hx0 r' hr'
        refine ⟨h1, h2, fun hpk' => ?_⟩
        simp only [upd] at hpk' ⊢; split at hpk'
        · simp at hpk'
        · rename_i e; rw [if_neg e]; exact h3 hpk'
      · intro q w hw; simp only [upd] at hw; split at hw
        · simp at hw
        · exact hi.parkedLt q w hw
    · exact ⟨hi.mutsLe, hi.hLe, hi.cursorLe, hi.rowStamp, hi.rowFresh, hi.fillRev, hi.fillFresh,
        hi.repairSpoiled, hi.requestLe, hi.answerOk, hi.listingOk,
        fun x hx => hi.flightOk x (List.mem_of_mem_erase hx), fun x hx => hi.flightLt x (List.mem_of_mem_erase hx),
        hi.parkedLt⟩

theorem reachable_inv {s : St} (h : Reachable s) : Inv s := by
  induction h with
  | init => exact init_inv
  | step _ hs ih => exact step_inv ih hs

end Nimbus.Coherence.Store
