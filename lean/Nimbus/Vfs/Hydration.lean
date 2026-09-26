/-
  Nimbus.Vfs.Hydration — N17 lazy hydration in an import window (CUTOVER.md v3.1
  §3; content-store SPEC §7), at chunk granularity, with fetch failure (review P1 of
  3d3e0bb8) and deadlines on async readers.

  A path's bytes are a list of chunk hashes; chunks are content-addressed, so one hash
  may back several paths. An import window leaves some hashes in state 1 (remote). A path
  is local when every one of its chunks is. A background job fetches hashes in queue
  order, one per `job` event: the first queued hash that is ready (its `notBefore` has
  passed). The fetch succeeds (the hash is stored) or fails (rejected, wrong bytes, or
  left out of the batch: all alike here). A failed hash goes to the queue's back with
  `notBefore = now + min(maxBackoff, backoff · 2^(k-1))` after its `k`-th failure; at
  `maxA` failures it is failed for good: out of the queue, into `failed`. `retry`
  (retryFailed) re-queues every failed hash.
  - An async read of a path that is not local, with no failed chunk, waits (a reader
    record with a deadline `RD` ticks on) and moves its remote chunks to the front.
  - A sync read of such a path answers EIO naming it and moves its chunks to the front.
  - `bind` (a WASI launch) names paths: their remote chunks move to the front, and its
    gate waits until they are all local or its deadline (`D` ticks after bind) passes.
  - A read, a waiting reader or a gate touching a path with a failed chunk answers EIO
    naming the path and the chunk, at once.
  Readers and gates are settled after every event.

  Proved, over every reachable state and every schedule of events and fetch outcomes:
  - `sync_never_state1` / `async_never_state1` / `reader_ok_local`: no reader is handed
    the bytes of a path with a chunk that is not local.
  - `hyd_mono`: a stored chunk stays stored; a local path stays local.
  - `queue_covers`: every remote chunk neither stored nor failed for good is queued,
    through any number of failures, backoffs and retries.
  - `failed_not_stored`: a hash failed for good is not stored.
  - `failed_readers_eio` / `failed_gates_eio` / `async_failed_eio` / `sync_failed_eio`:
    every reader, gate and read of a path backed by a failed hash has EIO.
  - `reader_bounded` / `gate_bounded`: no waiting reader outlives `RD` ticks and no
    open gate `D` ticks, whatever the fetches do.
  - `gate_ok_local` / `bound_reads_never_eio`, `nothing_named_starts`.
  - `named_local_within`: with every queued hash ready and no named chunk failed, the
    named paths are local after as many successful fetches as they had remote chunks.
  - Traces: `a_shared_chunk`, `a_failure_trace`, `a_reader_deadline`.
-/

namespace Nimbus.Vfs.Hydration

structure Cfg where
  /-- A gate's deadline, in ticks after bind. -/
  D : Nat
  /-- An async reader's deadline, in ticks after its read. -/
  RD : Nat
  backoff : Nat := 1
  maxBackoff : Nat := 4
  maxA : Nat := 8
  deriving DecidableEq, Repr

inductive Res where
  | ok
  /-- EIO naming the path, and the failed chunk when a failure caused it. -/
  | eio (p : Nat) (chunk : Option Nat)
  deriving DecidableEq, Repr

structure Gate where
  named : List Nat
  opened : Nat
  result : Option Res
  deriving DecidableEq, Repr

structure Reader where
  path : Nat
  start : Nat
  result : Option Res
  deriving DecidableEq, Repr

structure H where
  cfg : Cfg
  now : Nat
  /-- Each path's chunk hashes. -/
  files : List (Nat × List Nat)
  /-- The hashes the import window left in state 1. -/
  remote : List Nat
  hyd : List Nat
  queue : List Nat
  failed : List Nat
  attempts : Nat → Nat
  notBefore : Nat → Nat
  readers : List Reader
  gates : List Gate

def chunksOf (s : H) (p : Nat) : List Nat := ((s.files.find? (·.1 == p)).map (·.2)).getD []

def hLocal (s : H) (h : Nat) : Bool := !s.remote.contains h || s.hyd.contains h

def isLocal (s : H) (p : Nat) : Bool := (chunksOf s p).all (hLocal s)

/-- The first chunk of `p` that failed for good. -/
def failedChunk (s : H) (p : Nat) : Option Nat := (chunksOf s p).find? (s.failed.contains ·)

/-- The first named path backed by a failed chunk, and that chunk. -/
def gateFailed (s : H) (named : List Nat) : Option (Nat × Nat) :=
  named.findSome? fun p => (failedChunk s p).map (p, ·)

/-- The remote chunks of `ps`, in order: what `NeedsHydration` names. -/
def need (s : H) (ps : List Nat) : List Nat := (ps.flatMap (chunksOf s)).filter (!hLocal s ·)

/-- Move `hs`'s queued hashes to the front, in `hs`'s order. -/
def prio (q hs : List Nat) : List Nat :=
  let front := hs.filter q.contains
  front ++ q.filter (fun x => !front.contains x)

def settleR (s : H) (r : Reader) : Reader :=
  match r.result with
  | some _ => r
  | none =>
    if isLocal s r.path then { r with result := some .ok }
    else match failedChunk s r.path with
      | some c => { r with result := some (.eio r.path (some c)) }
      | none => if r.start + s.cfg.RD ≤ s.now then { r with result := some (.eio r.path none) } else r

def settleG (s : H) (g : Gate) : Gate :=
  match g.result with
  | some _ => g
  | none =>
    if g.named.all (isLocal s) then { g with result := some .ok }
    else match gateFailed s g.named with
      | some (p, c) => { g with result := some (.eio p (some c)) }
      | none =>
        if g.opened + s.cfg.D ≤ s.now then
          { g with result := some (.eio ((g.named.find? (!isLocal s ·)).getD 0) none) }
        else g

def settle (s : H) : H := { s with readers := s.readers.map (settleR s), gates := s.gates.map (settleG s) }

inductive Ev where
  | tick
  /-- A fetch of the first ready queued hash: outcome 0 succeeds; any other fails
      (1 rejected, 2 wrong bytes, 3 left out: alike here). -/
  | job (outcome : Nat)
  | asyncRead (p : Nat)
  | syncRead (p : Nat)
  | bind (named : List Nat)
  | retry
  deriving Repr

inductive Out where
  | ok
  | idle
  | fetched (h : Nat)
  | skipped (h : Nat)
  | failedOnce (h : Nat)
  | failedHard (h : Nat)
  | bytes (p : Nat)
  | wait
  | eio (p : Nat) (chunk : Option Nat)
  deriving DecidableEq, Repr

def upd (f : Nat → Nat) (i v : Nat) : Nat → Nat := fun j => if j = i then v else f j

def backoffAfter (c : Cfg) (k : Nat) : Nat := min c.maxBackoff (c.backoff * 2 ^ (k - 1))

/-- The first queued hash whose backoff has passed. -/
def pick (s : H) : Option Nat := s.queue.find? fun x => decide (s.notBefore x ≤ s.now)

def jobStep (s : H) (outcome : Nat) : Out × H :=
  match pick s with
  | none => (.idle, s)
  | some x =>
    if hLocal s x then (.skipped x, { s with queue := s.queue.erase x })
    else if outcome = 0 then (.fetched x, { s with hyd := s.hyd ++ [x], queue := s.queue.erase x })
    else if s.cfg.maxA ≤ s.attempts x + 1 then
      (.failedHard x, { s with queue := s.queue.filter (· != x), failed := s.failed ++ [x],
                               attempts := upd s.attempts x (s.attempts x + 1) })
    else
      (.failedOnce x, { s with queue := s.queue.filter (· != x) ++ [x],
                               attempts := upd s.attempts x (s.attempts x + 1),
                               notBefore := upd s.notBefore x (s.now + backoffAfter s.cfg (s.attempts x + 1)) })

def raw (s : H) : Ev → Out × H
  | .tick => (.ok, { s with now := s.now + 1 })
  | .job o => jobStep s o
  | .asyncRead p =>
    if isLocal s p then (.bytes p, s)
    else match failedChunk s p with
      | some c => (.eio p (some c), s)
      | none => (.wait, { s with readers := s.readers ++ [⟨p, s.now, none⟩], queue := prio s.queue (need s [p]) })
  | .syncRead p =>
    if isLocal s p then (.bytes p, s)
    else match failedChunk s p with
      | some c => (.eio p (some c), s)
      | none => (.eio p none, { s with queue := prio s.queue (need s [p]) })
  | .bind named => (.ok, { s with queue := prio s.queue (need s named), gates := s.gates ++ [⟨named, s.now, none⟩] })
  | .retry =>
    (.ok, { s with queue := s.queue ++ s.failed, failed := [],
                   attempts := fun h => if s.failed.contains h then 0 else s.attempts h,
                   notBefore := fun h => if s.failed.contains h then s.now else s.notBefore h })

def step (s : H) (e : Ev) : Out × H := let r := raw s e; (r.1, settle r.2)

def start (cfg : Cfg) (files : List (Nat × List Nat)) (remote : List Nat) : H :=
  ⟨cfg, 0, files, remote, [], remote, [], fun _ => 0, fun _ => 0, [], []⟩

inductive Reach : H → Prop
  | init (cfg : Cfg) (files : List (Nat × List Nat)) (remote : List Nat) : Reach (start cfg files remote)
  | step {s : H} (e : Ev) : Reach s → Reach (step s e).2

/-! ## Settling leaves the store alone -/

@[simp] theorem settle_files (s : H) : (settle s).files = s.files := rfl
@[simp] theorem settle_remote (s : H) : (settle s).remote = s.remote := rfl
@[simp] theorem settle_hyd (s : H) : (settle s).hyd = s.hyd := rfl
@[simp] theorem settle_queue (s : H) : (settle s).queue = s.queue := rfl
@[simp] theorem settle_failed (s : H) : (settle s).failed = s.failed := rfl
@[simp] theorem settle_now (s : H) : (settle s).now = s.now := rfl
@[simp] theorem settle_cfg (s : H) : (settle s).cfg = s.cfg := rfl
@[simp] theorem settle_notBefore (s : H) : (settle s).notBefore = s.notBefore := rfl
theorem isLocal_settle (s : H) : isLocal (settle s) = isLocal s := rfl
theorem hLocal_settle (s : H) : hLocal (settle s) = hLocal s := rfl
theorem failedChunk_settle (s : H) : failedChunk (settle s) = failedChunk s := rfl
theorem gateFailed_settle (s : H) : gateFailed (settle s) = gateFailed s := rfl

/-! ## Readers -/

theorem sync_never_state1 (s : H) (p q : Nat) (h : (step s (.syncRead p)).1 = .bytes q) :
    q = p ∧ ∀ c ∈ chunksOf s p, hLocal s c = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, List.all_eq_true.mp hl⟩
  · split at h <;> cases h

theorem async_never_state1 (s : H) (p q : Nat) (h : (step s (.asyncRead p)).1 = .bytes q) :
    q = p ∧ ∀ c ∈ chunksOf s p, hLocal s c = true := by
  simp only [step, raw] at h
  split at h
  · rename_i hl; cases h; exact ⟨rfl, List.all_eq_true.mp hl⟩
  · split at h <;> cases h

theorem failedChunk_spec {s : H} {p c : Nat} (h : failedChunk s p = some c) : c ∈ chunksOf s p ∧ c ∈ s.failed :=
  ⟨List.mem_of_find?_eq_some h, by simpa using List.find?_some h⟩

theorem failedChunk_none {s : H} {p : Nat} (h : failedChunk s p = none) : ∀ c ∈ chunksOf s p, c ∉ s.failed := by
  intro c hc hf
  exact List.find?_eq_none.mp h c hc (by simpa using hf)

/-- A read of a path backed by a failed hash answers EIO naming it at once. -/
theorem async_failed_eio (s : H) (p c : Nat) (hl : isLocal s p = false) (hf : failedChunk s p = some c) :
    (step s (.asyncRead p)).1 = .eio p (some c) := by
  simp [step, raw, hl, hf]

theorem sync_failed_eio (s : H) (p c : Nat) (hl : isLocal s p = false) (hf : failedChunk s p = some c) :
    (step s (.syncRead p)).1 = .eio p (some c) := by
  simp [step, raw, hl, hf]

/-! ## Frame -/

theorem pick_mem {s : H} {x : Nat} (h : pick s = some x) : x ∈ s.queue := List.mem_of_find?_eq_some h

theorem jobStep_frame (s : H) (o : Nat) : (jobStep s o).2.files = s.files ∧ (jobStep s o).2.remote = s.remote ∧
    (jobStep s o).2.cfg = s.cfg ∧ (∀ c ∈ s.hyd, c ∈ (jobStep s o).2.hyd) ∧ (jobStep s o).2.now = s.now ∧
    (jobStep s o).2.readers = s.readers ∧ (jobStep s o).2.gates = s.gates := by
  unfold jobStep
  split
  · exact ⟨rfl, rfl, rfl, fun _ h => h, rfl, rfl, rfl⟩
  · split
    · exact ⟨rfl, rfl, rfl, fun _ h => h, rfl, rfl, rfl⟩
    · split
      · exact ⟨rfl, rfl, rfl, fun _ h => List.mem_append_left _ h, rfl, rfl, rfl⟩
      · split <;> exact ⟨rfl, rfl, rfl, fun _ h => h, rfl, rfl, rfl⟩

theorem raw_frame (s : H) (e : Ev) : (raw s e).2.files = s.files ∧ (raw s e).2.remote = s.remote ∧
    (raw s e).2.cfg = s.cfg ∧ (∀ c ∈ s.hyd, c ∈ (raw s e).2.hyd) ∧ s.now ≤ (raw s e).2.now := by
  cases e with
  | job o =>
    obtain ⟨h1, h2, h3, h4, h5, -⟩ := jobStep_frame s o
    exact ⟨h1, h2, h3, h4, by simp only [raw]; omega⟩
  | tick => exact ⟨rfl, rfl, rfl, fun _ h => h, by simp [raw]⟩
  | asyncRead p =>
    simp only [raw]; split
    · exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩
    · split <;> exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩
  | syncRead p =>
    simp only [raw]; split
    · exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩
    · split <;> exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩
  | bind named => exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩
  | retry => exact ⟨rfl, rfl, rfl, fun _ h => h, Nat.le_refl _⟩

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

/-! ## The queue holds every remote chunk neither stored nor failed -/

def Covers (s : H) : Prop := ∀ c, c ∈ s.remote → c ∉ s.hyd → c ∉ s.failed → c ∈ s.queue

theorem prio_mem {q hs : List Nat} {c : Nat} (h : c ∈ q) : c ∈ prio q hs := by
  unfold prio
  by_cases e : (hs.filter q.contains).contains c = true
  · exact List.mem_append_left _ (List.contains_iff_mem.mp e)
  · refine List.mem_append_right _ (List.mem_filter.mpr ⟨h, ?_⟩)
    have : (hs.filter q.contains).contains c = false := by
      cases h' : (hs.filter q.contains).contains c
      · rfl
      · exact absurd h' e
    show (!(hs.filter q.contains).contains c) = true
    rw [this]; rfl

theorem prio_sub {q hs : List Nat} {c : Nat} (h : c ∈ prio q hs) : c ∈ q := by
  unfold prio at h
  rcases List.mem_append.mp h with h | h
  · exact List.contains_iff_mem.mp (List.mem_filter.mp h).2
  · exact (List.mem_filter.mp h).1

theorem jobStep_covers (s : H) (hs : Covers s) (o : Nat) : Covers (jobStep s o).2 := by
  intro c hc hn hf
  have hc' : c ∈ s.remote := by rw [← (jobStep_frame s o).2.1]; exact hc
  unfold jobStep at hn hf ⊢
  cases hp : pick s with
  | none => simp only [hp] at hn hf ⊢; exact hs c hc' hn hf
  | some x =>
    simp only [hp] at hn hf ⊢
    by_cases hl : hLocal s x = true
    · simp only [hl, if_true] at hn hf ⊢
      have hcx : c ≠ x := by
        rintro rfl
        simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem] at hl
        rcases hl with h | h
        · simp at h; exact h hc'
        · exact hn h
      exact (List.mem_erase_of_ne hcx).mpr (hs c hc' hn hf)
    · simp only [hl, Bool.false_eq_true, if_false] at hn hf ⊢
      by_cases ho : o = 0
      · simp only [ho, if_true] at hn hf ⊢
        simp only [List.mem_append, List.mem_singleton, not_or] at hn
        exact (List.mem_erase_of_ne hn.2).mpr (hs c hc' hn.1 hf)
      · simp only [ho, if_false] at hn hf ⊢
        by_cases hm : s.cfg.maxA ≤ s.attempts x + 1
        · simp only [hm, if_true] at hn hf ⊢
          simp only [List.mem_append, List.mem_singleton, not_or] at hf
          exact List.mem_filter.mpr ⟨hs c hc' hn hf.1, by simpa using hf.2⟩
        · simp only [hm, if_false] at hn hf ⊢
          by_cases e : c = x
          · subst e; exact List.mem_append_right _ (List.mem_singleton_self _)
          · exact List.mem_append_left _ (List.mem_filter.mpr ⟨hs c hc' hn hf, by simpa using e⟩)

theorem step_covers (s : H) (hs : Covers s) (e : Ev) : Covers (step s e).2 := by
  show Covers (raw s e).2
  cases e with
  | job o => exact jobStep_covers s hs o
  | tick => exact hs
  | asyncRead p =>
    intro c hc hn hf
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hc hn hf ⊢ <;>
      first | exact hs c hc hn hf | exact prio_mem (hs c hc hn hf)
  | syncRead p =>
    intro c hc hn hf
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hc hn hf ⊢ <;>
      first | exact hs c hc hn hf | exact prio_mem (hs c hc hn hf)
  | bind named => intro c hc hn hf; exact prio_mem (hs c hc hn hf)
  | retry =>
    intro c hc hn _
    show c ∈ s.queue ++ s.failed
    by_cases h : c ∈ s.failed
    · exact List.mem_append_right _ h
    · exact List.mem_append_left _ (hs c hc hn h)

theorem queue_covers {s : H} (h : Reach s) : Covers s := by
  induction h with
  | init cfg files remote => intro c hc _ _; exact hc
  | step e _ ih => exact step_covers _ ih e

/-! ## Failed hashes -/

structure Core (s : H) : Prop where
  qRem : ∀ x ∈ s.queue, x ∈ s.remote
  fRem : ∀ x ∈ s.failed, x ∈ s.remote
  fNotQ : ∀ x ∈ s.failed, x ∉ s.queue
  fNotHyd : ∀ x ∈ s.failed, x ∉ s.hyd

theorem jobStep_core (s : H) (hs : Core s) (o : Nat) : Core (jobStep s o).2 := by
  unfold jobStep
  split
  · exact hs
  · rename_i x hx
    have hxq := pick_mem hx
    split
    · exact ⟨fun y hy => hs.qRem y (List.mem_of_mem_erase hy), hs.fRem,
        fun y hy h => hs.fNotQ y hy (List.mem_of_mem_erase h), hs.fNotHyd⟩
    · rename_i hl
      have hxh : x ∉ s.hyd ∧ x ∈ s.remote := by
        simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem, not_or] at hl
        exact ⟨hl.2, by simpa using hl.1⟩
      split
      · refine ⟨fun y hy => hs.qRem y (List.mem_of_mem_erase hy), hs.fRem,
          fun y hy h => hs.fNotQ y hy (List.mem_of_mem_erase h), fun y hy h => ?_⟩
        rcases List.mem_append.mp h with h | h
        · exact hs.fNotHyd y hy h
        · simp at h; subst h; exact hs.fNotQ y hy hxq
      · split
        · refine ⟨fun y hy => hs.qRem y (List.mem_filter.mp hy).1, fun y hy => ?_, fun y hy h => ?_, fun y hy h => ?_⟩
          · rcases List.mem_append.mp hy with hy | hy
            · exact hs.fRem y hy
            · simp at hy; subst hy; exact hxh.2
          · rcases List.mem_append.mp hy with hy | hy
            · exact hs.fNotQ y hy (List.mem_filter.mp h).1
            · simp at hy; subst hy; simp [List.mem_filter] at h
          · rcases List.mem_append.mp hy with hy | hy
            · exact hs.fNotHyd y hy h
            · simp at hy; subst hy; exact hxh.1 h
        · refine ⟨fun y hy => ?_, hs.fRem, fun y hy h => ?_, hs.fNotHyd⟩
          · rcases List.mem_append.mp hy with hy | hy
            · exact hs.qRem y (List.mem_filter.mp hy).1
            · simp at hy; subst hy; exact hxh.2
          · rcases List.mem_append.mp h with h | h
            · exact hs.fNotQ y hy (List.mem_filter.mp h).1
            · simp at h; subst h; exact hs.fNotQ y hy hxq

theorem raw_core (s : H) (hs : Core s) (e : Ev) : Core (raw s e).2 := by
  have prioCore : ∀ hs' : List Nat, Core { s with queue := prio s.queue hs' } := fun _ =>
    ⟨fun y hy => hs.qRem y (prio_sub hy), hs.fRem, fun y hy h => hs.fNotQ y hy (prio_sub h), hs.fNotHyd⟩
  cases e with
  | job o => exact jobStep_core s hs o
  | tick => exact ⟨hs.qRem, hs.fRem, hs.fNotQ, hs.fNotHyd⟩
  | asyncRead p =>
    have := prioCore (need s [p])
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] <;>
      first | exact hs | exact ⟨this.qRem, this.fRem, this.fNotQ, this.fNotHyd⟩
  | syncRead p =>
    have := prioCore (need s [p])
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] <;>
      first | exact hs | exact ⟨this.qRem, this.fRem, this.fNotQ, this.fNotHyd⟩
  | bind named =>
    have := prioCore (need s named)
    exact ⟨this.qRem, this.fRem, this.fNotQ, this.fNotHyd⟩
  | retry =>
    refine ⟨fun y hy => ?_, fun _ h => (by cases h), fun _ h => (by cases h), fun _ h => (by cases h)⟩
    rcases List.mem_append.mp hy with hy | hy
    · exact hs.qRem y hy
    · exact hs.fRem y hy

theorem core {s : H} (h : Reach s) : Core s := by
  induction h with
  | init cfg files remote => exact ⟨fun _ h => h, fun _ h => (by cases h), fun _ h => (by cases h), fun _ h => (by cases h)⟩
  | step e _ ih => have := raw_core _ ih e; exact ⟨this.qRem, this.fRem, this.fNotQ, this.fNotHyd⟩

/-- A hash failed for good is not stored. -/
theorem failed_not_stored {s : H} (h : Reach s) (x : Nat) (hx : x ∈ s.failed) : x ∉ s.hyd := (core h).fNotHyd x hx

theorem failed_not_local {s : H} (h : Reach s) (x : Nat) (hx : x ∈ s.failed) : hLocal s x = false := by
  have := (core h).fRem x hx
  have := (core h).fNotHyd x hx
  simp [hLocal, *]

/-! ## Readers and gates -/

def RG (s : H) : Prop :=
  (∀ r ∈ s.readers, (r.result = none → s.now < r.start + s.cfg.RD ∧ failedChunk s r.path = none) ∧
    (r.result = some .ok → isLocal s r.path = true)) ∧
  (∀ g ∈ s.gates, (g.result = none → s.now < g.opened + s.cfg.D ∧ gateFailed s g.named = none) ∧
    (g.result = some .ok → ∀ p ∈ g.named, isLocal s p = true))

theorem settleR_spec (t : H) (r : Reader) (hr : r.result = some .ok → isLocal t r.path = true) :
    ((settleR t r).result = none → t.now < r.start + t.cfg.RD ∧ failedChunk t r.path = none) ∧
      ((settleR t r).result = some .ok → isLocal t r.path = true) ∧ (settleR t r).path = r.path ∧
      (settleR t r).start = r.start := by
  unfold settleR
  split
  · rename_i v hv
    exact ⟨fun h => (by rw [hv] at h; cases h), hr, rfl, rfl⟩
  · split
    · rename_i hl; exact ⟨fun h => (by cases h), fun _ => hl, rfl, rfl⟩
    · split
      · exact ⟨fun h => (by cases h), fun h => (by cases h), rfl, rfl⟩
      · rename_i hf
        split
        · exact ⟨fun h => (by cases h), fun h => (by cases h), rfl, rfl⟩
        · rename_i hd; exact ⟨fun _ => ⟨by omega, hf⟩, fun h => (by simp_all), rfl, rfl⟩

theorem settleG_spec (t : H) (g : Gate) (hg : g.result = some .ok → ∀ p ∈ g.named, isLocal t p = true) :
    ((settleG t g).result = none → t.now < g.opened + t.cfg.D ∧ gateFailed t g.named = none) ∧
      ((settleG t g).result = some .ok → ∀ p ∈ g.named, isLocal t p = true) ∧ (settleG t g).named = g.named ∧
      (settleG t g).opened = g.opened := by
  unfold settleG
  split
  · rename_i v hv
    exact ⟨fun h => (by rw [hv] at h; cases h), hg, rfl, rfl⟩
  · split
    · rename_i hl; exact ⟨fun h => (by cases h), fun _ p hp => List.all_eq_true.mp hl p hp, rfl, rfl⟩
    · split
      · exact ⟨fun h => (by cases h), fun h => (by cases h), rfl, rfl⟩
      · rename_i hf
        split
        · exact ⟨fun h => (by cases h), fun h => (by cases h), rfl, rfl⟩
        · rename_i hd; exact ⟨fun _ => ⟨by omega, hf⟩, fun h => (by simp_all), rfl, rfl⟩

theorem settle_RG (t : H) (hr : ∀ r ∈ t.readers, r.result = some .ok → isLocal t r.path = true)
    (hg : ∀ g ∈ t.gates, g.result = some .ok → ∀ p ∈ g.named, isLocal t p = true) : RG (settle t) := by
  refine ⟨fun r' hr' => ?_, fun g' hg' => ?_⟩
  · obtain ⟨r, hr0, rfl⟩ := List.mem_map.mp hr'
    obtain ⟨a, b, c, d⟩ := settleR_spec t r (hr r hr0)
    rw [c, d]; exact ⟨a, b⟩
  · obtain ⟨g, hg0, rfl⟩ := List.mem_map.mp hg'
    obtain ⟨a, b, c, d⟩ := settleG_spec t g (hg g hg0)
    rw [c, d]; exact ⟨a, b⟩

theorem raw_readers (s : H) (e : Ev) : ∀ r ∈ (raw s e).2.readers, r ∈ s.readers ∨ r.result = none := by
  intro r hr
  cases e with
  | job o => change r ∈ (jobStep s o).2.readers at hr; rw [(jobStep_frame s o).2.2.2.2.2.1] at hr; exact Or.inl hr
  | asyncRead p =>
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hr
    · rcases List.mem_append.mp hr with h | h
      · exact Or.inl h
      · simp at h; subst h; exact Or.inr rfl
    all_goals exact Or.inl hr
  | syncRead p =>
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hr <;> exact Or.inl hr
  | _ => exact Or.inl hr

theorem raw_gates (s : H) (e : Ev) : ∀ g ∈ (raw s e).2.gates, g ∈ s.gates ∨ g.result = none := by
  intro g hg
  cases e with
  | job o => change g ∈ (jobStep s o).2.gates at hg; rw [(jobStep_frame s o).2.2.2.2.2.2] at hg; exact Or.inl hg
  | asyncRead p =>
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hg <;> exact Or.inl hg
  | syncRead p =>
    cases hl : isLocal s p <;> cases hfc : failedChunk s p <;>
      simp only [raw, hl, hfc, Bool.false_eq_true, if_false, if_true] at hg <;> exact Or.inl hg
  | bind named =>
    simp only [raw, List.mem_append, List.mem_singleton] at hg
    rcases hg with hg | rfl
    · exact Or.inl hg
    · exact Or.inr rfl
  | _ => exact Or.inl hg

theorem step_RG (s : H) (hs : RG s) (e : Ev) : RG (step s e).2 := by
  obtain ⟨hf, hr, _, hh, _⟩ := raw_frame s e
  have mono := isLocal_mono hf hr hh
  apply settle_RG
  · intro r hr0 hok
    rcases raw_readers s e r hr0 with h | h
    · exact mono _ ((hs.1 r h).2 hok)
    · rw [h] at hok; cases hok
  · intro g hg0 hok p hp
    rcases raw_gates s e g hg0 with h | h
    · exact mono _ ((hs.2 g h).2 hok p hp)
    · rw [h] at hok; cases hok

theorem rg {s : H} (h : Reach s) : RG s := by
  induction h with
  | init => exact ⟨fun _ h => (by cases h), fun _ h => (by cases h)⟩
  | step e _ ih => exact step_RG _ ih e

theorem reader_ok_local {s : H} (h : Reach s) (r : Reader) (hr : r ∈ s.readers) (hok : r.result = some .ok) :
    ∀ c ∈ chunksOf s r.path, hLocal s c = true := List.all_eq_true.mp ((rg h).1 r hr |>.2 hok)

/-- No waiting reader outlives its deadline, whatever the fetches do. -/
theorem reader_bounded {s : H} (h : Reach s) (r : Reader) (hr : r ∈ s.readers) (hopen : r.result = none) :
    s.now < r.start + s.cfg.RD := ((rg h).1 r hr |>.1 hopen).1

/-- No open gate outlives its deadline. -/
theorem gate_bounded {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hopen : g.result = none) :
    s.now < g.opened + s.cfg.D := ((rg h).2 g hg |>.1 hopen).1

theorem gate_ok_local {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hok : g.result = some .ok) :
    ∀ p ∈ g.named, isLocal s p = true := ((rg h).2 g hg).2 hok

/-- Once a launch's gate opened, no sync read of a named path answers EIO. -/
theorem bound_reads_never_eio {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (hok : g.result = some .ok)
    (p : Nat) (hp : p ∈ g.named) (q : Nat) (c : Option Nat) : (step s (.syncRead p)).1 ≠ .eio q c := by
  simp [step, raw, gate_ok_local h g hg hok p hp]

/-- Every reader of a path backed by a hash failed for good has EIO. -/
theorem failed_readers_eio {s : H} (h : Reach s) (r : Reader) (hr : r ∈ s.readers) (c : Nat)
    (hc : c ∈ chunksOf s r.path) (hf : c ∈ s.failed) : ∃ q c', r.result = some (.eio q c') := by
  rcases hres : r.result with _ | v
  · have := ((rg h).1 r hr).1 hres
    exact absurd hf (failedChunk_none this.2 c hc)
  · cases v with
    | ok =>
      have := List.all_eq_true.mp (((rg h).1 r hr).2 hres) c hc
      rw [failed_not_local h c hf] at this; cases this
    | eio q c' => exact ⟨q, c', rfl⟩

/-- Every gate naming a path backed by a hash failed for good has EIO. -/
theorem failed_gates_eio {s : H} (h : Reach s) (g : Gate) (hg : g ∈ s.gates) (p : Nat) (hp : p ∈ g.named)
    (c : Nat) (hc : c ∈ chunksOf s p) (hf : c ∈ s.failed) : ∃ q c', g.result = some (.eio q c') := by
  rcases hres : g.result with _ | v
  · have := (((rg h).2 g hg).1 hres).2
    have hp' := List.findSome?_eq_none_iff.mp this p hp
    have : failedChunk s p = none := by
      cases h' : failedChunk s p with
      | none => rfl
      | some _ => rw [h'] at hp'; cases hp'
    exact absurd hf (failedChunk_none this c hc)
  · cases v with
    | ok =>
      have := List.all_eq_true.mp ((((rg h).2 g hg).2 hres) p hp) c hc
      rw [failed_not_local h c hf] at this; cases this
    | eio q c' => exact ⟨q, c', rfl⟩

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
  | n + 1, s => jobs n (step s (.job 0)).2

def AllReady (s : H) : Prop := ∀ x ∈ s.queue, s.notBefore x ≤ s.now

theorem jobs_mono : ∀ n (t : H) c, hLocal t c = true → hLocal (jobs n t) c = true := by
  intro n
  induction n with
  | zero => intro t c h; exact h
  | succ n ih =>
    intro t c h
    obtain ⟨_, hr, _, hh, _⟩ := raw_frame t (.job 0)
    exact ih _ c (hLocal_mono hr hh c h)

theorem jobs_frame : ∀ n (t : H), (jobs n t).files = t.files ∧ (jobs n t).remote = t.remote := by
  intro n
  induction n with
  | zero => intro t; exact ⟨rfl, rfl⟩
  | succ n ih =>
    intro t
    obtain ⟨h1, h2⟩ := ih (step t (.job 0)).2
    exact ⟨h1.trans (raw_frame t (.job 0)).1, h2.trans (raw_frame t (.job 0)).2.1⟩

/-- A successful fetch of the head when every queued hash is ready: the head is local,
    the queue is the rest, and every queued hash is still ready. -/
theorem job_head (s : H) (x : Nat) (r : List Nat) (hq : s.queue = x :: r) (hrd : AllReady s) :
    hLocal (step s (.job 0)).2 x = true ∧ (step s (.job 0)).2.queue = r ∧ AllReady (step s (.job 0)).2 := by
  have hp : pick s = some x := by
    unfold pick; rw [hq]; exact List.find?_cons_of_pos _ (by simpa using hrd x (by rw [hq]; exact List.mem_cons_self _ _))
  have hrd' : ∀ y ∈ r, s.notBefore y ≤ s.now := fun y hy => hrd y (by rw [hq]; exact List.mem_cons_of_mem _ hy)
  simp only [step, raw, jobStep, hp]
  split
  · rename_i hl
    refine ⟨hl, by simp [hq], fun y hy => ?_⟩
    simp only [settle_queue, hq, List.erase_cons_head] at hy
    exact hrd' y hy
  · simp only [if_true]
    refine ⟨by simp [hLocal], by simp [hq], fun y hy => ?_⟩
    simp only [settle_queue, hq, List.erase_cons_head] at hy
    exact hrd' y hy

theorem jobs_hydrate : ∀ (u : List Nat) (s : H) (r : List Nat), s.queue = u ++ r → AllReady s →
    ∀ c ∈ u, hLocal (jobs u.length s) c = true := by
  intro u
  induction u with
  | nil => intro _ _ _ _ c hc; cases hc
  | cons x u ih =>
    intro s r hq hrd c hc
    obtain ⟨hx, hq', hrd'⟩ := job_head s x (u ++ r) (by simpa using hq) hrd
    simp only [List.length_cons, jobs]
    rcases List.mem_cons.mp hc with rfl | hc
    · exact jobs_mono _ _ _ hx
    · exact ih _ r hq' hrd' c hc

/-- With every queued hash ready and no named chunk failed, every named path is local
    after at most as many successful fetches as its remote chunks. -/
theorem named_local_within {s : H} (hr : Reach s) (named : List Nat) (hrd : AllReady s)
    (hnf : ∀ p ∈ named, ∀ c ∈ chunksOf s p, c ∉ s.failed) :
    let s1 := (step s (.bind named)).2
    ∃ k ≤ (need s named).length, ∀ p ∈ named, isLocal (jobs k s1) p = true := by
  intro s1
  have hcov := queue_covers hr
  let front := (need s named).filter s.queue.contains
  have hq1 : s1.queue = front ++ s.queue.filter (fun x => !front.contains x) := rfl
  have hrd1 : AllReady s1 := fun y hy => hrd y (prio_sub hy)
  refine ⟨front.length, List.length_filter_le _ _, fun p hp => ?_⟩
  obtain ⟨hf, hrm⟩ := jobs_frame front.length s1
  unfold isLocal chunksOf
  rw [hf]
  refine List.all_eq_true.mpr fun c hc => ?_
  have hc' : c ∈ chunksOf s p := hc
  by_cases hl : hLocal s c = true
  · exact jobs_mono front.length s1 c
      (hLocal_mono (s' := s1) (raw_frame s (.bind named)).2.1 (raw_frame s (.bind named)).2.2.2.1 c hl)
  · have hn : c ∈ need s named := List.mem_filter.mpr ⟨List.mem_flatMap.mpr ⟨p, hp, hc'⟩, by simpa using hl⟩
    simp only [hLocal, Bool.or_eq_true, Bool.not_eq_true', List.contains_iff_mem, not_or] at hl
    have hin : c ∈ s.queue := hcov c (by simpa using hl.1) hl.2 (hnf p hp c hc')
    have hfr : c ∈ front := List.mem_filter.mpr ⟨hn, List.contains_iff_mem.mpr hin⟩
    exact jobs_hydrate front s1 _ hq1 hrd1 c hfr

/-! ## Traces -/

/-- Paths 1 and 2 share chunk 5; path 3 is chunk 6; path 7 has only local chunk 9. A
    launch naming 1 moves 5 to the front; one fetch makes 1 and 2 local; a sync read of
    3 is EIO; a launch naming 3 with no fetch fails at its deadline naming 3. -/
theorem a_shared_chunk :
    let s0 := start { D := 3, RD := 3 } [(1, [5]), (2, [5]), (3, [6]), (7, [9])] [6, 5]
    let s1 := (step s0 (.bind [1])).2
    let s2 := (step s1 (.job 0)).2
    let s3 := (step s2 (.bind [7])).2
    let s4 := (step s3 (.bind [3])).2
    let s5 := (step (step (step s4 .tick).2 .tick).2 .tick).2
    s1.queue = [5, 6] ∧ isLocal s2 1 = true ∧ isLocal s2 2 = true ∧ (s2.gates.map (·.result)) = [some .ok] ∧
      (step s2 (.syncRead 3)).1 = .eio 3 none ∧ (s3.gates.map (·.result)) = [some .ok, some .ok] ∧
      (s5.gates.map (·.result)) = [some .ok, some .ok, some (.eio 3 none)] := by
  decide

def failCfg : Cfg := { D := 10, RD := 10, backoff := 1, maxBackoff := 4, maxA := 2 }

def failRun : List Ev :=
  [.asyncRead 2, .bind [1], .job 1, .job 0, .job 2, .job 0, .tick, .job 3]

/-- Path 1 is chunk 5, path 2 chunks 5 and 6, path 3 chunk 7; two attempts allowed. The
    first fetch of 5 fails and backs off a tick; 6 is fetched; 7 fails and backs off; a
    fetch before the backoff is idle; after a tick 5 fails for good: the waiting reader
    of 2 and the launch naming 1 get EIO naming chunk 5, as do fresh reads; a retry
    re-queues 5 and a fetch makes 1 local. -/
theorem a_failure_trace :
    let s := failRun.foldl (fun t e => (step t e).2) (start failCfg [(1, [5]), (2, [5, 6]), (3, [7])] [5, 6, 7])
    s.failed = [5] ∧ s.queue = [7] ∧ 5 ∉ s.hyd ∧
      (s.readers.map (·.result)) = [some (.eio 2 (some 5))] ∧ (s.gates.map (·.result)) = [some (.eio 1 (some 5))] ∧
      (step s (.syncRead 1)).1 = .eio 1 (some 5) ∧ (step s (.asyncRead 1)).1 = .eio 1 (some 5) ∧
      (let r := (step s .retry).2; r.queue = [7, 5] ∧ isLocal (step (step r (.job 0)).2 (.job 0)).2 1 = true) := by
  decide

/-- A reader of a chunk no fetch delivers gets EIO once its deadline has passed. -/
theorem a_reader_deadline :
    let s0 := start { D := 5, RD := 2 } [(1, [5])] [5]
    let s1 := (step s0 (.asyncRead 1)).2
    let s2 := (step (step s1 .tick).2 .tick).2
    (step s0 (.asyncRead 1)).1 = .wait ∧ (s1.readers.map (·.result)) = [none] ∧
      (s2.readers.map (·.result)) = [some (.eio 1 none)] := by
  decide

end Nimbus.Vfs.Hydration
