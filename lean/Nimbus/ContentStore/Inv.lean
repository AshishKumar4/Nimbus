/-
  Nimbus.ContentStore.Inv — the invariant, and what one inode write
  (`commit`) does to each part of it.
-/

import Nimbus.ContentStore.Lemmas

namespace Nimbus.ContentStore

variable (P : Nat)

/-- Whatever exists and nothing durable or in flight holds is queued. -/
def Cov (s : St) : Prop := ∀ x, Stored s x → ¬ StrongRef s x → ¬ WriterHeld s x → x ∈ s.queue

/-- The restore job's durable row names a live snapshot, and a clean job has
    restored exactly the snapshot below its cursor. -/
def JobOk (P : Nat) (s : St) : Prop :=
  ∀ j, s.job = some j → (j.name, j.g) ∈ s.snaps ∧ j.cursor ≤ P ∧
    (j.clean = true → ∀ q < j.cursor, s.view q = s.snapView j.name q)

/-- Everything but the queue's coverage and the job: what a state in the
    middle of one transaction still satisfies. -/
structure Base (s : St) : Prop where
  liveGen : ∀ p r, s.live p = some r → r.gen ≤ s.gen
  histGen : ∀ h ∈ s.hist, h.genTo ≤ s.gen
  snapGen : ∀ x ∈ s.snaps, x.2 ≤ s.gen
  /-- A history row ends where the live row of its path began. -/
  histBelowLive : ∀ h ∈ s.hist, ∀ r, s.live h.path = some r → h.genTo ≤ r.gen
  freshChunk : ∀ k, s.nextChunk ≤ k → s.chunks k = none
  freshContent : ∀ c, s.nextContent ≤ c → s.contents c = none
  /-- Every path reads what was last written to it. -/
  liveView : ∀ p, readRef s ((s.live p).map Row.ref) = some (s.view p)
  histLive : ∀ h ∈ s.hist, resolve s h.ref ≠ none
  /-- Every snapshot reads what the tree held when it was taken. -/
  snapView : ∀ x ∈ s.snaps, ∀ p, readRef s (atRef s x.2 p) = some (s.snapView x.1 p)
  /-- Every detached descriptor reads what it read when it was unlinked. -/
  fdView : ∀ f ∈ s.fds, resolve s f.ref = some f.view
  writerView : ∀ w ∈ s.writers, ∃ ct, s.contents w.content = some ct ∧ ct.state = .staging ∧
    ct.chunks.mapM s.chunks = some w.hashes
  writerUnique : ∀ w1 ∈ s.writers, ∀ w2 ∈ s.writers, w1.content = w2.content → w1 = w2
  writerNodup : s.writers.Nodup
  writerUnqueued : ∀ w ∈ s.writers, Ref.content w.content ∉ s.queue
  queueBound : ∀ c, Ref.content c ∈ s.queue → c < s.nextContent
  digestOk : ∀ c ct d, s.contents c = some ct → ct.state = .live → ct.digest = some d →
    ct.chunks.mapM s.chunks = some d

structure Inv (s : St) extends Base s : Prop where
  /-- Leak freedom's half: whatever exists and nothing durable or in flight
      holds is queued. -/
  coverage : Cov s
  jobOk : JobOk P s

/-! ## Reading the invariant -/

theorem liveView_resolve {s : St} (hi : Base s) {p : Path} {r : Row} (h : s.live p = some r) :
    ∃ v, resolve s r.ref = some v ∧ s.view p = some v := by
  have := hi.liveView p
  simp only [h, Option.map_some', readRef] at this
  cases hr : resolve s r.ref with
  | none => simp [hr] at this
  | some v => simp [hr] at this; exact ⟨v, rfl, this.symm⟩

theorem resolve_content_live {s : St} {c : Nat} (h : resolve s (.content c) ≠ none) :
    ∃ ct, s.contents c = some ct ∧ ct.state = .live := by
  cases hr : resolve s (.content c) with
  | none => exact absurd hr h
  | some v => obtain ⟨ct, h1, h2, _⟩ := resolve_live_content hr; exact ⟨ct, h1, h2⟩

/-- A resolvable reference is never a writer's staging content. -/
theorem not_writer_of_resolves {s : St} (hi : Base s) {x : Ref} (h : resolve s x ≠ none) :
    ¬ WriterHeld s x := by
  cases x with
  | chunk k => exact id
  | content c =>
    rintro ⟨w, hw, rfl⟩
    obtain ⟨ct, hct, hl⟩ := resolve_content_live h
    obtain ⟨ct', hct', hs, _⟩ := hi.writerView w hw
    rw [hct] at hct'; cases hct'; rw [hl] at hs; cases hs

theorem exists_of_resolves {s : St} {x : Ref} (h : resolve s x ≠ none) : Stored s x := by
  cases x with
  | chunk k =>
    show s.chunks k ≠ none
    intro hk; apply h; simp [resolve, hk]
  | content c =>
    obtain ⟨ct, hct, _⟩ := resolve_content_live h
    show s.contents c ≠ none
    rw [hct]; simp

theorem content_lt_of_exists {s : St} (hi : Base s) {c : Nat} (h : s.contents c ≠ none) :
    c < s.nextContent := by
  exact Nat.lt_of_not_le fun hn => h (hi.freshContent c hn)

theorem chunk_lt_of_exists {s : St} (hi : Base s) {k : Nat} (h : s.chunks k ≠ none) :
    k < s.nextChunk := by
  exact Nat.lt_of_not_le fun hn => h (hi.freshChunk k hn)

theorem resolve_ne_none {s : St} {x : Ref} {v : List Hash} (h : resolve s x = some v) : resolve s x ≠ none := by
  rw [h]; simp

/-- What `atRef` answers is a live row's or a history row's reference. -/
theorem atRef_mem {s : St} {g : Nat} {p : Path} {x : Ref} (h : atRef s g p = some x) :
    (∃ r, s.live p = some r ∧ r.ref = x) ∨ (∃ hr ∈ s.hist, hr.ref = x) := by
  unfold atRef at h
  cases hf : s.hist.find? (covers g p) with
  | some hr =>
    simp only [hf, Option.some.injEq] at h
    exact Or.inr ⟨hr, List.mem_of_find?_eq_some hf, h⟩
  | none =>
    simp only [hf] at h
    cases hl : s.live p with
    | none => simp [hl] at h
    | some r =>
      simp only [hl] at h
      split at h
      · cases h; exact Or.inl ⟨r, rfl, rfl⟩
      · cases h

/-! ## One inode write -/

theorem commit_live (s : St) (p : Path) (nr : Option Ref) (q : Path) :
    (commit s p nr).live q = if q = p then nr.map (fun ref => ⟨s.gen + 1, ref⟩) else s.live q := by
  simp [commit, upd]

theorem mem_commit_hist {s : St} {p : Path} {nr : Option Ref} {h : HRow} :
    h ∈ (commit s p nr).hist ↔
      h ∈ s.hist ∨ ∃ r, s.live p = some r ∧ r.gen ≤ pinGen s ∧ h = ⟨p, r.gen, s.gen + 1, r.ref⟩ := by
  simp only [commit]
  cases hl : s.live p with
  | none => simp
  | some r =>
    simp only
    split
    · rename_i hr; simp [hr]
    · rename_i hr
      constructor
      · exact Or.inl
      · rintro (h | ⟨r', hr', h1, _⟩)
        · exact h
        · cases hr'; exact absurd h1 hr

theorem mem_commit_queue {s : St} {p : Path} {nr : Option Ref} {x : Ref} :
    x ∈ (commit s p nr).queue ↔
      x ∈ s.queue ∨ ∃ r, s.live p = some r ∧ nr ≠ some r.ref ∧ x = r.ref := by
  simp only [commit]
  cases hl : s.live p with
  | none => simp
  | some r =>
    simp only
    split
    · rename_i he
      constructor
      · exact Or.inl
      · rintro (h | ⟨r', hr', hne, rfl⟩)
        · exact h
        · cases hr'; exact absurd he hne
    · rename_i he
      rw [mem_enq]
      constructor
      · rintro (h | rfl)
        · exact Or.inl h
        · exact Or.inr ⟨r, rfl, he, rfl⟩
      · rintro (h | ⟨r', hr', _, rfl⟩)
        · exact Or.inl h
        · cases hr'; exact Or.inr rfl

theorem commit_liveRef {s : St} {p : Path} {x : Ref} : LiveRef (commit s p (some x)) x :=
  ⟨p, ⟨s.gen + 1, x⟩, by simp [commit_live], rfl⟩

/-- A write loses at most one durable reference: the old row's, which it
    queued unless it rewrote the same reference. -/
theorem commit_lost {s : St} {p : Path} {nr : Option Ref} {x : Ref}
    (hs : StrongRef s x) (hn : ¬ StrongRef (commit s p nr) x) :
    ∃ r, s.live p = some r ∧ r.ref = x ∧ nr ≠ some x := by
  rcases hs with ⟨q, r, hq, rfl⟩ | ⟨h, hh, rfl⟩ | hm
  · by_cases hqp : q = p
    · subst hqp
      refine ⟨r, hq, rfl, ?_⟩
      rintro rfl; exact hn (Or.inl commit_liveRef)
    · exact absurd (Or.inl ⟨q, r, by rw [commit_live, if_neg hqp, hq], rfl⟩) hn
  · exact absurd (Or.inr (Or.inl ⟨h, mem_commit_hist.mpr (Or.inl hh), rfl⟩)) hn
  · exact absurd (Or.inr (Or.inr (by cases x <;> exact hm))) hn

theorem commit_queue_sub {s : St} {p : Path} {nr : Option Ref} {x : Ref} (h : x ∈ s.queue) :
    x ∈ (commit s p nr).queue := mem_commit_queue.mpr (Or.inl h)

/-- The coverage half of the invariant survives a write, whatever the state
    the write starts from, as long as every object it can see existed or is
    referenced by the write itself. -/
theorem commit_coverage {s : St} {p : Path} {nr : Option Ref}
    (hcov : ∀ x, Stored s x → ¬ StrongRef s x → ¬ WriterHeld s x → x ∈ s.queue) :
    ∀ x, Stored s x → ¬ StrongRef (commit s p nr) x → ¬ WriterHeld s x → x ∈ (commit s p nr).queue := by
  intro x hx hn hw
  by_cases hs : StrongRef s x
  · obtain ⟨r, hr, rfl, hne⟩ := commit_lost hs hn
    exact mem_commit_queue.mpr (Or.inr ⟨r, hr, hne, rfl⟩)
  · exact commit_queue_sub (hcov x hx hs hw)

theorem commit_gens {s : St} (hi : Base s) (p : Path) (nr : Option Ref) :
    (∀ q r, (commit s p nr).live q = some r → r.gen ≤ s.gen + 1) ∧
    (∀ h ∈ (commit s p nr).hist, h.genTo ≤ s.gen + 1) ∧
    (∀ h ∈ (commit s p nr).hist, ∀ r, (commit s p nr).live h.path = some r → h.genTo ≤ r.gen) := by
  refine ⟨?_, ?_, ?_⟩
  · intro q r hq
    rw [commit_live] at hq
    split at hq
    · cases nr <;> simp at hq; subst hq; exact Nat.le_refl _
    · have := hi.liveGen q r hq; omega
  · intro h hh
    rcases mem_commit_hist.mp hh with hh | ⟨r, _, _, rfl⟩
    · have := hi.histGen h hh; omega
    · exact Nat.le_refl _
  · intro h hh r hr
    rw [commit_live] at hr
    rcases mem_commit_hist.mp hh with hh' | ⟨r0, _, _, rfl⟩
    · split at hr
      · cases nr <;> simp at hr; subst hr; have := hi.histGen h hh'; simp; omega
      · exact hi.histBelowLive h hh' r hr
    · simp at hr; cases nr <;> simp at hr; subst hr; exact Nat.le_refl _

/-! ## Projections through the ghost updates -/

@[simp] theorem setView_live (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).live = s.live := rfl
@[simp] theorem setView_hist (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).hist = s.hist := rfl
@[simp] theorem setView_snaps (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).snaps = s.snaps := rfl
@[simp] theorem setView_chunks (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).chunks = s.chunks := rfl
@[simp] theorem setView_contents (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).contents = s.contents := rfl
@[simp] theorem setView_queue (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).queue = s.queue := rfl
@[simp] theorem setView_writers (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).writers = s.writers := rfl
@[simp] theorem setView_fds (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).fds = s.fds := rfl
@[simp] theorem setView_job (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).job = s.job := rfl
@[simp] theorem setView_gen (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).gen = s.gen := rfl
@[simp] theorem setView_nextChunk (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).nextChunk = s.nextChunk := rfl
@[simp] theorem setView_nextContent (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).nextContent = s.nextContent := rfl
@[simp] theorem setView_snapView (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).snapView = s.snapView := rfl
@[simp] theorem setView_view (s : St) (p : Path) (v : Option (List Hash)) : (setView s p v).view = upd s.view p v := rfl

@[simp] theorem dirty_live (s : St) : (dirty s).live = s.live := rfl
@[simp] theorem dirty_hist (s : St) : (dirty s).hist = s.hist := rfl
@[simp] theorem dirty_snaps (s : St) : (dirty s).snaps = s.snaps := rfl
@[simp] theorem dirty_chunks (s : St) : (dirty s).chunks = s.chunks := rfl
@[simp] theorem dirty_contents (s : St) : (dirty s).contents = s.contents := rfl
@[simp] theorem dirty_queue (s : St) : (dirty s).queue = s.queue := rfl
@[simp] theorem dirty_writers (s : St) : (dirty s).writers = s.writers := rfl
@[simp] theorem dirty_fds (s : St) : (dirty s).fds = s.fds := rfl
@[simp] theorem dirty_gen (s : St) : (dirty s).gen = s.gen := rfl
@[simp] theorem dirty_nextChunk (s : St) : (dirty s).nextChunk = s.nextChunk := rfl
@[simp] theorem dirty_nextContent (s : St) : (dirty s).nextContent = s.nextContent := rfl
@[simp] theorem dirty_snapView (s : St) : (dirty s).snapView = s.snapView := rfl
@[simp] theorem dirty_view (s : St) : (dirty s).view = s.view := rfl

@[simp] theorem commit_chunks' (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).chunks = s.chunks := rfl
@[simp] theorem commit_contents' (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).contents = s.contents := rfl
@[simp] theorem commit_snaps' (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).snaps = s.snaps := rfl
@[simp] theorem commit_writers (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).writers = s.writers := rfl
@[simp] theorem commit_fds (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).fds = s.fds := rfl
@[simp] theorem commit_job (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).job = s.job := rfl
@[simp] theorem commit_gen (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).gen = s.gen + 1 := rfl
@[simp] theorem commit_nextChunk (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).nextChunk = s.nextChunk := rfl
@[simp] theorem commit_nextContent (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).nextContent = s.nextContent := rfl
@[simp] theorem commit_snapView (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).snapView = s.snapView := rfl
@[simp] theorem commit_view (s : St) (p : Path) (nr : Option Ref) : (commit s p nr).view = s.view := rfl


@[simp] theorem updContent_live (s : St) (c : Nat) (o : Option Content) : (updContent s c o).live = s.live := rfl
@[simp] theorem updContent_hist (s : St) (c : Nat) (o : Option Content) : (updContent s c o).hist = s.hist := rfl
@[simp] theorem updContent_snaps (s : St) (c : Nat) (o : Option Content) : (updContent s c o).snaps = s.snaps := rfl
@[simp] theorem updContent_chunks (s : St) (c : Nat) (o : Option Content) : (updContent s c o).chunks = s.chunks := rfl
@[simp] theorem updContent_contents (s : St) (c : Nat) (o : Option Content) : (updContent s c o).contents = upd s.contents c o := rfl
@[simp] theorem updContent_queue (s : St) (c : Nat) (o : Option Content) : (updContent s c o).queue = s.queue := rfl
@[simp] theorem updContent_writers (s : St) (c : Nat) (o : Option Content) : (updContent s c o).writers = s.writers := rfl
@[simp] theorem updContent_fds (s : St) (c : Nat) (o : Option Content) : (updContent s c o).fds = s.fds := rfl
@[simp] theorem updContent_job (s : St) (c : Nat) (o : Option Content) : (updContent s c o).job = s.job := rfl
@[simp] theorem updContent_gen (s : St) (c : Nat) (o : Option Content) : (updContent s c o).gen = s.gen := rfl
@[simp] theorem updContent_nextChunk (s : St) (c : Nat) (o : Option Content) : (updContent s c o).nextChunk = s.nextChunk := rfl
@[simp] theorem updContent_nextContent (s : St) (c : Nat) (o : Option Content) : (updContent s c o).nextContent = s.nextContent := rfl
@[simp] theorem updContent_view (s : St) (c : Nat) (o : Option Content) : (updContent s c o).view = s.view := rfl
@[simp] theorem updContent_snapView (s : St) (c : Nat) (o : Option Content) : (updContent s c o).snapView = s.snapView := rfl

theorem liveRef_congr {s s' : St} (h : s'.live = s.live) {x : Ref} : LiveRef s' x ↔ LiveRef s x := by
  unfold LiveRef; rw [h]

theorem histRef_congr {s s' : St} (h : s'.hist = s.hist) {x : Ref} : HistRef s' x ↔ HistRef s x := by
  unfold HistRef; rw [h]

theorem fdRef_congr {s s' : St} (h : s'.fds = s.fds) {x : Ref} : FdRef s' x ↔ FdRef s x := by
  unfold FdRef; rw [h]

theorem manRef_congr {s s' : St} (h : s'.contents = s.contents) {x : Ref} : ManRef s' x ↔ ManRef s x := by
  cases x <;> simp [ManRef, h]

theorem strongRef_congr {s s' : St} (hl : s'.live = s.live) (hh : s'.hist = s.hist)
    (hc : s'.contents = s.contents) {x : Ref} : StrongRef s' x ↔ StrongRef s x := by
  unfold StrongRef; rw [liveRef_congr hl, histRef_congr hh, manRef_congr hc]

theorem writerHeld_congr {s s' : St} (h : s'.writers = s.writers) {x : Ref} : WriterHeld s' x ↔ WriterHeld s x := by
  cases x <;> simp [WriterHeld, h]

theorem exists_congr' {s s' : St} (hc : s'.chunks = s.chunks) (hk : s'.contents = s.contents) {x : Ref} :
    Stored s' x ↔ Stored s x := by
  cases x <;> simp [Stored, hc, hk]

theorem pinGen_congr {s s' : St} (h : s'.snaps = s.snaps) : pinGen s' = pinGen s := by
  simp [pinGen, h]

theorem atRef_congr {s s' : St} (hh : s'.hist = s.hist) (hl : s'.live = s.live) (g : Nat) (p : Path) :
    atRef s' g p = atRef s g p := by
  simp [atRef, hh, hl]

/-! ## A user write, from a state one transaction has prepared -/

/-- A write of `p` to `nr` in its own transaction, from a state `s1` that the
    same transaction prepared (interned a chunk, published a content, dropped a
    writer, …). `s1` satisfies everything but coverage, and its coverage may
    miss only what the write itself is about to reference. -/
theorem commit_core {s1 : St} {p : Path} {nr : Option Ref} {v : Option (List Hash)}
    (hb : Base s1)
    (hcov : ∀ x, Stored s1 x → ¬ StrongRef s1 x → ¬ WriterHeld s1 x → x ∈ s1.queue ∨ nr = some x)
    (hv : readRef s1 nr = some v) :
    Base (setView (dirty (commit s1 p nr)) p v) ∧ Cov (setView (dirty (commit s1 p nr)) p v) := by
  obtain ⟨g1, g2, g3⟩ := commit_gens hb p nr
  have hc : ∀ o, readRef (setView (dirty (commit s1 p nr)) p v) o = readRef s1 o :=
    readRef_congr rfl rfl
  have hr : ∀ x, resolve (setView (dirty (commit s1 p nr)) p v) x = resolve s1 x :=
    resolve_congr rfl rfl
  refine ⟨⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩, ?_⟩
  · exact g1
  · exact g2
  · intro x hx; have := hb.snapGen x hx; simp; omega
  · exact g3
  · exact hb.freshChunk
  · exact hb.freshContent
  · intro q
    rw [hc]
    simp only [setView_live, dirty_live, setView_view, commit_live]
    by_cases hq : q = p
    · subst hq; simp only [if_true, upd_same]
      cases nr with
      | none => exact hv
      | some x => simpa using hv
    · rw [if_neg hq, upd_ne _ _ hq]; exact hb.liveView q
  · intro h hh
    rw [hr]
    simp only [setView_hist, dirty_hist] at hh
    rcases mem_commit_hist.mp hh with hh | ⟨r, hl, _, rfl⟩
    · exact hb.histLive h hh
    · obtain ⟨w, hw, _⟩ := liveView_resolve hb hl
      exact resolve_ne_none hw
  · intro x hx q
    rw [hc]
    simp only [setView_snaps, dirty_snaps, commit_snaps'] at hx
    have e : atRef (setView (dirty (commit s1 p nr)) p v) x.2 q = atRef (commit s1 p nr) x.2 q :=
      atRef_congr rfl rfl x.2 q
    rw [e, commit_atRef (le_pinGen hx) (hb.snapGen x hx)]
    exact hb.snapView x hx q
  · intro f hf; rw [hr]; exact hb.fdView f hf
  · intro w hw; exact hb.writerView w hw
  · exact hb.writerUnique
  · exact hb.writerNodup
  · intro w hw hq
    simp only [setView_queue, dirty_queue] at hq
    rcases mem_commit_queue.mp hq with hq | ⟨r, hl, _, he⟩
    · exact hb.writerUnqueued w hw hq
    · obtain ⟨_, hres, _⟩ := liveView_resolve hb hl
      have : resolve s1 (Ref.content w.content) ≠ none := by rw [he]; exact resolve_ne_none hres
      exact not_writer_of_resolves hb this ⟨w, hw, rfl⟩
  · intro c hq
    simp only [setView_queue, dirty_queue] at hq
    rcases mem_commit_queue.mp hq with hq | ⟨r, hl, _, he⟩
    · exact hb.queueBound c hq
    · obtain ⟨_, hres, _⟩ := liveView_resolve hb hl
      have : resolve s1 (Ref.content c) ≠ none := by rw [he]; exact resolve_ne_none hres
      exact content_lt_of_exists hb (exists_of_resolves this)
  · exact hb.digestOk
  · intro x hx hn hw
    simp only [setView_queue, dirty_queue]
    have hx' : Stored s1 x := by cases x <;> exact hx
    have hn' : ¬ StrongRef (commit s1 p nr) x := by
      intro h; apply hn
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr (by cases x <;> exact h))
    have hw' : ¬ WriterHeld s1 x := by cases x <;> exact hw
    by_cases hs : StrongRef s1 x
    · obtain ⟨r, hr, rfl, hne⟩ := commit_lost hs hn'
      exact mem_commit_queue.mpr (Or.inr ⟨r, hr, hne, rfl⟩)
    · rcases hcov x hx' hs hw' with h | rfl
      · exact commit_queue_sub h
      · exact absurd (Or.inl commit_liveRef) hn'

/-- `Base` and `Cov` do not read the job. -/
theorem base_job {s : St} (J : Option Job) (h : Base s) : Base { s with job := J } :=
  ⟨h.liveGen, h.histGen, h.snapGen, h.histBelowLive, h.freshChunk, h.freshContent, h.liveView,
   h.histLive, h.snapView, h.fdView, h.writerView, h.writerUnique, h.writerNodup, h.writerUnqueued,
   h.queueBound, h.digestOk⟩

theorem dirty_eq_job (s : St) : dirty s = { s with job := s.job.map fun j => { j with clean := false } } := rfl

/-- A user write in its own transaction: `commit_core`, and the restore job (if
    any) is no longer clean. -/
theorem commit_inv {s1 : St} {p : Path} {nr : Option Ref} {v : Option (List Hash)}
    (hb : Base s1)
    (hcov : ∀ x, Stored s1 x → ¬ StrongRef s1 x → ¬ WriterHeld s1 x → x ∈ s1.queue ∨ nr = some x)
    (hv : readRef s1 nr = some v)
    (hjob : ∀ j, s1.job = some j → (j.name, j.g) ∈ s1.snaps ∧ j.cursor ≤ P) :
    Inv P (setView (dirty (commit s1 p nr)) p v) := by
  obtain ⟨h1, h2⟩ := commit_core hb hcov hv
  refine ⟨h1, h2, ?_⟩
  intro j hj
  simp only [setView_job, dirty, commit_job] at hj
  cases hj1 : s1.job with
  | none => simp [hj1] at hj
  | some j1 =>
    simp only [hj1, Option.map_some', Option.some.injEq] at hj
    subst hj
    obtain ⟨h1, h2⟩ := hjob j1 hj1
    exact ⟨h1, h2, fun h => by simp at h⟩

end Nimbus.ContentStore
