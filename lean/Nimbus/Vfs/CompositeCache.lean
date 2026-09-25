/-
  Nimbus.Vfs.CompositeCache — the node facet's staged store over a `CompositeVFS`
  (DESIGN.md §4): content is staged only from a backend that offers `changes`,
  keyed by that backend and its own relative path; a sync read routes first, then
  serves the staged entry, and misses (the named EAGAIN) otherwise.

  Each backend with `changes` brings its own no-stale guarantee
  (`Nimbus.Coherence.Store.no_stale_read` for SqliteVFS): every entry staged from it
  holds a value it had at some instant at or after its own horizon, and a barrier
  moves every such horizon to the barrier's instant or later. From those
  hypotheses alone:

  - `sync_read_fresh`: a sync read at a resumption returns a value the backend now
    serving the path held at some instant at or after the barrier, whatever the
    mount table did in between (mounts, unmounts, a source answering a different
    backend);
  - `never_cached`: a backend without `changes` is never staged;
  - `a_path_keyed_cache_serves_the_old_backend`: keying the store by composite path
    instead serves the previous backend's bytes after the source switches.
-/

namespace Nimbus.Vfs.CompositeCache

abbrev Path := List String
abbrev Backend := Nat

structure Sys where
  /-- A backend's value for a relative path at an instant. -/
  hist : Backend → Path → Nat → Nat
  changes : Backend → Bool
  /-- Where the composite routes a path at an instant (the table may change). -/
  route : Nat → Path → Backend × Path

structure Cache where
  entries : List ((Backend × Path) × Nat)
  /-- Each backend's horizon: its newest admitted answer. -/
  H : Backend → Nat

inductive Read where
  | value (v : Nat)
  | eagain

def syncRead (S : Sys) (C : Cache) (now : Nat) (p : Path) : Read :=
  let (b, rp) := S.route now p
  if S.changes b then
    match C.entries.find? (·.1 == (b, rp)) with
    | some (_, v) => .value v
    | none => .eagain
  else .eagain

/-- Each backend's own guarantee, as its coherence proof states it. -/
def BackendFresh (S : Sys) (C : Cache) (now : Nat) : Prop :=
  ∀ b rp v, ((b, rp), v) ∈ C.entries → ∃ t, C.H b ≤ t ∧ t ≤ now ∧ S.hist b rp t = v

theorem sync_read_fresh (S : Sys) (C : Cache) (now T : Nat) (hf : BackendFresh S C now)
    (hbar : ∀ b, S.changes b = true → T ≤ C.H b) (p : Path) (v : Nat) (h : syncRead S C now p = .value v) :
    ∃ t, T ≤ t ∧ t ≤ now ∧ S.hist (S.route now p).1 (S.route now p).2 t = v := by
  unfold syncRead at h
  generalize hr : S.route now p = r at h ⊢
  obtain ⟨b, rp⟩ := r
  simp only at h ⊢
  split at h
  · rename_i hc
    cases hx : C.entries.find? (·.1 == (b, rp)) with
    | none => rw [hx] at h; cases h
    | some x =>
      rw [hx] at h; cases h
      have hk : x.1 = (b, rp) := by simpa using List.find?_some hx
      have hm : ((b, rp), x.2) ∈ C.entries := by rw [← hk]; exact List.mem_of_find?_eq_some hx
      obtain ⟨t, h1, h2, h3⟩ := hf b rp x.2 hm
      exact ⟨t, Nat.le_trans (hbar b hc) h1, h2, h3⟩
  · cases h

/-- Staging, barriers and mount-table changes: the store only ever holds entries
    from backends with `changes`. -/
inductive Step (S : Sys) : Cache → Cache → Prop
  | stage (C : Cache) (b : Backend) (rp : Path) (v : Nat) : S.changes b = true →
      Step S C { C with entries := C.entries ++ [((b, rp), v)] }
  | evict (C : Cache) (k : Backend × Path) : Step S C { C with entries := C.entries.filter (·.1 != k) }
  | barrier (C : Cache) (H' : Backend → Nat) : (∀ b, C.H b ≤ H' b) → Step S C { C with H := H' }

inductive Reachable (S : Sys) : Cache → Prop
  | init : Reachable S ⟨[], fun _ => 0⟩
  | step {C C' : Cache} : Reachable S C → Step S C C' → Reachable S C'

theorem never_cached (S : Sys) {C : Cache} (h : Reachable S C) : ∀ e ∈ C.entries, S.changes e.1.1 = true := by
  induction h with
  | init => intro e he; cases he
  | step _ hs ih =>
    cases hs with
    | stage b rp v hc =>
      intro e he
      rcases List.mem_append.mp he with he | he
      · exact ih e he
      · simp at he; subst he; exact hc
    | evict k => intro e he; exact ih e (List.mem_filter.mp he).1
    | barrier H' _ => exact ih

/-- A store keyed by composite path: `/pc/x` staged while `/pc` served backend 1
    (value 5); the source now answers backend 2, whose `x` has always been 7. The
    keyed-by-path read returns 5, a value backend 2 never held. -/
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
