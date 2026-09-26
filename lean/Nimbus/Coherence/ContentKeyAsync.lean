/-
  Nimbus.Coherence.ContentKeyAsync — `ContentKey`'s rules with ACQUIRE and repair
  split into the events the code has, interleaving freely with commits, other
  answers, fills and each other:

  - a barrier asks from the facet's horizon; the authority serves at some later
    instant (each entry: a path committed after the base, its newest revision and
    the key of its bytes then); the facet admits the answer later still;
  - admission (NodeNoMirror's 4c8871bb-style rule): an answer at or below the
    horizon changes nothing; otherwise, for each named row older than its entry,
    keep and re-date it when the keys match, drop it otherwise; reads in flight
    note the entry; the horizon moves to the answer. While a repair runs, an
    answer is dropped (the barrier joins the repair);
  - a repair starts (a poison, or a new incarnation) and spoils every read in
    flight; its listing is served at some instant (per path: newest revision and
    key then); later the facet reconciles every row against it by key alone and
    moves the horizon to the listing's cursor; refills install paths the
    reconcile left empty; the repair publishes.

  Proved (`no_stale_read`), assuming only equal key ⇒ equal bytes: every dated
  row holds bytes the authority held at some instant at or after the horizon.
-/

import Nimbus.Coherence.ContentKey

namespace Nimbus.Coherence.ContentKeyAsync

open Nimbus.Coherence.ContentKey (Path Bytes Row Fill bytesAt lastRev NoMut upd bytesAt_eq lastRev_spec
  le_lastRev noMut_extend noMut_append bytesAt_append)

/-- An answer: its base, the instant it was served at, and its entries
    (path, newest revision, key). -/
structure Answer where
  base : Nat
  rev : Nat
  entries : List (Path × Nat × Nat)

structure Listing where
  cursor : Nat
  revs : Path → Nat
  keys : Path → Nat

structure St where
  rev : Nat
  muts : List (Path × Nat × Bytes)
  rows : Path → Option Row
  fills : List Fill
  H : Nat
  requests : List Nat
  answers : List Answer
  /-- `none`: no repair; `some none`: waiting for the listing. -/
  repair : Option (Option (Listing × Bool))

variable (key : Bytes → Nat)

def entryOf (a : Answer) (p : Path) : Option (Nat × Nat) := (a.entries.find? (·.1 == p)).map (·.2)

def admitRow (a : Answer) (p : Path) (o : Option Row) : Option Row :=
  match o, entryOf a p with
  | some r, some (e, k) => if r.date < e then (if key r.bytes = k then some ⟨r.bytes, e⟩ else none) else some r
  | o, _ => o

def admitFill (a : Answer) (f : Fill) : Fill :=
  match entryOf a f.path with
  | some (e, _) => { f with reported := max f.reported e }
  | none => f

def reconRow (L : Listing) (p : Path) (o : Option Row) : Option Row :=
  match o with
  | some r => if key r.bytes = L.keys p then some ⟨r.bytes, L.revs p⟩ else none
  | none => none

inductive Step : St → St → Prop
  | commit (s : St) (p : Path) (b : Bytes) (n : Nat) : s.rev < n →
      Step s { s with rev := n, muts := s.muts ++ [(p, n, b)] }
  | request (s : St) : Step s { s with requests := s.requests ++ [s.H] }
  | serve (s : St) (c : Nat) : c ∈ s.requests →
      Step s { s with
        requests := s.requests.erase c
        answers := s.answers ++ [⟨c, s.rev, (s.muts.filter fun x => c < x.2.1).map fun x =>
          (x.1, lastRev s.muts x.1 s.rev, key (bytesAt s.muts x.1 s.rev))⟩] }
  | admitStale (s : St) (i : Nat) (a : Answer) : s.answers[i]? = some a → a.rev ≤ s.H →
      Step s { s with answers := s.answers.eraseIdx i }
  | admit (s : St) (i : Nat) (a : Answer) : s.answers[i]? = some a → s.H < a.rev → s.repair = none →
      Step s { s with
        answers := s.answers.eraseIdx i
        rows := fun p => admitRow key a p (s.rows p)
        fills := s.fills.map (admitFill a)
        H := a.rev }
  | join (s : St) (i : Nat) (a : Answer) : s.answers[i]? = some a → s.repair ≠ none →
      Step s { s with answers := s.answers.eraseIdx i }
  | repairStart (s : St) : s.repair = none →
      Step s { s with repair := some none, fills := s.fills.map fun f => { f with spoiled := true } }
  | list (s : St) : s.repair = some none →
      Step s { s with repair := some (some (⟨s.rev, fun p => lastRev s.muts p s.rev,
        fun p => key (bytesAt s.muts p s.rev)⟩, false)) }
  | reconcile (s : St) (L : Listing) : s.repair = some (some (L, false)) →
      Step s { s with
        rows := fun p => reconRow key L p (s.rows p)
        H := max s.H L.cursor
        repair := some (some (L, true)) }
  | refill (s : St) (L : Listing) (p : Path) : s.repair = some (some (L, true)) → s.rows p = none →
      Step s { s with rows := upd s.rows p (some ⟨bytesAt s.muts p s.rev, L.revs p⟩) }
  | publish (s : St) (L : Listing) : s.repair = some (some (L, true)) → Step s { s with repair := none }
  | issue (s : St) (p : Path) : s.repair = none → Step s { s with fills := s.fills ++ [⟨p, s.H, 0, false, none⟩] }
  | fetch (s : St) (f : Fill) : f ∈ s.fills → f.served = none →
      Step s { s with fills := s.fills.map fun g => if g = f then { f with served := some (bytesAt s.muts f.path s.rev, s.rev) } else g }
  | copy (s : St) (f : Fill) (q : Path) (r : Row) : f ∈ s.fills → f.served = none → s.rows q = some r →
      key r.bytes = key (bytesAt s.muts f.path s.rev) →
      Step s { s with fills := s.fills.map fun g => if g = f then { f with served := some (r.bytes, s.rev) } else g }
  | land (s : St) (f : Fill) (b : Bytes) (R : Nat) : f ∈ s.fills → f.served = some (b, R) →
      Step s { s with
        fills := s.fills.erase f
        rows := if f.spoiled = false ∧ f.reported ≤ f.rev ∧ (s.rows f.path).all (fun r => decide (r.date ≤ f.rev))
          then upd s.rows f.path (some ⟨b, f.rev⟩) else s.rows }

def init : St :=
  { rev := 0, muts := [], rows := fun _ => none, fills := [], H := 0, requests := [], answers := [], repair := none }

inductive Reachable : St → Prop
  | init : Reachable init
  | step {s s' : St} : Reachable s → Step key s s' → Reachable s'

def Good (s : St) (p : Path) (b : Bytes) (r : Nat) : Prop :=
  ∃ u, u ≤ s.rev ∧ bytesAt s.muts p u = b ∧ NoMut s.muts p u (max r s.H)

def AnswerOk (s : St) (a : Answer) : Prop :=
  a.rev ≤ s.rev ∧
  (∀ y ∈ a.entries, y.2.1 = lastRev s.muts y.1 a.rev ∧ y.2.2 = key (bytesAt s.muts y.1 a.rev)) ∧
  (∀ x ∈ s.muts, a.base < x.2.1 → x.2.1 ≤ a.rev → ∃ y ∈ a.entries, y.1 = x.1)

def ListingOk (s : St) (L : Listing) : Prop :=
  L.cursor ≤ s.rev ∧ (∀ p, L.revs p = lastRev s.muts p L.cursor) ∧ (∀ p, L.keys p = key (bytesAt s.muts p L.cursor))

structure Inv (s : St) : Prop where
  mutsLe : ∀ x ∈ s.muts, x.2.1 ≤ s.rev
  hLe : s.H ≤ s.rev
  rowDate : ∀ p r, s.rows p = some r → r.date ≤ s.rev
  rowGood : ∀ p r, s.rows p = some r → Good s p r.bytes r.date
  fillRev : ∀ f ∈ s.fills, f.rev ≤ s.H
  fillGood : ∀ f ∈ s.fills, ∀ b R, f.served = some (b, R) →
    f.spoiled = true ∨ f.rev < f.reported ∨ (R ≤ s.rev ∧ bytesAt s.muts f.path R = b ∧ NoMut s.muts f.path R (max f.rev s.H))
  reqLe : ∀ c ∈ s.requests, c ≤ s.H
  answers : ∀ a ∈ s.answers, a.base ≤ s.H ∧ AnswerOk key s a
  repairSpoiled : s.repair ≠ none → ∀ f ∈ s.fills, f.spoiled = true
  listing : ∀ L b, s.repair = some (some (L, b)) → ListingOk key s L ∧ (b = false → s.H ≤ L.cursor) ∧
    (b = true → s.H = max s.H L.cursor)

/-! ## Lemmas -/

theorem lastRev_append {muts : List (Path × Nat × Bytes)} {p : Path} {t : Nat} {y : Path × Nat × Bytes}
    (hy : t < y.2.1) : lastRev (muts ++ [y]) p t = lastRev muts p t := by
  unfold lastRev; rw [List.foldl_append]; simp only [List.foldl_cons, List.foldl_nil]
  split
  · rename_i h; omega
  · rfl

theorem entryOf_spec {a : Answer} {p : Path} {e k : Nat} (h : entryOf a p = some (e, k)) :
    (p, e, k) ∈ a.entries := by
  unfold entryOf at h
  cases hf : a.entries.find? (·.1 == p) with
  | none => rw [hf] at h; cases h
  | some y =>
    rw [hf] at h; simp at h
    have hm := List.mem_of_find?_eq_some hf
    have hp := List.find?_some hf
    simp at hp
    have : y = (p, e, k) := by
      obtain ⟨y1, y2, y3⟩ := y; simp at hp h; subst hp; rw [h.1, h.2]
    rw [← this]; exact hm

theorem entryOf_none {a : Answer} {p : Path} (h : entryOf a p = none) : ∀ y ∈ a.entries, y.1 ≠ p := by
  unfold entryOf at h
  cases hf : a.entries.find? (·.1 == p) with
  | none =>
    intro y hy e
    have := List.find?_eq_none.mp hf y hy
    simp [e] at this
  | some y => rw [hf] at h; cases h

variable {key}

theorem answer_append {s : St} {a : Answer} (ha : AnswerOk key s a) {y : Path × Nat × Bytes}
    (hy : s.rev < y.2.1) : AnswerOk key { s with rev := y.2.1, muts := s.muts ++ [y] } a := by
  obtain ⟨h1, h2, h3⟩ := ha
  refine ⟨by show a.rev ≤ y.2.1; omega, fun z hz => ?_, fun x hx hb hr => ?_⟩
  · obtain ⟨e1, e2⟩ := h2 z hz
    show z.2.1 = lastRev (s.muts ++ [y]) z.1 a.rev ∧ z.2.2 = key (bytesAt (s.muts ++ [y]) z.1 a.rev)
    rw [lastRev_append (by omega), bytesAt_append (by omega)]; exact ⟨e1, e2⟩
  · rcases List.mem_append.mp hx with hx | hx
    · exact h3 x hx hb hr
    · simp at hx; subst hx; simp at hr; omega

theorem step_inv (hkey : ∀ a b, key a = key b → a = b) {s s' : St} (hi : Inv key s) (h : Step key s s') :
    Inv key s' := by
  have hHle := hi.hLe
  cases h with
  | commit p b n hn =>
    refine ⟨?_, by show s.H ≤ n; omega, fun q r h => by have := hi.rowDate q r h; show r.date ≤ n; omega,
      fun q r hr => ?_, hi.fillRev, fun f hf b' R hs => ?_, hi.reqLe, fun a ha => ?_, hi.repairSpoiled, ?_⟩
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
    · obtain ⟨h1, h2⟩ := hi.answers a ha
      exact ⟨h1, answer_append (y := (p, n, b)) h2 hn⟩
    · intro L b' hL
      obtain ⟨⟨l1, l2, l3⟩, l4, l5⟩ := hi.listing L b' hL
      refine ⟨⟨by show L.cursor ≤ n; omega, fun q => ?_, fun q => ?_⟩, l4, l5⟩
      · show L.revs q = lastRev (s.muts ++ [(p, n, b)]) q L.cursor
        rw [lastRev_append (by show L.cursor < n; omega)]; exact l2 q
      · show L.keys q = key (bytesAt (s.muts ++ [(p, n, b)]) q L.cursor)
        rw [bytesAt_append (by show L.cursor < n; omega)]; exact l3 q
  | request =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood, fun c hc => ?_, hi.answers,
      hi.repairSpoiled, hi.listing⟩
    rcases List.mem_append.mp hc with hc | hc
    · exact hi.reqLe c hc
    · simp at hc; subst hc; exact Nat.le_refl _
  | serve c hc =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood,
      fun c' hc' => hi.reqLe c' (List.mem_of_mem_erase hc'), fun a ha => ?_, hi.repairSpoiled, hi.listing⟩
    rcases List.mem_append.mp ha with ha | ha
    · exact hi.answers a ha
    · simp at ha; subst ha
      refine ⟨hi.reqLe c hc, Nat.le_refl _, fun y hy => ?_, fun x hx hb _ => ?_⟩
      · obtain ⟨x, _, rfl⟩ := List.mem_map.mp hy
        exact ⟨rfl, rfl⟩
      · exact ⟨_, List.mem_map.mpr ⟨x, List.mem_filter.mpr ⟨hx, by simpa using hb⟩, rfl⟩, rfl⟩
  | admitStale i a _ _ =>
    exact ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood, hi.reqLe,
      fun b hb => hi.answers b (List.mem_of_mem_eraseIdx hb), hi.repairSpoiled, hi.listing⟩
  | join i a _ _ =>
    exact ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood, hi.reqLe,
      fun b hb => hi.answers b (List.mem_of_mem_eraseIdx hb), hi.repairSpoiled, hi.listing⟩
  | admit i a hai hgt hrep =>
    have ha : a ∈ s.answers := List.mem_of_getElem? hai
    obtain ⟨hbase, ⟨ar, aent, acov⟩⟩ := hi.answers a ha
    -- a commit of `p` after the horizon, up to the answer, is named at or above itself
    have hcov : ∀ p x, x ∈ s.muts → x.1 = p → s.H < x.2.1 → x.2.1 ≤ a.rev →
        ∃ e k, entryOf a p = some (e, k) ∧ x.2.1 ≤ e := by
      intro p x hx hp hH hr
      obtain ⟨y, hy, hyp⟩ := acov x hx (by omega) hr
      cases he : entryOf a p with
      | none => exact absurd (hyp.trans hp) (entryOf_none he y hy)
      | some ek =>
        obtain ⟨e, k⟩ := ek
        have hm := entryOf_spec he
        have := (aent _ hm).1
        simp only at this
        refine ⟨e, k, rfl, ?_⟩
        rw [this]; exact le_lastRev hx hp hr
    have hent : ∀ p e k, entryOf a p = some (e, k) → e = lastRev s.muts p a.rev ∧ k = key (bytesAt s.muts p a.rev) :=
      fun p e k he => aent _ (entryOf_spec he)
    refine ⟨hi.mutsLe, by show a.rev ≤ s.rev; exact ar, ?_, ?_, ?_, ?_, ?_, ?_, fun h => absurd hrep h,
      fun L b h => by simp [hrep] at h⟩
    · intro q r hq
      change admitRow key a q (s.rows q) = some r at hq
      unfold admitRow at hq
      cases hr0 : s.rows q with
      | none => rw [hr0] at hq; cases entryOf a q <;> cases hq
      | some r0 =>
        rw [hr0] at hq
        cases he : entryOf a q with
        | none => rw [he] at hq; cases hq; exact hi.rowDate q _ hr0
        | some ek =>
          obtain ⟨e, k⟩ := ek
          rw [he] at hq; simp only at hq
          split at hq
          · split at hq
            · cases hq; rw [(hent q e k he).1]; exact Nat.le_trans (lastRev_spec s.muts q a.rev).1 ar
            · cases hq
          · cases hq; exact hi.rowDate q _ hr0
    · intro q r hq
      change admitRow key a q (s.rows q) = some r at hq
      show ∃ u, u ≤ s.rev ∧ bytesAt s.muts q u = r.bytes ∧ NoMut s.muts q u (max r.date a.rev)
      unfold admitRow at hq
      cases hr0 : s.rows q with
      | none => rw [hr0] at hq; cases entryOf a q <;> cases hq
      | some r0 =>
        rw [hr0] at hq
        obtain ⟨u, hu, hb, hno⟩ := hi.rowGood q r0 hr0
        have hd0 := hi.rowDate q r0 hr0
        cases he : entryOf a q with
        | none =>
          rw [he] at hq; cases hq
          refine ⟨u, hu, hb, noMut_extend hno ?_⟩
          intro x hx hp ⟨l, rr⟩
          obtain ⟨e, k, he', _⟩ := hcov q x hx hp (by omega) (by omega)
          rw [he] at he'; cases he'
        | some ek =>
          obtain ⟨e, k⟩ := ek
          rw [he] at hq; simp only at hq
          obtain ⟨he1, he2⟩ := hent q e k he
          split at hq
          · split at hq
            · rename_i _ hk
              cases hq
              refine ⟨a.rev, ar, ?_, ?_⟩
              · rw [he2] at hk; exact (hkey _ _ hk).symm
              · have := (lastRev_spec s.muts q a.rev).1
                intro x hx hp ⟨l, rr⟩; simp only at rr; omega
            · cases hq
          · rename_i hge
            cases hq
            refine ⟨u, hu, hb, noMut_extend hno ?_⟩
            intro x hx hp ⟨l, rr⟩
            obtain ⟨e', k', he', hle⟩ := hcov q x hx hp (by omega) (by omega)
            rw [he] at he'; injection he' with he'; injection he' with he'; subst he'
            omega
    · intro f hf
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf
      have := hi.fillRev g hg
      unfold admitFill; split <;> (simp only; omega)
    · intro f hf b R hs
      obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf
      have hs' : g.served = some (b, R) := by unfold admitFill at hs; split at hs <;> exact hs
      have hfr := hi.fillRev g hg
      unfold admitFill
      rcases hi.fillGood g hg b R hs' with h | h | ⟨hR, hb, hno⟩
      · left; split <;> exact h
      · right; left; split
        · show g.rev < max g.reported _; omega
        · exact h
      · cases he : entryOf a g.path with
        | none =>
          simp only
          right; right
          refine ⟨hR, hb, noMut_extend hno ?_⟩
          intro x hx hp ⟨l, rr⟩
          obtain ⟨e, k, he', _⟩ := hcov g.path x hx hp (by omega) (by omega)
          rw [he] at he'; cases he'
        | some ek =>
          obtain ⟨e, k⟩ := ek
          simp only
          by_cases hlt : g.rev < e
          · right; left; show g.rev < max g.reported e; omega
          · right; right
            refine ⟨hR, hb, noMut_extend hno ?_⟩
            intro x hx hp ⟨l, rr⟩
            obtain ⟨e', k', he', hle⟩ := hcov g.path x hx hp (by omega) (by omega)
            rw [he] at he'; injection he' with he'; injection he' with he'; subst he'
            omega
    · intro c hc; have := hi.reqLe c hc; show c ≤ a.rev; omega
    · intro b hb
      obtain ⟨h1, h2⟩ := hi.answers b (List.mem_of_mem_eraseIdx hb)
      exact ⟨by show b.base ≤ a.rev; omega, h2⟩
  | repairStart hrep =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_, hi.reqLe, hi.answers, ?_, ?_⟩
    · intro f hf; obtain ⟨g, hg, rfl⟩ := List.mem_map.mp hf; exact hi.fillRev g hg
    · intro f hf _ _ _; obtain ⟨g, _, rfl⟩ := List.mem_map.mp hf; exact Or.inl rfl
    · intro _ f hf; obtain ⟨g, _, rfl⟩ := List.mem_map.mp hf; rfl
    · intro L b h; simp at h
  | list hrep =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood, hi.reqLe, hi.answers,
      fun _ => hi.repairSpoiled (by rw [hrep]; simp), ?_⟩
    intro L b h; simp at h; obtain ⟨rfl, rfl⟩ := h
    exact ⟨⟨Nat.le_refl _, fun _ => rfl, fun _ => rfl⟩, fun _ => hHle, fun h => by cases h⟩
  | reconcile L hL =>
    obtain ⟨⟨l1, l2, l3⟩, l4, _⟩ := hi.listing L false hL
    have hHL := l4 rfl
    have hsp := hi.repairSpoiled (by rw [hL]; simp)
    refine ⟨hi.mutsLe, by show max s.H L.cursor ≤ s.rev; omega, ?_, ?_, ?_, fun f hf _ _ _ => Or.inl (hsp f hf),
      fun c hc => by have := hi.reqLe c hc; show c ≤ max s.H L.cursor; omega,
      fun a ha => by obtain ⟨h1, h2⟩ := hi.answers a ha; exact ⟨by show a.base ≤ max s.H L.cursor; omega, h2⟩,
      fun _ => hsp, ?_⟩
    · intro q r hq
      change reconRow key L q (s.rows q) = some r at hq
      unfold reconRow at hq
      cases hr0 : s.rows q with
      | none => rw [hr0] at hq; cases hq
      | some r0 =>
        rw [hr0] at hq; simp only at hq
        split at hq
        · cases hq; rw [l2 q]; exact Nat.le_trans (lastRev_spec s.muts q L.cursor).1 l1
        · cases hq
    · intro q r hq
      change reconRow key L q (s.rows q) = some r at hq
      show ∃ u, u ≤ s.rev ∧ bytesAt s.muts q u = r.bytes ∧ NoMut s.muts q u (max r.date (max s.H L.cursor))
      unfold reconRow at hq
      cases hr0 : s.rows q with
      | none => rw [hr0] at hq; cases hq
      | some r0 =>
        rw [hr0] at hq; simp only at hq
        split at hq
        · rename_i hk
          cases hq
          refine ⟨L.cursor, l1, by rw [l3 q] at hk; exact (hkey _ _ hk).symm, ?_⟩
          have := (lastRev_spec s.muts q L.cursor).1
          rw [l2 q]
          intro x hx hp ⟨l, rr⟩; simp only at rr; omega
        · cases hq
    · intro f hf; have := hi.fillRev f hf; show f.rev ≤ max s.H L.cursor; omega
    · intro L' b h; simp at h; obtain ⟨rfl, rfl⟩ := h
      refine ⟨⟨l1, l2, l3⟩, (fun h => by cases h), fun _ => ?_⟩
      show max s.H L.cursor = max (max s.H L.cursor) L.cursor; omega
  | refill L p hL _ =>
    obtain ⟨⟨l1, l2, _⟩, _, l5⟩ := hi.listing L true hL
    have hHL := l5 rfl
    refine ⟨hi.mutsLe, hi.hLe, ?_, ?_, hi.fillRev, hi.fillGood, hi.reqLe, hi.answers, hi.repairSpoiled, hi.listing⟩
    · intro q r hq
      simp only [upd] at hq; split at hq
      · cases hq; rename_i e; subst e
        rw [l2 q]; exact Nat.le_trans (lastRev_spec s.muts q L.cursor).1 l1
      · exact hi.rowDate q r hq
    · intro q r hq
      simp only [upd] at hq; split at hq
      · rename_i e; subst e; cases hq
        refine ⟨s.rev, Nat.le_refl _, rfl, ?_⟩
        have := (lastRev_spec s.muts q L.cursor).1
        intro x hx _ ⟨l, _⟩; have := hi.mutsLe x hx; omega
      · exact hi.rowGood q r hq
  | publish L hL =>
    exact ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, hi.fillRev, hi.fillGood, hi.reqLe, hi.answers,
      fun h => absurd rfl h, fun L b h => by cases h⟩
  | issue p hrep =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_, hi.reqLe, hi.answers, fun h => absurd hrep h,
      hi.listing⟩
    · intro f hf
      rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillRev f hf
      · simp at hf; subst hf; exact Nat.le_refl _
    · intro f hf b R hs
      rcases List.mem_append.mp hf with hf | hf
      · exact hi.fillGood f hf b R hs
      · simp at hf; subst hf; cases hs
  | fetch f hf _ =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_, hi.reqLe, hi.answers, ?_, hi.listing⟩
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
        simp only [if_pos rfl]
        right; right
        have := hi.fillRev g0 hf
        refine ⟨Nat.le_refl _, rfl, ?_⟩
        intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
      · simp only [if_neg e] at hs ⊢
        exact hi.fillGood g0 hg0 b R hs
    · intro hr g hg
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      split
      · rename_i e; subst e; exact hi.repairSpoiled hr g0 hf
      · exact hi.repairSpoiled hr g0 hg0
  | copy f q r hf _ hq hk =>
    refine ⟨hi.mutsLe, hi.hLe, hi.rowDate, hi.rowGood, ?_, ?_, hi.reqLe, hi.answers, ?_, hi.listing⟩
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
        simp only [if_pos rfl]
        right; right
        have := hi.fillRev g0 hf
        refine ⟨Nat.le_refl _, (hkey _ _ hk).symm, ?_⟩
        intro x hx _ ⟨a, _⟩; have := hi.mutsLe x hx; omega
      · simp only [if_neg e] at hs ⊢
        exact hi.fillGood g0 hg0 b R hs
    · intro hr g hg
      obtain ⟨g0, hg0, rfl⟩ := List.mem_map.mp hg
      split
      · rename_i e; subst e; exact hi.repairSpoiled hr g0 hf
      · exact hi.repairSpoiled hr g0 hg0
  | land f b R hf hs =>
    refine ⟨hi.mutsLe, hi.hLe, ?_, ?_, fun g hg => hi.fillRev g (List.mem_of_mem_erase hg),
      fun g hg => hi.fillGood g (List.mem_of_mem_erase hg), hi.reqLe, hi.answers,
      fun hr g hg => hi.repairSpoiled hr g (List.mem_of_mem_erase hg), hi.listing⟩
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

theorem reachable_inv (hkey : ∀ a b, key a = key b → a = b) {s : St} (h : Reachable key s) : Inv key s := by
  induction h with
  | init =>
    exact ⟨(fun _ h => by cases h), Nat.le_refl _, (fun _ _ h => by cases h), (fun _ _ h => by cases h),
      (fun _ h => by cases h), (fun _ h => by cases h), (fun _ h => by cases h), (fun _ h => by cases h),
      (fun h => absurd rfl h), (fun _ _ h => by cases h)⟩
  | step _ hs ih => exact step_inv hkey ih hs

/-- No stale read under any interleaving of commits, answers served and admitted
    in any order, repairs, fills and copies by key. -/
theorem no_stale_read (hkey : ∀ a b, key a = key b → a = b) {s : St} (h : Reachable key s) {p : Path} {r : Row}
    (hr : s.rows p = some r) : ∃ t, s.H ≤ t ∧ t ≤ s.rev ∧ bytesAt s.muts p t = r.bytes := by
  have hi := reachable_inv hkey h
  obtain ⟨u, hu, hb, hno⟩ := hi.rowGood p r hr
  have := hi.rowDate p r hr
  have := hi.hLe
  by_cases e : max r.date s.H ≤ u
  · exact ⟨u, by omega, hu, hb⟩
  · exact ⟨max r.date s.H, by omega, by omega, by rw [bytesAt_eq (by omega) hno]; exact hb⟩

end Nimbus.Coherence.ContentKeyAsync
