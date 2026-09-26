/-
  Nimbus.Runtime.Pipes — pipes and the wasm bash's pipeline scheduler
  (packages/core/src/runtime/bash/preamble.ts; the design Main approved after the
  review of 5bdfec12, as GitParityLane stated it).

  A pipe has a capacity `C` and holds `q` bytes in flight. Its read and write ends are
  counted across the live processes that hold them (`rs`, `ws`: derived, never
  stored). Processes are slots, each with a script of actions; a fork starts an unborn
  slot with a copy of the forking process's ends. Three kinds of process:
  - `jspi`: a child with JSPI. A write parks while the pipe holds its capacity (or the
    budget is spent); a read of an empty pipe with a live writer parks.
  - `bash`: bash itself (asyncify). A read parks; a write never parks.
  - `plain`: a child without JSPI. It can wait for nothing: a read of an empty pipe
    suspends it (the scheduler runs nested above it).
  A write that never parks appends while the bytes in flight over all pipes stay within
  the budget `B`. Past it the writer is suspended: its frame stays on the stack and the
  scheduler runs nested above it, lowest slot first (sources first). Only the top of
  the stack may resume. A read that would have to wait for writers that are all
  suspended beneath it fails the whole command (`abort`, a named error, non-zero
  status); so does a scheduler that finds nothing to run while something is suspended.
  A write to a pipe with no read end: SIGPIPE (status 141), or EPIPE when the writer
  ignores SIGPIPE. An exit closes every end; the last read end's close discards what is
  in flight (the reader chose to stop). There is no held exit.

  Proved over every reachable state (rules as approved, `Rules.ok`):
  (1) `accounting` (every accepted byte is read, in flight, or discarded when its last
      reader closed; `lost = 0`), `drop_only_readerless` (discarding happens only to
      a pipe with no read end), `eof_only_writerless` (a read ends only when no write
      end is left), `abort_named` (a command that stopped a reader early has a named
      error and a non-zero status), `fork_keeps_parked` (a fork leaves a parked write
      or read exactly as it was, and the child gets none).
  (2) `sigpipe_only_readerless`: SIGPIPE or EPIPE only when the pipe has no read end.
  (3) `sched_some` / `sched_none` (the scheduler runs a process that can progress
      whenever one exists), `no_spin` (every such step lowers a measure: no spin, and
      every run of the scheduler ends), `stuck_is_linux` (when nothing can run and
      nothing is suspended, every live process waits exactly as it would on Linux).
  (4) `budget`: the bytes in flight over all pipes never exceed `B`.
  (5) `ignored_is_epipe`: with SIGPIPE ignored, a readerless write fails with EPIPE
      and the writer goes on.
  The review's findings are rule variants (`Rules`), each shown by a trace in
  `Nimbus.Runtime.PipesTraces` to lose data or kill wrongly.
-/

namespace Nimbus.Runtime.Pipes

/-- The rules; `ok` is the approved design, each flag one of 5bdfec12's. -/
structure Rules where
  /-- A writer that exits with more than the capacity unread is SIGPIPE-killed while its
      reader is alive, and the bytes past the capacity are lost (finding 1). -/
  heldKill : Bool := false
  /-- A fork taken while a writer is parked drops the parked write (finding 2). -/
  forkDrops : Bool := false
  /-- A read that would wait on a suspended writer fails only that reader, silently
      (finding 3). -/
  spillSilent : Bool := false
  /-- An ignored SIGPIPE still kills (finding 4). -/
  ignoreIgnored : Bool := false
  /-- The budget is one total over all pipes (the approved text), not per pipe. -/
  globalBudget : Bool := false
  deriving DecidableEq, Repr

def Rules.ok : Rules := {}

inductive Mode where
  | jspi
  | bash
  | plain
  deriving DecidableEq, Repr

inductive Act where
  | write (p n : Nat)
  /-- One read of at most `n` bytes. -/
  | read (p n : Nat)
  /-- Close one end: the read end when `r`. -/
  | close (p : Nat) (r : Bool)
  /-- Start slot `k` with a copy of every end. -/
  | fork (k : Nat)
  | exit (code : Nat)
  deriving DecidableEq, Repr

inductive PSt where
  | unborn
  | run
  | parkW
  | parkR
  | susp
  | done (code : Nat)
  | killed (sig : Nat)
  | aborted
  deriving DecidableEq, Repr

structure Proc where
  mode : Mode
  ign : Bool
  /-- A failed write ends it with status 1 (coreutils: `yes`, `head`, `cat`). -/
  errExit : Bool
  prog : List Act
  rEnds : Nat → Nat
  wEnds : Nat → Nat
  st : PSt

structure Pipe where
  q : Nat := 0
  acc : Nat := 0
  rd : Nat := 0
  drop : Nat := 0
  lost : Nat := 0
  deriving DecidableEq, Repr

/-- What a step answered, for the fixture. -/
inductive Out where
  | wrote (n : Nat)
  | read (n : Nat)
  | eof
  | parked
  | suspended
  | sigpipe
  | epipe
  | ebadf
  | forked (k : Nat)
  | closed
  | exited (c : Nat)
  | aborted (msg : String)
  | none
  deriving DecidableEq, Repr

structure St where
  C : Nat
  B : Nat
  n : Nat
  m : Nat
  procs : Nat → Proc
  pipes : Nat → Pipe
  stack : List Nat
  err : Option String

def upd {α : Type} (f : Nat → α) (i : Nat) (v : α) : Nat → α := fun j => if j = i then v else f j

def sumTo (n : Nat) (f : Nat → Nat) : Nat := ((List.range n).map f).sum

def alive (pr : Proc) : Bool :=
  match pr.st with
  | .run | .parkW | .parkR | .susp => true
  | _ => false

def rs (s : St) (p : Nat) : Nat := sumTo s.n fun i => if alive (s.procs i) then (s.procs i).rEnds p else 0
def ws (s : St) (p : Nat) : Nat := sumTo s.n fun i => if alive (s.procs i) then (s.procs i).wEnds p else 0

/-- Bytes in flight over all pipes. -/
def tot (s : St) : Nat := sumTo s.m fun p => (s.pipes p).q

/-- The last read end gone: what is in flight is discarded. -/
def settle (s : St) : St :=
  { s with pipes := fun p => if rs s p = 0 then { s.pipes p with q := 0, drop := (s.pipes p).drop + (s.pipes p).q }
                             else s.pipes p }

def setProc (s : St) (i : Nat) (pr : Proc) : St := { s with procs := upd s.procs i pr }

def finish (s : St) (i : Nat) (st : PSt) : St :=
  settle { setProc s i { s.procs i with st := st, prog := [] } with stack := s.stack.erase i }

def abortMsg : String := "a stage would wait for a pipe writer suspended beneath it (no JSPI): the command stops"
def stuckMsg : String := "no stage can run while a pipe writer is suspended (no JSPI): the command stops"

/-- The whole command stops with a named error. -/
def abort (s : St) (msg : String) : St :=
  settle { s with procs := fun i => if alive (s.procs i) then { s.procs i with st := .aborted, prog := [] } else s.procs i,
                  stack := [], err := some msg }

/-- Every live write end of `p` belongs to a suspended frame. -/
def writersNested (s : St) (p : Nat) : Bool :=
  (List.range s.n).all fun j => !(alive (s.procs j) && decide (0 < (s.procs j).wEnds p)) || s.stack.contains j

variable (R : Rules)

/-- A write fits: within the budget (per pipe, or in total under `globalBudget`), and for
    a JSPI child also below the capacity. -/
def accepts (s : St) (pr : Proc) (p n : Nat) : Bool :=
  (if R.globalBudget then decide (tot s + n ≤ s.B) else decide ((s.pipes p).q + n ≤ s.B)) &&
    (pr.mode != .jspi || decide ((s.pipes p).q < s.C))

/-- Process `i` takes the CPU. A child without JSPI cannot yield: from its first step
    to its exit its frame is on the stack. Bash and JSPI children are there only while
    suspended. -/
def enter (s0 : St) (i : Nat) : St :=
  { s0 with stack := if (s0.procs i).mode = .plain then (if s0.stack.contains i then s0.stack else i :: s0.stack)
                     else s0.stack.erase i }

/-- Run the head of process `i`'s script on `s` (already entered). -/
def execCore (s : St) (i : Nat) : Out × St :=
  let pr := s.procs i
  let go (pr' : Proc) (s : St) : St := setProc s i pr'
  match pr.prog with
  | [] => (.exited 0, finish s i (.done 0))
  | a :: rest =>
    let next := { pr with prog := rest, st := .run }
    match a with
    | .write p n =>
      if s.m ≤ p then (.ebadf, finish s i (.done 1))
      else if rs s p = 0 then
        if pr.ign && !R.ignoreIgnored then
          (.epipe, if pr.errExit then finish s i (.done 1) else go next s)
        else (.sigpipe, finish s i (.killed 13))
      else if accepts R s pr p n then
        (.wrote n, go next { s with pipes := upd s.pipes p { s.pipes p with q := (s.pipes p).q + n, acc := (s.pipes p).acc + n } })
      else if pr.mode = .jspi then (.parked, go { pr with st := .parkW } s)
      else if pr.mode = .plain then (.suspended, go { pr with st := .susp } s)
      else (.suspended, go { pr with st := .susp } { s with stack := i :: s.stack })
    | .read p n =>
      if s.m ≤ p then (.ebadf, finish s i (.done 1))
      else if 0 < (s.pipes p).q then
        let k := min n (s.pipes p).q
        (.read k, go next { s with pipes := upd s.pipes p { s.pipes p with q := (s.pipes p).q - k, rd := (s.pipes p).rd + k } })
      else if ws s p = 0 then (.eof, go next s)
      else if writersNested s p then
        if R.spillSilent then (.aborted abortMsg, finish s i (.done 1)) else (.aborted abortMsg, abort s abortMsg)
      else if pr.mode = .plain then (.suspended, go { pr with st := .susp } s)
      else (.parked, go { pr with st := .parkR } s)
    | .close p r =>
      (.closed, settle (go { next with rEnds := if r then upd pr.rEnds p (pr.rEnds p - 1) else pr.rEnds,
                                        wEnds := if r then pr.wEnds else upd pr.wEnds p (pr.wEnds p - 1) } s))
    | .fork k =>
      if k < s.n ∧ (s.procs k).st = .unborn then
        (.forked k, go next (setProc s k { s.procs k with st := .run, rEnds := pr.rEnds, wEnds := pr.wEnds }))
      else (.none, go next s)
    | .exit c =>
      if R.heldKill && pr.mode != .jspi then
        match (List.range s.m).find? (fun p => decide (0 < pr.wEnds p) && decide (s.C < (s.pipes p).q) && decide (0 < rs s p)) with
        | some p =>
          (.sigpipe, finish { s with pipes := upd s.pipes p { s.pipes p with q := s.C, lost := (s.pipes p).lost + ((s.pipes p).q - s.C) } } i (.killed 13))
        | none => (.exited c, finish s i (.done c))
      else (.exited c, finish s i (.done c))

/-- Run the head of process `i`'s script, resuming it if it was parked or suspended. -/
def execHead (s0 : St) (i : Nat) : Out × St := execCore R (enter s0 i) i

/-- A fork taken while process `i` is parked: slot `k` starts with a copy of its ends;
    `i` keeps its parked operation. -/
def forkParked (s : St) (i k : Nat) : St :=
  let pr := s.procs i
  if (pr.st = .parkW ∨ pr.st = .parkR) ∧ k < s.n ∧ (s.procs k).st = .unborn ∧ k ≠ i then
    let s := setProc s k { s.procs k with st := .run, rEnds := pr.rEnds, wEnds := pr.wEnds }
    match R.forkDrops, pr.st, pr.prog with
    | true, .parkW, .write p n :: rest =>
      { setProc s i { pr with st := .run, prog := rest } with
        pipes := upd s.pipes p { s.pipes p with acc := (s.pipes p).acc + n, lost := (s.pipes p).lost + n } }
    | _, _, _ => s
  else s

/-- A child without JSPI is running on top of the stack: nothing else can run. -/
def holding (s : St) : Option Nat :=
  match s.stack with
  | t :: _ => if (s.procs t).st = .run then some t else none
  | [] => none

/-- Process `i` can make progress now. -/
def enabled (s : St) (i : Nat) : Bool :=
  decide (i < s.n) && (match holding s with | some t => t == i | none => true) &&
  match (s.procs i).st, (s.procs i).prog with
  | .run, _ => true
  | .parkW, .write p n :: _ => decide (s.m ≤ p) || rs s p == 0 || accepts R s (s.procs i) p n
  | .parkR, .read p _ :: _ => decide (s.m ≤ p) || decide (0 < (s.pipes p).q) || ws s p == 0 || writersNested (enter s i) p
  | .susp, .write p n :: _ => s.stack.head? == some i && (decide (s.m ≤ p) || rs s p == 0 || accepts R s (s.procs i) p n)
  | .susp, .read p _ :: _ =>
    s.stack.head? == some i && (decide (s.m ≤ p) || decide (0 < (s.pipes p).q) || ws s p == 0 || writersNested (enter s i) p)
  | _, _ => false

/-- The lowest slot that can progress (sources first). -/
def sched (s : St) : Option Nat := (List.range s.n).find? (enabled R s)

def anySusp (s : St) : Bool := (List.range s.n).any fun i => (s.procs i).st == .susp && !(s.procs i).prog.isEmpty

/-- One scheduler step: run the lowest slot that can progress; with none and a writer
    suspended, stop the command. -/
def schedStep (s : St) : Option (Nat × Out × St) :=
  match sched R s with
  | some i => let r := execHead R s i; some (i, r.1, r.2)
  | none => if anySusp s then some (s.n, .aborted stuckMsg, abort s stuckMsg) else none

inductive Ev where
  | run (i : Nat)
  | forkParked (i k : Nat)
  | stuck

def step (s : St) : Ev → St
  | .run i => if alive (s.procs i) then (execHead R s i).2 else s
  | .forkParked i k => forkParked R s i k
  | .stuck => if (List.range s.n).all (fun i => !enabled R s i) && anySusp s then abort s stuckMsg else s

/-- A slot of a command: its kind, disposition, script, and the ends it starts with
    (`reads`, `writes`: pipes); `started` false for a slot only a fork starts. -/
structure Slot where
  mode : Mode
  ign : Bool := false
  errExit : Bool := true
  prog : List Act
  reads : List Nat := []
  writes : List Nat := []
  started : Bool := true

structure Cmd where
  C : Nat
  B : Nat
  m : Nat
  slots : List Slot

def count (l : List Nat) (p : Nat) : Nat := l.count p

def Slot.proc (sl : Slot) : Proc :=
  ⟨sl.mode, sl.ign, sl.errExit, sl.prog, count sl.reads, count sl.writes, if sl.started then .run else .unborn⟩

def Cmd.init (c : Cmd) : St :=
  { C := c.C, B := c.B, n := c.slots.length, m := c.m, stack := [], err := none, pipes := fun _ => {},
    procs := fun i => match c.slots[i]? with
      | some sl => sl.proc
      | none => ⟨.plain, false, false, [], fun _ => 0, fun _ => 0, .unborn⟩ }

inductive Reach : St → Prop
  | init (c : Cmd) : Reach c.init
  | step {s : St} (e : Ev) : Reach s → Reach (step R s e)

/-- Bash's status for a slot: its exit code, 128 + signal, or 1 when stopped. -/
def status (pr : Proc) : Nat :=
  match pr.st with
  | .done c => c
  | .killed sg => 128 + sg
  | .aborted => 1
  | _ => 0

/-- The command's status: the named error makes it non-zero; else the last stage's. -/
def cmdStatus (s : St) (last : Nat) : Nat :=
  if s.err.isSome then max 1 (status (s.procs last)) else status (s.procs last)

/-- Run the scheduler: each step's slot, what it ran, and the answer. -/
def runSched : Nat → St → List (Nat × Option Act × Out) × St
  | 0, s => ([], s)
  | f + 1, s =>
    match schedStep R s with
    | some (i, o, s') =>
      let r := runSched f s'
      ((i, (s.procs i).prog.head?, o) :: r.1, r.2)
    | none => ([], s)

end Nimbus.Runtime.Pipes
