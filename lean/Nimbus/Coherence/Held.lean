/-
  Nimbus.Coherence.Held — held cells: an own write the facet store had no room for,
  kept in process memory (`__residentHeld`, release-next c30d304b) and served by sync
  reads like a row. It is undated (own) while its write-back is in flight and dated at
  the write's revision once acknowledged (`__residentStamp`).

  A held cell is a row of `Nimbus.Coherence.Store` that lives in the heap (`heap p`):
  the store's rows are exactly what sync reads serve, wherever they live. A cell stays
  in the heap while it is unchanged or its own bytes are stamped; any other change (a
  report dropping it, a put of new bytes, a fill, a refetch) takes it out. `hold` is an
  own write the store has no room for; `evict` is the LRU dropping a held cell (a
  miss, never old bytes).

  The rule the fix implements (GitParityLane) is the store's rule for every row: a
  dated cell is judged by every delta report and by a repair's listing, an undated
  one survives both and a repair notes its listed revision as a report. So `HStep`
  is `Step` plus `hold` and `evict`, and:
  - `held_inv`: every state reachable with held cells satisfies the store's invariant.
  - `held_no_stale` / `no_pre_peer_bytes`: every dated cell, held or not, holds a
    value the authority had at or after the newest admitted barrier; so after a peer
    write the authority acknowledged at or before that barrier, no sync read serves
    bytes older than the peer's, across any poison and repair.
  - `held_own_no_pre_peer`: an own cell whose write-back committed, served at a
    resumption with its acknowledgements settled, is not older than such a peer write.

  As built in c30d304b a repair judged only the store's file table (`reconcileHeld`:
  a held cell neither judged nor noted as a report):
  - `held_stale_after_repair` (the reviewer's held-stale.mjs): own write held, its
    write-back acknowledged, a peer overwrites, a poison's repair: the held cell with
    the own bytes is served though the authority committed the peer's before the
    barrier; `the_fixed_repair_drops_the_held_cell` is the same trace under the rule.
  - `held_report_missed_across_repair`: the write-back is still in flight during the
    repair, so the listing's report of the peer write never reaches it; it lands and
    stamps the held cell stale. The fix's `own` report for undated held cells closes it.
-/

import Nimbus.Coherence.StoreBugs

namespace Nimbus.Coherence.Store

/-- The facet's state and where each cell lives (`true`: the heap). -/
structure HSt where
  s : St
  heap : Path → Bool

/-- A cell stays in the heap only unchanged, or its own bytes stamped. -/
def stays : Option Row → Option Row → Bool
  | some a, some b => a == b || (a.stamp == .own && match b.stamp with | .dated _ => true | .own => false)
  | _, _ => false

def moved (a : HSt) (s' : St) : HSt := ⟨s', fun p => a.heap p && stays (a.s.rows p) (s'.rows p)⟩

/-- `writeSync`'s effect. -/
def ownWrite (s : St) (p : Path) : St :=
  { s with rows := upd s.rows p (some ⟨s.nextId, .own⟩), parked := upd s.parked p (some s.nextId),
           nextId := s.nextId + 1 }

inductive HStep : HSt → HSt → Prop
  | core (a : HSt) (s' : St) : Step a.s s' → HStep a (moved a s')
  /-- An own write the store has no room for: held in the heap. -/
  | hold (a : HSt) (p : Path) : HStep a ⟨ownWrite a.s p, upd a.heap p true⟩
  /-- The LRU forgets a held cell. -/
  | evict (a : HSt) (p : Path) : a.heap p = true →
      HStep a ⟨{ a.s with rows := upd a.s.rows p none }, upd a.heap p false⟩

inductive HReach : HSt → Prop
  | init : HReach ⟨init, fun _ => false⟩
  | step {a b : HSt} : HReach a → HStep a b → HReach b

/-! ## The invariant holds with held cells -/

theorem drop_inv {s : St} (hi : Inv s) (p : Path) : Inv { s with rows := upd s.rows p none } := by
  refine ⟨hi.mutsLe, hi.hLe, hi.cursorLe, ?_, ?_, hi.fillRev, hi.fillFresh, hi.repairSpoiled, hi.requestLe,
    hi.answerOk, hi.listingOk, hi.flightOk, hi.flightLt, hi.parkedLt⟩
  · intro q v r hq
    simp only [upd] at hq
    split at hq
    · cases hq
    · exact hi.rowStamp q v r hq
  · intro q v r hq
    simp only [upd] at hq
    split at hq
    · cases hq
    · exact hi.rowFresh q v r hq

theorem held_inv {a : HSt} (h : HReach a) : Inv a.s := by
  induction h with
  | init => exact init_inv
  | step _ hs ih =>
    cases hs with
    | core s' hs => exact step_inv ih hs
    | hold p => exact step_inv ih (Step.writeSync _ p)
    | evict p _ => exact drop_inv ih p

/-! ## No stale read -/

theorem no_stale_of_inv {s : St} (hi : Inv s) {p : Path} {v r : Nat} (hr : s.rows p = some ⟨v, .dated r⟩) :
    ∃ t, s.H ≤ t ∧ t ≤ s.rev ∧ valAt s.muts p t = v := by
  obtain ⟨hv, hno⟩ := hi.rowFresh p v r hr
  have hHle := hi.hLe
  have hvle : v ≤ s.rev := by
    rcases hv with rfl | hv
    · omega
    · exact (hi.mutsLe _ hv).2
  refine ⟨max v s.H, by omega, by omega, ?_⟩
  obtain ⟨h1, h2⟩ := valAt_spec s.muts p (max v s.H)
  rcases hv with rfl | hv
  · rcases h1 with h1 | ⟨hm, hle⟩
    · exact h1
    · have := hi.mutsLe _ hm
      exact absurd ⟨by omega, by omega⟩ (hno _ hm rfl)
  · have hge := h2 _ hv rfl (by omega)
    rcases h1 with h1 | ⟨hm, hle⟩
    · have := (hi.mutsLe _ hv).1; omega
    · by_cases e : v < valAt s.muts p (max v s.H)
      · exact absurd ⟨e, by omega⟩ (hno _ hm rfl)
      · omega

/-- Every dated cell, held or in the store, holds a value the authority had at some
    instant at or after the newest admitted barrier answer. -/
theorem held_no_stale {a : HSt} (h : HReach a) {p : Path} {v r : Nat}
    (hr : a.s.rows p = some ⟨v, .dated r⟩) : ∃ t, a.s.H ≤ t ∧ t ≤ a.s.rev ∧ valAt a.s.muts p t = v :=
  no_stale_of_inv (held_inv h) hr

/-- After a peer write the authority committed at or before the newest admitted
    barrier, no sync read of a dated cell, held or not, serves bytes older than it,
    across any number of poisons and repairs. -/
theorem no_pre_peer_bytes {a : HSt} (h : HReach a) {p : Path} {n v r : Nat} (hm : (p, n) ∈ a.s.muts)
    (hn : n ≤ a.s.H) (hr : a.s.rows p = some ⟨v, .dated r⟩) : n ≤ v := by
  obtain ⟨t, ht, -, hv⟩ := held_no_stale h hr
  rw [← hv]
  exact (valAt_spec a.s.muts p t).2 _ hm rfl (by omega)

/-- An own cell whose write-back committed at `r`, at a resumption whose
    acknowledgements are settled, is not older than such a peer write either. -/
theorem held_own_no_pre_peer {a : HSt} (h : HReach a) (hs : AcksSettled a.s) {g : Flight} (hg : g ∈ a.s.flights)
    {r : Nat} (hr : g.committed = some r) (hp : a.s.parked g.path = some g.w) {n : Nat}
    (hm : (g.path, n) ∈ a.s.muts) (hn : n ≤ a.s.H) : n ≤ r := by
  have hi := held_inv h
  obtain ⟨-, -, hf⟩ := hi.flightOk g hg r hr
  have hno : NoMut a.s.muts g.path r (max r a.s.H) := by
    rcases hf hp with h' | h'
    · rw [hs g hg hp] at h'; omega
    · exact h'
  by_cases e : n ≤ r
  · exact e
  · exact absurd ⟨by omega, by omega⟩ (hno _ hm rfl)

/-! ## As built in c30d304b -/

/-- The repair as built: the listing judges the file table only; a held cell is
    neither dropped nor noted as a report (`__residentOwnPaths` and the pass's `own`
    read the file table). -/
def reconcileHeld (a : HSt) (L : Listing) : St :=
  { a.s with
    repair := some (some { L with reconciled := true })
    H := max a.s.H L.cursor
    rows := fun p => if a.heap p then a.s.rows p else match a.s.rows p with
      | some ⟨v, .dated r⟩ => if r < L.listed p then none else some ⟨v, .dated r⟩
      | o => o
    reports := fun p => if a.heap p then a.s.reports p else
      if a.s.parked p ≠ none ∧ a.s.reports p < L.listed p then L.listed p else a.s.reports p }

/-- The code's moves: the store's own (all but the repair's reconcile are as the
    code has them), holds, evictions, and the as-built reconcile. -/
inductive BStep : HSt → HSt → Prop
  | fixed (a b : HSt) : HStep a b → BStep a b
  | reconcileHeld (a : HSt) (L : Listing) : a.s.repair = some (some L) → L.reconciled = false →
      BStep a ⟨reconcileHeld a L, a.heap⟩

inductive BReach : HSt → Prop
  | init : BReach ⟨init, fun _ => false⟩
  | step {a b : HSt} : BReach a → BStep a b → BReach b

/-- `flushLand`'s effect. -/
def landS (s : St) (g : Flight) (r : Nat) : St :=
  if s.parked g.path = some g.w then
    { s with
      flights := s.flights.erase g
      parked := upd s.parked g.path none
      reports := upd s.reports g.path 0
      rows := if r < s.reports g.path then upd s.rows g.path none
        else match s.rows g.path with
          | some ⟨_, .own⟩ => upd s.rows g.path (some ⟨r, .dated r⟩)
          | o => upd s.rows g.path o }
  else { s with flights := s.flights.erase g }

/-- `reconcile`'s effect. -/
def reconS (s : St) (L : Listing) : St :=
  { s with
    repair := some (some { L with reconciled := true })
    H := max s.H L.cursor
    rows := fun p => match s.rows p with
      | some ⟨v, .dated r⟩ => if r < L.listed p then none else some ⟨v, .dated r⟩
      | o => o
    reports := fun p => if s.parked p ≠ none ∧ s.reports p < L.listed p then L.listed p else s.reports p }

theorem last_le (s : St) (p : Path) : last s p ≤ s.rev := by
  rcases (valAt_spec s.muts p s.rev).1 with h | h
  · unfold last; omega
  · exact h.2

/-- A listing at the authority's clock. -/
def listNow (s : St) : Listing := ⟨s.rev, fun p => last s p, false⟩

/-- Own write held, its write-back sent and committed at 1. -/
def afterCommit : HSt :=
  let a1 : HSt := ⟨ownWrite init 0, upd (fun _ => false) 0 true⟩
  let a2 := moved a1 { a1.s with flights := a1.s.flights ++ [⟨0, 0, none⟩] }
  let g : Flight := ⟨0, 0, none⟩
  moved a2 { commitMut a2.s g.path 1 with
    flights := a2.s.flights.map fun x => if x = g then { g with committed := some 1 } else x }

/-- The acknowledgement landed, unless `inFlight`. -/
def afterAck (inFlight : Bool) : HSt :=
  if inFlight then afterCommit else moved afterCommit (landS afterCommit.s ⟨0, 0, some 1⟩ 1)

/-- Then a peer commits 2, churn trims the log, and a barrier is poisoned: a repair
    starts. -/
def beforeList (inFlight : Bool) : HSt :=
  let a4 := afterAck inFlight
  let a5 := moved a4 (commitMut a4.s 0 (a4.s.rev + 1))
  let a6 := moved a5 { a5.s with logFloor := max a5.s.logFloor a5.s.rev }
  let q := (a6.s.nextId, a6.s.cursor)
  let a7 := moved a6 { a6.s with requests := a6.s.requests ++ [q], nextId := a6.s.nextId + 1 }
  let ans : Answer := ⟨q.1, q.2, a7.s.rev, poisons a7.s q.2, deltaFrom a7.s q.2, false⟩
  let a8 := moved a7 { a7.s with requests := a7.s.requests.erase q, answers := a7.s.answers ++ [ans] }
  moved a8 { a8.s with answers := a8.s.answers.erase ans, fills := spoil a8.s.fills, repair := some none }

def theListing (inFlight : Bool) : Listing := listNow (beforeList inFlight).s

def beforeRecon (inFlight : Bool) : HSt :=
  moved (beforeList inFlight) { (beforeList inFlight).s with repair := some (some (theListing inFlight)) }

theorem afterCommit_reach : HReach afterCommit := by
  have h1 : HReach ⟨ownWrite init 0, upd (fun _ => false) 0 true⟩ := .step .init (.hold _ 0)
  have h2 := HReach.step h1 (.core _ _ (.flushSend _ 0 0 (by decide) (by decide)))
  exact HReach.step h2 (.core _ _ (.flushCommit _ ⟨0, 0, none⟩ 1 (by decide) rfl (by decide)))

theorem afterAck_reach (inFlight : Bool) : HReach (afterAck inFlight) := by
  cases inFlight
  · exact HReach.step afterCommit_reach (.core _ _ (.flushLand _ ⟨0, 0, some 1⟩ 1 (by decide) rfl))
  · exact afterCommit_reach

theorem beforeList_reach (inFlight : Bool) : HReach (beforeList inFlight) := by
  have h5 := HReach.step (afterAck_reach inFlight) (.core _ _ (.peerWrite _ 0 _ (Nat.lt_succ_self _)))
  have h6 := HReach.step h5 (.core _ _ (.trim _ _ (Nat.le_refl _)))
  have h7 := HReach.step h6 (.core _ _ (.request _))
  have h8 := HReach.step h7 (.core _ _ (.serve _ _ (List.mem_append_right _ (List.mem_singleton.mpr rfl))))
  exact HReach.step h8 (.core _ _ (.admitPoison _ _ (List.mem_append_right _ (List.mem_singleton.mpr rfl))
    (by cases inFlight <;> decide) (by cases inFlight <;> rfl)))

theorem beforeRecon_reach (inFlight : Bool) : HReach (beforeRecon inFlight) :=
  HReach.step (beforeList_reach inFlight) (.core _ _ (.list _ (fun p => last _ p) (by cases inFlight <;> rfl)
    (fun _ => Nat.le_refl _) (fun p => last_le _ p)))

theorem hreach_breach {a : HSt} (h : HReach a) : BReach a := by
  induction h with
  | init => exact .init
  | step _ hs ih => exact .step ih (.fixed _ _ hs)

def reconciled (inFlight : Bool) : Listing := { theListing inFlight with reconciled := true }

/-- After the as-built reconcile and the publish. -/
def afterBuilt (inFlight : Bool) : HSt :=
  let c : HSt := ⟨reconcileHeld (beforeRecon inFlight) (theListing inFlight), (beforeRecon inFlight).heap⟩
  moved c { c.s with cursor := (reconciled inFlight).cursor, repair := none }

/-- After the rule's reconcile and the publish. -/
def afterFixed (inFlight : Bool) : HSt :=
  let c := moved (beforeRecon inFlight) (reconS (beforeRecon inFlight).s (theListing inFlight))
  moved c { c.s with cursor := (reconciled inFlight).cursor, repair := none }

theorem afterBuilt_reach (inFlight : Bool) : BReach (afterBuilt inFlight) := by
  have h := BReach.step (hreach_breach (beforeRecon_reach inFlight))
    (.reconcileHeld _ (theListing inFlight) rfl rfl)
  exact BReach.step h (.fixed _ _ (.core _ _ (.publish _ (reconciled inFlight) rfl rfl)))

theorem afterFixed_reach (inFlight : Bool) : HReach (afterFixed inFlight) := by
  have h := HReach.step (beforeRecon_reach inFlight) (.core _ _ (.reconcile _ (theListing inFlight) rfl rfl))
  exact HReach.step h (.core _ _ (.publish _ (reconciled inFlight) rfl rfl))

/-- The reviewer's held-stale.mjs, as built: after the repair whose barrier followed
    the peer's commit at 2, the held cell still serves the own bytes committed at 1. -/
theorem held_stale_after_repair :
    BReach (afterBuilt false) ∧ (afterBuilt false).heap 0 = true ∧
      (afterBuilt false).s.rows 0 = some ⟨1, .dated 1⟩ ∧ (0, 2) ∈ (afterBuilt false).s.muts ∧
      2 ≤ (afterBuilt false).s.H ∧ (afterBuilt false).s.repair.isNone = true := by
  refine ⟨afterBuilt_reach false, by decide, by decide, by decide, by decide, by decide⟩

/-- Under the rule the same trace drops the held cell: the sync read misses (and the
    path is refetched when there is room). -/
theorem the_fixed_repair_drops_the_held_cell :
    HReach (afterFixed false) ∧ (afterFixed false).s.rows 0 = none ∧ (afterFixed false).s.repair.isNone = true := by
  refine ⟨afterFixed_reach false, by decide, by decide⟩

/-- The write-back in flight across the repair, as built: the listing's report of the
    peer's commit never reaches it, and its acknowledgement stamps the held cell at 1,
    older than the peer's 2 that preceded the barrier. -/
theorem held_report_missed_across_repair :
    let a := afterBuilt true
    let b := moved a (landS a.s ⟨0, 0, some 1⟩ 1)
    BReach b ∧ a.s.reports 0 = 0 ∧ b.heap 0 = true ∧ b.s.rows 0 = some ⟨1, .dated 1⟩ ∧ (0, 2) ∈ b.s.muts ∧
      2 ≤ b.s.H := by
  intro a b
  refine ⟨BReach.step (afterBuilt_reach true) (.fixed _ _ (.core _ _ (.flushLand _ ⟨0, 0, some 1⟩ 1 (by decide) rfl))),
    by decide, by decide, by decide, by decide, by decide⟩

/-- Under the rule the listing's revision is noted as the own cell's report, and the
    acknowledgement then drops it instead of stamping. -/
theorem the_fixed_repair_reports_the_held_own_cell :
    let a := afterFixed true
    let b := moved a (landS a.s ⟨0, 0, some 1⟩ 1)
    HReach b ∧ a.s.reports 0 = 2 ∧ b.s.rows 0 = none := by
  intro a b
  refine ⟨HReach.step (afterFixed_reach true) (.core _ _ (.flushLand _ ⟨0, 0, some 1⟩ 1 (by decide) rfl)),
    by decide, by decide⟩

/-! ## The fixture's events

  Driven at the store's API: a peer write at the authority; an own write (`bundle[p]`,
  held when the store is full); its write-back committed and acknowledged; a barrier
  (`fsAcquire` from the store's cursor, admitted); a repair (churn trims the log, the
  barrier is poisoned, `__residentSynchronizeFromSupervisor`). Each is a sequence of
  the rule's moves, so every state a fixture shows is reachable (`exec_reach`). -/

def churnPath : Path := 9

inductive FEv where
  | peer (p : Path)
  | own (p : Path)
  | flush (p : Path)
  | barrier
  | repair
  deriving Repr

def xPeer (a : HSt) (p : Path) : HSt := moved a (commitMut a.s p (a.s.rev + 1))

def xOwn (full : Bool) (a : HSt) (p : Path) : HSt :=
  if full then ⟨ownWrite a.s p, upd a.heap p true⟩ else moved a (ownWrite a.s p)

def flushChain (a : HSt) (p w : Nat) : HSt :=
  let g : Flight := ⟨p, w, none⟩
  let a1 := moved a { a.s with flights := a.s.flights ++ [g] }
  let n := a1.s.rev + 1
  let a2 := moved a1 { commitMut a1.s g.path n with
    flights := a1.s.flights.map fun x => if x = g then { g with committed := some n } else x }
  moved a2 (landS a2.s { g with committed := some n } n)

def xFlush (a : HSt) (p : Path) : HSt :=
  match a.s.parked p with
  | none => a
  | some w => if a.s.flights.all (fun g => g.w != w) then flushChain a p w else a

def refillOne (L : Listing) (before : Path → Option Row) (a : HSt) (p : Path) : HSt :=
  match before p, a.s.rows p with
  | some ⟨_, .dated _⟩, none => moved a { a.s with rows := upd a.s.rows p (some ⟨last a.s p, .dated (L.listed p)⟩) }
  | _, _ => a

/-- A repair, once a poison started it: list at the authority's clock, reconcile,
    refetch what the reconcile dropped (only when the store has room), publish. -/
def repairAfter (full : Bool) (paths : List Path) (a : HSt) : HSt :=
  let L := listNow a.s
  let a1 := moved a { a.s with repair := some (some L) }
  let a2 := moved a1 (reconS a1.s L)
  let L' : Listing := { L with reconciled := true }
  let a3 := if full then a2 else paths.foldl (refillOne L' a1.s.rows) a2
  moved a3 { a3.s with cursor := L'.cursor, repair := none }

def reqQ (a : HSt) : Nat × Nat := (a.s.nextId, a.s.cursor)

def afterReq (a : HSt) : HSt :=
  moved a { a.s with requests := a.s.requests ++ [reqQ a], nextId := a.s.nextId + 1 }

def theAns (a : HSt) : Answer :=
  let a1 := afterReq a
  ⟨(reqQ a).1, (reqQ a).2, a1.s.rev, poisons a1.s (reqQ a).2, deltaFrom a1.s (reqQ a).2, false⟩

def afterServe (a : HSt) : HSt :=
  let a1 := afterReq a
  moved a1 { a1.s with requests := a1.s.requests.erase (reqQ a), answers := a1.s.answers ++ [theAns a] }

def xBarrier (full : Bool) (paths : List Path) (a : HSt) : HSt :=
  if a.s.repair.isNone then
    let a2 := afterServe a
    if (theAns a).poison then
      repairAfter full paths
        (moved a2 { a2.s with answers := a2.s.answers.erase (theAns a), fills := spoil a2.s.fills, repair := some none })
    else moved a2 (admitM a2.s (theAns a))
  else a

def xRepair (full : Bool) (paths : List Path) (a : HSt) : HSt :=
  let b := xPeer a churnPath
  xBarrier full paths (moved b { b.s with logFloor := max b.s.logFloor b.s.rev })

def exec (full : Bool) (paths : List Path) (a : HSt) : FEv → HSt
  | .peer p => xPeer a p
  | .own p => xOwn full a p
  | .flush p => xFlush a p
  | .barrier => xBarrier full paths a
  | .repair => xRepair full paths a

theorem reach_core {a : HSt} (h : HReach a) {s' : St} (hs : Step a.s s') : HReach (moved a s') :=
  .step h (.core _ _ hs)

theorem refillOne_reach (L : Listing) (hL : L.reconciled = true) (before : Path → Option Row) :
    ∀ (a : HSt) (p : Path), HReach a → a.s.repair = some (some L) →
      HReach (refillOne L before a p) ∧ (refillOne L before a p).s.repair = some (some L) := by
  intro a p h hr
  unfold refillOne
  split
  · rename_i hn
    exact ⟨reach_core h (.refill _ L p hr hL hn), hr⟩
  · exact ⟨h, hr⟩

theorem refills_reach (L : Listing) (hL : L.reconciled = true) (before : Path → Option Row) :
    ∀ (ps : List Path) (a : HSt), HReach a → a.s.repair = some (some L) →
      HReach (ps.foldl (refillOne L before) a) ∧ (ps.foldl (refillOne L before) a).s.repair = some (some L) := by
  intro ps
  induction ps with
  | nil => intro a h hr; exact ⟨h, hr⟩
  | cons p ps ih =>
    intro a h hr
    obtain ⟨h1, h2⟩ := refillOne_reach L hL before a p h hr
    exact ih _ h1 h2

theorem repairAfter_reach (full : Bool) (paths : List Path) {a : HSt} (h : HReach a) (hr : a.s.repair = some none) :
    HReach (repairAfter full paths a) := by
  have h1 := reach_core h (.list _ (fun p => last a.s p) hr (fun _ => Nat.le_refl _) (fun p => last_le _ p))
  have h2 := reach_core h1 (.reconcile _ (listNow a.s) rfl rfl)
  unfold repairAfter
  cases full
  · obtain ⟨h3, hr3⟩ := refills_reach { listNow a.s with reconciled := true } rfl _ paths _ h2 rfl
    exact reach_core h3 (.publish _ _ hr3 rfl)
  · exact reach_core h2 (.publish _ _ rfl rfl)

theorem xBarrier_reach (full : Bool) (paths : List Path) {a : HSt} (h : HReach a) : HReach (xBarrier full paths a) := by
  unfold xBarrier
  split
  · rename_i hn
    have hr : a.s.repair = none := Option.isNone_iff_eq_none.mp hn
    have h1 : HReach (afterReq a) := reach_core h (.request _)
    have h2 : HReach (afterServe a) :=
      reach_core h1 (.serve _ (reqQ a) (List.mem_append_right _ (List.mem_singleton.mpr rfl)))
    by_cases hp : (theAns a).poison = true
    · simp only [hp, if_true]
      exact repairAfter_reach full paths
        (reach_core h2 (.admitPoison _ (theAns a) (List.mem_append_right _ (List.mem_singleton.mpr rfl)) hp hr)) rfl
    · have hp' : (theAns a).poison = false := by simpa using hp
      simp only [hp', Bool.false_eq_true, if_false]
      exact reach_core h2 (.admitMono _ (theAns a) (List.mem_append_right _ (List.mem_singleton.mpr rfl))
        hp' (Nat.le_refl _) hr)
  · exact h

theorem xFlush_reach {a : HSt} (h : HReach a) (p : Path) : HReach (xFlush a p) := by
  unfold xFlush
  split
  · exact h
  · rename_i w hw
    split
    · rename_i hall
      have hne : ∀ g ∈ a.s.flights, g.w ≠ w := fun g hg => by
        have := List.all_eq_true.mp hall g hg
        simpa using this
      have h1 := reach_core h (.flushSend _ p w hw hne)
      have hg : (⟨p, w, none⟩ : Flight) ∈ a.s.flights ++ [⟨p, w, none⟩] := List.mem_append_right _ (List.mem_singleton.mpr rfl)
      have h2 := reach_core h1 (.flushCommit _ ⟨p, w, none⟩ _ hg rfl (Nat.lt_succ_self _))
      exact reach_core h2 (.flushLand _ _ _ (List.mem_map.mpr ⟨_, hg, if_pos rfl⟩) rfl)
    · exact h

theorem exec_reach (full : Bool) (paths : List Path) {a : HSt} (h : HReach a) (e : FEv) :
    HReach (exec full paths a e) := by
  cases e with
  | peer p => exact reach_core h (.peerWrite _ p _ (Nat.lt_succ_self _))
  | own p =>
    show HReach (xOwn full a p)
    cases full
    · exact reach_core h (.writeSync _ p)
    · exact .step h (.hold _ p)
  | flush p => exact xFlush_reach h p
  | barrier => exact xBarrier_reach full paths h
  | repair =>
    have h1 := reach_core h (.peerWrite _ churnPath _ (Nat.lt_succ_self _))
    exact xBarrier_reach full paths (reach_core h1 (.trim _ _ (Nat.le_refl _)))

/-- Every state a fixture run shows is reachable by the rule's moves, so its dated
    cells are never older than a peer write before the barrier. -/
theorem run_reach (full : Bool) (paths : List Path) :
    ∀ (es : List FEv) (a : HSt), HReach a → HReach (es.foldl (exec full paths) a) := by
  intro es
  induction es with
  | nil => intro a h; exact h
  | cons e es ih => intro a h; exact ih _ (exec_reach full paths h e)

end Nimbus.Coherence.Store
