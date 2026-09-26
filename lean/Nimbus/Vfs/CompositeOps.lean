/-
  Nimbus.Vfs.CompositeOps — the composite operations phase 1 ships beyond the core
  ones in `Composite`: `removeRecursive` (native, or the fallback walk with its
  partial-removal report), the never-emulated capabilities (`readRange`,
  `writeFileIfRevision`, `readFileAtRevision`), `copy` across mounts, and modes of
  mount points.

  A backend's capabilities are static configuration (`Caps`), not state: which
  optional methods it has, whether it reports POSIX modes (and its root's mode),
  and, for a backend without `removeRecursive`, the entries its `unlink`/`rmdir`
  refuse (`pins`) — the only way the fallback can leave a partial result.

  Rules (DECIDED where DESIGN.md is silent, flagged to the Filesystem lane):
  - All walk with `follow = false` for their operands (`readRange` and the CAS reads
    follow the final link) and answer walk errors, then ENXIO, first.
  - `removeRecursive p`: `/`, a live mount point or an ancestor of one → EBUSY.
    Native: the subtree goes. Fallback: post-order, an entry is removed unless it
    is pinned or holds a pinned entry; the report names the roots of the removed
    subtrees (native: only the operand, no walk) and every kept entry
    (`fallback_report_exact`, `roots_exact`). Only `p`'s backend changes
    (`removeRecursive_stays_in_mount`).
  - `readRange`, `writeFileIfRevision`, `readFileAtRevision`: lookup first (a
    missing path is ENOENT, as on Linux — Main's ruling); an existing path on a
    backend without them → ENOTSUP, nothing changes (`unsupported_is_enotsup`); with
    them the model only asserts support (revisions are `Coherence`'s).
  - `copy from to recursive`: across mounts allowed. Source: `/` or an ancestor of
    a live mount that is not itself a mount point → ENOTSUP (a tree holding another
    mount is not copied); a live mount point copies its backend. Target: `/`, a
    live mount point or an ancestor → EBUSY. Then POSIX-like: ENOENT (source),
    EISDIR (directory without `recursive`), ENOENT/ENOTDIR (target parent),
    EINVAL (target inside the source), EEXIST (a directory onto anything that
    exists), EISDIR (a file onto a directory), a file onto a file replaces it. Only
    the target's backend changes (`copy_stays_in_target`); the count is the number
    of entries copied.
  - Modes (`mount_point_mode`): `stat` of a live mount point reports its backend
    root's mode, synthesized (0755) only when the backend reports none; a
    synthesized ancestor reports 0755; `/` reports the root backend's root mode.
-/

import Nimbus.Vfs.Composite

namespace Nimbus.Vfs.CompositeOps

open Nimbus.Vfs.Composite

structure Caps where
  removeRecursive : Bool
  readRange : Bool
  cas : Bool
  /-- `some m`: the backend reports modes, its root has mode `m`. -/
  rootMode : Option Nat
  pins : List Path
  deriving DecidableEq, Repr

inductive X where
  | removeRecursive (p : String)
  | readRange (p : String)
  | writeFileIfRevision (p : String)
  | readFileAtRevision (p : String)
  | copy (a b : String) (recursive : Bool)
  | statMode (p : String)

inductive XOut where
  | err (code : String)
  | report (removed kept : List Path)
  | bytes (b : Nat)
  | supported
  | count (n : Nat)
  | dir (mode : Option Nat)
  | other (o : Out)
  deriving DecidableEq, Repr

def synthMode : Nat := 493

/-! ## Recursive removal -/

def subtree (t : Tree) (rp : Path) : List Path := (t.filter fun x => pfx rp x.1).map (·.1)

/-- An entry stays when it is pinned or holds a pinned entry. -/
def keeps (pins : List Path) (q : Path) : Bool := pins.any fun pin => pfx q pin

/-- The fallback walk: the new tree, the entries removed, the entries kept. -/
def fallbackRemove (t : Tree) (pins : List Path) (rp : Path) : Tree × List Path × List Path :=
  let sub := subtree t rp
  let removed := sub.filter fun q => !keeps pins q
  let kept := sub.filter fun q => keeps pins q
  (t.filter fun x => !(pfx rp x.1 && !keeps pins x.1), removed, kept)

/-- The report is exact: every entry of the subtree is reported once, removed
    entries are gone, kept entries remain, and nothing outside the subtree moves. -/
theorem fallback_report_exact (t : Tree) (pins : List Path) (rp : Path) :
    let r := fallbackRemove t pins rp
    (∀ q ∈ r.2.1, q ∉ r.1.map (·.1)) ∧ (∀ q ∈ r.2.2, q ∈ r.1.map (·.1)) ∧
    (∀ q ∈ subtree t rp, (q ∈ r.2.1 ∨ q ∈ r.2.2) ∧ ¬ (q ∈ r.2.1 ∧ q ∈ r.2.2)) ∧
    (∀ x ∈ t, pfx rp x.1 = false → x ∈ r.1) := by
  simp only [fallbackRemove]
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro q hq hm
    obtain ⟨hs, hk⟩ := List.mem_filter.mp hq
    obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hm
    obtain ⟨_, hk'⟩ := List.mem_filter.mp hx
    obtain ⟨y, hy, hyq⟩ := List.mem_map.mp hs
    obtain ⟨_, hpy⟩ := List.mem_filter.mp hy
    rw [← hyq] at hk
    simp_all
  · intro q hq
    obtain ⟨hs, hk⟩ := List.mem_filter.mp hq
    obtain ⟨y, hy, rfl⟩ := List.mem_map.mp hs
    exact List.mem_map.mpr ⟨y, List.mem_filter.mpr ⟨(List.mem_filter.mp hy).1, by simp_all⟩, rfl⟩
  · intro q hq
    by_cases hk : keeps pins q = true
    · exact ⟨Or.inr (List.mem_filter.mpr ⟨hq, hk⟩), fun ⟨h1, _⟩ => by simp [hk] at h1⟩
    · exact ⟨Or.inl (List.mem_filter.mpr ⟨hq, by simpa using hk⟩), fun ⟨_, h2⟩ => hk (List.mem_filter.mp h2).2⟩
  · intro x hx hp
    exact List.mem_filter.mpr ⟨hx, by simp [hp]⟩

/-- The report lists removed subtrees by their roots: a removed entry whose parent
    was not removed, or which is the operand itself. Native removal reports only the
    operand, without walking the subtree. -/
def roots (rp : Path) (removed : List Path) : List Path :=
  removed.filter fun q => q == rp || !removed.contains q.dropLast

theorem keeps_mono {pins : List Path} {r q : Path} (h : pfx r q = true) (hk : keeps pins q = true) :
    keeps pins r = true := by
  obtain ⟨pin, hp, hq⟩ := List.any_eq_true.mp hk
  exact List.any_eq_true.mpr ⟨pin, hp, pfx_iff.mpr ((pfx_iff.mp h).trans (pfx_iff.mp hq))⟩

/-- The roots report is exact: every removed entry lies under a listed root, and
    every subtree entry under a listed root was removed. -/
theorem roots_exact (t : Tree) (pins : List Path) (rp : Path) :
    let r := fallbackRemove t pins rp
    (∀ q ∈ r.2.1, ∃ x ∈ roots rp r.2.1, pfx x q = true) ∧
    (∀ x ∈ roots rp r.2.1, ∀ q ∈ subtree t rp, pfx x q = true → q ∈ r.2.1) := by
  simp only [fallbackRemove]
  constructor
  · intro q
    induction q using (measure List.length).wf.induction with
    | _ q ih =>
    intro hq
    by_cases hr : (q == rp || !(subtree t rp |>.filter fun q => !keeps pins q).contains q.dropLast) = true
    · exact ⟨q, List.mem_filter.mpr ⟨hq, hr⟩, pfx_iff.mpr (List.prefix_refl q)⟩
    · simp only [Bool.or_eq_true, beq_iff_eq, Bool.not_eq_true', not_or] at hr
      have hpar : q.dropLast ∈ (subtree t rp).filter fun q => !keeps pins q := by
        have := hr.2; simpa using this
      have hlen : q.dropLast.length < q.length := by
        cases q with
        | nil =>
          exfalso
          obtain ⟨hs, _⟩ := List.mem_filter.mp hq
          obtain ⟨y, hy, hyq⟩ := List.mem_map.mp hs
          have := (List.mem_filter.mp hy).2
          rw [hyq] at this
          have := pfx_iff.mp this
          exact hr.1 (List.prefix_nil.mp this).symm
        | cons _ _ => simp [List.length_dropLast]
      obtain ⟨x, hx, hxp⟩ := ih _ hlen hpar
      exact ⟨x, hx, pfx_iff.mpr ((pfx_iff.mp hxp).trans (List.dropLast_prefix q))⟩
  · intro x hx q hq hxq
    obtain ⟨hxr, _⟩ := List.mem_filter.mp hx
    obtain ⟨_, hxk⟩ := List.mem_filter.mp hxr
    refine List.mem_filter.mpr ⟨hq, ?_⟩
    cases hk : keeps pins q
    · rfl
    · have := keeps_mono hxq hk
      simp [this] at hxk

/-! ## The operations -/

def reach (S : St) (P : Principal) (follow : Bool) (raw : String) : Except String Path :=
  match walkRaw S P follow raw with
  | none => .error "ELOOP"
  | some (.error e) => .error e
  | some (.ok p) => if absent S.mounts P p then .error "ENXIO" else .ok p

def isMountPoint (S : St) (P : Principal) (p : Path) : Bool :=
  S.mounts.any fun m => m.point == p && live P m

def relocate (t : Tree) (rs rq : Path) : Tree :=
  (t.filter fun x => pfx rs x.1 && x.1 != rs).map fun x => (rq ++ x.1.drop rs.length, x.2)

variable (caps : Backend → Caps)

def execX (S : St) (P : Principal) : X → XOut × St
  | .removeRecursive raw =>
    match reach S P false raw with
    | .error e => (.err e, S)
    | .ok p =>
      if p = [] ∨ synth S.mounts P p then (.err "EBUSY", S) else
      let b := (route S.mounts p).backend
      let t := S.trees b
      let rp := rel S.mounts p
      if (look t rp).isNone then (.err "ENOENT", S)
      else if (caps b).removeRecursive then
        (.report [(route S.mounts p).point ++ rp] [], setTree S b (cut t rp))
      else
        let (t', removed, kept) := fallbackRemove t (caps b).pins rp
        (.report ((roots rp removed).map ((route S.mounts p).point ++ ·)) (kept.map ((route S.mounts p).point ++ ·)),
          setTree S b t')
  | .readRange raw =>
    match reach S P true raw with
    | .error e => (.err e, S)
    | .ok p =>
      if synth S.mounts P p then (.err "EISDIR", S)
      else match look (treeAt S p) (rel S.mounts p) with
        | none => (.err "ENOENT", S)
        | some e =>
          if !(caps (route S.mounts p).backend).readRange then (.err "ENOTSUP", S)
          else match e with
            | .file v => (.bytes v, S)
            | _ => (.err "EISDIR", S)
  | .writeFileIfRevision raw =>
    match reach S P true raw with
    | .error e => (.err e, S)
    | .ok p =>
      if synth S.mounts P p then (.err "EISDIR", S)
      else if (look (treeAt S p) (rel S.mounts p)).isNone then (.err "ENOENT", S)
      else if !(caps (route S.mounts p).backend).cas then (.err "ENOTSUP", S)
      else (.supported, S)
  | .readFileAtRevision raw =>
    match reach S P true raw with
    | .error e => (.err e, S)
    | .ok p =>
      if synth S.mounts P p then (.err "EISDIR", S)
      else if (look (treeAt S p) (rel S.mounts p)).isNone then (.err "ENOENT", S)
      else if !(caps (route S.mounts p).backend).cas then (.err "ENOTSUP", S)
      else (.supported, S)
  | .copy ra rb recursive =>
    match reach S P false ra with
    | .error e => (.err e, S)
    | .ok a =>
      match reach S P false rb with
      | .error e => (.err e, S)
      | .ok q =>
        if (a = [] ∨ synth S.mounts P a) ∧ !isMountPoint S P a then (.err "ENOTSUP", S)
        else if q = [] ∨ synth S.mounts P q then (.err "EBUSY", S)
        else
          let sb := (route S.mounts a).backend
          let ts := S.trees sb
          let rs := rel S.mounts a
          let tb := (route S.mounts q).backend
          let tt := S.trees tb
          let rq := rel S.mounts q
          match (if isMountPoint S P a then some Ent.dir else look ts rs) with
          | none => (.err "ENOENT", S)
          | some src =>
            if src = .dir ∧ recursive = false then (.err "EISDIR", S)
            else if look tt rq.dropLast = none then (.err "ENOENT", S)
            else if look tt rq.dropLast ≠ some .dir then (.err "ENOTDIR", S)
            else if pfx a q then (.err "EINVAL", S)
            else match look tt rq, src with
              | some _, .dir => (.err "EEXIST", S)
              | some .dir, _ => (.err "EISDIR", S)
              | _, .dir =>
                let rel' := relocate ts rs rq
                (.count (1 + rel'.length), setTree S tb (tt ++ [(rq, .dir)] ++ rel'))
              | _, e => (.count 1, setTree S tb ((tt.filter (·.1 != rq)) ++ [(rq, e)]))
  | .statMode raw =>
    match reach S P true raw with
    | .error "ENXIO" => (.other .null, S)
    | .error "ENOENT" => (.other .null, S)
    | .error e => (.err e, S)
    | .ok p =>
      if p = [] then (.dir (some ((caps 0).rootMode.getD synthMode)), S)
      else if isMountPoint S P p then (.dir (some ((caps (route S.mounts p).backend).rootMode.getD synthMode)), S)
      else if synth S.mounts P p then (.dir (some synthMode), S)
      else (.other (exec S P (.stat raw)).1, S)

/-! ## What is proved -/

def Frame (S S' : St) (b : Backend) : Prop := S'.mounts = S.mounts ∧ ∀ c, c ≠ b → S'.trees c = S.trees c

theorem frame_refl (S : St) (b : Backend) : Frame S S b := ⟨rfl, fun _ _ => rfl⟩

theorem frame_set (S : St) (b : Backend) (t : Tree) : Frame S (setTree S b t) b :=
  ⟨rfl, fun c hc => by simp [setTree, hc]⟩

/-- `removeRecursive` changes only the backend serving its operand: it never
    crosses into another mount, and `/`, a live mount point or an ancestor of one is
    EBUSY with nothing changed. -/
theorem removeRecursive_stays_in_mount (S : St) (P : Principal) (raw : String) :
    (∀ p, reach S P false raw = .ok p → Frame S (execX caps S P (.removeRecursive raw)).2 (route S.mounts p).backend) ∧
    (∀ p, reach S P false raw = .ok p → (p = [] ∨ synth S.mounts P p = true) →
      execX caps S P (.removeRecursive raw) = (.err "EBUSY", S)) := by
  refine ⟨fun p hp => ?_, fun p hp hs => ?_⟩
  · simp only [execX, hp]
    split
    · exact frame_refl _ _
    · split
      · exact frame_refl _ _
      · split
        · exact frame_set _ _ _
        · exact frame_set _ _ _
  · simp only [execX, hp]
    rw [if_pos hs]

/-- A capability the backend lacks answers ENOTSUP and is never emulated. -/
theorem unsupported_is_enotsup (S : St) (P : Principal) (raw : String) (p : Path)
    (hp : reach S P true raw = .ok p) (hs : synth S.mounts P p = false) {e : Ent}
    (he : look (treeAt S p) (rel S.mounts p) = some e) :
    ((caps (route S.mounts p).backend).readRange = false → execX caps S P (.readRange raw) = (.err "ENOTSUP", S)) ∧
    ((caps (route S.mounts p).backend).cas = false →
      execX caps S P (.writeFileIfRevision raw) = (.err "ENOTSUP", S) ∧
      execX caps S P (.readFileAtRevision raw) = (.err "ENOTSUP", S)) := by
  refine ⟨fun h => ?_, fun h => ⟨?_, ?_⟩⟩ <;> simp [execX, hp, hs, h, he]

/-- `copy` changes only the target's backend (so a source in another mount is
    untouched). -/
theorem copy_stays_in_target (S : St) (P : Principal) (ra rb : String) (r : Bool) (q : Path)
    (hq : ∀ a, reach S P false ra = .ok a → reach S P false rb = .ok q) :
    Frame S (execX caps S P (.copy ra rb r)).2 (route S.mounts q).backend := by
  simp only [execX]
  split
  · exact frame_refl _ _
  · rename_i a ha
    rw [hq a ha]
    simp only
    split
    · exact frame_refl _ _
    · split
      · exact frame_refl _ _
      · split
        · exact frame_refl _ _
        · split
          · exact frame_refl _ _
          · split
            · exact frame_refl _ _
            · split
              · exact frame_refl _ _
              · split
                · exact frame_refl _ _
                · split
                  · exact frame_refl _ _
                  · exact frame_refl _ _
                  · exact frame_set _ _ _
                  · exact frame_set _ _ _

/-- A live mount point reports its backend root's mode when the backend has modes. -/
theorem mount_point_mode (S : St) (P : Principal) (raw : String) (p : Path) (hp : reach S P true raw = .ok p)
    (hne : p ≠ []) (hm : isMountPoint S P p = true) (m : Nat)
    (hmode : (caps (route S.mounts p).backend).rootMode = some m) :
    execX caps S P (.statMode raw) = (.dir (some m), S) := by
  simp [execX, hp, hne, hm, hmode]

end Nimbus.Vfs.CompositeOps
