/-
  Nimbus.Vfs.ProcessFiles — the process-binding layer over the composite
  (DESIGN.md §3: `bind`, descriptors, `releaseProcess`, mutation leases, write
  receipts).

  (1) Durability accounting (`acked_accounted`). A descriptor on a backend with
  `writeRange` writes through: a write is acknowledged only after the backend call
  returned. Without it the handle buffers, up to a byte cap (EFBIG past it, not
  acknowledged). A flush moves a handle's pending writes to the backend, or — when
  it fails — to the loss report the process (or, for a killed one, its supervisor)
  receives. `releaseProcess` flushes every handle, each flush succeeding or
  failing; a kill reports every pending write lost. Every acknowledged write is at
  every instant applied, pending on a live handle, or reported lost; a kill that
  drops pending writes breaks it (`a_kill_that_drops_buffers_loses_silently`).

  (2) Atomicity. What is atomic is one backend call. With `writeRange`, one write
  is one call. An `O_APPEND` write whose end-of-file offset is taken in the same
  call as the write (`appendAtomic`) never overlaps another append
  (`atomic_appends_disjoint`); one that reads the size and writes in two calls
  can (`a_two_step_append_overwrites`). A buffered handle's flush reads the file
  and writes it back; when the backend is asynchronous another flush can land in
  between and its bytes are overwritten (`a_buffered_flush_overwrites_a_concurrent_flush`):
  concurrent descriptors on a buffered backend are last-flush-wins, per byte
  range only when the backend is synchronous.

  (3) Mutation leases (`leases_hold`). Every mutation is checked, for each path it
  names, on the literal path and on the path after root-link resolution, by
  overlap; each mutation touches only subtrees rooted at those, so no mutation of
  another owner's leased subtree passes. Checking the literal path alone lets a
  write through a link reach the lease (`a_literal_only_check_is_bypassed`).

  (4) Write receipts (`receipt_sound`). A receipt `{before, after}` taken in the
  commit's own step names the commit; any `after` at or above it with no later
  commit of the path in between still names the committed bytes, which is what
  `Coherence.Store`'s stamping needs. A receipt read after a later commit of the
  path does not (`a_late_receipt_names_another_write`).
-/

import Nimbus.Coherence.StoreSafety

namespace Nimbus.Vfs.ProcessFiles

/-! ## (1) Durability accounting -/

structure Fd where
  id : Nat
  pid : Nat
  buffered : Bool
  pending : List Nat
  deriving DecidableEq

structure St where
  fds : List Fd
  acked : List Nat
  applied : List Nat
  lost : List Nat
  next : Nat

def cap : Nat := 4

def flushTo (ok : Bool) (s : St) (f : Fd) : St :=
  if ok then { s with applied := s.applied ++ f.pending } else { s with lost := s.lost ++ f.pending }

/-- `dropOnKill`: the defect under test (a kill discards pending writes). -/
inductive Step (dropOnKill : Bool) : St → St → Prop
  | open_ (s : St) (pid : Nat) (buffered : Bool) :
      Step dropOnKill s { s with fds := s.fds ++ [⟨s.next, pid, buffered, []⟩], next := s.next + 1 }
  | writeThrough (s : St) (f : Fd) : f ∈ s.fds → f.buffered = false →
      Step dropOnKill s { s with acked := s.acked ++ [s.next], applied := s.applied ++ [s.next], next := s.next + 1 }
  | writeBuffered (s : St) (f : Fd) : f ∈ s.fds → f.buffered = true → f.pending.length < cap →
      Step dropOnKill s { s with
        fds := s.fds.map fun g => if g = f then { f with pending := f.pending ++ [s.next] } else g
        acked := s.acked ++ [s.next]
        next := s.next + 1 }
  /-- fsync or close: the pending writes reach the backend, or the flush fails and
      they are reported lost to the caller. -/
  | flush (s : St) (f : Fd) (ok : Bool) : f ∈ s.fds →
      Step dropOnKill s { flushTo ok s f with fds := s.fds.map fun g => if g = f then { f with pending := [] } else g }
  | close (s : St) (f : Fd) : f ∈ s.fds → f.pending = [] → Step dropOnKill s { s with fds := s.fds.erase f }
  /-- `releaseProcess`: every handle of the process is flushed (each with its own
      outcome) and closed. -/
  | release (s : St) (pid : Nat) (ok : Nat → Bool) :
      Step dropOnKill s { s with
        fds := s.fds.filter (·.pid != pid)
        applied := s.applied ++ (s.fds.filter fun f => f.pid == pid && ok f.id).flatMap (·.pending)
        lost := s.lost ++ (s.fds.filter fun f => f.pid == pid && !ok f.id).flatMap (·.pending) }
  /-- A killed process: nothing can flush; its pending writes are reported lost. -/
  | kill (s : St) (pid : Nat) :
      Step dropOnKill s { s with
        fds := s.fds.filter (·.pid != pid)
        lost := if dropOnKill then s.lost else s.lost ++ (s.fds.filter (·.pid == pid)).flatMap (·.pending) }

def init : St := ⟨[], [], [], [], 0⟩

inductive Reachable (d : Bool) : St → Prop
  | init : Reachable d init
  | step {s s' : St} : Reachable d s → Step d s s' → Reachable d s'

def Accounted (s : St) (i : Nat) : Prop := i ∈ s.applied ∨ i ∈ s.lost ∨ ∃ f ∈ s.fds, i ∈ f.pending

theorem mem_map_upd {f f' : Fd} {l : List Fd} (hf : f ∈ l) : f' ∈ l.map (fun g => if g = f then f' else g) :=
  List.mem_map.mpr ⟨f, hf, by simp⟩

theorem mem_map_keep {f f' g : Fd} {l : List Fd} (hg : g ∈ l) (hne : g ≠ f) :
    g ∈ l.map (fun x => if x = f then f' else x) :=
  List.mem_map.mpr ⟨g, hg, by simp [hne]⟩

theorem step_accounted {s s' : St} (h : Step false s s') (hs : ∀ i ∈ s.acked, Accounted s i) :
    ∀ i ∈ s'.acked, Accounted s' i := by
  cases h with
  | open_ pid b =>
    intro i hi
    rcases hs i hi with h | h | ⟨f, hf, hp⟩
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr ⟨f, List.mem_append_left _ hf, hp⟩)
  | writeThrough f _ _ =>
    intro i hi
    rcases List.mem_append.mp hi with hi | hi
    · rcases hs i hi with h | h | ⟨g, hg, hp⟩
      · exact Or.inl (List.mem_append_left _ h)
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr ⟨g, hg, hp⟩)
    · simp at hi; subst hi; exact Or.inl (List.mem_append_right _ (by simp))
  | writeBuffered f hf _ _ =>
    intro i hi
    rcases List.mem_append.mp hi with hi | hi
    · rcases hs i hi with h | h | ⟨g, hg, hp⟩
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · right; right
        by_cases e : g = f
        · subst e; exact ⟨_, mem_map_upd hg, List.mem_append_left _ hp⟩
        · exact ⟨g, mem_map_keep hg e, hp⟩
    · simp at hi; subst hi
      exact Or.inr (Or.inr ⟨_, mem_map_upd hf, List.mem_append_right _ (by simp)⟩)
  | flush f ok hf =>
    intro i hi
    have hi' : i ∈ s.acked := by unfold flushTo at hi; split at hi <;> exact hi
    rcases hs i hi' with h | h | ⟨g, hg, hp⟩
    · left; unfold flushTo; split
      · exact List.mem_append_left _ h
      · exact h
    · right; left; unfold flushTo; split
      · exact h
      · exact List.mem_append_left _ h
    · by_cases e : g = f
      · subst e
        unfold flushTo; split
        · exact Or.inl (List.mem_append_right _ hp)
        · exact Or.inr (Or.inl (List.mem_append_right _ hp))
      · right; right
        refine ⟨g, ?_, hp⟩
        unfold flushTo; split <;> exact mem_map_keep hg e
  | close f hf hp0 =>
    intro i hi
    rcases hs i hi with h | h | ⟨g, hg, hp⟩
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · by_cases e : g = f
      · subst e; rw [hp0] at hp; cases hp
      · exact Or.inr (Or.inr ⟨g, (List.mem_erase_of_ne e).mpr hg, hp⟩)
  | release pid ok =>
    intro i hi
    rcases hs i hi with h | h | ⟨g, hg, hp⟩
    · exact Or.inl (List.mem_append_left _ h)
    · exact Or.inr (Or.inl (List.mem_append_left _ h))
    · by_cases e : g.pid = pid
      · by_cases o : ok g.id = true
        · left; apply List.mem_append_right
          exact List.mem_flatMap.mpr ⟨g, List.mem_filter.mpr ⟨hg, by simp [e, o]⟩, hp⟩
        · right; left; apply List.mem_append_right
          exact List.mem_flatMap.mpr ⟨g, List.mem_filter.mpr ⟨hg, by simp [e, o]⟩, hp⟩
      · exact Or.inr (Or.inr ⟨g, List.mem_filter.mpr ⟨hg, by simp [e]⟩, hp⟩)
  | kill pid =>
    intro i hi
    rcases hs i hi with h | h | ⟨g, hg, hp⟩
    · exact Or.inl h
    · exact Or.inr (Or.inl (by simp only [Bool.false_eq_true, if_false]; exact List.mem_append_left _ h))
    · by_cases e : g.pid = pid
      · right; left
        simp only [Bool.false_eq_true, if_false]
        exact List.mem_append_right _ (List.mem_flatMap.mpr ⟨g, List.mem_filter.mpr ⟨hg, by simp [e]⟩, hp⟩)
      · exact Or.inr (Or.inr ⟨g, List.mem_filter.mpr ⟨hg, by simp [e]⟩, hp⟩)

/-- Every acknowledged write is applied, pending on a live handle, or reported
    lost — through flushes, failed flushes, `releaseProcess` and kills. -/
theorem acked_accounted {s : St} (h : Reachable false s) : ∀ i ∈ s.acked, Accounted s i := by
  induction h with
  | init => intro i hi; cases hi
  | step _ hs ih => exact step_accounted hs ih

/-- A kill that discards pending writes loses an acknowledged write silently. -/
theorem a_kill_that_drops_buffers_loses_silently :
    ∃ s, Reachable true s ∧ ∃ i ∈ s.acked, ¬ Accounted s i := by
  have h1 : Reachable true { init with fds := [⟨0, 7, true, []⟩], next := 1 } := .step .init (.open_ init 7 true)
  let s1 : St := { init with fds := [⟨0, 7, true, []⟩], next := 1 }
  have h2 := Reachable.step h1 (.writeBuffered s1 ⟨0, 7, true, []⟩ (by simp [s1]) rfl (by decide))
  have h3 := Reachable.step h2 (.kill _ 7)
  refine ⟨_, h3, 1, by simp [s1], ?_⟩
  intro hacc
  rcases hacc with h | h | ⟨f, hf, _⟩
  · simp [s1, init] at h
  · simp [s1, init] at h
  · simp [s1, init] at hf

/-! ## (2) Appends -/

/-- A backend file's length and the byte ranges appends claimed. -/
structure AppendSt where
  len : Nat
  regions : List (Nat × Nat)
  /-- Two-step appends that read the size and have not written yet. -/
  reads : List (Nat × Nat)

def Disjoint (r s : Nat × Nat) : Prop := r.1 + r.2 ≤ s.1 ∨ s.1 + s.2 ≤ r.1

inductive AppendStep : AppendSt → AppendSt → Prop
  /-- `appendAtomic`: the offset is the length, taken in the write's own call. -/
  | atomic (s : AppendSt) (k : Nat) : AppendStep s { s with len := s.len + k, regions := s.regions ++ [(s.len, k)] }
  /-- Two calls: read the size... -/
  | readSize (s : AppendSt) (k : Nat) : AppendStep s { s with reads := s.reads ++ [(s.len, k)] }
  /-- ...then write there. -/
  | writeAt (s : AppendSt) (r : Nat × Nat) : r ∈ s.reads →
      AppendStep s { s with len := max s.len (r.1 + r.2), regions := s.regions ++ [r], reads := s.reads.erase r }

/-- Only atomic appends: every claimed region ends at or before the length and no
    two overlap. -/
theorem atomic_appends_disjoint :
    ∀ (ks : List Nat) (s : AppendSt), (∀ r ∈ s.regions, r.1 + r.2 ≤ s.len) →
      (s.regions.Pairwise fun a b => a.2 = 0 ∨ b.2 = 0 ∨ Disjoint a b) →
      let t := ks.foldl (fun s k => { s with len := s.len + k, regions := s.regions ++ [(s.len, k)] }) s
      (∀ r ∈ t.regions, r.1 + r.2 ≤ t.len) ∧ (t.regions.Pairwise fun a b => a.2 = 0 ∨ b.2 = 0 ∨ Disjoint a b) := by
  intro ks
  induction ks with
  | nil => intro s h1 h2; exact ⟨h1, h2⟩
  | cons k ks ih =>
    intro s h1 h2
    apply ih
    · intro r hr
      rcases List.mem_append.mp hr with hr | hr
      · have := h1 r hr; show r.1 + r.2 ≤ s.len + k; omega
      · simp at hr; subst hr; exact Nat.le_refl _
    · rw [List.pairwise_append]
      refine ⟨h2, by simp, fun a ha b hb => ?_⟩
      simp at hb; subst hb
      right; right; left; exact h1 a ha

/-- Two two-step appends that read the size before either writes claim the same
    offset: the second overwrites the first. -/
theorem a_two_step_append_overwrites :
    AppendStep ⟨10, [], []⟩ ⟨10, [], [(10, 3)]⟩ ∧ AppendStep ⟨10, [], [(10, 3)]⟩ ⟨10, [], [(10, 3), (10, 4)]⟩ ∧
      ¬ Disjoint (10, 3) (10, 4) :=
  ⟨.readSize ⟨10, [], []⟩ 3, .readSize ⟨10, [], [(10, 3)]⟩ 4, by simp [Disjoint]⟩

/-- A buffered handle's flush reads the file and writes it back whole. Handle A
    flushes byte 1 = 'a' onto a read of [0,0]; handle B read [0,0] before A's
    write landed and writes back [2,0] with its own byte 0: A's acknowledged,
    flushed byte is overwritten. -/
theorem a_buffered_flush_overwrites_a_concurrent_flush :
    let file0 : List Nat := [0, 0]
    let readA := file0
    let readB := file0
    let afterA := readA.set 1 9
    let afterB := readB.set 0 2
    afterA.get? 1 = some 9 ∧ afterB.get? 1 = some 0 := by
  decide

/-! ## (3) Mutation leases -/

abbrev Path := List String

def overlap (a b : Path) : Bool := a.isPrefixOf b || b.isPrefixOf a

/-- One root link (at `link`, to `target`) resolved at a prefix. -/
def resolve (link target : Path) (p : Path) : Path :=
  if link.isPrefixOf p && link != [] then target ++ p.drop link.length else p

/-- What a mutation touches: the subtree roots it changes, each the literal or the
    resolved form of one of its arguments. -/
inductive Mut where
  /-- writeFile, writeRange, truncate, chmod, …: the resolved path. -/
  | throughLink (p : Path)
  /-- unlink, rmdir, rename, symlink, rm -r: the literal entry. -/
  | atEntry (p : Path)
  | rename (a b : Path)

def Mut.args : Mut → List Path
  | .throughLink p | .atEntry p => [p]
  | .rename a b => [a, b]

def touched (link target : Path) : Mut → List Path
  | .throughLink p => [resolve link target p]
  | .atEntry p => [p]
  | .rename a b => [a, b]

/-- The check: every argument, literal and resolved, overlaps no other owner's lease. -/
def allowed (leases : List (Nat × Path)) (owner : Nat) (link target : Path) (checkResolved : Bool) (m : Mut) : Bool :=
  m.args.all fun p =>
    leases.all fun (o, r) => o == owner ||
      (!overlap p r && (!checkResolved || !overlap (resolve link target p) r))

/-- An allowed mutation touches nothing that overlaps another owner's lease. -/
theorem leases_hold (leases : List (Nat × Path)) (owner : Nat) (link target : Path) (m : Mut)
    (h : allowed leases owner link target true m = true) :
    ∀ t ∈ touched link target m, ∀ l ∈ leases, l.1 ≠ owner → overlap t l.2 = false := by
  intro t ht l hl hne
  unfold allowed at h
  have hargs : ∀ p ∈ m.args, !overlap p l.2 = true ∧ !overlap (resolve link target p) l.2 = true := by
    intro p hp
    have := List.all_eq_true.mp (List.all_eq_true.mp h p hp) l hl
    simp [hne] at this
    simpa using this
  cases m with
  | throughLink p =>
    simp [touched] at ht; subst ht
    simpa using (hargs p (by simp [Mut.args])).2
  | atEntry p =>
    simp [touched] at ht; subst ht
    simpa using (hargs t (by simp [Mut.args])).1
  | rename a b =>
    simp [touched] at ht
    rcases ht with rfl | rfl
    · simpa using (hargs t (by simp [Mut.args])).1
    · simpa using (hargs t (by simp [Mut.args])).1

/-- Checking only the literal path: owner 2 writes `/x/f` while owner 1 leases
    `/dst` and `/x` links to `/dst`; the write lands in the lease. -/
theorem a_literal_only_check_is_bypassed :
    allowed [(1, ["dst"])] 2 ["x"] ["dst"] false (.throughLink ["x", "f"]) = true ∧
    overlap (resolve ["x"] ["dst"] ["x", "f"]) ["dst"] = true ∧
    allowed [(1, ["dst"])] 2 ["x"] ["dst"] true (.throughLink ["x", "f"]) = false := by
  decide

/-! ## (4) Write receipts -/

open Nimbus.Coherence.Store (valAt NoMut valAt_spec)

/-- A receipt's `after` at or above the process's own commit, with no later commit
    of the path up to it, names the committed bytes. -/
theorem receipt_sound (muts : List (Nat × Nat)) (p n a : Nat) (hm : (p, n) ∈ muts) (hn : 0 < n) (ha : n ≤ a)
    (hno : NoMut muts p n a) : valAt muts p a = n := by
  obtain ⟨h1, h2⟩ := valAt_spec muts p a
  have hge := h2 (p, n) hm rfl ha
  rcases h1 with h1 | ⟨hmem, hle⟩
  · omega
  · apply Classical.byContradiction; intro hne
    exact hno _ hmem rfl ⟨by simp at hge; omega, hle⟩

/-- A receipt taken in the commit's own step: `after` is the commit. -/
theorem receipt_in_step (muts : List (Nat × Nat)) (p n : Nat) (hn : 0 < n) :
    valAt (muts ++ [(p, n)]) p n = n :=
  receipt_sound _ p n n (by simp) hn (Nat.le_refl _) (fun x hx _ ⟨a, b⟩ => by omega)

/-- A receipt read after a peer committed the path again names the peer's write. -/
theorem a_late_receipt_names_another_write :
    valAt [(0, 1), (0, 2)] 0 2 = 2 ∧ (2 : Nat) ≠ 1 := by decide

end Nimbus.Vfs.ProcessFiles
