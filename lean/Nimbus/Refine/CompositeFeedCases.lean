/-
  Nimbus.Refine.CompositeFeedCases — `lean/fixtures/composite-feed.json` for the
  Filesystem lane's `tests/unit/composite-feed-refinement.mjs` (ProcessFs's staged
  namespace over a `CompositeVFS`).

  Each case: a root backend (SQLite, with `changes`), mounts live for the reader
  (`changes: true` = a backend with a change feed, `false` = without), their
  entries at the cursor, then a window of mutations (on the root backend at any
  path, shadowed ones included, or on a mount's backend) and table changes
  (`mount`, `unmount`). The staged namespace must equal `atCursor` after boot and
  `atAnswer` after one ACQUIRE; `poison` says whether that ACQUIRE must poison (the
  table changed). Values: `"dir"`, or `"vN"` for a file's bytes.
-/

import Nimbus.Vfs.CompositeFeed
import Nimbus.Refine.Json

namespace Nimbus.Refine.CompositeFeedCases

open Nimbus.Vfs.CompositeFeed
open Nimbus.Coherence.Namespace (Kind)
open Nimbus.Refine

abbrev LTree := List (Path × Kind)

def toTree (t : LTree) : Nimbus.Coherence.Namespace.Tree := fun q => (t.find? (·.1 == q)).map (·.2)

def key (p : Path) : String := "/" ++ "/".intercalate p

def kindJson : Kind → Json
  | .dir => .str "dir"
  | .file n => .str s!"v{n}"

def entriesJson (t : LTree) : Json :=
  .obj ((t.mergeSort fun a b => decide (key a.1 ≤ key b.1)).map fun x => (key x.1, kindJson x.2))

def names : List String := ["pc", "a", "b", "m"]

def points : List Path := [["pc"], ["m"], ["m", "pc"], ["m", "b", "pc"]]

/-- Add `p` as `k` (with directory parents) unless a prefix is a file or `p` exists. -/
def addEnt (t : LTree) (p : Path) (k : Kind) : LTree :=
  let blocked := (List.range p.length).any fun i => t.any fun x => x.1 == p.take (i + 1) && x.2 != .dir
  if p = [] || t.any (·.1 == p) || blocked then t
  else
    let withParents := (List.range (p.length - 1)).foldl (fun t i =>
      let q := p.take (i + 1)
      if t.any (·.1 == q) then t else t ++ [(q, .dir)]) t
    withParents ++ [(p, k)]

def rmTree (t : LTree) (p : Path) : LTree := t.filter fun x => !p.isPrefixOf x.1

def genPath : Gen Path := do
  let n := (← below 3) + 1
  let mut p := []
  for _ in [0:n] do p := p ++ [← pick names]
  return p

def genTree (n : Nat) (v : Nat) : Gen LTree := do
  let mut t : LTree := []
  for i in [0:n] do
    let p ← genPath
    t := addEnt t p (if (← below 3) == 0 then .dir else .file (v + i))
  return t

structure S where
  root : LTree
  mounts : List (Path × Bool)
  bt : List (Path × LTree)
  /-- Each mount's source, fresh per `mount`: a remount is another source. -/
  src : List (Path × Nat) := []

def table (s : S) : Table := ⟨s.mounts.map (·.1), fun m => ((s.mounts.find? (·.1 == m)).map (·.2)).getD false⟩

def world (s : S) : World := ⟨toTree s.root, fun m => toTree (((s.bt.find? (·.1 == m)).map (·.2)).getD [])⟩

def staged (s : S) : Json :=
  let T := table s
  let W := world s
  let pts := T.pts
  let cands := (s.root.map (·.1)) ++ (pts.flatMap fun m => (((s.bt.find? (·.1 == m)).map (·.2)).getD []).map (m ++ ·.1)) ++
    (pts.flatMap fun m => (List.range m.length).map fun i => m.take (i + 1))
  let vis := cands.eraseDups.filterMap fun q => if q = [] then none else (view T W q).map fun k => (q, k)
  entriesJson vis

def setBt (bt : List (Path × LTree)) (m : Path) (t : LTree) : List (Path × LTree) :=
  (bt.filter (·.1 != m)) ++ [(m, t)]

def isDir (t : LTree) (p : Path) : Bool := t.any fun x => x.1 == p && x.2 == .dir

/-- The table a reader's position records: each mount's point, feed and source. -/
def sig (s : S) : List (Path × Bool × Nat) :=
  (s.mounts.map fun (m, ch) => (m, ch, ((s.src.find? (·.1 == m)).map (·.2)).getD 0)).mergeSort
    fun a b => decide (key a.1 ≤ key b.1)

def genCase : Gen (Option Json) := do
  let mut s : S := { root := ← genTree ((← below 6) + 2) 1, mounts := [], bt := [] }
  let mut nextSrc := 1
  for pt in points do
    if (← below 2) == 0 then
      let ch := (← below 3) != 0
      let t ← genTree ((← below 4) + 1) 20
      s := { s with mounts := s.mounts ++ [(pt, ch)], bt := setBt s.bt pt t, src := s.src ++ [(pt, nextSrc)] }
      nextSrc := nextSrc + 1
  let s0 := s
  let mut out : Array Json := #[]
  -- `sub` entries: a directory removed (rm, or a file written over it), by backend
  -- (none = root) at its path in that backend.
  let mut subs : List (Option Path × Path) := []
  let n := (← below 5) + 1
  for i in [0:n] do
    let k ← below 10
    let v := 40 + i
    if k < 4 then
      let p ← genPath
      let t' := addEnt (rmTree s.root p) p (.file v)
      if t'.any (·.1 == p) then
        if isDir s.root p then subs := subs ++ [(none, p)]
        s := { s with root := t' }
        out := out.push (.obj [("backend", .str "root"), ("op", .str "write"), ("path", .str (key p)), ("bytes", .str s!"v{v}")])
    else if k < 5 then
      let p ← genPath
      if s.root.any (·.1 == p) then
        if isDir s.root p then subs := subs ++ [(none, p)]
        s := { s with root := rmTree s.root p }
        out := out.push (.obj [("backend", .str "root"), ("op", .str "rm"), ("path", .str (key p))])
    else if k < 8 then
      if !s.mounts.isEmpty then
        let (m, _) ← pick s.mounts
        let t := ((s.bt.find? (·.1 == m)).map (·.2)).getD []
        let p ← genPath
        if (← below 3) == 0 && t.any (·.1 == p) then
          if isDir t p then subs := subs ++ [(some m, p)]
          s := { s with bt := setBt s.bt m (rmTree t p) }
          out := out.push (.obj [("backend", .str (key m)), ("op", .str "rm"), ("path", .str (key p))])
        else
          let t' := addEnt (rmTree t p) p (.file v)
          if t'.any (·.1 == p) then
            if isDir t p then subs := subs ++ [(some m, p)]
            s := { s with bt := setBt s.bt m t' }
            out := out.push (.obj [("backend", .str (key m)), ("op", .str "write"), ("path", .str (key p)), ("bytes", .str s!"v{v}")])
    else if k < 9 then
      let pt ← pick points
      if !s.mounts.any (·.1 == pt) then
        let ch := (← below 3) != 0
        let t ← genTree 2 (60 + i)
        s := { s with mounts := s.mounts ++ [(pt, ch)], bt := setBt s.bt pt t, src := (s.src.filter (·.1 != pt)) ++ [(pt, nextSrc)] }
        nextSrc := nextSrc + 1
        out := out.push (.obj [("op", .str "mount"), ("point", .str (key pt)), ("changes", .bool ch), ("entries", entriesJson t)])
    else
      if !s.mounts.isEmpty then
        let (m, _) ← pick s.mounts
        s := { s with mounts := s.mounts.filter (·.1 != m) }
        out := out.push (.obj [("op", .str "unmount"), ("point", .str (key m))])
  let T := table s
  -- `subPoison` over these entries: a mount's entries count only for a mount
  -- whose source is the same at both ends (otherwise the table differs anyway).
  let rlog : List LEnt := subs.filterMap fun (b, p) => if b.isNone then some ⟨p, true⟩ else none
  let mlog : Path → List LEnt := fun m => subs.filterMap fun (b, p) => if b == some m then some ⟨p, true⟩ else none
  let poison := sig s0 != sig s || subPoison T rlog mlog
  let mountsJson := s0.mounts.map fun (m, ch) => Json.obj [("point", .str (key m)), ("changes", .bool ch),
    ("entries", entriesJson (((s0.bt.find? (·.1 == m)).map (·.2)).getD []))]
  return some (.obj [("root", entriesJson s0.root), ("mounts", .arr mountsJson), ("window", .arr out.toList),
    ("atCursor", staged s0), ("poison", .bool poison), ("atAnswer", staged s)])

/-- The review's repro, and a mount appearing over a root directory. -/
def directed : List Json :=
  [ .obj [("root", .obj []), ("mounts", .arr [.obj [("point", .str "/pc"), ("changes", .bool true), ("entries", .obj [])]]),
      ("window", .arr [.obj [("backend", .str "root"), ("op", .str "write"), ("path", .str "/pc/shadowed"), ("bytes", .str "v1")]]),
      ("atCursor", .obj [("/pc", .str "dir")]), ("poison", .bool false), ("atAnswer", .obj [("/pc", .str "dir")])],
    .obj [("root", .obj [("/pc", .str "dir"), ("/pc/a", .str "v1")]), ("mounts", .arr []),
      ("window", .arr [.obj [("op", .str "mount"), ("point", .str "/pc"), ("changes", .bool true), ("entries", .obj [])]]),
      ("atCursor", .obj [("/pc", .str "dir"), ("/pc/a", .str "v1")]), ("poison", .bool true),
      ("atAnswer", .obj [("/pc", .str "dir")])],
    -- A mount nested two levels under another whose backend lacks the level between:
    -- /m/b is the composite's directory, and /m's feed removing its own b is not staged.
    .obj [("root", .obj []),
      ("mounts", .arr [.obj [("point", .str "/m"), ("changes", .bool true), ("entries", .obj [("/b", .str "v1")])],
        .obj [("point", .str "/m/b/pc"), ("changes", .bool true), ("entries", .obj [("/x", .str "v2")])]]),
      ("window", .arr [.obj [("backend", .str "/m"), ("op", .str "rm"), ("path", .str "/b")]]),
      ("atCursor", .obj [("/m", .str "dir"), ("/m/b", .str "dir"), ("/m/b/pc", .str "dir"), ("/m/b/pc/x", .str "v2")]),
      ("poison", .bool false),
      ("atAnswer", .obj [("/m", .str "dir"), ("/m/b", .str "dir"), ("/m/b/pc", .str "dir"), ("/m/b/pc/x", .str "v2")])],
    -- ABA: a mount appears and goes within the window; the ends agree, so no poison,
    -- and the root's /pc/a, written while it was covered, is in the root feed.
    .obj [("root", .obj [("/pc", .str "dir")]), ("mounts", .arr []),
      ("window", .arr [.obj [("op", .str "mount"), ("point", .str "/pc"), ("changes", .bool true), ("entries", .obj [("/x", .str "v2")])],
        .obj [("backend", .str "root"), ("op", .str "write"), ("path", .str "/pc/a"), ("bytes", .str "v3")],
        .obj [("op", .str "unmount"), ("point", .str "/pc")]]),
      ("atCursor", .obj [("/pc", .str "dir")]), ("poison", .bool false),
      ("atAnswer", .obj [("/pc", .str "dir"), ("/pc/a", .str "v3")])],
    -- rm -r of a root directory the composite makes above a live mount
    -- (a_subtree_entry_at_a_composite_directory_must_poison).
    .obj [("root", .obj [("/m", .str "dir"), ("/m/a", .str "v1")]),
      ("mounts", .arr [.obj [("point", .str "/m/pc"), ("changes", .bool true), ("entries", .obj [])]]),
      ("window", .arr [.obj [("backend", .str "root"), ("op", .str "rm"), ("path", .str "/m")]]),
      ("atCursor", .obj [("/m", .str "dir"), ("/m/a", .str "v1"), ("/m/pc", .str "dir")]), ("poison", .bool true),
      ("atAnswer", .obj [("/m", .str "dir"), ("/m/pc", .str "dir")])] ]

def fixture : String :=
  fixtureText [("fixture", .str "composite-feed"), ("model", .str "Nimbus.Vfs.CompositeFeed"),
      ("note", .str "root backend has changes; mounts are live for the reader; a live mount point and every directory above one is the composite's directory, whichever backend holds that path (structural first); a mount without changes stages nothing else under it; root rows under a live mount or at a structural path are shadowed; a mount's feed entry at a structural path is dropped; poison = the table (point, changes, source per mount) differs between the ends of the window, or a directory was removed (rm, or a file written over it) at a path that is one of the composite's own directories at answer time and routes to that backend (a sub entry there, subPoison)")]
    (directed ++ runGen 0x46454544 (casesOf 150 genCase))

end Nimbus.Refine.CompositeFeedCases
