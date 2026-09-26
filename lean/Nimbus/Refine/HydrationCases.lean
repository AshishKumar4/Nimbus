/-
  Nimbus.Refine.HydrationCases — `lean/fixtures/n17-hydration.json` for
  NodeNoMirrorBuild's `tests/unit/n17-hydration-refinement.mjs`
  (`Nimbus.Vfs.Hydration.step`: chunk granularity, fetch failure, reader deadlines).

  Each case: `config` (`deadlineTicks` for a launch's gate, `readDeadlineTicks` for an
  async reader, `backoffTicks`, `maxBackoffTicks`, `maxAttempts`; one tick = one second
  of the fake clock); `files`, each path's chunk hashes in order (the same hash in two
  paths is one shared chunk; a chunk's bytes are the bridge's choice per hash); `remote`,
  the hashes the import left in state 1, in job order; then events in order, each with
  the expected answer and the state after it:
  - `tick`: the fake clock advances one second.
  - `job` with `outcome` `"ok"` | `"reject"` | `"mismatch"` | `"omit"`: one fetch of the
    first queued hash whose backoff has passed (the bridge's fetch serves one hash per
    step, succeeding, rejecting, answering wrong bytes, or leaving the hash out).
    `expect`: `"idle"` (nothing ready), `{"skipped": h}` (already local: no fetch),
    `{"fetched": h}`, `{"failed": h}` (to the back, `notBefore = now + min(maxBackoff,
    backoff · 2^(k-1))` after its `k`-th failure) or `{"failedForGood": h}` (at
    `maxAttempts`: out of the queue, into `failed`).
  - `asyncRead` p: `"bytes"`; `{"error":"EIO","path","chunk"}` when a chunk of p failed
    for good; else `"wait"`: a reader with a deadline, p's remote hashes to the front.
  - `syncRead` p: `"bytes"`; `{"error":"EIO","path","chunk"}` for a failed chunk; else
    `{"error":"EIO","path"}` and p's remote hashes to the front.
  - `bind` named: a WASI launch; its paths' remote hashes to the front (named, then chunk
    order).
  - `retry`: retryFailed: every failed hash back to the queue's end, ready now, attempts 0.
  After each event (readers and gates settle after every event): `readers` (every async
  read that waited, in order) and `gates` (every launch, in order): `"waiting"`, `"ok"`,
  or `{"error":"EIO","path","chunk"?}` (`chunk` when a failed hash caused it: the first
  named path with one, and its first failed chunk; without `chunk`, the deadline: a
  reader's own path, a gate's first named path that is not local); `queue` (hashes in
  order; one may repeat after reprioritization); `failed`.
-/

import Nimbus.Vfs.Hydration
import Nimbus.Refine.Json

namespace Nimbus.Refine.HydrationCases

open Nimbus.Vfs.Hydration
open Nimbus.Refine

def pname (p : Nat) : String := if p < 10 then s!"/imp/f{p}" else s!"/app/f{p}"

def hname (h : Nat) : String := s!"h{h}"

def resJson : Option Res → Json
  | none => .str "waiting"
  | some .ok => .str "ok"
  | some (.eio p c) => .obj ([("error", .str "EIO"), ("path", .str (pname p))] ++
      (match c with | some c => [("chunk", .str (hname c))] | none => []))

def outJson : Out → Json
  | .ok => .str "ok"
  | .idle => .str "idle"
  | .fetched h => .obj [("fetched", .str (hname h))]
  | .skipped h => .obj [("skipped", .str (hname h))]
  | .failedOnce h => .obj [("failed", .str (hname h))]
  | .failedHard h => .obj [("failedForGood", .str (hname h))]
  | .bytes _ => .str "bytes"
  | .wait => .str "wait"
  | .eio p c => resJson (some (.eio p c))

def outcomeName (o : Nat) : String :=
  if o = 0 then "ok" else if o = 1 then "reject" else if o = 2 then "mismatch" else "omit"

def evJson : Ev → List (String × Json)
  | .tick => [("event", .str "tick")]
  | .job o => [("event", .str "job"), ("outcome", .str (outcomeName o))]
  | .asyncRead p => [("event", .str "asyncRead"), ("path", .str (pname p))]
  | .syncRead p => [("event", .str "syncRead"), ("path", .str (pname p))]
  | .bind ns => [("event", .str "bind"), ("named", .arr (ns.map (.str ∘ pname)))]
  | .retry => [("event", .str "retry")]

def run (cfg : Cfg) (files : List (Nat × List Nat)) (remote : List Nat) (evs : List Ev) : Json := Id.run do
  let mut s := start cfg files remote
  let mut out : Array Json := #[]
  for e in evs do
    let (o, s') := step s e
    s := s'
    out := out.push (.obj (evJson e ++ [("expect", outJson o),
      ("readers", .arr (s.readers.map (resJson ·.result))), ("gates", .arr (s.gates.map (resJson ·.result))),
      ("queue", .arr (s.queue.map (.str ∘ hname))), ("failed", .arr (s.failed.map (.str ∘ hname)))]))
  return .obj [("config", .obj [("deadlineTicks", .ofNat cfg.D), ("readDeadlineTicks", .ofNat cfg.RD),
      ("backoffTicks", .ofNat cfg.backoff), ("maxBackoffTicks", .ofNat cfg.maxBackoff), ("maxAttempts", .ofNat cfg.maxA)]),
    ("files", .obj (files.map fun (p, cs) => (pname p, .arr (cs.map (.str ∘ hname))))),
    ("remote", .arr (remote.map (.str ∘ hname))), ("events", .arr out.toList)]

def genPath (n : Nat) : Gen Nat := do
  if (← below 4) == 0 then return 10 + (← below 3) else return ← below n

def genEv (n : Nat) : Gen Ev := do
  let k ← below 14
  if k < 3 then return .tick
  else if k < 7 then
    let f ← below 3
    let c ← below 3
    return .job (if f == 0 then c + 1 else 0)
  else if k < 9 then return .asyncRead (← genPath n)
  else if k < 11 then return .syncRead (← genPath n)
  else if k < 13 then
    let m ← below 3
    let mut ns := []
    for _ in [0:m] do ns := ns ++ [← genPath n]
    return .bind ns
  else return .retry

def genCase : Gen (Option Json) := do
  let n := (← below 5) + 2
  let pool := (← below 5) + 2
  let D := (← below 4) + 2
  let RD := (← below 4) + 2
  let maxA := (← below 3) + 1
  let backoff := (← below 2) + 1
  let maxBackoff := (← below 3) + 1
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
  let len := (← below 24) + 10
  let mut evs := []
  for _ in [0:len] do evs := evs ++ [← genEv n]
  return some (run { D := D, RD := RD, backoff := backoff, maxBackoff := maxBackoff, maxA := maxA } files remote evs)

/-- `a_shared_chunk`; a fetch that never resolves failing a bind and a reader at 30 s;
    `a_failure_trace` then its retry; `a_reader_deadline`. -/
def directed : List Json :=
  [ run { D := 3, RD := 3 } [(1, [5]), (2, [5]), (3, [6]), (7, [9])] [6, 5]
      [.bind [1], .job 0, .syncRead 2, .syncRead 3, .bind [7], .bind [3], .tick, .tick, .tick, .asyncRead 3, .job 0],
    run { D := 30, RD := 30 } [(0, [1, 2]), (10, [3])] [1, 2]
      ([.bind [0, 10], .asyncRead 0, .job 0] ++ List.replicate 30 .tick ++ [.syncRead 0]),
    run failCfg [(1, [5]), (2, [5, 6]), (3, [7])] [5, 6, 7]
      (failRun ++ [.syncRead 1, .asyncRead 1, .retry, .job 0, .job 0, .asyncRead 1, .syncRead 2, .bind [1, 2]]),
    run { D := 5, RD := 2 } [(1, [5]), (2, [6])] [5, 6] [.asyncRead 1, .asyncRead 2, .tick, .job 0, .tick] ]

def fixture : String :=
  fixtureText [("fixture", .str "n17-hydration"), ("model", .str "Nimbus.Vfs.Hydration.step"),
      ("note", .str "chunk granularity: a path is local when all its chunks are; a job event fetches the first queued hash whose backoff has passed, one hash per fetch, and its outcome is ok, reject, mismatch or omit (the last three alike: to the back with notBefore = now + min(maxBackoff, backoff * 2^(k-1)) after the k-th failure, failed for good at maxAttempts); a read, reader or gate of a path with a failed chunk has EIO naming the path and chunk at once; an async read of a non-local path waits with a deadline of readDeadlineTicks; reads and launches move their remote hashes to the front; readers and gates settle after every event; retry re-queues every failed hash")]
    (directed ++ runGen 0x48594452 (casesOf 150 genCase))

end Nimbus.Refine.HydrationCases
