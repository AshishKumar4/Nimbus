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
  table changed or a structural subtree entry requires it). Launch names choose
  the bounded unfed walk; an ordinary answer retains it, a relist replaces it.
  Values: `"dir"`, or `"vN"` for a file's bytes.
-/

import Nimbus.Vfs.CompositeFeed
import Nimbus.Vfs.CompositeCache
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

def world (s : S) : World := { root := toTree s.root, bt := fun m => toTree (((s.bt.find? (·.1 == m)).map (·.2)).getD []) }

def candidates (s : S) : List Path :=
  let pts := (table s).pts
  ((s.root.map (·.1)) ++ (pts.flatMap fun m => (((s.bt.find? (·.1 == m)).map (·.2)).getD []).map (m ++ ·.1)) ++
    (pts.flatMap fun m => (List.range m.length).map fun i => m.take (i + 1))).eraseDups

def fullTree (s : S) : LTree :=
  let T := { table s with ch := fun _ => true }
  let W := world s
  (candidates s).filterMap fun q => (view T W q).map fun k => (q, k)

structure Launch where
  entries : LTree
  listed : List Path := []
  room : Nat

def listDirectory (all : LTree) (dir : Path) (held : Launch) : Launch × List Path := Id.run do
  if held.listed.contains dir || held.room = 0 || toTree held.entries dir != some .dir then return (held, [])
  let children := all.filter fun x => x.1.dropLast == dir
  let fresh := children.filter fun x => !held.entries.any (·.1 == x.1)
  if fresh.length > held.room then return (held, [])
  return ({ entries := held.entries ++ fresh, listed := held.listed ++ [dir], room := held.room - fresh.length },
    children.filterMap fun x => if x.2 == .dir then some x.1 else none)

def walkQueue (all : LTree) : Nat → List Path → Launch → Launch
  | 0, _, held => held
  | _ + 1, [], held => held
  | n + 1, dir :: rest, held =>
    let (next, dirs) := listDirectory all dir held
    walkQueue all n (rest ++ dirs) next

/-- Finite projection of the launch walk: ancestors first, then named trees,
    adding a directory's children only when the whole fresh set fits. -/
def launchWalk (s : S) (named : List Path) (limit : Nat := 8192) : Launch := Id.run do
  let T := table s
  let all := fullTree s
  let points := T.pts.filter fun m => !T.ch m
  let wanted := named.filter fun p => (ownerPt T.pts p).any fun m => !T.ch m
  let levels := (wanted.flatMap fun p => (List.range p.length).map (p.take ·)).eraseDups.filter fun p =>
    points.any (·.isPrefixOf p)
  let ordered := levels.mergeSort fun a b => if a.length == b.length then decide (key a ≤ key b) else a.length ≤ b.length
  let mut held : Launch := { entries := points.map fun m => (m, .dir), room := limit }
  for dir in ordered do held := (listDirectory all dir held).1
  let queue := (wanted.filter fun p => toTree held.entries p == some .dir).mergeSort fun a b => decide (key a ≤ key b)
  return walkQueue all (all.length + 1) queue held

def withWalk (s : S) (held : Launch) : World :=
  { world s with
    walk := {
      tree := fun q => if q = [] || structural (table s).pts q then some .dir else toTree held.entries q
      spent := held.entries.countP (fun x => !structural (table s).pts x.1)
      limit := 8192
      listed := held.listed } }

def staged (s : S) (held : Launch) : Json :=
  let T := table s
  let W := withWalk s held
  let vis := ((candidates s) ++ held.entries.map (·.1)).eraseDups.filterMap fun q =>
    if q = [] then none else (view T W q).map fun k => (q, k)
  entriesJson vis

def unlisted (s : S) (held : Launch) : Json :=
  let T := table s
  let paths := ((candidates s).filter (structural T.pts) ++ held.entries.filterMap
    (fun x => if x.2 == .dir then some x.1 else none)).eraseDups
  .obj (paths.filterMap fun p => do
    let m ← ownerPt T.pts p
    if held.listed.contains p || (!held.entries.any (·.1 == p) && T.ch m) then none
    else some (key p, Json.str (key m)))

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
  let named := s0.mounts.map (·.1)
  let held := launchWalk s0 named
  let relisted := launchWalk s named
  return some (.obj [("root", entriesJson s0.root), ("mounts", .arr mountsJson), ("window", .arr out.toList),
    ("launchNames", .arr (named.map (Json.str ∘ key))), ("atCursor", staged s0 held),
    ("atCursorUnlisted", unlisted s0 held), ("poison", .bool poison),
    ("atAnswer", staged s (if poison then relisted else held)), ("atRelist", staged s relisted)])

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

def launchCase (s0 s1 : S) (named : List Path) (window : List Json) (poison : Bool)
    (extra : List (String × Json) := []) : Json :=
  let held := launchWalk s0 named
  let fresh := launchWalk s1 named
  .obj ([("root", entriesJson s0.root), ("mounts", .arr (s0.mounts.map fun (m, ch) =>
      .obj [("point", .str (key m)), ("changes", .bool ch),
        ("entries", entriesJson (((s0.bt.find? (·.1 == m)).map (·.2)).getD []))])),
    ("launchNames", .arr (named.map (Json.str ∘ key))), ("window", .arr window),
    ("atCursor", staged s0 held), ("atCursorUnlisted", unlisted s0 held),
    ("atCursorUndated", .arr (((candidates s0) ++ held.entries.map (·.1)).eraseDups.filter
      (fun p => (view (table s0) (withWalk s0 held) p).isSome)
        |>.mergeSort (fun a b => decide (key a ≤ key b)) |>.map (Json.str ∘ key))),
    ("poison", .bool poison), ("atAnswer", staged s1 (if poison then fresh else held)),
    ("atRelist", staged s1 fresh)] ++ extra)

def cachedReadJson : Nimbus.Vfs.CompositeCache.Read → Json
  | .value v rev => .obj [("bytes", .str s!"v{v}"), ("rev", .int rev)]
  | .eagain => .str "EAGAIN"

def cacheTrace : Json :=
  let S : Nimbus.Vfs.CompositeCache.Sys := {
    hist := fun _ _ t => if t = 0 then 1 else 2
    changes := fun _ => false
    route := fun _ p => (1, p) }
  let before := Nimbus.Vfs.CompositeCache.install ⟨[], fun _ => 0⟩ ⟨(1, ["kept", "data.txt"]), 1, 0, false⟩
  let reconciled := Nimbus.Vfs.CompositeCache.reconcile before {
    complete := true, comparable := true, revision := fun _ => 0, sameReadableContent := fun _ => false }
  let fetched := Nimbus.Vfs.CompositeCache.install reconciled ⟨(1, ["kept", "data.txt"]), S.hist 1 [] 1, 0, false⟩
  .obj [("path", .str "/m/kept/data.txt"),
    ("before", cachedReadJson (Nimbus.Vfs.CompositeCache.syncRead S before 0 ["kept", "data.txt"])),
    ("afterAcquire", cachedReadJson (Nimbus.Vfs.CompositeCache.syncRead S before 1 ["kept", "data.txt"])),
    ("afterDrop", cachedReadJson (Nimbus.Vfs.CompositeCache.syncRead S reconciled 1 ["kept", "data.txt"])),
    ("afterReconcile", cachedReadJson (Nimbus.Vfs.CompositeCache.syncRead S fetched 1 ["kept", "data.txt"]))]

def launchDirected : List Json := Id.run do
  let base : S := { root := [], mounts := [(["m"], false)], bt := [(["m"], [(["kept"], .dir), (["kept", "data.txt"], .file 1)])] }
  let changed := { base with bt := [(["m"], [(["kept"], .dir), (["kept", "data.txt"], .file 2)])] }
  let write := Json.obj [("backend", .str "/m"), ("op", .str "write"), ("path", .str "/kept/data.txt"), ("bytes", .str "v2")]
  let partialTree := [(["a"], Kind.dir), (["a", "f"], .file 1), (["a", "sibling"], .file 2), (["b"], .dir), (["b", "hidden"], .file 3)]
  let partialS := { base with bt := [(["m"], partialTree)] }
  let nested : S := {
    root := []
    mounts := [(["m"], false), (["m", "nested"], false)]
    bt := [(["m"], [(["nested"], .dir), (["nested", "shadowed"], .file 9)]),
      (["m", "nested"], [(["x"], .file 1)])] }
  let replaced := { nested with bt := setBt nested.bt ["m", "nested"] [(["x"], .file 2)] }
  let big := { base with bt := [(["m"], (["big"], Kind.dir) ::
    (List.range 8193).map (fun n => (["big", s!"f{n}"], Kind.file 1)))] }
  let pageTree := ["a", "b", "c", "d", "e", "g"].map fun n => ([n], Kind.file 1)
  let paged := { base with bt := [(["m"], pageTree)] }
  let extended := { paged with bt := [(["m"], pageTree ++ [(["z"], .file 2)])] }
  return [launchCase base changed [["m", "kept"]] [write] false [("cache", cacheTrace)],
    launchCase base base [] [] false,
    launchCase partialS partialS [["m", "a", "f"]] [] false,
    launchCase nested replaced [["m"]] [
      .obj [("op", .str "unmount"), ("point", .str "/m/nested")],
      .obj [("op", .str "mount"), ("point", .str "/m/nested"), ("changes", .bool false), ("entries", entriesJson [(["x"], .file 2)])]] true,
    launchCase big big [["m", "big"]] [] false,
    launchCase paged extended [["m"]] [] false [("betweenPages", .arr [
      .obj [("backend", .str "/m"), ("op", .str "write"), ("path", .str "/z"), ("bytes", .str "v2")]])]]

def fixture : String :=
  fixtureText [("fixture", .str "composite-feed"), ("model", .str "Nimbus.Vfs.CompositeFeed"),
      ("note", .str "ProcessFiles bound listings merge the feed view with a bounded launch-named walk of unfed mounts; walked entries have rev 0; unlisted directories certify no absence; continuing pages retain one walk; ordinary answers retain unfed observations, boot/relist replaces them; independent fed mounts use the composite's multi-feed cursor; structural paths shadow backend entries; table/source changes and structural subtree entries poison; cache observations bridge the resident store's undated held bytes and reconciliation")]
    (directed ++ launchDirected ++ runGen 0x46454544 (casesOf 150 genCase))

end Nimbus.Refine.CompositeFeedCases
