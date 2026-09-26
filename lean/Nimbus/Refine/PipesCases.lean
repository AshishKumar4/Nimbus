/-
  Nimbus.Refine.PipesCases — `lean/fixtures/pipes.json` for GitParityLane's
  `tests/unit/pipes-refinement.mjs` (`Nimbus.Runtime.Pipes`, the approved rules with a
  per-pipe budget; /mnt/scratch/nimbus/verify/release/pipes-design.md).

  Each case: `C` (capacity) and `B` (per-pipe budget; on a JSPI host it never binds and is
  set large), `pipes`, and `procs`, each `{pid, host: "jspi"|"local", kind: "bash"|"child",
  sigpipe: "default"|"ignore", exitsOnWriteError, reads: [pipe ids], writes: [pipe ids],
  started}` (pids are indices; a proc not started is started only by a fork). A jspi host
  maps both kinds to a process that parks; on a local host bash parks on reads only and a
  child never parks. Then `steps`, in the scheduler's order (lowest runnable pid first, a
  suspended frame resuming only from the top): `{pid, op, resumed, expect}`, with `op`
  `{"write":{pipe,n}}` | `{"read":{pipe,n}}` | `{"close":{pipe,end:"r"|"w"}}` |
  `{"fork":{child}}` | `{"exit":code}` | `"end"` (the script ran out: exit 0) |
  `"stuck"` (nothing can run while a frame is suspended: the command stops); `resumed`
  true when the pid was parked or suspended and this step completes its pending op;
  `expect` `{"wrote":n}` | `{"read":n}` | `"eof"` | `"parked"` | `"suspended"` | `"sigpipe"`
  | `"epipe"` | `{"forked":k}` | `"closed"` | `{"exited":c}` | `{"aborted":message}`.
  `final`: `status` per pid (exit code, 128 + signal, 1 when stopped by the command's
  error; 0 for a pid never run), `pipes` (`inFlight`, `read`, `discarded`), `error`.
  Cases with `"untestable"` state why the runtime cannot run them (SIGPIPE ignored:
  bash.wasm cannot tell the host its disposition).
-/

import Nimbus.Runtime.PipesTraces
import Nimbus.Refine.Json

namespace Nimbus.Refine.PipesCases

open Nimbus.Runtime.Pipes
open Nimbus.Runtime.PipesTraces
open Nimbus.Refine

def hostKind : Mode → String × String
  | .jspi => ("jspi", "child")
  | .bash => ("local", "bash")
  | .plain => ("local", "child")

def actJson : Act → Json
  | .write p n => .obj [("write", .obj [("pipe", .ofNat p), ("n", .ofNat n)])]
  | .read p n => .obj [("read", .obj [("pipe", .ofNat p), ("n", .ofNat n)])]
  | .close p r => .obj [("close", .obj [("pipe", .ofNat p), ("end", .str (if r then "r" else "w"))])]
  | .fork k => .obj [("fork", .obj [("child", .ofNat k)])]
  | .exit c => .obj [("exit", .ofNat c)]

def outJson : Out → Json
  | .wrote n => .obj [("wrote", .ofNat n)]
  | .read n => .obj [("read", .ofNat n)]
  | .eof => .str "eof"
  | .parked => .str "parked"
  | .suspended => .str "suspended"
  | .sigpipe => .str "sigpipe"
  | .epipe => .str "epipe"
  | .ebadf => .str "ebadf"
  | .forked k => .obj [("forked", .ofNat k)]
  | .closed => .str "closed"
  | .exited c => .obj [("exited", .ofNat c)]
  | .aborted m => .obj [("aborted", .str m)]
  | .none => .str "none"

def slotJson (k : Nat) (sl : Slot) (bashOnJspi : Bool) : Json :=
  let (h, kd) := hostKind sl.mode
  let kd := if sl.mode = .jspi && bashOnJspi then "bash" else kd
  .obj [("pid", .ofNat k), ("host", .str h), ("kind", .str kd), ("sigpipe", .str (if sl.ign then "ignore" else "default")),
    ("exitsOnWriteError", .bool sl.errExit), ("reads", .arr (sl.reads.map .ofNat)), ("writes", .arr (sl.writes.map .ofNat)),
    ("started", .bool sl.started)]

def runJson (name : String) (c : Cmd) (bashPids : List Nat := []) (extra : List (String × Json) := []) : Json := Id.run do
  let mut s := c.init
  let mut out : Array Json := #[]
  for _ in [0:400] do
    match schedStep Rules.ok s with
    | some (i, o, s') =>
      let pr := s.procs i
      let op : Json := if i = s.n then .str "stuck" else match pr.prog.head? with
        | some a => actJson a
        | none => .str "end"
      let resumed := pr.st == .parkW || pr.st == .parkR || pr.st == .susp
      out := out.push (.obj [("pid", .ofNat i), ("op", op), ("resumed", .bool resumed), ("expect", outJson o)])
      s := s'
    | none => break
  let procs := (c.slots.zip (List.range c.slots.length)).map fun (sl, k) => slotJson k sl (bashPids.contains k)
  return .obj ([("name", .str name), ("C", .ofNat c.C), ("B", .ofNat c.B), ("pipes", .ofNat c.m),
    ("procs", .arr procs), ("steps", .arr out.toList),
    ("final", .obj [("status", .arr ((List.range s.n).map fun i => .ofNat (status (s.procs i)))),
      ("pipes", .arr ((List.range s.m).map fun p => .obj [("inFlight", .ofNat (s.pipes p).q),
        ("read", .ofNat (s.pipes p).rd), ("discarded", .ofNat (s.pipes p).drop)])),
      ("error", match s.err with | some e => .str e | none => .null)])] ++ extra)

/-- The review's traces, and their JSPI-host twins. -/
def jspiOf (c : Cmd) : Cmd := { c with B := 1000, slots := c.slots.map fun sl => { sl with mode := .jspi } }

def directed : List Json :=
  [ runJson "seq | uniq -c | wc -l (local host)" seqUniqWc,
    runJson "seq | uniq -c | wc -l (jspi host)" (jspiOf seqUniqWc),
    runJson "fork in a loop | wc -c (local host)" forkLoop,
    runJson "yes | head -1 (local host)" (yesHead false),
    runJson "yes | head -1 (jspi host)" (jspiOf (yesHead false)),
    runJson "yes | head -c | wc -c past the budget (local host)" overBudget,
    runJson "yes | head -c | wc -c (jspi host)" (jspiOf overBudget),
    runJson "yes | while read | wc -c (local host)" bashMiddle,
    runJson "trap \"\" PIPE; yes | head -1 (local host)" (yesHead true)
      (extra := [("untestable", .str "bash.wasm has no sigaction import: the host cannot see an ignored SIGPIPE")]),
    runJson "a JSPI writer parks at capacity and resumes as the reader drains (jspi host)" parkedFork ]

def mode : Gen Mode := do
  let k ← below 3
  return if k == 0 then .jspi else if k == 1 then .bash else .plain

/-- A pipeline of 2-4 stages on one host: a source, middles copying, a sink reading. -/
def genCase : Gen (Option Json) := do
  let jspi := (← below 3) == 0
  let st := (← below 3) + 2
  let C := 4
  let bk ← below 3
  let B := if jspi then 1000 else bk * 4 + 6
  let mut slots : List Slot := []
  for k in [0:st] do
    let mk ← below 3
    let md := if jspi then Mode.jspi else if mk == 0 then .bash else .plain
    let ign := (← below 10) == 0
    let mut prog : List Act := []
    if k == 0 then
      let lines := (← below 12) + 1
      for _ in [0:lines] do prog := prog ++ [.write 0 ((← below 3) + 1)]
    else if k + 1 == st then
      let reads := (← below 12) + 1
      for _ in [0:reads] do prog := prog ++ [.read (k - 1) ((← below 3) + 1)]
    else
      let n := (← below 8) + 1
      for _ in [0:n] do
        if (← below 2) == 0 then prog := prog ++ [.read (k - 1) ((← below 3) + 1)]
        else prog := prog ++ [.write k ((← below 3) + 1)]
    if (← below 5) == 0 then prog := prog ++ [.exit (← below 2)]
    let reads := if k == 0 then [] else [k - 1]
    let writes := if k + 1 == st then [] else [k]
    slots := slots ++ [{ mode := md, ign := ign, prog := prog, reads := reads, writes := writes }]
  let c : Cmd := { C := C, B := B, m := st - 1, slots := slots }
  let ignored := slots.any (·.ign)
  return some (runJson s!"random {if jspi then "jspi" else "local"} {st}-stage" c
    (extra := if ignored then [("untestable", .str "bash.wasm has no sigaction import: the host cannot see an ignored SIGPIPE")] else []))

def fixture : String :=
  fixtureText [("fixture", .str "pipes"), ("model", .str "Nimbus.Runtime.Pipes (Rules.ok, per-pipe budget)"),
      ("note", .str "steps are in the model scheduler's order; a jspi host parks every writer at capacity and every reader of an empty pipe with a live writer; a local host parks bash on reads only, and a child never parks: a non-parking write appends while its pipe holds at most B, else the writer is suspended and the scheduler runs nested; a read that would wait on writers all suspended beneath it, or a scheduler with nothing to run while a frame is suspended, stops the command with the named error; the last read end's close discards what is in flight")]
    (directed ++ runGen 0x50495045 (casesOf 150 genCase))

end Nimbus.Refine.PipesCases
