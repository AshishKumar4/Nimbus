/-
  Nimbus.ContentStore.Model — the content-addressed VFS store of schema v2
  (SPEC.md §4–§5 as built, BUILD-RULES.md R1–R9): chunk dedup, contents
  (manifests) with staging/live/dying states, generations, history rows,
  snapshots, the restore job, the drop job, the reference-probed GC with its
  same-transaction queue, detached-descriptor pins, and a DO reset.

  Every `Step` constructor is ONE transaction, so an invariant of every
  reachable state is an invariant at every transaction boundary, and `reset`
  (a DO reset: every in-memory structure gone, then `open`) may follow any of
  them. A multi-transaction operation is a sequence of steps: a large write is
  `beginLarge`, `appendLarge`*, `publish*`; content GC is `gcContentStart`,
  `gcContentPage`*, `gcContentFinish`; restore is `restoreStart`,
  `restoreStep`*, `restoreFinish`; a snapshot drop is `dropSnapshot` then
  `dropHist`*.

  Abstractions (see `lean/README.md`): a file is its list of chunk hashes; one
  hash is one chunk (the real FastCDC cuts are not modeled; `Nimbus.Vfs.FastCdc`
  covers them). Hashes are collision-free. A page of the real code is several
  of these steps with nothing between them, which is a subset of the behaviors
  modeled here. Directories, modes, inos and `copyTree` are absent: copyTree is
  pages of `copy`. Only DETACHED descriptors pin (R5/R8: an attached
  descriptor reads through its path). Descriptor writes (R8) are not modeled.

  Ghost state: `view` (what each path must read), `snapView` (what each
  snapshot must read), `Fd.view`, `Writer.hashes`. The deployed store has none
  of it; it exists to state the theorems.
-/

namespace Nimbus.ContentStore

abbrev Path := Nat
abbrev Hash := Nat

/-- What an inode or history row points at: one chunk (a file ≤ 64 KiB) or a
    content (a manifest of chunks). Also a GC queue entry (kind 0 / kind 1). -/
inductive Ref where
  | chunk (k : Nat)
  | content (c : Nat)
  deriving DecidableEq, Repr

structure Row where
  gen : Nat
  ref : Ref
  deriving DecidableEq, Repr

/-- A history row: `path` read `ref` for generations `genFrom ≤ g < genTo`. -/
structure HRow where
  path : Path
  genFrom : Nat
  genTo : Nat
  ref : Ref
  deriving DecidableEq, Repr

/-- `vfs_contents.state`: 0 staging, 1 live, 2 dying (R4, absorbing). -/
inductive CState where
  | staging
  | live
  | dying
  deriving DecidableEq, Repr

structure Content where
  chunks : List Nat
  state : CState
  digest : Option (List Hash)
  deriving DecidableEq, Repr

/-- An in-flight multi-transaction large write (in memory; gone at a reset). -/
structure Writer where
  path : Path
  content : Nat
  /-- Ghost: the hashes appended so far. -/
  hashes : List Hash
  deriving DecidableEq, Repr

/-- A detached descriptor: unlinked but open, pinning what it read. -/
structure Fd where
  ref : Ref
  /-- Ghost: the bytes it must keep reading. -/
  view : List Hash
  deriving DecidableEq, Repr

/-- The durable restore job row (`vfs_jobs`). `clean` is ghost: no other write
    has landed since the job began. -/
structure Job where
  name : Nat
  g : Nat
  cursor : Nat
  clean : Bool
  deriving DecidableEq, Repr

structure St where
  gen : Nat
  live : Path → Option Row
  hist : List HRow
  /-- `(name, gen)` per snapshot. -/
  snaps : List (Nat × Nat)
  chunks : Nat → Option Hash
  contents : Nat → Option Content
  queue : List Ref
  nextChunk : Nat
  nextContent : Nat
  job : Option Job
  -- in memory
  writers : List Writer
  fds : List Fd
  -- ghost
  view : Path → Option (List Hash)
  snapView : Nat → Path → Option (List Hash)

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β :=
  fun y => if y = x then b else f y

/-- `pin_gen = MAX(vfs_snapshots.gen)`, 0 with no snapshot (R9). -/
def pinGen (s : St) : Nat := s.snaps.foldr (fun x m => max x.2 m) 0

/-- `INSERT … ON CONFLICT DO NOTHING` into `vfs_gc_queue`. -/
def enq (q : List Ref) (x : Ref) : List Ref := if x ∈ q then q else q ++ [x]

/-! ## Reading -/

/-- The bytes a reference reads. A content reads only while live. -/
def resolve (s : St) : Ref → Option (List Hash)
  | .chunk k => (s.chunks k).map fun h => [h]
  | .content c =>
    match s.contents c with
    | some ct => if ct.state = .live then ct.chunks.mapM s.chunks else none
    | none => none

/-- A row that may be absent: `some none` is "no such file", `none` is "the
    store cannot produce the bytes" (a collected chunk). -/
def readRef (s : St) : Option Ref → Option (Option (List Hash))
  | none => some none
  | some r => (resolve s r).map some

def covers (g : Nat) (p : Path) (h : HRow) : Bool :=
  h.path == p && decide (h.genFrom ≤ g) && decide (g < h.genTo)

/-- `at(g)`: the history row covering `g`, else the live row if written at or
    before `g` (SPEC §4.4). -/
def atRef (s : St) (g : Nat) (p : Path) : Option Ref :=
  match s.hist.find? (covers g p) with
  | some h => some h.ref
  | none =>
    match s.live p with
    | some r => if r.gen ≤ g then some r.ref else none
    | none => none

/-! ## References (what the GC probes) -/

def LiveRef (s : St) (x : Ref) : Prop := ∃ p r, s.live p = some r ∧ r.ref = x
def HistRef (s : St) (x : Ref) : Prop := ∃ h ∈ s.hist, h.ref = x
def ManRef (s : St) : Ref → Prop
  | .chunk k => ∃ c ct, s.contents c = some ct ∧ k ∈ ct.chunks
  | .content _ => False
def FdRef (s : St) (x : Ref) : Prop := ∃ f ∈ s.fds, f.ref = x
def WriterHeld (s : St) : Ref → Prop
  | .chunk _ => False
  | .content c => ∃ w ∈ s.writers, w.content = c

/-- The durable references the probe-guarded DELETE checks (R3, R4). -/
def StrongRef (s : St) (x : Ref) : Prop := LiveRef s x ∨ HistRef s x ∨ ManRef s x

def Exists (s : St) : Ref → Prop
  | .chunk k => s.chunks k ≠ none
  | .content c => s.contents c ≠ none

/-! ## Transactions -/

/-- R1: the chunk for `h` is an existing one (dedup hit) or the next fresh id. -/
def InternOk (s : St) (h k : Nat) : Prop := s.chunks k = some h ∨ k = s.nextChunk

def intern (s : St) (h k : Nat) : St :=
  if s.chunks k = some h then s
  else { s with chunks := upd s.chunks k (some h), nextChunk := k + 1 }

/-- One inode write in a transaction of its own (SPEC §4.2, R2): a new
    generation; a history row when a snapshot can see the old row; the old
    reference queued unless it is the new one. -/
def commit (s : St) (p : Path) (nr : Option Ref) : St :=
  let G := s.gen + 1
  { s with
    gen := G
    hist := match s.live p with
      | some r => if r.gen ≤ pinGen s then s.hist ++ [⟨p, r.gen, G, r.ref⟩] else s.hist
      | none => s.hist
    queue := match s.live p with
      | some r => if nr = some r.ref then s.queue else enq s.queue r.ref
      | none => s.queue
    live := upd s.live p (nr.map fun ref => ⟨G, ref⟩) }

/-- rename's phase-2 retirement: the same row write, queueing nothing (R2). -/
def retire (s : St) (p : Path) : St :=
  { commit s p none with queue := s.queue }

/-- A user write lands: a running restore job is no longer clean (ghost). -/
def dirty (s : St) : St := { s with job := s.job.map fun j => { j with clean := false } }

def setView (s : St) (p : Path) (v : Option (List Hash)) : St := { s with view := upd s.view p v }

def stagingIds (s : St) : List Nat :=
  (List.range s.nextContent).filter fun c =>
    match s.contents c with
    | some ct => ct.state = .staging
    | none => false

def updContent (s : St) (c : Nat) (ct : Option Content) : St := { s with contents := upd s.contents c ct }

def replaceWriter (ws : List Writer) (w w' : Writer) : List Writer :=
  ws.map fun x => if x = w then w' else x

-- `P`: the fixed number of paths the restore job walks (`restoreStep` visits
-- `0 … P-1`); every write names a path below it.
variable (P : Nat)

inductive Step : St → St → Prop
  /-- writeFile ≤ 64 KiB (R1, R2). -/
  | writeSmall (s : St) (p h k : Nat) :
      p < P → InternOk s h k →
      Step s (setView (dirty (commit (intern s h k) p (some (.chunk k)))) p (some [h]))
  /-- T1 of a multi-transaction large write: a state-0 content (R7). -/
  | beginLarge (s : St) (p : Path) :
      p < P →
      Step s { updContent s s.nextContent (some ⟨[], .staging, none⟩) with
        nextContent := s.nextContent + 1
        writers := s.writers ++ [⟨p, s.nextContent, []⟩] }
  /-- T2..Tk: one chunk and its manifest row, in the same transaction (R1). -/
  | appendLarge (s : St) (w : Writer) (ct : Content) (h k : Nat) :
      w ∈ s.writers → s.contents w.content = some ct → ct.state = .staging →
      InternOk s h k →
      Step s { updContent (intern s h k) w.content (some { ct with chunks := ct.chunks ++ [k] }) with
        writers := replaceWriter s.writers w { w with hashes := w.hashes ++ [h] } }
  /-- Tn: publish, no digest hit — the content goes live under its digest. -/
  | publishNew (s : St) (w : Writer) (ct : Content) :
      w ∈ s.writers → s.contents w.content = some ct → ct.state = .staging →
      Step s (setView (dirty (commit
        { updContent s w.content (some { ct with state := .live, digest := some w.hashes }) with
          writers := s.writers.erase w } w.path (some (.content w.content)))) w.path (some w.hashes))
  /-- Tn: publish onto an existing content with the same digest; the staging
      content is queued (R2, R7). -/
  | publishDedup (s : St) (w : Writer) (ct : Content) (c2 : Nat) (ct2 : Content) :
      w ∈ s.writers → s.contents w.content = some ct → ct.state = .staging →
      s.contents c2 = some ct2 → ct2.state = .live → ct2.digest = some w.hashes →
      Step s (setView (dirty (commit
        { s with writers := s.writers.erase w, queue := enq s.queue (.content w.content) }
        w.path (some (.content c2)))) w.path (some w.hashes))
  | delete (s : St) (p : Path) :
      p < P →
      Step s (setView (dirty (commit s p none)) p none)
  /-- copyFile: the destination shares the source's reference (SPEC §4.3). -/
  | copy (s : St) (src dst : Path) (r : Row) :
      dst < P → s.live src = some r →
      Step s (setView (dirty (commit s dst (some r.ref))) dst (s.view src))
  /-- rename: publish at the destination, then retire the source without
      queueing (R2). Both phases run in one JS turn; a reset between them
      leaves the state `copy` leaves. -/
  | rename (s : St) (src dst : Path) (r : Row) :
      dst < P → src ≠ dst → s.live src = some r →
      Step s (setView (setView (dirty (retire (commit s dst (some r.ref)) src)) dst (s.view src)) src none)
  /-- R5 in place: `UPDATE vfs_chunks` of a chunk nothing else can see. -/
  | editSmallInPlace (s : St) (p : Path) (r : Row) (k h : Nat) :
      s.live p = some r → r.ref = .chunk k → pinGen s < r.gen →
      (∀ q r', q ≠ p → s.live q = some r' → r'.ref ≠ .chunk k) →
      ¬ ManRef s (.chunk k) → ¬ HistRef s (.chunk k) → ¬ FdRef s (.chunk k) →
      (∀ k', s.chunks k' ≠ some h) →
      Step s (setView (dirty (commit { s with chunks := upd s.chunks k (some h) } p (some (.chunk k))))
        p (some [h]))
  /-- R5 otherwise: a new (or deduplicated) chunk; the old one is queued. -/
  | editSmallCow (s : St) (p : Path) (r : Row) (k0 h k : Nat) :
      s.live p = some r → r.ref = .chunk k0 → InternOk s h k →
      Step s (setView (dirty (commit (intern s h k) p (some (.chunk k)))) p (some [h]))
  /-- R6 unshared: replace manifest row `i` in place, digest NULL, queue the
      removed chunk. -/
  | editLargeInPlace (s : St) (p : Path) (r : Row) (c : Nat) (ct : Content) (i h k : Nat) :
      s.live p = some r → r.ref = .content c → pinGen s < r.gen →
      s.contents c = some ct → ct.state = .live → i < ct.chunks.length →
      (∀ q r', q ≠ p → s.live q = some r' → r'.ref ≠ .content c) →
      ¬ HistRef s (.content c) → ¬ FdRef s (.content c) → InternOk s h k →
      Step s (setView (dirty (commit
        { updContent (intern s h k) c (some { ct with chunks := ct.chunks.set i k, digest := none }) with
          queue := enq s.queue (.chunk (ct.chunks.getD i 0)) }
        p (some (.content c)))) p ((s.view p).map fun v => v.set i h))
  /-- R6 shared: a new content (copy of the manifest with row `i` replaced),
      published; the old content is queued. The real copy is paged through a
      staging content, which is `beginLarge`'s mechanism. -/
  | editLargeCow (s : St) (p : Path) (r : Row) (c : Nat) (ct : Content) (i h k : Nat) :
      s.live p = some r → r.ref = .content c → s.contents c = some ct → ct.state = .live →
      i < ct.chunks.length → InternOk s h k →
      Step s (setView (dirty (commit
        { updContent (intern s h k) (intern s h k).nextContent
            (some ⟨ct.chunks.set i k, .live, none⟩) with
          nextContent := (intern s h k).nextContent + 1 }
        p (some (.content (intern s h k).nextContent)))) p ((s.view p).map fun v => v.set i h))
  /-- The lazy digest (answer 6): memoized only when no content holds it. -/
  | memoDigest (s : St) (c : Nat) (ct : Content) (d : List Hash) :
      s.contents c = some ct → ct.state = .live → ct.digest = none → ct.chunks.mapM s.chunks = some d →
      (∀ c' ct', s.contents c' = some ct' → ct'.digest ≠ some d) →
      Step s (updContent s c (some { ct with digest := some d }))
  | snapshot (s : St) (n : Nat) :
      (∀ x ∈ s.snaps, x.1 ≠ n) →
      Step s { s with snaps := s.snaps ++ [(n, s.gen)], snapView := upd s.snapView n s.view }
  /-- One transaction: the row goes, `pin_gen` is recomputed (by `pinGen`).
      Refused while a job reads the snapshot (answer 5). -/
  | dropSnapshot (s : St) (n : Nat) :
      (∀ j, s.job = some j → j.name ≠ n) →
      Step s { s with snaps := s.snaps.filter fun x => x.1 ≠ n }
  /-- The drop job: a history row no snapshot can see goes, its reference queued. -/
  | dropHist (s : St) (h : HRow) :
      h ∈ s.hist → (∀ x ∈ s.snaps, ¬ (h.genFrom ≤ x.2 ∧ x.2 < h.genTo)) →
      Step s { s with hist := s.hist.erase h, queue := enq s.queue h.ref }
  | restoreStart (s : St) (n g : Nat) :
      s.job = none → (n, g) ∈ s.snaps →
      Step s { s with job := some ⟨n, g, 0, true⟩ }
  /-- One restored path (a page is several). A row the snapshot already sees
      (gen ≤ g) is left alone; any other is replaced by what the snapshot reads. -/
  | restoreSkip (s : St) (j : Job) (r : Row) :
      s.job = some j → j.cursor < P → s.live j.cursor = some r → r.gen ≤ j.g →
      Step s { s with job := some { j with cursor := j.cursor + 1 } }
  | restoreStep (s : St) (j : Job) :
      s.job = some j → j.cursor < P → (∀ r, s.live j.cursor = some r → j.g < r.gen) →
      Step s { setView (commit s j.cursor (atRef s j.g j.cursor)) j.cursor (s.snapView j.name j.cursor) with
        job := some { j with cursor := j.cursor + 1 } }
  | restoreFinish (s : St) (j : Job) :
      s.job = some j → j.cursor = P →
      Step s { s with job := none }
  /-- open then unlink: the descriptor pins what the path read (R8). -/
  | detach (s : St) (p : Path) (r : Row) :
      p < P → s.live p = some r →
      Step s { setView (dirty (commit s p none)) p none with
        fds := s.fds ++ [⟨r.ref, (s.view p).getD []⟩] }
  | close (s : St) (f : Fd) :
      f ∈ s.fds →
      Step s { s with fds := s.fds.erase f }
  /-- R3: an unreferenced, unpinned chunk is deleted with its queue row. -/
  | gcChunkDelete (s : St) (k : Nat) :
      .chunk k ∈ s.queue → s.chunks k ≠ none → ¬ StrongRef s (.chunk k) → ¬ FdRef s (.chunk k) →
      Step s { s with chunks := upd s.chunks k none, queue := s.queue.erase (.chunk k) }
  /-- R3: a referenced (or absent) chunk leaves the queue; a pinned one stays. -/
  | gcChunkSkip (s : St) (k : Nat) :
      .chunk k ∈ s.queue → (s.chunks k = none ∨ StrongRef s (.chunk k)) →
      Step s { s with queue := s.queue.erase (.chunk k) }
  /-- R4 first page: no inode, history, descriptor or writer holds it; it dies. -/
  | gcContentStart (s : St) (c : Nat) (ct : Content) :
      .content c ∈ s.queue → s.contents c = some ct → ct.state ≠ .dying →
      ¬ StrongRef s (.content c) → ¬ FdRef s (.content c) → ¬ WriterHeld s (.content c) →
      Step s (updContent s c (some { ct with state := .dying, digest := none }))
  /-- R4 later pages: a manifest row goes, its chunk queued. -/
  | gcContentPage (s : St) (c : Nat) (ct : Content) (k : Nat) (rest : List Nat) :
      .content c ∈ s.queue → s.contents c = some ct → ct.state = .dying → ct.chunks = k :: rest →
      Step s { updContent s c (some { ct with chunks := rest }) with queue := enq s.queue (.chunk k) }
  /-- R4 last page: the empty dying content goes with its queue row. -/
  | gcContentFinish (s : St) (c : Nat) (ct : Content) :
      .content c ∈ s.queue → s.contents c = some ct → ct.state = .dying → ct.chunks = [] →
      Step s { updContent s c none with queue := s.queue.erase (.content c) }
  | gcContentSkip (s : St) (c : Nat) :
      .content c ∈ s.queue →
      (s.contents c = none ∨ (StrongRef s (.content c) ∧ ∀ ct, s.contents c = some ct → ct.state ≠ .dying)) →
      Step s { s with queue := s.queue.erase (.content c) }
  /-- A DO reset, then open: memory is gone and every state-0 content is queued. -/
  | reset (s : St) :
      Step s { s with writers := [], fds := [], queue := (stagingIds s).foldl (fun q c => enq q (.content c)) s.queue }

def init : St :=
  { gen := 0, live := fun _ => none, hist := [], snaps := [], chunks := fun _ => none,
    contents := fun _ => none, queue := [], nextChunk := 0, nextContent := 0, job := none,
    writers := [], fds := [], view := fun _ => none, snapView := fun _ _ => none }

inductive Reachable : St → Prop
  | init : Reachable init
  | step {s s' : St} : Reachable s → Step P s s' → Reachable s'

end Nimbus.ContentStore
