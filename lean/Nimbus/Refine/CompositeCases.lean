/-
  Nimbus.Refine.CompositeCases — `lean/fixtures/composite-vfs.json`, the output of
  `Nimbus.Vfs.Composite.exec` on random mount tables, backend trees and operations.
  Consumed by the Filesystem lane's `tests/unit/composite-vfs-refinement.mjs`.

  Every backend is a fresh in-memory VFS holding the case's entries (the root one
  must support symlinks). A mount's source answers its backend to the principals
  listed in `only` (by uid), null to others; `only: null` answers everyone.
-/

import Nimbus.Vfs.Composite
import Nimbus.Refine.Json

namespace Nimbus.Refine.CompositeCases

open Nimbus.Vfs.Composite
open Nimbus.Refine

def uidOf (P : Principal) : Nat := if P = 0 then 0 else 1000

def key (p : Path) : String := "/".intercalate p

def backendName (b : Backend) : String := if b = 0 then "root" else s!"b{b}"

def entJson (x : Path × Ent) : Json :=
  match x.2 with
  | .file b => .obj [("path", .str (key x.1)), ("type", .str "file"), ("bytes", .str s!"v{b}")]
  | .dir => .obj [("path", .str (key x.1)), ("type", .str "directory")]
  | .link t => .obj [("path", .str (key x.1)), ("type", .str "symlink"), ("target", .str t)]

def treeJson (t : Tree) : Json :=
  .arr ((t.mergeSort fun a b => decide (key a.1 ≤ key b.1)).map entJson)

def outJson : Out → Json
  | .ok => .str "ok"
  | .null => .null
  | .kind k => .obj [("type", .str k)]
  | .bytes b => .obj [("bytes", .str s!"v{b}")]
  | .names l => .obj [("names", .arr (l.map Json.str))]
  | .err c => .obj [("error", .str c)]

def opJson (P : Principal) (op : Op) (o : Out) : Json :=
  let base (name : String) (extra : List (String × Json)) : Json :=
    .obj ([("as", .ofNat (uidOf P)), ("op", .str name), ("path", .str op.raw)] ++ extra ++ [("expect", outJson o)])
  match op with
  | .stat _ => base "stat" []
  | .readdir _ => base "readdir" []
  | .readFile _ => base "readFile" []
  | .writeFile _ b => base "writeFile" [("bytes", .str s!"v{b}")]
  | .mkdirp _ => base "mkdirp" []
  | .mkdir _ => base "mkdir" []
  | .unlink _ => base "unlink" []
  | .rmdir _ => base "rmdir" []
  | .rename _ b => base "rename" [("to", .str b)]

/-- Candidate mount points; the root backend never holds an entry at a mount
    point's proper ancestor (a synthesized directory never conflicts with a file). -/
def points : List Path := [["proc"], ["pc"], ["mnt"], ["mnt", "pc"], ["data", "x"]]

def names : List String := ["a", "b", "pc", "proc", "mnt", "data", "x"]

def withParents (t : Tree) (p : Path) : Tree :=
  (List.range p.length).foldl (fun t i =>
    let q := p.take (i + 1)
    if t.any (·.1 == q) then t else t ++ [(q, if i + 1 = p.length then .dir else .dir)]) t

/-- Add `p` with its parent directories, unless `p` exists or a prefix of it is
    not a directory: every tree is one a filesystem can hold. -/
def addEnt (t : Tree) (p : Path) (e : Ent) : Tree :=
  let blocked := (List.range p.length).any fun i => t.any fun x => x.1 == p.take (i + 1) && x.2 != .dir
  if t.any (·.1 == p) || blocked then t else (withParents t p.dropLast) ++ [(p, e)]

def genTree (allowed : Path → Bool) (n : Nat) (withLinks : Bool) : Gen Tree := do
  let mut t : Tree := []
  for _ in [0:n] do
    let depth := (← below 3) + 1
    let mut p : Path := []
    for _ in [0:depth] do p := p ++ [← pick names]
    if allowed p then
      let k ← below 6
      if k < 3 then t := addEnt t p (.file ((← below 9) + 1))
      else if k < 5 then t := addEnt t p .dir
      else if withLinks then
        let tgt ← pick ["/proc", "/pc", "mnt/pc", "../mnt", "/a", "/loop", "a/b", "/data/x"]
        t := addEnt t p (.link tgt)
  return t

def genRaw : Gen String := do
  let depth := (← below 3) + 1
  let mut parts : List String := []
  for _ in [0:depth] do
    let k ← below 12
    let n ← pick (names ++ ["loop", "q"])
    parts := parts ++ [if k == 0 then ".." else if k == 1 then "." else n]
  return "/" ++ "/".intercalate parts

/-- Every path some backend holds, seen through the mounts. -/
def known (S : St) : List String :=
  let rootPaths := (S.trees 0).map (·.1)
  let mounted := S.mounts.flatMap fun m => m.point :: (S.trees m.backend).map (m.point ++ ·.1)
  (rootPaths ++ mounted).map fun p => "/" ++ key p

def genPath (S : St) : Gen String := do
  let ks := known S
  let k ← below 3
  if k == 0 || ks.isEmpty then genRaw
  else
    let p ← pick ks
    let tail ← pick ["", "", "", "/new", "/a", "/../b"]
    return p ++ tail

def genOp (S : St) (b : Nat) : Gen Op := do
  let p ← genPath S
  let k ← below 16
  if k < 3 then return .stat p
  else if k < 6 then return .readdir p
  else if k < 8 then return .readFile p
  else if k < 10 then return .writeFile p b
  else if k < 11 then return (if (← below 2) == 0 then .mkdirp p else .mkdir p)
  else if k < 13 then return .unlink p
  else if k < 14 then return .rmdir p
  else return .rename p (← genPath S)

def genCase : Gen (Option Json) := do
  let mut ms : List Mount := []
  for pt in points do
    if (← below 2) == 0 then
      let b := (← below 3) + 1
      let only := if (← below 2) == 0 then none else some [0]
      ms := ms ++ [⟨pt, b, only⟩]
  -- the root never holds a file or link at a mount point's proper ancestor
  let ancestors := ms.flatMap fun m => (List.range m.point.length).map fun i => m.point.take i
  let rootOk (p : Path) : Bool := !(ancestors.any fun a => a == p.take a.length && p.length ≤ a.length && a != [])
  let root ← genTree rootOk ((← below 8) + 3) true
  let mut trees : List (Backend × Tree) := [(0, root)]
  for b in [1, 2, 3] do
    if ms.any (·.backend == b) then trees := trees ++ [(b, ← genTree (fun _ => true) ((← below 5) + 1) false)]
  let mut S : St := { mounts := ms, trees := fun b => ((trees.find? (·.1 == b)).map (·.2)).getD [] }
  let mut steps : Array Json := #[]
  let n := (← below 16) + 6
  for i in [0:n] do
    let P ← below 2
    let op ← genOp S (i + 20)
    let (o, S') := exec S P op
    S := S'
    steps := steps.push (opJson P op o)
  let mountsJson := ms.map fun m => Json.obj [("point", .str ("/" ++ key m.point)), ("backend", .str (backendName m.backend)),
    ("only", match m.only with | none => .null | some ps => .arr (ps.map fun P => .ofNat (uidOf P)))]
  let initial := Json.obj (trees.map fun (b, t) => (backendName b, treeJson t))
  let final := Json.obj (trees.map fun (b, _) => (backendName b, treeJson (S.trees b)))
  return some (.obj [("mounts", .arr mountsJson), ("backends", initial), ("steps", .arr steps.toList), ("final", final)])

/-- A root symlink at a directory that exists only above a mount point: the
    synthesized directory wins for principals the mount answers; for others the
    link is followed. -/
def runDirected (ms : List Mount) (trees : List (Backend × Tree)) (steps : List (Principal × Op)) : Json := Id.run do
  let mut S : St := { mounts := ms, trees := fun b => ((trees.find? (·.1 == b)).map (·.2)).getD [] }
  let mut out : Array Json := #[]
  for (P, op) in steps do
    let (o, S') := exec S P op
    S := S'
    out := out.push (opJson P op o)
  let mountsJson := ms.map fun m => Json.obj [("point", .str ("/" ++ key m.point)), ("backend", .str (backendName m.backend)),
    ("only", match m.only with | none => .null | some ps => .arr (ps.map fun P => .ofNat (uidOf P)))]
  .obj [("mounts", .arr mountsJson), ("backends", .obj (trees.map fun (b, t) => (backendName b, treeJson t))),
    ("steps", .arr out.toList), ("final", .obj (trees.map fun (b, _) => (backendName b, treeJson (S.trees b))))]

def directed : List Json :=
  let root : Tree := [(["srv"], .link "/elsewhere"), (["elsewhere"], .dir), (["elsewhere", "e"], .file 3),
    (["data"], .link "elsewhere")]
  let b1 : Tree := [(["f"], .file 5), (["d"], .dir)]
  let probe (P : Principal) : List (Principal × Op) :=
    [(P, .stat "/srv"), (P, .readdir "/srv"), (P, .stat "/srv/data"), (P, .readdir "/srv/data"),
     (P, .readFile "/srv/data/f"), (P, .writeFile "/srv/data/g" 7), (P, .readFile "/srv/data/g"),
     (P, .stat "/srv/e"), (P, .writeFile "/srv" 8), (P, .rmdir "/srv"), (P, .stat "/data/x"),
     (P, .readdir "/data"), (P, .readFile "/data/x/f")]
  [ runDirected [⟨["srv", "data"], 1, none⟩, ⟨["data", "x"], 1, none⟩] [(0, root), (1, b1)] (probe 0 ++ probe 1),
    runDirected [⟨["srv", "data"], 1, some [0]⟩, ⟨["data", "x"], 1, some [0]⟩] [(0, root), (1, b1)]
      (probe 0 ++ probe 1),
    -- `..` is physical: it applies after a link met before it; a cycle before it is ELOOP
    runDirected [⟨["pc"], 1, none⟩]
      [(0, [(["proc"], .dir), (["proc", "a"], .link "/pc"), (["proc", "r"], .link "../pc/d"), (["proc", "b"], .file 2),
          (["b"], .file 4), (["loop"], .link "/loop"), (["pc"], .dir)]), (1, b1)]
      [(0, .stat "/proc/a/../b"), (0, .readFile "/proc/a/../b"), (0, .readdir "/proc/a/.."),
       (0, .stat "/proc/r/.."), (0, .readdir "/proc/r/.."), (0, .readFile "/proc/r/../f"),
       (0, .stat "/loop/.."), (0, .readdir "/loop/../proc"), (0, .stat "/proc/b/../a"),
       (0, .writeFile "/proc/a/../c" 9), (0, .readFile "/c"), (0, .unlink "/proc/a/../c"),
       (0, .stat "/pc/d/../../proc/a"), (0, .rename "/proc/a/../b" "/proc/b2"),
       (0, .stat "/missing/../b"), (0, .readdir "/missing/.."), (0, .stat "/pc/nope/.."),
       (0, .writeFile "/b2/x" 1), (0, .rename "/missing/x" "/b2/y"), (0, .rename "/b2" "/missing/y")] ]

def fixture : String :=
  fixtureText [("fixture", .str "composite-vfs"), ("model", .str "Nimbus.Vfs.Composite.exec"),
      ("principals", .arr [.obj [("uid", .ofNat 0), ("gid", .ofNat 0)], .obj [("uid", .ofNat 1000), ("gid", .ofNat 1000)]]),
      ("note", .str "backends: fresh in-memory VFSes holding the entries (paths relative to the backend root, parents listed); a mount's source answers its backend to uids in `only`, null otherwise (only null = everyone); each step runs on composite.as(cred of `as`); `final` is every backend's tree after the steps; readdir names sorted")]
    (directed ++ runGen 0x434F4D50 (casesOf 200 genCase))

end Nimbus.Refine.CompositeCases
