/-
  Nimbus.Coherence.Store — the resident-store coherence protocol of a node
  facet (integrate/0924): `_acquireBarrier` admitting deltas and poisons,
  `_runResidentRepair` against an `fsList` listing, read-through fills with
  their tickets (`_beginFill`, `_noteFillReport`, `_spoilFills`,
  `_installResident`/`__residentFill`), and the facet's own writes
  (`__vfsWrites`, the flush RPC, `__nimbusNoteVfsReport`,
  `__nimbusStampFlushedCell`).

  Every constructor of `Step` is one atomic event: an authority commit, an RPC
  served at the authority, or one synchronous block of the facet. They
  interleave freely, so RPC answers arrive in any order and any time after they
  were served.

  A value is identified by the revision of the commit that produced it (0 is
  the initial contents). `muts` is every commit ever made (ghost; the real log
  keeps only entries above `logFloor`). `H` is ghost: the newest authority
  revision any admitted answer (delta or repair listing) was served at. A
  resumption runs user code after its barrier's answer was admitted, so its
  answer is at most `H`.

  THE PROPERTY (`row_fresh`): every row the facet holds dated (not its own
  unacknowledged bytes) carries a value the authority held at some instant at
  or after `H`, hence at or after the barrier of every resumption that can run.

  Abstractions: one facet (a peer is the authority's own commits); whole-file
  writes (the ranged own-mutation lease is not modeled); one supervisor
  incarnation (a new epoch is a poison, which is modeled); `fsList` reports a
  revision at or above each path's last commit, which
  `Nimbus.Vfs.RevisionFloor.revision_ge_last` proves of the code; a refill
  during repair is one read served and installed before the listing's cursor
  is published (no delta can be admitted while a repair runs, as the code
  guarantees by joining).
-/

namespace Nimbus.Coherence.Store

abbrev Path := Nat

inductive Stamp where
  | dated (r : Nat)
  | own
  deriving DecidableEq, Repr

structure Row where
  val : Nat
  stamp : Stamp
  deriving DecidableEq, Repr

/-- A read in flight and its ticket: the cursor it was issued under, the
    newest revision any barrier reported for its path since, a poison having
    spoiled it, and (once the authority answered) the value it read. -/
structure Fill where
  id : Nat
  path : Path
  rev : Nat
  reported : Nat
  spoiled : Bool
  served : Option Nat
  deriving DecidableEq, Repr

/-- An ACQUIRE the authority answered: the cursor it was asked from, the
    revision it answered at, and either a poison or, per path, the newest
    revision committed in between. -/
structure Answer where
  id : Nat
  base : Nat
  rev : Nat
  poison : Bool
  delta : List (Path × Nat)
  /-- Delivered with a routed request: asked from the supervisor's own cursor. -/
  routed : Bool
  deriving DecidableEq, Repr

/-- A flush of one parked write: its write id, and the revision the authority
    committed it at once it has. -/
structure Flight where
  path : Path
  w : Nat
  committed : Option Nat
  deriving DecidableEq, Repr

/-- A repair's listing, once the authority served it, and whether the facet has
    reconciled its rows against it yet. -/
structure Listing where
  cursor : Nat
  listed : Path → Nat
  reconciled : Bool

structure St where
  -- the authority
  rev : Nat
  muts : List (Path × Nat)
  logFloor : Nat
  -- the facet
  cursor : Nat
  rows : Path → Option Row
  fills : List Fill
  requests : List (Nat × Nat)
  answers : List Answer
  /-- `none`: no repair; `some none`: a repair waiting for its listing. -/
  repair : Option (Option Listing)
  parked : Path → Option Nat
  flights : List Flight
  reports : Path → Nat
  nextId : Nat
  -- ghost
  H : Nat

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β :=
  fun y => if y = x then b else f y

/-! ## The authority's history -/

/-- The newest commit of `p` at or before `t` (0: the initial contents). -/
def valAt (muts : List (Path × Nat)) (p : Path) (t : Nat) : Nat :=
  muts.foldl (fun m x => if x.1 = p ∧ x.2 ≤ t ∧ m < x.2 then x.2 else m) 0

def last (s : St) (p : Path) : Nat := valAt s.muts p s.rev

/-- No commit of `p` in `(a, b]`. -/
def NoMut (muts : List (Path × Nat)) (p : Path) (a b : Nat) : Prop :=
  ∀ x ∈ muts, x.1 = p → ¬ (a < x.2 ∧ x.2 ≤ b)

/-- The invalidation log as the authority still holds it: every entry above
    `logFloor`, the newest revision it dropped (the clock at open counts as
    dropped). -/
def retained (s : St) : List (Path × Nat) := s.muts.filter fun x => s.logFloor < x.2

/-- ACQUIRE's poison rule: a cursor below the floor cannot be answered by a
    delta. -/
def poisons (s : St) (c : Nat) : Bool := decide (c < s.logFloor)

/-- The delta an ACQUIRE from `c` answered at `s.rev` carries, read from the
    retained log: every path committed in `(c, rev]` at its newest revision
    (`invalidatedSince`). -/
def deltaFrom (s : St) (c : Nat) : List (Path × Nat) :=
  (((retained s).filter fun x => c < x.2).map (·.1)).foldl
    (fun acc p => if acc.any (·.1 == p) then acc else acc ++ [(p, last s p)]) []

/-- A commit at revision `n`: `vfs_state.gen`, so revisions jump, never repeat. -/
def commitMut (s : St) (p : Path) (n : Nat) : St :=
  { s with rev := n, muts := s.muts ++ [(p, n)] }

/-- The newest revision a delta reports for `p` (0 when it does not name it). -/
def repOf (d : List (Path × Nat)) (p : Path) : Nat :=
  d.foldl (fun m x => if x.1 = p then max m x.2 else m) 0

/-- Admitting a delta (`_acquireBarrier` then `__residentAdmit`): each reported
    path is noted on the reads in flight for it and on its parked write, and a
    dated row older than the report is dropped. The code walks the entries one
    at a time; the effect does not depend on their order. -/
def admit (s : St) (a : Answer) : St :=
  { s with
    fills := s.fills.map fun f => { f with reported := max f.reported (repOf a.delta f.path) }
    reports := fun p => if s.parked p ≠ none then max (s.reports p) (repOf a.delta p) else s.reports p
    rows := fun p => match s.rows p with
      | some ⟨v, .dated r⟩ => if r < repOf a.delta p then none else some ⟨v, .dated r⟩
      | o => o
    answers := s.answers.erase a
    cursor := a.rev
    H := max s.H a.rev }

/-- 4c8871bb: entries above the cursor only; the cursor never moves back. -/
def admitM (s : St) (a : Answer) : St :=
  let t := admit s { a with delta := a.delta.filter fun x => s.cursor < x.2 }
  { t with answers := s.answers.erase a, cursor := max s.cursor a.rev }

/-- NodeNoMirror's pushed content: a delta carries, for a path under the push
    roots and within the answer's byte budget (`push`), its bytes at the
    answer's revision; they are installed stamped at the path's reported
    revision unless the facet holds its own bytes or a row dated at or after it. -/
def acceptsPush : Option Row → Nat → Bool
  | some ⟨_, .own⟩, _ => false
  | some ⟨_, .dated r⟩, e => decide (r < e)
  | none, _ => true

def pushRows (t : St) (d : List (Path × Nat)) (push : Path → Bool) : St :=
  { t with rows := fun p =>
      if push p = true ∧ 0 < repOf d p ∧ t.parked p = none ∧ acceptsPush (t.rows p) (repOf d p) = true
      then some ⟨repOf d p, .dated (repOf d p)⟩ else t.rows p }

/-- `__residentFill` declines over own bytes or a row dated later than the read. -/
def accepts : Option Row → Nat → Bool
  | some ⟨_, .own⟩, _ => false
  | some ⟨_, .dated r⟩, rev => decide (r ≤ rev)
  | none, _ => true

def spoil (fs : List Fill) : List Fill := fs.map fun f => { f with spoiled := true }

inductive Step : St → St → Prop
  /-- Another process commits `p`. -/
  | peerWrite (s : St) (p : Path) (n : Nat) : s.rev < n → Step s (commitMut s p n)
  /-- Write churn trims the invalidation log. -/
  | trim (s : St) (f : Nat) : f ≤ s.rev → Step s { s with logFloor := max s.logFloor f }
  /-- A barrier sends `fsAcquire(cursor)`. -/
  | request (s : St) : Step s { s with requests := s.requests ++ [(s.nextId, s.cursor)], nextId := s.nextId + 1 }
  /-- The authority answers it: a poison when the log no longer reaches back
      to its cursor, else the delta. -/
  | serve (s : St) (q : Nat × Nat) : q ∈ s.requests →
      Step s { s with
        requests := s.requests.erase q
        answers := s.answers ++ [⟨q.1, q.2, s.rev, poisons s q.2, deltaFrom s q.2, false⟩] }
  /-- A routed request reaches the facet carrying the answer to "nothing since
      the supervisor's own cursor" (4c8871bb). -/
  | route (s : St) :
      Step s { s with
        answers := s.answers ++ [⟨s.nextId, s.rev, s.rev, poisons s s.rev, deltaFrom s s.rev, true⟩]
        nextId := s.nextId + 1 }
  /-- The answer lands and is admitted (no repair is running: a barrier
      answered during one joins it and asks again). -/
  | admitDelta (s : St) (a : Answer) : a ∈ s.answers → a.poison = false → a.routed = false →
      s.repair = none → Step s (admit s a)
  /-- 4c8871bb's admission, for fetched and delivered answers alike: only an
      answer from a base the facet has reached, only its entries above the
      cursor, and the cursor never moves back. -/
  | admitMono (s : St) (a : Answer) : a ∈ s.answers → a.poison = false → a.base ≤ s.cursor →
      s.repair = none → Step s (admitM s a)
  /-- NodeNoMirror: an answer admitted as `admitMono` also installs the bytes it
      pushed. (While only this admission is in use the cursor is the horizon.) -/
  | admitPush (s : St) (a : Answer) (push : Path → Bool) : a ∈ s.answers → a.poison = false →
      a.base ≤ s.cursor → s.repair = none → s.cursor = s.H →
      Step s (pushRows (admitM s a) (a.delta.filter fun x => s.cursor < x.2) push)
  /-- A poison lands: every read in flight is spoiled and the single-flight
      repair starts. -/
  | admitPoison (s : St) (a : Answer) : a ∈ s.answers → a.poison = true → s.repair = none →
      Step s { s with answers := s.answers.erase a, fills := spoil s.fills, repair := some none }
  /-- A barrier that joins a running repair drops its answer and asks again. -/
  | join (s : St) (a : Answer) : a ∈ s.answers → s.repair ≠ none →
      Step s { s with answers := s.answers.erase a }
  /-- The repair's `fsList`: the cursor read before the walk, and every path at
      a revision no older than its last commit. -/
  | list (s : St) (listed : Path → Nat) : s.repair = some none → (∀ p, last s p ≤ listed p) →
      (∀ p, listed p ≤ s.rev) →
      Step s { s with repair := some (some ⟨s.rev, listed, false⟩) }
  /-- The listing is applied: a dated row older than its listed revision is
      dropped; an own row is kept and its listed revision noted as a report.
      (`H` moves here: from now on the rows describe the listing's cursor.) -/
  | reconcile (s : St) (L : Listing) : s.repair = some (some L) → L.reconciled = false →
      Step s { s with
        repair := some (some { L with reconciled := true })
        H := max s.H L.cursor
        rows := fun p => match s.rows p with
          | some ⟨v, .dated r⟩ => if r < L.listed p then none else some ⟨v, .dated r⟩
          | o => o
        reports := fun p => if s.parked p ≠ none ∧ s.reports p < L.listed p then L.listed p else s.reports p }
  /-- A refill of a missing path during the repair, dated at its listed
      revision (`__residentFetchFiles`). -/
  | refill (s : St) (L : Listing) (p : Path) : s.repair = some (some L) → L.reconciled = true →
      s.rows p = none →
      Step s { s with rows := upd s.rows p (some ⟨last s p, .dated (L.listed p)⟩) }
  /-- The repair publishes the listing's cursor. -/
  | publish (s : St) (L : Listing) : s.repair = some (some L) → L.reconciled = true →
      Step s { s with cursor := L.cursor, repair := none }
  /-- A live read is issued behind a completed barrier (so never during a repair). -/
  | issueFill (s : St) (p : Path) : s.repair = none →
      Step s { s with fills := s.fills ++ [⟨s.nextId, p, s.cursor, 0, false, none⟩], nextId := s.nextId + 1 }
  /-- The authority serves it. -/
  | serveFill (s : St) (f : Fill) : f ∈ s.fills → f.served = none →
      Step s { s with fills := s.fills.map fun g => if g = f then { f with served := some (last s f.path) } else g }
  /-- Its bytes land: installed dated at the read's cursor unless a report or a
      poison outdated the ticket, the facet holds its own bytes there, or a row
      dated later (`_installResident`, `__residentFill`). -/
  | landFill (s : St) (f : Fill) (v : Nat) : f ∈ s.fills → f.served = some v →
      Step s { s with
        fills := s.fills.erase f
        rows := if f.spoiled = false ∧ f.reported ≤ f.rev ∧ s.parked f.path = none ∧
            accepts (s.rows f.path) f.rev = true
          then upd s.rows f.path (some ⟨v, .dated f.rev⟩) else s.rows }
  /-- `writeFileSync`: the bytes are parked and held as own. -/
  | writeSync (s : St) (p : Path) :
      Step s { s with
        rows := upd s.rows p (some ⟨s.nextId, .own⟩)
        parked := upd s.parked p (some s.nextId)
        nextId := s.nextId + 1 }
  /-- The write-back sends the parked bytes. -/
  | flushSend (s : St) (p : Path) (w : Nat) : s.parked p = some w → (∀ g ∈ s.flights, g.w ≠ w) →
      Step s { s with flights := s.flights ++ [⟨p, w, none⟩] }
  /-- The authority commits them. -/
  | flushCommit (s : St) (g : Flight) (n : Nat) : g ∈ s.flights → g.committed = none → s.rev < n →
      Step s { commitMut s g.path n with
        flights := s.flights.map fun x => if x = g then { g with committed := some n } else x }
  /-- The write's response lands. If no newer write was parked meanwhile it
      retires the parked bytes and dates its row at its own revision — unless
      a barrier reported the path above that revision while it was in flight,
      in which case a peer wrote after it and the row goes (`__nimbusStampFlushedCell`). -/
  | flushLand (s : St) (g : Flight) (r : Nat) : g ∈ s.flights → g.committed = some r →
      Step s (if s.parked g.path = some g.w then
        { s with
          flights := s.flights.erase g
          parked := upd s.parked g.path none
          reports := upd s.reports g.path 0
          rows := if r < s.reports g.path then upd s.rows g.path none
            else match s.rows g.path with
              | some ⟨_, .own⟩ => upd s.rows g.path (some ⟨r, .dated r⟩)
              | o => upd s.rows g.path o }
        else { s with flights := s.flights.erase g })

def init : St :=
  { rev := 0, muts := [], logFloor := 0, cursor := 0, rows := fun _ => none, fills := [],
    requests := [], answers := [], repair := none, parked := fun _ => none, flights := [],
    reports := fun _ => 0, nextId := 0, H := 0 }

inductive Reachable : St → Prop
  | init : Reachable init
  | step {s s' : St} : Reachable s → Step s s' → Reachable s'

end Nimbus.Coherence.Store
