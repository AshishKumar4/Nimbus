/-
  Nimbus.Refine.CompositePermCases — `lean/fixtures/composite-perm.json` for
  NodeNoMirrorBuild's `tests/unit/composite-perm-refinement.mjs`: permissions,
  symlinks and setgid through `CompositeVFS` (`Nimbus.Vfs.CompositePerm.cOp`).

  Each case: backends (`b0` is the root) of `kind` `"sqlite"` (a SqliteVFS: every
  entry chowned and chmodded as listed; its root is always 0755 0:0) or `"memory"` (a
  MemoryVFS: no modes; the listed modes are ignored), with entries in creation order
  (parents first; symlink targets are namespace paths, absolute from the caller's
  root or relative to the link's directory); mounts; then steps, each run on
  `composite.as(cred of as)` with the principals in the header, carrying state from
  step to step. A step's `path` may hold `..`. `expect`: `"ok"`, `null`,
  `{"kind", "mode", "uid", "gid"}` (mode without type bits; all three null when the
  backend reports no modes), `{"bytes"}`, `{"names"}` (sorted) or `{"error"}`. A
  file `writeFile` creates is 0644 and a directory `mkdir` makes is 0755 (umask
  022), owned by the caller's uid and primary gid, except that in a setgid directory
  of a sqlite backend both take the directory's gid and a new directory is setgid
  (02755). `final`: each backend's entries after the steps.
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
  .obj [("kind", .str (if b.enforces then "sqlite" else "memory")), ("entries", .arr (b.ents.map entJson))]

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
  | .mkdir => base "mkdir" []
  | .unlink => base "unlink" []

def names : List String := ["h", "pc", "q", "f", "x", "dev"]
def points : List Path := [["h", "pc"], ["pc"], ["h", "q", "m"], ["dev"]]
def dirModes : List Nat := [0o755, 0o700, 0o750, 0o711, 0o1777, 0o770, 0o2775, 0o2770, 0o755]
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
  let k ← below 6
  if k == 0 then return .link true [← pick names]
  else if k == 1 then return .link true [← pick names, ← pick names]
  else if k == 2 then return .link true [← pick names, ← pick names, ← pick names]
  else if k == 3 then return .link false ["..", ← pick names]
  else if k == 4 then return .link false ["..", "..", ← pick names, ← pick names]
  else return .link false [← pick names]

def genBackend (sql : Bool) (n : Nat) (v : Nat) : Gen Backend := do
  let mut b : Backend := if sql then ⟨true, true, synthMeta, []⟩ else ⟨false, false, synthMeta, []⟩
  for i in [0:n] do
    let p ← genPath
    let k ← below 7
    let kind ← if k < 2 then pure K.dir else if k < 5 then pure (K.file (v + i)) else genTarget
    b ← addEnt b p kind
  return b

def genOpPath (ms : List Mnt) : Gen Path := do
  if (← below 3) == 0 then
    let m ← pick (ms.map (·.point) ++ [[]])
    let extra ← below 3
    let mut p := m
    for _ in [0:extra] do p := p ++ [← pick names]
    if (← below 6) == 0 then p := p ++ ["..", ← pick names]
    if p = [] then p := [← pick names]
    return p
  else genPath

def genOp (v : Nat) : Gen Op := do
  let k ← below 10
  if k < 3 then return .stat
  else if k < 5 then return .readdir
  else if k < 7 then return .readFile
  else if k < 8 then return .writeFile v
  else if k < 9 then return .mkdir
  else return .unlink

def genCase : Gen (Option Json) := do
  let mut ms : List Mnt := []
  let mut bid := 1
  for pt in points do
    if (← below 2) == 0 then
      ms := ms ++ [⟨pt, bid⟩]
      bid := bid + 1
  if ms.isEmpty then return none
  let mut root ← genBackend true ((← below 6) + 3) 1
  -- sometimes the root holds the directories above a mount point, with their own modes
  for m in ms do
    for i in [1:m.point.length] do
      if (← below 2) == 0 then root ← addEnt root (m.point.take i) .dir
  let mut bks : List (Nat × Backend) := [(0, root)]
  for m in ms do
    bks := bks ++ [(m.bk, ← genBackend ((← below 3) != 0) ((← below 5) + 1) 20)]
  let get (l : List (Nat × Backend)) (k : Nat) : Backend :=
    ((l.find? (·.1 == k)).map (·.2)).getD ⟨false, false, synthMeta, []⟩
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

def mountsJson (ms : List Mnt) : Json :=
  .arr (ms.map fun m => .obj [("point", .str (key m.point)), ("backend", .str s!"b{m.bk}")])

def traceCase (S : St) (ks : List Nat) (steps : List (Cred × Op × Path)) : Json := Id.run do
  let mut T := S
  let mut out : Array Json := #[]
  for (c, op, p) in steps do
    let (o, T') := cOp T c op p
    T := T'
    out := out.push (opJson c op p o)
  return .obj [("mounts", mountsJson S.mounts), ("backends", .obj (ks.map fun k => (s!"b{k}", backendJson (S.bks k)))),
    ("steps", .arr out.toList), ("final", .obj (ks.map fun k => (s!"b{k}", .arr ((T.bks k).ents.map entJson))))]

/-- The perm.mjs trace (`the_perm_trace`), links (`links_resolve_in_the_callers_namespace`)
    and setgid (`a_setgid_directory_passes_its_group_on`). -/
def directed : List Json :=
  [ traceCase permTrace [0, 1]
      [(u2, .stat, ["h"]), (u2, .readdir, ["h"]), (u2, .readFile, ["h", "own"]), (u2, .readFile, ["h", "pc", "f"]),
       (u2, .stat, ["h", "missing"]), (u2, .stat, ["h", "pc"]), (u1, .readFile, ["h", "pc", "f"]),
       (u1, .readdir, ["h"]), (kernel, .readFile, ["h", "pc", "f"]), (u2, .writeFile 9, ["h", "pc"])],
    traceCase linkTrace [0, 1, 2, 3]
      [(u2, .readFile, ["pc", "l"]), (u2, .readFile, ["pc", "r"]), (u2, .readFile, ["dev", "stdin"]),
       (u1, .readFile, ["dev", "stdin"]), (u2, .readFile, ["pc", "x"]), (u1, .readFile, ["pc", "x"]),
       (u1, .readFile, ["pc", "a"]), (u1, .stat, ["pc", "l"]), (u1, .unlink, ["pc", "a"])],
    traceCase sgTrace [0]
      [(⟨1, 1, [1, 10]⟩, .writeFile 3, ["g", "f"]), (⟨1, 1, [1, 10]⟩, .mkdir, ["g", "d"]),
       (⟨1, 1, [1, 10]⟩, .stat, ["g", "f"]), (⟨1, 1, [1, 10]⟩, .stat, ["g", "d"]),
       (⟨1, 1, [1, 10]⟩, .writeFile 4, ["g", "d", "e"]), (⟨1, 1, [1, 10]⟩, .stat, ["g", "d", "e"])] ]

def fixture : String :=
  fixtureText [("fixture", .str "composite-perm"), ("model", .str "Nimbus.Vfs.CompositePerm.cOp"),
      ("principals", .arr (creds.map credJson)),
      ("note", .str "b0 is the root backend; kind sqlite = SqliteVFS (chown/chmod each entry as listed; root 0755 0:0), memory = MemoryVFS (no modes); every symlink resolves in the caller's namespace (absolute from its root, relative from the link's directory, .. at a mount root to the mount point's parent), 40 hops then ELOOP, search checked per hop; steps run on composite.as(cred of as) in order, carrying state; created files 0644 and directories 0755, the caller's uid and primary gid, but in a setgid sqlite directory the directory's gid, and new directories setgid; stat mode has no type bits; readdir names sorted")]
    (directed ++ runGen 0x5045524D (casesOf 150 genCase))

end Nimbus.Refine.CompositePermCases
