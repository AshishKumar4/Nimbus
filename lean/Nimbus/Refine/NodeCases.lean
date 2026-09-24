/-
  Nimbus.Refine.NodeCases — two fixtures for NodeNoMirrorBuild.

  `lean/fixtures/node-visible-namespace.json` (`Relist.relist_exact`): a tree
  built by root, a reader facet booted at the cursor, a window of root's
  mutations (chmods included), one ACQUIRE. The reader's namespace must be exactly
  `atCursor` before and `atAnswer` after (path → "dir" | "file").

  `lean/fixtures/node-overlay.json` (`Store.overlay_no_stale`): one facet process
  and a peer. `{"facet":"write"}` is a `writeFileSync` whose write-back is held;
  `{"facet":"rm"}` an unflushed `unlinkSync` of a file it wrote and has not
  flushed (a peer's `rm` names only a present path); `{"facet":"flush"}` delivers every
  held write-back (committed and acknowledged, in order); `{"facet":"acquire"}` a
  barrier. A read must return one of `expectAnyOf` (bytes, or "ENOENT"): the
  process's own pending effect when it has one, else a value the authority held
  at some instant between the last barrier (or boot) and now. An `acquire` never
  comes while a pending own write's path was committed by a peer since the last
  barrier: the code's barrier would wait for that write's acknowledgement, so the
  generator flushes first.
-/

import Nimbus.Refine.VisibleDeltaCases

namespace Nimbus.Refine.NodeCases

open Nimbus.Refine
open Nimbus.Refine.VisibleDeltaCases

/-! ## Visible namespace -/

def kindName (n : Nimbus.Coherence.VisibleDelta.Node) : String := if n.isDir then "dir" else "file"

def visibleJson (t : Tree) : Json :=
  .obj (((t.filter fun x => visible t x.1).mergeSort fun x y => decide (key x.1 ≤ key y.1)).map
    fun x => (key x.1, .str (kindName x.2)))

def genNsCase : Gen (Option Json) := do
  let (t0, v0, setup) ← runOps [] 0 ((← below 12) + 6)
  let (t1, _, window) ← runOps t0 v0 ((← below 6) + 1)
  return some (.obj [("setup", .arr setup.toList), ("window", .arr window.toList),
    ("atCursor", visibleJson t0), ("atAnswer", visibleJson t1)])

/-- Cases where only an exact relist can drop a held name. -/
def nsDirected : List Json :=
  let d (setup window : List Op) : Json := Id.run do
    let mut t : Tree := []
    let mut v := 0
    let mut s := #[]
    for op in setup do
      if let some t' := apply t (v + 1) op then
        v := v + 1; t := t'; s := s.push (opJson op)
    let t0 := t
    let mut w := #[]
    for op in window do
      if let some t' := apply t (v + 1) op then
        v := v + 1; t := t'; w := w.push (opJson op)
    .obj [("setup", .arr s.toList), ("window", .arr w.toList), ("atCursor", visibleJson t0), ("atAnswer", visibleJson t)]
  [ d [.mkdir ["d"] true, .mkdir ["d", "e"] true, .write ["d", "e", "x"]] [.chmod ["d", "e"] false],
    d [.mkdir ["d"] true, .write ["d", "x"], .write ["d", "y"]] [.chmod ["d"] false, .rmrf ["d", "x"], .chmod ["d"] true],
    d [.mkdir ["d"] true, .mkdir ["d", "e"] true, .write ["d", "e", "x"], .write ["d", "e", "y"]]
      [.chmod ["d"] false, .rmrf ["d", "e", "x"], .chmod ["d"] true],
    d [.mkdir ["d"] true, .mkdir ["d", "e"] true, .write ["d", "e", "x"]]
      [.chmod ["d"] false, .rename ["d", "e"] ["d", "f"], .chmod ["d"] true],
    d [.mkdir ["d"] true, .mkdir ["d", "e"] true, .write ["d", "e", "x"], .write ["q"]]
      [.chmod ["d"] false, .write ["q"]] ]

def nsFixture : String :=
  fixtureText [("fixture", .str "node-visible-namespace"), ("model", .str "Nimbus.Coherence.Relist.relist_exact"),
      ("reader", .obj [("uid", .ofNat 1000), ("gid", .ofNat 1000), ("groups", .arr [.ofNat 1000]), ("umask", .ofNat 18)]),
      ("note", .str "setup and window run as root; modes 493=0755, 448=0700; the reader facet boots after setup and ACQUIREs once after the window; paths have no leading slash")]
    (nsDirected ++ runGen 0x4E5356 (casesOf 150 genNsCase))

/-! ## Own-effect overlay -/

abbrev Val := Option Nat

structure OS where
  now : Nat
  /-- Authority history: (path, instant, value). -/
  hist : List (Nat × Nat × Val)
  own : List (Nat × Val)
  H : Nat

def valAt (h : List (Nat × Nat × Val)) (p t : Nat) : Val :=
  h.foldl (fun acc x => if x.1 = p ∧ x.2.1 ≤ t then x.2.2 else acc) none

def valJson : Val → Json
  | some n => .str s!"v{n}"
  | none => .str "ENOENT"

def allowed (s : OS) (p : Nat) : List Json :=
  match s.own.find? (·.1 == p) with
  | some (_, v) => [valJson v]
  | none =>
    let vs := (List.range (s.now + 1)).filter (s.H ≤ ·) |>.map (valAt s.hist p)
    (vs.eraseDups).map valJson

def commit (s : OS) (p : Nat) (v : Val) : OS := { s with now := s.now + 1, hist := s.hist ++ [(p, s.now + 1, v)] }

def pname (p : Nat) : String := s!"/f{p}"

def genOverlayCase : Gen (Option Json) := do
  let n := (← below 20) + 8
  let mut s : OS := { now := 0, hist := [], own := [], H := 0 }
  let mut out : Array Json := #[]
  let mut nextV := 1
  for _ in [0:n] do
    let k ← below 10
    let p ← below 3
    if k < 3 then
      s := commit s p (some nextV)
      out := out.push (.obj [("auth", .str "write"), ("path", .str (pname p)), ("bytes", .str s!"v{nextV}")])
      nextV := nextV + 1
    else if k < 4 then
      -- a peer removes only a path the authority has
      if (valAt s.hist p s.now).isSome then
        s := commit s p none
        out := out.push (.obj [("auth", .str "rm"), ("path", .str (pname p))])
    else if k < 6 then
      s := { s with own := (s.own.filter (·.1 != p)) ++ [(p, some nextV)] }
      out := out.push (.obj [("facet", .str "write"), ("path", .str (pname p)), ("bytes", .str s!"v{nextV}")])
      nextV := nextV + 1
    else if k < 7 then
      -- the process removes only a file it wrote and has not flushed
      if s.own.any fun x => x.1 == p && x.2.isSome then
        s := { s with own := (s.own.filter (·.1 != p)) ++ [(p, none)] }
        out := out.push (.obj [("facet", .str "rm"), ("path", .str (pname p))])
    else if k < 8 then
      for (q, v) in s.own do s := commit s q v
      s := { s with own := [] }
      out := out.push (.obj [("facet", .str "flush")])
    else if k < 9 then
      -- a barrier whose answer reports a path with a pending own write waits for
      -- that write's acknowledgement (`_awaitReportedOwnWrites`): flush first
      let raced := s.own.any fun x => s.hist.any fun y => y.1 == x.1 && decide (s.H < y.2.1)
      if raced then
        for (q, v) in s.own do s := commit s q v
        s := { s with own := [] }
        out := out.push (.obj [("facet", .str "flush")])
      s := { s with H := s.now }
      out := out.push (.obj [("facet", .str "acquire")])
    else
      out := out.push (.obj [("facet", .str "read"), ("path", .str (pname p)), ("expectAnyOf", .arr (allowed s p))])
  for p in List.range 3 do
    out := out.push (.obj [("facet", .str "read"), ("path", .str (pname p)), ("expectAnyOf", .arr (allowed s p))])
  return some (.obj [("steps", .arr out.toList)])

def overlayFixture : String :=
  fixtureText [("fixture", .str "node-overlay"), ("model", .str "Nimbus.Coherence.Store.overlay_no_stale"),
      ("note", .str "paths /f0../f2 start absent; a facet write-back is held until flush; flush commits and acknowledges every held write-back in order; reads happen at a resumption behind the last barrier (boot counts)")]
    (runGen 0x4F564C (casesOf 150 genOverlayCase))

end Nimbus.Refine.NodeCases
