/-
  The resident cache over a composite namespace. Launch walks and reads may
  install undated mounted bytes. A sync read can serve them until reconciliation;
  revision 0 never supplies clock evidence that they are still current.

  Freshness after a barrier applies to dated entries with the serving backend's
  own coherence guarantee. Reconciliation also retains own writes, equal readable
  content, and rows a short listing cannot judge. Those are separate evidence,
  not a comparison with revision 0. Backend/path keys abstract routing identity;
  the runtime's composite-path rows reconcile when that identity changes.
-/

namespace Nimbus.Vfs.CompositeCache

abbrev Path := List String
abbrev Backend := Nat

structure Sys where
  hist : Backend → Path → Nat → Nat
  changes : Backend → Bool
  route : Nat → Path → Backend × Path

structure Entry where
  key : Backend × Path
  value : Nat
  rev : Nat
  own : Bool := false
  deriving DecidableEq

structure Cache where
  entries : List Entry
  H : Backend → Nat

inductive Read where
  | value (v rev : Nat)
  | eagain
  deriving DecidableEq

def syncRead (S : Sys) (C : Cache) (now : Nat) (p : Path) : Read :=
  match C.entries.find? (·.key == S.route now p) with
  | some e => .value e.value e.rev
  | none => .eagain

def install (C : Cache) (e : Entry) : Cache :=
  { C with entries := e :: C.entries.filter (·.key != e.key) }

/-- Dated entries have the backend's no-stale guarantee; an undated observation
    makes no assertion about the backend's horizon. -/
def BackendFresh (S : Sys) (C : Cache) (now : Nat) : Prop :=
  ∀ e ∈ C.entries, 0 < e.rev → ∃ t, C.H e.key.1 ≤ t ∧ t ≤ now ∧ S.hist e.key.1 e.key.2 t = e.value

theorem sync_read_fresh (S : Sys) (C : Cache) (now T : Nat) (hf : BackendFresh S C now)
    (hbar : ∀ b, S.changes b = true → T ≤ C.H b)
    (hdated : ∀ e ∈ C.entries, 0 < e.rev → S.changes e.key.1 = true)
    (p : Path) (v rev : Nat) (hd : 0 < rev) (h : syncRead S C now p = .value v rev) :
    ∃ t, T ≤ t ∧ t ≤ now ∧ S.hist (S.route now p).1 (S.route now p).2 t = v := by
  unfold syncRead at h
  cases hx : C.entries.find? (·.key == S.route now p) with
  | none => rw [hx] at h; cases h
  | some e =>
    rw [hx] at h
    cases h
    have hk : e.key = S.route now p := by simpa using List.find?_some hx
    have hm := List.mem_of_find?_eq_some hx
    obtain ⟨t, h1, h2, h3⟩ := hf e hm hd
    refine ⟨t, Nat.le_trans (hbar e.key.1 (hdated e hm hd)) h1, h2, ?_⟩
    simpa [hk] using h3

def clockVouches (comparable : Bool) (listed held : Nat) : Bool :=
  comparable && decide (0 < listed) && decide (listed ≤ held)

structure Listing where
  complete : Bool
  comparable : Bool
  revision : Backend × Path → Nat
  sameReadableContent : Entry → Bool

def keep (L : Listing) (e : Entry) : Bool :=
  e.own || !L.complete || clockVouches L.comparable (L.revision e.key) e.rev || L.sameReadableContent e

def reconcile (C : Cache) (L : Listing) : Cache :=
  { C with entries := C.entries.filter (keep L) }

inductive Step (S : Sys) : Cache → Cache → Prop
  | stage (C : Cache) (e : Entry) (hd : 0 < e.rev → S.changes e.key.1 = true) : Step S C (install C e)
  | evict (C : Cache) (k : Backend × Path) : Step S C { C with entries := C.entries.filter (·.key != k) }
  | barrier (C : Cache) (H' : Backend → Nat) (h : ∀ b, C.H b ≤ H' b) : Step S C { C with H := H' }
  | reconcile (C : Cache) (L : Listing) : Step S C (reconcile C L)

inductive Reachable (S : Sys) : Cache → Prop
  | init : Reachable S ⟨[], fun _ => 0⟩
  | step {C C' : Cache} : Reachable S C → Step S C C' → Reachable S C'

theorem unfed_entries_undated (S : Sys) {C : Cache} (h : Reachable S C) :
    ∀ e ∈ C.entries, S.changes e.key.1 = false → e.rev = 0 := by
  induction h with
  | init => intro e he; cases he
  | step _ hs ih =>
    cases hs with
    | stage e hd =>
      intro x hx hc
      rcases List.mem_cons.mp hx with rfl | hx
      · by_cases hz : x.rev = 0
        · exact hz
        · have := hd (Nat.pos_of_ne_zero hz); rw [hc] at this; cases this
      · exact ih x (List.mem_filter.mp hx).1 hc
    | evict k => intro e he; exact ih e (List.mem_filter.mp he).1
    | barrier H' _ => exact ih
    | reconcile L => intro e he; exact ih e (List.mem_filter.mp he).1

theorem revision_zero_never_vouches (comparable : Bool) (held : Nat) :
    clockVouches comparable 0 held = false := by simp [clockVouches]

theorem undated_reconcile_drops (C : Cache) (L : Listing) (e : Entry)
    (hc : L.complete = true) (hr : L.revision e.key = 0)
    (ho : e.own = false) (hk : L.sameReadableContent e = false) : e ∉ (reconcile C L).entries := by
  intro h
  have := (List.mem_filter.mp h).2
  simp [keep, hc, hr, ho, hk, revision_zero_never_vouches] at this

theorem reconcile_preserves_other_evidence (C : Cache) (L : Listing) (e : Entry) (he : e ∈ C.entries)
    (h : e.own = true ∨ L.complete = false ∨ L.sameReadableContent e = true) :
    e ∈ (reconcile C L).entries := by
  apply List.mem_filter.mpr
  refine ⟨he, ?_⟩
  rcases h with h | h | h <;> simp [keep, h]

theorem sync_read_installed (S : Sys) (C : Cache) (now : Nat) (p : Path) (e : Entry)
    (hr : S.route now p = e.key) : syncRead S (install C e) now p = .value e.value e.rev := by
  simp [syncRead, install, hr]

/-- This is a reachable cache, not a freshness promise: an external unfed write
    has no incremental record to invalidate the old observation. -/
theorem undated_can_be_stale :
    let S : Sys := {
      hist := fun _ _ t => if t = 0 then 1 else 2
      changes := fun _ => false
      route := fun _ p => (1, p) }
    let C := install ⟨[], fun _ => 0⟩ ⟨(1, ["x"]), 1, 0, false⟩
    Reachable S C ∧ syncRead S C 1 ["x"] = .value 1 0 ∧ S.hist 1 ["x"] 1 = 2 := by
  exact ⟨Reachable.step .init (.stage _ _ (by intro h; exact (Nat.not_lt_zero _ h).elim)), by decide, rfl⟩

theorem a_path_keyed_cache_serves_the_old_backend :
    let S : Sys := {
      hist := fun b _ _ => if b = 1 then 5 else 7
      changes := fun _ => true
      route := fun t p => (if t = 0 then 1 else 2, p.drop 1) }
    let staged : List (Path × Nat) := [(["pc", "x"], S.hist (S.route 0 ["pc", "x"]).1 ["x"] 0)]
    (staged.find? (·.1 == ["pc", "x"])).map (·.2) = some 5 ∧
      ∀ t, S.hist (S.route 1 ["pc", "x"]).1 (S.route 1 ["pc", "x"]).2 t ≠ 5 := by
  refine ⟨by decide, fun t => by simp⟩

end Nimbus.Vfs.CompositeCache
