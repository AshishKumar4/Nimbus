/-
  Nimbus.Runtime.PipesProofs — the pipe model's properties (see `Nimbus.Runtime.Pipes`).
-/

import Nimbus.Runtime.Pipes

namespace Nimbus.Runtime.Pipes

variable (R : Rules)

/-! ## Basics -/

@[simp] theorem upd_same {α : Type} (f : Nat → α) (i : Nat) (v : α) : upd f i v i = v := by simp [upd]
@[simp] theorem upd_ne {α : Type} (f : Nat → α) {i j : Nat} (v : α) (h : j ≠ i) : upd f i v j = f j := by simp [upd, h]

theorem sum_snoc (l : List Nat) (x : Nat) : (l ++ [x]).sum = l.sum + x := by
  induction l with
  | nil => simp
  | cons y l ih => simp only [List.cons_append, List.sum_cons, ih]; omega

theorem sumTo_succ (n : Nat) (f : Nat → Nat) : sumTo (n + 1) f = sumTo n f + f n := by
  simp only [sumTo, List.range_succ, List.map_append, List.map_cons, List.map_nil, sum_snoc]

theorem sumTo_congr {n : Nat} {f g : Nat → Nat} (h : ∀ i < n, f i = g i) : sumTo n f = sumTo n g := by
  induction n with
  | zero => rfl
  | succ n ih => rw [sumTo_succ, sumTo_succ, ih (fun i hi => h i (by omega)), h n (by omega)]

theorem sumTo_le {n : Nat} {f g : Nat → Nat} (h : ∀ i < n, f i ≤ g i) : sumTo n f ≤ sumTo n g := by
  induction n with
  | zero => exact Nat.le_refl _
  | succ n ih => rw [sumTo_succ, sumTo_succ]; have := ih (fun i hi => h i (by omega)); have := h n (by omega); omega

theorem sumTo_upd (n : Nat) (f : Nat → Nat) (i v : Nat) (hi : i < n) :
    sumTo n (upd f i v) + f i = sumTo n f + v := by
  induction n with
  | zero => omega
  | succ n ih =>
    rw [sumTo_succ, sumTo_succ]
    by_cases e : i = n
    · subst e
      have : sumTo i (upd f i v) = sumTo i f := sumTo_congr (fun j hj => upd_ne f v (by omega))
      rw [this, upd_same]; omega
    · have := ih (by omega)
      rw [upd_ne f v (Ne.symm e)]; omega

theorem sumTo_eq_zero {n : Nat} {f : Nat → Nat} : sumTo n f = 0 ↔ ∀ i < n, f i = 0 := by
  induction n with
  | zero => simp [sumTo]
  | succ n ih =>
    rw [sumTo_succ]
    constructor
    · intro h i hi
      rcases Nat.lt_succ_iff_lt_or_eq.mp hi with hi | rfl
      · exact ih.mp (by omega) i hi
      · omega
    · intro h
      have := ih.mpr (fun i hi => h i (by omega))
      have := h n (by omega)
      omega

@[simp] theorem rs_stack (s : St) (x : List Nat) (p : Nat) : rs { s with stack := x } p = rs s p := rfl
@[simp] theorem ws_stack (s : St) (x : List Nat) (p : Nat) : ws { s with stack := x } p = ws s p := rfl
@[simp] theorem rs_pipes (s : St) (x : Nat → Pipe) (p : Nat) : rs { s with pipes := x } p = rs s p := rfl
@[simp] theorem ws_pipes (s : St) (x : Nat → Pipe) (p : Nat) : ws { s with pipes := x } p = ws s p := rfl
@[simp] theorem settle_procs (s : St) : (settle s).procs = s.procs := rfl
@[simp] theorem settle_n (s : St) : (settle s).n = s.n := rfl
@[simp] theorem settle_m (s : St) : (settle s).m = s.m := rfl
@[simp] theorem settle_B (s : St) : (settle s).B = s.B := rfl
@[simp] theorem settle_err (s : St) : (settle s).err = s.err := rfl
@[simp] theorem setProc_pipes (s : St) (i : Nat) (pr : Proc) : (setProc s i pr).pipes = s.pipes := rfl
@[simp] theorem setProc_n (s : St) (i : Nat) (pr : Proc) : (setProc s i pr).n = s.n := rfl
@[simp] theorem setProc_m (s : St) (i : Nat) (pr : Proc) : (setProc s i pr).m = s.m := rfl
@[simp] theorem setProc_B (s : St) (i : Nat) (pr : Proc) : (setProc s i pr).B = s.B := rfl
@[simp] theorem setProc_err (s : St) (i : Nat) (pr : Proc) : (setProc s i pr).err = s.err := rfl

theorem rs_settle (s : St) (p : Nat) : rs (settle s) p = rs s p := rfl

/-! ## (2) SIGPIPE and EPIPE only without a reader; (5) ignored is EPIPE -/

@[simp] theorem enter_procs (s : St) (i : Nat) : (enter s i).procs = s.procs := rfl
@[simp] theorem enter_pipes (s : St) (i : Nat) : (enter s i).pipes = s.pipes := rfl
@[simp] theorem enter_m (s : St) (i : Nat) : (enter s i).m = s.m := rfl
@[simp] theorem rs_enter (s : St) (i p : Nat) : rs (enter s i) p = rs s p := rfl
@[simp] theorem ws_enter (s : St) (i p : Nat) : ws (enter s i) p = ws s p := rfl

theorem core_refuse (hR : R.heldKill = false) (s : St) (i : Nat)
    (h : (execCore R s i).1 = .sigpipe ∨ (execCore R s i).1 = .epipe) :
    ∃ p n rest, (s.procs i).prog = .write p n :: rest ∧ p < s.m ∧ rs s p = 0 := by
  rcases hp : (s.procs i).prog with _ | ⟨a, rest⟩
  · simp [execCore, hp] at h
  · cases a with
    | write p n =>
      refine ⟨p, n, rest, rfl, ?_⟩
      simp only [execCore, hp] at h
      by_cases hm : s.m ≤ p
      · simp [hm] at h
      by_cases h0 : rs s p = 0
      · exact ⟨by omega, h0⟩
      simp only [hm, h0, if_false] at h
      repeat' split at h
      all_goals simp at h
    | read p n =>
      simp only [execCore, hp] at h
      repeat' split at h
      all_goals simp at h
    | close p r => simp [execCore, hp] at h
    | fork k => simp only [execCore, hp] at h; split at h <;> simp at h
    | exit c => simp [execCore, hp, hR] at h

/-- A write is refused (SIGPIPE, or EPIPE) only when its pipe has no read end. -/
theorem sigpipe_only_readerless (hR : R.heldKill = false) (s : St) (i : Nat)
    (h : (execHead R s i).1 = .sigpipe ∨ (execHead R s i).1 = .epipe) :
    ∃ p n rest, (s.procs i).prog = .write p n :: rest ∧ p < s.m ∧ rs s p = 0 := by
  simpa using core_refuse R hR (enter s i) i h

/-- With SIGPIPE ignored, a write with no reader left fails with EPIPE, and the writer
    is not killed. -/
theorem ignored_is_epipe (hR : R.ignoreIgnored = false) (s : St) (i p n : Nat) (rest : List Act)
    (hp : (s.procs i).prog = .write p n :: rest) (hm : p < s.m) (h0 : rs s p = 0) (hi : (s.procs i).ign = true) :
    (execHead R s i).1 = .epipe ∧ ((execHead R s i).2.procs i).st ≠ .killed 13 := by
  have hm' : ¬ s.m ≤ p := by omega
  simp only [execHead, execCore, enter_procs, hp, enter_m, hm', if_false, rs_enter, h0, if_true, hi, hR,
    Bool.not_false, Bool.and_self]
  refine ⟨trivial, ?_⟩
  split <;> simp [finish, settle, setProc]

/-- Without an ignored SIGPIPE, the refused writer is killed by it (status 141). -/
theorem default_is_sigpipe (s : St) (i p n : Nat) (rest : List Act)
    (hp : (s.procs i).prog = .write p n :: rest) (hm : p < s.m) (h0 : rs s p = 0) (hi : (s.procs i).ign = false) :
    (execHead R s i).1 = .sigpipe ∧ ((execHead R s i).2.procs i).st = .killed 13 := by
  have hm' : ¬ s.m ≤ p := by omega
  simp only [execHead, execCore, enter_procs, hp, enter_m, hm', if_false, rs_enter, h0, if_true, hi,
    Bool.false_and, Bool.false_eq_true]
  simp [finish, settle, setProc]

/-! ## (1) a read ends only when no writer is left -/

theorem eof_only_writerless (s : St) (i : Nat) (h : (execHead R s i).1 = .eof) :
    ∃ p n rest, (s.procs i).prog = .read p n :: rest ∧ (s.pipes p).q = 0 ∧ ws s p = 0 := by
  simp only [execHead] at h
  rcases hp : (s.procs i).prog with _ | ⟨a, rest⟩
  · simp [execCore, hp] at h
  · cases a with
    | read p n =>
      refine ⟨p, n, rest, rfl, ?_⟩
      simp only [execCore, enter_procs, hp, enter_m, enter_pipes, ws_enter] at h
      by_cases hm : s.m ≤ p
      · simp [hm] at h
      by_cases hq : 0 < (s.pipes p).q
      · simp [hm, hq] at h
      by_cases hw : ws s p = 0
      · exact ⟨by omega, hw⟩
      simp only [hm, hq, hw, if_false] at h
      repeat' split at h
      all_goals simp at h
    | write p n =>
      simp only [execCore, enter_procs, hp] at h
      repeat' split at h
      all_goals simp at h
    | close p r => simp [execCore, hp] at h
    | fork k => simp only [execCore, enter_procs, hp] at h; split at h <;> simp at h
    | exit c =>
      simp only [execCore, enter_procs, hp] at h
      repeat' split at h
      all_goals simp at h

/-! ## (3) the scheduler -/

theorem sched_some (s : St) (i : Nat) (h : sched R s = some i) : enabled R s i = true :=
  List.find?_some h

theorem sched_none (s : St) (h : sched R s = none) : ∀ i < s.n, enabled R s i = false := by
  intro i hi
  have := List.find?_eq_none.mp h i (List.mem_range.mpr hi)
  simpa using this

/-! ## (1) a fork leaves a parked operation as it was -/

theorem fork_keeps_parked (hR : R.forkDrops = false) (s : St) (i k : Nat) :
    (forkParked R s i k).procs i = s.procs i ∧ (forkParked R s i k).pipes = s.pipes := by
  unfold forkParked
  simp only [hR]
  by_cases h : ((s.procs i).st = .parkW ∨ (s.procs i).st = .parkR) ∧ k < s.n ∧ (s.procs k).st = .unborn ∧ k ≠ i
  · rw [if_pos h]
    exact ⟨by simp [setProc, upd, Ne.symm h.2.2.2], rfl⟩
  · rw [if_neg h]; exact ⟨rfl, rfl⟩

/-- The child of a fork taken while its parent is parked starts running its own script,
    with a copy of every end, and no parked operation. -/
theorem fork_child_fresh (s : St) (i k : Nat) (hp : (s.procs i).st = .parkW ∨ (s.procs i).st = .parkR)
    (hk : k < s.n) (hu : (s.procs k).st = .unborn) (hki : k ≠ i) :
    ((forkParked R s i k).procs k).st = .run ∧ ((forkParked R s i k).procs k).prog = (s.procs k).prog ∧
      ((forkParked R s i k).procs k).rEnds = (s.procs i).rEnds ∧ ((forkParked R s i k).procs k).wEnds = (s.procs i).wEnds := by
  unfold forkParked
  simp only []
  rw [if_pos ⟨hp, hk, hu, hki⟩]
  split <;> simp [setProc, upd, hki]

/-! ## (1) accounting and (4) the budget -/

/-- A pipe's books: every accepted byte is read, in flight, discarded when its last
    reader closed, or lost; under the approved rules nothing is lost; the bytes in
    flight stay within the budget. -/
def Books (R : Rules) (B : Nat) (pp : Pipe) : Prop :=
  pp.acc = pp.rd + pp.q + pp.drop + pp.lost ∧ (R.heldKill = false → R.forkDrops = false → pp.lost = 0) ∧
    (R.heldKill = false → R.globalBudget = false → pp.q ≤ B)

def AllBooks (s : St) : Prop := ∀ p, Books R s.B (s.pipes p)

theorem books_settle {s : St} (h : AllBooks R s) : AllBooks R (settle s) := by
  intro p
  simp only [settle]
  split
  · obtain ⟨h1, h2, h3⟩ := h p
    exact ⟨by simp only at h1 ⊢; omega, h2, fun _ _ => Nat.zero_le _⟩
  · exact h p

theorem books_upd {s : St} (h : AllBooks R s) {p : Nat} {pp : Pipe} (hp : Books R s.B pp) :
    AllBooks R { s with pipes := upd s.pipes p pp } := by
  intro q
  by_cases e : q = p
  · subst e; simpa using hp
  · simpa [upd_ne _ _ e] using h q

theorem books_procs {s : St} (h : AllBooks R s) (f : Nat → Proc) (x : List Nat) (e : Option String) :
    AllBooks R { s with procs := f, stack := x, err := e } := h

theorem books_finish {s : St} (h : AllBooks R s) (i : Nat) (st : PSt) : AllBooks R (finish s i st) :=
  books_settle R h

theorem books_abort {s : St} (h : AllBooks R s) (m : String) : AllBooks R (abort s m) :=
  books_settle R h

theorem books_core (s : St) (i : Nat) (h : AllBooks R s) : AllBooks R (execCore R s i).2 := by
  have hs : ∀ (pr : Proc), AllBooks R (setProc s i pr) := fun _ => h
  rcases hp : (s.procs i).prog with _ | ⟨a, rest⟩
  · simp only [execCore, hp]; exact books_finish R h _ _
  · cases a with
    | write p n =>
      simp only [execCore, hp]
      by_cases c1 : s.m ≤ p
      · simp only [c1, if_true]; exact books_finish R h _ _
      simp only [c1, if_false]
      by_cases c2 : rs s p = 0
      · simp only [c2, if_true]
        by_cases c3 : ((s.procs i).ign && !R.ignoreIgnored) = true
        · simp only [c3, if_true]
          by_cases c4 : (s.procs i).errExit = true
          · simp only [c4, if_true]; exact books_finish R h _ _
          · simp only [c4, Bool.false_eq_true, if_false]; exact hs _
        · simp only [c3, Bool.false_eq_true, if_false]; exact books_finish R h _ _
      simp only [c2, if_false]
      by_cases c5 : accepts R s (s.procs i) p n = true
      · simp only [c5, if_true]
        apply books_procs R (books_upd R h _)
        obtain ⟨h1, h2, h3⟩ := h p
        refine ⟨by simp only at h1 ⊢; omega, h2, fun hk hg => ?_⟩
        simp only [accepts, hg, Bool.false_eq_true, if_false, Bool.and_eq_true, decide_eq_true_eq] at c5
        simp only; omega
      simp only [c5, Bool.false_eq_true, if_false]
      split
      · exact hs _
      · split
        · exact hs _
        · exact books_procs R h _ _ _
    | read p n =>
      simp only [execCore, hp]
      by_cases c1 : s.m ≤ p
      · simp only [c1, if_true]; exact books_finish R h _ _
      simp only [c1, if_false]
      by_cases c2 : 0 < (s.pipes p).q
      · simp only [c2, if_true]
        apply books_procs R (books_upd R h _)
        obtain ⟨h1, h2, h3⟩ := h p
        refine ⟨by simp only at h1 ⊢; have := Nat.min_le_right n (s.pipes p).q; omega, h2, fun hk hg => ?_⟩
        simp only; have := h3 hk hg; omega
      simp only [c2, if_false]
      by_cases c3 : ws s p = 0
      · simp only [c3, if_true]; exact hs _
      simp only [c3, if_false]
      by_cases c4 : writersNested s p = true
      · simp only [c4, if_true]
        split
        · exact books_finish R h _ _
        · exact books_abort R h _
      · simp only [c4, Bool.false_eq_true, if_false]
        split
        · exact hs _
        · exact hs _
    | close p r => simp only [execCore, hp]; exact books_settle R (hs _)
    | fork k =>
      simp only [execCore, hp]
      split
      · exact h
      · exact hs _
    | exit c =>
      simp only [execCore, hp]
      split
      · rename_i hk
        split
        · rename_i p hf
          apply books_finish R (books_upd R h _)
          obtain ⟨h1, h2, h3⟩ := h p
          have hC : s.C < (s.pipes p).q := by
            have := List.find?_some hf
            simp only [Bool.and_eq_true, decide_eq_true_eq] at this
            exact this.1.2
          refine ⟨by simp only at h1 ⊢; omega, fun hk' => ?_, fun hk' => ?_⟩ <;>
            (simp only [hk', Bool.false_and, Bool.false_eq_true] at hk)
        · exact books_finish R h _ _
      · exact books_finish R h _ _

theorem books_step (s : St) (e : Ev) (h : AllBooks R s) : AllBooks R (step R s e) := by
  cases e with
  | run i =>
    simp only [step]
    split
    · exact books_core R _ i (h : AllBooks R (enter s i))
    · exact h
  | forkParked i k =>
    simp only [step, forkParked]
    split
    · split
      · rename_i p n rest _ _ _
        intro q
        show Books R s.B (upd s.pipes p _ q)
        by_cases e : q = p
        · subst e
          rw [upd_same]
          obtain ⟨h1, h2, h3⟩ := h q
          refine ⟨?_, fun _ hf => by simp_all, fun hk hg => h3 hk hg⟩
          simp only [setProc_pipes]
          omega
        · rw [upd_ne _ _ e]; exact h q
      · exact h
    · exact h
  | stuck =>
    simp only [step]
    split
    · exact books_abort R h _
    · exact h

theorem core_B (s : St) (i : Nat) : (execCore R s i).2.B = s.B := by
  rcases hp : (s.procs i).prog with _ | ⟨a, rest⟩
  · simp only [execCore, hp]; rfl
  · cases a <;> simp only [execCore, hp] <;> (repeat' split) <;> rfl

theorem step_B (s : St) (e : Ev) : (step R s e).B = s.B := by
  cases e with
  | run i => simp only [step]; split; exact core_B R _ i; rfl
  | forkParked i k => simp only [step, forkParked]; repeat' split
                      all_goals rfl
  | stuck => simp only [step]; split <;> rfl

theorem books {s : St} (h : Reach R s) : AllBooks R s := by
  induction h with
  | init c => intro p; exact ⟨rfl, fun _ _ => rfl, fun _ _ => Nat.zero_le _⟩
  | step e _ ih =>
    have := books_step R _ e ih
    intro p; have h := this p; rw [step_B] at h ⊢; exact h

/-- (1) Every byte a writer handed over is read, still in flight, or was discarded when
    its pipe's last reader closed; none is lost. -/
theorem accounting (hR : R = Rules.ok) {s : St} (h : Reach R s) (p : Nat) :
    (s.pipes p).acc = (s.pipes p).rd + (s.pipes p).q + (s.pipes p).drop ∧ (s.pipes p).lost = 0 := by
  obtain ⟨h1, h2, _⟩ := books R h p
  have := h2 (by subst hR; rfl) (by subst hR; rfl)
  exact ⟨by omega, this⟩

/-- (4) A pipe never holds more than the budget. -/
theorem budget (hR : R = Rules.ok) {s : St} (h : Reach R s) (p : Nat) : (s.pipes p).q ≤ s.B :=
  (books R h p).2.2 (by subst hR; rfl) (by subst hR; rfl)

/-- Discarding happens only to a pipe whose last read end is gone. -/
theorem drop_only_readerless (s : St) (p : Nat) (h : (s.pipes p).drop < ((settle s).pipes p).drop) : rs s p = 0 := by
  simp only [settle] at h
  split at h
  · assumption
  · omega

/-- A command stopped with a named error has a non-zero status. -/
theorem abort_named (s : St) (last : Nat) (h : s.err.isSome = true) : cmdStatus s last ≠ 0 := by
  simp only [cmdStatus, h, if_true]; omega

/-! ## (3) no spin: every scheduler step lowers a measure -/

/-- Twice the script left, plus one while running. -/
def wt (pr : Proc) : Nat := 2 * pr.prog.length + (if pr.st = .run then 1 else 0)

def meas (s : St) : Nat := sumTo s.n fun j => wt (s.procs j)

theorem meas_setProc (s : St) (i : Nat) (pr : Proc) (hi : i < s.n) :
    meas (setProc s i pr) + wt (s.procs i) = meas s + wt pr := by
  have : (fun j => wt (upd s.procs i pr j)) = upd (fun j => wt (s.procs j)) i (wt pr) := by
    funext j; by_cases e : j = i
    · subst e; simp
    · simp [upd_ne _ _ e]
  simp only [meas, setProc_n]
  show sumTo s.n (fun j => wt (upd s.procs i pr j)) + _ = _
  rw [this]; exact sumTo_upd _ _ _ _ hi

@[simp] theorem meas_pipes (s : St) (x : Nat → Pipe) : meas { s with pipes := x } = meas s := rfl
@[simp] theorem meas_stack (s : St) (x : List Nat) : meas { s with stack := x } = meas s := rfl
@[simp] theorem meas_settle (s : St) : meas (settle s) = meas s := rfl
@[simp] theorem meas_enter (s : St) (i : Nat) : meas (enter s i) = meas s := rfl

theorem meas_finish (s : St) (i : Nat) (st : PSt) (hi : i < s.n) (hs : st ≠ .run) :
    meas (finish s i st) + wt (s.procs i) = meas s := by
  have := meas_setProc s i { s.procs i with st := st, prog := [] } hi
  have h0 : wt { s.procs i with st := st, prog := [] } = 0 := by simp [wt, hs]
  have e : meas (finish s i st) = meas (setProc s i { s.procs i with st := st, prog := [] }) := rfl
  rw [e]; omega

theorem meas_abort (s : St) (m : String) (i : Nat) (hi : i < s.n) (ha : alive (s.procs i) = true) :
    meas (abort s m) + wt (s.procs i) ≤ meas s := by
  simp only [abort, meas_settle]
  let f := fun j => wt (s.procs j)
  have hle : sumTo s.n (fun j => wt (if alive (s.procs j) then { s.procs j with st := .aborted, prog := [] } else s.procs j))
      ≤ sumTo s.n (upd f i 0) := by
    apply sumTo_le; intro j _
    by_cases e : j = i
    · subst e; simp [ha, wt, upd]
    · rw [upd_ne _ _ e]; split
      · simp [wt]
      · exact Nat.le_refl _
  have hu := sumTo_upd s.n f i 0 hi
  show sumTo s.n (fun j => wt (if alive (s.procs j) then { s.procs j with st := .aborted, prog := [] } else s.procs j))
    + f i ≤ sumTo s.n f
  omega

theorem wt_run_pos (pr : Proc) (h : pr.st = .run) : 0 < wt pr := by simp [wt, h]

theorem meas_congr {a b : St} (hn : a.n = b.n) (hp : a.procs = b.procs) : meas a = meas b := by
  simp [meas, hn, hp]

theorem lt_of_set {t r : St} {i : Nat} {pr : Proc} (hr : r.n = t.n ∧ r.procs = upd t.procs i pr) (hi : i < t.n)
    (hw : wt pr < wt (t.procs i)) : meas r < meas t := by
  have e : meas r = meas (setProc t i pr) := meas_congr hr.1 hr.2
  have := meas_setProc t i pr hi
  omega

theorem lt_of_set2 {t r : St} {i k : Nat} {a b : Proc} (hr : r.n = t.n ∧ r.procs = upd (upd t.procs k a) i b)
    (hi : i < t.n) (hk : k < t.n) (hki : k ≠ i) (hw : wt a + wt b < wt (t.procs k) + wt (t.procs i)) :
    meas r < meas t := by
  have e : meas r = meas (setProc (setProc t k a) i b) := meas_congr hr.1 hr.2
  have h1 := meas_setProc t k a hk
  have h2 := meas_setProc (setProc t k a) i b hi
  have h3 : (setProc t k a).procs i = t.procs i := by simp [setProc, upd, Ne.symm hki]
  rw [h3] at h2
  omega

theorem lt_of_abort {t r : St} {m : String} {i : Nat} (hr : r.n = t.n ∧ r.procs = (abort t m).procs) (hi : i < t.n)
    (ha : alive (t.procs i) = true) (hw : 0 < wt (t.procs i)) : meas r < meas t := by
  have e : meas r = meas (abort t m) := meas_congr hr.1 hr.2
  have := meas_abort t m i hi ha
  omega

/-- The weight of a process that runs one more action and keeps running. -/
theorem wt_next (pr : Proc) (a : Act) (rest : List Act) (hp : pr.prog = a :: rest) :
    wt { pr with prog := rest, st := .run } + 1 ≤ wt pr := by
  simp [wt, hp]; split <;> omega

theorem wt_pos (pr : Proc) (a : Act) (rest : List Act) (hp : pr.prog = a :: rest) : 0 < wt pr := by
  simp only [wt, hp, List.length_cons]; split <;> omega

theorem wt_park (pr : Proc) (l : List Act) (st : PSt) (hr : pr.st = .run) (hl : pr.prog = l) (hs : st ≠ .run) :
    wt { pr with prog := l, st := st } < wt pr := by
  simp [wt, hr, hs, hl]

/-- A running process's step lowers the measure, whatever it does. -/
theorem core_run (t : St) (i : Nat) (hi : i < t.n) (hr : (t.procs i).st = .run) :
    meas (execCore R t i).2 < meas t := by
  have hal : alive (t.procs i) = true := by simp [alive, hr]
  rcases hp : (t.procs i).prog with _ | ⟨a, rest⟩
  · simp only [execCore, hp]
    exact lt_of_set ⟨rfl, rfl⟩ hi (by simp [wt, hr, hp])
  have hn := wt_next (t.procs i) a rest hp
  have hpos := wt_pos (t.procs i) a rest hp
  have hfin : ∀ st, st ≠ PSt.run → wt { t.procs i with st := st, prog := [] } < wt (t.procs i) := by
    intro st hs; simp [wt, hs]; exact hpos
  cases a with
  | write p n =>
    simp only [execCore, hp]
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
    split
    · split
      · split
        · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
        · exact lt_of_set ⟨rfl, rfl⟩ hi (by omega)
      · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (by omega)
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (wt_park _ _ _ hr hp (by simp))
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (wt_park _ _ _ hr hp (by simp))
    · exact lt_of_set ⟨rfl, rfl⟩ hi (wt_park _ _ _ hr hp (by simp))
  | read p n =>
    simp only [execCore, hp]
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (by omega)
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (by omega)
    split
    · split
      · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
      · exact lt_of_abort ⟨rfl, rfl⟩ hi hal hpos
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi (wt_park _ _ _ hr hp (by simp))
    · exact lt_of_set ⟨rfl, rfl⟩ hi (wt_park _ _ _ hr hp (by simp))
  | close p r =>
    simp only [execCore, hp]
    exact lt_of_set ⟨rfl, rfl⟩ hi (by simp only [wt, hp, List.length_cons] at hn ⊢; simp; omega)
  | fork k =>
    simp only [execCore, hp]
    split
    · rename_i hk
      have hki : k ≠ i := by intro e; subst e; rw [hr] at hk; exact absurd hk.2 (by simp)
      refine lt_of_set2 (k := k) ⟨rfl, rfl⟩ hi hk.1 hki ?_
      have hku : wt (t.procs k) = 2 * (t.procs k).prog.length := by simp [wt, hk.2]
      have : wt { t.procs k with st := .run, rEnds := (t.procs i).rEnds, wEnds := (t.procs i).wEnds }
          = 2 * (t.procs k).prog.length + 1 := by simp [wt]
      simp only [wt, List.length_cons, hp, hr, if_true] at hn ⊢
      omega
    · exact lt_of_set ⟨rfl, rfl⟩ hi (by omega)
  | exit c =>
    simp only [execCore, hp]
    split
    · split
      · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
      · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))
    · exact lt_of_set ⟨rfl, rfl⟩ hi (hfin _ (by simp))

theorem wt_wait (pr : Proc) (a : Act) (rest : List Act) (hp : pr.prog = a :: rest) (hs : pr.st ≠ .run) :
    wt { pr with prog := rest, st := .run } < wt pr := by
  simp [wt, hp, hs]; omega

theorem wt_fin (pr : Proc) (a : Act) (rest : List Act) (hp : pr.prog = a :: rest) (st : PSt) (hs : st ≠ .run) :
    wt { pr with st := st, prog := [] } < wt pr := by
  have h0 : wt { pr with st := st, prog := [] } = 0 := by simp [wt, hs]
  rw [h0]; exact wt_pos pr a rest hp

/-- What `enabled` says of a waiting process: its pending operation can complete now. -/
theorem enabled_wait (s : St) (i : Nat) (hr : (s.procs i).st ≠ .run) (hen : enabled R s i = true) :
    i < s.n ∧ alive (s.procs i) = true ∧
    ((∃ p n rest, (s.procs i).prog = .write p n :: rest ∧ (s.m ≤ p ∨ rs s p = 0 ∨ accepts R s (s.procs i) p n = true)) ∨
     (∃ p n rest, (s.procs i).prog = .read p n :: rest ∧
        (s.m ≤ p ∨ 0 < (s.pipes p).q ∨ ws s p = 0 ∨ writersNested (enter s i) p = true))) := by
  unfold enabled at hen
  simp only [Bool.and_eq_true, decide_eq_true_eq] at hen
  obtain ⟨⟨hi, _⟩, hen⟩ := hen
  refine ⟨hi, ?_⟩
  split at hen
  · exact absurd ‹_› hr
  · rename_i p n rest hst hp
    refine ⟨by simp [alive, hst], Or.inl ⟨p, n, rest, hp, ?_⟩⟩
    simp only [Bool.or_eq_true, decide_eq_true_eq, beq_iff_eq] at hen
    rcases hen with (h | h) | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr h)
  · rename_i p n rest hst hp
    refine ⟨by simp [alive, hst], Or.inr ⟨p, n, rest, hp, ?_⟩⟩
    simp only [Bool.or_eq_true, decide_eq_true_eq, beq_iff_eq] at hen
    rcases hen with ((h | h) | h) | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr (Or.inl h))
    · exact Or.inr (Or.inr (Or.inr h))
  · rename_i p n rest hst hp
    refine ⟨by simp [alive, hst], Or.inl ⟨p, n, rest, hp, ?_⟩⟩
    simp only [Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq, beq_iff_eq] at hen
    rcases hen.2 with (h | h) | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr h)
  · rename_i p n rest hst hp
    refine ⟨by simp [alive, hst], Or.inr ⟨p, n, rest, hp, ?_⟩⟩
    simp only [Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq, beq_iff_eq] at hen
    rcases hen.2 with ((h | h) | h) | h
    · exact Or.inl h
    · exact Or.inr (Or.inl h)
    · exact Or.inr (Or.inr (Or.inl h))
    · exact Or.inr (Or.inr (Or.inr h))
  · cases hen

/-- A waiting process the scheduler may resume completes its operation: the measure drops. -/
theorem core_wait (s : St) (i : Nat) (hr : (s.procs i).st ≠ .run) (hen : enabled R s i = true) :
    meas (execCore R (enter s i) i).2 < meas s := by
  obtain ⟨hi, hal, hc⟩ := enabled_wait R s i hr hen
  rw [← meas_enter s i]
  have hi' : i < (enter s i).n := hi
  rcases hc with ⟨p, n, rest, hp, hc⟩ | ⟨p, n, rest, hp, hc⟩
  · have hfin := wt_fin (s.procs i) _ rest hp
    have hwt := wt_wait (s.procs i) _ rest hp hr
    simp only [execCore, enter_procs, hp, enter_m, rs_enter]
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi' (hfin _ (by simp))
    rename_i hm
    split
    · split
      · split
        · exact lt_of_set ⟨rfl, rfl⟩ hi' (hfin _ (by simp))
        · exact lt_of_set ⟨rfl, rfl⟩ hi' hwt
      · exact lt_of_set ⟨rfl, rfl⟩ hi' (hfin _ (by simp))
    rename_i h0
    have ha : accepts R (enter s i) (s.procs i) p n = true := by
      rcases hc with h | h | h
      · exact absurd h hm
      · exact absurd h h0
      · exact h
    rw [if_pos ha]
    exact lt_of_set ⟨rfl, rfl⟩ hi' hwt
  · have hfin := wt_fin (s.procs i) _ rest hp
    have hwt := wt_wait (s.procs i) _ rest hp hr
    have hpos := wt_pos (s.procs i) _ rest hp
    simp only [execCore, enter_procs, hp, enter_m, enter_pipes, ws_enter]
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi' (hfin _ (by simp))
    rename_i hm
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi' hwt
    rename_i hq
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi' hwt
    rename_i hw
    have hwn : writersNested (enter s i) p = true := by
      rcases hc with h | h | h | h
      · exact absurd h hm
      · exact absurd h hq
      · exact absurd h hw
      · exact h
    rw [if_pos hwn]
    split
    · exact lt_of_set ⟨rfl, rfl⟩ hi' (hfin _ (by simp))
    · exact lt_of_abort ⟨rfl, rfl⟩ hi' hal hpos

/-- (3) Every scheduler step lowers the measure: the scheduler never spins, and every
    run of it ends. -/
theorem no_spin (s : St) (i : Nat) (o : Out) (s' : St) (h : schedStep R s = some (i, o, s')) : meas s' < meas s := by
  unfold schedStep at h
  split at h
  · rename_i j hj
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, -, rfl⟩ := h
    have hen := sched_some R s _ hj
    have hi : j < s.n := by simp only [enabled, Bool.and_eq_true, decide_eq_true_eq] at hen; exact hen.1.1
    by_cases hr : (s.procs j).st = .run
    · have := core_run R (enter s j) j hi hr
      simpa [execHead] using this
    · exact core_wait R s j hr hen
  · split at h
    · rename_i ha
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨-, -, rfl⟩ := h
      simp only [anySusp, List.any_eq_true, List.mem_range, Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true',
        List.isEmpty_eq_false] at ha
      obtain ⟨j, hj, hs, hne⟩ := ha
      obtain ⟨a, rest, hp⟩ : ∃ a rest, (s.procs j).prog = a :: rest := by
        cases h : (s.procs j).prog with
        | nil => simp [h] at hne
        | cons a rest => exact ⟨a, rest, rfl⟩
      exact lt_of_abort ⟨rfl, rfl⟩ hj (by simp [alive, hs]) (wt_pos _ a rest hp)
    · cases h

/-- When the scheduler finds nothing to run and nothing is suspended, every live process
    waits as it would on Linux: its operation cannot complete now. -/
theorem stuck_is_linux (s : St) (h : schedStep R s = none) : ∀ i < s.n, enabled R s i = false := by
  unfold schedStep at h
  split at h
  · cases h
  · rename_i hn; exact sched_none R s hn

end Nimbus.Runtime.Pipes
