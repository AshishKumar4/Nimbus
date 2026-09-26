/-
  Nimbus.Refine.CompositePermCases — `lean/fixtures/composite-perm.json` for
  NodeNoMirrorBuild's `tests/unit/composite-perm-refinement.mjs`: permissions
  through `CompositeVFS` (`Nimbus.Vfs.CompositePerm.cOp`).

  Each case: backends (`b0` is the root), each with `modes` (true: a SqliteVFS, every
  entry chowned and chmodded as listed; false: a MemoryVFS, modes ignored), its root's
  mode and owner, and entries in creation order (parents first; `symlink` entries only
  in mounted backends); mounts; then steps, each run on `composite.as(cred of as)`
  with the principals in the header, carrying state from step to step. `expect`:
  `"ok"`, `null`, `{"kind", "mode", "uid", "gid"}` (mode without type bits; mode
  null when the backend reports none), `{"bytes"}`, `{"names"}` (sorted) or
  `{"error"}`. A file `writeFile` creates is mode 0644, owned by the writer's uid
  and primary gid. `final`: each backend's entries after the steps.
-/

import Nimbus.Vfs.CompositePerm
import Nimbus.Refine.Json

namespace Nimbus.Refine.CompositePermCases

open Nimbus.Vfs.CompositePerm
open Nimbus.Refine

def key (p : Path) : String := "/" ++ "/".intercalate p

instance : Inhabited Cred := ⟨⟨0, 0, [0]⟩⟩

def creds : List Cred := [⟨0, 0, [0]⟩, ⟨1, 1, [1, 10]⟩, ⟨2, 2, [2]⟩]

def credJson (c : Cred) : Json :=
  .obj [("uid", .ofNat c.uid), ("gid", .ofNat c.gid), ("groups", .arr (c.groups.map .ofNat))]

def metaJson (m : Meta) : List (String × Json) := [("mode", .ofNat m.mode), ("uid", .ofNat m.uid), ("gid", .ofNat m.gid)]

def targetStr (abs : Bool) (t : List String) : String := (if abs then "/" else "") ++ "/".intercalate t

def entJson (x : Path × BEnt) : Json :=
  let extra : List (String × Json) := match x.2.k with
    | .dir => [("kind", .str "directory")]
    | .file n => [("kind", .str "file"), ("bytes", .str s!"v{n}")]
    | .link a t => [("kind", .str "symlink"), ("target", .str (targetStr a t))]
  .obj ([("path", .str (key x.1))] ++ extra ++ metaJson x.2.m)

def backendJson (b : Backend) : Json :=
  .obj [("modes", .bool b.modes), ("root", .obj (metaJson b.root)), ("entries", .arr (b.ents.map entJson))]

def outJson : Out → Json
  | .ok => .str "ok"
  | .null => .null
  | .stat k m => .obj ([("kind", .str k)] ++ match m with
      | some m => metaJson m
      | none => [("mode", .null), ("uid", .null), ("gid", .null)])
  | .bytes n => .obj [("bytes", .str s!"v{n}")]
  | .names l => .obj [("names", .arr (l.map .str))]
  | .err e => .obj [("error", .str e)]

def opJson (c : Cred) (op : Op) (p : Path) (o : Out) : Json :=
  let base (name : String) (extra : List (String × Json)) : Json :=
    .obj ([("as", .ofNat c.uid), ("op", .str name), ("path", .str (key p))] ++ extra ++ [("expect", outJson o)])
  match op with
  | .stat => base "stat" []
  | .readdir => base "readdir" []
  | .readFile => base "readFile" []
  | .writeFile n => base "writeFile" [("bytes", .str s!"v{n}")]
  | .unlink => base "unlink" []

def names : List String := ["h", "pc", "q", "f", "x"]
def points : List Path := [["h", "pc"], ["pc"], ["h", "q", "m"]]
def dirModes : List Nat := [0o755, 0o700, 0o750, 0o711, 0o1777, 0o770, 0o755]
def fileModes : List Nat := [0o644, 0o600, 0o640, 0o666, 0o604]

def genMeta (dir : Bool) : Gen Meta := do
  return ⟨← pick (if dir then dirModes else fileModes), ← pick [0, 1, 2], ← pick [0, 1, 2, 10]⟩

def genPath : Gen Path := do
  let n := (← below 3) + 1
  let mut p := []
  for _ in [0:n] do p := p ++ [← pick names]
  return p

/-- Add `p` (parents as directories first) unless a prefix is a non-directory or `p` exists. -/
def addEnt (b : Backend) (p : Path) (k : K) : Gen Backend := do
  let blocked := (List.range (p.length - 1)).any fun i =>
    b.ents.any fun x => x.1 == p.take (i + 1) && x.2.k != .dir
  if p = [] || b.ents.any (·.1 == p) || blocked then return b
  let mut b := b
  for i in [0:p.length - 1] do
    let q := p.take (i + 1)
    if !b.ents.any (·.1 == q) then b := { b with ents := b.ents ++ [(q, ⟨.dir, ← genMeta true⟩)] }
  let dir := match k with | .dir => true | _ => false
  return { b with ents := b.ents ++ [(p, ⟨k, ← genMeta dir⟩)] }

def genTarget : Gen K := do
  let k ← below 5
  if k == 0 then return .link true [← pick names]
  else if k == 1 then return .link true [← pick names, ← pick names]
  else if k == 2 then return .link false ["..", ← pick names]
  else if k == 3 then return .link false ["..", "..", ← pick names]
  else return .link false [← pick names]

def genBackend (links : Bool) (n : Nat) (v : Nat) : Gen Backend := do
  let modes := (← below 5) != 0
  let rm ← genMeta true
  let mut b : Backend := { modes := modes, root := rm, ents := [] }
  for i in [0:n] do
    let p ← genPath
    let k ← below 6
    let kind ← if k < 2 then pure K.dir else if k < 5 || !links then pure (K.file (v + i)) else genTarget
    b ← addEnt b p kind
  return b

def genOpPath (ms : List Mnt) : Gen Path := do
  if (← below 3) == 0 then
    let m ← pick (ms.map (·.point) ++ [[]])
    let extra ← below 3
    let mut p := m
    for _ in [0:extra] do p := p ++ [← pick names]
    if p = [] then p := [← pick names]
    return p
  else genPath

def genOp (v : Nat) : Gen Op := do
  let k ← below 10
  if k < 3 then return .stat
  else if k < 5 then return .readdir
  else if k < 7 then return .readFile
  else if k < 9 then return .writeFile v
  else return .unlink

def genCase : Gen (Option Json) := do
  let mut ms : List Mnt := []
  let mut bid := 1
  for pt in points do
    if (← below 2) == 0 then
      ms := ms ++ [⟨pt, bid⟩]
      bid := bid + 1
  if ms.isEmpty then return none
  -- the root: modes always (SqliteVFS), no links (the composite follows those)
  let r0 ← genBackend false ((← below 6) + 3) 1
  let mut root := { r0 with modes := true, root := ⟨0o755, 0, 0⟩ }
  -- sometimes the root holds the directories above a mount point, with their own modes
  for m in ms do
    for i in [1:m.point.length] do
      if (← below 2) == 0 then root ← addEnt root (m.point.take i) .dir
  let mut bks : List (Nat × Backend) := [(0, root)]
  for m in ms do
    bks := bks ++ [(m.bk, ← genBackend true ((← below 5) + 1) 20)]
  let get (l : List (Nat × Backend)) (k : Nat) : Backend :=
    ((l.find? (·.1 == k)).map (·.2)).getD { modes := false, root := synthMeta, ents := [] }
  let mut S : St := { mounts := ms, bks := get bks }
  let S0 := S
  let mut steps : Array Json := #[]
  let n := (← below 10) + 6
  for i in [0:n] do
    let c ← pick creds
    let p ← genOpPath ms
    let op ← genOp (40 + i)
    let (o, S') := cOp S c op p
    S := S'
    steps := steps.push (opJson c op p o)
  let ks := bks.map (·.1)
  return some (.obj [("mounts", .arr (ms.map fun m => .obj [("point", .str (key m.point)), ("backend", .str s!"b{m.bk}")])),
    ("backends", .obj (ks.map fun k => (s!"b{k}", backendJson (S0.bks k)))),
    ("steps", .arr steps.toList),
    ("final", .obj (ks.map fun k => (s!"b{k}", .arr ((S.bks k).ents.map entJson))))])

/-- The perm.mjs trace (`the_perm_trace`). -/
def directed : Json :=
  let S := permTrace
  let steps : List (Cred × Op × Path) :=
    [(u2, .stat, ["h"]), (u2, .readdir, ["h"]), (u2, .readFile, ["h", "own"]), (u2, .readFile, ["h", "pc", "f"]),
     (u2, .stat, ["h", "missing"]), (u2, .stat, ["h", "pc"]), (u1, .readFile, ["h", "pc", "f"]),
     (u1, .readdir, ["h"]), (kernel, .readFile, ["h", "pc", "f"]), (u2, .writeFile 9, ["h", "pc"])]
  .obj [("mounts", .arr [.obj [("point", .str "/h/pc"), ("backend", .str "b1")]]),
    ("backends", .obj [("b0", backendJson (S.bks 0)), ("b1", backendJson (S.bks 1))]),
    ("steps", .arr (steps.map fun (c, op, p) => opJson c op p (cOp S c op p).1)),
    ("final", .obj [("b0", .arr ((S.bks 0).ents.map entJson)), ("b1", .arr ((S.bks 1).ents.map entJson))])]

/-- Links inside a mount resolve inside it (`a_link_in_a_mount_stays_in_it`). -/
def directedLinks : Json :=
  let S := linkTrace
  let steps : List (Cred × Op × Path) :=
    [(u2, .readFile, ["pc", "l"]), (u2, .readFile, ["pc", "r"]), (u2, .readFile, ["etc", "p"]), (u2, .stat, ["pc", "l"])]
  .obj [("mounts", .arr [.obj [("point", .str "/pc"), ("backend", .str "b1")]]),
    ("backends", .obj [("b0", backendJson (S.bks 0)), ("b1", backendJson (S.bks 1))]),
    ("steps", .arr (steps.map fun (c, op, p) => opJson c op p (cOp S c op p).1)),
    ("final", .obj [("b0", .arr ((S.bks 0).ents.map entJson)), ("b1", .arr ((S.bks 1).ents.map entJson))])]

def fixture : String :=
  fixtureText [("fixture", .str "composite-perm"), ("model", .str "Nimbus.Vfs.CompositePerm.cOp"),
      ("principals", .arr (creds.map credJson)),
      ("note", .str "b0 is the root backend; modes true = SqliteVFS (chown/chmod each entry as listed, root included), false = MemoryVFS; symlink targets resolve inside their own backend; steps run on composite.as(cred of as) in order, carrying state; a created file is 0644, the writer's uid and primary gid; stat mode has no type bits; readdir names sorted")]
    ([directed, directedLinks] ++ runGen 0x5045524D (casesOf 150 genCase))

end Nimbus.Refine.CompositePermCases
