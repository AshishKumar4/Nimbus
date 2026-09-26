/-
  Nimbus.Vfs.Hydration — N17 lazy hydration in an import window (CUTOVER.md v3.1
  §3; content-store SPEC §7), at chunk granularity.

  A path's bytes are a list of chunk hashes; chunks are content-addressed, so one
  hash may back several paths (and snapshots). An import window leaves some hashes
  in state 1 (remote). A path is local when every one of its chunks is. A background
  job hydrates hashes in queue order, one hash per `job` event (the embedder's
  `hydrate(hashes)` resolving; a hydrate that never resolves is a schedule with no
  more `job`s), and hydrating one hash can make several paths local.
  - An async read of a path with a remote chunk moves those chunks (its
    `NeedsHydration(hashes)`) to the front of the job and waits; `resume` hands every
    waiting reader whose path is now local its bytes.
  - A sync read of such a path answers EIO naming it and moves its remote chunks to
    the front.
  - `bind` (a WASI launch) names paths: their remote chunks move to the front, in
    named order, and the launch's gate waits until every named path is local or the
    deadline (`D` ticks after bind) passes, when it fails with EIO naming the first
    named path that is not local. Gates are settled after every event.

  Proved, over every reachable state and every schedule:
  - `sync_never_state1` / `async_never_state1` / `resume_local`: no reader is handed
    the bytes of a path any of whose chunks is remote at that moment.
  - `hyd_mono` / `isLocal_mono`: a hydrated chunk stays hydrated, so a local path
    stays local.
  - `queue_covers`: every remote, unhydrated chunk is in the job's queue.
  - `gate_ok_local` / `bound_reads_never_eio`: after a launch's gate opens, every
    named path is local and a sync read of one never answers EIO.
  - `gate_bounded`: an open gate is strictly before its deadline, `D` ticks after
    bind: it waits at most `D` ticks whatever hydrate does.
  - `nothing_named_starts`: a launch naming nothing remote opens at bind.
  - `named_local_within`: with only `job` events after bind, every named path is
    local after at most as many hydrations as the named paths have remote chunks.
  - `a_shared_chunk`: one hydration makes two paths sharing a chunk local together.
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
  /-- Each path's chunk hashes. -/
  files : List (Nat × List Nat)
  /-- The hashes the import window left in state 1. -/
  remote : List Nat
  hyd : List Nat
  queue : List Nat
  waiting : List Nat
  gates : List Gate

def chunksOf (s : H) (p : Nat) : List Nat := ((s.files.find? (·.1 == p)).map (·.2)).getD []

def hLocal (s : H) (h : Nat) : Bool := !s.remote.contains h || s.hyd.contains h

def isLocal (s : H) (p : Nat) : Bool := (chunksOf s p).all (hLocal s)

/-- The remote chunks of `ps`, in order: what `NeedsHydration` names. -/
def need (s : H) (ps : List Nat) : List Nat := (ps.flatMap (chunksOf s)).filter (!hLocal s ·)

/-- Move `hs`'s queued hashes to the front, in `hs`'s order. -/
def prio (q hs : List Nat) : List Nat :=
  let front := hs.filter q.contains
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
    if isLocal s p then (.bytes p, s)
    else (.wait, { s with waiting := s.waiting ++ [p], queue := prio s.queue (need s [p]) })
  | .resume =>
    (.resumed (s.waiting.filter (isLocal s)), { s with waiting := s.waiting.filter (!isLocal s ·) })
  | .syncRead p => if isLocal s p then (.bytes p, s) else (.eio p, { s with queue := prio s.queue (need s [p]) })
  | .bind named =>
    (.ok, { s with queue := prio s.queue (need s named), gates := s.gates ++ [⟨named, s.now, none⟩] })

def step (s : H) (e : Ev) : Out × H := let r := raw s e; (r.1, settle r.2)

def start (D : Nat) (files : List (Nat × List Nat)) (remote : List Nat) : H := ⟨D, 0, files, remote, [], remote, [], []⟩

inductive Reach : H → Prop
  | init (D : Nat) (files : List (Nat × List Nat)) (remote : List Nat) : Reach (start D files remote)
  | step {s : H} (e : Ev) : Reach s → Reach (step s e).2

/-! ## Readers -/

theorem sync_never_state1 (s : H) (p q : Nat) (h : (step s (.syncRead p)).1 = .bytes q) :
    q = p ∧ ∀ c ∈ chunksOf s p, hLocal s c = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, List.all_eq_true.mp hl⟩
  · cases h

theorem async_never_state1 (s : H) (p q : Nat) (h : (step s (.asyncRead p)).1 = .bytes q) :
    q = p ∧ ∀ c ∈ chunksOf s p, hLocal s c = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, List.all_eq_true.mp hl⟩
  · cases h

theorem resume_local (s : H) (ps : List Nat) (h : (step s .resume).1 = .resumed ps) :
    ∀ p ∈ ps, ∀ c ∈ chunksOf s p, hLocal s c = true := by
  simp only [step, raw, Out.resumed.injEq] at h
  subst h
  intro p hp; exact List.all_eq_true.mp (List.mem_filter.mp hp).2

/-! ## Monotonicity -/

theorem raw_frame (s : H) (e : Ev) : (raw s e).2.files = s.files ∧ (raw s e).2.remote = s.remote ∧
    (raw s e).2.D = s.D ∧ (∀ c ∈ s.hyd, c ∈ (raw s e).2.hyd) ∧ s.now ≤ (raw s e).2.now := by
  cases e <;> simp only [raw] <;> (repeat' split) <;> simp_all

theorem hLocal_mono {s s' : H} (hr : s'.remote = s.remote) (hh : ∀ c ∈ s.hyd, c ∈ s'.hyd) (c : Nat)
    (h : hLocal s c = true) : hLocal s' c = true := by
  simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem] at h ⊢
  rw [hr]
  rcases h with h | h
  · left; simpa using h
  · exact Or.inr (hh c h)

theorem isLocal_mono {s s' : H} (hf : s'.files = s.files) (hr : s'.remote = s.remote) (hh : ∀ c ∈ s.hyd, c ∈ s'.hyd)
    (p : Nat) (h : isLocal s p = true) : isLocal s' p = true := by
  unfold isLocal chunksOf at h ⊢
  rw [hf]
  exact List.all_eq_true.mpr fun c hc => hLocal_mono hr hh c (List.all_eq_true.mp h c hc)

theorem hyd_mono (s : H) (e : Ev) : ∀ p, isLocal s p = true → isLocal (step s e).2 p = true := by
  obtain ⟨hf, hr, _, hh, _⟩ := raw_frame s e
  exact isLocal_mono (s' := (step s e).2) hf hr hh

/-! ## The queue holds every remote chunk -/

def Covers (s : H) : Prop := ∀ c, c ∈ s.remote → c ∉ s.hyd → c ∈ s.queue

theorem prio_mem {q hs : List Nat} {c : Nat} (h : c ∈ q) : c ∈ prio q hs := by
  unfold prio
  by_cases e : (hs.filter q.contains).contains c = true
  · exact List.mem_append_left _ (List.contains_iff_mem.mp e)
  · have hn : c ∉ hs.filter q.contains := fun h' => e (List.contains_iff_mem.mpr h')
    refine List.mem_append_right _ (List.mem_filter.mpr ⟨h, ?_⟩)
    have : (hs.filter q.contains).contains c = false := by
      cases h' : (hs.filter q.contains).contains c
      · rfl
      · exact absurd h' e
    show (!(hs.filter q.contains).contains c) = true
    rw [this]; rfl

theorem step_covers (s : H) (hs : Covers s) (e : Ev) : Covers (step s e).2 := by
  intro c hc hn
  show c ∈ (raw s e).2.queue
  have hc' : c ∈ s.remote := by rw [← (raw_frame s e).2.1]; exact hc
  have hn' : c ∉ s.hyd := fun h => hn ((raw_frame s e).2.2.2.1 c h)
  have hq := hs c hc' hn'
  cases e with
  | job =>
    have hn2 : c ∉ (raw s .job).2.hyd := hn
    revert hn2
    simp only [raw]
    split
    · rename_i x r he
      intro hn2
      rw [he] at hq
      simp only [List.mem_append, List.mem_singleton, not_or] at hn2
      rcases List.mem_cons.mp hq with rfl | h
      · exact absurd rfl hn2.2
      · exact h
    · rename_i he; intro _; rw [he] at hq; cases hq
  | asyncRead p => simp only [raw]; split; exact hq; exact prio_mem hq
  | syncRead p => simp only [raw]; split; exact hq; exact prio_mem hq
  | bind named => exact prio_mem hq
  | tick => exact hq
  | resume => exact hq

theorem queue_covers {s : H} (h : Reach s) : Covers s := by
  induction h with
  | init D files remote => intro c hc _; exact hc
  | step e _ ih => exact step_covers _ ih e

/-! ## Gates -/

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
  obtain ⟨hf, hr, _, hh, _⟩ := raw_frame s e
  have mono := isLocal_mono hf hr hh
  have old : ∀ g ∈ (raw s e).2.gates, g.result = some .ok → ∀ p ∈ g.named, isLocal (raw s e).2 p = true := by
    intro g hg hok p hp
    rcases raw_gates s e g hg with hg | hn
    · exact mono p ((hs g hg).1 hok p hp)
    · rw [hn] at hok; cases hok
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
  | init => intro g hg; simp [start] at hg
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

/-- A launch naming nothing remote opens at bind. -/
theorem nothing_named_starts (s : H) (named : List Nat) (hl : ∀ p ∈ named, isLocal s p = true) :
    ⟨named, s.now, some .ok⟩ ∈ (step s (.bind named)).2.gates := by
  simp only [step, raw, settle, List.map_append, List.map_cons, List.map_nil, List.mem_append, List.mem_singleton]
  right
  unfold settleG
  have : named.all (isLocal { s with queue := prio s.queue (need s named), gates := s.gates ++ [⟨named, s.now, none⟩] }) = true :=
    List.all_eq_true.mpr fun p hp => by simpa [isLocal, chunksOf, hLocal] using hl p hp
  simp [this]

/-! ## Priority -/

def jobs : Nat → H → H
  | 0, s => s
  | n + 1, s => jobs n (step s .job).2

theorem jobs_mono : ∀ n (t : H) c, c ∈ t.hyd → c ∈ (jobs n t).hyd := by
  intro n
  induction n with
  | zero => intro t c h; exact h
  | succ n ih => intro t c h; exact ih _ c ((raw_frame t .job).2.2.2.1 c h)

theorem jobs_frame : ∀ n (t : H), (jobs n t).files = t.files ∧ (jobs n t).remote = t.remote := by
  intro n
  induction n with
  | zero => intro t; exact ⟨rfl, rfl⟩
  | succ n ih =>
    intro t
    obtain ⟨h1, h2⟩ := ih (step t .job).2
    exact ⟨h1.trans (raw_frame t .job).1, h2.trans (raw_frame t .job).2.1⟩

theorem jobs_hydrate : ∀ (u : List Nat) (s : H) (r : List Nat), s.queue = u ++ r →
    ∀ c ∈ u, c ∈ (jobs u.length s).hyd := by
  intro u
  induction u with
  | nil => intro _ _ _ c hc; cases hc
  | cons x u ih =>
    intro s r hq c hc
    simp only [List.length_cons, jobs]
    have hq' : (step s .job).2.queue = u ++ r := by simp [step, raw, settle, hq]
    rcases List.mem_cons.mp hc with rfl | hc
    · exact jobs_mono _ _ _ (by simp [step, raw, settle, hq])
    · exact ih _ r hq' c hc

/-- With only `job` events after bind, every named path is local after at most as
    many hydrations as the named paths had remote chunks. -/
theorem named_local_within {s : H} (hr : Reach s) (named : List Nat) :
    let s1 := (step s (.bind named)).2
    ∃ k ≤ (need s named).length, ∀ p ∈ named, isLocal (jobs k s1) p = true := by
  intro s1
  have hcov := queue_covers hr
  let front := (need s named).filter s.queue.contains
  have hq1 : s1.queue = front ++ s.queue.filter (fun x => !front.contains x) := rfl
  refine ⟨front.length, List.length_filter_le _ _, fun p hp => ?_⟩
  obtain ⟨hf, hrm⟩ := jobs_frame front.length s1
  unfold isLocal chunksOf
  rw [hf]
  refine List.all_eq_true.mpr fun c hc => ?_
  have hc' : c ∈ chunksOf s p := hc
  by_cases hl : hLocal s c = true
  · exact hLocal_mono (hrm.trans (raw_frame s (.bind named)).2.1)
      (fun d hd => jobs_mono _ _ d ((raw_frame s (.bind named)).2.2.2.1 d hd)) c hl
  · have hn : c ∈ need s named :=
      List.mem_filter.mpr ⟨List.mem_flatMap.mpr ⟨p, hp, hc'⟩, by simpa using hl⟩
    simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem, not_or] at hl
    have hin : c ∈ s.queue := hcov c (by simpa using hl.1) hl.2
    have hfr : c ∈ front := List.mem_filter.mpr ⟨hn, List.contains_iff_mem.mpr hin⟩
    have := jobs_hydrate front s1 _ hq1 c hfr
    simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem]
    exact Or.inr this

/-! ## Traces -/

/-- Paths 1 and 2 share chunk 5; path 3 is chunk 6; path 7 has only local chunk 9.
    Deadline 3. A launch naming 1 moves 5 to the front; one hydration makes both 1
    and 2 local; a sync read of 3 is EIO; a launch naming 7 opens at once; a launch
    naming 3 with no job fails at the deadline naming 3. -/
theorem a_shared_chunk :
    let s0 := start 3 [(1, [5]), (2, [5]), (3, [6]), (7, [9])] [6, 5]
    let s1 := (step s0 (.bind [1])).2
    let s2 := (step s1 .job).2
    let s3 := (step s2 (.bind [7])).2
    let s4 := (step s3 (.bind [3])).2
    let s5 := (step (step (step s4 .tick).2 .tick).2 .tick).2
    s1.queue = [5, 6] ∧ isLocal s2 1 = true ∧ isLocal s2 2 = true ∧ (s2.gates.map (·.result)) = [some .ok] ∧
      (step s2 (.syncRead 3)).1 = .eio 3 ∧ (s3.gates.map (·.result)) = [some .ok, some .ok] ∧
      (s4.gates.map (·.result)) = [some .ok, some .ok, none] ∧
      (s5.gates.map (·.result)) = [some .ok, some .ok, some (.eio 3)] := by
  decide

end Nimbus.Vfs.Hydration
