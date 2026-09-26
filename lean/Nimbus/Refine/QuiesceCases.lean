/-
  Nimbus.Refine.QuiesceCases — `lean/fixtures/quiesce.json` for NodeNoMirrorBuild's
  `tests/unit/quiesce-refinement.mjs` (`Nimbus.ContentStore.Quiesce.step`, with the
  bypass).

  Each case is a list of steps run in order on one engine; after each step the
  bridge lets the engine settle (every microtask, and the lease poll's
  yieldToStorage) before the next.
  - `{"op":"acquire"}`: acquireExclusiveMutation on its own root; the lease's id is
    the number of acquires before it.
  - `{"op":"release","lease"}`.
  - `{"op":"stream","owner"?}`: writeStream of job `id` (jobs are numbered in call
    order), carrying that lease's owner if given; its source stays open until
    `end`.
  - `{"op":"restore"}`, `{"op":"copy"}`: restoreAsync / sliced copyTree job `id`;
    they run to the end on their own, within the settle of the step that starts
    them (the model's `tick`s, taken until none runs: `settleJobs`).
  - `{"op":"end","job"}`: the stream's source closes.
  - `{"op":"snapshot"}`: snapshot(`s<k>`, {quiesce:true}), k the number of
    snapshot steps before it.
  Each step's `expect`: `started`, the jobs that started during the step, in order;
  `pinned`, the snapshots that pinned during it, each with `contents`, the jobs done
  when it pinned (ascending). Job `id`'s effect is its own path, so a snapshot's view
  holds exactly its contents' paths. At the end: `pins` (all, in order), `starts`
  (every job in start order) and `pending` (snapshots not pinned: none, since every
  case ends by draining).
-/

import Nimbus.ContentStore.Quiesce
import Nimbus.Refine.Json

namespace Nimbus.Refine.QuiesceCases

open Nimbus.ContentStore.Quiesce
open Nimbus.Refine

inductive Step where
  | acquire
  | release (n : Nat)
  | stream (owner : Option Nat)
  | restore
  | copy
  | finish (j : Nat)
  | tick
  | snapshot

def toEv : Step → Ev
  | .acquire => .acquire
  | .release n => .release n
  | .stream o => .start .stream o (match o with | some n => .lease n | none => .none)
  | .restore => .start .restore none .none
  | .copy => .start .copy none .none
  | .finish j => .endStream j
  | .tick => .tick
  | .snapshot => .snapshot

def stepHead (s : St) : Step → List (String × Json)
  | .acquire => [("op", .str "acquire"), ("lease", .ofNat s.nextOwner)]
  | .release n => [("op", .str "release"), ("lease", .ofNat n)]
  | .stream o => [("op", .str "stream"), ("id", .ofNat s.jobs.length)] ++
      (match o with | some n => [("owner", .ofNat n)] | none => [])
  | .restore => [("op", .str "restore"), ("id", .ofNat s.jobs.length)]
  | .copy => [("op", .str "copy"), ("id", .ofNat s.jobs.length)]
  | .finish j => [("op", .str "end"), ("job", .ofNat j)]
  | .tick => [("op", .str "tick")]
  | .snapshot => [("op", .str "snapshot"), ("name", .str s!"s{s.nextSnap}")]

def pinJson (p : Nat × List Nat) : Json :=
  .obj [("snapshot", .str s!"s{p.1}"), ("contents", .arr (p.2.map .ofNat))]

def anyJobRunning (t : St) : Bool := t.jobs.any fun j => j.kind != .stream && j.st == .running

/-- Restore and copy jobs run out within a step's settle: model `tick`s until none runs. -/
def settleJobs (t : St) : St :=
  (List.range (t.snaps.length + 2)).foldl (fun t _ => if anyJobRunning t then step true t .tick else t) t

def stepF (s : St) (st : Step) : St := settleJobs (step true s (toEv st))

def run (steps : List Step) : Json := Id.run do
  let mut s := init
  let mut out : Array Json := #[]
  for st in steps do
    let head := stepHead s st
    let s' := stepF s st
    out := out.push (.obj (head ++ [("expect", .obj [("started", .arr ((s'.starts.drop s.starts.length).map .ofNat)),
      ("pinned", .arr ((s'.pins.drop s.pins.length).map pinJson))])]))
    s := s'
  return .obj [("steps", .arr out.toList), ("pins", .arr (s.pins.map pinJson)),
    ("starts", .arr (s.starts.map .ofNat)), ("pending", .arr (s.snaps.map fun k => .str s!"s{k}"))]

def runningStreams (s : St) : List Nat := idsWhere s fun j => j.kind == .stream && j.st == .running

/-- End every running stream, run every job out, release every lease; until nothing is
    pending (at most one round per snapshot, by `drain`). -/
def drainSteps (s0 : St) : List Step := Id.run do
  let mut s := s0
  let mut out : Array Step := #[]
  for _ in [0:s0.snaps.length + 2] do
    for j in runningStreams s do
      out := out.push (.finish j); s := stepF s (.finish j)
    for n in s.leases do
      out := out.push (.release n); s := stepF s (.release n)
  return out.toList

def genStep (s : St) : Gen Step := do
  let k ← below 16
  if k < 2 then return .acquire
  else if k < 3 then
    if s.leases.isEmpty then return .acquire else return .release (← pick s.leases)
  else if k < 7 then
    if !s.leases.isEmpty && (← below 2) == 0 then return .stream (some (← pick s.leases)) else return .stream none
  else if k < 8 then return .restore
  else if k < 9 then return .copy
  else if k < 13 then
    let r := runningStreams s
    if r.isEmpty then return .snapshot else return .finish (← pick r)
  else return .snapshot

def genCase : Gen (Option Json) := do
  let mut s := init
  let mut steps : Array Step := #[]
  let n := (← below 16) + 6
  for _ in [0:n] do
    let st ← genStep s
    steps := steps.push st
    s := stepF s st
  return some (run (steps.toList ++ drainSteps s))

/-- `clone_pins`, `lease_after_gate`, and the two shapes `WF` forbids, driven by the
    bridge so they end (a lease holder's copy and a job's stream wait for the pin). -/
def directed : List Json :=
  [ run [.acquire, .snapshot, .stream (some 0), .stream (some 0), .stream none, .finish 0, .finish 1, .release 0, .finish 2],
    run [.stream none, .snapshot, .acquire, .stream (some 0), .copy, .finish 0, .finish 1, .release 0, .snapshot],
    run [.acquire, .snapshot, .copy, .release 0],
    run [.stream none, .snapshot, .restore, .stream none, .finish 0, .finish 2] ]

def fixture : String :=
  fixtureText [("fixture", .str "quiesce"), ("model", .str "Nimbus.ContentStore.Quiesce.step"),
      ("note", .str "one engine per case; settle after every step; leases, jobs and snapshots are numbered by call order; a stream carrying a live lease's owner starts at once, other spanning work waits for the newest pending snapshot and starts right after it pins; a snapshot pins after every earlier one, once no spanning work runs and no lease is held; restore and copy jobs finish within the settle of the step that starts them; contents are the jobs done at the pin")]
    (directed ++ runGen 0x51554945 (casesOf 150 genCase))

end Nimbus.Refine.QuiesceCases
