/-
  Nimbus.Vfs.CompositeBeneath — resolution beneath a root (WASI preopens, openat2
  RESOLVE_BENEATH) through the composite (`CompositePerm`'s namespace, checks and
  links).

  `resolve(R, path)` walks `path` relative to the directory `R` exactly as
  `CompositePerm.walk` does (search checked on each directory it leaves, before the
  next lookup; every link followed in the namespace; 40 hops, then ELOOP), with three
  refusals, each ENOTCAPABLE, checked per component and per hop: `..` at `R`; an
  absolute link; an absolute `path`. `..` elsewhere pops one component, so at a
  mount's root it goes to the mount point's parent, and across the composite's own
  directories above a mount it is the same pop: there is no other way up.
  Directories above `R` are not searched (the preopen holds `R`).

  Proved:
  - `beneath_contained`: whatever `resolve(R, path)` resolves to lies at or under `R`,
    through any number of links, `..`, mounts and directories above them.
  - `beneath_named`: every directory it passes from `R` down is a directory granting
    the caller search.
  - `beneath_agrees`: when it resolves, it resolves to exactly what the unrestricted
    walk from `R` does: the refusals only refuse, they never pick another file.
  - `beneath_across_mounts` (decided, the f6f6fa6e shape): from a root above a mount
    point and from a mount point, `..` out of the mount stays beneath, and one more
    `..` at the root is ENOTCAPABLE; relative links climbing out and absolute links
    are ENOTCAPABLE; a link climbing to the mount point's parent that is still
    beneath resolves.
-/

import Nimbus.Vfs.CompositePerm

namespace Nimbus.Vfs.CompositeBeneath

open Nimbus.Vfs.CompositePerm

/-- `walk` beneath `R`. -/
def walkB (S : St) (c : Cred) (follow : Bool) (R : Path) : Nat → Nat → Path → List String → Except String Path
  | 0, _, _, _ => .error "ELOOP"
  | _ + 1, _, done, [] => .ok done
  | n + 1, h, done, x :: rs =>
    if !grants c (metaAt S done) 1 then .error "EACCES"
    else if x = "" ∨ x = "." then walkB S c follow R n h done rs
    else if x = ".." then
      if done = R then .error "ENOTCAPABLE" else walkB S c follow R n h done.dropLast rs
    else
      let q := done ++ [x]
      match entAt S q with
      | none => if rs = [] then .ok q else .error "ENOENT"
      | some (.link a t, _) =>
        if rs = [] ∧ follow = false then .ok q
        else if h = 0 then .error "ELOOP"
        else if a then .error "ENOTCAPABLE"
        else walkB S c follow R n (h - 1) done (t ++ rs)
      | some (.dir, _) => walkB S c follow R n h q rs
      | some (.file _, _) => if rs = [] then .ok q else .error "ENOTDIR"

/-- `path` (its components; `abs` when it began with `/`) resolved beneath `R`. -/
def resolveB (S : St) (c : Cred) (follow : Bool) (R : Path) (abs : Bool) (raw : List String) : Except String Path :=
  if abs then .error "ENOTCAPABLE" else walkB S c follow R fuel maxLinks R raw

/-! ## Contained -/

theorem prefix_dropLast {R d : Path} (h : R <+: d) (hne : d ≠ R) : R <+: d.dropLast := by
  obtain ⟨t, rfl⟩ := h
  have ht : t ≠ [] := by rintro rfl; simp at hne
  rw [List.dropLast_append_of_ne_nil _ ht]
  exact List.prefix_append _ _

theorem walkB_contained (S : St) (c : Cred) (f : Bool) (R : Path) :
    ∀ n h done rs p, R <+: done → walkB S c f R n h done rs = .ok p → R <+: p := by
  intro n
  induction n with
  | zero => intro _ _ _ _ _ h; simp [walkB] at h
  | succ n ih =>
    intro h done rs p hR hw
    have snoc : ∀ x, R <+: done ++ [x] := fun x => hR.trans (List.prefix_append _ _)
    cases rs with
    | nil => simp only [walkB, Except.ok.injEq] at hw; subst hw; exact hR
    | cons x rs =>
      simp only [walkB] at hw
      split at hw
      · cases hw
      · split at hw
        · exact ih _ _ _ _ hR hw
        · split at hw
          · split at hw
            · cases hw
            · exact ih _ _ _ _ (prefix_dropLast hR ‹_›) hw
          · split at hw
            · split at hw
              · cases hw; exact snoc x
              · cases hw
            · split at hw
              · cases hw; exact snoc x
              · split at hw
                · cases hw
                · split at hw
                  · cases hw
                  · exact ih _ _ _ _ hR hw
            · exact ih _ _ _ _ (snoc x) hw
            · split at hw
              · cases hw; exact snoc x
              · cases hw

/-- Whatever a path resolves to beneath `R` lies at or under `R`. -/
theorem beneath_contained (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) : R <+: p := by
  unfold resolveB at h
  split at h
  · cases h
  · exact walkB_contained S c f R _ _ _ _ p (List.prefix_refl R) h

/-! ## Searched from the root down -/

/-- Every directory on `d` from `R` down (each prefix of length at least `R`'s, short
    of `d`) is a directory granting search. -/
def NamedFrom (S : St) (c : Cred) (R d : Path) : Prop :=
  ∀ i, R.length ≤ i → i < d.length → IsDir S (d.take i) ∧ grants c (metaAt S (d.take i)) 1 = true

theorem namedFrom_snoc {S : St} {c : Cred} {R d : Path} (x : String) (hn : NamedFrom S c R d) (hd : IsDir S d)
    (hg : grants c (metaAt S d) 1 = true) : NamedFrom S c R (d ++ [x]) := by
  intro i hR hi
  simp only [List.length_append, List.length_singleton] at hi
  by_cases e : i = d.length
  · subst e; rw [List.take_append_of_le_length (Nat.le_refl _), List.take_length]; exact ⟨hd, hg⟩
  · rw [List.take_append_of_le_length (by omega)]; exact hn i hR (by omega)

theorem namedFrom_dropLast {S : St} {c : Cred} {R d : Path} (hn : NamedFrom S c R d) (hR : R <+: d)
    (hne : d ≠ R) : NamedFrom S c R d.dropLast ∧ IsDir S d.dropLast := by
  have hlt : R.length < d.length := by
    obtain ⟨t, rfl⟩ := hR
    have : t ≠ [] := by rintro rfl; simp at hne
    simp [List.length_pos.mpr this]
  rw [List.dropLast_eq_take]
  refine ⟨fun i hr hi => ?_, ?_⟩
  · simp only [List.length_take] at hi
    rw [List.take_take, Nat.min_eq_left (by omega)]
    exact hn i hr (by omega)
  · exact (hn _ (by omega) (by omega)).1

theorem walkB_named (S : St) (c : Cred) (f : Bool) (R : Path) :
    ∀ n h done rs p, R <+: done → NamedFrom S c R done → IsDir S done →
      walkB S c f R n h done rs = .ok p → NamedFrom S c R p := by
  intro n
  induction n with
  | zero => intro _ _ _ _ _ _ _ h; simp [walkB] at h
  | succ n ih =>
    intro h done rs p hR hn hd hw
    have snocR : ∀ x, R <+: done ++ [x] := fun x => hR.trans (List.prefix_append _ _)
    cases rs with
    | nil => simp only [walkB, Except.ok.injEq] at hw; subst hw; exact hn
    | cons x rs =>
      simp only [walkB] at hw
      split at hw
      · cases hw
      · rename_i hg
        have hg : grants c (metaAt S done) 1 = true := by simpa using hg
        split at hw
        · exact ih _ _ _ _ hR hn hd hw
        · split at hw
          · split at hw
            · cases hw
            · rename_i hne
              have := namedFrom_dropLast hn hR hne
              exact ih _ _ _ _ (prefix_dropLast hR hne) this.1 this.2 hw
          · split at hw
            · split at hw
              · cases hw; exact namedFrom_snoc x hn hd hg
              · cases hw
            · split at hw
              · cases hw; exact namedFrom_snoc x hn hd hg
              · split at hw
                · cases hw
                · split at hw
                  · cases hw
                  · exact ih _ _ _ _ hR hn hd hw
            · rename_i m he
              exact ih _ _ _ _ (snocR x) (namedFrom_snoc x hn hd hg) ⟨m, he⟩ hw
            · split at hw
              · cases hw; exact namedFrom_snoc x hn hd hg
              · cases hw

/-- Every directory from `R` down to what `R`'s path resolves to is a directory that
    grants the caller search. -/
theorem beneath_named (S : St) (c : Cred) (f : Bool) (R : Path) (hR : IsDir S R) (abs : Bool) (raw : List String)
    (p : Path) (h : resolveB S c f R abs raw = .ok p) :
    ∀ i, R.length ≤ i → i < p.length → IsDir S (p.take i) ∧ grants c (metaAt S (p.take i)) 1 = true := by
  unfold resolveB at h
  split at h
  · cases h
  · exact walkB_named S c f R _ _ _ _ p (List.prefix_refl R)
      (fun i h1 h2 => absurd h2 (by omega)) hR h

/-! ## The refusals only refuse -/

theorem walkB_agrees (S : St) (c : Cred) (f : Bool) (R : Path) :
    ∀ n h done rs p, walkB S c f R n h done rs = .ok p → walk S c f n h done rs = .ok p := by
  intro n
  induction n with
  | zero => intro _ _ _ _ h; simp [walkB] at h
  | succ n ih =>
    intro h done rs p hw
    cases rs with
    | nil => simpa [walkB, walk] using hw
    | cons x rs =>
      simp only [walkB] at hw
      simp only [walk]
      split at hw
      · cases hw
      · rename_i hg
        rw [if_neg hg]
        split at hw
        · rw [if_pos ‹_›]; exact ih _ _ _ _ hw
        · rw [if_neg ‹_›]
          split at hw
          · rw [if_pos ‹_›]
            split at hw
            · cases hw
            · exact ih _ _ _ _ hw
          · rw [if_neg ‹_›]
            revert hw
            cases he : entAt S (done ++ [x]) with
            | none => simp
            | some km =>
              obtain ⟨k, m⟩ := km
              cases k with
              | dir => exact ih _ _ _ _
              | file b => simp
              | link a t =>
                simp only
                intro hw
                split at hw
                · rw [if_pos ‹_›]; exact hw
                · rw [if_neg ‹_›]
                  split at hw
                  · cases hw
                  · rw [if_neg ‹_›]
                    split at hw
                    · cases hw
                    · rename_i ha
                      simp only [Bool.not_eq_true] at ha
                      subst ha
                      exact ih _ _ _ _ hw

/-- When `path` resolves beneath `R`, it resolves to exactly what the unrestricted
    walk from `R` gives. -/
theorem beneath_agrees (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) : walk S c f fuel maxLinks R raw = .ok p := by
  unfold resolveB at h
  split at h
  · cases h
  · exact walkB_agrees S c f R _ _ _ _ p h

/-! ## Across mounts (f6f6fa6e) -/

/-- A resolution's answer as data: the error, or `""` and the path. -/
def ans : Except String Path → String × Path
  | .error e => (e, [])
  | .ok p => ("", p)

/-- `/a/m` mounts backend 1 (holding `x/f`, `up -> ../../etc/p`, `side -> ../n`,
    `abs -> /etc/p`, `loop -> loop`); the root holds `/a/n` and `/etc/p`. -/
def mountTrace : St :=
  { mounts := [⟨["a", "m"], 1⟩],
    bks := fun k => if k = 0 then
        sqlite [(["a"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["a", "n"], ⟨.file 3, ⟨0o644, 0, 0⟩⟩),
          (["etc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["etc", "p"], ⟨.file 5, ⟨0o644, 0, 0⟩⟩)]
      else memory [(["x"], ⟨.dir, synthMeta⟩), (["x", "f"], ⟨.file 7, synthMeta⟩),
          (["up"], ⟨.link false ["..", "..", "etc", "p"], synthMeta⟩),
          (["side"], ⟨.link false ["..", "n"], synthMeta⟩),
          (["abs"], ⟨.link true ["etc", "p"], synthMeta⟩),
          (["loop"], ⟨.link false ["loop"], synthMeta⟩)] }

theorem beneath_across_mounts :
    let S := mountTrace
    let R := ["a"]
    let M := ["a", "m"]
    ans (resolveB S u2 true R false ["m", "x", "..", "..", "n"]) = ("", ["a", "n"]) ∧
    ans (resolveB S u2 true R false ["m", ".."]) = ("", ["a"]) ∧
    ans (resolveB S u2 true R false ["m", "..", ".."]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true R false ["m", "x", "..", "..", "..", "etc", "p"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true R false ["m", "side"]) = ("", ["a", "n"]) ∧
    ans (resolveB S u2 true R false ["m", "up"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true R false ["m", "abs"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true M false [".."]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true M false ["side"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 false M false ["abs"]) = ("", ["a", "m", "abs"]) ∧
    ans (resolveB S u2 true M true ["x"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB S u2 true M false ["loop"]) = ("ELOOP", []) ∧
    ans (walk S u2 true fuel maxLinks M ["up"]) = ("", ["etc", "p"]) := by
  decide

end Nimbus.Vfs.CompositeBeneath
