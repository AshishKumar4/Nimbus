/-
  Nimbus.Refine.LedgerCases — `lean/fixtures/n18-ledger.json` for NodeNoMirrorBuild's
  `tests/unit/n18-ledger-refinement.mjs` (`Nimbus.Vfs.Ledger.step`).

  Each case: a limit, the session DO's own bytes at start (no facets), then
  operations run in order through ProcessFiles' ledger, each with the expected
  answer and the ledger after it:
  - `{"op":"write","bytes"}`: a session-DO write admitted for `bytes`.
  - `{"op":"fill","facet","bytes"}`: a facet fill.
  - `{"op":"delSess","bytes"}`, `{"op":"delFacet","facet"}` (`facets.delete`),
    `{"op":"settle","facet","bytes"}` (a reported databaseSize: the row becomes
    min(bytes, recorded); nothing for an unknown facet), `{"op":"report","facet","bytes"}`
    (a reported databaseSize checked against the record: the row becomes max(bytes,
    recorded), created if absent; the excess is `overshoot`), `{"op":"abort","facet"}`, `{"op":"restart"}` (the ledger is re-read; reservations
    are released).
  - `{"op":"reserve","id","bytes"}`: admitted like a write of `bytes` (ENOSPC when it
    does not fit); on ok the reservation grows by `bytes`.
  - `{"op":"draw","id","bytes"}`: a write against the reservation: what it covers is
    taken from it without admission; the rest, if any, is admitted like a write (on
    ENOSPC nothing changes); on ok the session grows by `bytes`.
  - `{"op":"refund","id","bytes"}`: a drawn write rolled back: t = min(bytes, session)
    moves from the session back to the reservation.
  - `{"op":"release","id"}`, `{"op":"releaseAll"}`.
  `expect`: `"ok"` or `"ENOSPC"`; `ledger`: `{used (reservations included), reserved,
  reservations:{id: bytes} (none at 0), overshoot (cumulative reported-over-admitted bytes),
  session, facets:{name: bytes}}`. A refused operation changes nothing.
-/

import Nimbus.Vfs.Ledger
import Nimbus.Refine.Json

namespace Nimbus.Refine.LedgerCases

open Nimbus.Vfs.Ledger
open Nimbus.Refine

def fname (n : Nat) : String := s!"f{n}"

def ledgerJson (s : St) : Json :=
  .obj [("used", .ofNat (used s)), ("overshoot", .ofNat s.over), ("session", .ofNat s.sess),
    ("facets", .obj (s.facets.map fun x => (fname x.1, .ofNat x.2))),
    ("reserved", .ofNat (sumB s.res)),
    ("reservations", .obj (s.res.map fun x => (s!"r{x.1}", .ofNat x.2)))]

def opJson : Op → Json
  | .write b => .obj [("op", .str "write"), ("bytes", .ofNat b)]
  | .fill n b => .obj [("op", .str "fill"), ("facet", .str (fname n)), ("bytes", .ofNat b)]
  | .delSess b => .obj [("op", .str "delSess"), ("bytes", .ofNat b)]
  | .delFacet n => .obj [("op", .str "delFacet"), ("facet", .str (fname n))]
  | .settle n b => .obj [("op", .str "settle"), ("facet", .str (fname n)), ("bytes", .ofNat b)]
  | .report n b => .obj [("op", .str "report"), ("facet", .str (fname n)), ("bytes", .ofNat b)]
  | .abort n => .obj [("op", .str "abort"), ("facet", .str (fname n))]
  | .restart => .obj [("op", .str "restart")]
  | .reserve r b => .obj [("op", .str "reserve"), ("id", .str s!"r{r}"), ("bytes", .ofNat b)]
  | .draw r b => .obj [("op", .str "draw"), ("id", .str s!"r{r}"), ("bytes", .ofNat b)]
  | .refund r t => .obj [("op", .str "refund"), ("id", .str s!"r{r}"), ("bytes", .ofNat t)]
  | .release r => .obj [("op", .str "release"), ("id", .str s!"r{r}")]
  | .releaseAll => .obj [("op", .str "releaseAll")]

def withResult (j : Json) (o : Out) (s : St) : Json :=
  match j with
  | .obj kvs => .obj (kvs ++ [("expect", .str (if o = .ok then "ok" else "ENOSPC")), ("ledger", ledgerJson s)])
  | j => j

def run (s0 : St) (ops : List Op) : Json := Id.run do
  let mut s := s0
  let mut out : Array Json := #[]
  for op in ops do
    let (o, s') := step s op
    s := s'
    out := out.push (withResult (opJson op) o s)
  return .obj [("limit", .ofNat s0.limit), ("session", .ofNat s0.sess), ("steps", .arr out.toList)]

def genOp : Gen Op := do
  let k ← below 22
  let b ← below 40
  if k < 6 then return .write b
  else if k < 9 then return .fill (← below 3) b
  else if k < 10 then return .delSess (← below 20)
  else if k < 11 then return .delFacet (← below 3)
  else if k < 12 then
    if (← below 2) == 0 then return .settle (← below 3) (← below 30) else return .report (← below 3) (← below 60)
  else if k < 13 then return .abort (← below 3)
  else if k < 14 then return .restart
  else if k < 16 then return .reserve (← below 3) ((← below 30) + 1)
  else if k < 19 then return .draw (← below 3) (← below 25)
  else if k < 20 then return .refund (← below 3) (← below 10)
  else if k < 21 then return .release (← below 3)
  else return .releaseAll

def genCase : Gen (Option Json) := do
  let sess ← below 41
  let n := (← below 16) + 8
  let mut ops : List Op := []
  for _ in [0:n] do ops := ops ++ [← genOp]
  return some (run ⟨100, sess, [], 0, []⟩ ops)

/-- `a_ledger_trace`, reached from an empty ledger. -/
def directed : List Json :=
  [ run ⟨100, 40, [], 0, []⟩ [.fill 1 20, .write 20, .write 60, .abort 1, .restart, .delFacet 1, .write 60],
    -- an over-report: the ledger takes it, refuses until a delete (an_over_report_refuses)
    run ⟨100, 10, [], 0, []⟩ [.fill 1 20, .report 1 90, .write 1, .delFacet 1, .write 1],
    -- a reservation drawn within it is admitted even with a facet over its bytes
    -- (admitting_zero_can_be_refused); a draw past it admits the rest
    run ⟨100, 10, [], 0, []⟩ [.fill 1 20, .reserve 7 30, .report 1 90, .draw 7 10, .draw 7 20, .write 1,
      .reserve 8 5, .delFacet 1, .reserve 8 5, .draw 8 12, .refund 8 4, .release 8, .restart] ]

def fixture : String :=
  fixtureText [("fixture", .str "n18-ledger"), ("model", .str "Nimbus.Vfs.Ledger.step"),
      ("note", .str "used = session + recorded facet bytes + reservations; an admitted operation (write, fill, reserve) is refused with ENOSPC, changing nothing, when it does not fit; nothing is evictable. A draw takes what its reservation covers without admission and admits only the rest, refund moves bytes from the session back to the reservation, release/releaseAll/restart drop reservations")]
    (directed ++ runGen 0x4C454447 (casesOf 150 genCase))

end Nimbus.Refine.LedgerCases
