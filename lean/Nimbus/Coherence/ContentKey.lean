/-
  Nimbus.Coherence.ContentKey — NodeNoMirror's content-key savings in the resident
  store (work/node-nomirror 04cb9dd9, schema 2: every row carries `ckey`, the
  authority's `contentKey`):

  1. copy by key: a fill takes bytes already held under another path whose key
     equals the key the authority lists for the path, instead of fetching;
  2. keep on same key: a delta entry whose key equals the held row's key keeps
     the row and re-dates it at the entry's revision (chmod, touch, a rewrite with
     the same bytes);
  3. cross-epoch keep: a repair keeps and re-dates every row whose key the
     listing repeats, comparing no revisions (a P5 `rotateIncarnation` makes them
     incomparable).

  The one assumption is content-store P1's key property, stated as the hypothesis
  `hkey : ∀ a b, key a = key b → a = b` (equal key ⇒ equal bytes). Nothing else
  about keys is used.

  Proved (`no_stale_read`): every dated row holds bytes the authority held at some
  instant at or after the horizon — the newest answer admitted. Bytes, not
  commits: a row re-dated by key may name bytes an older commit wrote.

  Abstractions: an ACQUIRE is served and admitted in one step, and a repair lists
  and reconciles in one step (out-of-order answers, the fill ticket against
  in-flight reports, poisons and own writes are `Nimbus.Coherence.Store`'s; this
  model keeps fills in flight with their tickets and adds the key rules).
-/

namespace Nimbus.Coherence.ContentKey

abbrev Path := Nat
abbrev Bytes := Nat

structure Row where
  bytes : Bytes
  date : Nat
  deriving DecidableEq

structure Fill where
  path : Path
  rev : Nat
  reported : Nat
  spoiled : Bool
  /-- The bytes the read returned, and the authority revision it read at. -/
  served : Option (Bytes × Nat)
  deriving DecidableEq

structure St where
  rev : Nat
  /-- Every commit: path, revision, bytes (revisions increase along the list). -/
  muts : List (Path × Nat × Bytes)
  rows : Path → Option Row
  fills : List Fill
  H : Nat

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β := fun y => if y = x then b else f y

/-- The bytes of `p` at instant `t` (0: the initial contents). -/
def bytesAt (muts : List (Path × Nat × Bytes)) (p : Path) (t : Nat) : Bytes :=
  muts.foldl (fun acc x => if x.1 = p ∧ x.2.1 ≤ t then x.2.2 else acc) 0

/-- The newest commit of `p` at or before `t` (0 when none). -/
def lastRev (muts : List (Path × Nat × Bytes)) (p : Path) (t : Nat) : Nat :=
  muts.foldl (fun m x => if x.1 = p ∧ x.2.1 ≤ t ∧ m < x.2.1 then x.2.1 else m) 0

def NoMut (muts : List (Path × Nat × Bytes)) (p : Path) (a b : Nat) : Prop :=
  ∀ x ∈ muts, x.1 = p → ¬ (a < x.2.1 ∧ x.2.1 ≤ b)

variable (key : Bytes → Nat)

/-- The answer's entry for `p`, if any: the newest commit after the horizon, and
    the key of the path's bytes now. -/
def entry (s : St) (p : Path) : Option Nat :=
  if s.H < lastRev s.muts p s.rev then some (lastRev s.muts p s.rev) else none

/-- Rule 2 on one row. -/
def acqRow (s : St) (p : Path) (o : Option Row) : Option Row :=
  match o, entry s p with
  | some r, some e =>
    if r.date < e then (if key r.bytes = key (bytesAt s.muts p s.rev) then some ⟨r.bytes, e⟩ else none)
    else some r
  | o, _ => o

def acqFill (s : St) (f : Fill) : Fill :=
  match entry s f.path with
  | some e => { f with reported := max f.reported e }
  | none => f

inductive Step : St → St → Prop
  | commit (s : St) (p : Path) (b : Bytes) (n : Nat) : s.rev < n →
      Step s { s with rev := n, muts := s.muts ++ [(p, n, b)] }
  /-- ACQUIRE served and admitted: a row older than its path's entry is kept and
      re-dated when the keys match (rule 2), dropped otherwise; reads in flight
      note the entry. -/
  | acquire (s : St) :
      Step s { s with rows := fun p => acqRow key s p (s.rows p), fills := s.fills.map (acqFill s), H := s.rev }
  /-- A repair (a poison, or a new incarnation): the listing's keys decide alone
      (rule 3); every read in flight is spoiled. -/
  | repair (s : St) :
      Step s { s with
        rows := fun p => match s.rows p with
          | some r => if key r.bytes = key (bytesAt s.muts p s.rev) then some ⟨r.bytes, s.rev⟩ else none
          | none => none
        fills := s.fills.map fun f => { f with spoiled := true }
        H := s.rev }
  | issue (s : St) (p : Path) : Step s { s with fills := s.fills ++ [⟨p, s.H, 0, false, none⟩] }
  /-- The authority serves the read. -/
  | fetch (s : St) (f : Fill) : f ∈ s.fills → f.served = none →
      Step s { s with fills := s.fills.map fun g => if g = f then { f with served := some (bytesAt s.muts f.path s.rev, s.rev) } else g }
  /-- Copy by key (rule 1): the listing says the path's key now is that of bytes
      already held under `q`; they are taken instead. -/
  | copy (s : St) (f : Fill) (q : Path) (r : Row) : f ∈ s.fills → f.served = none → s.rows q = some r →
      key r.bytes = key (bytesAt s.muts f.path s.rev) →
      Step s { s with fills := s.fills.map fun g => if g = f then { f with served := some (r.bytes, s.rev) } else g }
  /-- The read lands: installed at its ticket's revision unless outdated. -/
  | land (s : St) (f : Fill) (b : Bytes) (R : Nat) : f ∈ s.fills → f.served = some (b, R) →
      Step s { s with
        fills := s.fills.erase f
        rows := if f.spoiled = false ∧ f.reported ≤ f.rev ∧ (s.rows f.path).all (fun r => decide (r.date ≤ f.rev))
          then upd s.rows f.path (some ⟨b, f.rev⟩) else s.rows }

def init : St := { rev := 0, muts := [], rows := fun _ => none, fills := [], H := 0 }

inductive Reachable : St → Prop
  | init : Reachable init
  | step {s s' : St} : Reachable s → Step key s s' → Reachable s'

/-! ## The authority's history -/

/-- Two instants with no commit of `p` between them see the same bytes. -/
theorem bytesAt_eq {muts : List (Path × Nat × Bytes)} {p : Path} {u w : Nat} (hu : u ≤ w)
    (h : NoMut muts p u w) : bytesAt muts p w = bytesAt muts p u := by
  unfold bytesAt
  suffices ∀ (l : List (Path × Nat × Bytes)) acc, (∀ x ∈ l, x ∈ muts) →
      l.foldl (fun acc x => if x.1 = p ∧ x.2.1 ≤ w then x.2.2 else acc) acc =
      l.foldl (fun acc x => if x.1 = p ∧ x.2.1 ≤ u then x.2.2 else acc) acc from this muts 0 (fun _ h => h)
  intro l
  induction l with
  | nil => intro _ _; rfl
  | cons x l ih =>
    intro acc hl
    simp only [List.foldl_cons]
    have hx := h x (hl x (List.mem_cons_self _ _))
    have e : (x.1 = p ∧ x.2.1 ≤ w) ↔ (x.1 = p ∧ x.2.1 ≤ u) := by
      constructor
      · rintro ⟨h1, h2⟩; exact ⟨h1, Nat.le_of_not_lt fun h3 => hx h1 ⟨h3, h2⟩⟩
      · rintro ⟨h1, h2⟩; exact ⟨h1, by omega⟩
    have ih' := ih (if x.1 = p ∧ x.2.1 ≤ u then x.2.2 else acc) (fun y hy => hl y (List.mem_cons_of_mem _ hy))
    by_cases hw : x.1 = p ∧ x.2.1 ≤ w
    · rw [if_pos hw, if_pos (e.mp hw)]; rw [if_pos (e.mp hw)] at ih'; exact ih'
    · rw [if_neg hw, if_neg (fun h => hw (e.mpr h))]; rw [if_neg (fun h => hw (e.mpr h))] at ih'; exact ih'

theorem lastRev_fold (p : Path) (t : Nat) :
    ∀ (l : List (Path × Nat × Bytes)) (m : Nat),
      let r := l.foldl (fun m x => if x.1 = p ∧ x.2.1 ≤ t ∧ m < x.2.1 then x.2.1 else m) m
      m ≤ r ∧ (r = m ∨ r ≤ t) ∧ ∀ x ∈ l, x.1 = p → x.2.1 ≤ t → x.2.1 ≤ r := by
  intro l
  induction l with
  | nil => intro m; simp
  | cons y l ih =>
    intro m
    simp only [List.foldl_cons]
    split
    · rename_i hy
      obtain ⟨h1, h2, h3⟩ := ih y.2.1
      refine ⟨by omega, Or.inr (by rcases h2 with h2 | h2 <;> omega), ?_⟩
      intro x hx hp ht
      rcases List.mem_cons.mp hx with rfl | hx
      · exact h1
      · exact h3 x hx hp ht
    · rename_i hy
      obtain ⟨h1, h2, h3⟩ := ih m
      refine ⟨h1, h2, ?_⟩
      intro x hx hp ht
      rcases List.mem_cons.mp hx with rfl | hx
      · have : ¬ m < x.2.1 := fun hlt => hy ⟨hp, ht, hlt⟩
        omega
      · exact h3 x hx hp ht

theorem lastRev_spec (muts : List (Path × Nat × Bytes)) (p : Path) (t : Nat) :
    lastRev muts p t ≤ t ∧ NoMut muts p (lastRev muts p t) t := by
  obtain ⟨_, h2, h3⟩ := lastRev_fold p t muts 0
  refine ⟨?_, fun x hx hp ⟨a, b⟩ => ?_⟩
  · rcases h2 with h2 | h2
    · unfold lastRev; rw [h2]; omega
    · exact h2
  · have := h3 x hx hp b; unfold lastRev at a; omega

/-- A commit after the horizon and at or before `t` is at or below the entry. -/
theorem le_lastRev {muts : List (Path × Nat × Bytes)} {p : Path} {t : Nat} {x : Path × Nat × Bytes}
    (hx : x ∈ muts) (hp : x.1 = p) (ht : x.2.1 ≤ t) : x.2.1 ≤ lastRev muts p t :=
  (lastRev_fold p t muts 0).2.2 x hx hp ht

theorem acqRow_some {s : St} {p : Path} {o : Option Row} {r : Row} (h : acqRow key s p o = some r) :
    ∃ r0, o = some r0 ∧
      ((∀ e, entry s p = some e → e ≤ r0.date) ∧ r = r0 ∨
       ∃ e, entry s p = some e ∧ key r0.bytes = key (bytesAt s.muts p s.rev) ∧ r = ⟨r0.bytes, e⟩) := by
  unfold acqRow at h
  cases o with
  | none => cases h : entry s p <;> simp_all
  | some r0 =>
    refine ⟨r0, rfl, ?_⟩
    cases he : entry s p with
    | none => rw [he] at h; simp at h; left; exact ⟨(fun e h' => by cases h'), h.symm⟩
    | some e =>
      rw [he] at h; simp only at h
      by_cases hlt : r0.date < e
      · rw [if_pos hlt] at h
        by_cases hk : key r0.bytes = key (bytesAt s.muts p s.rev)
        · rw [if_pos hk] at h; injection h with h; right; exact ⟨e, rfl, hk, h.symm⟩
        · rw [if_neg hk] at h; cases h
      · rw [if_neg hlt] at h; injection h with h
        left; exact ⟨fun e' he' => by injection he' with he'; subst he'; omega, h.symm⟩

/-! ## The invariant -/

def Good (s : St) (p : Path) (b : Bytes) (r : Nat) : Prop :=
  ∃ u, u ≤ s.rev ∧ bytesAt s.muts p u = b ∧ NoMut s.muts p u (max r s.H)

structure Inv (s : St) : Prop where
  mutsLe : ∀ x ∈ s.muts, x.2.1 ≤ s.rev
  hLe : s.H ≤ s.rev
  rowDate : ∀ p r, s.rows p = some r → r.date ≤ s.rev
  rowGood : ∀ p r, s.rows p = some r → Good s p r.bytes r.date
  fillRev : ∀ f ∈ s.fills, f.rev ≤ s.H
  fillGood : ∀ f ∈ s.fills, ∀ b R, f.served = some (b, R) →
    f.spoiled = true ∨ f.rev < f.reported ∨ (R ≤ s.rev ∧ bytesAt s.muts f.path R = b ∧ NoMut s.muts f.path R (max f.rev s.H))

theorem noMut_extend {muts : List (Path × Nat × Bytes)} {p : Path} {u a b : Nat} (h1 : NoMut muts p u a)
    (h2 : NoMut muts p a b) : NoMut muts p u b := by
  intro x hx hp ⟨l, r⟩
  by_cases e : x.2.1 ≤ a
  · exact h1 x hx hp ⟨l, e⟩
  · exact h2 x hx hp ⟨by omega, r⟩

theorem noMut_append {muts : List (Path × Nat × Bytes)} {p : Path} {u a : Nat} (h : NoMut muts p u a)
    {y : Path × Nat × Bytes} (hy : a < y.2.1) : NoMut (muts ++ [y]) p u a := by
  intro x hx hp ⟨l, r⟩
  rcases List.mem_append.mp hx with hx | hx
  · exact h x hx hp ⟨l, r⟩
  · simp at hx; subst hx; omega

theorem bytesAt_append {muts : List (Path × Nat × Bytes)} {p : Path} {t : Nat} {y : Path × Nat × Bytes}
    (hy : t < y.2.1) : bytesAt (muts ++ [y]) p t = bytesAt muts p t := by
  unfold bytesAt; rw [List.foldl_append]; simp only [List.foldl_cons, List.foldl_nil]
  split
  · rename_i h; omega
  · rfl

variable {key}

theorem step_inv (hkey : ∀ a b, key a = key b → a = b) {s s' : St} (hi : Inv s) (h : Step key s s') : Inv s' := by
  have hHle := hi.hLe
  cases h with
  | commit p b n hn =>
    refine ⟨?_, by show s.H ≤ n; omega, fun q r h => by have := hi.rowDate q r h; show r.date ≤ n; omega,
      fun q r hr => ?_, hi.fillRev, fun f hf b' R hs => ?_⟩
    · intro x hx
      rcases List.mem_append.mp hx with hx | hx
      · have := hi.mutsLe x hx; show x.2.1 ≤ n; omega
      · simp at hx; subst hx; exact Nat.le_refl _
    · obtain ⟨u, hu, hb, hno⟩ := hi.rowGood q r hr
      have := hi.rowDate q r hr
      exact ⟨u, by show u ≤ n; omega, by rw [bytesAt_append (by show u < n; omega)]; exact hb,
        noMut_append hno (by show max r.date s.H < n; omega)⟩
    · rcases hi.fillGood f hf b' R hs with h | h | ⟨hR, hb, hno⟩
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · have := hi.fillRev f hf
        exact Or.inr (Or.inr ⟨by show R ≤ n; omega, by rw [bytesAt_append (by show R < n; omega)]; exact hb,
          noMut_append hno (by show max f.rev s.H < n; omega)⟩)
  | acquire =>
    have hcov : ∀ p x, x ∈ s.muts → x.1 = p → s.H < x.2.1 → entry s p = some (lastRev s.muts p s.rev) ∧
        x.2.1 ≤ lastRev s.muts p s.rev := by
      intro p x hx hp hH
      have hle := le_lastRev hx hp (hi.mutsLe x hx)
      exact ⟨by unfold entry; rw [if_pos (by omega)], hle⟩
    have hent : ∀ p e, entry s p = some e → e = lastRev s.muts p s.rev ∧ s.H < e := by
      intro p e he
      unfold entry at he; split at he
      · injection he with he; exact ⟨he.symm, by rename_i h; omega⟩
      · cases he
    refine ⟨hi.mutsLe, Nat.le_refl _, ?_, ?_, ?_, ?_⟩
    · intro q r hq
      obtain ⟨r0, hr0, h | ⟨e, he, _, rfl⟩⟩ := acqRow_some (key := key) (s := s) (show acqRow key s q (s.rows q) = some r from hq)
      · rw [h.2]; exact hi.rowDate q r0 hr0
      · rw [(hent q e he).1]; exact (lastRev_spec s.muts q s.rev).1
    · intro q r hq
      show ∃ u, u ≤ s.rev ∧ bytesAt s.muts q u = r.bytes ∧ NoMut s.muts q u (max r.date s.rev)
      obtain ⟨r0, hr0, ⟨hge, hr⟩ | ⟨e, he, hk, hr⟩⟩ :=
        acqRow_some (key := key) (s := s) (show acqRow key s q (s.rows q) = some r from hq)
      · rw [hr]
        obtain ⟨u, hu, hb, hno⟩ := hi.rowGood q r0 hr0
        refine ⟨u, hu, hb, noMut_extend hno ?_⟩
        intro x hx hp ⟨a, b⟩
        have := hi.rowDate q r0 hr0
        have hH : s.H < x.2.1 := by omega
        obtain ⟨h1, h2⟩ := hcov q x hx hp hH
        have := hge _ h1
        omega
      · rw [hr]
        refine ⟨s.rev, Nat.le_refl _, (hkey _ _ hk).symm, ?_⟩
        intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
    · intro f hf
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf
      have := hi.fillRev g hg
      unfold acqFill; split <;> (simp only; omega)
    · intro f hf b R hs
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf
      have hs' : g.served = some (b, R) := by unfold acqFill at hs; split at hs <;> exact hs
      unfold acqFill
      rcases hi.fillGood g hg b R hs' with h | h | ⟨hR, hb, hno⟩
      · left; split <;> exact h
      · right; left; split
        · show g.rev < max g.reported _; omega
        · exact h
      · cases he : entry s g.path with
        | none =>
          simp only
          right; right
          refine ⟨hR, hb, noMut_extend hno ?_⟩
          intro x hx hp ⟨a, b'⟩
          have hH : s.H < x.2.1 := by omega
          rw [(hcov g.path x hx hp hH).1] at he; cases he
        | some e =>
          simp only
          have := (hent g.path e he).2
          have := hi.fillRev g hg
          right; left; show g.rev < max g.reported e; omega
  | repair =>
    refine ⟨hi.mutsLe, Nat.le_refl _, ?_, ?_, ?_, ?_⟩
    · intro q r hq
      simp only at hq
      split at hq
      · split at hq
        · injection hq with hq; subst hq; exact Nat.le_refl _
        · cases hq
      · cases hq
    · intro q r hq
      simp only at hq
      split at hq
      · split at hq
        · rename_i hk
          injection hq with hq; subst hq
          refine ⟨s.rev, Nat.le_refl _, (hkey _ _ hk).symm, ?_⟩
          intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
        · cases hq
      · cases hq
    · intro f hf
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf
      have := hi.fillRev g hg; show g.rev ≤ s.rev; omega
    · intro f hf _ _ _
      obtain ⟨g, _, rfl⟩ := List.mem_map.mp hf
      exact Or.inl rfl
  | issue p =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_⟩
    · intro f hf
      rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillRev f hf
      · simp at hf; subst hf; exact Nat.le_refl _
    · intro f hf b R hs
      rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillGood f hf b R hs
      · simp at hf; subst hf; cases hs
  | fetch f hf _ =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_⟩
    · intro g hg
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      split
      · rename_i e; subst e; exact hi.fillRev g0 hf
      · exact hi.fillRev g0 hg0
    · intro g hg b R hs
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      by_cases e : g0 = f
      · subst e
        simp only [if_pos rfl, Option.some.injEq, Prod.mk.injEq] at hs
        obtain ⟨rfl, rfl⟩ := hs
        right; right
        have := hi.fillRev g0 hf
        simp only [if_pos rfl]
        refine ⟨Nat.le_refl _, rfl, ?_⟩
        intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
      · simp only [if_neg e] at hs ⊢
        exact hi.fillGood g0 hg0 b R hs
  | copy f q r hf _ hq hk =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_⟩
    · intro g hg
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      split
      · rename_i e; subst e; exact hi.fillRev g0 hf
      · exact hi.fillRev g0 hg0
    · intro g hg b R hs
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      by_cases e : g0 = f
      · subst e
        simp only [if_pos rfl, Option.some.injEq, Prod.mk.injEq] at hs
        obtain ⟨rfl, rfl⟩ := hs
        right; right
        have := hi.fillRev g0 hf
        simp only [if_pos rfl]
        refine ⟨Nat.le_refl _, (hkey _ _ hk).symm, ?_⟩
        intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
      · simp only [if_neg e] at hs ⊢
        exact hi.fillGood g0 hg0 b R hs
  | land f b R hf hs =>
    refine ⟨hi.mutsLe, hi.hLe, ?_, ?_, fun g hg => hi.fillRev g (List.mem_of_mem_erase hg),
      fun g hg => hi.fillGood g (List.mem_of_mem_erase hg)⟩
    · intro q r hq
      simp only at hq
      split at hq
      · simp only [upd] at hq
        split at hq
        · injection hq with hq; subst hq; have := hi.fillRev f hf; show f.rev ≤ s.rev; omega
        · exact hi.rowDate q r hq
      · exact hi.rowDate q r hq
    · intro q r hq
      simp only at hq
      split at hq
      · rename_i hc
        simp only [upd] at hq
        split at hq
        · rename_i e; subst e
          injection hq with hq; subst hq
          rcases hi.fillGood f hf b R hs with h | h | ⟨hR, hb, hno⟩
          · rw [hc.1] at h; cases h
          · exact absurd hc.2.1 (by omega)
          · exact ⟨R, hR, hb, hno⟩
        · exact hi.rowGood q r hq
      · exact hi.rowGood q r hq

theorem reachable_inv (hkey : ∀ a b, key a = key b → a = b) {s : St} (h : Reachable key s) : Inv s := by
  induction h with
  | init => exact ⟨(fun _ h => by cases h), Nat.le_refl _, (fun _ _ h => by cases h), (fun _ _ h => by cases h),
      (fun _ h => by cases h), (fun _ h => by cases h)⟩
  | step _ hs ih => exact step_inv hkey ih hs

/-- No stale read with the content-key savings, given only P1's key property:
    every dated row holds bytes the authority held at some instant at or after the
    newest admitted answer. -/
theorem no_stale_read (hkey : ∀ a b, key a = key b → a = b) {s : St} (h : Reachable key s) {p : Path} {r : Row}
    (hr : s.rows p = some r) : ∃ t, s.H ≤ t ∧ t ≤ s.rev ∧ bytesAt s.muts p t = r.bytes := by
  have hi := reachable_inv hkey h
  obtain ⟨u, hu, hb, hno⟩ := hi.rowGood p r hr
  have := hi.rowDate p r hr
  have := hi.hLe
  by_cases e : max r.date s.H ≤ u
  · exact ⟨u, by omega, hu, hb⟩
  · exact ⟨max r.date s.H, by omega, by omega, by rw [bytesAt_eq (by omega) hno]; exact hb⟩

/-- Without P1's property the savings serve stale bytes: two different contents
    under one key, and a repair keeps a row whose bytes the path no longer has. -/
theorem a_colliding_key_keeps_a_stale_row :
    let key : Bytes → Nat := fun _ => 0
    ∃ s, Reachable key s ∧ ∃ r, s.rows 0 = some r ∧ ∀ t, s.H ≤ t → t ≤ s.rev → bytesAt s.muts 0 t ≠ r.bytes := by
  intro key
  let s1 : St := { init with fills := [⟨0, 0, 0, false, none⟩] }
  have h1 : Reachable key s1 := .step .init (.issue init 0)
  let s2 : St := { s1 with fills := [⟨0, 0, 0, false, some (0, 0)⟩] }
  have h2 : Reachable key s2 := .step h1 (.fetch s1 ⟨0, 0, 0, false, none⟩ (by simp [s1]) rfl)
  let s3 : St := { s2 with fills := [], rows := upd s2.rows 0 (some ⟨0, 0⟩) }
  have h3 : Reachable key s3 := by
    have := Reachable.step h2 (.land s2 ⟨0, 0, 0, false, some (0, 0)⟩ 0 0 (by simp [s2]) rfl)
    simpa [s3, s2, s1, init] using this
  let s4 : St := { s3 with rev := 1, muts := [(0, 1, 7)] }
  have h4 : Reachable key s4 := by
    have := Reachable.step h3 (.commit s3 0 7 1 (by simp [s3, s2, s1, init]))
    simpa [s4, s3, s2, s1, init] using this
  have h5 := Reachable.step h4 (.repair s4)
  refine ⟨_, h5, ⟨0, 1⟩, by simp [s4, s3, s2, s1, init, upd, key], ?_⟩
  intro t ht _
  simp [s4, s3, s2, s1, init] at ht
  simp [bytesAt, s4]
  omega

end Nimbus.Coherence.ContentKey
