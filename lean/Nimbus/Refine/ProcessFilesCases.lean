/-
  Nimbus.Refine.ProcessFilesCases — `lean/fixtures/process-files.json` for the
  Filesystem lane's phase-2 bridge `tests/unit/process-files-refinement.mjs`.

  Two kinds of case.

  `descriptors`: one backend, with `writeRange` or without (a buffered handle,
  cap 8 pending bytes per handle; EFBIG past it, nothing acknowledged). Processes
  open, write, fsync, close, are released (`releaseProcess`: every handle
  flushed, then later use EBADF) or killed (nothing flushed; the loss report
  names exactly the handles with pending bytes). A buffered flush reads the file,
  applies the handle's pending writes in order (an `append` one at the end as it
  is then), and writes it back. A write-through `append` takes the end in the same
  call. `read` expects the file's bytes after each step, so two handles on one
  path are checked at flush granularity (`ProcessFiles` (2)). After it, Linux
  page-cache semantics (Main's ruling on 98f85d11 P2): `readFd` (the handle's
  process's view of its path), `readAs pid path` and `statAs pid path` (`size`), by
  every process with a live handle and by an observer (pid 3). A process sees its own
  handles' pending writes on the path merged in, handle by handle in open order, by the
  merge a flush does (`viewAs_is_flush`); another process sees the flushed file
  (`viewAs_other`). `null`: no such file.

  `leases`: a root link `/x → /dst`; owners take and drop leases; mutations
  (`writeFile`, `unlink`, `mkdir`) as an owner or as none. EBUSY when the literal or
  the resolved path overlaps another owner's lease; EPERM when an owner mutates
  outside its own root; `writeFile` returns a receipt whose `after` must equal
  the path's revision read right after and `before` the one read right before
  (`ProcessFiles` (3), (4)).
-/

import Nimbus.Vfs.ProcessFiles
import Nimbus.Refine.Json

namespace Nimbus.Refine.ProcessFilesCases

open Nimbus.Refine

def cap : Nat := 8

structure H where
  fd : Nat
  pid : Nat
  path : Nat
  append : Bool
  pos : Nat
  /-- Buffered writes: (offset or none for append, bytes). -/
  pending : List (Option Nat × List Nat)
  deriving Inhabited

structure D where
  files : Nat → Option (List Nat)
  hs : List H
  dead : List Nat
  nextFd : Nat

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β := fun y => if y = x then b else f y

def writeAt (file : List Nat) (off : Nat) (b : List Nat) : List Nat :=
  let padded := file ++ List.replicate (off + b.length - file.length) 0
  (List.range padded.length).map fun i => if off ≤ i ∧ i < off + b.length then b.getD (i - off) 0 else padded.getD i 0

def applyPending (file : List Nat) (ws : List (Option Nat × List Nat)) : List Nat :=
  ws.foldl (fun f (o, b) => writeAt f (o.getD f.length) b) file

def bytesStr (b : List Nat) : String := String.mk (b.map fun n => Char.ofNat (97 + n))

def fname (p : Nat) : String := s!"/f{p}"

def flushH (d : D) (h : H) : D :=
  { d with files := upd d.files h.path (some (applyPending ((d.files h.path).getD []) h.pending)),
           hs := d.hs.map fun g => if g.fd = h.fd then { g with pending := [] } else g }

/-- What `pid` reads at `p` (Linux page-cache semantics, Main's ruling on 98f85d11 P2):
    the flushed file with its own handles' pending writes merged in, handle by handle
    in open order, by the merge a flush does; another process's pending writes are not
    seen. `none`: no file. -/
def viewAs (d : D) (pid p : Nat) : Option (List Nat) :=
  (d.files p).map fun f => ((d.hs.filter fun h => h.pid == pid && h.path == p).foldl (fun f h => applyPending f h.pending) f)

/-- Flushing handles one after another (`releaseProcess` flushes a process's handles in
    open order). -/
def flushAll (d : D) (hs : List H) : D := hs.foldl flushH d

theorem flushH_files (d : D) (h : H) (p : Nat) :
    (flushH d h).files p = if p = h.path then some (applyPending ((d.files h.path).getD []) h.pending) else d.files p := by
  simp only [flushH, upd]

theorem flushAll_files (p : Nat) : ∀ (hs : List H) (d : D), (∀ h ∈ hs, h.path = p) → d.files p ≠ none →
    (flushAll d hs).files p = (d.files p).map fun f => hs.foldl (fun f h => applyPending f h.pending) f := by
  intro hs
  induction hs with
  | nil => intro d _ _; simp only [flushAll, List.foldl_nil]; cases d.files p <;> rfl
  | cons h hs ih =>
    intro d hp hn
    simp only [flushAll, List.foldl_cons] at ih ⊢
    have hh : h.path = p := hp h (List.mem_cons_self _ _)
    have e1 : (flushH d h).files p = some (applyPending ((d.files p).getD []) h.pending) := by
      rw [flushH_files, if_pos hh.symm, hh]
    rw [ih _ (fun g hg => hp g (List.mem_cons_of_mem _ hg)) (by rw [e1]; simp), e1]
    cases hd : d.files p with
    | none => exact absurd hd hn
    | some f => simp

/-- The pending holder reads exactly what the file holds once its handles on the path
    are flushed (as `releaseProcess` would), and no other process's pending write shows. -/
theorem viewAs_is_flush (d : D) (pid p : Nat) (hn : d.files p ≠ none) :
    viewAs d pid p = (flushAll d (d.hs.filter fun h => h.pid == pid && h.path == p)).files p := by
  rw [flushAll_files p _ d (fun h hh => by
    have := (List.mem_filter.mp hh).2
    simp only [Bool.and_eq_true, beq_iff_eq] at this
    exact this.2) hn]
  rfl

/-- A process with no handle on the path reads the flushed file. -/
theorem viewAs_other (d : D) (pid p : Nat) (h : ∀ g ∈ d.hs, g.path = p → g.pid ≠ pid) :
    viewAs d pid p = d.files p := by
  unfold viewAs
  have : (d.hs.filter fun g => g.pid == pid && g.path == p) = [] :=
    List.filter_eq_nil_iff.mpr fun g hg => by
      have := h g hg
      by_cases e : g.path = p
      · simp [this e]
      · simp [e]
  rw [this]
  cases d.files p <;> rfl

def optBytes : Option (List Nat) → Json
  | some f => .str (bytesStr f)
  | none => .null

/-- The checks after a step: each live handle's `readFd`, and `readAs`/`statAs` of both
    paths by every process with a live handle and by an observer (pid 3). -/
def views (d : D) : List Json :=
  let pids := ((d.hs.map (·.pid)).eraseDups ++ [3])
  (d.hs.map fun h => .obj [("op", .str "readFd"), ("fd", .ofNat h.fd), ("expect", optBytes (viewAs d h.pid h.path))]) ++
  pids.flatMap fun pid => [0, 1].flatMap fun p =>
    [.obj [("op", .str "readAs"), ("pid", .ofNat pid), ("path", .str (fname p)), ("expect", optBytes (viewAs d pid p))],
     .obj [("op", .str "statAs"), ("pid", .ofNat pid), ("path", .str (fname p)),
       ("expect", match viewAs d pid p with | some f => .obj [("size", .ofNat f.length)] | none => .null)]]

def genDescCase : Gen (Option Json) := do
  let wr := (← below 2) == 0
  let mut d : D := ⟨fun _ => none, [], [], 0⟩
  let mut out : Array Json := #[]
  let n := (← below 20) + 8
  for _ in [0:n] do
    let k ← below 12
    let live := d.hs
    if k < 3 || live.isEmpty then
      let pid := (← below 2) + 1
      if d.dead.contains pid then continue
      let p ← below 2
      let app := (← below 3) == 0
      let tr := !app && (← below 4) == 0
      let file := if tr then [] else (d.files p).getD []
      d := { d with files := upd d.files p (some file), hs := d.hs ++ [⟨d.nextFd, pid, p, app, 0, []⟩], nextFd := d.nextFd + 1 }
      out := out.push (.obj [("op", .str "open"), ("pid", .ofNat pid), ("fd", .ofNat (d.nextFd - 1)), ("path", .str (fname p)),
        ("append", .bool app), ("trunc", .bool tr)])
    else if k < 7 then
      let h ← pick live
      let len := (← below 4) + 1
      let b := (List.range len).map fun i => (h.fd * 3 + i + len) % 26
      if wr then
        let file := (d.files h.path).getD []
        let off := if h.append then file.length else h.pos
        d := { d with files := upd d.files h.path (some (writeAt file off b)),
                      hs := d.hs.map fun g => if g.fd = h.fd then { g with pos := off + len } else g }
        out := out.push (.obj [("op", .str "write"), ("fd", .ofNat h.fd), ("bytes", .str (bytesStr b)), ("expect", .str "ok")])
      else
        let used := (h.pending.map (·.2.length)).foldl (· + ·) 0
        if used + len > cap then
          out := out.push (.obj [("op", .str "write"), ("fd", .ofNat h.fd), ("bytes", .str (bytesStr b)),
            ("expect", .obj [("error", .str "EFBIG")])])
        else
          let w : Option Nat × List Nat := (if h.append then none else some h.pos, b)
          d := { d with hs := d.hs.map fun g => if g.fd = h.fd then { g with pending := g.pending ++ [w], pos := g.pos + len } else g }
          out := out.push (.obj [("op", .str "write"), ("fd", .ofNat h.fd), ("bytes", .str (bytesStr b)), ("expect", .str "ok")])
    else if k < 8 then
      let h ← pick live
      d := flushH d h
      out := out.push (.obj [("op", .str "fsync"), ("fd", .ofNat h.fd), ("expect", .str "ok")])
    else if k < 10 then
      let h ← pick live
      d := flushH d h
      d := { d with hs := d.hs.filter (·.fd != h.fd) }
      out := out.push (.obj [("op", .str "close"), ("fd", .ofNat h.fd), ("expect", .str "ok")])
    else if k < 11 then
      let pid := (← pick live).pid
      for h in d.hs do if h.pid == pid then d := flushH d h
      let fds := (d.hs.filter (·.pid == pid)).map (·.fd)
      d := { d with hs := d.hs.filter (·.pid != pid), dead := d.dead ++ [pid] }
      out := out.push (.obj [("op", .str "release"), ("pid", .ofNat pid)])
      if let some fd := fds.head? then
        out := out.push (.obj [("op", .str "write"), ("fd", .ofNat fd), ("bytes", .str "z"), ("expect", .obj [("error", .str "EBADF")])])
    else
      let pid := (← pick live).pid
      let lost := (d.hs.filter fun h => h.pid == pid && !h.pending.isEmpty).map (·.fd)
      d := { d with hs := d.hs.filter (·.pid != pid), dead := d.dead ++ [pid] }
      out := out.push (.obj [("op", .str "kill"), ("pid", .ofNat pid), ("lost", .arr (lost.map Json.ofNat))])
    for p in [0, 1] do
      out := out.push (.obj [("op", .str "read"), ("path", .str (fname p)),
        ("expect", match d.files p with | some f => .str (bytesStr f) | none => .null)])
    for v in views d do out := out.push v
  return some (.obj [("kind", .str "descriptors"), ("writeRange", .bool wr), ("cap", .ofNat cap), ("steps", .arr out.toList)])

/-! ## Leases -/

abbrev Path := List String

def key (p : Path) : String := "/" ++ "/".intercalate p

def resolveX (p : Path) : Path := Nimbus.Vfs.ProcessFiles.resolve ["x"] ["dst"] p

def overlap := Nimbus.Vfs.ProcessFiles.overlap

def leaseAnswer (leases : List (Nat × Path)) (owner : Nat) (p : Path) : Option String :=
  let rp := resolveX p
  if leases.any fun (o, r) => o != owner && (overlap p r || overlap rp r) then some "EBUSY"
  else match leases.find? (·.1 == owner) with
    | some (_, r) => if r.isPrefixOf rp then none else some "EPERM"
    | none => none

def paths : List Path := [["dst"], ["dst", "f"], ["dst", "g"], ["x", "f"], ["x", "g"], ["a"], ["a", "b"]]

def genLeaseCase : Gen (Option Json) := do
  let mut leases : List (Nat × Path) := []
  let mut out : Array Json := #[.obj [("op", .str "mkdir"), ("path", .str "/dst"), ("expect", .str "ok")],
    .obj [("op", .str "symlink"), ("path", .str "/x"), ("target", .str "/dst"), ("expect", .str "ok")],
    .obj [("op", .str "mkdir"), ("path", .str "/a"), ("expect", .str "ok")]]
  let n := (← below 14) + 6
  for _ in [0:n] do
    let k ← below 10
    let owner ← below 3
    let p ← pick paths
    if k < 2 then
      if owner != 0 && !(leases.any (·.1 == owner)) then
        let r := resolveX p
        if leases.any fun (_, l) => overlap r l then
          out := out.push (.obj [("op", .str "lease"), ("owner", .ofNat owner), ("path", .str (key p)),
            ("expect", .obj [("error", .str "EBUSY")])])
        else
          leases := leases ++ [(owner, r)]
          out := out.push (.obj [("op", .str "lease"), ("owner", .ofNat owner), ("path", .str (key p)), ("expect", .str "ok")])
    else if k < 3 then
      if leases.any (·.1 == owner) then
        leases := leases.filter (·.1 != owner)
        out := out.push (.obj [("op", .str "unlease"), ("owner", .ofNat owner)])
    else if p != ["dst"] && p != ["a"] then
      let ans := leaseAnswer leases owner p
      let expect := match ans with | some e => Json.obj [("error", .str e)] | none => .str "ok"
      out := out.push (.obj [("op", .str "writeFile"), ("owner", .ofNat owner), ("path", .str (key p)),
        ("bytes", .str "q"), ("receipt", .bool ans.isNone), ("expect", expect)])
  return some (.obj [("kind", .str "leases"), ("steps", .arr out.toList)])

def fixture : String :=
  fixtureText [("fixture", .str "process-files"), ("model", .str "Nimbus.Vfs.ProcessFiles"),
      ("note", .str "descriptors: bytes are letters; open creates the file (O_CREAT); read is a process holding nothing; readFd/readAs/statAs: the process's own pending writes on the path merged in (its handles in open order, the flush merge), other processes' not; pid 3 holds nothing; owner 0 = no lease; leases: a lease root is the resolved path; mutations check literal and resolved paths by overlap")]
    (runGen 0x50465331 (do
      let a ← casesOf 120 genDescCase
      let b ← casesOf 60 genLeaseCase
      return a ++ b))

end Nimbus.Refine.ProcessFilesCases
