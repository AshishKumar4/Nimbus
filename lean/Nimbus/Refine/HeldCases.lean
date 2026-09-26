/-
  Nimbus.Refine.HeldCases — `lean/fixtures/resident-poison-reconcile.json` for
  GitParityLane's `tests/unit/resident-poison-reconcile.mjs`: held cells through
  barriers and poison repairs (`Nimbus.Coherence.Store.exec`, the rule; every state a
  case shows is reachable, `run_reach`, so its dated cells are never older than a peer
  write before the barrier, `no_pre_peer_bytes`).

  Each case runs one store over one authority. `full`: the store has no room (grant 0):
  every own write is held in the heap and nothing fetched is admitted; else it has room
  and nothing is held. `paths` are the files read after every event; `churn` is a file
  no case reads. Events, in order:
  - `{"event":"peer","path","bytes"}`: a peer writes the file at the authority.
  - `{"event":"own","path","bytes"}`: the process's own write (`bundle[path] = bytes`).
  - `{"event":"flush","path","bytes"}`: its write-back: the authority commits the
    parked bytes and the store is told (`__residentStamp(path, rev)`).
  - `{"event":"barrier"}`: `fsAcquire` from the store's cursor, admitted
    (`__residentAdmit`). No barrier here is poisoned.
  - `{"event":"repair","bytes"}`: churn (`churn` written with `bytes`) trims the log
    past the cursor, so the barrier is poisoned and the store repairs
    (`__residentSynchronizeFromSupervisor`).
  After each event `expect` maps every path to what `__residentGet` serves: the bytes,
  or null (a miss: with no room, EAGAIN, never old bytes).
-/

import Nimbus.Coherence.Held
import Nimbus.Refine.Json

namespace Nimbus.Refine.HeldCases

open Nimbus.Coherence.Store
open Nimbus.Refine

def pname (p : Path) : String := if p = churnPath then "app/churn" else s!"app/f{p}"

/-- Bytes of each commit (its revision) and of each own write (its id). -/
structure Names where
  commits : List (Nat × String) := []

def served (n : Names) (a : HSt) (p : Path) : Json :=
  match a.s.rows p with
  | some ⟨v, .dated _⟩ => match n.commits.find? (·.1 == v) with
    | some (_, b) => .str b
    | none => .null
  | some ⟨w, .own⟩ => .str s!"own-{w}"
  | none => .null

def run (full : Bool) (paths : List Path) (evs : List FEv) : Json := Id.run do
  let mut a : HSt := ⟨init, fun _ => false⟩
  let mut n : Names := {}
  let mut out : Array Json := #[]
  for e in evs do
    let (head, names') : List (String × Json) × Names := match e with
      | .peer p =>
        let b := s!"peer-{a.s.rev + 1}"
        ([("event", .str "peer"), ("path", .str (pname p)), ("bytes", .str b)],
          { commits := n.commits ++ [(a.s.rev + 1, b)] })
      | .own p => ([("event", .str "own"), ("path", .str (pname p)), ("bytes", .str s!"own-{a.s.nextId}")], n)
      | .flush p => match a.s.parked p with
        | some w =>
          let b := s!"own-{w}"
          ([("event", .str "flush"), ("path", .str (pname p)), ("bytes", .str b)],
            { commits := n.commits ++ [(a.s.rev + 1, b)] })
        | none => ([("event", .str "flush"), ("path", .str (pname p)), ("bytes", .null)], n)
      | .barrier => ([("event", .str "barrier")], n)
      | .repair =>
        let b := s!"churn-{a.s.rev + 1}"
        ([("event", .str "repair"), ("bytes", .str b)], { commits := n.commits ++ [(a.s.rev + 1, b)] })
    a := exec full paths a e
    n := names'
    out := out.push (.obj (head ++ [("expect", .obj (paths.map fun p => (pname p, served n a p)))]))
  return .obj [("full", .bool full), ("paths", .arr (paths.map (.str ∘ pname))), ("churn", .str (pname churnPath)),
    ("events", .arr out.toList)]

def genEv (paths : List Path) (a : HSt) : Gen FEv := do
  let k ← below 12
  if k < 3 then return .peer (← pick paths)
  else if k < 5 then return .own (← pick paths)
  else if k < 8 then
    let parked := paths.filter fun p => (a.s.parked p).isSome
    if parked.isEmpty then return .barrier else return .flush (← pick parked)
  else if k < 10 then return .barrier
  else return .repair

def genCase : Gen (Option Json) := do
  let full := (← below 2) == 0
  let paths := List.range ((← below 3) + 2)
  let len := (← below 14) + 6
  let mut a : HSt := ⟨init, fun _ => false⟩
  let mut evs : List FEv := []
  for _ in [0:len] do
    let e ← genEv paths a
    evs := evs ++ [e]
    a := exec full paths a e
  return some (run full paths evs)

/-- The reviewer's held-stale.mjs, full and with room; an own cell held through a
    barrier and a repair; a held dated cell a barrier's report drops. -/
def directed : List Json :=
  [ run true [0] [.own 0, .flush 0, .peer 0, .repair, .barrier],
    run false [0] [.own 0, .flush 0, .peer 0, .repair, .barrier],
    run true [0, 1] [.own 1, .peer 1, .barrier, .repair, .flush 1, .barrier, .peer 0, .repair],
    run true [0] [.own 0, .flush 0, .peer 0, .barrier, .own 0, .repair] ]

def fixture : String :=
  fixtureText [("fixture", .str "resident-poison-reconcile"), ("model", .str "Nimbus.Coherence.Store.exec"),
      ("note", .str "one store over one authority per case; full: grant 0, every own write held in the heap and nothing fetched admitted, else room and nothing held; a held cell is judged like a row: dated, by every barrier's report and by a repair's listing (kept iff listed at or below its revision, else forgotten and refetched when there is room, a miss when there is none); undated (own, before its write-back is acknowledged), kept by both; expect is __residentGet per path after each event, null for a miss")]
    (directed ++ runGen 0x48454C44 (casesOf 150 genCase))

end Nimbus.Refine.HeldCases
