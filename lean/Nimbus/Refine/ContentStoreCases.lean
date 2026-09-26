/-
  Nimbus.Refine.ContentStoreCases — `lean/fixtures/content-store.json`: random
  sequences of VFS operations run through the model's own transactions
  (`exec` builds each post-state with the same term the matching `Step`
  constructor names, with the parameters the code would choose), with what the model
  says every path, snapshot and detached descriptor reads after each check
  point, and after a final GC drain the files the store must still hold.
  `tests/unit/content-store-refinement.mjs` (ContentStoreBuild) replays each
  case through the deployed `SqliteVFS` and compares the bytes.
-/

import Nimbus.ContentStore.Gc
import Nimbus.Refine.Json

namespace Nimbus.Refine.ContentStoreCases

open Nimbus.ContentStore
open Nimbus.Refine

/-- Paths `/p0` … `/p3`. -/
def P : Nat := 4

inductive Op where
  | write (p : Path) (pieces : List Hash)
  | edit (p : Path) (at_ : Nat) (piece : Hash)
  | delete (p : Path)
  | copy (src dst : Path)
  | rename (src dst : Path)
  | snapshot (n : Nat)
  | drop (n : Nat)
  | restore (n : Nat)
  | detach (fd : Nat) (p : Path)
  | close (fd : Nat)
  | reset

/-! ## The model's transactions, with the parameters the code would choose -/

/-- The chunk a hash dedups to, or the next fresh id (R1). -/
def chunkFor (s : St) (h : Hash) : Nat :=
  ((List.range s.nextChunk).find? fun k => s.chunks k == some h).getD s.nextChunk

theorem chunkFor_ok (s : St) (h : Hash) : InternOk s h (chunkFor s h) := by
  unfold chunkFor InternOk
  cases hf : (List.range s.nextChunk).find? fun k => s.chunks k == some h with
  | none => exact Or.inr rfl
  | some k =>
    left
    have := List.find?_some hf
    simpa using this

def writeSmallS (s : St) (p h : Nat) : St :=
  setView (dirty (commit (intern s h (chunkFor s h)) p (some (.chunk (chunkFor s h))))) p (some [h])

def beginS (s : St) (p : Path) : St :=
  { updContent s s.nextContent (some ⟨[], .staging, none⟩) with
    nextContent := s.nextContent + 1, writers := s.writers ++ [⟨p, s.nextContent, []⟩] }

def appendS (s : St) (w : Writer) (ct : Content) (h : Hash) : St :=
  let k := chunkFor s h
  { updContent (intern s h k) w.content (some { ct with chunks := ct.chunks ++ [k] }) with
    writers := replaceWriter s.writers w { w with hashes := w.hashes ++ [h] } }

def publishS (s : St) (w : Writer) (ct : Content) : St :=
  let hit := (List.range s.nextContent).find? fun c =>
    match s.contents c with
    | some ct2 => ct2.state == .live && ct2.digest == some w.hashes
    | none => false
  match hit with
  | some c2 =>
    setView (dirty (commit { s with writers := s.writers.erase w, queue := enq s.queue (.content w.content) }
      w.path (some (.content c2)))) w.path (some w.hashes)
  | none =>
    setView (dirty (commit
      { updContent s w.content (some { ct with state := .live, digest := some w.hashes }) with
        writers := s.writers.erase w } w.path (some (.content w.content)))) w.path (some w.hashes)

/-- A large file: T1 staging content, one transaction per chunk, publish (R7). -/
def writeLargeS (s : St) (p : Path) (pieces : List Hash) : Option St := do
  let c := s.nextContent
  let mut t := beginS s p
  for h in pieces do
    let w ← t.writers.find? (·.content == c)
    let ct ← t.contents c
    t := appendS t w ct h
  let w ← t.writers.find? (·.content == c)
  let ct ← t.contents c
  return publishS t w ct

/-- A pwrite of one piece: the model always takes the copy-on-write path; the
    code may rewrite in place, which reads the same (both are `Step`s). -/
def editS (s : St) (p : Path) (i : Nat) (h : Hash) : Option St := do
  let r ← s.live p
  match r.ref with
  | .chunk _ => if i = 0 then some (writeSmallS s p h) else none
  | .content c =>
    let ct ← s.contents c
    if i < ct.chunks.length then
      let k := chunkFor s h
      let S := intern s h k
      some (setView (dirty (commit
        { updContent S S.nextContent (some ⟨ct.chunks.set i k, .live, none⟩) with
          nextContent := S.nextContent + 1 }
        p (some (.content S.nextContent)))) p ((s.view p).map fun v => v.set i h))
    else none

def restoreStepS (s : St) : Option St := do
  let j ← s.job
  if j.cursor < P then
    match s.live j.cursor with
    | some r =>
      if r.gen ≤ j.g then return { s with job := some { j with cursor := j.cursor + 1 } }
      else return { setView (commit s j.cursor (atRef s j.g j.cursor)) j.cursor (s.snapView j.name j.cursor) with
        job := some { j with cursor := j.cursor + 1 } }
    | none =>
      return { setView (commit s j.cursor (atRef s j.g j.cursor)) j.cursor (s.snapView j.name j.cursor) with
        job := some { j with cursor := j.cursor + 1 } }
  else if j.cursor = P then return { s with job := none }
  else none

/-- The whole restore job, one path per transaction. -/
def restoreS (s : St) (n : Nat) : Option St := do
  let x ← s.snaps.find? (·.1 == n)
  if s.job ≠ none then none
  let mut t : St := { s with job := some ⟨n, x.2, 0, true⟩ }
  for _ in [0:P + 1] do
    t ← restoreStepS t
  if t.job = none then some t else none

/-- The drop transaction, then the drop job over every history row it frees. -/
def dropS (s : St) (n : Nat) : St :=
  let t : St := { s with snaps := s.snaps.filter fun x => x.1 ≠ n }
  t.hist.foldl (fun (t : St) h =>
    if t.snaps.all (fun x => !(decide (h.genFrom ≤ x.2) && decide (x.2 < h.genTo))) && t.hist.contains h
    then { t with hist := t.hist.erase h, queue := enq t.queue h.ref } else t) t

def exec (s : St) : Op → Option St
  | .write p pieces =>
    if p < P then
      match pieces with
      | [h] => some (writeSmallS s p h)
      | [] => none
      | _ => writeLargeS s p pieces
    else none
  | .edit p i h => editS s p i h
  | .delete p => if p < P ∧ s.live p ≠ none then some (setView (dirty (commit s p none)) p none) else none
  | .copy src dst => do
    let r ← s.live src
    if dst < P ∧ src ≠ dst then some (setView (dirty (commit s dst (some r.ref))) dst (s.view src)) else none
  | .rename src dst => do
    let r ← s.live src
    if dst < P ∧ src ≠ dst then
      some (setView (setView (dirty (retire (commit s dst (some r.ref)) src)) dst (s.view src)) src none)
    else none
  | .snapshot n =>
    if s.snaps.any (·.1 == n) then none
    else some { s with snaps := s.snaps ++ [(n, s.gen)], snapView := upd s.snapView n s.view }
  | .drop n => if s.snaps.any (·.1 == n) then some (dropS s n) else none
  | .restore n => restoreS s n
  | .detach _ p => do
    let r ← s.live p
    if p < P then some { setView (dirty (commit s p none)) p none with fds := s.fds ++ [⟨r.ref, (s.view p).getD []⟩] }
    else none
  | .close i => do
    let f ← s.fds[i]?
    some { s with fds := s.fds.erase f }
  | .reset =>
    some { s with writers := [], fds := [], queue := (stagingIds s).foldl (fun q c => enq q (.content c)) s.queue }

/-! ## Emitting -/

def pathName (p : Path) : String := s!"/p{p}"

def viewJson : Option (List Hash) → Json
  | none => .null
  | some v => .arr (v.map Json.ofNat)

def opJson : Op → Json
  | .write p pieces => .obj [("op", .str "write"), ("path", .str (pathName p)), ("pieces", .arr (pieces.map Json.ofNat))]
  | .edit p i h => .obj [("op", .str "edit"), ("path", .str (pathName p)), ("at", .ofNat i), ("piece", .ofNat h)]
  | .delete p => .obj [("op", .str "delete"), ("path", .str (pathName p))]
  | .copy a b => .obj [("op", .str "copy"), ("from", .str (pathName a)), ("to", .str (pathName b))]
  | .rename a b => .obj [("op", .str "rename"), ("from", .str (pathName a)), ("to", .str (pathName b))]
  | .snapshot n => .obj [("op", .str "snapshot"), ("name", .str s!"s{n}")]
  | .drop n => .obj [("op", .str "drop"), ("name", .str s!"s{n}")]
  | .restore n => .obj [("op", .str "restore"), ("name", .str s!"s{n}")]
  | .detach fd p => .obj [("op", .str "open-unlink"), ("fd", .ofNat fd), ("path", .str (pathName p))]
  | .close fd => .obj [("op", .str "close"), ("fd", .ofNat fd)]
  | .reset => .obj [("op", .str "reset")]

/-- What the model says is readable now: every path, every snapshot, every
    open detached descriptor (in open order). -/
def checkJson (s : St) : Json :=
  .obj [("op", .str "check"),
    ("files", .obj ((List.range P).map fun p => (pathName p, viewJson (s.view p)))),
    ("snapshots", .obj (s.snaps.map fun x =>
      (s!"s{x.1}", .obj ((List.range P).map fun p => (pathName p, viewJson (s.snapView x.1 p)))))),
    ("fds", .arr (s.fds.map fun f => .arr (f.view.map Json.ofNat)))]

/-- After GC drains: the files whose bytes the store must still hold (live,
    snapshot and descriptor views), each once. -/
def reachable (s : St) : List (List Hash) :=
  let all := ((List.range P).filterMap s.view) ++
    (s.snaps.flatMap fun x => (List.range P).filterMap (s.snapView x.1)) ++ s.fds.map (·.view)
  all.foldl (fun acc v => if acc.contains v then acc else acc ++ [v]) []

def genOp (s : St) : Gen Op := do
  let p ← below P
  let q ← below P
  let piece ← below 6
  let k ← below 24
  let fdCount := s.fds.length
  if k < 9 then
    let n := (← below 3) + 1
    let mut pieces := #[]
    for _ in [0:n] do pieces := pieces.push (← below 6)
    return .write p pieces.toList
  else if k < 11 then return .edit p (← below 3) piece
  else if k < 12 then return .delete p
  else if k < 14 then return .copy p q
  else if k < 15 then return .rename p q
  else if k < 17 then return .snapshot (← below 3)
  else if k < 18 then return .drop (← below 3)
  else if k < 20 then return .restore (← below 3)
  else if k < 22 then return .detach fdCount p
  else if k < 23 then return (if fdCount = 0 then .reset else .close (fdCount - 1))
  else return .reset

def genCase : Gen (Option Json) := do
  let n := (← below 16) + 4
  let mut s := init
  let mut ops : Array Json := #[]
  for _ in [0:n] do
    let op ← genOp s
    match exec s op with
    | some s' =>
      s := s'
      ops := ops.push (opJson op)
      if (← below 3) == 0 then ops := ops.push (checkJson s)
    | none => pure ()
  ops := ops.push (checkJson s)
  ops := ops.push (.obj [("op", .str "gc")])
  ops := ops.push (.obj [("op", .str "checkStore"),
    ("reachable", .arr ((reachable s).map fun v => .arr (v.map Json.ofNat)))])
  return some (.obj [("ops", .arr ops.toList)])

/-- The defects found against SPEC.md, as scenarios the code must get right. -/
def directed : List Json :=
  let run (ops : List Op) : Json := Id.run do
    let mut s := init
    let mut out : Array Json := #[]
    for op in ops do
      if let some s' := exec s op then
        s := s'
        out := out.push (opJson op)
        out := out.push (checkJson s)
    out := out.push (.obj [("op", .str "gc")])
    out := out.push (.obj [("op", .str "checkStore"),
      ("reachable", .arr ((reachable s).map fun v => .arr (v.map Json.ofNat)))])
    .obj [("ops", .arr out.toList)]
  [ -- a descriptor pins a shared chunk; the surviving path is edited
    run [.write 0 [1], .copy 0 1, .detach 0 1, .edit 0 0 2, .close 0],
    -- a snapshot sees a row; that row is edited
    run [.write 0 [1], .snapshot 0, .edit 0 0 2, .restore 0],
    -- unlink an open file, GC, then close: nothing may leak
    run [.write 0 [3], .detach 0 0, .close 0],
    -- large file shared by copy, edited in one chunk, snapshot restored
    run [.write 0 [1, 2, 3], .snapshot 1, .copy 0 1, .edit 1 1 4, .restore 1, .drop 1],
    -- rename leaves the destination holding the source's bytes
    run [.write 0 [1, 2], .rename 0 2, .reset] ]

def fixture : String :=
  fixtureText [("fixture", .str "content-store"), ("model", .str "Nimbus.ContentStore.Step"),
      ("piece", .obj [("bytes", .ofNat 40000),
        ("gen", .str "xorshift32: s = (h*2654435761+1) mod 2^32 (never 0); per byte s^=s<<13; s^=s>>>17; s^=s<<5 (u32); byte = s & 255")]),
      ("paths", .ofNat P)]
    (directed ++ runGen 0x434153 (casesOf 150 genCase))

end Nimbus.Refine.ContentStoreCases
