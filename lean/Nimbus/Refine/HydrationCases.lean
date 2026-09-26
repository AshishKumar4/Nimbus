/-
  Nimbus.Refine.HydrationCases — `lean/fixtures/n17-hydration.json` for
  NodeNoMirrorBuild's `tests/unit/n17-hydration-refinement.mjs`
  (`Nimbus.Vfs.Hydration.step`).

  Each case: `deadlineTicks` (one tick = one second of the fake clock, so 30 =
  HYDRATION_DEADLINE_MS), the imported paths (state 1 at start, job order as
  listed), the local paths, then events in order, each with the expected answer
  and the state after it:
  - `tick`: the fake clock advances one second.
  - `job`: the embedder's `hydrate` resolves for the path at the front of the job.
  - `asyncRead` p: `"bytes"`, or `"wait"` (the reader awaits; p moves to the front).
  - `resume`: every waiting reader whose path is now local gets its bytes:
    `{"resumed": [paths]}`.
  - `syncRead` p: `"bytes"`, or `{"error":"EIO","path"}` (p moves to the front).
  - `bind` named: a WASI launch naming those paths.
  After each event: `gates` (every launch so far, in bind order: `"waiting"`,
  `"ok"` or `{"error":"EIO","path"}`, the first unhydrated named path) and `queue`
  (the job's remaining order).
-/

import Nimbus.Vfs.Hydration
import Nimbus.Refine.Json

namespace Nimbus.Refine.HydrationCases

open Nimbus.Vfs.Hydration
open Nimbus.Refine

/-- Paths below 10 are imported, the rest local. -/
def pname (p : Nat) : String := if p < 10 then s!"/imp/f{p}" else s!"/app/f{p}"

def gJson (g : Gate) : Json :=
  match g.result with
  | none => .str "waiting"
  | some .ok => .str "ok"
  | some (.eio p) => .obj [("error", .str "EIO"), ("path", .str (pname p))]

def outJson : Out → Json
  | .ok => .str "ok"
  | .bytes _ => .str "bytes"
  | .wait => .str "wait"
  | .eio p => .obj [("error", .str "EIO"), ("path", .str (pname p))]
  | .resumed ps => .obj [("resumed", .arr (ps.map (.str ∘ pname)))]

def evJson : Ev → List (String × Json)
  | .tick => [("event", .str "tick")]
  | .job => [("event", .str "job")]
  | .asyncRead p => [("event", .str "asyncRead"), ("path", .str (pname p))]
  | .resume => [("event", .str "resume")]
  | .syncRead p => [("event", .str "syncRead"), ("path", .str (pname p))]
  | .bind ns => [("event", .str "bind"), ("named", .arr (ns.map (.str ∘ pname)))]

def run (D : Nat) (imp loc : List Nat) (evs : List Ev) : Json := Id.run do
  let mut s : H := ⟨D, 0, imp, [], imp, [], []⟩
  let mut out : Array Json := #[]
  for e in evs do
    let (o, s') := step s e
    s := s'
    out := out.push (.obj (evJson e ++ [("expect", outJson o), ("gates", .arr (s.gates.map gJson)),
      ("queue", .arr (s.queue.map (.str ∘ pname)))]))
  return .obj [("deadlineTicks", .ofNat D), ("imported", .arr (imp.map (.str ∘ pname))),
    ("local", .arr (loc.map (.str ∘ pname))), ("events", .arr out.toList)]

def genPath (n : Nat) : Gen Nat := do
  if (← below 4) == 0 then return 10 + (← below 3) else return ← below n

def genEv (n : Nat) : Gen Ev := do
  let k ← below 12
  if k < 3 then return .tick
  else if k < 5 then return .job
  else if k < 7 then return .asyncRead (← genPath n)
  else if k < 8 then return .resume
  else if k < 10 then return .syncRead (← genPath n)
  else
    let m ← below 3
    let mut ns := []
    for _ in [0:m] do ns := ns ++ [← genPath n]
    return .bind ns

def genCase : Gen (Option Json) := do
  let n := (← below 5) + 2
  let D := (← below 4) + 2
  let len := (← below 20) + 10
  let mut evs := []
  for _ in [0:len] do evs := evs ++ [← genEv n]
  return some (run D (List.range n) [10, 11, 12] evs)

/-- `a_window`, and a hydrate that never resolves failing a bind at 30 s. -/
def directed : List Json :=
  [ run 3 [1, 2] [10] [.bind [2], .job, .syncRead 1, .bind [10], .bind [1], .tick, .tick, .tick, .asyncRead 1, .job, .resume],
    run 30 [0] [10] ([.bind [0, 10]] ++ List.replicate 30 .tick ++ [.syncRead 0]) ]

def fixture : String :=
  fixtureText [("fixture", .str "n17-hydration"), ("model", .str "Nimbus.Vfs.Hydration.step"),
      ("note", .str "state-1 paths hydrate in job order, one per job event; an async read of one waits and moves it to the front; a sync read answers EIO naming it and moves it to the front; bind moves its state-1 named paths to the front, in named order, and its gate opens when all are local or fails with EIO naming the first unhydrated one once deadlineTicks have passed since bind; gates are settled after every event")]
    (directed ++ runGen 0x48594452 (casesOf 150 genCase))

end Nimbus.Refine.HydrationCases
