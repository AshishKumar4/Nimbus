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
  backend answers for the rest, and the answer is still checked beneath `R`. Beneath
  `R` only a mount whose point lies at or under `R` is handed over (`beneathSt`,
  `within := R`): its backend follows links only in its own tree, so beneath `R`. From
  a root inside such a mount every component is walked here, and its links are read as
  its backend reads them (`linkComps`: an absolute target re-rooted at the mount point,
  a relative one climbing no higher than it). `handsWF_beneath`: the restriction keeps
  the hand-off well formed.

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
    if handed S done x rs then
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
        else walkB S c follow R n (h - 1) (if (S.hands q || a) = true then [] else done) (linkComps S q a t ++ rs)
      | some (.dir, _) => walkB S c follow R n h q rs
      | some (.file _, _) => if rs = [] then .ok q else .error "ENOTDIR"

/-- The root is resolved by name from `/` (a descriptor root re-resolves by its path):
    every directory above it, and it, must grant the caller search before the walk
    leaves it. Stricter than Linux (which trusts the open descriptor), never looser. -/
def rootDenied (S : St) (c : Cred) (R : Path) : Bool :=
  (List.range R.length).any fun i =>
    !(handsTo S (R.take i) R || handsTo S (R.take (i + 1)) R) && !grants c (metaAt S (R.take i)) 1

/-- The composite beneath `R`: a path is handed to its backend only when that mount's
    point lies at or under `R`, so whatever the backend resolves, in its own tree, lies
    beneath `R` too. From a root inside such a mount every component is walked here. -/
def beneathSt (S : St) (R : Path) : St :=
  { S with within := R }

/-- `path` (its components; `abs` when it began with `/`) resolved beneath `R`: what the
    walk reaches, when that lies at or under `R`. -/
def resolveB (S : St) (c : Cred) (follow : Bool) (R : Path) (abs : Bool) (raw : List String) : Except String Path :=
  if rootDenied S c R then .error "EACCES"
  else if abs then .error "ENOTCAPABLE"
  else match walkB (beneathSt S R) c follow R fuel maxLinks R raw with
    | .ok p => if R.isPrefixOf p then .ok p else .error "ENOTCAPABLE"
    | .error e => .error e

/-- What `resolveB` answers `.ok` for is what the walk reached, and it lies at or under `R`. -/
theorem resolveB_ok {S : St} {c : Cred} {f : Bool} {R : Path} {abs : Bool} {raw : List String} {p : Path}
    (h : resolveB S c f R abs raw = .ok p) :
    rootDenied S c R = false ∧ walkB (beneathSt S R) c f R fuel maxLinks R raw = .ok p ∧ R <+: p := by
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

/-! ## Handed over beneath a root -/

private def pick (p : Path) (best m : Mnt) : Mnt :=
  if m.point.isPrefixOf p && best.point.length < m.point.length then m else best

private theorem ownerOf_eq (ms : List Mnt) (p : Path) : ownerOf ms p = ms.foldl (pick p) ⟨[], 0⟩ := rfl

private theorem foldl_pick_prefix (p : Path) :
    ∀ (ms : List Mnt) (best : Mnt), best.point <+: p → (ms.foldl (pick p) best).point <+: p := by
  intro ms
  induction ms with
  | nil => intro best h; exact h
  | cons m ms ih =>
    intro best h
    apply ih
    unfold pick
    split
    · rename_i hc
      simp only [Bool.and_eq_true, decide_eq_true_eq] at hc
      exact List.isPrefixOf_iff_prefix.mp hc.1
    · exact h

private theorem foldl_pick_mono (p : Path) :
    ∀ (ms : List Mnt) (best : Mnt), best.point.length ≤ (ms.foldl (pick p) best).point.length := by
  intro ms
  induction ms with
  | nil => intro best; exact Nat.le_refl _
  | cons m ms ih =>
    intro best
    refine Nat.le_trans ?_ (ih _)
    unfold pick
    split
    · rename_i hc
      simp only [Bool.and_eq_true, decide_eq_true_eq] at hc
      exact Nat.le_of_lt hc.2
    · exact Nat.le_refl _

private theorem foldl_pick_max (p : Path) :
    ∀ (ms : List Mnt) (best m : Mnt), m ∈ ms → m.point <+: p →
      m.point.length ≤ (ms.foldl (pick p) best).point.length := by
  intro ms
  induction ms with
  | nil => intro _ _ hm; simp at hm
  | cons m' ms ih =>
    intro best m hm hp
    simp only [List.foldl]
    rcases List.mem_cons.mp hm with rfl | hm
    · refine Nat.le_trans ?_ (foldl_pick_mono p ms _)
      unfold pick
      split
      · exact Nat.le_refl _
      · rename_i hc
        have : m.point.isPrefixOf p = true := List.isPrefixOf_iff_prefix.mpr hp
        simp only [this, Bool.true_and, decide_eq_true_eq] at hc
        omega
    · exact ih _ _ hm hp

private theorem foldl_pick_mem (p : Path) :
    ∀ (ms : List Mnt) (best : Mnt), ms.foldl (pick p) best = best ∨ ms.foldl (pick p) best ∈ ms := by
  intro ms
  induction ms with
  | nil => intro best; exact .inl rfl
  | cons m ms ih =>
    intro best
    simp only [List.foldl]
    rcases ih (pick p best m) with h | h
    · rw [h]; unfold pick; split
      · exact .inr (List.mem_cons_self _ _)
      · exact .inl rfl
    · exact .inr (List.mem_cons_of_mem _ h)

theorem ownerOf_prefix (ms : List Mnt) (p : Path) : (ownerOf ms p).point <+: p :=
  foldl_pick_prefix p ms _ List.nil_prefix

/-- `ownerOf` is the default root mount or one of `ms`. -/
theorem ownerOf_mem (ms : List Mnt) (p : Path) : (ownerOf ms p).point = [] ∨ ownerOf ms p ∈ ms := by
  rcases foldl_pick_mem p ms ⟨[], 0⟩ with h | h
  · exact .inl (by rw [ownerOf_eq, h])
  · exact .inr h

/-- A mount whose point is on `p` is no deeper than the one `p` is in. -/
theorem ownerOf_max {ms : List Mnt} {p : Path} {m : Mnt} (hm : m ∈ ms) (hp : m.point <+: p) :
    m.point.length ≤ (ownerOf ms p).point.length :=
  foldl_pick_max p ms _ m hm hp

/-- The mount `q` is in, if its point lies on `p` (`q` on the way to `p`), is a prefix of `p`'s. -/
theorem ownerOf_prefix_of {ms : List Mnt} {q p : Path} (hq : (ownerOf ms q).point <+: p) :
    (ownerOf ms q).point <+: (ownerOf ms p).point := by
  rcases ownerOf_mem ms q with h | h
  · rw [h]; exact List.nil_prefix
  · exact List.prefix_of_prefix_length_le hq (ownerOf_prefix ms p) (ownerOf_max h hq)

theorem handsIn_of_nil {S : St} (h0 : S.within = []) (q : Path) : handsIn S q = S.hands q := by
  simp [handsIn, h0, List.isPrefixOf]

/-- Beneath a root, what may be handed over is well formed as the composite's own
    hand-off is, provided no mount's point is past its own point (as `hands` means). -/
theorem handsWF_beneath {S : St} (R : Path) (hw : HandsWF S) (h0 : S.within = [])
    (hoff : ∀ q, S.hands q = true → q ≠ (ownerOf S.mounts q).point) : HandsWF (beneathSt S R) := by
  have hb : ∀ q, handsIn (beneathSt S R) q = (S.hands q && R.isPrefixOf (ownerOf S.mounts q).point) := fun _ => rfl
  constructor
  · intro q x hq
    rw [hb] at hq
    simp only [Bool.and_eq_true] at hq
    rcases hw.1 q x (by rw [handsIn_of_nil h0]; exact hq.1) with hd | hd
    · left
      rw [hb]
      simp only [Bool.and_eq_true]
      refine ⟨by rw [← handsIn_of_nil h0]; exact hd, ?_⟩
      have hR := List.isPrefixOf_iff_prefix.mp hq.2
      exact List.isPrefixOf_iff_prefix.mpr
        (hR.trans (ownerOf_prefix_of ((ownerOf_prefix _ q).trans (List.prefix_append _ _))))
    · exact .inr hd
  · intro q hq
    rw [hb] at hq
    simp only [Bool.and_eq_true] at hq
    rcases hw.2 q (by rw [handsIn_of_nil h0]; exact hq.1) with hd | hd
    · left
      rw [hb]
      simp only [Bool.and_eq_true]
      refine ⟨by rw [← handsIn_of_nil h0]; exact hd, ?_⟩
      have hR := List.isPrefixOf_iff_prefix.mp hq.2
      -- The mount `q` is in is not at `q` itself, so it is on `q.dropLast`.
      exact List.isPrefixOf_iff_prefix.mpr
        (hR.trans (ownerOf_prefix_of (prefix_dropLast (ownerOf_prefix _ q) (hoff q hq.1))))
    · exact .inr hd

/-! ## Searched from the root down -/

/-- Every directory on `d` from `R` down (each prefix of length at least `R`'s, short
    of `d`) is a directory granting search, or is in or leads into a path its backend
    resolves (`hands`), which that backend checks. -/
def NamedFrom (S : St) (c : Cred) (R d : Path) : Prop :=
  ∀ i, R.length ≤ i → i < d.length →
    handsIn S (d.take i) = true ∨ handsIn S (d.take (i + 1)) = true ∨
      (IsDir S (d.take i) ∧ grants c (metaAt S (d.take i)) 1 = true)

theorem namedFrom_snoc {S : St} {c : Cred} {R d : Path} (x : String) (hn : NamedFrom S c R d)
    (hx : handsIn S d = true ∨ handsIn S (d ++ [x]) = true ∨ (IsDir S d ∧ grants c (metaAt S d) 1 = true)) :
    NamedFrom S c R (d ++ [x]) := by
  intro i hR hi
  simp only [List.length_append, List.length_singleton] at hi
  by_cases e : i = d.length
  · subst e
    rw [List.take_append_of_le_length (Nat.le_refl _), List.take_length, List.take_of_length_le (by simp)]
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
    (hx : handsIn S d = true ∨ handsIn S (d ++ [x]) = true ∨ (IsDir S d ∧ grants c (metaAt S d) 1 = true)) :
    Walked S c R (d ++ [x]) := by
  rcases hw with ⟨hR, hn⟩ | hn
  · exact .inl ⟨hR.trans (List.prefix_append _ _), namedFrom_snoc x hn hx⟩
  · exact .inr (namedH_snoc x hn hx)

theorem walked_dropLast {S : St} {c : Cred} {R d : Path} (hw : Walked S c R d) (hne : d ≠ R) :
    Walked S c R d.dropLast := by
  rcases hw with ⟨hR, hn⟩ | hn
  · exact .inl ⟨prefix_dropLast hR hne, namedFrom_dropLast hn⟩
  · exact .inr (namedH_dropLast hn)

/-- The directory the walk's `done` (not `R`) is in is past a flagged point, or a directory. -/
theorem walked_parent {S : St} {c : Cred} {R d : Path} (hwf : HandsWF S) (hw : Walked S c R d) (hne : d ≠ R) :
    handsIn S d.dropLast = true ∨ IsDir S d.dropLast := by
  rcases hw with ⟨hR, hn⟩ | hn
  · obtain ⟨t, rfl⟩ := hR
    have ht : t ≠ [] := by rintro rfl; simp at hne
    have hlen : R.length < (R ++ t).length := by simp [List.length_pos.mpr ht]
    have h := hn ((R ++ t).length - 1) (by omega) (by omega)
    rw [Nat.sub_add_cancel (by omega), List.take_length] at h
    rw [List.dropLast_eq_take]
    rcases h with h | h | h
    · exact .inl h
    · rcases hwf.2 _ h with h' | h'
      · exact .inl (by rw [← List.dropLast_eq_take]; exact h')
      · exact .inr (by rw [← List.dropLast_eq_take]; exact h')
    · exact .inr h.1
  · exact namedH_parent hwf hn

theorem walked_named {S : St} {c : Cred} {R d : Path} (hw : Walked S c R d) : NamedFrom S c R d := by
  rcases hw with ⟨_, hn⟩ | hn
  · exact hn
  · exact fun i _ hi => hn i hi

theorem walkB_named (S : St) (c : Cred) (f : Bool) (R : Path) (hwf : HandsWF S) :
    ∀ n h done rs p, Walked S c R done → (handsIn S done = true ∨ IsDir S done) →
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
          · split at hw
            · cases hw
            · rename_i hne
              exact ih _ _ _ _ (walked_dropLast hW hne) (walked_parent hwf hW hne) hw
          · rcases handed_hands hh with hq | ⟨_, _, _, hq⟩
            · exact ih _ _ _ _ (walked_snoc x hW (.inl hq)) (hwf.1 _ x hq) hw
            · exact ih _ _ _ _ (walked_snoc x hW (.inr (.inl hq))) (.inl hq) hw
      · rename_i hh
        have hdir : IsDir S done := unhanded_dir (by simpa using hh) hd
        split at hw
        · cases hw
        · rename_i hg
          have hg : grants c (metaAt S done) 1 = true := by simpa using hg
          have hs : handsIn S done = true ∨ handsIn S (done ++ [x]) = true ∨ (IsDir S done ∧ grants c (metaAt S done) 1 = true) :=
            .inr (.inr ⟨hdir, hg⟩)
          split at hw
          · exact ih _ _ _ _ hW hd hw
          · split at hw
            · split at hw
              · cases hw
              · rename_i hne
                exact ih _ _ _ _ (walked_dropLast hW hne) (walked_parent hwf hW hne) hw
            · split at hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW hs)
                · cases hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW hs)
                · split at hw
                  · cases hw
                  · split at hw
                    · exact ih _ _ _ _ (.inr fun i hi => by simp at hi) (.inr (root_dir S)) hw
                    · exact ih _ _ _ _ hW hd hw
              · rename_i m he
                exact ih _ _ _ _ (walked_snoc x hW hs) (.inr ⟨m, he⟩) hw
              · split at hw
                · cases hw; exact walked_named (walked_snoc x hW hs)
                · cases hw

/-- Every directory from `R` down to what `R`'s path resolves to is a directory that
    grants the caller search, except where the walk is in or leads into a path handed
    to a backend that resolves its own paths (beneath `R`: `beneathSt`). -/
theorem beneath_named (S : St) (c : Cred) (f : Bool) (R : Path) (hwf : HandsWF S) (h0 : S.within = [])
    (hoff : ∀ q, S.hands q = true → q ≠ (ownerOf S.mounts q).point)
    (hR : handsIn (beneathSt S R) R = true ∨ IsDir S R)
    (abs : Bool) (raw : List String) (p : Path) (h : resolveB S c f R abs raw = .ok p) :
    ∀ i, R.length ≤ i → i < p.length →
      handsIn (beneathSt S R) (p.take i) = true ∨ handsIn (beneathSt S R) (p.take (i + 1)) = true ∨
        (IsDir S (p.take i) ∧ grants c (metaAt S (p.take i)) 1 = true) :=
  walkB_named (beneathSt S R) c f R (handsWF_beneath R hwf h0 hoff) _ _ _ _ p
    (.inl ⟨List.prefix_refl R, fun i h1 h2 => absurd h2 (by omega)⟩) hR (resolveB_ok h).2.1

/-- What resolves beneath a root the caller could name: every directory from `/` to the
    root granted search too, or was handed over on the way to it. -/
theorem beneath_root_searched (S : St) (c : Cred) (f : Bool) (R : Path) (abs : Bool) (raw : List String) (p : Path)
    (h : resolveB S c f R abs raw = .ok p) :
    ∀ i < R.length, (handsTo S (R.take i) R || handsTo S (R.take (i + 1)) R) = true ∨
      grants c (metaAt S (R.take i)) 1 = true := by
  have hd := (resolveB_ok h).1
  intro i hi
  simp only [rootDenied, List.any_eq_false, List.mem_range] at hd
  have := hd i hi
  cases hh : (handsTo S (R.take i) R || handsTo S (R.take (i + 1)) R)
  · right
    simp only [hh, Bool.not_false, Bool.true_and, Bool.not_eq_true'] at this
    cases hg : grants c (metaAt S (R.take i)) 1
    · simp [hg] at this
    · rfl
  · exact .inl rfl

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
    (h : resolveB S c f R abs raw = .ok p) : walk (beneathSt S R) c f fuel maxLinks R raw = .ok p :=
  walkB_agrees (beneathSt S R) c f R _ _ _ _ p (resolveB_ok h).2.1

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

/-- `/pc` mounts a device (backend 1): `home/me` is its user's, with `home/me/f`, an
    absolute link `home/me/up -> /home/me` and a relative one `home/me/climb ->
    ../../../../home/me`, which the device reads from its own root (the second climbing
    no higher than it); `vault` only root may search, yet holds the user's `vault/mine/g`; `locked`
    only root may search, and a mount nested at `/pc/locked/inner` holds `x`; `safe`
    holds `out -> /secret` and `up -> ../secret`, links out of it. The nested mount
    (not flagged) holds the file `x` and the absolute link `al -> /pc/home/me/f`. With
    `resolves`, the device resolves its own paths (`hands`): what is past `/pc` and in
    the device, the longest mount on it, not in the nested mount. -/
def deviceMounts : List Mnt := [⟨["pc"], 1⟩, ⟨["pc", "locked", "inner"], 2⟩]

def deviceTrace (resolves : Bool) : St :=
  { mounts := deviceMounts,
    bks := fun k => if k = 0 then sqlite []
      else if k = 1 then
        sqlite [(["home"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["home", "me"], ⟨.dir, ⟨0o755, 2, 2⟩⟩),
          (["home", "me", "f"], ⟨.file 3, ⟨0o644, 2, 2⟩⟩), (["home", "me", "up"], ⟨.link true ["home", "me"], ⟨0o777, 2, 2⟩⟩),
          (["home", "me", "climb"], ⟨.link false ["..", "..", "..", "..", "home", "me"], ⟨0o777, 2, 2⟩⟩),
          (["vault"], ⟨.dir, ⟨0o700, 0, 0⟩⟩), (["vault", "mine"], ⟨.dir, ⟨0o755, 2, 2⟩⟩),
          (["vault", "mine", "g"], ⟨.file 1, ⟨0o644, 2, 2⟩⟩), (["locked"], ⟨.dir, ⟨0o700, 0, 0⟩⟩),
          (["safe"], ⟨.dir, ⟨0o755, 2, 2⟩⟩), (["safe", "out"], ⟨.link true ["secret"], ⟨0o777, 2, 2⟩⟩),
          (["safe", "up"], ⟨.link false ["..", "secret"], ⟨0o777, 2, 2⟩⟩), (["secret"], ⟨.file 6, ⟨0o644, 2, 2⟩⟩)]
      else memory [(["x"], ⟨.file 1, synthMeta⟩), (["al"], ⟨.link true ["pc", "home", "me", "f"], synthMeta⟩)],
    hands := fun q => resolves && (ownerOf deviceMounts q).point == ["pc"] && decide (1 < q.length) }

/-- Handed over, the walk searches nothing past `/pc` (the device checks its own, and
    here serves its user's file under a directory the composite would refuse them) and
    reads none of its links (the device reads `up` from its own root); the way to the
    nested mount is still searched here; `..` at the root is still ENOTCAPABLE. From a
    root inside the device nothing is handed over (the device would follow `safe/out`
    out of it): its links are read, and leave the root ENOTCAPABLE; from a root that
    holds `/pc`, the device follows them in its own tree, beneath the root. A sibling of
    the nested mount, on the device, is the device's alone, past `locked`; in the
    nested mount, which is not flagged, the walk looks up every component (kernel:
    `x` is a file, so `x/child` is ENOTDIR) and follows its absolute link. From a root
    inside the device, its links are read as the device reads them (`linkComps`):
    `up` and `climb` lead to `/pc/home/me` and on to its `f`; on an unflagged device
    `up` leads to the namespace's `/home/me`, which is not there. -/
theorem beneath_hands_over :
    ans (resolveB (deviceTrace false) u2 true [] false ["pc", "vault", "mine", "g"]) = ("EACCES", []) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "vault", "mine", "g"]) = ("", ["pc", "vault", "mine", "g"]) ∧
    ans (resolveB (deviceTrace false) u2 true [] false ["pc", "home", "me", "up", "f"]) = ("ENOENT", []) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "home", "me", "up", "f"]) = ("", ["pc", "home", "me", "up", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "home", "me", "..", "me", "f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "locked", "inner", "x"]) = ("EACCES", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false ["f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false [".."]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "safe"] false ["out"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "safe"] false ["up"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc"] false ["safe", "out"]) = ("", ["pc", "safe", "out"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "safe", "up"]) = ("", ["pc", "safe", "up"]) ∧
    ans (resolveB (deviceTrace true) u2 true [] false ["pc", "locked", "sib"]) = ("", ["pc", "locked", "sib"]) ∧
    ans (resolveB (deviceTrace true) kernel true [] false ["pc", "locked", "inner", "x", "child"]) = ("ENOTDIR", []) ∧
    ans (resolveB (deviceTrace true) kernel true [] false ["pc", "locked", "inner", "al"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) kernel true ["pc", "locked", "inner"] false ["al"]) = ("ENOTCAPABLE", []) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false ["up", "f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace true) u2 true ["pc", "home", "me"] false ["climb", "f"]) = ("", ["pc", "home", "me", "f"]) ∧
    ans (resolveB (deviceTrace false) u2 true ["pc", "home", "me"] false ["up", "f"]) = ("ENOENT", []) := by
  decide

end Nimbus.Vfs.CompositeBeneath
