/-
  Nimbus.ContentStore.Steps — every transaction keeps the invariant.
-/

import Nimbus.ContentStore.Frames

namespace Nimbus.ContentStore

variable (P : Nat)

/-! ## Chunk interning (R1) -/

theorem internOk_fresh {s : St} (hb : Base s) {h k : Nat} (hk : InternOk s h k) :
    s.chunks k = some h ∨ s.chunks k = none := by
  rcases hk with hk | rfl
  · exact Or.inl hk
  · exact Or.inr (hb.freshChunk _ (Nat.le_refl _))

theorem intern_base {s : St} (hb : Base s) {h k : Nat} (hk : InternOk s h k) : Base (intern s h k) := by
  have he := intern_ext (internOk_fresh hb hk)
  unfold intern at he ⊢
  split
  · exact hb
  · rename_i hne
    rw [if_neg hne] at he
    have hkn : k = s.nextChunk := by
      rcases hk with hk | hk
      · exact absurd hk hne
      · exact hk
    subst hkn
    refine base_ext hb he rfl rfl rfl rfl rfl rfl rfl ?_ hb.freshContent ?_ hb.writerUnique
      hb.writerNodup hb.writerUnqueued hb.queueBound ?_
    · intro j hj
      simp only at hj ⊢
      rw [upd_ne _ _ (by omega)]; exact hb.freshChunk j (by omega)
    · intro w hw
      obtain ⟨ct, h1, h2, h3⟩ := hb.writerView w hw
      exact ⟨ct, h1, h2, mapM_mono he.1 h3⟩
    · intro c ct d h1 h2 h3; exact mapM_mono he.1 (hb.digestOk c ct d h1 h2 h3)

/-- Interning adds at most the chunk it names. -/
theorem intern_exists {s : St} {h k : Nat} {x : Ref} (hx : Exists (intern s h k) x) :
    Exists s x ∨ x = .chunk k := by
  unfold intern at hx
  split at hx
  · exact Or.inl hx
  · cases x with
    | chunk j =>
      by_cases e : j = k
      · exact Or.inr (e ▸ rfl)
      · left; show s.chunks j ≠ none
        have : upd s.chunks k (some h) j ≠ none := hx
        rwa [upd_ne _ _ e] at this
    | content c => exact Or.inl hx

theorem intern_refs (s : St) (h k : Nat) :
    (intern s h k).live = s.live ∧ (intern s h k).hist = s.hist ∧ (intern s h k).contents = s.contents ∧
    (intern s h k).queue = s.queue ∧ (intern s h k).writers = s.writers ∧ (intern s h k).job = s.job ∧
    (intern s h k).snaps = s.snaps ∧ (intern s h k).nextContent = s.nextContent := by
  unfold intern; split <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

@[simp] theorem intern_view (s : St) (h k : Nat) : (intern s h k).view = s.view := by
  unfold intern; split <;> rfl
@[simp] theorem intern_snapView (s : St) (h k : Nat) : (intern s h k).snapView = s.snapView := by
  unfold intern; split <;> rfl
@[simp] theorem intern_gen (s : St) (h k : Nat) : (intern s h k).gen = s.gen := by
  unfold intern; split <;> rfl
@[simp] theorem intern_fds (s : St) (h k : Nat) : (intern s h k).fds = s.fds := by
  unfold intern; split <;> rfl

theorem strongRef_intern {s : St} {h k : Nat} {x : Ref} : StrongRef (intern s h k) x ↔ StrongRef s x := by
  obtain ⟨hl, hh, hc, -⟩ := intern_refs s h k
  unfold StrongRef LiveRef HistRef
  rw [hl, hh]
  cases x <;> simp [ManRef, hc]

theorem writerHeld_intern {s : St} {h k : Nat} {x : Ref} : WriterHeld (intern s h k) x ↔ WriterHeld s x := by
  obtain ⟨-, -, -, -, hw, -⟩ := intern_refs s h k
  cases x <;> simp [WriterHeld, hw]

/-- A write that references a chunk it just interned. -/
theorem intern_commit_inv {s : St} (hi : Inv P s) {h k : Nat} (hk : InternOk s h k) (p : Path)
    (v : Option (List Hash)) (hv : v = some [h]) :
    Inv P (setView (dirty (commit (intern s h k) p (some (.chunk k)))) p v) := by
  obtain ⟨hl, hh, hc, hq, hw, hj, hs, -⟩ := intern_refs s h k
  apply commit_inv P (intern_base hi.toBase hk)
  · intro x hx hn hwh
    rcases intern_exists hx with hx | rfl
    · rw [strongRef_intern] at hn; rw [writerHeld_intern] at hwh
      rw [hq]; exact Or.inl (hi.coverage x hx hn hwh)
    · exact Or.inr rfl
  · simp [readRef, resolve, intern_chunks_self, hv]
  · intro j hj'; rw [hj] at hj'; rw [hs]
    obtain ⟨h1, h2, -⟩ := hi.jobOk j hj'; exact ⟨h1, h2⟩

theorem jobOk_weak {s : St} (hi : Inv P s) : ∀ j, s.job = some j → (j.name, j.g) ∈ s.snaps ∧ j.cursor ≤ P :=
  fun j hj => let ⟨a, b, _⟩ := hi.jobOk j hj; ⟨a, b⟩

/-! ## Writes that start from the state as it is -/

theorem plain_commit_inv {s : St} (hi : Inv P s) (p : Path) {nr : Option Ref} {v : Option (List Hash)}
    (hv : readRef s nr = some v) : Inv P (setView (dirty (commit s p nr)) p v) :=
  commit_inv P hi.toBase (fun x hx hn hw => Or.inl (hi.coverage x hx hn hw)) hv (jobOk_weak P hi)

theorem writeSmall_inv {s : St} (hi : Inv P s) {p h k : Nat} (hk : InternOk s h k) :
    Inv P (setView (dirty (commit (intern s h k) p (some (.chunk k)))) p (some [h])) :=
  intern_commit_inv P hi hk p _ rfl

theorem delete_inv {s : St} (hi : Inv P s) (p : Path) :
    Inv P (setView (dirty (commit s p none)) p none) :=
  plain_commit_inv P hi p rfl

theorem copy_inv {s : St} (hi : Inv P s) {src dst : Path} {r : Row} (hr : s.live src = some r) :
    Inv P (setView (dirty (commit s dst (some r.ref))) dst (s.view src)) := by
  apply plain_commit_inv P hi
  have := hi.liveView src
  simpa [hr] using this

theorem editSmallCow_inv {s : St} (hi : Inv P s) {p h k : Nat} (hk : InternOk s h k) :
    Inv P (setView (dirty (commit (intern s h k) p (some (.chunk k)))) p (some [h])) :=
  intern_commit_inv P hi hk p _ rfl

/-! ## Large writes (R7) -/

theorem beginLarge_inv {s : St} (hi : Inv P s) (p : Path) :
    Inv P { updContent s s.nextContent (some ⟨[], .staging, none⟩) with
      nextContent := s.nextContent + 1
      writers := s.writers ++ [⟨p, s.nextContent, []⟩] } := by
  have hfresh := hi.freshContent s.nextContent (Nat.le_refl _)
  have he : Ext s { updContent s s.nextContent (some ⟨[], .staging, none⟩) with
      nextContent := s.nextContent + 1, writers := s.writers ++ [⟨p, s.nextContent, []⟩] } := by
    refine ⟨fun k h hk => hk, fun c ct hc _ => ?_⟩
    show upd s.contents s.nextContent _ c = some ct
    have : c ≠ s.nextContent := by intro e; subst e; rw [hfresh] at hc; cases hc
    rw [upd_ne _ _ this]; exact hc
  have hw' : ∀ w ∈ s.writers, w.content < s.nextContent := by
    intro w hw
    obtain ⟨ct, h1, -⟩ := hi.writerView w hw
    exact content_lt_of_exists hi.toBase (by rw [h1]; simp)
  refine ⟨base_ext hi.toBase he rfl rfl rfl rfl rfl rfl rfl hi.freshChunk ?_ ?_ ?_ ?_ ?_ ?_ ?_, ?_, hi.jobOk⟩
  · intro c hc; simp only at hc ⊢
    rw [updContent] at *; simp only
    rw [upd_ne _ _ (by omega)]; exact hi.freshContent c (by omega)
  · intro w hw
    simp only [List.mem_append, List.mem_singleton] at hw
    rcases hw with hw | rfl
    · obtain ⟨ct, h1, h2, h3⟩ := hi.writerView w hw
      refine ⟨ct, ?_, h2, h3⟩
      simp only [updContent]; rw [upd_ne _ _ (by have := hw' w hw; omega)]; exact h1
    · exact ⟨⟨[], .staging, none⟩, by simp [updContent], rfl, by simp⟩
  · intro w1 hw1 w2 hw2 he'
    simp only [List.mem_append, List.mem_singleton] at hw1 hw2
    rcases hw1 with hw1 | rfl <;> rcases hw2 with hw2 | rfl
    · exact hi.writerUnique w1 hw1 w2 hw2 he'
    · have := hw' w1 hw1; simp at he'; omega
    · have := hw' w2 hw2; simp at he'; omega
    · rfl
  · refine nodup_append_single hi.writerNodup ?_
    intro hm; have := hw' _ hm; simp at this
  · intro w hw hq
    simp only [List.mem_append, List.mem_singleton] at hw
    rcases hw with hw | rfl
    · exact hi.writerUnqueued w hw hq
    · have := hi.queueBound _ hq; simp at this
  · intro c hq; have := hi.queueBound c hq; simp only; omega
  · intro c ct d hc hl hd
    simp only [updContent] at hc
    by_cases e : c = s.nextContent
    · subst e; simp at hc; subst hc; cases hl
    · rw [upd_ne _ _ e] at hc; exact hi.digestOk c ct d hc hl hd
  · intro x hx hn hw
    cases x with
    | chunk k =>
      apply hi.coverage (.chunk k) (show s.chunks k ≠ none from hx)
      · intro h; apply hn
        rcases h with ⟨q, r, h1, h2⟩ | h | ⟨c, ct, hc, hk⟩
        · exact Or.inl ⟨q, r, h1, h2⟩
        · exact Or.inr (Or.inl h)
        · refine Or.inr (Or.inr ⟨c, ct, ?_, hk⟩)
          simp only [updContent]; rw [upd_ne _ _ (by intro e; subst e; rw [hfresh] at hc; cases hc)]; exact hc
      · exact id
    | content c =>
      by_cases e : c = s.nextContent
      · subst e; exact absurd ⟨⟨p, s.nextContent, []⟩, by simp, rfl⟩ hw
      · have hx' : Exists s (.content c) := by
          show s.contents c ≠ none
          have : upd s.contents s.nextContent _ c ≠ none := hx
          rwa [upd_ne _ _ e] at this
        apply hi.coverage _ hx'
        · intro h; apply hn
          rcases h with h | h | h
          · exact Or.inl h
          · exact Or.inr (Or.inl h)
          · exact h.elim
        · rintro ⟨w, hw1, hw2⟩; exact hw ⟨w, by simp [hw1], hw2⟩

theorem appendLarge_inv {s : St} (hi : Inv P s) {w : Writer} {ct : Content} {h k : Nat}
    (hw : w ∈ s.writers) (hc : s.contents w.content = some ct) (hst : ct.state = .staging)
    (hk : InternOk s h k) :
    Inv P { updContent (intern s h k) w.content (some { ct with chunks := ct.chunks ++ [k] }) with
      writers := replaceWriter s.writers w { w with hashes := w.hashes ++ [h] } } := by
  have hS := intern_base hi.toBase hk
  obtain ⟨hl, hh, hcs, hq, hws, hj, hs, hnc⟩ := intern_refs s h k
  have hkh := intern_chunks_self s h k
  have heI := intern_ext (h := h) (k := k) (internOk_fresh hi.toBase hk)
  have hc' : (intern s h k).contents w.content = some ct := by rw [hcs]; exact hc
  have hne : ∀ x ∈ s.writers, x ≠ w → x.content ≠ w.content :=
    fun x hx e h' => e (hi.writerUnique x hx w hw h')
  have he : Ext (intern s h k) { updContent (intern s h k) w.content (some { ct with chunks := ct.chunks ++ [k] }) with
      writers := replaceWriter s.writers w { w with hashes := w.hashes ++ [h] } } := by
    refine ⟨fun k h hk => hk, fun c ct' hct hl' => ?_⟩
    show upd (intern s h k).contents w.content _ c = some ct'
    by_cases e : c = w.content
    · subst e; rw [hc'] at hct; cases hct; rw [hst] at hl'; cases hl'
    · rw [upd_ne _ _ e]; exact hct
  have hwc : w.content < s.nextContent := content_lt_of_exists hi.toBase (by rw [hc]; simp)
  refine ⟨base_ext hS he rfl rfl rfl rfl rfl rfl rfl hS.freshChunk ?_ ?_ ?_ ?_ ?_ ?_ ?_, ?_, ?_⟩
  · intro c hcn; simp only [updContent] at hcn ⊢
    rw [upd_ne _ _ (by rw [hnc] at hcn; omega)]; exact hS.freshContent c hcn
  · intro x hx
    simp only at hx
    rcases (mem_replaceWriter hw).mp hx with rfl | ⟨hx, hxw⟩
    · refine ⟨{ ct with chunks := ct.chunks ++ [k] }, by simp [updContent], hst, ?_⟩
      obtain ⟨ct0, h1, _, h3⟩ := hi.writerView w hw
      rw [hc] at h1; cases h1
      exact mapM_append (mapM_mono heI.1 h3) hkh
    · obtain ⟨ct0, h1, h2, h3⟩ := hS.writerView x (by rw [hws]; exact hx)
      refine ⟨ct0, ?_, h2, h3⟩
      simp only [updContent]; rw [upd_ne _ _ (hne x hx hxw)]; exact h1
  · intro x1 hx1 x2 hx2 e
    simp only at hx1 hx2
    rcases (mem_replaceWriter hw).mp hx1 with rfl | ⟨hx1, hx1w⟩ <;>
      rcases (mem_replaceWriter hw).mp hx2 with rfl | ⟨hx2, hx2w⟩
    · rfl
    · exact absurd e.symm (hne x2 hx2 hx2w)
    · exact absurd e (hne x1 hx1 hx1w)
    · exact hi.writerUnique x1 hx1 x2 hx2 e
  · simp only
    apply nodup_map_of_inj hi.writerNodup
    intro a ha b hb e
    by_cases ea : a = w <;> by_cases eb : b = w
    · rw [ea, eb]
    · simp only [ea, eb, if_true, if_false] at e
      exact absurd (congrArg Writer.content e).symm (hne b hb eb)
    · simp only [ea, eb, if_true, if_false] at e
      exact absurd (congrArg Writer.content e) (hne a ha ea)
    · simpa [ea, eb] using e
  · intro x hx hqx
    simp only [updContent_queue] at hx hqx
    rw [hq] at hqx
    rcases (mem_replaceWriter hw).mp hx with rfl | ⟨hx, _⟩
    · exact hi.writerUnqueued w hw hqx
    · exact hi.writerUnqueued x hx hqx
  · intro c hqc; simp only [updContent_queue, updContent_nextContent] at hqc ⊢
    rw [hq] at hqc; rw [hnc]; exact hi.queueBound c hqc
  · intro c ct' d hct hl' hd
    simp only [updContent] at hct
    by_cases e : c = w.content
    · subst e; simp at hct; subst hct; rw [hst] at hl'; cases hl'
    · rw [upd_ne _ _ e] at hct; exact hS.digestOk c ct' d hct hl' hd
  · intro x hx hn hwh
    have hx0 : Exists (intern s h k) x := by
      cases x with
      | chunk j => exact hx
      | content c =>
        show (intern s h k).contents c ≠ none
        by_cases e : c = w.content
        · subst e; rw [hc']; simp
        · have : upd (intern s h k).contents w.content _ c ≠ none := hx
          rwa [upd_ne _ _ e] at this
    have hman : ∀ j, ManRef (intern s h k) (.chunk j) → ManRef { updContent (intern s h k) w.content
        (some { ct with chunks := ct.chunks ++ [k] }) with
        writers := replaceWriter s.writers w { w with hashes := w.hashes ++ [h] } } (.chunk j) := by
      rintro j ⟨c, ct', hct, hj⟩
      by_cases e : c = w.content
      · subst e; rw [hc'] at hct; cases hct
        exact ⟨w.content, { ct with chunks := ct.chunks ++ [k] }, by simp, by simp [hj]⟩
      · exact ⟨c, ct', by simp only [updContent]; rw [upd_ne _ _ e]; exact hct, hj⟩
    rcases intern_exists hx0 with hx1 | rfl
    · show x ∈ (intern s h k).queue
      rw [hq]
      apply hi.coverage x hx1
      · intro hs'; apply hn
        rcases hs' with h1 | h1 | h1
        · exact Or.inl ((liveRef_congr (by simp [hl])).mpr h1)
        · exact Or.inr (Or.inl ((histRef_congr (by simp [hh])).mpr h1))
        · cases x with
          | chunk j => exact Or.inr (Or.inr (hman j (by rw [← strongRef_intern (h := h) (k := k)] at *; exact (show ManRef (intern s h k) (.chunk j) from by
              obtain ⟨c, ct', hct, hj⟩ := h1; exact ⟨c, ct', by rw [hcs]; exact hct, hj⟩))))
          | content c => exact h1.elim
      · intro hw'; apply hwh
        cases x with
        | chunk j => exact hw'
        | content c =>
          obtain ⟨y, hy, rfl⟩ := hw'
          by_cases e : y = w
          · subst e; exact ⟨_, (mem_replaceWriter hw).mpr (Or.inl rfl), rfl⟩
          · exact ⟨y, (mem_replaceWriter hw).mpr (Or.inr ⟨hy, e⟩), rfl⟩
    · exact absurd (Or.inr (Or.inr ⟨w.content, { ct with chunks := ct.chunks ++ [k] }, by simp, by simp⟩)) hn
  · intro j hj'
    have e1 : (intern s h k).job = s.job := hj
    simp only [updContent_job] at hj'
    rw [e1] at hj'
    obtain ⟨a, b, c⟩ := hi.jobOk j hj'
    exact ⟨by simp [hs, a], b, by simpa using c⟩

/-- A content's manifest is unchanged: chunk references are unchanged. -/
theorem manRef_upd_same {s : St} {c : Nat} {ct ct' : Content} (hc : s.contents c = some ct)
    (hch : ct'.chunks = ct.chunks) {x : Ref} : ManRef (updContent s c (some ct')) x ↔ ManRef s x := by
  cases x with
  | content _ => simp [ManRef]
  | chunk j =>
    simp only [ManRef, updContent_contents]
    constructor
    · rintro ⟨d, cd, hd, hj⟩
      by_cases e : d = c
      · subst e; simp at hd; subst hd; exact ⟨d, ct, hc, hch ▸ hj⟩
      · rw [upd_ne _ _ e] at hd; exact ⟨d, cd, hd, hj⟩
    · rintro ⟨d, cd, hd, hj⟩
      by_cases e : d = c
      · subst e; rw [hc] at hd; cases hd; exact ⟨d, ct', by simp, hch ▸ hj⟩
      · exact ⟨d, cd, by rw [upd_ne _ _ e]; exact hd, hj⟩

theorem publishNew_inv {s : St} (hi : Inv P s) {w : Writer} {ct : Content}
    (hw : w ∈ s.writers) (hc : s.contents w.content = some ct) (hst : ct.state = .staging) :
    Inv P (setView (dirty (commit
      { updContent s w.content (some { ct with state := .live, digest := some w.hashes }) with
        writers := s.writers.erase w } w.path (some (.content w.content)))) w.path (some w.hashes)) := by
  obtain ⟨ct0, h1, _, hmap⟩ := hi.writerView w hw
  rw [hc] at h1; cases h1
  have hwc : w.content < s.nextContent := content_lt_of_exists hi.toBase (by rw [hc]; simp)
  have hne : ∀ x ∈ s.writers.erase w, x.content ≠ w.content := by
    intro x hx e
    obtain ⟨hxw, hx'⟩ := (mem_erase_writers hi.toBase).mp hx
    exact hxw (hi.writerUnique x hx' w hw e)
  let s1 : St := { updContent s w.content (some { ct with state := .live, digest := some w.hashes }) with
    writers := s.writers.erase w }
  have he : Ext s s1 := by
    refine ⟨fun k h hk => hk, fun c ct' hct hl => ?_⟩
    show upd s.contents w.content _ c = some ct'
    by_cases e : c = w.content
    · subst e; rw [hc] at hct; cases hct; rw [hst] at hl; cases hl
    · rw [upd_ne _ _ e]; exact hct
  have hb1 : Base s1 := by
    refine base_ext hi.toBase he rfl rfl rfl rfl rfl rfl rfl hi.freshChunk ?_ ?_ ?_ ?_ ?_ ?_ ?_
    · intro c hcn
      have hcn' : s.nextContent ≤ c := hcn
      show upd s.contents w.content _ c = none
      rw [upd_ne _ _ (by omega)]; exact hi.freshContent c hcn'
    · intro x hx
      obtain ⟨cx, h1, h2, h3⟩ := hi.writerView x (List.mem_of_mem_erase hx)
      exact ⟨cx, by show upd s.contents w.content _ x.content = _; rw [upd_ne _ _ (hne x hx)]; exact h1, h2, h3⟩
    · intro a ha b hb' e
      exact hi.writerUnique a (List.mem_of_mem_erase ha) b (List.mem_of_mem_erase hb') e
    · exact hi.writerNodup.erase w
    · intro x hx; exact hi.writerUnqueued x (List.mem_of_mem_erase hx)
    · exact hi.queueBound
    · intro c ct' d hct hl hd
      show ct'.chunks.mapM s.chunks = some d
      change upd s.contents w.content _ c = some ct' at hct
      by_cases e : c = w.content
      · subst e; simp at hct; subst hct; simp at hd; subst hd; exact hmap
      · rw [upd_ne _ _ e] at hct; exact hi.digestOk c ct' d hct hl hd
  apply commit_inv P hb1
  · intro x hx hn hwh
    have hx' : Exists s x := by
      cases x with
      | chunk j => exact hx
      | content c =>
        show s.contents c ≠ none
        by_cases e : c = w.content
        · subst e; rw [hc]; simp
        · have : upd s.contents w.content _ c ≠ none := hx
          rwa [upd_ne _ _ e] at this
    have hn' : ¬ StrongRef s x := by
      intro h; apply hn
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr ((manRef_congr (s' := s1)
          (s := updContent s w.content (some { ct with state := .live, digest := some w.hashes })) rfl).mpr
          ((manRef_upd_same (ct' := { ct with state := .live, digest := some w.hashes }) hc rfl).mpr h)))
    by_cases hwx : WriterHeld s x
    · cases x with
      | chunk j => exact hwx.elim
      | content c =>
        obtain ⟨y, hy, rfl⟩ := hwx
        by_cases e : y = w
        · subst e; exact Or.inr rfl
        · exact absurd ⟨y, (mem_erase_writers hi.toBase).mpr ⟨e, hy⟩, rfl⟩ hwh
    · exact Or.inl (hi.coverage x hx' hn' hwx)
  · show (resolve s1 (.content w.content)).map some = some (some w.hashes)
    simp [resolve, s1, updContent, hmap]
  · intro j hj; exact jobOk_weak P hi j hj

theorem publishDedup_inv {s : St} (hi : Inv P s) {w : Writer} {ct : Content} {c2 : Nat} {ct2 : Content}
    (hw : w ∈ s.writers) (hc : s.contents w.content = some ct)
    (hc2 : s.contents c2 = some ct2) (hl2 : ct2.state = .live) (hd2 : ct2.digest = some w.hashes) :
    Inv P (setView (dirty (commit
      { s with writers := s.writers.erase w, queue := enq s.queue (.content w.content) }
      w.path (some (.content c2)))) w.path (some w.hashes)) := by
  have hwc : w.content < s.nextContent := content_lt_of_exists hi.toBase (by rw [hc]; simp)
  have hne : ∀ x ∈ s.writers.erase w, x.content ≠ w.content := by
    intro x hx e
    obtain ⟨hxw, hx'⟩ := (mem_erase_writers hi.toBase).mp hx
    exact hxw (hi.writerUnique x hx' w hw e)
  have hb1 : Base { s with writers := s.writers.erase w, queue := enq s.queue (.content w.content) } := by
    refine base_ext hi.toBase (Ext.refl s) rfl rfl rfl rfl rfl rfl rfl hi.freshChunk hi.freshContent ?_ ?_ ?_ ?_ ?_ hi.digestOk
    · intro x hx; exact hi.writerView x (List.mem_of_mem_erase hx)
    · intro a ha b hb' e
      exact hi.writerUnique a (List.mem_of_mem_erase ha) b (List.mem_of_mem_erase hb') e
    · exact hi.writerNodup.erase w
    · intro x hx hq
      rcases mem_enq.mp hq with hq | hq
      · exact hi.writerUnqueued x (List.mem_of_mem_erase hx) hq
      · exact hne x hx (by injection hq)
    · intro c hq
      rcases mem_enq.mp hq with hq | hq
      · exact hi.queueBound c hq
      · cases hq; exact hwc
  apply commit_inv P hb1
  · intro x hx hn hwh
    by_cases hwx : WriterHeld s x
    · cases x with
      | chunk j => exact hwx.elim
      | content c =>
        obtain ⟨y, hy, rfl⟩ := hwx
        by_cases e : y = w
        · subst e; exact Or.inl (mem_enq_self _ _)
        · exact absurd ⟨y, (mem_erase_writers hi.toBase).mpr ⟨e, hy⟩, rfl⟩ hwh
    · exact Or.inl (mem_enq_of_mem _ (hi.coverage x hx hn hwx))
  · show (resolve s (.content c2)).map some = some (some w.hashes)
    simp [resolve, hc2, hl2, hi.digestOk c2 ct2 _ hc2 hl2 hd2]
  · intro j hj; exact jobOk_weak P hi j hj

/-! ## Snapshots, the drop job and the restore job -/

theorem snapshot_inv {s : St} (hi : Inv P s) {n : Nat} (hn : ∀ x ∈ s.snaps, x.1 ≠ n) :
    Inv P { s with snaps := s.snaps ++ [(n, s.gen)], snapView := upd s.snapView n s.view } := by
  refine ⟨⟨hi.liveGen, hi.histGen, ?_, hi.histBelowLive, hi.freshChunk, hi.freshContent, hi.liveView,
    hi.histLive, ?_, hi.fdView, hi.writerView, hi.writerUnique, hi.writerNodup, hi.writerUnqueued,
    hi.queueBound, hi.digestOk⟩, hi.coverage, ?_⟩
  · intro x hx
    simp only [List.mem_append, List.mem_singleton] at hx
    rcases hx with hx | rfl
    · exact hi.snapGen x hx
    · exact Nat.le_refl _
  · intro x hx p
    simp only [List.mem_append, List.mem_singleton] at hx
    rcases hx with hx | rfl
    · have : x.1 ≠ n := hn x hx
      show readRef s (atRef s x.2 p) = some (upd s.snapView n s.view x.1 p)
      rw [upd_ne _ _ this]; exact hi.snapView x hx p
    · show readRef s (atRef s s.gen p) = some (upd s.snapView n s.view n p)
      rw [upd_same]
      cases hl : s.live p with
      | none =>
        have : atRef s s.gen p = none := by
          unfold atRef
          rw [List.find?_eq_none.mpr (fun h hh => by
            have := hi.histGen h hh
            simp [covers]; intro _ _; omega)]
          simp [hl]
        rw [this]; have := hi.liveView p; simpa [hl] using this
      | some r =>
        rw [atRef_of_live_le hi.toBase hl (hi.liveGen p r hl)]
        have := hi.liveView p; simpa [hl] using this
  · intro j hj
    obtain ⟨a, b, c⟩ := hi.jobOk j hj
    refine ⟨List.mem_append_left _ a, b, fun hc q hq => ?_⟩
    show s.view q = upd s.snapView n s.view j.name q
    rw [upd_ne _ _ (hn _ a)]; exact c hc q hq

theorem dropSnapshot_inv {s : St} (hi : Inv P s) {n : Nat} (hj : ∀ j, s.job = some j → j.name ≠ n) :
    Inv P { s with snaps := s.snaps.filter fun x => x.1 ≠ n } := by
  refine ⟨⟨hi.liveGen, hi.histGen, ?_, hi.histBelowLive, hi.freshChunk, hi.freshContent, hi.liveView,
    hi.histLive, ?_, hi.fdView, hi.writerView, hi.writerUnique, hi.writerNodup, hi.writerUnqueued,
    hi.queueBound, hi.digestOk⟩, hi.coverage, ?_⟩
  · intro x hx; exact hi.snapGen x (List.mem_filter.mp hx).1
  · intro x hx p; exact hi.snapView x (List.mem_filter.mp hx).1 p
  · intro j hj'
    obtain ⟨a, b, c⟩ := hi.jobOk j hj'
    exact ⟨List.mem_filter.mpr ⟨a, by simpa using hj j hj'⟩, b, c⟩

theorem dropHist_inv {s : St} (hi : Inv P s) {h : HRow} (hh : h ∈ s.hist)
    (hn : ∀ x ∈ s.snaps, ¬ (h.genFrom ≤ x.2 ∧ x.2 < h.genTo)) :
    Inv P { s with hist := s.hist.erase h, queue := enq s.queue h.ref } := by
  have hres := hi.histLive h hh
  refine ⟨⟨hi.liveGen, fun x hx => hi.histGen x (List.mem_of_mem_erase hx), hi.snapGen,
    fun x hx => hi.histBelowLive x (List.mem_of_mem_erase hx), hi.freshChunk, hi.freshContent, hi.liveView,
    fun x hx => hi.histLive x (List.mem_of_mem_erase hx), ?_, hi.fdView, hi.writerView, hi.writerUnique,
    hi.writerNodup, ?_, ?_, hi.digestOk⟩, ?_, hi.jobOk⟩
  · intro x hx p
    have : atRef { s with hist := s.hist.erase h, queue := enq s.queue h.ref } x.2 p = atRef s x.2 p := by
      unfold atRef
      simp only
      rw [find_erase_of_false]
      have := hn x hx
      unfold covers
      by_cases h1 : h.genFrom ≤ x.2 <;> by_cases h2 : x.2 < h.genTo <;> simp_all
    rw [readRef_congr rfl rfl, this]; exact hi.snapView x hx p
  · intro w hw hq
    rcases mem_enq.mp hq with hq | hq
    · exact hi.writerUnqueued w hw hq
    · have : resolve s (Ref.content w.content) ≠ none := by rw [hq]; exact hres
      exact not_writer_of_resolves hi.toBase this ⟨w, hw, rfl⟩
  · intro c hq
    rcases mem_enq.mp hq with hq | hq
    · exact hi.queueBound c hq
    · exact content_lt_of_exists hi.toBase (show Exists s (.content c) from hq ▸ exists_of_resolves hres)
  · intro x hx hn' hw
    by_cases hs : StrongRef s x
    · rcases hs with hl | ⟨h', hh', rfl⟩ | hm
      · exact absurd (Or.inl hl) hn'
      · by_cases e : h' = h
        · subst e; exact mem_enq_self _ _
        · exact absurd (Or.inr (Or.inl ⟨h', (List.mem_erase_of_ne e).mpr hh', rfl⟩)) hn'
      · exact absurd (Or.inr (Or.inr (by cases x <;> exact hm))) hn'
    · exact mem_enq_of_mem _ (hi.coverage x hx hs hw)

theorem restoreStart_inv {s : St} (hi : Inv P s) {n g : Nat} (hs : (n, g) ∈ s.snaps) :
    Inv P { s with job := some ⟨n, g, 0, true⟩ } := by
  refine ⟨base_job _ hi.toBase, hi.coverage, ?_⟩
  intro j hj
  simp only [Option.some.injEq] at hj; subst hj
  exact ⟨hs, Nat.zero_le _, fun _ q hq => absurd hq (Nat.not_lt_zero _)⟩

theorem restoreSkip_inv {s : St} (hi : Inv P s) {j : Job} {r : Row} (hj : s.job = some j)
    (hc : j.cursor < P) (hl : s.live j.cursor = some r) (hg : r.gen ≤ j.g) :
    Inv P { s with job := some { j with cursor := j.cursor + 1 } } := by
  refine ⟨base_job _ hi.toBase, hi.coverage, ?_⟩
  intro j' hj'
  simp only [Option.some.injEq] at hj'; subst hj'
  obtain ⟨a, b, c⟩ := hi.jobOk j hj
  refine ⟨a, hc, fun hcl q hq => ?_⟩
  by_cases e : q = j.cursor
  · subst e
    have h1 := hi.snapView _ a j.cursor
    rw [atRef_of_live_le hi.toBase hl hg] at h1
    have h2 := hi.liveView j.cursor
    rw [hl] at h2
    simp only [Option.map_some'] at h2
    rw [h2] at h1; exact Option.some.inj h1
  · exact c hcl q (by simp only at hq; omega)

theorem restoreStep_inv {s : St} (hi : Inv P s) {j : Job} (hj : s.job = some j) (hc : j.cursor < P) :
    Inv P { setView (commit s j.cursor (atRef s j.g j.cursor)) j.cursor (s.snapView j.name j.cursor) with
      job := some { j with cursor := j.cursor + 1 } } := by
  obtain ⟨a, b, c⟩ := hi.jobOk j hj
  have hv := hi.snapView _ a j.cursor
  obtain ⟨h1, h2⟩ := commit_core (p := j.cursor) hi.toBase
    (fun x hx hn hw => Or.inl (hi.coverage x hx hn hw)) hv
  refine ⟨by have h := base_job (some { j with cursor := j.cursor + 1 }) h1; exact h, h2, ?_⟩
  intro j' hj'
  simp only [Option.some.injEq] at hj'; subst hj'
  refine ⟨a, hc, fun hcl q hq => ?_⟩
  show upd s.view j.cursor (s.snapView j.name j.cursor) q = s.snapView j.name q
  by_cases e : q = j.cursor
  · subst e; rw [upd_same]
  · rw [upd_ne _ _ e]; exact c hcl q (by simp only at hq; omega)

theorem restoreFinish_inv {s : St} (hi : Inv P s) : Inv P { s with job := none } :=
  ⟨base_job _ hi.toBase, hi.coverage, fun j hj => by cases hj⟩

/-! ## Descriptors -/

theorem close_inv {s : St} (hi : Inv P s) (f : Fd) : Inv P { s with fds := s.fds.erase f } := by
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, hi.freshContent, hi.liveView,
    hi.histLive, hi.snapView, fun x hx => hi.fdView x (List.mem_of_mem_erase hx), hi.writerView, hi.writerUnique,
    hi.writerNodup, hi.writerUnqueued, hi.queueBound, hi.digestOk⟩, hi.coverage, hi.jobOk⟩

theorem detach_inv {s : St} (hi : Inv P s) {p : Path} {r : Row} (hl : s.live p = some r) :
    Inv P { setView (dirty (commit s p none)) p none with fds := s.fds ++ [⟨r.ref, (s.view p).getD []⟩] } := by
  obtain ⟨v, hv, hvp⟩ := liveView_resolve hi.toBase hl
  have hb1 : Base { s with fds := s.fds ++ [⟨r.ref, (s.view p).getD []⟩] } := by
    refine ⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, hi.freshContent, hi.liveView,
      hi.histLive, hi.snapView, ?_, hi.writerView, hi.writerUnique, hi.writerNodup, hi.writerUnqueued,
      hi.queueBound, hi.digestOk⟩
    intro f hf
    simp only [List.mem_append, List.mem_singleton] at hf
    rcases hf with hf | hf
    · exact hi.fdView f hf
    · subst hf
      show resolve s r.ref = some ((s.view p).getD [])
      rw [hvp]; exact hv
  exact commit_inv P hb1 (fun x hx hn hw => Or.inl (hi.coverage x hx hn hw)) rfl
    (fun j hj => jobOk_weak P hi j hj)

theorem memoDigest_inv {s : St} (hi : Inv P s) {c : Nat} {ct : Content} {d : List Hash}
    (hc : s.contents c = some ct) (hm : ct.chunks.mapM s.chunks = some d) :
    Inv P (updContent s c (some { ct with digest := some d })) := by
  have hr : ∀ x, resolve (updContent s c (some { ct with digest := some d })) x = resolve s x := by
    intro x; cases x with
    | chunk k => rfl
    | content c' =>
      by_cases e : c' = c
      · subst e; simp [resolve, hc]
      · exact resolve_upd_content _ (fun h => e (by injection h))
  have hrr : ∀ o, readRef (updContent s c (some { ct with digest := some d })) o = readRef s o := by
    intro o; cases o <;> simp [readRef, hr]
  have hcs : ∀ c', (updContent s c (some { ct with digest := some d })).contents c' ≠ none ↔ s.contents c' ≠ none := by
    intro c'; by_cases e : c' = c
    · subst e; simp [hc]
    · simp [upd_ne _ _ e]
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, ?_, ?_, ?_, ?_, ?_, ?_,
    hi.writerUnique, hi.writerNodup, hi.writerUnqueued, hi.queueBound, ?_⟩, ?_, hi.jobOk⟩
  · intro c' h'; have := hi.freshContent c' h'
    by_cases e : c' = c
    · subst e; rw [hc] at this; cases this
    · simp [upd_ne _ _ e, this]
  · intro p; rw [hrr]; exact hi.liveView p
  · intro h hh; rw [hr]; exact hi.histLive h hh
  · intro x hx p; rw [hrr, atRef_congr rfl rfl]; exact hi.snapView x hx p
  · intro f hf; rw [hr]; exact hi.fdView f hf
  · intro w hw
    obtain ⟨cw, h1, h2, h3⟩ := hi.writerView w hw
    by_cases e : w.content = c
    · rw [e] at h1; rw [hc] at h1; cases h1
      exact ⟨{ ct with digest := some d }, by simp [e], h2, h3⟩
    · exact ⟨cw, by simp [upd_ne _ _ e, h1], h2, h3⟩
  · intro c' ct' d' h1 h2 h3
    by_cases e : c' = c
    · subst e; simp at h1; subst h1; simp at h3; subst h3; exact hm
    · simp [upd_ne _ _ e] at h1; exact hi.digestOk c' ct' d' h1 h2 h3
  · intro x hx hn hw
    apply hi.coverage x
    · cases x with
      | chunk k => exact hx
      | content c' => exact (hcs c').mp hx
    · intro h; apply hn
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr ((manRef_upd_same (ct' := { ct with digest := some d }) hc rfl).mpr h))
    · exact hw

/-- rename (R2): the retirement of the source queues nothing, and that is safe
    because the destination holds the same reference. -/
theorem rename_inv {s : St} (hi : Inv P s) {src dst : Path} {r : Row} (hne : src ≠ dst)
    (hl : s.live src = some r) :
    Inv P (setView (setView (dirty (retire (commit s dst (some r.ref)) src)) dst (s.view src)) src none) := by
  have h1 := copy_inv P hi (dst := dst) hl
  have h2 := delete_inv P h1 src
  let S1 := setView (dirty (commit s dst (some r.ref))) dst (s.view src)
  let S2 := setView (dirty (commit S1 src none)) src none
  have hS1src : S1.live src = some r := by
    show (commit s dst (some r.ref)).live src = some r
    rw [commit_live_ne hne]; exact hl
  have h3 : Inv P { S2 with queue := S1.queue } := by
    apply requeue_inv P h2
    · intro y hy; exact commit_queue_sub hy
    · intro y hy hn
      rcases mem_commit_queue.mp hy with hy | ⟨r', hr', _, rfl⟩
      · exact absurd hy hn
      · rw [hS1src] at hr'; cases hr'
        refine Or.inl (Or.inl ⟨dst, ⟨s.gen + 1, r.ref⟩, ?_, rfl⟩)
        show (commit S1 src none).live dst = _
        rw [commit_live_ne (Ne.symm hne)]
        show (commit s dst (some r.ref)).live dst = _
        simp [commit_live]
  refine ⟨by have h := base_job (setView (setView (dirty (retire (commit s dst (some r.ref)) src))
      dst (s.view src)) src none).job h3.toBase; exact h, h3.coverage, ?_⟩
  intro j hj
  simp only [setView_job, dirty] at hj
  cases hj0 : s.job with
  | none => simp [retire, hj0] at hj
  | some j0 =>
    simp only [retire, commit_job, hj0, Option.map_some', Option.some.injEq] at hj
    subst hj
    obtain ⟨a, b, -⟩ := hi.jobOk j0 hj0
    exact ⟨a, b, fun h => by simp at h⟩

/-! ## GC (R3, R4) -/

theorem noMan_of {s : St} {k : Nat} (h : ¬ ManRef s (.chunk k)) : ∀ c ct, s.contents c = some ct → k ∉ ct.chunks :=
  fun c ct hc hk => h ⟨c, ct, hc, hk⟩

theorem gcChunkDelete_inv {s : St} (hi : Inv P s) {k : Nat} (hn : ¬ StrongRef s (.chunk k))
    (hf : ¬ FdRef s (.chunk k)) :
    Inv P { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) } := by
  have hm := noMan_of (fun h => hn (Or.inr (Or.inr h)))
  have hr : ∀ x, x ≠ .chunk k →
      resolve { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) } x = resolve s x := by
    intro x hx
    have e := resolve_congr (s' := { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) })
      (s := { s with chunks := upd s.chunks k none }) rfl rfl x
    rw [e]
    exact resolve_upd_chunk none hx hm
  have hrr : ∀ o, o ≠ some (.chunk k) →
      readRef { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) } o = readRef s o := by
    intro o ho; cases o with
    | none => rfl
    | some x => simp only [readRef]; rw [hr x (fun h => ho (h ▸ rfl))]
  have hlive : ∀ p r, s.live p = some r → r.ref ≠ .chunk k := fun p r hl e => hn (Or.inl ⟨p, r, hl, e⟩)
  have hhist : ∀ h ∈ s.hist, h.ref ≠ .chunk k := fun h hh e => hn (Or.inr (Or.inl ⟨h, hh, e⟩))
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, ?_, hi.freshContent, ?_, ?_, ?_, ?_, ?_,
    hi.writerUnique, hi.writerNodup, ?_, ?_, ?_⟩, ?_, hi.jobOk⟩
  · intro j hj
    show upd s.chunks k none j = none
    by_cases e : j = k
    · subst e; simp
    · rw [upd_ne _ _ e]; exact hi.freshChunk j hj
  · intro p
    rw [hrr]; exact hi.liveView p
    cases hl : s.live p with
    | none => simp
    | some r => simp only [Option.map_some']; intro e; exact hlive p r hl (Option.some.inj e)
  · intro h hh; rw [hr _ (hhist h hh)]; exact hi.histLive h hh
  · intro x hx p
    rw [hrr]; exact hi.snapView x hx p
    intro e
    rcases atRef_mem e with ⟨r, hl, he⟩ | ⟨h, hh, he⟩
    · exact hlive _ r hl he
    · exact hhist h hh he
  · intro f hff; rw [hr _ (fun e => hf ⟨f, hff, e⟩)]; exact hi.fdView f hff
  · intro w hw
    obtain ⟨ct, h1, h2, h3⟩ := hi.writerView w hw
    refine ⟨ct, h1, h2, ?_⟩
    rw [← h3]; apply mapM_congr
    intro j hj; have : j ≠ k := fun e => hm _ ct h1 (e ▸ hj)
    show upd s.chunks k none j = s.chunks j
    rw [upd_ne _ _ this]
  · intro w hw hq; exact hi.writerUnqueued w hw (List.mem_of_mem_erase hq)
  · intro c hq; exact hi.queueBound c (List.mem_of_mem_erase hq)
  · intro c ct d h1 h2 h3
    rw [← hi.digestOk c ct d h1 h2 h3]; apply mapM_congr
    intro j hj; have : j ≠ k := fun e => hm _ ct h1 (e ▸ hj)
    show upd s.chunks k none j = s.chunks j
    rw [upd_ne _ _ this]
  · intro x hx hn' hw
    have hxk : x ≠ .chunk k := by
      rintro rfl; exact hx (by show upd s.chunks k none k = none; simp)
    have hx' : Exists s x := by
      cases x with
      | chunk j =>
        have : j ≠ k := fun e => hxk (e ▸ rfl)
        have h' : upd s.chunks k none j ≠ none := hx
        rwa [upd_ne _ _ this] at h'
      | content c => exact hx
    have hq := hi.coverage x hx' (fun h => hn' ((strongRef_congr rfl rfl rfl).mpr h)) hw
    exact (List.mem_erase_of_ne hxk).mpr hq

theorem gcChunkSkip_inv {s : St} (hi : Inv P s) {k : Nat}
    (h : s.chunks k = none ∨ StrongRef s (.chunk k)) :
    Inv P { s with queue := s.queue.erase (.chunk k) } := by
  apply requeue_inv P hi
  · intro y hy; exact List.mem_of_mem_erase hy
  · intro y hy hn
    have : y = .chunk k := Classical.byContradiction fun e => hn ((List.mem_erase_of_ne e).mpr hy)
    subst this
    rcases h with h | h
    · exact Or.inr (fun hx => hx h)
    · exact Or.inl h

theorem gcContentSkip_inv {s : St} (hi : Inv P s) {c : Nat}
    (h : s.contents c = none ∨ (StrongRef s (.content c) ∧ ∀ ct, s.contents c = some ct → ct.state ≠ .dying)) :
    Inv P { s with queue := s.queue.erase (.content c) } := by
  apply requeue_inv P hi
  · intro y hy; exact List.mem_of_mem_erase hy
  · intro y hy hn
    have : y = .content c := Classical.byContradiction fun e => hn ((List.mem_erase_of_ne e).mpr hy)
    subst this
    rcases h with h | h
    · exact Or.inr (fun hx => hx h)
    · exact Or.inl h.1

/-- Nothing a reader can reach points at a dying content. -/
theorem dying_unreferenced {s : St} (hb : Base s) {c : Nat} {ct : Content} (hc : s.contents c = some ct)
    (hd : ct.state = .dying) :
    ¬ LiveRef s (.content c) ∧ ¬ HistRef s (.content c) ∧ ¬ FdRef s (.content c) ∧ ¬ WriterHeld s (.content c) := by
  have hnone := not_dying_of_resolves hc hd
  refine ⟨?_, ?_, ?_, ?_⟩
  · rintro ⟨p, r, hl, he⟩
    obtain ⟨v, hv, _⟩ := liveView_resolve hb hl
    rw [he, hnone] at hv; cases hv
  · rintro ⟨h, hh, he⟩
    have := hb.histLive h hh; rw [he] at this; exact this hnone
  · rintro ⟨f, hf, he⟩
    have := hb.fdView f hf; rw [he, hnone] at this; cases this
  · rintro ⟨w, hw, he⟩
    obtain ⟨ct', h1, h2, _⟩ := hb.writerView w hw
    rw [he, hc] at h1; cases h1; rw [hd] at h2; cases h2

/-- Changing content `c` when no reader reaches it keeps every reader's bytes. -/
theorem views_upd_content {s : St} (hb : Base s) {c : Nat} (o : Option Content)
    (hl : ¬ LiveRef s (.content c)) (hh : ¬ HistRef s (.content c)) (hf : ¬ FdRef s (.content c))
    (hw : ¬ WriterHeld s (.content c)) (s' : St) (hc : s'.chunks = s.chunks)
    (hk : s'.contents = upd s.contents c o) (hlive : s'.live = s.live) (hhist : s'.hist = s.hist)
    (hsn : s'.snaps = s.snaps) (hv : s'.view = s.view) (hsv : s'.snapView = s.snapView) (hfd : s'.fds = s.fds)
    (hwr : s'.writers = s.writers) :
    (∀ p, readRef s' ((s'.live p).map Row.ref) = some (s'.view p)) ∧
    (∀ h ∈ s'.hist, resolve s' h.ref ≠ none) ∧
    (∀ x ∈ s'.snaps, ∀ p, readRef s' (atRef s' x.2 p) = some (s'.snapView x.1 p)) ∧
    (∀ f ∈ s'.fds, resolve s' f.ref = some f.view) ∧
    (∀ w ∈ s'.writers, ∃ ct, s'.contents w.content = some ct ∧ ct.state = .staging ∧
      ct.chunks.mapM s'.chunks = some w.hashes) := by
  have hr : ∀ x, x ≠ .content c → resolve s' x = resolve s x := by
    intro x hx
    rw [resolve_congr (s := updContent s c o) hc hk]
    exact resolve_upd_content o hx
  have hrr : ∀ x : Option Ref, x ≠ some (.content c) → readRef s' x = readRef s x := by
    intro x hx; cases x with
    | none => rfl
    | some y => simp only [readRef]; rw [hr y (fun e => hx (e ▸ rfl))]
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · intro p; rw [hlive, hv, hrr]; exact hb.liveView p
    cases h : s.live p with
    | none => simp
    | some r => simp only [Option.map_some']; intro e; exact hl ⟨p, r, h, Option.some.inj e⟩
  · intro h hh'; rw [hhist] at hh'; rw [hr _ (fun e => hh ⟨h, hh', e⟩)]; exact hb.histLive h hh'
  · intro x hx p; rw [hsn] at hx; rw [hsv, atRef_congr hhist hlive, hrr]; exact hb.snapView x hx p
    intro e
    rcases atRef_mem e with ⟨r, h1, h2⟩ | ⟨h, h1, h2⟩
    · exact hl ⟨p, r, h1, h2⟩
    · exact hh ⟨h, h1, h2⟩
  · intro f hf'; rw [hfd] at hf'; rw [hr _ (fun e => hf ⟨f, hf', e⟩)]; exact hb.fdView f hf'
  · intro w hw'; rw [hwr] at hw'
    obtain ⟨ct, h1, h2, h3⟩ := hb.writerView w hw'
    have : w.content ≠ c := fun e => hw ⟨w, hw', e⟩
    exact ⟨ct, by rw [hk, upd_ne _ _ this]; exact h1, h2, by rw [hc]; exact h3⟩

theorem gcContentStart_inv {s : St} (hi : Inv P s) {c : Nat} {ct : Content} (hc : s.contents c = some ct)
    (hn : ¬ StrongRef s (.content c)) (hf : ¬ FdRef s (.content c)) (hw : ¬ WriterHeld s (.content c)) :
    Inv P (updContent s c (some { ct with state := .dying, digest := none })) := by
  obtain ⟨v1, v2, v3, v4, v5⟩ := views_upd_content hi.toBase (some { ct with state := .dying, digest := none })
    (fun h => hn (Or.inl h)) (fun h => hn (Or.inr (Or.inl h))) hf hw
    (updContent s c (some { ct with state := .dying, digest := none })) rfl rfl rfl rfl rfl rfl rfl rfl rfl
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, ?_, v1, v2, v3, v4, v5,
    hi.writerUnique, hi.writerNodup, hi.writerUnqueued, hi.queueBound, ?_⟩, ?_, hi.jobOk⟩
  · intro c' h'
    have := hi.freshContent c' h'
    have e : c' ≠ c := by intro e; subst e; rw [hc] at this; cases this
    simp [upd_ne _ _ e, this]
  · intro c' ct' d h1 h2 h3
    by_cases e : c' = c
    · subst e; simp at h1; subst h1; cases h2
    · simp [upd_ne _ _ e] at h1; exact hi.digestOk c' ct' d h1 h2 h3
  · intro x hx hn' hw'
    apply hi.coverage x
    · cases x with
      | chunk j => exact hx
      | content c' =>
        show s.contents c' ≠ none
        by_cases e : c' = c
        · subst e; rw [hc]; simp
        · have : upd s.contents c _ c' ≠ none := hx
          rwa [upd_ne _ _ e] at this
    · intro h; apply hn'
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr ((manRef_upd_same (ct' := { ct with state := .dying, digest := none }) hc rfl).mpr h))
    · exact hw'

theorem gcContentPage_inv {s : St} (hi : Inv P s) {c : Nat} {ct : Content} {k : Nat} {rest : List Nat}
    (hc : s.contents c = some ct) (hd : ct.state = .dying) (hch : ct.chunks = k :: rest) :
    Inv P { updContent s c (some { ct with chunks := rest }) with queue := enq s.queue (.chunk k) } := by
  obtain ⟨u1, u2, u3, u4⟩ := dying_unreferenced hi.toBase hc hd
  obtain ⟨v1, v2, v3, v4, v5⟩ := views_upd_content hi.toBase (some { ct with chunks := rest })
    u1 u2 u3 u4 { updContent s c (some { ct with chunks := rest }) with queue := enq s.queue (.chunk k) }
    rfl rfl rfl rfl rfl rfl rfl rfl rfl
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, ?_, v1, v2, v3, v4, v5,
    hi.writerUnique, hi.writerNodup, ?_, ?_, ?_⟩, ?_, hi.jobOk⟩
  · intro c' h'
    have := hi.freshContent c' h'
    have e : c' ≠ c := by intro e; subst e; rw [hc] at this; cases this
    show upd s.contents c _ c' = none
    rw [upd_ne _ _ e]; exact this
  · intro w hw hq
    rcases mem_enq.mp hq with hq | hq
    · exact hi.writerUnqueued w hw hq
    · cases hq
  · intro c' hq
    rcases mem_enq.mp hq with hq | hq
    · exact hi.queueBound c' hq
    · cases hq
  · intro c' ct' d h1 h2 h3
    change upd s.contents c _ c' = some ct' at h1
    by_cases e : c' = c
    · subst e; simp at h1; subst h1; rw [hd] at h2; cases h2
    · rw [upd_ne _ _ e] at h1; exact hi.digestOk c' ct' d h1 h2 h3
  · intro x hx hn' hw'
    by_cases e : x = .chunk k
    · subst e; exact mem_enq_self _ _
    apply mem_enq_of_mem
    apply hi.coverage x
    · cases x with
      | chunk j => exact hx
      | content c' =>
        show s.contents c' ≠ none
        by_cases e' : c' = c
        · subst e'; rw [hc]; simp
        · have : upd s.contents c _ c' ≠ none := hx
          rwa [upd_ne _ _ e'] at this
    · intro h; apply hn'
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · cases x with
        | content _ => exact h.elim
        | chunk j =>
          obtain ⟨d, cd, h1, h2⟩ := h
          refine Or.inr (Or.inr ⟨d, ?_, ?_, ?_⟩)
          · exact if d = c then { ct with chunks := rest } else cd
          · show upd s.contents c _ d = _
            by_cases e' : d = c
            · subst e'; simp
            · rw [upd_ne _ _ e']; simp [e', h1]
          · by_cases e' : d = c
            · subst e'; rw [hc] at h1; cases h1; rw [hch] at h2
              simp only [if_true]
              rcases List.mem_cons.mp h2 with h2 | h2
              · exact absurd (h2 ▸ rfl) e
              · exact h2
            · simp [e', h2]
    · exact hw'

theorem gcContentFinish_inv {s : St} (hi : Inv P s) {c : Nat} {ct : Content}
    (hc : s.contents c = some ct) (hd : ct.state = .dying) (hch : ct.chunks = []) :
    Inv P { updContent s c none with queue := s.queue.erase (.content c) } := by
  obtain ⟨u1, u2, u3, u4⟩ := dying_unreferenced hi.toBase hc hd
  obtain ⟨v1, v2, v3, v4, v5⟩ := views_upd_content hi.toBase none
    u1 u2 u3 u4 { updContent s c none with queue := s.queue.erase (.content c) }
    rfl rfl rfl rfl rfl rfl rfl rfl rfl
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, ?_, v1, v2, v3, v4, v5,
    hi.writerUnique, hi.writerNodup, ?_, ?_, ?_⟩, ?_, hi.jobOk⟩
  · intro c' h'
    show upd s.contents c none c' = none
    by_cases e : c' = c
    · subst e; simp
    · rw [upd_ne _ _ e]; exact hi.freshContent c' h'
  · intro w hw hq; exact hi.writerUnqueued w hw (List.mem_of_mem_erase hq)
  · intro c' hq; exact hi.queueBound c' (List.mem_of_mem_erase hq)
  · intro c' ct' d h1 h2 h3
    change upd s.contents c none c' = some ct' at h1
    by_cases e : c' = c
    · subst e; simp at h1
    · rw [upd_ne _ _ e] at h1; exact hi.digestOk c' ct' d h1 h2 h3
  · intro x hx hn' hw'
    have hxc : x ≠ .content c := by
      rintro rfl; exact hx (by show upd s.contents c none c = none; simp)
    apply (List.mem_erase_of_ne hxc).mpr
    apply hi.coverage x
    · cases x with
      | chunk j => exact hx
      | content c' =>
        have e : c' ≠ c := fun e => hxc (e ▸ rfl)
        have : upd s.contents c none c' ≠ none := hx
        rwa [upd_ne _ _ e] at this
    · intro h; apply hn'
      rcases h with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · cases x with
        | content _ => exact h.elim
        | chunk j =>
          obtain ⟨d, cd, h1, h2⟩ := h
          have e : d ≠ c := by
            intro e; subst e; rw [hc] at h1; cases h1; rw [hch] at h2; cases h2
          exact Or.inr (Or.inr ⟨d, cd, by show upd s.contents c none d = _; rw [upd_ne _ _ e]; exact h1, h2⟩)
    · exact hw'

/-! ## A DO reset, then open -/

theorem reset_inv {s : St} (hi : Inv P s) :
    Inv P { s with writers := [], fds := [], queue := (stagingIds s).foldl (fun q c => enq q (.content c)) s.queue } := by
  refine ⟨⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, hi.freshChunk, hi.freshContent, hi.liveView,
    hi.histLive, hi.snapView, (fun f hf => by cases hf), (fun w hw => by cases hw), (fun w hw => by cases hw),
    List.nodup_nil, (fun w hw => by cases hw), ?_, hi.digestOk⟩, ?_, hi.jobOk⟩
  · intro c hq
    rcases (mem_foldl_enq _ _).mp hq with hq | ⟨c', hc', he⟩
    · exact hi.queueBound c hq
    · cases he; exact (mem_stagingIds.mp hc').1
  · intro x hx hn hw
    apply (mem_foldl_enq _ _).mpr
    by_cases hws : WriterHeld s x
    · cases x with
      | chunk _ => exact hws.elim
      | content c =>
        obtain ⟨w, hw', rfl⟩ := hws
        obtain ⟨ct, h1, h2, _⟩ := hi.writerView w hw'
        refine Or.inr ⟨w.content, mem_stagingIds.mpr ⟨content_lt_of_exists hi.toBase (by rw [h1]; simp),
          ct, h1, h2⟩, rfl⟩
    · exact Or.inl (hi.coverage x hx hn hws)

/-! ## Edits (R5, R6) -/

theorem mem_set_self {l : List Nat} {i k : Nat} (hi : i < l.length) : k ∈ l.set i k := by
  rw [List.mem_iff_getElem]
  exact ⟨i, by simpa using hi, List.getElem_set_self _⟩

theorem mem_set_of_ne {l : List Nat} {i k j : Nat} (hj : j ∈ l) (hne : j ≠ l.getD i 0) : j ∈ l.set i k := by
  obtain ⟨m, hm, rfl⟩ := List.mem_iff_getElem.mp hj
  rw [List.mem_iff_getElem]
  have : i ≠ m := by
    rintro rfl; apply hne; simp [List.getD, hm]
  exact ⟨m, by simpa using hm, by rw [List.getElem_set_ne this]⟩

theorem setView_setView (s : St) (p : Path) (v v' : Option (List Hash)) :
    setView (setView s p v) p v' = setView s p v' := by
  simp only [setView]
  congr 1
  funext q
  by_cases e : q = p <;> simp [upd, e]

theorem editSmallInPlace_inv {s : St} (hi : Inv P s) {p : Path} {r : Row} {k h : Nat}
    (hl : s.live p = some r) (hr : r.ref = .chunk k) (hg : pinGen s < r.gen)
    (hother : ∀ q r', q ≠ p → s.live q = some r' → r'.ref ≠ .chunk k)
    (hman : ¬ ManRef s (.chunk k)) (hhist : ¬ HistRef s (.chunk k)) (hfd : ¬ FdRef s (.chunk k)) :
    Inv P (setView (dirty (commit { s with chunks := upd s.chunks k (some h) } p (some (.chunk k)))) p (some [h])) := by
  have hm := noMan_of hman
  obtain ⟨v0, hv0, _⟩ := liveView_resolve hi.toBase hl
  have hk : s.chunks k ≠ none := by
    intro e; rw [hr] at hv0; simp [resolve, e] at hv0
  let s1 : St := setView { s with chunks := upd s.chunks k (some h) } p (some [h])
  have hres : ∀ x, x ≠ .chunk k → resolve s1 x = resolve s x := by
    intro x hx
    have e := resolve_congr (s' := s1) (s := { s with chunks := upd s.chunks k (some h) }) rfl rfl x
    rw [e]
    exact resolve_upd_chunk _ hx hm
  have hrr : ∀ o, o ≠ some (.chunk k) → readRef s1 o = readRef s o := by
    intro o ho; cases o with
    | none => rfl
    | some x => simp only [readRef]; rw [hres x (fun e => ho (e ▸ rfl))]
  have hb1 : Base s1 := by
    refine ⟨hi.liveGen, hi.histGen, hi.snapGen, hi.histBelowLive, ?_, hi.freshContent, ?_, ?_, ?_, ?_, ?_,
      hi.writerUnique, hi.writerNodup, hi.writerUnqueued, hi.queueBound, ?_⟩
    · intro j hj
      show upd s.chunks k (some h) j = none
      have : j ≠ k := by intro e; subst e; exact hk (hi.freshChunk _ hj)
      rw [upd_ne _ _ this]; exact hi.freshChunk j hj
    · intro q
      show readRef s1 ((s.live q).map Row.ref) = some (upd s.view p (some [h]) q)
      by_cases e : q = p
      · subst e; simp only [hl, upd_same, Option.map_some', hr]; simp [readRef, resolve, s1]
      · rw [upd_ne _ _ e, hrr]; exact hi.liveView q
        cases hq : s.live q with
        | none => simp
        | some r' => simp only [Option.map_some']; intro e'; exact hother q r' e hq (Option.some.inj e')
    · intro hh hmem; rw [hres _ (fun e => hhist ⟨hh, hmem, e⟩)]; exact hi.histLive hh hmem
    · intro x hx q
      show readRef s1 (atRef s x.2 q) = some (s.snapView x.1 q)
      rw [hrr]; exact hi.snapView x hx q
      intro e
      rcases atRef_mem' e with ⟨r', h1, h2, h3⟩ | ⟨hh, h1, h2⟩
      · by_cases eq : q = p
        · subst eq; rw [hl] at h1; cases h1
          have h4 := le_pinGen hx
          have h5 : pinGen s1 = pinGen s := rfl
          omega
        · exact hother q r' eq h1 h3
      · exact hhist ⟨hh, h1, h2⟩
    · intro f hf; rw [hres _ (fun e => hfd ⟨f, hf, e⟩)]; exact hi.fdView f hf
    · intro w hw
      obtain ⟨ct, h1, h2, h3⟩ := hi.writerView w hw
      refine ⟨ct, h1, h2, ?_⟩
      rw [← h3]; apply mapM_congr
      intro j hj; have : j ≠ k := fun e => hm _ ct h1 (e ▸ hj)
      show upd s.chunks k (some h) j = s.chunks j
      rw [upd_ne _ _ this]
    · intro c ct d h1 h2 h3
      rw [← hi.digestOk c ct d h1 h2 h3]; apply mapM_congr
      intro j hj; have : j ≠ k := fun e => hm _ ct h1 (e ▸ hj)
      show upd s.chunks k (some h) j = s.chunks j
      rw [upd_ne _ _ this]
  have := commit_inv P (p := p) (nr := some (.chunk k)) (v := some [h]) hb1
    (fun x hx hn hw => Or.inl (hi.coverage x (by
        cases x with
        | chunk j =>
          show s.chunks j ≠ none
          by_cases e : j = k
          · subst e; exact hk
          · have : upd s.chunks k (some h) j ≠ none := hx
            rwa [upd_ne _ _ e] at this
        | content c => exact hx) hn hw))
    (by simp [readRef, resolve, s1])
    (fun j hj => jobOk_weak P hi j hj)
  have e1 : setView (dirty (commit s1 p (some (.chunk k)))) p (some [h]) =
      setView (setView (dirty (commit { s with chunks := upd s.chunks k (some h) } p (some (.chunk k))))
        p (some [h])) p (some [h]) := rfl
  rw [e1, setView_setView] at this
  exact this

theorem editLargeCow_inv {s : St} (hi : Inv P s) {p : Path} {r : Row} {c : Nat} {ct : Content} {i h k : Nat}
    (hl : s.live p = some r) (hr : r.ref = .content c) (hc : s.contents c = some ct)
    (hi' : i < ct.chunks.length) (hk : InternOk s h k) :
    Inv P (setView (dirty (commit
        { updContent (intern s h k) (intern s h k).nextContent (some ⟨ct.chunks.set i k, .live, none⟩) with
          nextContent := (intern s h k).nextContent + 1 }
        p (some (.content (intern s h k).nextContent)))) p ((s.view p).map fun v => v.set i h)) := by
  have hS := intern_base hi.toBase hk
  have heI := intern_ext (h := h) (k := k) (internOk_fresh hi.toBase hk)
  obtain ⟨hlS, hhS, hcS, hqS, hwS, hjS, hsS, hnS⟩ := intern_refs s h k
  have hkh := intern_chunks_self s h k
  let S := intern s h k
  let c2 := S.nextContent
  have hc2 : S.contents c2 = none := hS.freshContent c2 (Nat.le_refl _)
  obtain ⟨old, hold, hvp⟩ := liveView_resolve hi.toBase hl
  rw [hr] at hold
  obtain ⟨ct', hct', _, hmap⟩ := resolve_live_content hold
  rw [hc] at hct'; cases hct'
  have hmapS : ct.chunks.mapM S.chunks = some old := mapM_mono heI.1 hmap
  let s1 : St := { updContent S c2 (some ⟨ct.chunks.set i k, .live, none⟩) with nextContent := c2 + 1 }
  have he : Ext S s1 := by
    refine ⟨fun _ _ hk => hk, fun d cd hd _ => ?_⟩
    show upd S.contents c2 _ d = some cd
    have : d ≠ c2 := by intro e; subst e; rw [hc2] at hd; cases hd
    rw [upd_ne _ _ this]; exact hd
  have hb1 : Base s1 := by
    refine base_ext hS he rfl rfl rfl rfl rfl rfl rfl hS.freshChunk ?_ ?_ hS.writerUnique hS.writerNodup
      hS.writerUnqueued ?_ ?_
    · intro d hd
      show upd S.contents c2 _ d = none
      have hd' : c2 + 1 ≤ d := hd
      rw [upd_ne _ _ (by omega)]; exact hS.freshContent d (by show S.nextContent ≤ d; omega)
    · intro w hw
      obtain ⟨cw, h1, h2, h3⟩ := hS.writerView w hw
      have : w.content ≠ c2 := by intro e; rw [e, hc2] at h1; cases h1
      exact ⟨cw, by show upd S.contents c2 _ w.content = _; rw [upd_ne _ _ this]; exact h1, h2, h3⟩
    · intro d hq; have := hS.queueBound d hq; show d < S.nextContent + 1
      have : d < S.nextContent := this
      omega
    · intro d cd dg h1 h2 h3
      change upd S.contents c2 _ d = some cd at h1
      by_cases e : d = c2
      · subst e; simp at h1; subst h1; cases h3
      · rw [upd_ne _ _ e] at h1; exact hS.digestOk d cd dg h1 h2 h3
  apply commit_inv P hb1
  · intro x hx hn hw
    cases x with
    | content d =>
      by_cases e : d = c2
      · subst e; exact Or.inr rfl
      · left
        rw [show s1.queue = s.queue from hqS]
        apply hi.coverage
        · show s.contents d ≠ none
          have : upd S.contents c2 _ d ≠ none := hx
          rw [upd_ne _ _ e, hcS] at this; exact this
        · intro h'; apply hn
          rcases h' with h' | h' | h'
          · exact Or.inl ((liveRef_congr (s' := s1) (s := s) hlS).mpr h')
          · exact Or.inr (Or.inl ((histRef_congr (s' := s1) (s := s) hhS).mpr h'))
          · exact h'.elim
        · intro h'; apply hw
          exact (writerHeld_congr (s' := s1) (s := s) hwS).mpr h'
    | chunk j =>
      left
      rw [show s1.queue = s.queue from hqS]
      rcases intern_exists (show Exists S (.chunk j) from hx) with hx' | hx'
      · apply hi.coverage _ hx'
        · intro h'; apply hn
          rcases h' with h' | h' | ⟨d, cd, h1, h2⟩
          · exact Or.inl ((liveRef_congr (s' := s1) (s := s) hlS).mpr h')
          · exact Or.inr (Or.inl ((histRef_congr (s' := s1) (s := s) hhS).mpr h'))
          · have : d ≠ c2 := by intro e; subst e; rw [← hcS, hc2] at h1; cases h1
            exact Or.inr (Or.inr ⟨d, cd, by show upd S.contents c2 _ d = _; rw [upd_ne _ _ this, hcS]; exact h1, h2⟩)
        · exact hw
      · cases hx'
        exact absurd (Or.inr (Or.inr ⟨c2, ⟨ct.chunks.set i k, .live, none⟩,
          by show upd S.contents c2 _ c2 = _; simp, mem_set_self hi'⟩)) hn
  · show (resolve s1 (.content c2)).map some = some ((s.view p).map fun v => v.set i h)
    rw [hvp]
    have : resolve s1 (.content c2) = some (old.set i h) := by
      have e1 : s1.contents c2 = some ⟨ct.chunks.set i k, .live, none⟩ := by
        show upd S.contents c2 _ c2 = _; simp
      have e2 : s1.chunks = S.chunks := rfl
      simp only [resolve, e1, e2, if_true]
      exact mapM_set hkh i hmapS
    rw [this]; rfl
  · intro j hj
    have hj' : s.job = some j := by rw [← hjS]; exact hj
    obtain ⟨a, b, -⟩ := hi.jobOk j hj'
    exact ⟨by show (j.name, j.g) ∈ S.snaps; rw [hsS]; exact a, b⟩

theorem editLargeInPlace_inv {s : St} (hi : Inv P s) {p : Path} {r : Row} {c : Nat} {ct : Content} {i h k : Nat}
    (hl : s.live p = some r) (hr : r.ref = .content c) (hg : pinGen s < r.gen)
    (hc : s.contents c = some ct) (hi' : i < ct.chunks.length)
    (hother : ∀ q r', q ≠ p → s.live q = some r' → r'.ref ≠ .content c)
    (hhist : ¬ HistRef s (.content c)) (hfd : ¬ FdRef s (.content c)) (hk : InternOk s h k) :
    Inv P (setView (dirty (commit
        { updContent (intern s h k) c (some { ct with chunks := ct.chunks.set i k, digest := none }) with
          queue := enq s.queue (.chunk (ct.chunks.getD i 0)) }
        p (some (.content c)))) p ((s.view p).map fun v => v.set i h)) := by
  have hS := intern_base hi.toBase hk
  have heI := intern_ext (h := h) (k := k) (internOk_fresh hi.toBase hk)
  obtain ⟨hlS, hhS, hcS, hqS, hwS, hjS, hsS, hnS⟩ := intern_refs s h k
  have hkh := intern_chunks_self s h k
  let S := intern s h k
  -- the step's hypotheses, read in the interned state
  have hlI : S.live p = some r := by rw [hlS]; exact hl
  have hcI : S.contents c = some ct := by rw [hcS]; exact hc
  have hgI : pinGen S < r.gen := by rw [pinGen_congr hsS]; exact hg
  have hotherI : ∀ q r', q ≠ p → S.live q = some r' → r'.ref ≠ .content c := by
    intro q r' e h'; rw [hlS] at h'; exact hother q r' e h'
  have hhistI : ¬ HistRef S (.content c) := fun h' => hhist ((histRef_congr hhS).mp h')
  have hfdI : ¬ FdRef S (.content c) := fun h' => hfd ((fdRef_congr (intern_fds s h k)).mp h')
  have hviewI : S.view = s.view := intern_view s h k
  obtain ⟨old, hold, hvp⟩ := liveView_resolve hS hlI
  rw [hr] at hold
  obtain ⟨ct', hct', hlv, hmapS⟩ := resolve_live_content hold
  rw [hcI] at hct'; cases hct'
  have hvp' : s.view p = some old := by rw [← hviewI]; exact hvp
  let ct2 : Content := { ct with chunks := ct.chunks.set i k, digest := none }
  let newv : Option (List Hash) := (s.view p).map fun v => v.set i h
  let s0 : St := { updContent S c (some ct2) with queue := enq s.queue (.chunk (ct.chunks.getD i 0)) }
  let s1 : St := setView s0 p newv
  have hwc : ∀ w ∈ S.writers, w.content ≠ c := by
    intro w hw e
    obtain ⟨cw, h1, h2, _⟩ := hS.writerView w hw
    rw [e, hcI] at h1; cases h1; rw [hlv] at h2; cases h2
  have hres : ∀ x, x ≠ .content c → resolve s1 x = resolve S x := by
    intro x hx
    have e := resolve_congr (s' := s1) (s := updContent S c (some ct2)) rfl rfl x
    rw [e, resolve_upd_content _ hx]
  have hrr : ∀ o, o ≠ some (.content c) → readRef s1 o = readRef S o := by
    intro o ho; cases o with
    | none => rfl
    | some x => simp only [readRef]; rw [hres x (fun e => ho (e ▸ rfl))]
  have hnew : resolve s1 (.content c) = some (old.set i h) := by
    have e1 : s1.contents c = some ct2 := by show upd S.contents c _ c = _; simp
    have e2 : s1.chunks = S.chunks := rfl
    simp only [resolve, e1, e2, ct2, hlv, if_true]
    exact mapM_set hkh i hmapS
  have hb1 : Base s1 := by
    refine ⟨hS.liveGen, hS.histGen, hS.snapGen, hS.histBelowLive, hS.freshChunk, ?_, ?_, ?_, ?_, ?_, ?_,
      hS.writerUnique, hS.writerNodup, ?_, ?_, ?_⟩
    · intro d hd
      show upd S.contents c _ d = none
      have : d ≠ c := by intro e; subst e; rw [hS.freshContent _ hd] at hcI; cases hcI
      rw [upd_ne _ _ this]; exact hS.freshContent d hd
    · intro q
      show readRef s1 ((S.live q).map Row.ref) = some (upd S.view p newv q)
      by_cases e : q = p
      · subst e
        rw [hlI]; simp only [Option.map_some', upd_same, hr, readRef, hnew]; simp [newv, hvp']
      · rw [upd_ne _ _ e, hrr]
        · exact hS.liveView q
        cases hq : S.live q with
        | none => simp
        | some r' => simp only [Option.map_some']; intro e'; exact hotherI q r' e hq (Option.some.inj e')
    · intro hh hmem; rw [hres _ (fun e => hhistI ⟨hh, hmem, e⟩)]; exact hS.histLive hh hmem
    · intro x hx q
      show readRef s1 (atRef S x.2 q) = some (S.snapView x.1 q)
      rw [hrr]
      · exact hS.snapView x hx q
      intro e
      rcases atRef_mem' e with ⟨r', h1, h2, h3⟩ | ⟨hh, h1, h2⟩
      · by_cases eq : q = p
        · subst eq; rw [hlI] at h1; cases h1
          have := le_pinGen hx
          have e2 : pinGen s1 = pinGen S := rfl
          omega
        · exact hotherI q r' eq h1 h3
      · exact hhistI ⟨hh, h1, h2⟩
    · intro f hf; rw [hres _ (fun e => hfdI ⟨f, hf, e⟩)]; exact hS.fdView f hf
    · intro w hw
      obtain ⟨cw, h1, h2, h3⟩ := hS.writerView w hw
      refine ⟨cw, ?_, h2, h3⟩
      show upd S.contents c _ w.content = _
      rw [upd_ne _ _ (hwc w hw)]; exact h1
    · intro w hw hq
      rcases mem_enq.mp hq with hq | hq
      · rw [← hqS] at hq; exact hS.writerUnqueued w hw hq
      · cases hq
    · intro d hq
      rcases mem_enq.mp hq with hq | hq
      · rw [← hqS] at hq; exact hS.queueBound d hq
      · cases hq
    · intro d cd dg h1 h2 h3
      change upd S.contents c _ d = some cd at h1
      by_cases e : d = c
      · subst e; simp at h1; subst h1; cases h3
      · rw [upd_ne _ _ e] at h1; exact hS.digestOk d cd dg h1 h2 h3
  have := commit_inv P (p := p) (nr := some (.content c)) (v := newv) hb1
    (by
      intro x hx hn hw
      left
      show x ∈ enq s.queue (.chunk (ct.chunks.getD i 0))
      cases x with
      | content d =>
        apply mem_enq_of_mem
        apply hi.coverage
        · show s.contents d ≠ none
          by_cases e : d = c
          · subst e; rw [hc]; simp
          · have : upd S.contents c _ d ≠ none := hx
            rw [upd_ne _ _ e, hcS] at this; exact this
        · intro h'; apply hn
          rcases h' with h' | h' | h'
          · exact Or.inl ((liveRef_congr (s' := s1) (s := s) hlS).mpr h')
          · exact Or.inr (Or.inl ((histRef_congr (s' := s1) (s := s) hhS).mpr h'))
          · exact h'.elim
        · intro h'; exact hw ((writerHeld_congr (s' := s1) (s := s) hwS).mpr h')
      | chunk j =>
        by_cases ej : j = ct.chunks.getD i 0
        · subst ej; exact mem_enq_self _ _
        apply mem_enq_of_mem
        rcases intern_exists (show Exists S (.chunk j) from hx) with hx' | hx'
        · apply hi.coverage _ hx'
          · intro h'; apply hn
            rcases h' with h' | h' | ⟨d, cd, h1, h2⟩
            · exact Or.inl ((liveRef_congr (s' := s1) (s := s) hlS).mpr h')
            · exact Or.inr (Or.inl ((histRef_congr (s' := s1) (s := s) hhS).mpr h'))
            · by_cases e : d = c
              · subst e; rw [hc] at h1; cases h1
                exact Or.inr (Or.inr ⟨d, ct2, by show upd S.contents d _ d = _; simp, mem_set_of_ne h2 ej⟩)
              · exact Or.inr (Or.inr ⟨d, cd, by show upd S.contents c _ d = _; rw [upd_ne _ _ e, hcS]; exact h1, h2⟩)
          · exact hw
        · cases hx'
          exact absurd (Or.inr (Or.inr ⟨c, ct2, by show upd S.contents c _ c = _; simp, mem_set_self hi'⟩)) hn)
    (by show (resolve s1 (.content c)).map some = some newv; rw [hnew]; simp [newv, hvp'])
    (fun j hj => by
      have hj' : s.job = some j := by rw [← hjS]; exact hj
      obtain ⟨a, b, -⟩ := hi.jobOk j hj'
      exact ⟨by show (j.name, j.g) ∈ S.snaps; rw [hsS]; exact a, b⟩)
  have e1 : setView (dirty (commit s1 p (some (.content c)))) p newv =
      setView (setView (dirty (commit s0 p (some (.content c)))) p newv) p newv := rfl
  rw [e1, setView_setView] at this
  exact this

end Nimbus.ContentStore
