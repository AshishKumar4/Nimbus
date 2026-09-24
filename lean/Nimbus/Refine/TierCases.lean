/-
  Nimbus.Refine.TierCases — `lean/fixtures/content-store-tier.json`: the
  content-store fixture's schema plus content-store P6's tiering. Operations run
  through the content-store model's transactions (`ContentStoreCases.exec`); the
  cold set follows `Nimbus.ContentStore.Tier`'s rules at the store's granularity.
  Every file is a single piece (one chunk, the piece's identity; see `single`):

  - `tier` (tierColdChunks to done) colds every stored chunk some history row
    reaches, that no live row, open descriptor, staging content or hot snapshot
    reaches (a live row reaches the chunks of its content; ContentStoreBuild's
    LIVE_CHUNK_UNREFERENCED). It runs no GC.
  - a write or edit holding a piece revives that piece's chunk in place;
  - `prepare` hydrates every chunk the snapshot reaches and makes it hot until
    `release`;
  - `restore` refuses with ENODATA when a history row covering the snapshot names
    a cold chunk, and changes nothing.

  A check's snapshot read expects `{"error":"ENODATA"}` when the bytes need a
  cold chunk. Live paths and descriptors never do (`Tier.live_never_cold`).
  Consumed by ContentStoreBuild's `tests/unit/content-store-refinement.mjs`.
-/

import Nimbus.Refine.ContentStoreCases

namespace Nimbus.Refine.TierCases

open Nimbus.ContentStore
open Nimbus.Refine
open Nimbus.Refine.ContentStoreCases

structure TS where
  s : St
  cold : List Nat
  hot : List Nat

def refChunks (s : St) : Ref → List Nat
  | .chunk k => [k]
  | .content c => ((s.contents c).map (·.chunks)).getD []

def snapRefs (s : St) (n : Nat) : List Ref :=
  match s.snaps.find? (·.1 == n) with
  | some x => (List.range P).filterMap (atRef s x.2)
  | none => []

def tierable (t : TS) (k : Nat) : Bool :=
  let s := t.s
  let liveReach := (List.range P).flatMap fun p => ((s.live p).map fun r => refChunks s r.ref).getD []
  let fdReach := s.fds.flatMap fun f => refChunks s f.ref
  let stagingReach := (List.range s.nextContent).flatMap fun c =>
    match s.contents c with
    | some ct => if ct.state == .staging then ct.chunks else []
    | none => []
  let hotReach := t.hot.flatMap fun n => (snapRefs s n).flatMap (refChunks s)
  let histReach := s.hist.flatMap fun h => refChunks s h.ref
  (s.chunks k).isSome && histReach.contains k && !liveReach.contains k && !fdReach.contains k &&
    !stagingReach.contains k && !hotReach.contains k

def tier (t : TS) : TS :=
  { t with cold := t.cold ++ ((List.range t.s.nextChunk).filter fun k => tierable t k && !t.cold.contains k) }

/-- Chunks a write's pieces land on: revived in place. -/
def revive (t : TS) (pieces : List Hash) : TS :=
  { t with cold := t.cold.filter fun k => !(pieces.any fun h => t.s.chunks k == some h) }

/-- GC deletes chunks; a deleted id is no longer cold (its trash row is not observable here). -/
def forget (t : TS) : TS := { t with cold := t.cold.filter fun k => (t.s.chunks k).isSome }

inductive TOp where
  | base (op : Op)
  | tier
  | prepare (n : Nat)
  | release (n : Nat)

def restoreBlocked (t : TS) (n : Nat) : Bool :=
  match t.s.snaps.find? (·.1 == n) with
  | some x => t.s.hist.any fun h => covers x.2 h.path h && (refChunks t.s h.ref).any t.cold.contains
  | none => false

/-- One step: the new state and the JSON line, or `none` when the op does not apply. -/
def execT (t : TS) : TOp → Option (TS × Json)
  | .tier => some (tier t, .obj [("op", .str "tier")])
  | .prepare n =>
    if t.s.snaps.any (·.1 == n) && !t.hot.contains n then
      let reach := (snapRefs t.s n).flatMap (refChunks t.s)
      some ({ t with cold := t.cold.filter (!reach.contains ·), hot := t.hot ++ [n] },
        .obj [("op", .str "prepare"), ("name", .str s!"s{n}")])
    else none
  | .release n =>
    if t.hot.contains n then some ({ t with hot := t.hot.erase n }, .obj [("op", .str "release"), ("name", .str s!"s{n}")])
    else none
  | .base op =>
    match op with
    | .restore n =>
      if restoreBlocked t n then some (t, .obj [("op", .str "restore"), ("name", .str s!"s{n}"), ("error", .str "ENODATA")])
      else (exec t.s op).map fun s' => ({ t with s := s' }, opJson op)
    | .drop n => (exec t.s op).map fun s' => ({ t with s := s', hot := t.hot.erase n }, opJson op)
    | .reset => if t.hot.isEmpty then (exec t.s op).map fun s' => ({ t with s := s' }, opJson op) else none
    | .write _ pieces => (exec t.s op).map fun s' => (revive { t with s := s' } pieces, opJson op)
    | .edit _ _ h => (exec t.s op).map fun s' => (revive { t with s := s' } [h], opJson op)
    | _ => (exec t.s op).map fun s' => ({ t with s := s' }, opJson op)

def readJson (t : TS) (r : Option Ref) (v : Option (List Hash)) : Json :=
  match r with
  | some r => if (refChunks t.s r).any t.cold.contains then .obj [("error", .str "ENODATA")] else viewJson v
  | none => viewJson v

def checkT (t : TS) : Json :=
  let s := t.s
  .obj [("op", .str "check"),
    ("files", .obj ((List.range P).map fun p => (pathName p, viewJson (s.view p)))),
    ("snapshots", .obj (s.snaps.map fun x =>
      (s!"s{x.1}", .obj ((List.range P).map fun p =>
        (pathName p, readJson t (atRef s x.2 p) (s.snapView x.1 p)))))),
    ("fds", .arr (s.fds.map fun f => .arr (f.view.map Json.ofNat)))]

/-- Tier cases use single-piece files only: a file of one piece is one chunk
    whose identity is the piece's, while a multi-piece file is FastCDC-cut over
    its bytes and its chunks are not its pieces (which the model's chunk ids do
    not follow). -/
def single : Op → Op
  | .write p (h :: _) => .write p [h]
  | .edit p _ h => .edit p 0 h
  | op => op

def genTOp (t : TS) : Gen TOp := do
  let k ← below 12
  if k < 2 then return .tier
  else if k < 3 then return .prepare (← below 3)
  else if k < 4 then return .release (← below 3)
  else if k < 6 then return .base (.delete (← below P))
  else return .base (single (← genOp t.s))

def finish (t : TS) (ops : Array Json) : Json :=
  let ops := ops.push (checkT t) |>.push (.obj [("op", .str "gc")]) |>.push (.obj [("op", .str "checkStore"),
    ("reachable", .arr ((reachable t.s).map fun v => .arr (v.map Json.ofNat)))])
  .obj [("ops", .arr ops.toList)]

def genCase : Gen (Option Json) := do
  let n := (← below 20) + 6
  let mut t : TS := { s := init, cold := [], hot := [] }
  let mut ops : Array Json := #[]
  -- a populated tree and a snapshot of it, so later deletes and rewrites leave history to tier
  let mut seed : Array TOp := #[]
  for p in List.range P do seed := seed.push (.base (.write p [← below 6]))
  seed := seed.push (.base (.snapshot 0))
  for op in seed do
    if let some (t', line) := execT t op then
      t := t'
      ops := ops.push line
  for _ in [0:n] do
    let op ← genTOp t
    match execT t op with
    | some (t', line) =>
      t := t'
      ops := ops.push line
      if (← below 3) == 0 then ops := ops.push (checkT t)
    | none => pure ()
  return some (finish t ops)

def run (ops : List TOp) : Json := Id.run do
  let mut t : TS := { s := init, cold := [], hot := [] }
  let mut out : Array Json := #[]
  for op in ops do
    if let some (t', line) := execT t op then
      t := t'
      out := out.push line
      out := out.push (checkT t)
  finish t out

def directed : List Json :=
  [ -- a deleted small file's chunk goes cold; the snapshot reads ENODATA; restore refuses
    run [.base (.write 0 [1]), .base (.snapshot 0), .base (.delete 0), .tier, .base (.restore 0)],
    -- prepare hydrates and pins against tier; release, tier again, restore refuses
    run [.base (.write 0 [1]), .base (.snapshot 0), .base (.delete 0), .tier, .prepare 0, .tier,
      .base (.restore 0), .release 0, .tier, .base (.restore 0)],
    -- a write holding the bytes revives the chunk in place: the snapshot reads again
    run [.base (.write 0 [2]), .base (.snapshot 0), .base (.delete 0), .tier, .base (.write 1 [2])],
    -- a copy keeps the chunk live; deleting both lets it go cold
    run [.base (.write 0 [1]), .base (.copy 0 1), .base (.snapshot 1), .base (.delete 0), .tier,
      .base (.delete 1), .tier, .base (.restore 1)],
    -- an open descriptor pins against tier
    run [.base (.write 0 [4]), .base (.snapshot 0), .base (.detach 0 0), .tier, .base (.close 0), .tier] ]

def fixture : String :=
  fixtureText [("fixture", .str "content-store-tier"), ("model", .str "Nimbus.ContentStore.Tier"),
      ("piece", .obj [("bytes", .ofNat 40000),
        ("gen", .str "xorshift32: s = (h*2654435761+1) mod 2^32 (never 0); per byte s^=s<<13; s^=s>>>17; s^=s<<5 (u32); byte = s & 255")]),
      ("paths", .ofNat P)]
    (directed ++ runGen 0x54494552 (casesOf 150 genCase))

end Nimbus.Refine.TierCases
