/-
  Negative regression probe — REVISION-IS-LAST FAMILY. This file must NEVER
  compile.

  The tempting axiom: a path reports exactly its last mutation. It is false
  since d35e88c6 bounded the per-path map: a path that is not a file and
  holds no stamp reports at least the floor, which can be newer than its own
  last change (another path was stamped later, and its stamp dropped). The proof below derives `False` from it; with the
  axiom absent it must fail as an UNKNOWN IDENTIFIER, which check-no-false.sh
  holds it to.
-/

import Nimbus.Vfs.RevisionFloor

open Nimbus.Vfs.RevisionFloor

theorem boom_revision_is_last : False := by
  let s1 := bump init [["a"]] [] (fun _ => 1) 1
  let s2 := bump s1 [["b"]] [] (fun _ => 2) 2
  let s3 := drop s2 2
  have ok1 : BumpOk init [["a"]] [] (fun _ => 1) 1 :=
    ⟨by simp [init], by intro p _; simp [init], by simp, by intros; rfl, by simp⟩
  have ok2 : BumpOk s1 [["b"]] [] (fun _ => 2) 2 :=
    ⟨by simp [s1, bump], by intro p _; simp [s1, bump], by simp, by intros; simp [s1, bump, init], by simp⟩
  have h1 : Reachable s1 := .step .init (.bump _ _ _ _ _ ok1)
  have h : Reachable s3 := .step (.step h1 (.bump _ _ _ _ _ ok2)) (.drop _ 2 (by simp [s2, bump]))
  have e := Nimbus.Vfs.RevisionFloor.revision_eq_last s3 h ["a"] (by simp)
  -- ["a"] was mutated at 1 and holds no stamp; the drop to 2 raised the floor past it.
  have hst1 : s1.stamps = bumped 1 init.stamps [["a"]] := bump_stamps init_inv ok1
  have hst2 : s2.stamps = bumped 2 s1.stamps [["b"]] := bump_stamps (reachable_inv h1) ok2
  have ha2 : s2.stamps ["a"] = none := by rw [hst2, hst1]; decide
  have hdrop : s3.stamps ["a"] = none := by
    show (match s2.stamps ["a"] with | some v => if v ≤ 2 then none else some v | none => none) = none
    rw [ha2]
  have hr : revision s3 ["a"] = 2 := by
    unfold revision; rw [if_neg (by simp), hdrop]; simp [s3, drop, s2, s1, bump, init]; decide
  have hl : s3.last ["a"] = 1 := by simp [s3, drop, s2, s1, bump, init, above]; decide
  rw [hr, hl] at e
  exact absurd e (by decide)
