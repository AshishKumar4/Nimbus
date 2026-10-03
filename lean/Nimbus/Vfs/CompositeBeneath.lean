/-
  Nimbus.Vfs.CompositeBeneath — resolution beneath a root (WASI preopens, openat2
  RESOLVE_BENEATH) through the composite (`CompositePerm`'s namespace, checks and
  links).

  `resolve(R, path)` walks `path` relative to the directory `R` exactly as
  `CompositePerm.walk` does (search checked on each directory it leaves, before the
  next lookup; every link followed in the namespace, a relative one from its
  directory and an absolute one from `/`; 40 hops, then ELOOP), with three
  refusals, each ENOTCAPABLE: `..` at `R` and an absolute `path`, checked per
  component, and an answer that does not lie at or under `R`, checked once at the
  end. `..` elsewhere pops one component, so at a mount's root it goes to the mount
  point's parent, and across the composite's own directories above a mount it is
  the same pop: there is no other way up. An absolute link leaves `R` only for as
  long as the walk is away: where it leads must come back beneath `R`.
  The root itself is resolved by name first: every directory from `/` down to `R`
  must grant search, else EACCES (as Nimbus re-resolves a descriptor root by path).
  Past the point of a mount whose backend resolves its own paths (`hands`), as in
  `walk`, nothing is looked up, searched or read as a link, and `..` is lexical: that
  backend answers for the rest, and the answer is still checked beneath `R`.

  Proved:
  - `beneath_contained`: whatever `resolve(R, path)` resolves to lies at or under `R`,
    through any number of links, `..`, mounts and directories above them.
  - `beneath_named`: every directory it passes from `R` down is a directory granting
    the caller search, an absolute link's walk from `/` included;
    `beneath_root_searched`: so does every directory from `/` to `R`, because the
    root is resolved by name first (EACCES otherwise: stricter than Linux, which
    trusts the preopen's descriptor, and never looser).
  - `beneath_agrees`: when it resolves, it resolves to exactly what the unrestricted
    walk from `R` does: the refusals only refuse, they never pick another file.
  - `beneath_hands_over` (decided): a device that resolves its own paths serves its
    user's file under a directory the composite would refuse them, its links are its
    own, the way to a mount nested in it is still searched, and `..` at `R` is still
    ENOTCAPABLE.
  - `beneath_across_mounts` (decided, the f6f6fa6e shape): from a root above a mount
    point and from a mount point, `..` out of the mount stays beneath, and one more
    `..` at the root is ENOTCAPABLE; relative links climbing out are ENOTCAPABLE; a
    link climbing to the mount point's parent that is still beneath resolves; an
    absolute link resolves from `/` where it lands beneath the root, and is
    ENOTCAPABLE where it does not.
-/

import Nimbus.Vfs.CompositePerm

namespace Nimbus.Vfs.CompositeBeneath

open Nimbus.Vfs.CompositePerm

/-- `walk` beneath `R`. -/
def walkB (S : St) (c : Cred) (follow : Bool) (R : Path) : Nat → Nat → Path → List String → Except String Path
  | 0, _, _, _ => .error "ELOOP"
  | _ + 1, _, done, [] => .ok done
  | n + 1, h, done, x :: rs =>
    if handed S done x then
      if x = "" ∨ x = "." then walkB S c follow R n h done rs
      else if x = ".." then
        if done = R then .error "ENOTCAPABLE" else walkB S c follow R n h done.dropLast rs
      else walkB S c follow R n h (done ++ [x]) rs
    else if !grants c (metaAt S done) 1 then .error "EACCES"
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
        else walkB S c follow R n (h - 1) (if a then [] else done) (t ++ rs)
      | some (.dir, _) => walkB S c follow R n h q rs
      | some (.file _, _) => if rs = [] then .ok q else .error "ENOTDIR"

/-- The root is resolved by name from `/` (a descriptor root re-resolves by its path):
    every directory above it, and it, must grant the caller search before the walk
    leaves it. Stricter than Linux (which trusts the open descriptor), never looser. -/
def rootDenied (S : St) (c : Cred) (R : Path) : Bool :=
  (List.range R.length).any fun i => !S.hands (R.take (i + 1)) && !grants c (metaAt S (R.take i)) 1

/-- `path` (its components; `abs` when it began with `/`) resolved beneath `R`: what the
    walk reaches, when that lies at or under `R`. -/
def resolveB (S : St) (c : Cred) (follow : Bool) (R : Path) (abs : Bool) (raw : List String) : Except String Path :=
  if rootDenied S c R then .error "EACCES"
  else if abs then .error "ENOTCAPABLE"
  else match walkB S c follow R fuel maxLinks R raw with
    | .ok p => if R.isPrefixOf p then .ok p else .error "ENOTCAPABLE"
    | .error e => .error e

/-- What `resolveB` answers `.ok` for is what the walk reached, and it lies at or under `R`. -/
theorem resolveB_ok {S : St} {c : Cred} {f : Bool} {R : Path} {abs : Bool} {raw : List String} {p : Path}
    (h : resolveB S c f R abs raw = .ok p) :
    rootDenied S c R = false ∧ walkB S c f R fuel maxLinks R raw = .ok p ∧ R <+: p := by
  unfold resolveB at h
  split at h
  · cases h
  rename_i hd
  split at h
  · cases h
  split at h
  · rename_i p' hw
    split at h
    · rename_i hp
      cases h
      exact ⟨by simpa using hd, hw, List.isPrefixOf_iff_prefix.mp hp⟩
    · cases h
  · cases h

/-! ## Contained -/

theorem prefix_dropLast {R d : Path} (h : R <+: d) (hne : d ≠ R) : R <+: d.dropLast := by
  obtain ⟨t, rfl⟩ := h
  have ht : t ≠ [] := by rintro rfl; simp at hne
  rw [List.dropLast_append_of_ne_nil _ ht]
  exact List.prefix_append _ _

/-- Whatever a path resolves to beneath `R` lies at or under `R`. -/
theorem beneath_contained (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) : R <+: p :=
  (resolveB_ok h).2.2

/-! ## Searched from the root down -/

/-- Every directory on `d` from `R` down (each prefix of length at least `R`'s, short
    of `d`) is a directory granting search, or one the walk left into a path its
    backend resolves (`hands`), which that backend checks. -/
def NamedFrom (S : St) (c : Cred) (R d : Path) : Prop :=
  ∀ i, R.length ≤ i → i < d.length →
    S.hands (d.take (i + 1)) = true ∨ (IsDir S (d.take i) ∧ grants c (metaAt S (d.take i)) 1 = true)

theorem namedFrom_snoc {S : St} {c : Cred} {R d : Path} (x : String) (hn : NamedFrom S c R d)
    (hx : S.hands (d ++ [x]) = true ∨ (IsDir S d ∧ grants c (metaAt S d) 1 = true)) : NamedFrom S c R (d ++ [x]) := by
  intro i hR hi
  simp only [List.length_append, List.length_singleton] at hi
  by_cases e : i = d.length
  · subst e
    rw [List.take_of_length_le (by simp), List.take_append_of_le_length (Nat.le_refl _), List.take_length]
    exact hx
  · rw [List.take_append_of_le_length (by omega), List.take_append_of_le_length (by omega)]
    exact hn i hR (by omega)

theorem namedFrom_dropLast {S : St} {c : Cred} {R d : Path} (hn : NamedFrom S c R d) : NamedFrom S c R d.dropLast := by
  rw [List.dropLast_eq_take]
  intro i hr hi
  simp only [List.length_take] at hi
  simp only [List.take_take]
  rw [Nat.min_eq_left (show i + 1 ≤ d.length - 1 by omega), Nat.min_eq_left (show i ≤ d.length - 1 by omega)]
  exact hn i hr (by omega)

/-- Where the walk stands: beneath `R`, every directory from `R` down searched (or
    handed over); or, once an absolute link has sent it to `/`, every directory from
    `/` down. -/
def Walked (S : St) (c : Cred) (R d : Path) : Prop :=
  (R <+: d ∧ NamedFrom S c R d) ∨ NamedH S c d

theorem walked_snoc {S : St} {c : Cred} {R d : Path} (x : String) (hw : Walked S c R d)
    (hx : S.hands (d ++ [x]) = true ∨ (IsDir S d ∧ grants c (metaAt S d) 1 = true)) : Walked S c R (d ++ [x]) := by
  rcases hw with ⟨hR, hn⟩ | hn
  · exact .inl ⟨hR.trans (List.prefix_append _ _), namedFrom_snoc x hn hx⟩
  · exact .inr (namedH_snoc x hn hx)

theorem walked_dropLast {S : St} {c : Cred} {R d : Path} (hw : Walked S c R d) (hne : d ≠ R) :
    Walked S c R d.dropLast := by
  rcases hw with ⟨hR, hn⟩ | hn
  · exact .inl ⟨prefix_dropLast hR hne, namedFrom_dropLast hn⟩
  · exact .inr (namedH_dropLast hn)

/-- A directory the walk is in, not handed over and not `R`, sits in a directory. -/
theorem walked_parent {S : St} {c : Cred} {R d : Path} (hw : Walked S c R d) (hnd : S.hands d = false)
    (hd : IsDir S d) (hne : d ≠ R) : IsDir S d.dropLast := by
  rcases hw with ⟨hR, hn⟩ | hn
  · obtain ⟨t, rfl⟩ := hR
    have ht : t ≠ [] := by rintro rfl; simp at hne
    have hlen : R.length < (R ++ t).length := by simp [List.length_pos.mpr ht]
    have h := hn ((R ++ t).length - 1) (by omega) (by omega)
    rw [Nat.sub_add_cancel (by omega), List.take_length] at h
    rcases h with h | h
    · simp [hnd] at h
    · rw [List.dropLast_eq_take]; exact h.1
  · exact namedH_parent hn hnd hd

theorem walked_named {S : St} {c : Cred} {R d : Path} (hw : Walked S c R d) : NamedFrom S c R d := by
  rcases hw with ⟨_, hn⟩ | hn
  · exact hn
  · exact fun i _ hi => hn i hi

theorem walkB_named (S : St) (c : Cred) (f : Bool) (R : Path) (hwf : HandsWF S) :
    ∀ n h done rs p, Walked S c R done → (S.hands done = true ∨ IsDir S done) →
      walkB S c f R n h done rs = .ok p → NamedFrom S c R p := by
  intro n
  induction n with
  | zero => intro _ _ _ _ _ _ h; simp [walkB] at h
  | succ n ih =>
    intro h done rs p hW hd hw
    cases rs with
    | nil => simp only [walkB, Except.ok.injEq] at hw; subst hw; exact walked_named hW
    | cons x rs =>
      simp only [walkB] at hw
      split at hw
      · rename_i hh
        split at hw
        · exact ih _ _ _ _ hW hd hw
        · split at hw
          · rename_i hdd
            have hdone : S.hands done = true := by
              unfold handed at hh; cases h' : S.hands done <;> simp_all
            split at hw
            · cases hw
            · rename_i hne
              exact ih _ _ _ _ (walked_dropLast hW hne) (hwf.2 _ hdone) hw
          · have hq : S.hands (done ++ [x]) = true := by
              unfold handed at hh
              cases h' : S.hands done
              · simp_all
              · exact hwf.1 _ _ h'
            exact ih _ _ _ _ (walked_snoc x hW (.inl hq)) (.inl hq) hw
      · rename_i hh
        have hnd : S.hands done = false := by
          unfold handed at hh; cases h' : S.hands done <;> simp_all
        have hdir : IsDir S done := hd.resolve_left (by simp [hnd])
        split at hw
        · cases hw
        · rename_i hg
          have hg : grants c (metaAt S done) 1 = true := by simpa using hg
          split at hw
          · exact ih _ _ _ _ hW hd hw
          · split at hw
            · split at hw
              · cases hw
              · rename_i hne
                exact ih _ _ _ _ (walked_dropLast hW hne) (.inr (walked_parent hW hnd hdir hne)) hw
            · split at hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW (.inr ⟨hdir, hg⟩))
                · cases hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW (.inr ⟨hdir, hg⟩))
                · split at hw
                  · cases hw
                  · split at hw
                    · exact ih _ _ _ _ (.inr fun i hi => by simp at hi) (.inr (root_dir S)) hw
                    · exact ih _ _ _ _ hW hd hw
              · rename_i m he
                exact ih _ _ _ _ (walked_snoc x hW (.inr ⟨hdir, hg⟩)) (.inr ⟨m, he⟩) hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW (.inr ⟨hdir, hg⟩))
                · cases hw

/-- Every directory from `R` down to what `R`'s path resolves to is a directory that
    grants the caller search, except where the walk handed the rest to a backend that
    resolves its own paths. -/
theorem beneath_named (S : St) (c : Cred) (f : Bool) (R : Path) (hwf : HandsWF S) (hR : S.hands R = true ∨ IsDir S R)
    (abs : Bool) (raw : List String) (p : Path) (h : resolveB S c f R abs raw = .ok p) :
    ∀ i, R.length ≤ i → i < p.length →
      S.hands (p.take (i + 1)) = true ∨ (IsDir S (p.take i) ∧ grants c (metaAt S (p.take i)) 1 = true) :=
  walkB_named S c f R hwf _ _ _ _ p (.inl ⟨List.prefix_refl R, fun i h1 h2 => absurd h2 (by omega)⟩) hR (resolveB_ok h).2.1

/-- What resolves beneath a root the caller could name: every directory from `/` to the
    root granted search too, or was left into a path its backend resolves. -/
theorem beneath_root_searched (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) :
    ∀ i < R.length, S.hands (R.take (i + 1)) = true ∨ grants c (metaAt S (R.take i)) 1 = true := by
  have hd := (resolveB_ok h).1
  intro i hi
  simp only [rootDenied, List.any_eq_false, List.mem_range, Bool.and_eq_true, Bool.not_eq_true', not_and,
    Bool.not_eq_false] at hd
  by_cases hh : S.hands (R.take (i + 1)) = true
  · exact .inl hh
  · exact .inr (by simpa using hd i hi (by simpa using hh))

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
      · rename_i hh
        rw [if_pos hh]
        split at hw
        · rw [if_pos ‹_›]; exact ih _ _ _ _ hw
        · rw [if_neg ‹_›]
          split at hw
          · rw [if_pos ‹_›]
            split at hw
            · cases hw
            · exact ih _ _ _ _ hw
          · rw [if_neg ‹_›]; exact ih _ _ _ _ hw
      · rename_i hh
        rw [if_neg hh]
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
                      exact ih _ _ _ _ hw

/-- When `path` resolves beneath `R`, it resolves to exactly what the unrestricted
    walk from `R` gives. -/
theorem beneath_agrees (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) : walk S c f fuel maxLinks R raw = .ok p :=
  walkB_agrees S c f R _ _ _ _ p (resolveB_ok h).2.1

/-! ## Across mounts (f6f6fa6e) -/

/-- A resolution's answer as data: the error, or `""` and the path. -/
def ans : Except String Path → String × Path
  | .error e => (e, [])
  | .ok p => ("", p)

/-- `/a/m` mounts backend 1 (holding `x/f`, `up -> ../../etc/p`, `side -> ../n`,
    `abs -> /etc/p`, `loop -> loop`, and the absolute links `inside -> /a/n`,
    `chain -> /a/m/inside` and `gone -> /a/none`); the root holds `/a/n` and `/etc/p`. -/
def mountTrace : St :=
  { mounts := [⟨["a", "m"], 1⟩],
    bks := fun k => if k = 0 then
        sqlite [(["a"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["a", "n"], ⟨.file 3, ⟨0o644, 0, 0⟩⟩),
          (["etc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["etc", "p"], ⟨.file 5, ⟨0o644, 0, 0⟩⟩)]
      else memory [(["x"], ⟨.dir, synthMeta⟩), (["x", "f"], ⟨.file 7, synthMeta⟩),
          (["up"], ⟨.link false ["..", "..", "etc", "p"], synthMeta⟩),
          (["side"], ⟨.link false ["..", "n"], synthMeta⟩),
          (["abs"], ⟨.link true ["etc", "p"], synthMeta⟩),
          (["loop"], ⟨.link false ["loop"], synthMeta⟩),
          (["inside"], ⟨.link true ["a", "n"], synthMeta⟩),
          (["chain"], ⟨.link true ["a", "m", "inside"], synthMeta⟩),
          (["gone"], ⟨.link true ["a", "none"], synthMeta⟩)] }

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
    ans (resolveB S u2 true R false ["m", "inside"]) = ("", ["a", "n"]) ∧
    ans (resolveB S u2 true R false ["m", "chain"]) = ("", ["a", "n"]) ∧
    ans (resolveB S u2 true R false ["m", "gone"]) = ("", ["a", "none"]) ∧
    ans (resolveB S u2 true R false ["m", "gone", "x"]) = ("ENOENT", []) ∧
    ans (resolveB S u2 true M false ["inside"]) = ("ENOTCAPABLE", []) ∧
    ans (walk S u2 true fuel maxLinks M ["up"]) = ("", ["etc", "p"]) := by
  decide

/-- `/pc` mounts a device (backend 1): `home/me` is its user's, with `home/me/f` and
    an absolute link `home/me/up -> /home/me`, which the device reads from its own
    root; `vault` only root may search, yet holds the user's `vault/mine/g`; `locked`
    only root may search, and a mount nested at `/pc/locked/inner` holds `x`. With
    `resolves`, the device resolves its own paths (`hands`): everything past `/pc`
    that is not on the way to the nested mount. -/
def deviceMounts : List Mnt := [⟨["pc"], 1⟩, ⟨["pc", "locked", "inner"], 2⟩]

def deviceTrace (resolves : Bool) : St :=
  { mounts := deviceMounts,
    bks := fun k => if k = 0 then sqlite []
      else if k = 1 then
        sqlite [(["home"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["home", "me"], ⟨.dir, ⟨0o755, 2, 2⟩⟩),
          (["home", "me", "f"], ⟨.file 3, ⟨0o644, 2, 2⟩⟩), (["home", "me", "up"], ⟨.link true ["home", "me"], ⟨0o777, 2, 2⟩⟩),
          (["vault"], ⟨.dir, ⟨0o700, 0, 0⟩⟩), (["vault", "mine"], ⟨.dir, ⟨0o755, 2, 2⟩⟩),
          (["vault", "mine", "g"], ⟨.file 1, ⟨0o644, 2, 2⟩⟩), (["locked"], ⟨.dir, ⟨0o700, 0, 0⟩⟩)]
      else memory [(["x"], ⟨.file 1, synthMeta⟩)],
    hands := fun q => resolves && ["pc"].isPrefixOf q && decide (1 < q.length) && !structural deviceMounts q }

/-- Handed over, the walk searches nothing past `/pc` (the device checks its own, and
    here serves its user's file under a directory the composite would refuse them) and
    reads none of its links (the device reads `up` from its own root); the way to the
    nested mount is still searched here; `..` at the root is still ENOTCAPABLE. -/
theorem beneath_hands_over :
    ans (resolveB (deviceTrace false) u2 true [] false ["pc", "vault", "mine", "g"]) = ("EACCES", []) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "vault", "mine", "g"]) = ("", ["pc", "vault", "mine", "g"]) ∧
    ans (resolveB (deviceTrace false) u2 true [] false ["pc", "home", "me", "up", "f"]) = ("ENOENT", []) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "home", "me", "up", "f"]) = ("", ["pc", "home", "me", "up", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "home", "me", "..", "me", "f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "locked", "inner", "x"]) = ("EACCES", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false ["f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false [".."]) = ("ENOTCAPABLE", []) := by
  decide

end Nimbus.Vfs.CompositeBeneath
