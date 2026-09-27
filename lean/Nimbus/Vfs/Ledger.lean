/-
  Nimbus.Vfs.Ledger — N18 admission (CUTOVER.md v3.1 §3, §2.8): the session's
  storage ledger and `admit`.

  used = the session DO's own bytes (`sess`) + every recorded facet database
  (`nimbus_facet_storage`, live, dead or persisted) + reservations. A write of
  `need` bytes is admitted before it is made: it is refused with ENOSPC and nothing
  changes when it does not fit. Nothing in the ledger is evictable: the namespace
  image cache the original design proposed was never wired to a producer and was
  removed rather than shipped as dead accounting.

  Proved, for every reachable state and every operation:
  - `used_le_limit`: used never exceeds the limit plus the overshoot facets
    reported beyond their admitted bytes (`report`: the row becomes the larger);
    `admitted_within`: an admitted operation that succeeds leaves used within the
    limit, so overshoot is never admitted more; `refuses_when_over`: while the
    session and facets are over the limit every admitted operation is refused.
  - `refused_unchanged`: a refused write (session write, facet fill, reserve, draw)
    leaves the whole state unchanged, destination included;
    `refuses_iff`: it is refused exactly when it would not fit.
  - `nothing_frees`: every operation other than a delete (a session delete,
    `facets.delete`, a size settlement or report, a release) never lowers used.
  - `facet_row_stays`: a facet row leaves the ledger only by `facets.delete`
    (`abort` and a restart keep it).
-/

namespace Nimbus.Vfs.Ledger

/-- A (key, bytes) row: a facet by name, a reservation by id. -/
abbrev Row := Nat × Nat

def sumB (l : List Row) : Nat := (l.map (·.2)).sum

/-- The bytes recorded under key `k`. -/
def cur (l : List Row) (k : Nat) : Nat := sumB (l.filter (·.1 == k))

def others (l : List Row) (k : Nat) : List Row := l.filter (·.1 != k)

structure St where
  limit : Nat
  sess : Nat
  facets : List Row
  /-- Ghost: the bytes facets have reported beyond what they were admitted. -/
  over : Nat := 0
  /-- Reservations by id: admitted bytes not yet drawn. -/
  res : List Row := []

def used (s : St) : Nat := s.sess + sumB s.facets + sumB s.res

/-- Set `r`'s row to `v`, dropping it at 0. -/
def setR (l : List Row) (r v : Nat) : List Row := others l r ++ (if v = 0 then [] else [(r, v)])

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

theorem sumB_setR (l : List Row) (r v : Nat) : sumB (setR l r v) = sumB (others l r) + v := by
  unfold setR; split <;> simp_all [sumB_append]

/-! ## Admission -/

/-- `fixed + need` fits the limit. Nothing is evictable, so this is the whole decision. -/
def fits (L need fixed : Nat) : Bool := decide (fixed + need ≤ L)

theorem fits_true {L need fixed : Nat} : fits L need fixed = true ↔ fixed + need ≤ L := by
  simp [fits]

theorem fits_false {L need fixed : Nat} : fits L need fixed = false ↔ L < fixed + need := by
  simp [fits]

/-! ## Operations -/

inductive Op where
  /-- A session-DO write (import page, cross-database copy target, snapshot rows, ...). -/
  | write (b : Nat)
  /-- A facet fill of `b` bytes into facet `n`. -/
  | fill (n b : Nat)
  | delSess (b : Nat)
  /-- `facets.delete(n)`. -/
  | delFacet (n : Nat)
  /-- A facet reports a `databaseSize` at or below its recorded bytes. -/
  | settle (n b : Nat)
  /-- A facet reports a `databaseSize` (boot, after a fill, exit): the row becomes
      max(reported, recorded), and anything above the recorded bytes is overshoot. -/
  | report (n b : Nat)
  /-- `facets.abort(n)`: the database persists. -/
  | abort (n : Nat)
  /-- A restart re-reads the ledger; reservations are released. -/
  | restart
  /-- Reserve `b` bytes under id `r`: admitted like a write of `b`. -/
  | reserve (r b : Nat)
  /-- Write `b` bytes against reservation `r`: what it covers is taken from it, the rest
      admitted like a write. -/
  | draw (r b : Nat)
  /-- A drawn write of `t` bytes rolled back: its bytes return to the reservation. -/
  | refund (r t : Nat)
  | release (r : Nat)
  | releaseAll
  deriving Repr

inductive Out where
  | ok
  | enospc
  deriving DecidableEq, Repr

/-- What admission charges: the session's bytes, the facets, and reservations. -/
def fixedS (s : St) : Nat := s.sess + sumB s.facets + sumB s.res

/-- One operation: the answer and the new state. -/
def step (s : St) : Op → Out × St
  | .write b =>
    if fits s.limit b (fixedS s) then (.ok, { s with sess := s.sess + b }) else (.enospc, s)
  | .fill n b =>
    if fits s.limit b (fixedS s) then (.ok, { s with facets := others s.facets n ++ [(n, cur s.facets n + b)] })
    else (.enospc, s)
  | .delSess b => (.ok, { s with sess := s.sess - b })
  | .delFacet n => (.ok, { s with facets := others s.facets n })
  | .settle n b =>
    if s.facets.any (·.1 == n) then (.ok, { s with facets := others s.facets n ++ [(n, min b (cur s.facets n))] })
    else (.ok, s)
  | .report n b =>
    (.ok, { s with facets := others s.facets n ++ [(n, max b (cur s.facets n))], over := s.over + (b - cur s.facets n) })
  | .abort _ => (.ok, s)
  | .restart => (.ok, { s with res := [] })
  | .reserve r b =>
    if fits s.limit b (fixedS s) then (.ok, { s with res := setR s.res r (cur s.res r + b) }) else (.enospc, s)
  | .draw r b =>
    if b ≤ cur s.res r then (.ok, { s with sess := s.sess + b, res := setR s.res r (cur s.res r - b) })
    else if fits s.limit (b - cur s.res r) (fixedS s) then (.ok, { s with sess := s.sess + b, res := setR s.res r 0 })
    else (.enospc, s)
  | .refund r t =>
    (.ok, { s with sess := s.sess - min t s.sess, res := setR s.res r (cur s.res r + min t s.sess) })
  | .release r => (.ok, { s with res := others s.res r })
  | .releaseAll => (.ok, { s with res := [] })

def Op.frees : Op → Bool
  | .delSess _ | .delFacet _ | .settle _ _ | .report _ _ | .restart | .release _ | .releaseAll => true
  | _ => false

def Op.admits : Op → Bool
  | .write _ | .fill _ _ | .reserve _ _ => true
  | _ => false

def Op.isDraw : Op → Bool
  | .draw _ _ => true
  | _ => false

def Op.need : Op → Nat
  | .write b | .fill _ b | .reserve _ b => b
  | _ => 0

inductive Reach : St → Prop
  | init (L sess : Nat) (h : sess ≤ L) : Reach ⟨L, sess, [], 0, []⟩
  | step {s : St} (op : Op) : Reach s → Reach (step s op).2

/-! ## What is proved -/

theorem step_limit (s : St) (op : Op) : (step s op).2.limit = s.limit := by
  cases op <;> simp only [step] <;> (repeat' split) <;> rfl

theorem step_over (s : St) (op : Op) : s.over ≤ (step s op).2.over := by
  cases op <;> simp only [step] <;> (repeat' split) <;> simp

/-- An admitted operation that succeeds leaves used within the limit: overshoot is
    never admitted more. -/
theorem admitted_within (s : St) (op : Op) (ha : op.admits = true) (hok : (step s op).1 = .ok) :
    used (step s op).2 ≤ s.limit := by
  cases op <;> simp [Op.admits] at ha
  case write b =>
    simp only [step] at hok ⊢; split at hok
    · rename_i hf; split
      · have := fits_true.mp hf; simp only [used, fixedS] at this ⊢; omega
      · rename_i hn; exact absurd hf hn
    · cases hok
  case fill n b =>
    have e := sumB_split s.facets n
    simp only [step] at hok ⊢; split at hok
    · rename_i hf; split
      · have := fits_true.mp hf; simp only [used, fixedS, sumB_append, sumB_cons, sumB_nil] at this e ⊢; omega
      · rename_i hn; exact absurd hf hn
    · cases hok
  case reserve r b =>
    have e := sumB_split s.res r
    simp only [step] at hok ⊢; split at hok
    · rename_i hf; split
      · have := fits_true.mp hf; simp only [used, fixedS, sumB_setR] at this e ⊢; omega
      · rename_i hn; exact absurd hf hn
    · cases hok

theorem step_used (s : St) (h : used s ≤ s.limit + s.over) (op : Op) :
    used (step s op).2 ≤ s.limit + (step s op).2.over := by
  have ho := step_over s op
  cases op with
  | write b =>
    simp only [step]; split
    · rename_i hf; have := fits_true.mp hf; simp only [used, fixedS] at this ⊢; omega
    · exact h
  | fill n b =>
    simp only [step]; split
    · rename_i hf; have := fits_true.mp hf
      have e := sumB_split s.facets n
      simp only [used, fixedS, sumB_append, sumB_cons, sumB_nil] at this e ⊢; omega
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
  | report n b =>
    have e := sumB_split s.facets n
    simp only [step, used, sumB_append, sumB_cons, sumB_nil] at h e ⊢
    have : max b (cur s.facets n) = cur s.facets n + (b - cur s.facets n) := by omega
    omega
  | abort _ => exact h
  | restart => simp only [step, used, sumB_nil] at h ⊢; omega
  | reserve r b =>
    simp only [step]; split
    · rename_i hf; have := fits_true.mp hf
      have e := sumB_split s.res r
      simp only [used, fixedS, sumB_setR] at this e ⊢; omega
    · exact h
  | draw r b =>
    have e := sumB_split s.res r
    simp only [step]; split
    · simp only [used, sumB_setR] at h e ⊢; omega
    · split
      · rename_i hb hf; have := fits_true.mp hf
        simp only [used, fixedS, sumB_setR] at this e ⊢; omega
      · exact h
  | refund r t =>
    have e := sumB_split s.res r
    have := Nat.min_le_right t s.sess
    simp only [step, used, sumB_setR] at h e ⊢; omega
  | release r =>
    have e := sumB_split s.res r
    simp only [step, used] at h e ⊢; omega
  | releaseAll => simp only [step, used, sumB_nil] at h ⊢; omega

/-- Used never exceeds the limit plus what facets reported beyond their admitted
    bytes; with no over-report, never the limit. -/
theorem used_le_limit {s : St} (h : Reach s) : used s ≤ s.limit + s.over := by
  induction h with
  | init L sess h => simpa [used] using h
  | step op _ ih => rw [step_limit]; exact step_used _ ih op

/-- Once the session's own bytes and the facets are over the limit, every admitted
    operation is refused. -/
theorem refuses_when_over (s : St) (op : Op) (ha : op.admits = true) (hov : s.limit < fixedS s) :
    (step s op).1 = .enospc := by
  cases op <;> simp [Op.admits] at ha
  all_goals
    simp only [step]
    split
    · rename_i hf; have := fits_true.mp hf; omega
    · rfl

/-- A refused write changes nothing. -/
theorem refused_unchanged (s : St) (op : Op) (h : (step s op).1 = .enospc) :
    (step s op).2 = s := by
  cases op <;> simp only [step] at h ⊢ <;> (repeat' split) <;> simp_all

/-- It is refused exactly when it would not fit. -/
theorem refuses_iff (s : St) (op : Op) (ha : op.admits = true) :
    (step s op).1 = .enospc ↔ s.limit < fixedS s + op.need := by
  cases op <;> simp [Op.admits] at ha
  all_goals
    simp only [step, Op.need]
    split
    · rename_i hf; simp only [reduceCtorEq, false_iff, Nat.not_lt]; exact fits_true.mp hf
    · rename_i hf; simp only [true_iff]; exact fits_false.mp (by simpa using hf)

/-- Every operation but a delete never lowers used: nothing is evicted on admission. -/
theorem nothing_frees (s : St) (op : Op) (hf : op.frees = false) : used s ≤ used (step s op).2 := by
  cases op <;> simp [Op.frees] at hf
  case write b => simp only [step]; split <;> simp [used] <;> omega
  case fill n b =>
    have e := sumB_split s.facets n
    simp only [step]; split
    · simp only [used, sumB_append, sumB_cons, sumB_nil] at e ⊢; omega
    · exact Nat.le_refl _
  case reserve r b =>
    have e := sumB_split s.res r
    simp only [step]; split
    · simp only [used, sumB_setR] at e ⊢; omega
    · exact Nat.le_refl _
  case draw r b =>
    have e := sumB_split s.res r
    simp only [step]; split
    · simp only [used, sumB_setR, sumB_nil]; omega
    · split
      · simp only [used, sumB_setR] at e ⊢; omega
      · exact Nat.le_refl _
  case refund r t =>
    have e := sumB_split s.res r
    have := Nat.min_le_right t s.sess
    simp only [step, used, sumB_setR, sumB_nil]; omega
  all_goals simp [step]

/-- A facet row leaves the ledger only by `facets.delete`. -/
theorem facet_row_stays (s : St) (op : Op) (n : Nat) (hd : ∀ m, op ≠ .delFacet m ∨ m ≠ n)
    (hn : n ∈ s.facets.map (fun x : Row => x.1)) : n ∈ (step s op).2.facets.map (fun x : Row => x.1) := by
  have keep : ∀ m b, n ∈ (others s.facets m ++ [(m, b)]).map (fun x : Row => x.1) := by
    intro m b
    by_cases e : m = n
    · simp [e]
    · obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hn
      exact List.mem_map.mpr ⟨x, List.mem_append_left _ (List.mem_filter.mpr ⟨hx, by simpa using fun h => e h.symm⟩), rfl⟩
  cases op with
  | write b => simp only [step]; split <;> exact hn
  | fill m b => simp only [step]; split; exact keep m _; exact hn
  | delFacet m =>
    rcases hd m with h | h
    · exact absurd rfl h
    · obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hn
      exact List.mem_map.mpr ⟨x, List.mem_filter.mpr ⟨hx, by simpa using fun e => h e.symm⟩, rfl⟩
  | settle m b => simp only [step]; split; exact keep m _; exact hn
  | report m b => exact keep m _
  | reserve q b => simp only [step]; split <;> exact hn
  | draw q b => simp only [step]; repeat' split
                all_goals exact hn
  | _ => exact hn

/-! ## Traces -/

/-- Limit 100; session 40, facet 1 at 20. A 20-byte write fits (80 used); a 60-byte
    write is refused and nothing changes; after `abort` the dead facet still counts,
    and `facets.delete` frees it. -/
theorem a_ledger_trace :
    let s0 : St := ⟨100, 40, [(1, 20)], 0, []⟩
    let r1 := step s0 (.write 20)
    let r2 := step r1.2 (.write 60)
    let r3 := step r2.2 (.abort 1)
    let r4 := step r3.2 (.delFacet 1)
    r1.1 = .ok ∧ used r1.2 = 80 ∧ r2.1 = .enospc ∧ used r2.2 = 80 ∧ used r3.2 = 80 ∧ used r4.2 = 60 := by
  decide

/-- Facet 1 was admitted 20 bytes and reports 90: the ledger takes 90 (110 used,
    overshoot 70), and refuses even a 1-byte write until something is deleted. -/
theorem an_over_report_refuses :
    let s0 : St := ⟨100, 10, [(1, 20)], 0, []⟩
    let r1 := step s0 (.report 1 90)
    let r2 := step r1.2 (.write 1)
    let r3 := step r2.2 (.delFacet 1)
    let r4 := step r3.2 (.write 1)
    used r1.2 = 100 ∧ r1.2.over = 70 ∧ r2.1 = .enospc ∧ r4.1 = .ok := by
  decide

/-! ## Reservations -/

/-- (1) A draw within its reservation is always admitted, and changes no total. -/
theorem draw_within (s : St) (r b : Nat) (hb : b ≤ cur s.res r) :
    (step s (.draw r b)).1 = .ok ∧ used (step s (.draw r b)).2 = used s := by
  have e := sumB_split s.res r
  simp only [step, hb, if_true, used, sumB_setR]
  exact ⟨trivial, by omega⟩

/-- A reservation only shrinks by its own draws, its release, or releasing all: nothing
    else another operation does (another reservation, a write, a fill, an over-report)
    takes from it. -/
theorem reservation_kept (s : St) (op : Op) (r : Nat)
    (hop : (∀ b, op ≠ .draw r b) ∧ op ≠ .release r ∧ op ≠ .releaseAll ∧ op ≠ .restart) :
    cur s.res r ≤ cur (step s op).2.res r := by
  have setR_cur : ∀ (l : List Row) (q v : Nat), cur (setR l q v) r = if q = r then v else cur l r := by
    intro l q v
    unfold setR cur others
    by_cases e : q = r
    · subst e
      have : ((l.filter (·.1 != q)).filter (·.1 == q)) = [] := by
        simp [List.filter_filter]
      split
      · rename_i hv; simp [List.filter_append, this, hv]
      · simp [List.filter_append, this]
    · rw [if_neg e]
      have : ((l.filter (·.1 != q)).filter (·.1 == r)) = l.filter (·.1 == r) := by
        rw [List.filter_filter]
        congr 1; funext x; by_cases h : x.1 = r <;> simp [h, e]
        · intro h'; exact e (h' ▸ h.symm ▸ rfl)
      split <;> simp [List.filter_append, this, e]
  obtain ⟨hd, hrel, hall, hrs⟩ := hop
  cases op with
  | reserve q b =>
    simp only [step]; split
    · rw [setR_cur]; split
      · subst_vars; omega
      · exact Nat.le_refl _
    · exact Nat.le_refl _
  | draw q b =>
    have hq : q ≠ r := fun e => hd b (by rw [e])
    simp only [step]; split
    · rw [setR_cur, if_neg hq]; exact Nat.le_refl _
    · split
      · rw [setR_cur, if_neg hq]; exact Nat.le_refl _
      · exact Nat.le_refl _
  | refund q t =>
    simp only [step]; rw [setR_cur]; split
    · subst_vars; omega
    · exact Nat.le_refl _
  | release q =>
    have hq : q ≠ r := fun e => hrel (by rw [e])
    have := setR_cur s.res q 0
    have e : setR s.res q 0 = others s.res q := by simp [setR]
    rw [e, if_neg hq] at this
    show cur s.res r ≤ cur (others s.res q) r
    rw [this]; exact Nat.le_refl _
  | releaseAll => exact absurd rfl hall
  | restart => exact absurd rfl hrs
  | write b => simp only [step]; split <;> exact Nat.le_refl _
  | fill n b => simp only [step]; split <;> exact Nat.le_refl _
  | settle n b => simp only [step]; split <;> exact Nat.le_refl _
  | _ => exact Nat.le_refl _

/-- Why a draw inside its reservation must not be admitted at all: with a facet over its
    admitted bytes, admitting even 0 bytes is refused. -/
theorem admitting_zero_can_be_refused :
    let s0 : St := ⟨100, 10, [(1, 20)], 0, []⟩
    let s1 := (step s0 (.reserve 7 30)).2
    let s2 := (step s1 (.report 1 90)).2
    (step s1 (.report 1 90)).1 = .ok ∧ fits s2.limit 0 (fixedS s2) = false ∧
      (step s2 (.draw 7 30)).1 = .ok := by
  decide

end Nimbus.Vfs.Ledger
