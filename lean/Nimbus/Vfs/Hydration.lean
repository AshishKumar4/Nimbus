/-
  Nimbus.Vfs.Hydration — N17 lazy hydration in an import window (CUTOVER.md v3.1
  §3; content-store SPEC §7).

  An import window leaves some paths' chunks in state 1 (remote). A background job
  hydrates them in queue order, one path per `job` event (the embedder's `hydrate`
  resolving; a hydrate that never resolves is a schedule with no more `job`s).
  - An async read of a state-1 path moves it to the front of the job and waits; a
    `resume` hands every waiting reader whose path is now local its bytes.
  - A sync read of a state-1 path answers EIO naming it and moves it to the front.
  - `bind` (a WASI launch) names paths (program, argv, cwd inside an import target):
    the state-1 ones move to the front, and the launch's gate waits until all named
    paths are local, or the deadline (`D` ticks after bind) passes, when it fails
    with EIO naming the first unhydrated one. Gates are settled after every event.

  Proved, over every reachable state and every schedule:
  - `sync_never_state1` / `async_never_state1` / `resume_local`: no reader is
    handed the bytes of a path that is not local at that moment.
  - `hyd_mono`: a hydrated path stays hydrated through the window.
  - `gate_ok_local` / `bound_reads_never_eio`: after a launch's gate opens, every
    named path is local, and a sync read of one never answers EIO.
  - `gate_bounded`: an open gate is always strictly before its deadline, which is
    `D` ticks after bind — the gate waits at most `D` ticks, whatever the job does.
  - `nothing_named_starts`: a launch naming no state-1 path opens at bind.
  - `named_first` / `named_hydrate_within`: bind puts its state-1 named paths at
    the front of the job, so (with no other reprioritization in between) they are
    all local after as many `job` events as there are of them.
-/

namespace Nimbus.Vfs.Hydration

inductive GRes where
  | ok
  | eio (p : Nat)
  deriving DecidableEq, Repr

structure Gate where
  named : List Nat
  opened : Nat
  result : Option GRes
  deriving DecidableEq, Repr

structure H where
  D : Nat
  now : Nat
  imported : List Nat
  hyd : List Nat
  queue : List Nat
  waiting : List Nat
  gates : List Gate

/-- A path's bytes are readable: it was never in the window, or it is hydrated. -/
def isLocal (s : H) (p : Nat) : Bool := !s.imported.contains p || s.hyd.contains p

/-- Move `ps`'s queued paths to the front, in `ps`'s order. -/
def prio (q ps : List Nat) : List Nat :=
  let front := ps.filter q.contains
  front ++ q.filter (fun x => !front.contains x)

def settleG (s : H) (g : Gate) : Gate :=
  match g.result with
  | some _ => g
  | none =>
    if g.named.all (isLocal s) then { g with result := some .ok }
    else if g.opened + s.D ≤ s.now then { g with result := some (.eio ((g.named.find? (!isLocal s ·)).getD 0)) }
    else g

def settle (s : H) : H := { s with gates := s.gates.map (settleG s) }

inductive Ev where
  | tick
  | job
  | asyncRead (p : Nat)
  | resume
  | syncRead (p : Nat)
  | bind (named : List Nat)
  deriving Repr

inductive Out where
  | ok
  | bytes (p : Nat)
  | wait
  | eio (p : Nat)
  | resumed (ps : List Nat)
  deriving DecidableEq, Repr

def raw (s : H) : Ev → Out × H
  | .tick => (.ok, { s with now := s.now + 1 })
  | .job =>
    match s.queue with
    | x :: r => (.ok, { s with hyd := s.hyd ++ [x], queue := r })
    | [] => (.ok, s)
  | .asyncRead p =>
    if isLocal s p then (.bytes p, s) else (.wait, { s with waiting := s.waiting ++ [p], queue := prio s.queue [p] })
  | .resume =>
    (.resumed (s.waiting.filter (isLocal s)), { s with waiting := s.waiting.filter (!isLocal s ·) })
  | .syncRead p => if isLocal s p then (.bytes p, s) else (.eio p, { s with queue := prio s.queue [p] })
  | .bind named => (.ok, { s with queue := prio s.queue named, gates := s.gates ++ [⟨named, s.now, none⟩] })

def step (s : H) (e : Ev) : Out × H := let r := raw s e; (r.1, settle r.2)

inductive Reach : H → Prop
  | init (D : Nat) (imp : List Nat) : Reach ⟨D, 0, imp, [], imp, [], []⟩
  | step {s : H} (e : Ev) : Reach s → Reach (step s e).2

/-! ## Readers -/

theorem sync_never_state1 (s : H) (p q : Nat) (h : (step s (.syncRead p)).1 = .bytes q) : q = p ∧ isLocal s p = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, hl⟩
  · cases h

theorem async_never_state1 (s : H) (p q : Nat) (h : (step s (.asyncRead p)).1 = .bytes q) : q = p ∧ isLocal s p = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, hl⟩
  · cases h

theorem resume_local (s : H) (ps : List Nat) (h : (step s .resume).1 = .resumed ps) : ∀ p ∈ ps, isLocal s p = true := by
  simp only [step, raw, Out.resumed.injEq] at h
  subst h
  intro p hp; exact (List.mem_filter.mp hp).2

/-! ## Monotonicity -/

theorem raw_frame (s : H) (e : Ev) : (raw s e).2.imported = s.imported ∧ (raw s e).2.D = s.D ∧
    (∀ p ∈ s.hyd, p ∈ (raw s e).2.hyd) ∧ s.now ≤ (raw s e).2.now := by
  cases e <;> simp only [raw] <;> (repeat' split) <;> simp_all

theorem isLocal_mono {s s' : H} (hi : s'.imported = s.imported) (hh : ∀ p ∈ s.hyd, p ∈ s'.hyd) (p : Nat)
    (h : isLocal s p = true) : isLocal s' p = true := by
  simp only [isLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem] at h ⊢
  rw [hi]
  rcases h with h | h
  · left; simpa using h
  · exact Or.inr (hh p h)

theorem hyd_mono (s : H) (e : Ev) : ∀ p, isLocal s p = true → isLocal (step s e).2 p = true := by
  obtain ⟨hi, _, hh, _⟩ := raw_frame s e
  intro p h
  exact isLocal_mono (s' := (step s e).2) (by simpa [step, settle] using hi) (by simpa [step, settle] using hh) p h

/-! ## Gates -/

/-- The gate invariant: an opened gate names only local paths; an open one is
    before its deadline. -/
def GateInv (s : H) : Prop :=
  ∀ g ∈ s.gates, (g.result = some .ok → ∀ p ∈ g.named, isLocal s p = true) ∧
    (g.result = none → s.now < g.opened + s.D)

theorem settleG_open (s : H) (g : Gate) (h : (settleG s g).result = none) : s.now < g.opened + s.D := by
  unfold settleG at h
  split at h
  · simp_all
  · split at h
    · simp at h
    · split at h
      · simp at h
      · omega

theorem settleG_ok (s : H) (g : Gate) (hg : g.result = some .ok → ∀ p ∈ g.named, isLocal s p = true)
    (h : (settleG s g).result = some .ok) : ∀ p ∈ g.named, isLocal s p = true := by
  unfold settleG at h
  split at h
  · exact hg h
  · split at h
    · rename_i ha; intro p hp; exact List.all_eq_true.mp ha p hp
    · split at h <;> simp_all

theorem settleG_named (s : H) (g : Gate) : (settleG s g).named = g.named ∧ (settleG s g).opened = g.opened := by
  unfold settleG
  split
  · exact ⟨rfl, rfl⟩
  · split
    · exact ⟨rfl, rfl⟩
    · split <;> exact ⟨rfl, rfl⟩

theorem raw_gates (s : H) (e : Ev) : ∀ g ∈ (raw s e).2.gates, g ∈ s.gates ∨ g.result = none := by
  intro g hg
  cases e with
  | bind named =>
    simp only [raw, List.mem_append, List.mem_singleton] at hg
    rcases hg with hg | rfl
    · exact Or.inl hg
    · exact Or.inr rfl
  | job => simp only [raw] at hg; split at hg <;> exact Or.inl hg
  | asyncRead p => simp only [raw] at hg; split at hg <;> exact Or.inl hg
  | syncRead p => simp only [raw] at hg; split at hg <;> exact Or.inl hg
  | tick => exact Or.inl hg
  | resume => exact Or.inl hg

theorem step_gateInv (s : H) (hs : GateInv s) (e : Ev) : GateInv (step s e).2 := by
  obtain ⟨hi, hD, hh, _⟩ := raw_frame s e
  have mono := isLocal_mono hi hh
  have old : ∀ g ∈ (raw s e).2.gates, g.result = some .ok → ∀ p ∈ g.named, isLocal (raw s e).2 p = true := by
    intro g hg hr p hp
    rcases raw_gates s e g hg with hg | hn
    · exact mono p ((hs g hg).1 hr p hp)
    · rw [hn] at hr; cases hr
  intro g' hg'
  simp only [step, settle, List.mem_map] at hg'
  obtain ⟨g, hg, rfl⟩ := hg'
  obtain ⟨hn, ho⟩ := settleG_named (raw s e).2 g
  refine ⟨fun h => ?_, fun h => ?_⟩
  · rw [hn]; intro p hp
    exact settleG_ok (raw s e).2 g (old g hg) h p hp
  · rw [ho]; exact settleG_open (raw s e).2 g h

theorem gateInv {s : H} (h : Reach s) : GateInv s := by
  induction h with
  | init => intro g hg; simp at hg
  | step e _ ih => exact step_gateInv _ ih e

theorem gate_ok_local {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hok : g.result = some .ok) :
    ∀ p ∈ g.named, isLocal s p = true := (gateInv h g hg).1 hok

/-- Once a launch's gate opened, no sync read of a named path answers EIO. -/
theorem bound_reads_never_eio {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hok : g.result = some .ok)
    (p : Nat) (hp : p ∈ g.named) (q : Nat) : (step s (.syncRead p)).1 ≠ .eio q := by
  simp only [step, raw, gate_ok_local h g hg hok p hp, if_true]
  simp

/-- An open gate is before its deadline, `D` ticks after bind. -/
theorem gate_bounded {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hopen : g.result = none) :
    s.now < g.opened + s.D := (gateInv h g hg).2 hopen

/-- A launch naming no state-1 path opens at bind. -/
theorem nothing_named_starts (s : H) (named : List Nat) (hl : ∀ p ∈ named, isLocal s p = true) :
    ⟨named, s.now, some .ok⟩ ∈ (step s (.bind named)).2.gates := by
  simp only [step, raw, settle, List.map_append, List.map_cons, List.map_nil, List.mem_append, List.mem_singleton]
  right
  unfold settleG
  have : named.all (isLocal { s with queue := prio s.queue named, gates := s.gates ++ [⟨named, s.now, none⟩] }) = true :=
    List.all_eq_true.mpr fun p hp => by simpa [isLocal] using hl p hp
  simp [this]

/-! ## Priority -/

theorem named_first (q named : List Nat) :
    ∃ front rest, prio q named = front ++ rest ∧ (∀ p ∈ named, p ∈ q → p ∈ front) ∧ front.length ≤ named.length := by
  refine ⟨named.filter q.contains, _, rfl, fun p hp hq => ?_, ?_⟩
  · exact List.mem_filter.mpr ⟨hp, List.contains_iff_mem.mpr hq⟩
  · exact List.length_filter_le _ _

def jobs : Nat → H → H
  | 0, s => s
  | n + 1, s => jobs n (step s .job).2

theorem jobs_hydrate : ∀ (u : List Nat) (s : H) (r : List Nat), s.queue = u ++ r →
    ∀ p ∈ u, p ∈ (jobs u.length s).hyd := by
  intro u
  induction u with
  | nil => intro _ _ _ p hp; cases hp
  | cons x u ih =>
    intro s r hq p hp
    simp only [List.length_cons, jobs]
    have hq' : (step s .job).2.queue = u ++ r := by simp [step, raw, settle, hq]
    rcases List.mem_cons.mp hp with rfl | hp
    · -- x is hydrated now and stays
      have hx : p ∈ (step s .job).2.hyd := by simp [step, raw, settle, hq]
      suffices ∀ n (t : H), p ∈ t.hyd → p ∈ (jobs n t).hyd from this _ _ hx
      intro n
      induction n with
      | zero => intro t h; exact h
      | succ n ihn => intro t h; exact ihn _ ((raw_frame t .job).2.2.1 p h)
    · exact ih _ r hq' p hp

/-- After bind, with only `job` events, the launch's state-1 named paths are all
    local after at most as many `job`s as it named. -/
theorem named_hydrate_within (s : H) (named : List Nat) :
    let s1 := (step s (.bind named)).2
    ∃ k ≤ named.length, ∀ p ∈ named, p ∈ s.queue → p ∈ (jobs k s1).hyd := by
  obtain ⟨front, rest, he, hf, hl⟩ := named_first s.queue named
  refine ⟨front.length, hl, fun p hp hq => ?_⟩
  exact jobs_hydrate front _ rest (by simp [step, raw, settle, he]) p (hf p hp hq)

/-! ## Traces -/

/-- Paths 1, 2 imported, deadline 3 ticks. A launch naming 2 waits and opens when
    2 hydrates, although 1 is still remote; a sync read of 1 is EIO; a launch naming
    nothing imported (7) opens at once; a launch naming 1 with no job fails at the
    deadline naming 1. -/
theorem a_window :
    let s0 : H := ⟨3, 0, [1, 2], [], [1, 2], [], []⟩
    let s1 := (step s0 (.bind [2])).2
    let s2 := (step s1 .job).2
    let s3 := (step s2 (.bind [7])).2
    let s4 := (step s3 (.bind [1])).2
    let s5 := (step (step (step s4 .tick).2 .tick).2 .tick).2
    s1.queue = [2, 1] ∧ (s2.gates.map (·.result)) = [some .ok] ∧ (step s2 (.syncRead 1)).1 = .eio 1 ∧
      (s3.gates.map (·.result)) = [some .ok, some .ok] ∧ (s4.gates.map (·.result)) = [some .ok, some .ok, none] ∧
      (s5.gates.map (·.result)) = [some .ok, some .ok, some (.eio 1)] := by
  decide

end Nimbus.Vfs.Hydration
