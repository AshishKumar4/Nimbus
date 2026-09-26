/-
  Nimbus.Vfs.Ledger — N18 admission (CUTOVER.md v3.1 §3, §2.8): the session's
  storage ledger and `admit`.

  used = the session DO's own bytes (`sess`, without the namespace images) + every
  recorded facet database (`nimbus_facet_storage`, live, dead or persisted) + the
  per-principal namespace images (`nimbus_ns_image`, in least-recently-used order,
  oldest first). A write of `need` bytes is admitted before it is made: if it does
  not fit, the oldest images (other than the one being written) are dropped until it
  does; if it would not fit even with every such image gone, it is refused with
  ENOSPC and nothing changes — no image is dropped for a write that is refused
  anyway (the one departure from the spec's literal wording "drops ... until the
  write fits; only when no image is left does it refuse", which reaches the same
  decision but loses the images first).

  Proved, for every reachable state and every operation:
  - `used_le_limit`: used never exceeds the limit.
  - `refused_unchanged`: a refused write (session write, facet fill, image write)
    leaves the whole state unchanged, destination included, and evicts nothing;
    `refuses_iff`: it is refused exactly when it would not fit with every evictable
    image gone.
  - `evicts_oldest_minimal`: what is evicted is a prefix of the evictable images
    (oldest first), and no shorter prefix would have made the write fit.
  - `only_eviction_frees`: every operation other than a delete (a session delete,
    `facets.delete`, a size settlement, the epoch drop of unused images) frees at
    most the bytes of the images it evicted, and evicts only on admission.
  - `facet_row_stays`: a facet row leaves the ledger only by `facets.delete`
    (`abort` and a restart keep it).
-/

namespace Nimbus.Vfs.Ledger

/-- A (key, bytes) row: a facet by name, an image by principal. -/
abbrev Row := Nat × Nat

def sumB (l : List Row) : Nat := (l.map (·.2)).sum

/-- The bytes recorded under key `k`. -/
def cur (l : List Row) (k : Nat) : Nat := sumB (l.filter (·.1 == k))

def others (l : List Row) (k : Nat) : List Row := l.filter (·.1 != k)

structure St where
  limit : Nat
  sess : Nat
  facets : List Row
  images : List Row

def used (s : St) : Nat := s.sess + sumB s.facets + sumB s.images

/-! ## Sums -/

@[simp] theorem sumB_nil : sumB [] = 0 := rfl
@[simp] theorem sumB_cons (x : Row) (l : List Row) : sumB (x :: l) = x.2 + sumB l := by simp [sumB]
@[simp] theorem sumB_append (a b : List Row) : sumB (a ++ b) = sumB a + sumB b := by
  induction a with
  | nil => simp [sumB]
  | cons x a ih => simp only [List.cons_append, sumB_cons, ih]; omega

theorem sumB_split (l : List Row) (k : Nat) : sumB l = sumB (others l k) + cur l k := by
  induction l with
  | nil => rfl
  | cons x l ih =>
    unfold others cur at *
    by_cases h : x.1 = k <;> simp [List.filter_cons, h] at ih ⊢ <;> omega

theorem sumB_filter_le (l : List Row) (p : Row → Bool) : sumB (l.filter p) ≤ sumB l := by
  induction l with
  | nil => simp
  | cons x l ih => simp only [List.filter_cons]; split <;> simp <;> omega

/-! ## Eviction -/

/-- Drop the oldest images until `fixed + need` fits with the rest: the evicted
    prefix and the survivors, or `none` when even dropping all of them is not enough. -/
def fitDrop (L need fixed : Nat) : List Row → Option (List Row × List Row)
  | [] => if fixed + need ≤ L then some ([], []) else none
  | x :: r =>
    if fixed + sumB (x :: r) + need ≤ L then some ([], x :: r)
    else (fitDrop L need fixed r).map fun (ev, sv) => (x :: ev, sv)

theorem fitDrop_some {L need fixed : Nat} : ∀ {imgs : List Row} {ev sv : List Row},
    fitDrop L need fixed imgs = some (ev, sv) → ev ++ sv = imgs ∧ fixed + sumB sv + need ≤ L := by
  intro imgs
  induction imgs with
  | nil => intro ev sv h; simp only [fitDrop] at h; split at h <;> simp_all
  | cons x r ih =>
    intro ev sv h
    simp only [fitDrop] at h
    split at h
    · rename_i hle
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨rfl, hle⟩
    · cases hr : fitDrop L need fixed r with
      | none => simp [hr] at h
      | some p =>
        obtain ⟨ev', sv'⟩ := p
        simp only [hr, Option.map_some', Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        obtain ⟨h1, h2⟩ := ih hr
        exact ⟨by simp [h1], h2⟩

theorem fitDrop_none {L need fixed : Nat} : ∀ {imgs : List Row},
    fitDrop L need fixed imgs = none ↔ L < fixed + need := by
  intro imgs
  induction imgs with
  | nil => simp only [fitDrop]; split <;> simp <;> omega
  | cons x r ih =>
    simp only [fitDrop]
    split
    · simp; omega
    · simp only [Option.map_eq_none']; exact ih

/-- Minimality: the survivors fit, and keeping one more image would not. -/
theorem fitDrop_min {L need fixed : Nat} : ∀ {imgs : List Row} {ev sv : List Row},
    fitDrop L need fixed imgs = some (ev, sv) → ev = [] ∨ ∃ x, L < fixed + sumB (ev.getLast?.toList ++ sv) + need ∧
      ev.getLast? = some x := by
  intro imgs
  induction imgs with
  | nil => intro ev sv h; simp only [fitDrop] at h; split at h <;> simp_all
  | cons x r ih =>
    intro ev sv h
    simp only [fitDrop] at h
    split at h
    · simp_all
    · rename_i hn
      cases hr : fitDrop L need fixed r with
      | none => simp [hr] at h
      | some p =>
        obtain ⟨ev', sv'⟩ := p
        simp only [hr, Option.map_some', Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        right
        rcases ih hr with rfl | ⟨y, hy, hl⟩
        · have := (fitDrop_some hr).1
          simp at this; subst this
          exact ⟨x, by simp at hn ⊢; omega, by simp⟩
        · refine ⟨y, ?_, ?_⟩
          · have : (x :: ev').getLast? = ev'.getLast? := by
              cases ev' with
              | nil => simp at hl
              | cons _ _ => simp [List.getLast?_cons]
            rw [this]; exact hy
          · cases ev' with
            | nil => simp at hl
            | cons _ _ => simp [List.getLast?_cons] at hl ⊢; exact hl

/-! ## Operations -/

inductive Op where
  /-- A session-DO write (import page, cross-database copy target, snapshot rows, ...). -/
  | write (b : Nat)
  /-- A facet fill of `b` bytes into facet `n`. -/
  | fill (n b : Nat)
  /-- A namespace-image write of `b` bytes for principal `k`. -/
  | image (k b : Nat)
  /-- A launch uses principal `k`'s image: it becomes the most recent. -/
  | touch (k : Nat)
  | delSess (b : Nat)
  /-- `facets.delete(n)`. -/
  | delFacet (n : Nat)
  /-- A facet reports a `databaseSize` at or below its recorded bytes. -/
  | settle (n b : Nat)
  /-- Epoch change: keep only the images of principals in `keep`. -/
  | dropImages (keep : List Nat)
  /-- `facets.abort(n)`: the database persists. -/
  | abort (n : Nat)
  | restart
  deriving Repr

inductive Out where
  | ok
  | enospc
  deriving DecidableEq, Repr

def fixedS (s : St) : Nat := s.sess + sumB s.facets

/-- One operation: the answer, the new state, and the images it evicted. -/
def step (s : St) : Op → Out × St × List Row
  | .write b =>
    match fitDrop s.limit b (fixedS s) s.images with
    | some (ev, sv) => (.ok, { s with sess := s.sess + b, images := sv }, ev)
    | none => (.enospc, s, [])
  | .fill n b =>
    match fitDrop s.limit b (fixedS s) s.images with
    | some (ev, sv) => (.ok, { s with facets := others s.facets n ++ [(n, cur s.facets n + b)], images := sv }, ev)
    | none => (.enospc, s, [])
  | .image k b =>
    match fitDrop s.limit b (fixedS s + cur s.images k) (others s.images k) with
    | some (ev, sv) => (.ok, { s with images := sv ++ [(k, cur s.images k + b)] }, ev)
    | none => (.enospc, s, [])
  | .touch k =>
    if s.images.any (·.1 == k) then (.ok, { s with images := others s.images k ++ [(k, cur s.images k)] }, [])
    else (.ok, s, [])
  | .delSess b => (.ok, { s with sess := s.sess - b }, [])
  | .delFacet n => (.ok, { s with facets := others s.facets n }, [])
  | .settle n b =>
    if s.facets.any (·.1 == n) then (.ok, { s with facets := others s.facets n ++ [(n, min b (cur s.facets n))] }, [])
    else (.ok, s, [])
  | .dropImages keep => (.ok, { s with images := s.images.filter (fun x => keep.contains x.1) }, [])
  | .abort _ => (.ok, s, [])
  | .restart => (.ok, s, [])

def Op.frees : Op → Bool
  | .delSess _ | .delFacet _ | .settle _ _ | .dropImages _ => true
  | _ => false

def Op.admits : Op → Bool
  | .write _ | .fill _ _ | .image _ _ => true
  | _ => false

def Op.need : Op → Nat
  | .write b | .fill _ b | .image _ b => b
  | _ => 0

inductive Reach : St → Prop
  | init (L sess : Nat) (h : sess ≤ L) : Reach ⟨L, sess, [], []⟩
  | step {s : St} (op : Op) : Reach s → Reach (step s op).2.1

/-! ## What is proved -/

theorem step_limit (s : St) (op : Op) : (step s op).2.1.limit = s.limit := by
  cases op <;> simp only [step] <;> (try split) <;> rfl

theorem step_used (s : St) (h : used s ≤ s.limit) (op : Op) : used (step s op).2.1 ≤ s.limit := by
  cases op with
  | write b =>
    simp only [step]; split
    · rename_i ev sv hf
      have := (fitDrop_some hf).2
      simp only [used, fixedS] at this ⊢; omega
    · exact h
  | fill n b =>
    simp only [step]; split
    · rename_i ev sv hf
      have := (fitDrop_some hf).2
      have e := sumB_split s.facets n
      simp only [used, fixedS, sumB_append, sumB_cons, sumB_nil] at this e ⊢; omega
    · exact h
  | image k b =>
    simp only [step]; split
    · rename_i ev sv hf
      have := (fitDrop_some hf).2
      simp only [used, fixedS, sumB_append, sumB_cons, sumB_nil] at this ⊢; omega
    · exact h
  | touch k =>
    have e := sumB_split s.images k
    simp only [step]; split
    · simp only [used, sumB_append, sumB_cons, sumB_nil] at h e ⊢; omega
    · exact h
  | delSess b => simp only [step, used] at h ⊢; omega
  | delFacet n =>
    have e := sumB_split s.facets n
    simp only [step, used] at h e ⊢; omega
  | settle n b =>
    have e := sumB_split s.facets n
    simp only [step]; split
    · simp only [used, sumB_append, sumB_cons, sumB_nil] at h e ⊢
      have := Nat.min_le_right b (cur s.facets n); omega
    · exact h
  | dropImages keep =>
    have := sumB_filter_le s.images (fun x => keep.contains x.1)
    simp only [step, used] at h ⊢; omega
  | abort _ => exact h
  | restart => exact h

/-- Used never exceeds the limit. -/
theorem used_le_limit {s : St} (h : Reach s) : used s ≤ s.limit := by
  induction h with
  | init L sess h => simpa [used] using h
  | step op _ ih => rw [step_limit]; exact step_used _ ih op

/-- A refused write changes nothing and evicts nothing. -/
theorem refused_unchanged (s : St) (op : Op) (h : (step s op).1 = .enospc) :
    (step s op).2.1 = s ∧ (step s op).2.2 = [] := by
  cases op <;> simp only [step] at h ⊢ <;> (repeat' split at h) <;> simp_all

/-- It is refused exactly when it would not fit with every evictable image gone. -/
theorem refuses_iff (s : St) (op : Op) (ha : op.admits = true) :
    (step s op).1 = .enospc ↔
      s.limit < fixedS s + (match op with | .image k _ => cur s.images k | _ => 0) + op.need := by
  cases op <;> simp [Op.admits] at ha
  all_goals
    simp only [step, Op.need]
    split
    · rename_i hf; simp only [reduceCtorEq, false_iff, Nat.not_lt]
      have := (fitDrop_some hf).2; omega
    · rename_i hf; simp only [true_iff]; have := fitDrop_none.mp hf; omega

/-- What is evicted is the oldest evictable images, and no fewer would have done. -/
theorem evicts_oldest_minimal (s : St) (b : Nat) :
    ∀ ev sv, fitDrop s.limit b (fixedS s) s.images = some (ev, sv) →
      ev ++ sv = s.images ∧ (ev = [] ∨ ∃ x, ev.getLast? = some x ∧ s.limit < fixedS s + sumB (x :: sv) + b) := by
  intro ev sv h
  refine ⟨(fitDrop_some h).1, ?_⟩
  rcases fitDrop_min h with e | ⟨x, hx, hl⟩
  · exact Or.inl e
  · exact Or.inr ⟨x, hl, by rw [hl] at hx; simpa using hx⟩

/-- Every operation but a delete frees at most the bytes of the images it evicted,
    and only an admitted write evicts. -/
theorem only_eviction_frees (s : St) (op : Op) (hf : op.frees = false) :
    used s ≤ used (step s op).2.1 + sumB (step s op).2.2 ∧ (op.admits = false → (step s op).2.2 = []) := by
  cases op <;> simp [Op.frees] at hf
  case write b =>
    simp only [step]; split
    · rename_i ev sv h
      have := (fitDrop_some h).1
      refine ⟨?_, by simp [Op.admits]⟩
      simp only [used]; rw [← this, sumB_append]; omega
    · simp
  case fill n b =>
    simp only [step]; split
    · rename_i ev sv h
      have := (fitDrop_some h).1
      have e := sumB_split s.facets n
      refine ⟨?_, by simp [Op.admits]⟩
      simp only [used, sumB_append, sumB_cons, sumB_nil] at e ⊢; rw [← this, sumB_append]; omega
    · simp
  case image k b =>
    simp only [step]; split
    · rename_i ev sv h
      have := (fitDrop_some h).1
      have e := sumB_split s.images k
      refine ⟨?_, by simp [Op.admits]⟩
      simp only [used, sumB_append, sumB_cons, sumB_nil] at e ⊢
      rw [e, ← this, sumB_append]; omega
    · simp
  case touch k =>
    have e := sumB_split s.images k
    simp only [step]; split
    · refine ⟨?_, fun _ => rfl⟩
      simp only [used, sumB_append, sumB_cons, sumB_nil]; omega
    · simp
  all_goals simp [step]

/-- A facet row leaves the ledger only by `facets.delete`. -/
theorem facet_row_stays (s : St) (op : Op) (n : Nat) (hd : ∀ m, op ≠ .delFacet m ∨ m ≠ n)
    (hn : n ∈ s.facets.map (fun x : Row => x.1)) : n ∈ (step s op).2.1.facets.map (fun x : Row => x.1) := by
  have keep : ∀ m b, n ∈ (others s.facets m ++ [(m, b)]).map (fun x : Row => x.1) := by
    intro m b
    by_cases e : m = n
    · simp [e]
    · obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hn
      exact List.mem_map.mpr ⟨x, List.mem_append_left _ (List.mem_filter.mpr ⟨hx, by simpa using fun h => e h.symm⟩), rfl⟩
  cases op with
  | write b => simp only [step]; split <;> exact hn
  | fill m b => simp only [step]; split; exact keep m _; exact hn
  | image k b => simp only [step]; split <;> exact hn
  | delFacet m =>
    rcases hd m with h | h
    · exact absurd rfl h
    · obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hn
      exact List.mem_map.mpr ⟨x, List.mem_filter.mpr ⟨hx, by simpa using fun e => h e.symm⟩, rfl⟩
  | settle m b => simp only [step]; split; exact keep m _; exact hn
  | touch k => simp only [step]; split <;> exact hn
  | _ => exact hn

/-! ## Traces -/

/-- Limit 100; session 40, facet 1 at 20, images of principals 1 (15) and 2 (15),
    1 oldest. A 20-byte write evicts principal 1's image only; a 60-byte write is
    refused and nothing changes; after `abort` the dead facet still counts, and
    `facets.delete` frees it. -/
theorem a_ledger_trace :
    let s0 : St := ⟨100, 40, [(1, 20)], [(1, 15), (2, 15)]⟩
    let r1 := step s0 (.write 20)
    let r2 := step r1.2.1 (.write 60)
    let r3 := step r2.2.1 (.abort 1)
    let r4 := step r3.2.1 (.delFacet 1)
    r1.1 = .ok ∧ r1.2.2 = [(1, 15)] ∧ r1.2.1.images = [(2, 15)] ∧ used r1.2.1 = 95 ∧
      r2.1 = .enospc ∧ used r2.2.1 = 95 ∧ used r3.2.1 = 95 ∧ used r4.2.1 = 75 := by
  decide

end Nimbus.Vfs.Ledger
