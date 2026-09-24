/-
  Nimbus.ContentStore.Gc — leak freedom. At quiescence (no large write in
  flight, no detached descriptor open) the GC alone always has a step that
  lowers a well-founded measure of the queue, so it empties it; and an empty
  queue, by the coverage invariant, means every chunk and content that exists
  is referenced by a live row, a history row or a manifest. No garbage outlives
  quiescence, and no audit pass is needed for that.
-/

import Nimbus.ContentStore.Safety

namespace Nimbus.ContentStore

variable (P : Nat)

/-- What one queue row still costs: a chunk row is one step; a content row is
    one step per manifest row (its page and its chunk's own step) plus its
    start and finish. -/
def qweight (s : St) : Ref → Nat
  | .chunk _ => 1
  | .content c =>
    match s.contents c with
    | none => 1
    | some ct => (if ct.state = .dying then 1 else 2) + 2 * ct.chunks.length

def wsum (f : Ref → Nat) : List Ref → Nat
  | [] => 0
  | x :: l => f x + wsum f l

def weight (s : St) : Nat := wsum (qweight s) s.queue

theorem wsum_erase (f : Ref → Nat) {x : Ref} : ∀ {l : List Ref}, x ∈ l → wsum f (l.erase x) + f x = wsum f l := by
  intro l
  induction l with
  | nil => intro h; cases h
  | cons a l ih =>
    intro h
    by_cases e : a = x
    · subst e; simp [wsum]; omega
    · rw [List.erase_cons_tail (by simpa using e)]
      have hx : x ∈ l := by
        rcases List.mem_cons.mp h with h | h
        · exact absurd h.symm e
        · exact h
      simp only [wsum]; have := ih hx; omega

theorem wsum_mono {f g : Ref → Nat} : ∀ {l : List Ref}, (∀ y ∈ l, f y ≤ g y) → wsum f l ≤ wsum g l := by
  intro l
  induction l with
  | nil => intro _; exact Nat.le_refl _
  | cons a l ih =>
    intro h
    simp only [wsum]
    have := h a (List.mem_cons_self _ _)
    have := ih (fun y hy => h y (List.mem_cons_of_mem _ hy))
    omega

theorem wsum_enq (f : Ref → Nat) (q : List Ref) (y : Ref) : wsum f (enq q y) ≤ wsum f q + f y := by
  unfold enq; split
  · omega
  · induction q with
    | nil => simp [wsum]
    | cons a l ih =>
      simp only [List.cons_append, wsum]
      have := ih (by intro h; rename_i hn; exact hn (List.mem_cons_of_mem _ h))
      omega

/-- The quiescent state: nothing in flight holds anything. -/
def Quiet (s : St) : Prop := s.writers = [] ∧ s.fds = []

/-- From a quiet state with a non-empty queue the GC has a step, it lowers the
    weight, and it keeps the state quiet. -/
theorem gc_progress {s : St} (hq : Quiet s) {x : Ref} (hx : x ∈ s.queue) :
    ∃ s', Step P s s' ∧ weight s' < weight s ∧ Quiet s' := by
  have noFd : ∀ y, ¬ FdRef s y := by rintro y ⟨f, hf, _⟩; rw [hq.2] at hf; cases hf
  have noW : ∀ y, ¬ WriterHeld s y := by
    intro y; cases y with
    | chunk _ => exact id
    | content c => rintro ⟨w, hw, _⟩; rw [hq.1] at hw; cases hw
  cases x with
  | chunk k =>
    -- chunk weights do not read the store, and the step leaves contents alone
    by_cases hdel : s.chunks k ≠ none ∧ ¬ StrongRef s (.chunk k)
    · refine ⟨_, .gcChunkDelete s k hx hdel.1 hdel.2 (noFd _), ?_, hq⟩
      show wsum (qweight _) (s.queue.erase (.chunk k)) < wsum (qweight s) s.queue
      have := wsum_erase (qweight s) hx
      have e : qweight { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) } = qweight s := by
        funext y; cases y <;> rfl
      rw [e]; simp [qweight] at this; omega
    · have h' : s.chunks k = none ∨ StrongRef s (.chunk k) := by
        by_cases e : s.chunks k = none
        · exact Or.inl e
        · exact Or.inr (Classical.byContradiction fun hn => hdel ⟨e, hn⟩)
      refine ⟨_, .gcChunkSkip s k hx h', ?_, hq⟩
      show wsum (qweight _) (s.queue.erase (.chunk k)) < wsum (qweight s) s.queue
      have := wsum_erase (qweight s) hx
      have e : qweight { s with queue := s.queue.erase (.chunk k) } = qweight s := by
        funext y; cases y <;> rfl
      rw [e]; simp [qweight] at this; omega
  | content c =>
    cases hc : s.contents c with
    | none =>
      refine ⟨_, .gcContentSkip s c hx (Or.inl hc), ?_, hq⟩
      show wsum (qweight _) (s.queue.erase (.content c)) < wsum (qweight s) s.queue
      have := wsum_erase (qweight s) hx
      have e : qweight { s with queue := s.queue.erase (.content c) } = qweight s := by
        funext y; cases y <;> rfl
      rw [e]; simp [qweight, hc] at this; omega
    | some ct =>
      by_cases hd : ct.state = .dying
      · cases hch : ct.chunks with
        | nil =>
          refine ⟨_, .gcContentFinish s c ct hx hc hd hch, ?_, hq⟩
          show wsum (qweight _) (s.queue.erase (.content c)) < wsum (qweight s) s.queue
          have h1 := wsum_erase (qweight s) hx
          have h2 : wsum (qweight { updContent s c none with queue := s.queue.erase (.content c) })
              (s.queue.erase (.content c)) ≤ wsum (qweight s) (s.queue.erase (.content c)) := by
            apply wsum_mono; intro y _; cases y with
            | chunk _ => exact Nat.le_refl _
            | content d =>
              by_cases e : d = c
              · subst e; simp [qweight, updContent, hc, hd, hch]
              · simp [qweight, updContent, upd_ne _ _ e]
          simp [qweight, hc, hd, hch] at h1; omega
        | cons k rest =>
          refine ⟨_, .gcContentPage s c ct k rest hx hc hd hch, ?_, hq⟩
          show wsum (qweight _) (enq s.queue (.chunk k)) < wsum (qweight s) s.queue
          let s' : St := { updContent s c (some { ct with chunks := rest }) with queue := enq s.queue (.chunk k) }
          have h1 := wsum_enq (qweight s') s.queue (.chunk k)
          have h2 := wsum_erase (qweight s') hx
          have h3 := wsum_erase (qweight s) hx
          have h4 : wsum (qweight s') (s.queue.erase (.content c)) ≤ wsum (qweight s) (s.queue.erase (.content c)) := by
            apply wsum_mono; intro y _; cases y with
            | chunk _ => exact Nat.le_refl _
            | content d =>
              by_cases e : d = c
              · subst e; simp [s', qweight, updContent, hc, hd, hch] <;> omega
              · simp [s', qweight, updContent, upd_ne _ _ e]
          have h5 : qweight s' (.content c) + 2 = qweight s (.content c) := by
            simp [s', qweight, updContent, hc, hd, hch]; omega
          show wsum (qweight s') (enq s.queue (.chunk k)) < _
          simp only [qweight] at h1
          omega
      · by_cases hs : StrongRef s (.content c)
        · refine ⟨_, .gcContentSkip s c hx (Or.inr ⟨hs, fun ct' h' => by rw [hc] at h'; cases h'; exact hd⟩), ?_, hq⟩
          show wsum (qweight _) (s.queue.erase (.content c)) < wsum (qweight s) s.queue
          have := wsum_erase (qweight s) hx
          have e : qweight { s with queue := s.queue.erase (.content c) } = qweight s := by
            funext y; cases y <;> rfl
          rw [e]
          have : 0 < qweight s (.content c) := by simp [qweight, hc]; split <;> omega
          omega
        · refine ⟨_, .gcContentStart s c ct hx hc hd hs (noFd _) (noW _), ?_, hq⟩
          show wsum (qweight _) s.queue < wsum (qweight s) s.queue
          let s' : St := updContent s c (some { ct with state := .dying, digest := none })
          have h2 := wsum_erase (qweight s') hx
          have h3 := wsum_erase (qweight s) hx
          have h4 : wsum (qweight s') (s.queue.erase (.content c)) ≤ wsum (qweight s) (s.queue.erase (.content c)) := by
            apply wsum_mono; intro y _; cases y with
            | chunk _ => exact Nat.le_refl _
            | content d =>
              by_cases e : d = c
              · subst e; simp [s', qweight, updContent, hc, hd]
              · simp [s', qweight, updContent, upd_ne _ _ e]
          have h5 : qweight s' (.content c) + 1 = qweight s (.content c) := by
            simp [s', qweight, updContent, hc, hd]; omega
          show wsum (qweight s') s.queue < _
          omega

inductive Star : St → St → Prop
  | refl (s : St) : Star s s
  | step {s s' s'' : St} : Step P s s' → Star s' s'' → Star s s''

theorem star_inv {s s' : St} (hi : Inv P s) (h : Star P s s') : Inv P s' := by
  induction h with
  | refl => exact hi
  | step hs _ ih => exact ih (step_inv P hi hs)

/-- From any quiet state the GC reaches an empty queue. -/
theorem gc_drains : ∀ n (s : St), weight s ≤ n → Inv P s → Quiet s →
    ∃ s', Star P s s' ∧ s'.queue = [] ∧ Quiet s' := by
  intro n
  induction n with
  | zero =>
    intro s hw hi hq
    cases hqs : s.queue with
    | nil => exact ⟨s, .refl s, hqs, hq⟩
    | cons x l =>
      obtain ⟨s', _, hlt, _⟩ := gc_progress P hq (x := x) (by rw [hqs]; exact List.mem_cons_self _ _)
      omega
  | succ n ih =>
    intro s hw hi hq
    cases hqs : s.queue with
    | nil => exact ⟨s, .refl s, hqs, hq⟩
    | cons x l =>
      obtain ⟨s', hs, hlt, hq'⟩ := gc_progress P hq (x := x) (by rw [hqs]; exact List.mem_cons_self _ _)
      obtain ⟨s'', h1, h2, h3⟩ := ih s' (by omega) (step_inv P hi hs) hq'
      exact ⟨s'', .step hs h1, h2, h3⟩

/-- Leak freedom: once writes stop and descriptors close, GC alone reaches a
    state where every stored chunk and content is referenced by a live row, a
    history row (so by a snapshot) or a manifest. -/
theorem no_garbage_after_quiescence {s : St} (h : Reachable P s) (hq : Quiet s) :
    ∃ s', Star P s s' ∧ ∀ x, Exists s' x → StrongRef s' x := by
  have hi := reachable_inv P h
  obtain ⟨s', hs, hqe, hq'⟩ := gc_drains P (weight s) s (Nat.le_refl _) hi hq
  have hi' := star_inv P hi hs
  refine ⟨s', hs, fun x hx => Classical.byContradiction fun hn => ?_⟩
  have hw : ¬ WriterHeld s' x := by
    cases x with
    | chunk _ => exact id
    | content c => rintro ⟨w, hw, _⟩; rw [hq'.1] at hw; cases hw
  have := hi'.coverage x hx hn hw
  rw [hqe] at this; cases this

end Nimbus.ContentStore
