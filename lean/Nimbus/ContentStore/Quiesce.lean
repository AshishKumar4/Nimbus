/-
  Nimbus.ContentStore.Quiesce — the quiesced snapshot (`SqliteVFS.quiesced` /
  `spanning`, work/node-nomirror).

  Actors. Exclusive mutation leases are taken synchronously and never wait; each has
  a fresh owner. Spanning work is writeStream, restoreAsync and sliced copyTree; a
  stream may carry an owner. A quiesced snapshot appends itself to a FIFO chain of
  pending snapshots (the gate). Its turn comes when every earlier one has pinned; it
  pins once no spanning work is running and no lease is held (check and pin in one
  turn). New spanning work starts at once when no snapshot is pending, or when it
  carries the owner of a live lease (the bypass, `bypass := true`). Otherwise it waits
  on the newest pending snapshot and starts right after that one pins, in call order,
  before the next snapshot checks. Streams end when their source does (`endStream`);
  restoreAsync and copyTree run to the end on their own (`tick`).

  Who waits for whom, outside the store (the environment): each job has a `parent`.
  A lease's holder releases it only after the jobs it awaits (`parent = .lease n`)
  are done; a job finishes only after the jobs it awaits (`parent = .job k`) are
  done (`Resp`).

  Proved:
  (1) Deadlock freedom (`drain`): from every reachable state where every job a lease
      holder awaits carries its lease's owner, and no job awaits another spanning job
      (`WF`), a sequence of `Resp` events (streams ending, jobs running out, leases
      released) pins every pending snapshot and starts every gated job. Each gated
      job waits on a pending snapshot (`gated_on_pending`), so with no snapshot
      pending nothing is gated.
  (2) Consistency (`pin_clean`): a snapshot pins only when no spanning work is running
      and no lease is held, and its contents are exactly the jobs done then: no
      partial state of a spanning operation or a lease.
  (3) Liveness of unrelated work: a gated job waits on the snapshot that was newest
      when it arrived (`gated_on_newest`) and starts in the same step that snapshot
      pins (`pin_starts_its_waiters`); a lease never waits (`acquire_never_waits`).
  Traces: the clone (a lease plus streams under it) pins with the bypass
  (`clone_pins`) and deadlocks without it (`clone_deadlocks_without_bypass`); a lease
  taken after the gate is waited out and its streams run (`lease_after_gate`). The
  `WF` hypotheses are necessary: a lease holder awaiting a copyTree
  (`lease_awaiting_copy_deadlocks`) and a job awaiting a stream it starts
  (`job_awaiting_stream_deadlocks`) both deadlock under the rule.
-/

namespace Nimbus.ContentStore.Quiesce

inductive Kind where
  | stream
  | restore
  | copy
  deriving DecidableEq, Repr

inductive Par where
  | none
  | lease (n : Nat)
  | job (k : Nat)
  deriving DecidableEq, Repr

inductive JSt where
  | gated (w : Nat)
  | running
  | done
  deriving DecidableEq, Repr

structure Job where
  kind : Kind
  owner : Option Nat
  parent : Par
  st : JSt
  deriving DecidableEq, Repr

structure St where
  nextOwner : Nat
  leases : List Nat
  snaps : List Nat
  nextSnap : Nat
  jobs : List Job
  /-- Each pinned snapshot and the jobs done when it pinned. -/
  pins : List (Nat × List Nat)
  /-- Job ids in the order they started. -/
  starts : List Nat
  deriving Repr

def init : St := ⟨0, [], [], 0, [], [], []⟩

def isRunning (j : Job) : Bool := j.st == .running

def anyRunning (s : St) : Bool := s.jobs.any isRunning

def idsWhere (s : St) (p : Job → Bool) : List Nat :=
  ((s.jobs.zip (List.range s.jobs.length)).filter (fun x => p x.1)).map (·.2)

def doneIds (s : St) : List Nat := idsWhere s (·.st == .done)

def canPin (s : St) : Bool := !s.snaps.isEmpty && !anyRunning s && s.leases.isEmpty

/-- Pin the head snapshot and start the jobs waiting on it. -/
def pin1 (s : St) : St :=
  match s.snaps with
  | k :: r =>
    { s with snaps := r, pins := s.pins ++ [(k, doneIds s)],
             jobs := s.jobs.map (fun j => if j.st = .gated k then { j with st := .running } else j),
             starts := s.starts ++ idsWhere s (·.st == .gated k) }
  | [] => s

def settleN : Nat → St → St
  | 0, s => s
  | n + 1, s => if canPin s then settleN n (pin1 s) else s

def settle (s : St) : St := settleN s.snaps.length s

inductive Ev where
  | acquire
  | release (n : Nat)
  | start (k : Kind) (owner : Option Nat) (parent : Par)
  | endStream (j : Nat)
  | tick
  | snapshot
  deriving Repr

variable (bypass : Bool)

def raw (s : St) : Ev → St
  | .acquire => { s with nextOwner := s.nextOwner + 1, leases := s.leases ++ [s.nextOwner] }
  | .release n => { s with leases := s.leases.filter (· != n) }
  | .start k owner parent =>
    if owner.any (· ≥ s.nextOwner) then s
    else
      let go := s.snaps.isEmpty || (bypass && owner.any s.leases.contains)
      let st := if go then JSt.running else .gated (s.snaps.getLast?.getD 0)
      { s with jobs := s.jobs ++ [⟨k, owner, parent, st⟩],
               starts := if go then s.starts ++ [s.jobs.length] else s.starts }
  | .endStream i =>
    match s.jobs[i]? with
    | some j => if j.kind = .stream ∧ j.st = .running then { s with jobs := s.jobs.set i { j with st := .done } } else s
    | none => s
  | .tick => { s with jobs := s.jobs.map fun j => if j.kind ≠ .stream ∧ j.st = .running then { j with st := .done } else j }
  | .snapshot => { s with snaps := s.snaps ++ [s.nextSnap], nextSnap := s.nextSnap + 1 }

def step (s : St) (e : Ev) : St := settle (raw bypass s e)

inductive Reach : St → Prop
  | init : Reach init
  | step {s : St} (e : Ev) : Reach s → Reach (step bypass s e)

/-! ## The environment -/

def childrenDone (s : St) (p : Par) : Bool := s.jobs.all fun j => j.parent != p || j.st == .done

/-- The events the environment can take without breaking who-awaits-whom. -/
def Resp (s : St) : Ev → Prop
  | .endStream i => childrenDone s (.job i) = true
  | .tick => ∀ i j, s.jobs[i]? = some j → j.kind ≠ .stream → j.st = .running → childrenDone s (.job i) = true
  | .release n => childrenDone s (.lease n) = true
  | _ => False

inductive RespPath : St → St → Prop
  | refl (s : St) : RespPath s s
  | cons {s t : St} (e : Ev) : Resp s e → RespPath (step bypass s e) t → RespPath s t

/-- A lease holder's awaited jobs carry its owner; no job awaits another. -/
def WF (s : St) : Prop := ∀ j ∈ s.jobs, (∀ n, j.parent = .lease n → j.owner = some n) ∧ ∀ k, j.parent ≠ .job k

/-! ## Settling -/

theorem pin1_snaps (s : St) (h : s.snaps ≠ []) : (pin1 s).snaps.length + 1 = s.snaps.length := by
  unfold pin1; split
  · simp_all
  · simp_all

theorem settleN_done : ∀ n (s : St), s.snaps.length ≤ n → canPin (settleN n s) = false := by
  intro n
  induction n with
  | zero =>
    intro s h
    simp only [settleN, canPin]
    have : s.snaps = [] := List.eq_nil_of_length_eq_zero (by omega)
    simp [this]
  | succ n ih =>
    intro s h
    simp only [settleN]
    split
    · rename_i hc
      have hne : s.snaps ≠ [] := by
        intro e; simp [canPin, e] at hc
      exact ih _ (by have := pin1_snaps s hne; omega)
    · simpa using ‹¬canPin s = true›

theorem settled (s : St) : canPin (settle s) = false := settleN_done _ s (Nat.le_refl _)

/-- Whatever settling does, it is a run of `pin1`s, each allowed by `canPin`. -/
theorem settleN_cases : ∀ n (s : St), settleN n s = s ∨ (canPin s = true ∧ settleN n s = settleN (n - 1) (pin1 s) ∧ n ≠ 0) := by
  intro n s
  cases n with
  | zero => exact Or.inl rfl
  | succ n =>
    simp only [settleN]
    split
    · exact Or.inr ⟨‹_›, rfl, by omega⟩
    · exact Or.inl rfl

/-! ## Invariants -/

structure Inv (s : St) : Prop where
  gatedPending : ∀ j ∈ s.jobs, ∀ w, j.st = .gated w → w ∈ s.snaps
  ownersIssued : ∀ j ∈ s.jobs, ∀ o, j.owner = some o → o < s.nextOwner
  leasesIssued : ∀ o ∈ s.leases, o < s.nextOwner
  /-- With the bypass, a gated job's owner is not a live lease. -/
  gatedNotLive : bypass = true → ∀ j ∈ s.jobs, ∀ w o, j.st = .gated w → j.owner = some o → o ∉ s.leases

theorem pin1_inv {s : St} (h : Inv bypass s) : Inv bypass (pin1 s) := by
  unfold pin1
  split
  · rename_i k r hs
    refine ⟨?_, ?_, h.leasesIssued, ?_⟩
    · intro j hj w hw
      obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      by_cases e : j0.st = .gated k
      · simp [e] at hw
      · simp only [e, if_false] at hw
        have := h.gatedPending j0 hj0 w hw
        rw [hs] at this
        rcases List.mem_cons.mp this with rfl | h'
        · exact absurd hw e
        · exact h'
    · intro j hj o ho
      obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      split at ho <;> exact h.ownersIssued j0 hj0 o ho
    · intro hb j hj w o hw ho
      obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      by_cases e : j0.st = .gated k
      · simp [e] at hw
      · simp only [e, if_false] at hw ho
        exact h.gatedNotLive hb j0 hj0 w o hw ho
  · exact h

theorem settleN_inv : ∀ n (s : St), Inv bypass s → Inv bypass (settleN n s) := by
  intro n
  induction n with
  | zero => intro s h; exact h
  | succ n ih => intro s h; simp only [settleN]; split; exact ih _ (pin1_inv bypass h); exact h

theorem raw_inv {s : St} (h : Inv bypass s) (e : Ev) : Inv bypass (raw bypass s e) := by
  cases e with
  | acquire =>
    refine ⟨h.gatedPending, fun j hj o ho => by have := h.ownersIssued j hj o ho; show o < s.nextOwner + 1; omega,
      fun o ho => ?_, fun hb j hj w o hw ho => ?_⟩
    · show o < s.nextOwner + 1
      rcases List.mem_append.mp ho with ho | ho
      · have := h.leasesIssued o ho; omega
      · simp at ho; omega
    · have hl := h.ownersIssued j hj o ho
      show o ∉ s.leases ++ [s.nextOwner]
      simp only [List.mem_append, List.mem_singleton, not_or]
      exact ⟨h.gatedNotLive hb j hj w o hw ho, by omega⟩
  | release n =>
    refine ⟨h.gatedPending, h.ownersIssued, fun o ho => h.leasesIssued o (List.mem_filter.mp ho).1,
      fun hb j hj w o hw ho hm => h.gatedNotLive hb j hj w o hw ho (List.mem_filter.mp hm).1⟩
  | start k owner parent =>
    simp only [raw]
    split
    · exact h
    · rename_i hown
      refine ⟨?_, ?_, h.leasesIssued, ?_⟩
      · intro j hj w hw
        rcases List.mem_append.mp hj with hj | hj
        · exact h.gatedPending j hj w hw
        · simp only [List.mem_singleton] at hj; subst hj
          simp only at hw
          split at hw
          · cases hw
          · rename_i hgo
            injection hw with hw; subst hw
            have hne : s.snaps ≠ [] := by intro e; simp [e] at hgo
            cases hl : s.snaps.getLast? with
            | none => simp [List.getLast?_eq_none_iff] at hl; exact absurd hl hne
            | some x => simpa [hl] using List.mem_of_getLast?_eq_some hl
      · intro j hj o ho
        rcases List.mem_append.mp hj with hj | hj
        · exact h.ownersIssued j hj o ho
        · simp only [List.mem_singleton] at hj; subst hj
          simp only at ho; subst ho
          simp at hown; exact hown
      · intro hb j hj w o hw ho
        rcases List.mem_append.mp hj with hj | hj
        · exact h.gatedNotLive hb j hj w o hw ho
        · simp only [List.mem_singleton] at hj; subst hj
          simp only at hw ho; subst ho
          split at hw
          · cases hw
          · rename_i hgo
            intro hm
            simp [hb, hm, List.contains_iff_mem] at hgo
  | endStream i =>
    simp only [raw]
    split
    · rename_i j0 hj0
      have hm0 : j0 ∈ s.jobs := List.mem_of_getElem? hj0
      split
      · refine ⟨fun j hj w hw => ?_, fun j hj o ho => ?_, h.leasesIssued, fun hb j hj w o hw ho => ?_⟩
        · rcases List.mem_or_eq_of_mem_set hj with hj | rfl
          · exact h.gatedPending j hj w hw
          · cases hw
        · rcases List.mem_or_eq_of_mem_set hj with hj | rfl
          · exact h.ownersIssued j hj o ho
          · exact h.ownersIssued j0 hm0 o ho
        · rcases List.mem_or_eq_of_mem_set hj with hj | rfl
          · exact h.gatedNotLive hb j hj w o hw ho
          · cases hw
      · exact h
    · exact h
  | tick =>
    refine ⟨fun j hj w hw => ?_, fun j hj o ho => ?_, h.leasesIssued, fun hb j hj w o hw ho => ?_⟩
    · obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      split at hw
      · cases hw
      · exact h.gatedPending j0 hj0 w hw
    · obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      split at ho <;> exact h.ownersIssued j0 hj0 o ho
    · obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
      split at hw
      · cases hw
      · rename_i hc; simp only [hc, if_false] at ho; exact h.gatedNotLive hb j0 hj0 w o hw ho
  | snapshot =>
    exact ⟨fun j hj w hw => List.mem_append_left _ (h.gatedPending j hj w hw), h.ownersIssued, h.leasesIssued,
      h.gatedNotLive⟩

theorem inv {s : St} (h : Reach bypass s) : Inv bypass s := by
  induction h with
  | init =>
    constructor
    · intro _ h; cases h
    · intro _ h; cases h
    · intro _ h; cases h
    · intro _ _ h; cases h
  | step e _ ih => exact settleN_inv bypass _ _ (raw_inv bypass ih e)

theorem reach_settled {s : St} (h : Reach bypass s) : canPin s = false := by
  cases h with
  | init => rfl
  | step e _ => exact settled _

/-! ## (2) Consistency and (3) liveness -/

/-- A pin happens only with nothing running and no lease held, and records exactly
    the jobs done then. -/
theorem pin_clean (s : St) (hc : canPin s = true) :
    (∀ j ∈ s.jobs, j.st ≠ .running) ∧ s.leases = [] ∧
      ∃ k, (pin1 s).pins = s.pins ++ [(k, doneIds s)] := by
  simp only [canPin, Bool.and_eq_true, Bool.not_eq_true', List.isEmpty_iff] at hc
  obtain ⟨⟨hs, hr⟩, hl⟩ := hc
  refine ⟨fun j hj he => ?_, hl, ?_⟩
  · have : anyRunning s = true := List.any_eq_true.mpr ⟨j, hj, by simp [isRunning, he]⟩
    rw [this] at hr; cases hr
  · unfold pin1
    cases h : s.snaps with
    | nil => simp [h] at hs
    | cons k r => exact ⟨k, by simp⟩

/-- A new job starts at once when no snapshot is pending, or when it carries a live
    lease's owner (with the bypass); otherwise it waits on the snapshot that was
    newest when it arrived. -/
theorem gated_on_newest (s : St) (k : Kind) (o : Option Nat) (p : Par)
    (hn : o.any (· ≥ s.nextOwner) = false) :
    (raw bypass s (.start k o p)).jobs = s.jobs ++
      [⟨k, o, p, if s.snaps.isEmpty || (bypass && o.any s.leases.contains) then .running
        else .gated (s.snaps.getLast?.getD 0)⟩] := by
  simp [raw, hn]

/-- The pin of snapshot `k` starts every job waiting on it, in call order. -/
theorem pin_starts_its_waiters (s : St) (k : Nat) (r : List Nat) (hs : s.snaps = k :: r) :
    (∀ j ∈ (pin1 s).jobs, ∀ w, j.st = .gated w → w ≠ k) ∧
      (pin1 s).starts = s.starts ++ idsWhere s (·.st == .gated k) := by
  unfold pin1
  rw [hs]
  refine ⟨fun j hj w hw hwk => ?_, rfl⟩
  subst hwk
  obtain ⟨j0, _, rfl⟩ := List.mem_map.mp hj
  split at hw
  · cases hw
  · contradiction

theorem gated_on_pending {s : St} (h : Reach bypass s) : ∀ j ∈ s.jobs, ∀ w, j.st = .gated w → w ∈ s.snaps :=
  (inv bypass h).gatedPending

theorem acquire_never_waits (s : St) :
    (raw bypass s .acquire).leases = s.leases ++ [s.nextOwner] := rfl

/-! ## (1) Deadlock freedom -/

def notDone (j : Job) : Bool := j.st != .done

/-- The environment's remaining work: leases held and jobs not done. -/
def work (s : St) : Nat := s.leases.length + s.jobs.countP notDone

theorem settle_cases (t : St) : settle t = t ∨ (settle t).snaps.length < t.snaps.length := by
  unfold settle
  suffices ∀ n (u : St), u.snaps.length ≤ n → settleN n u = u ∨ (settleN n u).snaps.length < u.snaps.length from
    this _ t (Nat.le_refl _)
  intro n
  induction n with
  | zero => intro u _; exact Or.inl rfl
  | succ n ih =>
    intro u hu
    simp only [settleN]
    split
    · rename_i hc
      have hne : u.snaps ≠ [] := by intro e; simp [canPin, e] at hc
      have hp := pin1_snaps u hne
      right
      rcases ih (pin1 u) (by omega) with e | lt
      · rw [e]; omega
      · omega
    · exact Or.inl rfl

theorem settle_id {t : St} (h : canPin t = false) : settle t = t := by
  unfold settle
  cases t.snaps.length with
  | zero => rfl
  | succ n => simp [settleN, h]

theorem countP_map_lt {l : List Job} (f : Job → Job) (hf : ∀ j, notDone j = false → notDone (f j) = false)
    (hex : ∃ j ∈ l, notDone j = true ∧ notDone (f j) = false) : (l.map f).countP notDone < l.countP notDone := by
  induction l with
  | nil => simp at hex
  | cons x xs ih =>
    simp only [List.map_cons, List.countP_cons]
    obtain ⟨j, hj, h1, h2⟩ := hex
    have le : (xs.map f).countP notDone ≤ xs.countP notDone := by
      rw [List.countP_map]
      exact List.countP_mono_left fun y _ hy => by
        cases h : notDone y
        · simp [hf y h] at hy
        · rfl
    rcases List.mem_cons.mp hj with rfl | hj
    · rw [if_neg (by simp [h2]), if_pos h1]; omega
    · have := ih ⟨j, hj, h1, h2⟩
      have hx : notDone (f x) = true → notDone x = true := fun h => by
        cases hx : notDone x
        · rw [hf x hx] at h; cases h
        · rfl
      by_cases a : notDone (f x) = true
      · rw [if_pos a, if_pos (hx a)]; omega
      · rw [if_neg a]; split <;> omega

/-- One environment move from a reachable, well-formed state with a snapshot pending:
    it is allowed, and it pins a snapshot or lowers the remaining work. -/
theorem progress {s : St} (hr : Reach true s) (hw : WF s) (hs : s.snaps ≠ []) :
    ∃ e, Resp s e ∧ ((step true s e).snaps.length < s.snaps.length ∨
      ((step true s e).snaps.length = s.snaps.length ∧ work (step true s e) < work s)) := by
  have hi := inv true hr
  have hcd : ∀ k, childrenDone s (.job k) = true := fun k =>
    List.all_eq_true.mpr fun j hj => by simp [(hw j hj).2 k]
  -- the raw move either pins through settle or keeps its own work count
  have fin : ∀ e, work (raw true s e) < work s → (raw true s e).snaps = s.snaps →
      (step true s e).snaps.length < s.snaps.length ∨
        ((step true s e).snaps.length = s.snaps.length ∧ work (step true s e) < work s) := by
    intro e hlt hsn
    unfold step
    rcases settle_cases (raw true s e) with h | h
    · right; rw [h, hsn]; exact ⟨rfl, hlt⟩
    · left; rw [← hsn]; exact h
  by_cases hst : ∃ (i : Nat) (j : Job), s.jobs[i]? = some j ∧ j.kind = .stream ∧ j.st = .running
  · obtain ⟨i, j, hij, hk, hjr⟩ := hst
    refine ⟨.endStream i, hcd i, fin _ ?_ ?_⟩
    · obtain ⟨hi', rfl⟩ := List.getElem?_eq_some_iff.mp hij
      simp only [raw, hij, hk, hjr, and_self, if_true, work]
      rw [List.countP_set _ _ _ _ hi']
      simp [notDone, hjr]
      have : 0 < s.jobs.countP notDone :=
        List.countP_pos_iff.mpr ⟨_, List.getElem_mem hi', by simp [notDone, hjr]⟩
      omega
    · simp only [raw, hij, hk, hjr, and_self, if_true]
  by_cases hrun : ∃ j ∈ s.jobs, j.st = .running
  · obtain ⟨j, hj, hjr⟩ := hrun
    have hk : j.kind ≠ .stream := by
      intro hk
      obtain ⟨i, hi', rfl⟩ := List.getElem_of_mem hj
      exact hst ⟨i, _, List.getElem?_eq_getElem hi', hk, hjr⟩
    refine ⟨.tick, fun i _ _ _ _ => hcd i, fin _ ?_ rfl⟩
    simp only [raw, work]
    have := countP_map_lt (l := s.jobs)
      (fun j => if j.kind ≠ .stream ∧ j.st = .running then { j with st := .done } else j)
      (fun j h => by
        show notDone (if j.kind ≠ .stream ∧ j.st = .running then { j with st := .done } else j) = false
        split
        · rfl
        · exact h)
      ⟨j, hj, by simp [notDone, hjr], by simp [notDone, hk, hjr]⟩
    omega
  have hnr : anyRunning s = false := by
    cases h : anyRunning s
    · rfl
    · obtain ⟨j, hj, h'⟩ := List.any_eq_true.mp h
      exact absurd ⟨j, hj, by simpa [isRunning] using h'⟩ hrun
  cases hl : s.leases with
  | nil =>
    have := reach_settled true hr
    simp [canPin, hl, hnr, List.isEmpty_iff, hs] at this
  | cons n rest =>
    refine ⟨.release n, ?_, fin _ ?_ rfl⟩
    · refine List.all_eq_true.mpr fun j hj => ?_
      simp only [Bool.or_eq_true, bne_iff_ne, ne_eq, beq_iff_eq]
      by_cases hp : j.parent = .lease n
      · right
        have ho := (hw j hj).1 n hp
        cases hjs : j.st with
        | done => rfl
        | running => exact absurd ⟨j, hj, hjs⟩ hrun
        | gated w => exact absurd (by rw [hl]; exact List.mem_cons_self _ _) (hi.gatedNotLive rfl j hj w n hjs ho)
      · exact Or.inl hp
    · simp only [raw, work, hl]
      have : ((n :: rest).filter (· != n)).length < (n :: rest).length := by
        simp only [List.filter_cons, bne_self_eq_false, Bool.false_eq_true, if_false, List.length_cons]
        have := List.length_filter_le (· != n) rest
        omega
      omega

theorem wf_settle {t : St} (h : WF t) : WF (settle t) := by
  unfold settle
  suffices ∀ n (u : St), WF u → WF (settleN n u) from this _ t h
  intro n
  induction n with
  | zero => intro u h; exact h
  | succ n ih =>
    intro u hu
    simp only [settleN]
    split
    · apply ih
      unfold pin1
      split
      · intro j hj
        obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
        split <;> exact hu j0 hj0
      · exact hu
    · exact hu

theorem wf_resp {s : St} (h : WF s) (e : Ev) (hr : Resp s e) : WF (step true s e) := by
  apply wf_settle
  cases e with
  | endStream i =>
    simp only [raw]
    split
    · rename_i j0 hj0
      split
      · intro j hj
        rcases List.mem_or_eq_of_mem_set hj with hj | rfl
        · exact h j hj
        · exact h j0 (List.mem_of_getElem? hj0)
      · exact h
    · exact h
  | tick =>
    intro j hj
    obtain ⟨j0, hj0, rfl⟩ := List.mem_map.mp hj
    split <;> exact h j0 hj0
  | release n => exact h
  | _ => exact hr.elim

/-- (1) From every reachable well-formed state, the environment's own moves pin every
    pending snapshot; then nothing is gated. -/
theorem drain : ∀ n m (s : St), s.snaps.length = n → work s = m → Reach true s → WF s →
    ∃ t, RespPath true s t ∧ Reach true t ∧ t.snaps = [] ∧ ∀ j ∈ t.jobs, ∀ w, j.st ≠ .gated w := by
  intro n
  induction n using Nat.strongRecOn with
  | ind n ihn =>
  intro m
  induction m using Nat.strongRecOn with
  | ind m ihm =>
  intro s hn hm hr hw
  by_cases hs : s.snaps = []
  · refine ⟨s, .refl s, hr, hs, fun j hj w hg => ?_⟩
    have := gated_on_pending true hr j hj w hg
    rw [hs] at this; cases this
  · obtain ⟨e, hresp, hdec⟩ := progress hr hw hs
    have hr' : Reach true (step true s e) := .step e hr
    have hw' := wf_resp hw e hresp
    rcases hdec with lt | ⟨eq, lt⟩
    · obtain ⟨t, hp, ht⟩ := ihn _ (by omega) _ _ rfl rfl hr' hw'
      exact ⟨t, .cons e hresp hp, ht⟩
    · obtain ⟨t, hp, ht⟩ := ihm _ (by omega) _ (by omega) rfl hr' hw'
      exact ⟨t, .cons e hresp hp, ht⟩

theorem deadlock_free {s : St} (hr : Reach true s) (hw : WF s) :
    ∃ t, RespPath true s t ∧ t.snaps = [] ∧ ∀ j ∈ t.jobs, ∀ w, j.st ≠ .gated w := by
  obtain ⟨t, hp, _, h⟩ := drain _ _ s rfl rfl hr hw
  exact ⟨t, hp, h⟩

/-! ## Deadlocks the rule does not prevent, and the clone -/

/-- A property the environment's moves cannot leave, and under which no snapshot pins. -/
theorem stuck (b : Bool) (P : St → Prop)
    (hP : ∀ s, P s → canPin s = false ∧ ∀ e, Resp s e → P (raw b s e) ∧ canPin (raw b s e) = false)
    {s t : St} (hs : P s) (hp : RespPath b s t) : P t := by
  induction hp with
  | refl => exact hs
  | cons e hr _ ih =>
    obtain ⟨h1, h2⟩ := (hP _ hs).2 e hr
    apply ih
    unfold step; rw [settle_id h2]; exact h1

def run (b : Bool) (es : List Ev) : St := es.foldl (step b) init

/-- The clone (reviewer-0924 cs2/deadlock.mjs): a lease, a snapshot, streams under the
    lease. With the bypass the streams run, the lease is released, the snapshot pins
    with both streams; a stream with no owner started after the gate waits for the pin
    and is not in it. -/
theorem clone_pins :
    let s := run true [.acquire, .snapshot, .start .stream (some 0) (.lease 0), .start .stream (some 0) (.lease 0),
      .start .stream none .none, .endStream 0, .endStream 1, .release 0]
    s.pins = [(0, [0, 1])] ∧ s.starts = [0, 1, 2] ∧ s.snaps = [] := by
  decide

def cloneP (t : St) : Prop := t.jobs = [⟨.stream, some 0, .lease 0, .gated 0⟩] ∧ t.leases = [0] ∧ t.snaps = [0]

/-- Without the bypass the clone never pins: the stream waits for the snapshot, the
    lease holder for the stream, the snapshot for the lease. -/
theorem clone_deadlocks_without_bypass :
    let s := run false [.acquire, .snapshot, .start .stream (some 0) (.lease 0)]
    ∀ t, RespPath false s t → t.snaps = [0] := by
  intro s t hp
  have h0 : cloneP s := by unfold cloneP; decide
  refine (stuck false cloneP ?_ h0 hp).2.2
  intro u ⟨hj, hl, hs⟩
  refine ⟨by simp [canPin, hl], fun e hr => ?_⟩
  cases e with
  | endStream i =>
    have : raw false u (.endStream i) = u := by
      simp only [raw, hj]
      cases i with
      | zero => simp
      | succ i => simp
    rw [this]; exact ⟨⟨hj, hl, hs⟩, by simp [canPin, hl]⟩
  | tick =>
    refine ⟨⟨by simp [raw, hj], hl, hs⟩, by simp [canPin, raw, hl]⟩
  | release n =>
    by_cases hn : n = 0
    · subst hn; simp [Resp, childrenDone, hj] at hr
    · have hn' : (0 != n) = true := by simpa [bne_iff_ne] using Ne.symm hn
      refine ⟨⟨hj, by simp [raw, hl, hn'], hs⟩, by simp [canPin, raw, hl, hn']⟩
  | _ => exact hr.elim

def copyP (t : St) : Prop := t.jobs = [⟨.copy, none, .lease 0, .gated 0⟩] ∧ t.leases = [0] ∧ t.snaps = [0]

/-- A lease holder awaiting a copyTree (which carries no owner) deadlocks under the
    rule: `WF` is needed. -/
theorem lease_awaiting_copy_deadlocks :
    let s := run true [.acquire, .snapshot, .start .copy none (.lease 0)]
    ∀ t, RespPath true s t → t.snaps = [0] := by
  intro s t hp
  have h0 : copyP s := by unfold copyP; decide
  refine (stuck true copyP ?_ h0 hp).2.2
  intro u ⟨hj, hl, hs⟩
  refine ⟨by simp [canPin, hl], fun e hr => ?_⟩
  cases e with
  | endStream i =>
    have : raw true u (.endStream i) = u := by
      simp only [raw, hj]
      cases i with
      | zero => simp
      | succ i => simp
    rw [this]; exact ⟨⟨hj, hl, hs⟩, by simp [canPin, hl]⟩
  | tick =>
    refine ⟨⟨by simp [raw, hj], hl, hs⟩, by simp [canPin, raw, hl]⟩
  | release n =>
    by_cases hn : n = 0
    · subst hn; simp [Resp, childrenDone, hj] at hr
    · have hn' : (0 != n) = true := by simpa [bne_iff_ne] using Ne.symm hn
      refine ⟨⟨hj, by simp [raw, hl, hn'], hs⟩, by simp [canPin, raw, hl, hn']⟩
  | _ => exact hr.elim

def nestP (t : St) : Prop :=
  t.jobs = [⟨.restore, none, .none, .running⟩, ⟨.stream, none, .job 0, .gated 0⟩] ∧ t.leases = [] ∧ t.snaps = [0]

/-- A spanning job awaiting a stream it starts after a snapshot was requested
    deadlocks under the rule: the snapshot waits for the job, the stream for the
    snapshot. `WF` is needed (the engine's restoreAsync and copyTree start none). -/
theorem job_awaiting_stream_deadlocks :
    let s := run true [.start .restore none .none, .snapshot, .start .stream none (.job 0)]
    ∀ t, RespPath true s t → t.snaps = [0] := by
  intro s t hp
  have h0 : nestP s := by unfold nestP; decide
  refine (stuck true nestP ?_ h0 hp).2.2
  intro u ⟨hj, hl, hs⟩
  have hc : ∀ v : St, v.jobs = u.jobs → canPin v = false := fun v hv => by
    simp [canPin, anyRunning, hv, hj, isRunning]
  refine ⟨hc u rfl, fun e hr => ?_⟩
  cases e with
  | endStream i =>
    have : raw true u (.endStream i) = u := by
      simp only [raw, hj]
      rcases i with _ | _ | i <;> simp
    rw [this]; exact ⟨⟨hj, hl, hs⟩, hc u rfl⟩
  | tick =>
    have := hr 0 ⟨.restore, none, .none, .running⟩ (by simp [hj]) (by decide) rfl
    simp [childrenDone, hj] at this
  | release n =>
    exact ⟨⟨hj, by simp [raw, hl], hs⟩, hc _ rfl⟩
  | _ => exact hr.elim

/-- A lease taken after the gate never waits; the snapshot waits it out, a stream
    under it runs, work with no owner waits for the pin; the next snapshot has it. -/
theorem lease_after_gate :
    let s := run true [.start .stream none .none, .snapshot, .acquire, .start .stream (some 0) (.lease 0),
      .start .copy none .none, .endStream 0, .endStream 1, .release 0, .tick, .snapshot]
    s.pins = [(0, [0, 1]), (1, [0, 1, 2])] ∧ s.starts = [0, 1, 2] ∧ s.snaps = [] := by
  decide

end Nimbus.ContentStore.Quiesce
