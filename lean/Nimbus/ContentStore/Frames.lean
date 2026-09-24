/-
  Nimbus.ContentStore.Frames — what the transactions that do not write an inode
  change, and the lemmas the per-step proofs share.
-/

import Nimbus.ContentStore.Inv

namespace Nimbus.ContentStore

variable (P : Nat)

/-- A transaction that only adds chunks and contents, or edits contents nothing
    live can read, keeps `Base` given the parts of it that mention writers,
    the queue and digests. -/
theorem base_ext {s s' : St} (hb : Base s) (he : Ext s s')
    (hl : s'.live = s.live) (hh : s'.hist = s.hist) (hs : s'.snaps = s.snaps) (hg : s'.gen = s.gen)
    (hf : s'.fds = s.fds) (hv : s'.view = s.view) (hsv : s'.snapView = s.snapView)
    (hfc : ∀ k, s'.nextChunk ≤ k → s'.chunks k = none)
    (hfk : ∀ c, s'.nextContent ≤ c → s'.contents c = none)
    (hw : ∀ w ∈ s'.writers, ∃ ct, s'.contents w.content = some ct ∧ ct.state = .staging ∧
      ct.chunks.mapM s'.chunks = some w.hashes)
    (hwu : ∀ w1 ∈ s'.writers, ∀ w2 ∈ s'.writers, w1.content = w2.content → w1 = w2)
    (hwn : s'.writers.Nodup)
    (hwq : ∀ w ∈ s'.writers, Ref.content w.content ∉ s'.queue)
    (hqb : ∀ c, Ref.content c ∈ s'.queue → c < s'.nextContent)
    (hd : ∀ c ct d, s'.contents c = some ct → ct.state = .live → ct.digest = some d →
      ct.chunks.mapM s'.chunks = some d) : Base s' := by
  refine ⟨?_, ?_, ?_, ?_, hfc, hfk, ?_, ?_, ?_, ?_, hw, hwu, hwn, hwq, hqb, hd⟩
  · rw [hl, hg]; exact hb.liveGen
  · rw [hh, hg]; exact hb.histGen
  · rw [hs, hg]; exact hb.snapGen
  · rw [hh, hl]; exact hb.histBelowLive
  · intro p; rw [hl, hv]; exact readRef_ext he (hb.liveView p)
  · intro h hh'; rw [hh] at hh'
    obtain ⟨v, hv'⟩ := Option.ne_none_iff_exists'.mp (hb.histLive h hh')
    exact resolve_ne_none (resolve_ext he hv')
  · intro x hx p; rw [hs] at hx; rw [hsv, atRef_congr hh hl]
    exact readRef_ext he (hb.snapView x hx p)
  · intro f hf'; rw [hf] at hf'; exact resolve_ext he (hb.fdView f hf')

/-- Rewriting chunk `k` changes no reference that cannot reach it. -/
theorem resolve_upd_chunk {s : St} {k : Nat} (o : Option Hash) {x : Ref} (hx : x ≠ .chunk k)
    (hm : ∀ c ct, s.contents c = some ct → k ∉ ct.chunks) :
    resolve { s with chunks := upd s.chunks k o } x = resolve s x := by
  cases x with
  | chunk j =>
    have : j ≠ k := fun h => hx (h ▸ rfl)
    simp [resolve, upd_ne _ _ this]
  | content c =>
    simp only [resolve]
    cases hc : s.contents c with
    | none => rfl
    | some ct =>
      simp only
      split
      · apply mapM_congr
        intro j hj
        have : j ≠ k := fun h => hm c ct hc (h ▸ hj)
        simp [upd_ne _ _ this]
      · rfl

theorem readRef_upd_chunk {s : St} {k : Nat} (o : Option Hash) {x : Option Ref}
    (hx : x ≠ some (.chunk k)) (hm : ∀ c ct, s.contents c = some ct → k ∉ ct.chunks) :
    readRef { s with chunks := upd s.chunks k o } x = readRef s x := by
  cases x with
  | none => rfl
  | some r =>
    simp only [readRef]
    rw [resolve_upd_chunk o (fun h => hx (h ▸ rfl)) hm]

/-- Changing content `c` changes no reference but `c`. -/
theorem resolve_upd_content {s : St} {c : Nat} (o : Option Content) {x : Ref} (hx : x ≠ .content c) :
    resolve (updContent s c o) x = resolve s x := by
  cases x with
  | chunk j => rfl
  | content d =>
    have : d ≠ c := fun h => hx (h ▸ rfl)
    simp [resolve, updContent, upd_ne _ _ this]

theorem readRef_upd_content {s : St} {c : Nat} (o : Option Content) {x : Option Ref}
    (hx : x ≠ some (.content c)) : readRef (updContent s c o) x = readRef s x := by
  cases x with
  | none => rfl
  | some r =>
    simp only [readRef]
    rw [resolve_upd_content o (fun h => hx (h ▸ rfl))]

/-- What `atRef` answers is the live row (when it predates `g`) or a history row. -/
theorem atRef_mem' {s : St} {g : Nat} {p : Path} {x : Ref} (h : atRef s g p = some x) :
    (∃ r, s.live p = some r ∧ r.gen ≤ g ∧ r.ref = x) ∨ (∃ hr ∈ s.hist, hr.ref = x) := by
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
      · cases h; exact Or.inl ⟨r, rfl, by assumption, rfl⟩
      · cases h

/-- A live row written at or before `g` is what `at(g)` reads, because the
    history rows of its path all end where it began. -/
theorem atRef_of_live_le {s : St} (hb : Base s) {g : Nat} {p : Path} {r : Row}
    (hl : s.live p = some r) (hg : r.gen ≤ g) : atRef s g p = some r.ref := by
  unfold atRef
  have : s.hist.find? (covers g p) = none := by
    rw [List.find?_eq_none]
    intro h hh
    have hle := hb.histBelowLive h hh
    simp only [covers, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq]
    rintro ⟨⟨rfl, _⟩, hlt⟩
    have := hle r hl; omega
  rw [this]; simp [hl, hg]

theorem find_erase_of_false {l : List HRow} {h : HRow} {f : HRow → Bool} (hf : f h = false) :
    (l.erase h).find? f = l.find? f := by
  induction l with
  | nil => rfl
  | cons a l ih =>
    by_cases e : a = h
    · subst e; simp [hf]
    · rw [List.erase_cons_tail (by simpa using e)]
      simp only [List.find?_cons]
      split
      · rfl
      · exact ih

theorem mem_replaceWriter {ws : List Writer} {w w' x : Writer} (hw : w ∈ ws) :
    x ∈ replaceWriter ws w w' ↔ x = w' ∨ (x ∈ ws ∧ x ≠ w) := by
  unfold replaceWriter
  rw [List.mem_map]
  constructor
  · rintro ⟨y, hy, rfl⟩
    by_cases e : y = w
    · simp [e]
    · simp only [e, if_false]; exact Or.inr ⟨hy, e⟩
  · rintro (rfl | ⟨hx, hne⟩)
    · exact ⟨w, hw, by simp⟩
    · exact ⟨x, hx, by simp [hne]⟩

theorem mem_stagingIds {s : St} {c : Nat} :
    c ∈ stagingIds s ↔ c < s.nextContent ∧ ∃ ct, s.contents c = some ct ∧ ct.state = .staging := by
  unfold stagingIds
  rw [List.mem_filter, List.mem_range]
  constructor
  · rintro ⟨h1, h2⟩
    refine ⟨h1, ?_⟩
    cases hc : s.contents c with
    | none => simp [hc] at h2
    | some ct => simp [hc] at h2; exact ⟨ct, rfl, h2⟩
  · rintro ⟨h1, ct, hc, hs⟩
    exact ⟨h1, by simp [hc, hs]⟩

/-- Queue rows a state can do without: dropping a row whose target something
    durable still holds keeps the invariant. -/
theorem requeue_inv {s : St} (hi : Inv P s) (q' : List Ref) (hsub : ∀ y ∈ q', y ∈ s.queue)
    (hheld : ∀ y ∈ s.queue, y ∉ q' → StrongRef s y ∨ ¬ Exists s y) : Inv P { s with queue := q' } := by
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, hi.freshContent,
    hi.liveView, hi.histLive, hi.snapView, hi.fdView, hi.writerView, hi.writerUnique, hi.writerNodup,
    ?_, ?_, hi.digestOk⟩, ?_, hi.jobOk⟩
  · intro w hw hq; exact hi.writerUnqueued w hw (hsub _ hq)
  · intro c hq; exact hi.queueBound c (hsub _ hq)
  · intro x hx hn hw
    have hq := hi.coverage x hx hn hw
    by_cases h : x ∈ q'
    · exact h
    · rcases hheld x hq h with h' | h'
      · exact absurd h' hn
      · exact absurd hx h'

/-- A live, history or descriptor reference reads a live content, never a
    dying one. -/
theorem not_dying_of_resolves {s : St} {c : Nat} {ct : Content} (hc : s.contents c = some ct)
    (hd : ct.state = .dying) : resolve s (.content c) = none := by
  simp [resolve, hc, hd]

theorem nodup_append_single {α : Type} {l : List α} {x : α} (hl : l.Nodup) (hx : x ∉ l) :
    (l ++ [x]).Nodup := by
  induction l with
  | nil => simp
  | cons a l ih =>
    rw [List.nodup_cons] at hl
    simp only [List.cons_append, List.nodup_cons, List.mem_append, List.mem_singleton, not_or]
    refine ⟨⟨hl.1, fun e => hx (e ▸ List.mem_cons_self _ _)⟩, ih hl.2 (fun h => hx (List.mem_cons_of_mem _ h))⟩

theorem nodup_map_of_inj {α β : Type} {f : α → β} {l : List α} (hl : l.Nodup)
    (hf : ∀ a ∈ l, ∀ b ∈ l, f a = f b → a = b) : (l.map f).Nodup := by
  induction l with
  | nil => simp
  | cons a l ih =>
    rw [List.nodup_cons] at hl
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and]
    refine ⟨fun b hb e => hl.1 ((hf b (List.mem_cons_of_mem _ hb) a (List.mem_cons_self _ _) e) ▸ hb), ?_⟩
    exact ih hl.2 (fun x hx y hy e => hf x (List.mem_cons_of_mem _ hx) y (List.mem_cons_of_mem _ hy) e)

theorem mem_erase_writers {s : St} (hb : Base s) {w x : Writer} :
    x ∈ s.writers.erase w ↔ x ≠ w ∧ x ∈ s.writers := hb.writerNodup.mem_erase_iff

end Nimbus.ContentStore
