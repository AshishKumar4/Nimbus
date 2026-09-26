/-
  Nimbus.Refine.HydrationCases — `lean/fixtures/n17-hydration.json` for
  NodeNoMirrorBuild's `tests/unit/n17-hydration-refinement.mjs`
  (`Nimbus.Vfs.Hydration.step`, chunk granularity).

  Each case: `deadlineTicks` (one tick = one second of the fake clock, so 30 =
  HYDRATION_DEADLINE_MS); `files`, each path's chunk hashes in order (an import page's
  manifests: the same hash in two paths is one shared chunk; a chunk's bytes are the
  bridge's choice per hash); `remote`, the hashes the import left in state 1, in job
  order (every other hash is local); then events in order, each with the expected
  answer and the state after it:
  - `tick`: the fake clock advances one second.
  - `job`: the embedder's `hydrate` resolves for the hash at the front of the job.
  - `asyncRead` p: `"bytes"`, or `"wait"` (the reader awaits `NeedsHydration`; p's
    remote hashes move to the front, in p's chunk order).
  - `resume`: every waiting reader whose path is now local: `{"resumed": [paths]}`.
  - `syncRead` p: `"bytes"`, or `{"error":"EIO","path"}` (p's remote hashes move to
    the front).
  - `bind` named: a WASI launch naming those paths; their remote hashes move to the
    front, in named then chunk order.
  After each event: `gates` (every launch so far, in bind order: `"waiting"`, `"ok"`
  or `{"error":"EIO","path"}`, the first named path not local) and `queue` (the job's
  remaining hashes; a hash may repeat after reprioritization, and hydrating it again
  is a no-op).
-/

import Nimbus.Vfs.Hydration
import Nimbus.Refine.Json

namespace Nimbus.Refine.HydrationCases

open Nimbus.Vfs.Hydration
open Nimbus.Refine

def pname (p : Nat) : String := if p < 10 then s!"/imp/f{p}" else s!"/app/f{p}"

def hname (h : Nat) : String := s!"h{h}"

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

def run (D : Nat) (files : List (Nat × List Nat)) (remote : List Nat) (evs : List Ev) : Json := Id.run do
  let mut s := start D files remote
  let mut out : Array Json := #[]
  for e in evs do
    let (o, s') := step s e
    s := s'
    out := out.push (.obj (evJson e ++ [("expect", outJson o), ("gates", .arr (s.gates.map gJson)),
      ("queue", .arr (s.queue.map (.str ∘ hname)))]))
  return .obj [("deadlineTicks", .ofNat D),
    ("files", .obj (files.map fun (p, cs) => (pname p, .arr (cs.map (.str ∘ hname))))),
    ("remote", .arr (remote.map (.str ∘ hname))), ("events", .arr out.toList)]

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
  let pool := (← below 5) + 2
  let D := (← below 4) + 2
  let mut files : List (Nat × List Nat) := []
  for p in List.range n do
    let k := (← below 3) + 1
    let mut cs := []
    for _ in [0:k] do cs := cs ++ [← below pool]
    files := files ++ [(p, cs.eraseDups)]
  for p in [10, 11, 12] do
    let extra ← if (← below 3) == 0 then pure [← below pool] else pure []
    files := files ++ [(p, [100 + p] ++ extra)]
  let mut remote := []
  for h in List.range pool do
    if (← below 4) != 0 then remote := remote ++ [h]
  let len := (← below 20) + 10
  let mut evs := []
  for _ in [0:len] do evs := evs ++ [← genEv n]
  return some (run D files remote evs)

/-- `a_shared_chunk`, and a hydrate that never resolves failing a bind at 30 s. -/
def directed : List Json :=
  [ run 3 [(1, [5]), (2, [5]), (3, [6]), (7, [9])] [6, 5]
      [.bind [1], .job, .syncRead 2, .syncRead 3, .bind [7], .bind [3], .tick, .tick, .tick, .asyncRead 3, .job, .resume],
    run 30 [(0, [1, 2]), (10, [3])] [1, 2] ([.bind [0, 10], .job] ++ List.replicate 30 .tick ++ [.syncRead 0]) ]

def fixture : String :=
  fixtureText [("fixture", .str "n17-hydration"), ("model", .str "Nimbus.Vfs.Hydration.step"),
      ("note", .str "chunk granularity: a path is local when all its chunks are; remote hashes hydrate in job order, one per job event; an async read of a non-local path waits and moves its remote hashes to the front; a sync read answers EIO naming the path and moves them to the front; bind moves its named paths' remote hashes to the front and its gate opens when all named paths are local or fails with EIO naming the first that is not once deadlineTicks have passed since bind; gates are settled after every event")]
    (directed ++ runGen 0x48594452 (casesOf 150 genCase))

end Nimbus.Refine.HydrationCases
