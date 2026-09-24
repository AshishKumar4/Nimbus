/-
  Negative regression probe — REVISION-IS-LAST FAMILY. This file must NEVER
  compile.

  The tempting axiom: a path reports exactly its last mutation. It is false
  since d35e88c6 bounded the per-path map: a dropped path reports the floor,
  which can be newer than its own last write (a directory above it, or another
  path, was stamped later). The proof below derives `False` from it; with the
  axiom absent it must fail as an UNKNOWN IDENTIFIER, which check-no-false.sh
  holds it to.
-/

import Nimbus.Vfs.RevisionFloor

open Nimbus.Vfs.RevisionFloor

theorem boom_revision_is_last : False := by
  have hc1 : Closed 1 init.stamps := by intro q hq; simp [init] at hq
  let s1 := bump init [["a"]]
  have hst1 : s1.stamps = fun q => if [["a"]].any (fun p => decide (Under q p)) then some 1 else none :=
    walkAll_eq 1 [["a"]] ⟨init.stamps⟩ hc1
  have hc2 : Closed 2 s1.stamps := by
    intro q hq; rw [hst1] at hq; simp at hq
  let s2 := bump s1 [["b"]]
  let s3 := drop s2 2
  have h : Reachable s3 := .step (.step (.step .init (.bump _ _)) (.bump _ _)) (.drop _ 2 (by decide))
  have e := Nimbus.Vfs.RevisionFloor.revision_eq_last s3 h ["a"] (by simp)
  have ha : s1.stamps ["a"] = some 1 := by rw [hst1]; decide
  have hst2 : s2.stamps = fun q => if [["b"]].any (fun p => decide (Under q p)) then some 2 else s1.stamps q :=
    walkAll_eq 2 [["b"]] ⟨s1.stamps⟩ hc2
  have ha2 : s2.stamps ["a"] = some 1 := by rw [hst2]; simp; rw [ha]; decide
  have hdrop : s3.stamps ["a"] = none := by
    show (match s2.stamps ["a"] with | some v => if v ≤ 2 then none else some v | none => none) = none
    rw [ha2]; rfl
  have hr : revision s3 ["a"] = 2 := by
    unfold revision; rw [if_neg (by simp), hdrop]; rfl
  have hl : s3.last ["a"] = 1 := by simp [s3, drop, s2, s1, bump, init]; decide
  rw [hr, hl] at e
  exact absurd e (by decide)
