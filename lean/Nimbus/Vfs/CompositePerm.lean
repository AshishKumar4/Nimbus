/-
  Nimbus.Vfs.CompositePerm — permissions through `CompositeVFS` (Main's ruling on
  the P2 widening, node-nomirror 79cdbf90: uid 2 read `/h/pc/f` through a 0700 `/h`
  held by the root backend, and `stat /h` answered 40755).

  Each backend is a POSIX tree with modes (SqliteVFS) or without (MemoryVFS: every
  check passes). A credential is a uid, a primary gid and groups; uid 0 passes every
  check (CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH).

  The composite walks a path component by component (Linux path walk). Leaving a
  directory needs search (x) on it, checked before the next name is looked up, so
  EACCES at a component comes before any error from a later one (ruling (a)). While
  the walk stays on the composite's own directories (the root, live mount points and
  the directories above them) the composite checks search itself, against how it
  describes that directory (`descOf`, ruling (b)): the stat of the backend that
  holds it (the root for `/h`; a mount's backend for its point, which is that
  backend's `/`), or a synthesized 0755 root:root when that backend holds nothing
  there or reports no modes. At the first other component it hands the path, relative
  to its mount, to that mount's backend, which walks from its own root with its own
  checks, links included. readdir of a composite directory needs read (r) on it and
  lists the holder's entries plus the mount names (ruling (d)).

  Proved:
  - `never_widens`: at a path the composite hands off, whatever it answers other than
    its own refusal is exactly the backend's own answer for that credential; a
    backend refusal is never turned into a success (`backend_refusal_stands`).
  - `search_checked`: an answer past the walk means every composite directory on the
    way granted search as `descOf` describes it; `held_described`: that is the
    holding backend's own mode, owner and group.
  - `privileged_passes` (ruling (c)); `synth_meta_open` (a synthesized directory
    lets everyone search and list and only uid 0 write).
  - Links inside a mount resolve inside it (`bWalk` substitutes a target from the
    backend's own root, and `..` never climbs above it): `confined` (a handed-off
    answer depends on no other backend's contents), `step_frame` (a mutation
    changes only that backend), and `a_link_in_a_mount_stays_in_it`.
  - `the_perm_trace`: the perm.mjs trace with every verdict, and
    `the_backend_alone_grants_the_leak` (why the composite's own check is needed).

  Not modeled here: root-backend links followed by the composite, `..` in
  composite paths, per-principal sources (all in `Composite`), ACLs, setgid
  inheritance, and exec permission on files.
-/

namespace Nimbus.Vfs.CompositePerm

abbrev Path := List String

structure Meta where
  mode : Nat
  uid : Nat
  gid : Nat
  deriving DecidableEq, Repr

structure Cred where
  uid : Nat
  gid : Nat
  groups : List Nat
  deriving DecidableEq, Repr

inductive K where
  | dir
  | file (b : Nat)
  /-- A symlink: absolute (`/a/b`) or relative, by its components. -/
  | link (abs : Bool) (t : List String)
  deriving DecidableEq, Repr

structure BEnt where
  k : K
  m : Meta
  deriving DecidableEq, Repr

structure Backend where
  modes : Bool
  root : Meta
  ents : List (Path × BEnt)

/-- What a backend holds at `r`; its root is a directory. -/
def look (b : Backend) (r : Path) : Option BEnt :=
  if r = [] then some ⟨.dir, b.root⟩ else (b.ents.find? (·.1 == r)).map (·.2)

def classBits (c : Cred) (m : Meta) : Nat :=
  if c.uid = m.uid then m.mode / 64 % 8
  else if m.gid = c.gid ∨ m.gid ∈ c.groups then m.mode / 8 % 8
  else m.mode % 8

/-- `want`: 4 (r), 2 (w) or 1 (x). -/
def grants (c : Cred) (m : Meta) (want : Nat) : Bool :=
  c.uid == 0 || classBits c m / want % 2 == 1

def bGrants (b : Backend) (c : Cred) (m : Meta) (want : Nat) : Bool := !b.modes || grants c m want

def synthMeta : Meta := ⟨0o755, 0, 0⟩

/-! ## A backend's own walk and operations -/

def fuel : Nat := 64
def hops : Nat := 8

/-- The backend's lookup from its root: leaving `done` needs search on it; a link met
    before the last component (or at the last when `follow`) is replaced by its
    target, absolute from this backend's root, relative from the link's directory;
    `..` pops, and never above the root. -/
def bWalk (b : Backend) (c : Cred) (follow : Bool) : Nat → Nat → Path → List String → Except String Path
  | 0, _, _, _ => .error "ELOOP"
  | _ + 1, _, done, [] => .ok done
  | n + 1, h, done, x :: rs =>
    match look b done with
    | none => .error "ENOENT"
    | some d =>
      if !bGrants b c d.m 1 then .error "EACCES"
      else if x = "" ∨ x = "." then bWalk b c follow n h done rs
      else if x = ".." then bWalk b c follow n h done.dropLast rs
      else
        let q := done ++ [x]
        match look b q with
        | some ⟨.link abs t, _⟩ =>
          if rs = [] ∧ follow = false then .ok q
          else if h = 0 then .error "ELOOP"
          else bWalk b c follow n (h - 1) (if abs then [] else done) (t ++ rs)
        | some ⟨.dir, _⟩ => bWalk b c follow n h q rs
        | some _ => if rs = [] then .ok q else .error "ENOTDIR"
        | none => if rs = [] then .ok q else .error "ENOENT"

inductive Op where
  | stat
  | readdir
  | readFile
  | writeFile (b : Nat)
  | unlink
  deriving DecidableEq, Repr

inductive Out where
  | ok
  | null
  | stat (k : String) (m : Option Meta)
  | bytes (b : Nat)
  | names (l : List String)
  | err (e : String)
  deriving DecidableEq, Repr

def kindName : K → String
  | .dir => "directory"
  | .file _ => "file"
  | .link _ _ => "symlink"

def insertName (x : String) : List String → List String
  | [] => [x]
  | y :: ys => if x = y then y :: ys else if x < y then x :: y :: ys else y :: insertName x ys

/-- Sorted, without duplicates. -/
def sortNames (l : List String) : List String := l.foldr insertName []

def children (b : Backend) (r : Path) : List String :=
  (b.ents.filter fun x => x.1.length = r.length + 1 && r.isPrefixOf x.1).filterMap (·.1.getLast?)

def setEnt (b : Backend) (r : Path) (e : BEnt) : Backend :=
  { b with ents := (b.ents.filter (·.1 != r)) ++ [(r, e)] }

def delEnt (b : Backend) (r : Path) : Backend := { b with ents := b.ents.filter (·.1 != r) }

/-- The backend's own answer for credential `c` at its relative path `r`. -/
def bOp (b : Backend) (c : Cred) (op : Op) (r : Path) : Out × Option Backend :=
  match op with
  | .stat =>
    match bWalk b c true fuel hops [] r with
    | .error "ENOENT" => (.null, none)
    | .error e => (.err e, none)
    | .ok q => match look b q with
      | none => (.null, none)
      | some e => (.stat (kindName e.k) (if b.modes then some e.m else none), none)
  | .readdir =>
    match bWalk b c true fuel hops [] r with
    | .error e => (.err e, none)
    | .ok q => match look b q with
      | some ⟨.dir, m⟩ => if bGrants b c m 4 then (.names (sortNames (children b q)), none) else (.err "EACCES", none)
      | some _ => (.err "ENOTDIR", none)
      | none => (.err "ENOENT", none)
  | .readFile =>
    match bWalk b c true fuel hops [] r with
    | .error e => (.err e, none)
    | .ok q => match look b q with
      | some ⟨.file n, m⟩ => if bGrants b c m 4 then (.bytes n, none) else (.err "EACCES", none)
      | some ⟨.dir, _⟩ => (.err "EISDIR", none)
      | some _ => (.err "EINVAL", none)
      | none => (.err "ENOENT", none)
  | .writeFile n =>
    match bWalk b c true fuel hops [] r with
    | .error e => (.err e, none)
    | .ok q =>
      if q = [] then (.err "EISDIR", none) else
      match look b q with
      | some ⟨.file _, m⟩ => if bGrants b c m 2 then (.ok, some (setEnt b q ⟨.file n, m⟩)) else (.err "EACCES", none)
      | some ⟨.dir, _⟩ => (.err "EISDIR", none)
      | some _ => (.err "EINVAL", none)
      | none => match look b q.dropLast with
        | some ⟨.dir, pm⟩ =>
          if bGrants b c pm 2 then (.ok, some (setEnt b q ⟨.file n, ⟨0o644, c.uid, c.gid⟩⟩)) else (.err "EACCES", none)
        | _ => (.err "ENOENT", none)
  | .unlink =>
    match bWalk b c false fuel hops [] r with
    | .error e => (.err e, none)
    | .ok q =>
      if q = [] then (.err "EISDIR", none) else
      match look b q with
      | none => (.err "ENOENT", none)
      | some ⟨.dir, _⟩ => (.err "EISDIR", none)
      | some e => match look b q.dropLast with
        | some ⟨.dir, pm⟩ =>
          if !bGrants b c pm 2 then (.err "EACCES", none)
          else if b.modes && pm.mode / 512 % 2 == 1 && c.uid != 0 && c.uid != e.m.uid && c.uid != pm.uid then
            (.err "EPERM", none)
          else (.ok, some (delEnt b q))
        | _ => (.err "ENOENT", none)

/-! ## The composite -/

structure Mnt where
  point : Path
  bk : Nat
  deriving DecidableEq, Repr

/-- Backend 0 is the root's, mounted at `[]` implicitly. -/
structure St where
  mounts : List Mnt
  bks : Nat → Backend

def ownerOf (ms : List Mnt) (p : Path) : Mnt :=
  ms.foldl (fun best m => if m.point.isPrefixOf p && best.point.length < m.point.length then m else best) ⟨[], 0⟩

def rel (ms : List Mnt) (p : Path) : Path := p.drop (ownerOf ms p).point.length

/-- The root, a live mount point, or a directory above one. -/
def structural (ms : List Mnt) (p : Path) : Bool := p.isEmpty || ms.any fun m => p.isPrefixOf m.point

def mountNames (ms : List Mnt) (p : Path) : List String :=
  ms.filterMap fun m => if p.isPrefixOf m.point && p.length < m.point.length then m.point[p.length]? else none

inductive Desc where
  | dir (m : Meta)
  /-- The holder has a non-directory there: only mount names live under it. -/
  | shadow
  deriving DecidableEq, Repr

/-- How the composite describes one of its own directories: the holding backend's
    stat (a mount point's is its backend's `/`), else synthesized. -/
def descOf (S : St) (d : Path) : Desc :=
  let b := S.bks (ownerOf S.mounts d).bk
  match look b (rel S.mounts d) with
  | some ⟨.dir, m⟩ => .dir (if b.modes then m else synthMeta)
  | some _ => .shadow
  | none => .dir synthMeta

def Desc.meta : Desc → Meta
  | .dir m => m
  | .shadow => synthMeta

/-- The composite's part of the walk, over its own directories from `d`: `none` when
    the whole path is the composite's or it has been handed to a backend. -/
def cPre (S : St) (c : Cred) : Path → List String → Option String
  | _, [] => none
  | d, x :: rs =>
    if !grants c (descOf S d).meta 1 then some "EACCES"
    else if structural S.mounts (d ++ [x]) then cPre S c (d ++ [x]) rs
    else if descOf S d = .shadow then some "ENOENT"
    else none

def structOp (S : St) (c : Cred) (op : Op) (p : Path) : Out :=
  match op with
  | .stat => .stat "directory" (some (descOf S p).meta)
  | .readdir =>
    if !grants c (descOf S p).meta 4 then .err "EACCES"
    else
      let b := S.bks (ownerOf S.mounts p).bk
      let own := match look b (rel S.mounts p) with
        | some ⟨.dir, _⟩ => children b (rel S.mounts p)
        | _ => []
      .names (sortNames (own ++ mountNames S.mounts p))
  | .readFile => .err "EISDIR"
  | .writeFile _ => .err "EBUSY"
  | .unlink => .err "EISDIR"

def backendStep (S : St) (c : Cred) (op : Op) (p : Path) : Out × St :=
  let k := (ownerOf S.mounts p).bk
  match bOp (S.bks k) c op (rel S.mounts p) with
  | (o, some b) => (o, { S with bks := fun j => if j = k then b else S.bks j })
  | (o, none) => (o, S)

def cOp (S : St) (c : Cred) (op : Op) (p : Path) : Out × St :=
  match cPre S c [] p with
  | some e => (if op = .stat ∧ e = "ENOENT" then .null else .err e, S)
  | none => if structural S.mounts p then (structOp S c op p, S) else backendStep S c op p

/-! ## Never wider than the backend -/

theorem never_widens (S : St) (c : Cred) (op : Op) (p : Path) (hs : structural S.mounts p = false) :
    (∃ e, cPre S c [] p = some e ∧ (cOp S c op p).2 = S) ∨
      cOp S c op p = backendStep S c op p := by
  unfold cOp
  cases h : cPre S c [] p with
  | some e => exact Or.inl ⟨e, rfl, rfl⟩
  | none => right; simp [hs]

/-- A backend's refusal stands: the composite answers an error (or `stat`'s null). -/
theorem backend_refusal_stands (S : St) (c : Cred) (op : Op) (p : Path) (hs : structural S.mounts p = false)
    {e : String} (hb : (bOp (S.bks (ownerOf S.mounts p).bk) c op (rel S.mounts p)).1 = .err e) :
    ∃ e', (cOp S c op p).1 = .err e' ∨ (cOp S c op p).1 = .null := by
  unfold cOp
  cases h : cPre S c [] p with
  | some e' =>
    simp only
    split
    · exact ⟨e', Or.inr rfl⟩
    · exact ⟨e', Or.inl rfl⟩
  | none =>
    simp only [hs, Bool.false_eq_true, if_false, backendStep]
    refine ⟨e, Or.inl ?_⟩
    revert hb
    cases bOp (S.bks (ownerOf S.mounts p).bk) c op (rel S.mounts p) with
    | mk o t => intro hb; cases t <;> simpa using hb

/-! ## Search on every composite directory -/

theorem structural_mono {ms : List Mnt} {a q : Path} (hq : structural ms q = true) (ha : a <+: q) :
    structural ms a = true := by
  simp only [structural, Bool.or_eq_true, List.isEmpty_iff, List.any_eq_true, List.isPrefixOf_iff_prefix] at hq ⊢
  rcases hq with rfl | ⟨m, hm, hqm⟩
  · exact Or.inl (List.prefix_nil.mp ha)
  · exact Or.inr ⟨m, hm, ha.trans hqm⟩

theorem cPre_search (S : St) (c : Cred) : ∀ (rs : List String) (d : Path), cPre S c d rs = none →
    ∀ i < rs.length, structural S.mounts (d ++ rs.take i) = true → grants c (descOf S (d ++ rs.take i)).meta 1 = true := by
  intro rs
  induction rs with
  | nil => intro _ _ i hi; simp at hi
  | cons x rs ih =>
    intro d h i hi hs
    unfold cPre at h
    have hx : grants c (descOf S d).meta 1 = true := by
      cases hg : grants c (descOf S d).meta 1
      · simp [hg] at h
      · rfl
    rw [if_neg (by simp [hx])] at h
    cases i with
    | zero => simpa using hx
    | succ i =>
      have e : d ++ (x :: rs).take (i + 1) = (d ++ [x]) ++ rs.take i := by simp
      rw [e] at hs ⊢
      by_cases hq : structural S.mounts (d ++ [x]) = true
      · rw [if_pos hq] at h
        exact ih _ h i (by simp at hi; omega) hs
      · exact absurd (structural_mono hs (List.prefix_append _ _)) hq

/-- Past the walk, every composite directory on the path granted search, as the
    composite describes it. -/
theorem search_checked (S : St) (c : Cred) (p : Path) (h : cPre S c [] p = none) :
    ∀ i < p.length, structural S.mounts (p.take i) = true → grants c (descOf S (p.take i)).meta 1 = true := by
  intro i hi hs
  have := cPre_search S c p [] h i hi (by simpa using hs)
  simpa using this

/-- A composite directory the holding backend (with modes) holds as a directory is
    described by that backend's own mode, owner and group. -/
theorem held_described (S : St) (d : Path) {m : Meta}
    (hl : look (S.bks (ownerOf S.mounts d).bk) (rel S.mounts d) = some ⟨.dir, m⟩)
    (hm : (S.bks (ownerOf S.mounts d).bk).modes = true) : descOf S d = .dir m := by
  simp [descOf, hl, hm]

theorem privileged_passes (g : Nat) (gs : List Nat) (m : Meta) (w : Nat) : grants ⟨0, g, gs⟩ m w = true := by
  simp [grants]

theorem synth_meta_open (c : Cred) :
    grants c synthMeta 1 = true ∧ grants c synthMeta 4 = true ∧ (c.uid ≠ 0 → grants c synthMeta 2 = false) := by
  unfold grants classBits synthMeta
  by_cases h0 : c.uid = 0
  · simp [h0]
  · simp only [h0, if_false]
    split <;> simp [h0]

/-! ## Links in a mount stay in it -/

theorem cPre_congr {S S' : St} (c : Cred) (hm : S'.mounts = S.mounts) : ∀ (rs : List String) (d : Path),
    (∀ i < rs.length, descOf S (d ++ rs.take i) = descOf S' (d ++ rs.take i)) → cPre S c d rs = cPre S' c d rs := by
  intro rs
  induction rs with
  | nil => intro d _; rfl
  | cons x rs ih =>
    intro d h
    have h0 : descOf S d = descOf S' d := by simpa using h 0 (by simp)
    unfold cPre
    rw [h0, hm, ih (d ++ [x]) (fun i hi => by
      have := h (i + 1) (by simp; omega)
      simpa using this)]

/-- A handed-off answer depends only on the mount's own backend and on how the
    composite describes the directories above it: no other backend's contents, so a
    link inside the mount cannot read or reach them. -/
theorem confined (S S' : St) (c : Cred) (op : Op) (p : Path) (hm : S'.mounts = S.mounts)
    (hs : structural S.mounts p = false)
    (hb : S'.bks (ownerOf S.mounts p).bk = S.bks (ownerOf S.mounts p).bk)
    (hd : ∀ i < p.length, descOf S (p.take i) = descOf S' (p.take i)) :
    (cOp S c op p).1 = (cOp S' c op p).1 := by
  have hc := cPre_congr c hm p [] (by simpa using hd)
  unfold cOp
  rw [← hc]
  cases cPre S c [] p with
  | some e => rfl
  | none =>
    simp only [hm, hs, Bool.false_eq_true, if_false, backendStep, rel, hb]
    cases bOp (S.bks (ownerOf S.mounts p).bk) c op (List.drop (ownerOf S.mounts p).point.length p) with
    | mk o t => cases t <;> rfl

/-- A mutation changes only the backend the path is handed to. -/
theorem step_frame (S : St) (c : Cred) (op : Op) (p : Path) :
    (cOp S c op p).2.mounts = S.mounts ∧
      ∀ j, j ≠ (ownerOf S.mounts p).bk → (cOp S c op p).2.bks j = S.bks j := by
  unfold cOp
  cases cPre S c [] p with
  | some e => exact ⟨rfl, fun _ _ => rfl⟩
  | none =>
    simp only
    split
    · exact ⟨rfl, fun _ _ => rfl⟩
    · unfold backendStep
      rcases h : bOp (S.bks (ownerOf S.mounts p).bk) c op (rel S.mounts p) with ⟨o, _ | b⟩
      · simp [h]
      · refine ⟨by simp [h], fun j hj => by simp [h, hj]⟩

/-! ## The perm.mjs trace -/

def kernel : Cred := ⟨0, 0, [0]⟩
def u1 : Cred := ⟨1, 1, [1]⟩
def u2 : Cred := ⟨2, 2, [2]⟩

/-- Root holds `/h` (uid 1, 0700) with `/h/own`; `/h/pc` mounts a backend holding
    `/f` (0644). -/
def permTrace : St :=
  { mounts := [⟨["h", "pc"], 1⟩],
    bks := fun k => if k = 0 then
        { modes := true, root := ⟨0o755, 0, 0⟩,
          ents := [(["h"], ⟨.dir, ⟨0o700, 1, 1⟩⟩), (["h", "pc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩),
            (["h", "own"], ⟨.file 1, ⟨0o644, 0, 0⟩⟩)] }
      else { modes := true, root := ⟨0o755, 0, 0⟩, ents := [(["f"], ⟨.file 7, ⟨0o644, 0, 0⟩⟩)] } }

theorem the_perm_trace :
    (cOp permTrace u2 .stat ["h"]).1 = .stat "directory" (some ⟨0o700, 1, 1⟩) ∧
    (cOp permTrace u2 .readdir ["h"]).1 = .err "EACCES" ∧
    (cOp permTrace u2 .readFile ["h", "own"]).1 = .err "EACCES" ∧
    (cOp permTrace u2 .readFile ["h", "pc", "f"]).1 = .err "EACCES" ∧
    (cOp permTrace u2 .stat ["h", "missing"]).1 = .err "EACCES" ∧
    (cOp permTrace u2 .stat ["h", "pc"]).1 = .err "EACCES" ∧
    (cOp permTrace u1 .readFile ["h", "pc", "f"]).1 = .bytes 7 ∧
    (cOp permTrace u1 .readdir ["h"]).1 = .names ["own", "pc"] ∧
    (cOp permTrace kernel .readFile ["h", "pc", "f"]).1 = .bytes 7 ∧
    (cOp permTrace u2 (.writeFile 9) ["h", "pc"]).1 = .err "EACCES" := by
  decide

/-- The mounted backend alone grants uid 2 the read: only the composite's search
    check on `/h` refuses it. -/
theorem the_backend_alone_grants_the_leak : (bOp (permTrace.bks 1) u2 .readFile ["f"]).1 = .bytes 7 := by
  decide

def rootEtc : Backend :=
  { modes := true, root := ⟨0o755, 0, 0⟩,
    ents := [(["etc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["etc", "p"], ⟨.file 5, ⟨0o644, 0, 0⟩⟩)] }

def pcLinks : Backend :=
  { modes := true, root := ⟨0o755, 0, 0⟩,
    ents := [(["l"], ⟨.link true ["etc", "p"], ⟨0o777, 0, 0⟩⟩), (["r"], ⟨.link false ["..", "..", "etc", "p"], ⟨0o777, 0, 0⟩⟩)] }

def linkTrace : St := { mounts := [⟨["pc"], 1⟩], bks := fun k => if k = 0 then rootEtc else pcLinks }

/-- A link in `/pc`'s backend to `/etc/p`, and one to `../../etc/p`, both resolve in
    that backend (which has no `etc`), never to the root's `/etc/p`. -/
theorem a_link_in_a_mount_stays_in_it :
    (cOp linkTrace u2 .readFile ["pc", "l"]).1 = .err "ENOENT" ∧
      (cOp linkTrace u2 .readFile ["pc", "r"]).1 = .err "ENOENT" ∧
      (cOp linkTrace u2 .readFile ["etc", "p"]).1 = .bytes 5 := by
  decide

end Nimbus.Vfs.CompositePerm
