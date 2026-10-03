/-
  Nimbus.Refine.BeneathCases — `lean/fixtures/beneath.json` for NodeNoMirrorBuild's
  `tests/unit/beneath-refinement.mjs` (`Nimbus.Vfs.CompositeBeneath.resolveB`).

  Each case: mounts and backends in `composite-perm.json`'s schema (`kind` sqlite or
  memory, entries in creation order; symlink targets are namespace paths), then
  steps, each a resolution beneath a root through the process bridge (a preopen of
  `root`, a lookup of `path` with RESOLVE_BENEATH): `{"as", "root", "path",
  "follow", "expect"}`. `path` is relative to `root` unless it begins with `/`; it
  may hold `.` and `..`. `follow`: whether a link in the last component is followed.
  `expect`: `{"path": the namespace path it resolves to}` or `{"error": ENOTCAPABLE |
  ENOENT | ENOTDIR | EACCES | ELOOP}`. A missing last component resolves (to its path),
  as a create would. Nothing is mutated.
-/

import Nimbus.Vfs.CompositeBeneath
import Nimbus.Refine.CompositePermCases

namespace Nimbus.Refine.BeneathCases

open Nimbus.Vfs.CompositePerm
open Nimbus.Vfs.CompositeBeneath
open Nimbus.Refine
open Nimbus.Refine.CompositePermCases

def ansJson : Except String Path → Json
  | .ok p => .obj [("path", .str (key p))]
  | .error e => .obj [("error", .str e)]

def pathStr (abs : Bool) (raw : List String) : String := (if abs then "/" else "") ++ "/".intercalate raw

def stepJson (S : St) (c : Cred) (R : Path) (f abs : Bool) (raw : List String) : Json :=
  .obj [("as", .ofNat c.uid), ("root", .str (key R)), ("path", .str (pathStr abs raw)), ("follow", .bool f),
    ("expect", ansJson (resolveB S c f R abs raw))]

def isDirB (S : St) (q : Path) : Bool :=
  match entAt S q with
  | some (.dir, _) => true
  | _ => false

def genRaw (ms : List Mnt) : Gen (List String) := do
  let n := (← below 4) + 1
  let mut raw := []
  let extra := ms.flatMap fun m => m.point
  for _ in [0:n] do
    let k ← below 10
    raw := raw ++ [← if k < 3 then pure ".." else if k < 4 then pure "." else pick (names ++ extra)]
  return raw

def genCase : Gen (Option Json) := do
  let mut ms : List Mnt := []
  let mut bid := 1
  for pt in points do
    if (← below 2) == 0 then
      ms := ms ++ [⟨pt, bid⟩]
      bid := bid + 1
  if ms.isEmpty then return none
  let mut root ← genBackend true ((← below 6) + 3) 1
  for m in ms do
    for i in [1:m.point.length] do
      if (← below 2) == 0 then root ← addEnt root (m.point.take i) .dir
  let mut bks : List (Nat × Backend) := [(0, root)]
  for m in ms do
    bks := bks ++ [(m.bk, ← genBackend ((← below 3) != 0) ((← below 5) + 1) 20)]
  let get (l : List (Nat × Backend)) (k : Nat) : Backend :=
    ((l.find? (·.1 == k)).map (·.2)).getD (memory [])
  let S : St := { mounts := ms, bks := get bks }
  let cands : List Path := [[]] ++ ms.flatMap (fun m => (List.range (m.point.length + 1)).map m.point.take) ++
    ((S.bks 0).ents.map (·.1)) ++ ms.flatMap (fun m => (S.bks m.bk).ents.map (m.point ++ ·.1))
  let roots := cands.eraseDups.filter (isDirB S)
  if roots.isEmpty then return none
  let mut steps : Array Json := #[]
  let n := (← below 10) + 8
  for _ in [0:n] do
    let c ← pick creds
    let R ← pick roots
    let raw ← genRaw ms
    let abs := (← below 12) == 0
    let f := (← below 4) != 0
    steps := steps.push (stepJson S c R f abs raw)
  let ks := bks.map (·.1)
  return some (.obj [("mounts", mountsJson ms),
    ("backends", .obj (ks.map fun k => (s!"b{k}", backendJson (S.bks k)))), ("steps", .arr steps.toList)])

/-- `beneath_across_mounts`. -/
def directed : Json :=
  let S := mountTrace
  let R := ["a"]
  let M := ["a", "m"]
  let steps : List (Path × Bool × Bool × List String) :=
    [(R, true, false, ["m", "x", "..", "..", "n"]), (R, true, false, ["m", ".."]), (R, true, false, ["m", "..", ".."]),
     (R, true, false, ["m", "x", "..", "..", "..", "etc", "p"]), (R, true, false, ["m", "side"]),
     (R, true, false, ["m", "up"]), (R, true, false, ["m", "abs"]), (M, true, false, [".."]),
     (M, true, false, ["side"]), (M, false, false, ["abs"]), (M, true, true, ["x"]), (M, true, false, ["x", "f"]), (M, true, false, ["loop"]),
     (R, true, false, ["m", "inside"]), (R, true, false, ["m", "chain"]), (R, true, false, ["m", "gone"]),
     (R, true, false, ["m", "gone", "x"]), (M, true, false, ["inside"]), (M, false, false, ["inside"])]
  .obj [("mounts", mountsJson S.mounts), ("backends", .obj [("b0", backendJson (S.bks 0)), ("b1", backendJson (S.bks 1))]),
    ("steps", .arr (steps.map fun (R, f, abs, raw) => stepJson S u2 R f abs raw))]

/-- `beneath_hands_over`: `/pc` resolves its own paths (`"resolvesPaths": true`). -/
def device : Json :=
  let S := deviceTrace true
  -- What the device itself refuses its user (`vault`) is not a resolution: no step asks it.
  let steps : List (Cred × Path × Bool × Bool × List String) :=
    [(u2, [], true, false, ["pc", "home", "me", "f"]), (u2, [], true, false, ["pc", "home", "me", "..", "me", "f"]),
     (u2, [], true, false, ["pc", "home", "me", "up", "f"]), (u2, [], true, false, ["pc", "locked", "inner", "x"]),
     (u2, ["pc", "home", "me"], true, false, ["f"]), (u2, ["pc", "home", "me"], true, false, [".."]),
     (u2, ["pc", "safe"], true, false, ["out"]), (u2, ["pc", "safe"], true, false, ["up"]),
     (u2, ["pc"], true, false, ["safe", "out"]), (u2, [], true, false, ["pc", "safe", "up"]),
     -- A sibling of the nested mount, handed over past `locked` (as kernel: the device
     -- itself would refuse uid 2 its own `locked`, which is no resolution).
     (kernel, [], true, false, ["pc", "locked", "sib"]),
     -- The nested mount is not flagged: below it every component is looked up.
     (kernel, [], true, false, ["pc", "locked", "inner", "x", "child"]), (kernel, [], true, false, ["pc", "locked", "inner", "x"]),
     (kernel, [], true, false, ["pc", "locked", "inner", "al"]), (kernel, ["pc", "locked", "inner"], true, false, ["al"]),
     (kernel, [], false, false, ["pc", "locked", "inner", "al"]),
     -- From a root inside the device its links are read as it reads them, re-rooted at /pc.
     (u2, ["pc", "home", "me"], true, false, ["up", "f"]), (u2, ["pc", "home", "me"], true, false, ["climb", "f"]),
     (u2, ["pc", "home", "me"], true, false, ["up"]),
     -- A link the device reads to a name the nested mount covers has no name here.
     (kernel, ["pc", "locked"], true, false, ["l"]), (kernel, ["pc", "locked"], true, false, ["inner", "x"])]
  .obj [("mounts", .arr (S.mounts.map fun m =>
      .obj [("point", .str (key m.point)), ("backend", .str s!"b{m.bk}"), ("resolvesPaths", .bool (m.point == ["pc"]))])),
    ("backends", .obj [("b0", backendJson (S.bks 0)), ("b1", backendJson (S.bks 1)), ("b2", backendJson (S.bks 2))]),
    ("steps", .arr (steps.map fun (c, R, f, abs, raw) => stepJson S c R f abs raw))]

def fixture : String :=
  fixtureText [("fixture", .str "beneath"), ("model", .str "Nimbus.Vfs.CompositeBeneath.resolveB"),
      ("principals", .arr (creds.map credJson)),
      ("note", .str "a lookup of path beneath root (a preopen, RESOLVE_BENEATH) through the composite, the root first resolved from / (EACCES unless every directory from / to root grants search), then as composite-perm's walk (search checked on every directory left from root down, every link followed in the namespace, 40 hops then ELOOP) with ENOTCAPABLE for .. at root or an absolute path; an absolute link resolves from /, and an answer that does not lie at or under root is ENOTCAPABLE; .. elsewhere pops one component, so at a mount's root it reaches the mount point's parent; a missing last component resolves; past the point of a mount with resolvesPaths whose point lies at or under root (not on the way to a mount nested in it) nothing is looked up or searched, and .. is lexical; from a root inside such a mount every component is walked")]
    ([directed, device] ++ runGen 0x42454E45 (casesOf 150 genCase))

end Nimbus.Refine.BeneathCases
