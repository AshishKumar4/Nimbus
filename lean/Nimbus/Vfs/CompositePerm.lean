/-
  Nimbus.Vfs.CompositePerm — permissions and symlinks through `CompositeVFS`
  (Main's rulings on the P2 widening, node-nomirror 79cdbf90: uid 2 read `/h/pc/f`
  through a 0700 `/h` held by the root backend, and `stat /h` answered 40755; then
  Linux link semantics; then Kinu N26, setgid inheritance).

  A backend is a tree whose entries carry a mode, owner and group. A SqliteVFS
  (`enforces`, `reports`) checks every access itself; its root is always 0755 root:root.
  A MemoryVFS enforces nothing and reports modes only when told to (`reports`). A
  credential is a uid, a primary gid and groups; uid 0 passes every check
  (CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH).

  The composite resolves a path as Linux does, in the caller's namespace, component
  by component (`walk`). Leaving a directory needs search (x) on it, checked before
  the next name is looked up, so EACCES at a component comes before any error from
  a later one. Every symlink, whichever backend holds it, is followed in the
  namespace: an absolute target from the caller's root, a relative one from the
  link's directory; `..` pops a component, so at a mount's root it reaches the mount
  point's parent. Each hop continues the same walk with the same checks; after 40
  hops (MAXSYMLINKS) the answer is ELOOP. The composite describes each path by
  `entAt`: the root, a live mount point or a directory above one is a directory,
  with the stat of the backend that holds it (a mount point is its backend's `/`),
  or a synthesized 0755 root:root where that backend holds nothing there or reports
  no modes; any other path is its holder's entry.

  `resolveResolution` carries that namespace path and an optional raw `Operand`.
  `scanTail`/`forwardedTail` implement design §3's lexical cursor and raw cut. A
  resolving mount receives that operand, interpreted by `backendWalk`: `walk` in
  the backend's own mountless namespace, with physical links and parents, before
  `bOp`. No operand means the existing unflagged backend path and operation.
  Structural directories still go to the composite itself (stat, readdir with
  read (r) permission, the rest refused). A new
  entry in a setgid directory of a backend with modes takes the directory's group,
  and a new directory there is setgid too (N26).

  Proved:
  - `resolve_named`: whatever a walk resolves to, every directory on the resolved
    path is a directory that grants the caller search: through links, the caller
    reaches only what it could name directly. `walk_named`: so with `hands` (a
    mount whose backend resolves its own paths, past its point and off the way to
    a mount nested in it), except where the walk handed the rest to that backend,
    which looks up, searches and follows links there itself (the namespace cursor
    is lexical; the backend's operand is not).
  - `never_widens` / `backend_refusal_stands`: the answer at a resolved path the
    composite does not make is the backend's own, and a backend refusal is never
    turned into a success. `resolved_frame`: that answer depends only on the backend
    that holds the path; `step_frame`: a mutation changes only that backend.
  - `held_described`, `privileged_passes`, `synth_meta_open`, `setgid_inherits`.
  - Traces: `the_perm_trace` (every verdict of perm.mjs),
    `the_backend_alone_grants_the_leak`, `links_resolve_in_the_callers_namespace`
    (absolute, `..` out of a mount, across mounts as `/dev/stdin` to
    `/proc/self/fd/0`, a hop that fails the caller's search check, a cycle),
    `a_setgid_directory_passes_its_group_on`.

  Not modeled here: per-principal sources and the refusal order among ENXIO, EBUSY
  and EXDEV (in `Composite`); ACLs; exec permission on files; umask other than 022.
-/

import Nimbus.Vfs.MountSelection

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

/-- A default ACL's base entries (`u::`, `g::`, `o::`), each an rwx triple. -/
structure Dacl where
  u : Nat
  g : Nat
  o : Nat
  deriving DecidableEq, Repr

structure Backend where
  /-- The backend checks each access itself (SqliteVFS). -/
  enforces : Bool
  /-- The backend reports modes and owners. -/
  reports : Bool
  root : Meta
  ents : List (Path × BEnt)
  /-- Directories with a default ACL. -/
  dacls : List (Path × Dacl)

def daclAt (b : Backend) (r : Path) : Option Dacl := (b.dacls.find? (·.1 == r)).map (·.2)

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

def bGrants (b : Backend) (c : Cred) (m : Meta) (want : Nat) : Bool := !b.enforces || grants c m want

def synthMeta : Meta := ⟨0o755, 0, 0⟩

def setgid (m : Meta) : Bool := m.mode / 1024 % 2 == 1

/-- A create mode masked by a default ACL's base entries, class by class; the umask
    is not applied. -/
def aclMode (cm : Nat) (a : Dacl) : Nat :=
  (cm / 64 % 8 &&& a.u % 8) * 64 + (cm / 8 % 8 &&& a.g % 8) * 8 + (cm % 8 &&& a.o % 8)

/-- The create mode: 0666 for a file, 0777 for a directory. -/
def createMode (dir : Bool) : Nat := if dir then 0o777 else 0o666

/-- A new entry in directory `pm` (default ACL `pd`): the create mode masked by the
    default ACL if there is one, else by umask 022; the writer's owner, but a setgid
    directory of a backend with modes gives its group, and to a new directory its
    setgid bit (N26). A new directory also inherits the default ACL. -/
def newMeta (b : Backend) (c : Cred) (pm : Meta) (pd : Option Dacl) (dir : Bool) : Meta :=
  let sg := b.reports && setgid pm
  let perm := match pd with
    | some a => aclMode (createMode dir) a
    | none => createMode dir - 0o022
  ⟨perm + (if sg && dir then 0o2000 else 0), c.uid, if sg then pm.gid else c.gid⟩

theorem setgid_inherits (b : Backend) (c : Cred) (pm : Meta) (pd : Option Dacl) (dir : Bool) (hr : b.reports = true)
    (hs : setgid pm = true) :
    (newMeta b c pm pd dir).gid = pm.gid ∧ (dir = true → setgid (newMeta b c pm pd dir) = true) := by
  refine ⟨by simp [newMeta, hr, hs], fun hd => ?_⟩
  subst hd
  have hs' : pm.mode / 1024 % 2 = 1 := by simpa [setgid] using hs
  have hp : (match pd with | some a => aclMode (createMode true) a | none => createMode true - 0o022) < 1024 := by
    cases pd with
    | none => simp [createMode]
    | some a =>
      simp only [aclMode, createMode, if_true]
      have := @Nat.and_le_left (0o777 / 64 % 8) (a.u % 8)
      have := @Nat.and_le_left (0o777 / 8 % 8) (a.g % 8)
      have := @Nat.and_le_left (0o777 % 8) (a.o % 8)
      omega
  have hsg : (b.reports && setgid pm) = true := by simp [hr, hs]
  unfold newMeta
  have hsg' : (b.reports && pm.mode / 1024 % 2 == 1 && true) = true := by simpa [setgid] using hsg
  simp only [setgid] at hsg ⊢
  rw [if_pos hsg']
  simp only [beq_iff_eq]
  generalize (match pd with | some a => aclMode (createMode true) a | none => createMode true - 0o022) = P at hp ⊢
  omega

theorem aclMode_classes (cm : Nat) (a : Dacl) :
    aclMode cm a / 64 % 8 = (cm / 64 % 8 &&& a.u % 8) ∧ aclMode cm a / 8 % 8 = (cm / 8 % 8 &&& a.g % 8) ∧
      aclMode cm a % 8 = (cm % 8 &&& a.o % 8) := by
  have h1 := @Nat.and_le_left (cm / 64 % 8) (a.u % 8)
  have h2 := @Nat.and_le_left (cm / 8 % 8) (a.g % 8)
  have h3 := @Nat.and_le_left (cm % 8) (a.o % 8)
  have : cm / 64 % 8 < 8 := Nat.mod_lt _ (by decide)
  have : cm / 8 % 8 < 8 := Nat.mod_lt _ (by decide)
  have : cm % 8 < 8 := Nat.mod_lt _ (by decide)
  unfold aclMode
  omega

theorem and_bit {x u w : Nat} (hx : x < 8) (hu : u < 8) (hw : w = 1 ∨ w = 2 ∨ w = 4)
    (h : (x &&& u) / w % 2 = 1) : x / w % 2 = 1 := by
  have key : ∀ x : Fin 8, ∀ u : Fin 8, ∀ w : Fin 3,
      (x.val &&& u.val) / (2 ^ w.val) % 2 = 1 → x.val / (2 ^ w.val) % 2 = 1 := by decide
  rcases hw with rfl | rfl | rfl
  · exact key ⟨x, hx⟩ ⟨u, hu⟩ 0 h
  · exact key ⟨x, hx⟩ ⟨u, hu⟩ 1 h
  · exact key ⟨x, hx⟩ ⟨u, hu⟩ 2 h

/-- A default ACL never grants more than the create mode asked for: whoever an
    entry made under it grants read, write or search to, the create mode alone would
    have granted it too. -/
theorem acl_never_widens (c : Cred) (cm : Nat) (a : Dacl) (uid gid w : Nat) (hw : w = 1 ∨ w = 2 ∨ w = 4)
    (h : grants c ⟨aclMode cm a, uid, gid⟩ w = true) : grants c ⟨cm, uid, gid⟩ w = true := by
  unfold grants classBits at h ⊢
  obtain ⟨e1, e2, e3⟩ := aclMode_classes cm a
  simp only at h ⊢
  rcases Bool.or_eq_true_iff.mp h with h | h
  · simp [h]
  · refine Bool.or_eq_true_iff.mpr (Or.inr ?_)
    simp only [beq_iff_eq] at h ⊢
    split at h
    · rw [if_pos ‹_›]; rw [e1] at h
      exact and_bit (Nat.mod_lt _ (by decide)) (Nat.mod_lt _ (by decide)) hw h
    · rw [if_neg ‹_›]
      split at h
      · rw [if_pos ‹_›]; rw [e2] at h
        exact and_bit (Nat.mod_lt _ (by decide)) (Nat.mod_lt _ (by decide)) hw h
      · rw [if_neg ‹_›]; rw [e3] at h
        exact and_bit (Nat.mod_lt _ (by decide)) (Nat.mod_lt _ (by decide)) hw h

/-! ## A backend's own operations

  `bLookup` and `bOp` operate on a physically resolved backend path. Unflagged
  namespace walks already supply one; a resolving mount first runs its raw operand
  through `backendWalk`, the same unflagged walker in the backend's own tree. -/

def bLookup (b : Backend) (c : Cred) (r : Path) : Except String Unit :=
  (List.range r.length).foldl (fun acc i => match acc with
    | .error e => .error e
    | .ok () => match look b (r.take i) with
      | some ⟨.dir, m⟩ => if bGrants b c m 1 then .ok () else .error "EACCES"
      | some _ => .error "ENOTDIR"
      | none => .error "ENOENT") (.ok ())

inductive Op where
  | stat
  | readdir
  | readFile
  | writeFile (b : Nat)
  | mkdir
  | unlink
  deriving DecidableEq, Repr

def Op.follow : Op → Bool
  | .mkdir | .unlink => false
  | _ => true

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

def delEnt (b : Backend) (r : Path) : Backend :=
  { b with ents := b.ents.filter (·.1 != r), dacls := b.dacls.filter (·.1 != r) }

/-- Create `r` in its directory, if the backend lets `c` write there; a new
    directory inherits its parent's default ACL. -/
def create (b : Backend) (c : Cred) (r : Path) (k : K) (dir : Bool) : Out × Option Backend :=
  match look b r.dropLast with
  | some ⟨.dir, pm⟩ =>
    if bGrants b c pm 2 then
      let pd := if b.reports then daclAt b r.dropLast else none
      let b' := setEnt b r ⟨k, newMeta b c pm pd dir⟩
      (.ok, some (match pd, dir with
        | some a, true => { b' with dacls := b'.dacls ++ [(r, a)] }
        | _, _ => b'))
    else (.err "EACCES", none)
  | _ => (.err "ENOENT", none)

/-- The backend's own answer for credential `c` at its relative path `r`. -/
def bOp (b : Backend) (c : Cred) (op : Op) (r : Path) : Out × Option Backend :=
  match bLookup b c r with
  | .error e => (if op = .stat ∧ e = "ENOENT" then .null else .err e, none)
  | .ok () =>
    match op, look b r with
    | .stat, none => (.null, none)
    | .stat, some e => (.stat (kindName e.k) (if b.reports then some e.m else none), none)
    | .readdir, some ⟨.dir, m⟩ =>
      if bGrants b c m 4 then (.names (sortNames (children b r)), none) else (.err "EACCES", none)
    | .readdir, some _ => (.err "ENOTDIR", none)
    | .readdir, none => (.err "ENOENT", none)
    | .readFile, some ⟨.file n, m⟩ => if bGrants b c m 4 then (.bytes n, none) else (.err "EACCES", none)
    | .readFile, some ⟨.dir, m⟩ => if bGrants b c m 4 then (.err "EISDIR", none) else (.err "EACCES", none)
    | .readFile, some _ => (.err "EINVAL", none)
    | .readFile, none => (.err "ENOENT", none)
    | .writeFile n, some ⟨.file _, m⟩ =>
      if bGrants b c m 2 then (.ok, some (setEnt b r ⟨.file n, m⟩)) else (.err "EACCES", none)
    | .writeFile _, some ⟨.dir, _⟩ => (.err "EISDIR", none)
    | .writeFile _, some _ => (.err "EINVAL", none)
    | .writeFile n, none => create b c r (.file n) false
    | .mkdir, some _ => (.err "EEXIST", none)
    | .mkdir, none => create b c r .dir true
    | .unlink, none => (.err "ENOENT", none)
    | .unlink, some e =>
      if r = [] then (.err "EISDIR", none) else
      match look b r.dropLast with
      | some ⟨.dir, pm⟩ =>
        if !bGrants b c pm 2 then (.err "EACCES", none)
        else if stickyDenies b c pm e.m then (.err "EPERM", none)
        else if e.k = .dir then (.err "EISDIR", none)
        else (.ok, some (delEnt b r))
      | _ => (.err "ENOENT", none)
where stickyDenies (b : Backend) (c : Cred) (pm m : Meta) : Bool :=
  b.enforces && pm.mode / 512 % 2 == 1 && c.uid != 0 && c.uid != m.uid && c.uid != pm.uid

/-- Move `ra` and everything under it to `rb`, entries keeping their meta. -/
def moveTree (b : Backend) (ra rb : Path) : Backend :=
  let mv (x : Path) : Path := if ra.isPrefixOf x then rb ++ x.drop ra.length else x
  let keep (x : Path) : Bool := !rb.isPrefixOf x
  { b with ents := (b.ents.filter (keep ·.1)).map (fun x => (mv x.1, x.2)),
           dacls := (b.dacls.filter (keep ·.1)).map (fun x => (mv x.1, x.2)) }

/-- A directory moving to another parent rewrites its `..`: it needs write
    permission on itself (`vfs_rename`'s `inode_permission(source, MAY_WRITE)`),
    after both parents' checks and the sticky bit. -/
def movesDotDot (b : Backend) (c : Cred) (src : BEnt) (ra rb : Path) : Bool :=
  src.k == .dir && ra.dropLast != rb.dropLast && !bGrants b c src.m 2

/-- rename(2) within one backend: POSIX's replacement rules, write permission on
    both directories, the sticky bit on either; the moved entries keep their owner,
    group and mode. -/
def bRename (b : Backend) (c : Cred) (ra rb : Path) : Out × Option Backend :=
  match bLookup b c ra, bLookup b c rb with
  | .error e, _ => (.err e, none)
  | _, .error e => (.err e, none)
  | .ok (), .ok () =>
    match look b ra with
    | none => (.err "ENOENT", none)
    | some src =>
      if ra = rb then (.ok, none)
      else if ra.isPrefixOf rb then (.err "EINVAL", none)
      else match look b ra.dropLast, look b rb.dropLast with
        | some ⟨.dir, pa⟩, some ⟨.dir, pb⟩ =>
          if !bGrants b c pa 2 || !bGrants b c pb 2 then (.err "EACCES", none)
          else if bOp.stickyDenies b c pa src.m then (.err "EPERM", none)
          else match look b rb with
            | none =>
              if movesDotDot b c src ra rb then (.err "EACCES", none) else (.ok, some (moveTree b ra rb))
            | some dst =>
              if bOp.stickyDenies b c pb dst.m then (.err "EPERM", none)
              else if src.k = .dir then
                if dst.k ≠ .dir then (.err "ENOTDIR", none)
                else if movesDotDot b c src ra rb then (.err "EACCES", none)
                else if !(children b rb).isEmpty then (.err "ENOTEMPTY", none)
                else (.ok, some (moveTree b ra rb))
              else if dst.k = .dir then (.err "EISDIR", none)
              else (.ok, some (moveTree b ra rb))
        | some ⟨.dir, _⟩, some _ => (.err "ENOTDIR", none)
        | some ⟨.dir, _⟩, none => (.err "ENOENT", none)
        | _, _ => (.err "ENOENT", none)

/-! ## The composite -/

structure Mnt where
  point : Path
  bk : Nat
  deriving DecidableEq, Repr

/-- Backend 0 is the root's, mounted at `[]` implicitly. `hands`: the paths past the
    point of the mount they are in (the longest mount on them) when that mount's
    backend resolves its own paths (`MountOptions.resolvesPaths`); none by default.
    A lookup hands such a path to the backend (`handsTo`) unless it is a directory
    above a mount nested there that the lookup goes on into, or its mount's point
    lies outside `within` (a walk confined beneath a root: CompositeVFS's
    `resolvedByBackend(path, within, to)`). -/
structure St where
  mounts : List Mnt
  bks : Nat → Backend
  hands : Path → Bool := fun _ => false
  within : Path := []

def ownerOf (ms : List Mnt) (p : Path) : Mnt :=
  MountSelection.select (·.point) ms p ⟨[], 0⟩

def rel (ms : List Mnt) (p : Path) : Path := p.drop (ownerOf ms p).point.length

def holder (S : St) (p : Path) : Backend := S.bks (ownerOf S.mounts p).bk

/-- The root, a live mount point, or a directory above one. -/
def structural (ms : List Mnt) (p : Path) : Bool := p.isEmpty || ms.any fun m => p.isPrefixOf m.point

def mountNames (ms : List Mnt) (p : Path) : List String :=
  ms.filterMap fun m => if p.isPrefixOf m.point && p.length < m.point.length then m.point[p.length]? else none

/-- A backend's meta as the composite reports it. -/
def shown (b : Backend) (m : Meta) : Meta := if b.reports then m else synthMeta

/-- How the composite describes a structural directory: the holder's stat if it
    holds a directory there, else synthesized. -/
def descMeta (S : St) (d : Path) : Meta :=
  match look (holder S d) (rel S.mounts d) with
  | some ⟨.dir, m⟩ => shown (holder S d) m
  | _ => synthMeta

/-- Whether the holder has a non-directory at a structural directory: then only
    mount names live under it. -/
def shadow (S : St) (d : Path) : Bool :=
  match look (holder S d) (rel S.mounts d) with
  | some ⟨.dir, _⟩ => false
  | some _ => true
  | none => false

/-- What the namespace holds at a path, as the caller's walk sees it. -/
def entAt (S : St) (q : Path) : Option (K × Meta) :=
  if structural S.mounts q then some (.dir, descMeta S q)
  else if q ≠ [] ∧ structural S.mounts q.dropLast ∧ shadow S q.dropLast then none
  else (look (holder S q) (rel S.mounts q)).map fun e => (e.k, shown (holder S q) e.m)

def metaAt (S : St) (d : Path) : Meta := match entAt S d with
  | some (_, m) => m
  | none => synthMeta

def maxLinks : Nat := 40
def fuel : Nat := 256

/-- Where a walk at `done` goes on to, taking `rest` lexically. -/
def lex : Path → List String → Path
  | done, [] => done
  | done, x :: rs => lex (if x = "" ∨ x = "." then done else if x = ".." then done.dropLast else done ++ [x]) rs

/-- Whether `q` may be handed to its backend: past the point of a flagged mount
    whose point lies at or under `within`. -/
def handsIn (S : St) (q : Path) : Bool :=
  S.hands q && S.within.isPrefixOf (ownerOf S.mounts q).point

/-- Whether a lookup at `q`, going on to `to`, hands `q` to its backend: it may be
    (`handsIn`), and it is not a directory above a mount nested there unless `to`
    stays in that mount. -/
def handsTo (S : St) (q to : Path) : Bool :=
  handsIn S q && (!structural S.mounts q || (ownerOf S.mounts to).point == (ownerOf S.mounts q).point)

/-- The components a walk resumes with, for the link at `q` reading `a`, `t`: on a
    flagged mount (whatever `within` is), from `/`, as its backend reads it from its own
    root, so an absolute target re-roots at the mount point and a relative one climbs
    no higher than it; none when that name is another mount's (a mount nested in the
    flagged one covers it), which the namespace cannot name (CompositeVFS's
    `linkLeadsTo`). Any other link: its target. -/
def linkComps (S : St) (q : Path) (a : Bool) (t : List String) : Option (List String) :=
  if S.hands q then
    let p := (ownerOf S.mounts q).point ++ lex (if a then [] else q.dropLast.drop (ownerOf S.mounts q).point.length) t
    if (ownerOf S.mounts p).point == (ownerOf S.mounts q).point then some p else none
  else some t

/-- Whether the walk at `done`, taking `x` and then `rs`, is in a path its backend
    resolves: it is already, or `x` takes it there. Then nothing is looked up or
    searched here. -/
def handed (S : St) (done : Path) (x : String) (rs : List String) : Bool :=
  handsTo S done (lex done (x :: rs)) || (x != "" && x != "." && x != ".." && handsTo S (done ++ [x]) (lex done (x :: rs)))

/-- The backend's operand, kept separately from the namespace's lexical name.
    Components retain empty names, dots and final separators: `rel = ["", "f"]`
    denotes `//f`, not `/f`. -/
structure Operand where
  point : Path
  rel : Path
  deriving DecidableEq, Repr

structure Resolution where
  path : Path
  operand : Option Operand := none
  deriving DecidableEq, Repr

/-- Dispatch always uses `operand.rel`. The public spelling needs its raw text
    only when a physical `..` can name a different parent; harmless dots and
    duplicate separators retain the existing canonical realpath result. -/
def Resolution.spelling (r : Resolution) : Path :=
  match r.operand with
  | some o => if ".." ∈ o.rel then o.point ++ o.rel else r.path
  | none => r.path

/-- `hands` describes paths *past* a resolving point. A fresh empty component
    probes that option without inventing a backend name, including at `/`. -/
def resolvesAt (S : St) (point : Path) : Bool := S.hands (point ++ [""])

structure TailScan where
  operand : Option Operand := none
  escaped : Bool := false
  deriving DecidableEq, Repr

/-- Design §3: `pos` is the lexical cursor; `cut` and `raw` remember the saved
    position and untouched suffix. Only namespace-owned names and a `..` leaving
    one move the cut. An escape past a non-root point invalidates the operand;
    at the resolving root, `..` clamps in place and stays in the raw suffix. -/
def scanTail (S : St) (point : Path) : Path → Path → List String → List String → TailScan
  | pos, cut, raw, [] =>
    if pos == point || structural S.mounts pos || (ownerOf S.mounts pos).point != point then {}
    else ⟨some ⟨point, cut.drop point.length ++ raw⟩, false⟩
  | pos, cut, raw, x :: rs =>
    if x = "" ∨ x = "." then scanTail S point pos cut raw rs
    else if x = ".." then
      if pos == point then
        if point.isEmpty then scanTail S point pos cut raw rs else ⟨none, true⟩
      else if !point.isPrefixOf pos then ⟨none, true⟩
      else if structural S.mounts pos then scanTail S point pos.dropLast pos.dropLast rs rs
      else scanTail S point pos.dropLast cut raw rs
    else
      let q := pos ++ [x]
      if structural S.mounts q then scanTail S point q q rs rs
      else scanTail S point q cut raw rs

def forwardedTail (S : St) (done : Path) (raw : List String) : TailScan :=
  let point := (ownerOf S.mounts done).point
  if resolvesAt S point && S.within.isPrefixOf point then scanTail S point done done raw raw else {}

/-- Capturing does not change component ownership or the namespace walk. Once a
    scan has found an operand, later backend-owned steps cannot shorten its raw
    prefix. A namespace-followed link starts a new scan. An escaped point stays
    lexical until a fresh named entry to that point (or a link expansion) restarts
    its suffix scan. Cursor equality after a clamped `..` is not a fresh entry. -/
structure Capture where
  operand : Option Operand := none
  escaped : List Path := []

def captureTail (S : St) (done : Path) (raw : List String) (cap : Capture) : Capture :=
  let point := (ownerOf S.mounts done).point
  if cap.operand.isSome || point ∈ cap.escaped then cap
  else
    let scanned := forwardedTail S done raw
    ⟨scanned.operand, if scanned.escaped then point :: cap.escaped else cap.escaped⟩

/-- Called only after taking an ordinary name, not after a lexical no-op/pop. -/
def enterCapture (S : St) (q : Path) (cap : Capture) : Capture :=
  let point := (ownerOf S.mounts q).point
  if q == point then { cap with escaped := cap.escaped.filter (· != point) } else cap

/-- Linux path walk in the caller's namespace; in a path its backend resolves,
    lexical (the backend answers for the rest). -/
def walk (S : St) (c : Cred) (follow : Bool) : Nat → Nat → Path → List String → Except String Path
  | 0, _, _, _ => .error "ELOOP"
  | _ + 1, _, done, [] => .ok done
  | n + 1, h, done, x :: rs =>
    if handed S done x rs then
      if x = "" ∨ x = "." then walk S c follow n h done rs
      else if x = ".." then walk S c follow n h done.dropLast rs
      else walk S c follow n h (done ++ [x]) rs
    else if !grants c (metaAt S done) 1 then .error "EACCES"
    else if x = "" ∨ x = "." then walk S c follow n h done rs
    else if x = ".." then walk S c follow n h done.dropLast rs
    else
      let q := done ++ [x]
      match entAt S q with
      | none => if rs = [] then .ok q else .error "ENOENT"
      | some (.link a t, _) =>
        if rs = [] ∧ follow = false then .ok q
        else if h = 0 then .error "ELOOP"
        else match linkComps S q a t with
          | none => .error "ENOTCAPABLE"
          | some l => walk S c follow n (h - 1) (if (S.hands q || a) = true then [] else done) (l ++ rs)
      | some (.dir, _) => walk S c follow n h q rs
      | some (.file _, _) => if rs = [] then .ok q else .error "ENOTDIR"

def resolve (S : St) (c : Cred) (follow : Bool) (raw : List String) : Except String Path :=
  walk S c follow fuel maxLinks [] raw

/-- The same namespace walk with its dispatch operand carried alongside its
    lexical result. In particular it still visits nested mounts, checks their
    namespace-owned components and follows only namespace-owned links. -/
def walkResolution (S : St) (c : Cred) (follow : Bool) :
    Nat → Nat → Path → List String → Capture → Except String Resolution
  | 0, _, _, _, _ => .error "ELOOP"
  | _ + 1, _, done, [], cap => .ok ⟨done, cap.operand⟩
  | n + 1, h, done, x :: rs, cap =>
    let cap := captureTail S done (x :: rs) cap
    if handed S done x rs then
      if x = "" ∨ x = "." then walkResolution S c follow n h done rs cap
      else if x = ".." then walkResolution S c follow n h done.dropLast rs cap
      else walkResolution S c follow n h (done ++ [x]) rs (enterCapture S (done ++ [x]) cap)
    else if !grants c (metaAt S done) 1 then .error "EACCES"
    else if x = "" ∨ x = "." then walkResolution S c follow n h done rs cap
    else if x = ".." then walkResolution S c follow n h done.dropLast rs cap
    else
      let q := done ++ [x]
      match entAt S q with
      | none => if rs = [] then .ok ⟨q, cap.operand⟩ else .error "ENOENT"
      | some (.link a t, _) =>
        if rs = [] ∧ follow = false then .ok ⟨q, cap.operand⟩
        else if h = 0 then .error "ELOOP"
        else match linkComps S q a t with
          | none => .error "ENOTCAPABLE"
          | some l => walkResolution S c follow n (h - 1)
              (if (S.hands q || a) = true then [] else done) (l ++ rs) {}
      | some (.dir, _) => walkResolution S c follow n h q rs (enterCapture S q cap)
      | some (.file _, _) => if rs = [] then .ok ⟨q, cap.operand⟩ else .error "ENOTDIR"

def resolveResolution (S : St) (c : Cred) (follow : Bool) (raw : List String) : Except String Resolution :=
  walkResolution S c follow fuel maxLinks [] raw {}

/-- Carrying the operand changes neither lexical ownership nor the namespace's
    answer, including its refusal order. -/
private theorem walkResolution_path (S : St) (c : Cred) (f : Bool) :
    ∀ n h done rs cap,
      (walkResolution S c f n h done rs cap).map Resolution.path = walk S c f n h done rs := by
  intro n
  induction n with
  | zero => intro _ _ _ _; rfl
  | succ n ih =>
    intro h done rs cap
    cases rs with
    | nil => rfl
    | cons x rs =>
      simp only [walkResolution, walk]
      split
      · split
        · exact ih _ _ _ _
        · split <;> exact ih _ _ _ _
      · split
        · rfl
        · split
          · exact ih _ _ _ _
          · split
            · exact ih _ _ _ _
            · split
              · split <;> rfl
              · split
                · rfl
                · split
                  · rfl
                  · split
                    · rfl
                    · exact ih _ _ _ _
              · exact ih _ _ _ _
              · split <;> rfl

private theorem resolveResolution_path (S : St) (c : Cred) (f : Bool) (raw : List String) :
    (resolveResolution S c f raw).map Resolution.path = resolve S c f raw :=
  walkResolution_path S c f fuel maxLinks [] raw {}

/-- A backend is its own mountless namespace. Its native permissions do not
    depend on whether it reports modes to the composite. -/
def backendNamespace (b : Backend) : St :=
  { mounts := [], bks := fun _ => { b with reports := true } }

/-- Physical backend-local interpretation: links use the backend root, `..`
    pops the directory actually reached, and a remaining slash or dot requires
    a directory. The unflagged walker also supplies final-follow/create rules. -/
def backendWalk (b : Backend) (c : Cred) (follow : Bool) (raw : Path) : Except String Path :=
  walk (backendNamespace b) (if b.enforces then c else ⟨0, 0, [0]⟩) follow fuel maxLinks [] raw

def backendOp (b : Backend) (c : Cred) (op : Op) (raw : Path) : Out × Option Backend :=
  match backendWalk b c op.follow raw with
  | .error e => (if op = .stat ∧ e = "ENOENT" then .null else .err e, none)
  | .ok p => bOp b c op p

/-- Unhanded paths keep the old `bOp` exactly. An operand is accepted only by
    the mount whose point anchors it. -/
def backendAnswer (S : St) (c : Cred) (op : Op) (p : Path) (operand : Option Operand) : Out × Option Backend :=
  match operand with
  | some o => if o.point == (ownerOf S.mounts p).point then backendOp (holder S p) c op o.rel
      else bOp (holder S p) c op (rel S.mounts p)
  | none => bOp (holder S p) c op (rel S.mounts p)

def backendPath (S : St) (c : Cred) (follow : Bool) (r : Resolution) : Except String Path :=
  match r.operand with
  | some o => if o.point == (ownerOf S.mounts r.path).point then backendWalk (holder S r.path) c follow o.rel
      else .ok (rel S.mounts r.path)
  | none => .ok (rel S.mounts r.path)

def structOp (S : St) (c : Cred) (op : Op) (p : Path) : Out :=
  match op with
  | .stat => .stat "directory" (some (descMeta S p))
  | .readdir =>
    if !grants c (descMeta S p) 4 then .err "EACCES"
    else
      let b := holder S p
      let own := match look b (rel S.mounts p) with
        | some ⟨.dir, _⟩ => children b (rel S.mounts p)
        | _ => []
      .names (sortNames (own ++ mountNames S.mounts p))
  | .readFile => if grants c (descMeta S p) 4 then .err "EISDIR" else .err "EACCES"
  | .writeFile _ => .err "EBUSY"
  | .mkdir => .err "EBUSY"
  | .unlink => if p ≠ [] ∧ !grants c (descMeta S p.dropLast) 2 then .err "EACCES" else .err "EISDIR"

def backendStep (S : St) (c : Cred) (op : Op) (p : Path) (operand : Option Operand := none) : Out × St :=
  let k := (ownerOf S.mounts p).bk
  match backendAnswer S c op p operand with
  | (o, some b) => (o, { S with bks := fun j => if j = k then b else S.bks j })
  | (o, none) => (o, S)

/-- A path directly under a structural directory its holder does not hold as a
    directory: only mount names live there, so it is absent (Composite's rule). -/
def underShadow (S : St) (p : Path) : Bool :=
  p != [] && structural S.mounts p.dropLast && !(look (holder S p.dropLast) (rel S.mounts p.dropLast)).any (·.k == .dir)

def cOp (S : St) (c : Cred) (op : Op) (raw : List String) : Out × St :=
  match resolveResolution S c op.follow raw with
  | .error e => (if op = .stat ∧ e = "ENOENT" then .null else .err e, S)
  | .ok r =>
    if structural S.mounts r.path then (structOp S c op r.path, S)
    else if underShadow S r.path then (if op = .stat then .null else .err "ENOENT", S)
    else backendStep S c op r.path r.operand

/-- rename(2) through the composite: neither side followed; a structural path is
    EBUSY; across backends EXDEV; else the holder's own rename. -/
def cRename (S : St) (c : Cred) (a b : List String) : Out × St :=
  match resolveResolution S c false a, resolveResolution S c false b with
  | .error e, _ => (.err e, S)
  | _, .error e => (.err e, S)
  | .ok p, .ok q =>
    if structural S.mounts p.path || structural S.mounts q.path then (.err "EBUSY", S)
    else if ownerOf S.mounts p.path ≠ ownerOf S.mounts q.path then (.err "EXDEV", S)
    else
      let k := (ownerOf S.mounts p.path).bk
      match backendPath S c false p, backendPath S c false q with
      | .error e, _ => (.err e, S)
      | _, .error e => (.err e, S)
      | .ok ra, .ok rb =>
        match bRename (S.bks k) c ra rb with
        | (o, some b) => (o, { S with bks := fun j => if j = k then b else S.bks j })
        | (o, none) => (o, S)

/-! ## Links reach only what the caller could name -/

def IsDir (S : St) (q : Path) : Prop := ∃ m, entAt S q = some (.dir, m)

theorem root_dir (S : St) : IsDir S [] := ⟨descMeta S [], by simp [entAt, structural]⟩

/-- Every directory on `d` (each proper prefix) is a directory granting search. -/
def Named (S : St) (c : Cred) (d : Path) : Prop :=
  ∀ i < d.length, IsDir S (d.take i) ∧ grants c (metaAt S (d.take i)) 1 = true

theorem named_snoc {S : St} {c : Cred} {d : Path} (x : String) (hn : Named S c d) (hd : IsDir S d)
    (hg : grants c (metaAt S d) 1 = true) : Named S c (d ++ [x]) := by
  intro i hi
  simp only [List.length_append, List.length_singleton] at hi
  by_cases e : i = d.length
  · subst e; rw [List.take_append_of_le_length (Nat.le_refl _), List.take_length]; exact ⟨hd, hg⟩
  · rw [List.take_append_of_le_length (by omega)]; exact hn i (by omega)

theorem named_dropLast {S : St} {c : Cred} {d : Path} (hn : Named S c d) (hd : IsDir S d) :
    Named S c d.dropLast ∧ IsDir S d.dropLast := by
  rw [List.dropLast_eq_take]
  refine ⟨fun i hi => ?_, ?_⟩
  · simp only [List.length_take] at hi
    rw [List.take_take, Nat.min_eq_left (by omega)]
    exact hn i (by omega)
  · cases d with
    | nil => exact hd
    | cons y ys => exact (hn _ (by simp)).1

/-- A path past a flagged mount's point leads on to one, or to a directory (a mount
    point nested there); and the directory it is in is past that point too, or a
    directory (at the top, the mount point). -/
def HandsWF (S : St) : Prop :=
  (∀ p x, handsIn S p = true → handsIn S (p ++ [x]) = true ∨ IsDir S (p ++ [x])) ∧
  (∀ p, handsIn S p = true → handsIn S p.dropLast = true ∨ IsDir S p.dropLast)

/-- Every directory on `d` is a directory granting the caller search, or is in or
    leads into a path its backend resolves, which that backend checks. -/
def NamedH (S : St) (c : Cred) (d : Path) : Prop :=
  ∀ i < d.length, handsIn S (d.take i) = true ∨ handsIn S (d.take (i + 1)) = true ∨
    (IsDir S (d.take i) ∧ grants c (metaAt S (d.take i)) 1 = true)

theorem structural_dir {S : St} {q : Path} (h : structural S.mounts q = true) : IsDir S q :=
  ⟨descMeta S q, by simp [entAt, h]⟩

theorem namedH_snoc {S : St} {c : Cred} {d : Path} (x : String) (hn : NamedH S c d)
    (hx : handsIn S d = true ∨ handsIn S (d ++ [x]) = true ∨ (IsDir S d ∧ grants c (metaAt S d) 1 = true)) :
    NamedH S c (d ++ [x]) := by
  intro i hi
  simp only [List.length_append, List.length_singleton] at hi
  by_cases e : i = d.length
  · subst e
    rw [List.take_append_of_le_length (Nat.le_refl _), List.take_length, List.take_of_length_le (by simp)]
    exact hx
  · rw [List.take_append_of_le_length (by omega), List.take_append_of_le_length (by omega)]
    exact hn i (by omega)

theorem namedH_dropLast {S : St} {c : Cred} {d : Path} (hn : NamedH S c d) : NamedH S c d.dropLast := by
  rw [List.dropLast_eq_take]
  intro i hi
  simp only [List.length_take] at hi
  simp only [List.take_take]
  rw [Nat.min_eq_left (show i + 1 ≤ d.length - 1 by omega), Nat.min_eq_left (show i ≤ d.length - 1 by omega)]
  exact hn i (by omega)

/-- The directory the walk's `done` is in is past a flagged mount's point, or a directory. -/
theorem namedH_parent {S : St} {c : Cred} {d : Path} (hw : HandsWF S) (hn : NamedH S c d) :
    handsIn S d.dropLast = true ∨ IsDir S d.dropLast := by
  cases d with
  | nil => exact .inr (root_dir S)
  | cons y ys =>
    have h := hn ys.length (by simp)
    simp only [List.length_cons] at h
    rw [List.take_of_length_le (show (y :: ys).length ≤ ys.length + 1 by simp)] at h
    have hdl : (y :: ys).dropLast = (y :: ys).take ys.length := by rw [List.dropLast_eq_take]; simp
    rw [hdl]
    rcases h with h | h | h
    · exact .inl h
    · rcases hw.2 _ h with h' | h'
      · exact .inl (by rw [← hdl]; exact h')
      · exact .inr (by rw [← hdl]; exact h')
    · exact .inr h.1

/-- Component ownership, without where the lookup goes. Capturing an operand
    does not change this decision (`walkResolution_path`). -/
theorem handed_hands {S : St} {done : Path} {x : String} {rs : List String} (h : handed S done x rs = true) :
    handsIn S done = true ∨ ((x = "" → False) ∧ (x = "." → False) ∧ (x = ".." → False) ∧ handsIn S (done ++ [x]) = true) := by
  unfold handed handsTo at h
  simp only [Bool.or_eq_true, Bool.and_eq_true, bne_iff_ne, ne_eq] at h
  rcases h with h | h
  · exact .inl h.1
  · exact .inr ⟨h.1.1.1, h.1.1.2, h.1.2, h.2.1⟩

/-- A walk not handed over at a path past a flagged point is at a directory above a
    nested mount. This remains lexical even when a raw operand is captured. -/
theorem unhanded_dir {S : St} {done : Path} {x : String} {rs : List String} (h : handed S done x rs = false)
    (hd : handsIn S done = true ∨ IsDir S done) : IsDir S done := by
  rcases hd with hd | hd
  · apply structural_dir
    unfold handed handsTo at h
    simp only [hd, Bool.true_and, Bool.or_eq_false_iff, Bool.not_eq_eq_eq_not, Bool.not_true] at h
    cases hs : structural S.mounts done
    · simp [hs] at h
    · rfl
  · exact hd

/-- Whatever a walk resolves to, every directory on it grants the caller search,
    except where it is in or leads into a path its backend resolves. -/
theorem walk_named (S : St) (c : Cred) (f : Bool) (hw : HandsWF S) :
    ∀ n h done rs p, NamedH S c done → (handsIn S done = true ∨ IsDir S done) →
      walk S c f n h done rs = .ok p → NamedH S c p := by
  intro n
  induction n with
  | zero => intro _ _ _ _ _ _ h; simp [walk] at h
  | succ n ih =>
    intro h done rs p hn hd hwk
    cases rs with
    | nil => simp only [walk, Except.ok.injEq] at hwk; subst hwk; exact hn
    | cons x rs =>
      simp only [walk] at hwk
      split at hwk
      · rename_i hh
        split at hwk
        · exact ih _ _ _ _ hn hd hwk
        · split at hwk
          · exact ih _ _ _ _ (namedH_dropLast hn) (namedH_parent hw hn) hwk
          · rename_i hx1 hx2
            rcases handed_hands hh with hq | ⟨_, _, _, hq⟩
            · have hnext := hw.1 _ x hq
              exact ih _ _ _ _ (namedH_snoc x hn (.inl hq)) hnext hwk
            · exact ih _ _ _ _ (namedH_snoc x hn (.inr (.inl hq))) (.inl hq) hwk
      · rename_i hh
        have hdir : IsDir S done := unhanded_dir (by simpa using hh) hd
        split at hwk
        · cases hwk
        · rename_i hg
          have hg : grants c (metaAt S done) 1 = true := by simpa using hg
          have hs : handsIn S done = true ∨ handsIn S (done ++ [x]) = true ∨ (IsDir S done ∧ grants c (metaAt S done) 1 = true) :=
            .inr (.inr ⟨hdir, hg⟩)
          split at hwk
          · exact ih _ _ _ _ hn hd hwk
          · split at hwk
            · exact ih _ _ _ _ (namedH_dropLast hn) (namedH_parent hw hn) hwk
            · split at hwk
              · split at hwk
                · cases hwk; exact namedH_snoc x hn hs
                · cases hwk
              · split at hwk
                · cases hwk; exact namedH_snoc x hn hs
                · split at hwk
                  · cases hwk
                  · split at hwk
                    · cases hwk
                    · split at hwk
                      · exact ih _ _ _ _ (fun i hi => by simp at hi) (.inr (root_dir S)) hwk
                      · exact ih _ _ _ _ hn hd hwk
              · rename_i m he
                exact ih _ _ _ _ (namedH_snoc x hn hs) (.inr ⟨m, he⟩) hwk
              · split at hwk
                · cases hwk; exact namedH_snoc x hn hs
                · cases hwk

/-- Whatever a path resolves to in a namespace that hands nothing over, through any
    number of links, every directory on the resolved path is a directory that grants
    the caller search: it reaches only what it could name directly. -/
theorem resolve_named (S : St) (c : Cred) (f : Bool) (hS : ∀ q, S.hands q = false) (raw : List String) (p : Path)
    (h : resolve S c f raw = .ok p) : ∀ i < p.length, IsDir S (p.take i) ∧ grants c (metaAt S (p.take i)) 1 = true := by
  have hwf : HandsWF S := ⟨fun q _ hq => by simp [handsIn, hS] at hq, fun q hq => by simp [handsIn, hS] at hq⟩
  have hn := walk_named S c f hwf _ _ _ _ p (fun i hi => by simp at hi) (.inr (root_dir S)) h
  intro i hi
  rcases hn i hi with h' | h' | h'
  · simp [handsIn, hS] at h'
  · simp [handsIn, hS] at h'
  · exact h'

/-! ## Never wider than the backend -/

theorem never_widens (S : St) (c : Cred) (op : Op) (raw : List String) :
    (∃ e, resolveResolution S c op.follow raw = .error e ∧ (cOp S c op raw).2 = S) ∨
      (∃ r, resolveResolution S c op.follow raw = .ok r ∧ structural S.mounts r.path = true ∧ cOp S c op raw = (structOp S c op r.path, S)) ∨
      (∃ r, resolveResolution S c op.follow raw = .ok r ∧ underShadow S r.path = true ∧ (cOp S c op raw).2 = S ∧
        ((cOp S c op raw).1 = .null ∨ (cOp S c op raw).1 = .err "ENOENT")) ∨
      (∃ r, resolveResolution S c op.follow raw = .ok r ∧ structural S.mounts r.path = false ∧ underShadow S r.path = false ∧
        cOp S c op raw = backendStep S c op r.path r.operand) := by
  unfold cOp
  cases h : resolveResolution S c op.follow raw with
  | error e => exact Or.inl ⟨e, rfl, rfl⟩
  | ok r =>
    cases hs : structural S.mounts r.path
    · cases hu : underShadow S r.path
      · exact Or.inr (Or.inr (Or.inr ⟨r, rfl, hs, hu, by simp [hs, hu]⟩))
      · refine Or.inr (Or.inr (Or.inl ⟨r, rfl, hu, by simp [hs, hu], ?_⟩))
        simp only [hs, hu, Bool.false_eq_true, if_false, if_true]
        split <;> simp
    · exact Or.inr (Or.inl ⟨r, rfl, hs, by simp [hs]⟩)

/-- A backend's refusal stands: where it refuses, the composite answers an error. -/
theorem backend_refusal_stands (S : St) (c : Cred) (op : Op) (raw : List String) (r : Resolution)
    (hr : resolveResolution S c op.follow raw = .ok r) (hs : structural S.mounts r.path = false) (hu : underShadow S r.path = false)
    {e : String} (hb : (backendAnswer S c op r.path r.operand).1 = .err e) : (cOp S c op raw).1 = .err e := by
  unfold cOp
  simp only [hr, hs, hu, Bool.false_eq_true, if_false, backendStep]
  revert hb
  cases backendAnswer S c op r.path r.operand with
  | mk o t => intro hb; cases t <;> simpa using hb

/-- Once resolved, the answer depends only on the backend that holds the path. -/
theorem resolved_frame (S S' : St) (c : Cred) (op : Op) (p : Path) (operand : Option Operand) (hm : S'.mounts = S.mounts)
    (hb : S'.bks (ownerOf S.mounts p).bk = S.bks (ownerOf S.mounts p).bk) :
    (backendStep S c op p operand).1 = (backendStep S' c op p operand).1 := by
  have ha : backendAnswer S' c op p operand = backendAnswer S c op p operand := by
    simp only [backendAnswer, holder, hm, hb, rel]
  unfold backendStep
  rw [ha]
  cases backendAnswer S c op p operand with
  | mk o t => cases t <;> rfl

/-- A mutation changes only the backend the resolved path is handed to. -/
theorem step_frame (S : St) (c : Cred) (op : Op) (p : Path) (operand : Option Operand) :
    (backendStep S c op p operand).2.mounts = S.mounts ∧
      ∀ j, j ≠ (ownerOf S.mounts p).bk → (backendStep S c op p operand).2.bks j = S.bks j := by
  unfold backendStep
  rcases h : backendAnswer S c op p operand with ⟨o, _ | b⟩
  · simp [h]
  · refine ⟨by simp [h], fun j hj => by simp [h, hj]⟩

/-- A structural directory the holding backend (with modes) holds as a directory is
    described by that backend's own mode, owner and group. -/
theorem held_described (S : St) (d : Path) {m : Meta} (hl : look (holder S d) (rel S.mounts d) = some ⟨.dir, m⟩)
    (hm : (holder S d).reports = true) : descMeta S d = m := by
  simp [descMeta, hl, shown, hm]

theorem privileged_passes (g : Nat) (gs : List Nat) (m : Meta) (w : Nat) : grants ⟨0, g, gs⟩ m w = true := by
  simp [grants]

theorem synth_meta_open (c : Cred) :
    grants c synthMeta 1 = true ∧ grants c synthMeta 4 = true ∧ (c.uid ≠ 0 → grants c synthMeta 2 = false) := by
  unfold grants classBits synthMeta
  by_cases h0 : c.uid = 0
  · simp [h0]
  · simp only [h0, if_false]
    split <;> simp [h0]

/-! ## Traces -/

def kernel : Cred := ⟨0, 0, [0]⟩
def u1 : Cred := ⟨1, 1, [1]⟩
def u2 : Cred := ⟨2, 2, [2]⟩

def sqlite (ents : List (Path × BEnt)) (dacls : List (Path × Dacl) := []) : Backend := ⟨true, true, synthMeta, ents, dacls⟩

def memory (ents : List (Path × BEnt)) : Backend := ⟨false, false, synthMeta, ents, []⟩

/-- Root holds `/h` (uid 1, 0700) with `/h/own`; `/h/pc` mounts a backend holding
    `/f` (0644). -/
def permTrace : St :=
  { mounts := [⟨["h", "pc"], 1⟩],
    bks := fun k => if k = 0 then
        sqlite [(["h"], ⟨.dir, ⟨0o700, 1, 1⟩⟩), (["h", "pc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩),
          (["h", "own"], ⟨.file 1, ⟨0o644, 0, 0⟩⟩)]
      else sqlite [(["f"], ⟨.file 7, ⟨0o644, 0, 0⟩⟩)] }

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

/-- Root: `/etc/p`, and `/h` (uid 1, 0700) holding `/h/s`. `/pc` (MemoryVFS, no
    modes): `l -> /etc/p`, `r -> ../etc/p`, `x -> /h/s`, `a -> b`, `b -> a`.
    `/proc` holds `self/fd/0`; `/dev` (MemoryVFS) has `stdin -> /proc/self/fd/0`. -/
def linkTrace : St :=
  { mounts := [⟨["pc"], 1⟩, ⟨["proc"], 2⟩, ⟨["dev"], 3⟩],
    bks := fun k =>
      if k = 0 then sqlite [(["etc"], ⟨.dir, ⟨0o755, 0, 0⟩⟩), (["etc", "p"], ⟨.file 5, ⟨0o644, 0, 0⟩⟩),
        (["h"], ⟨.dir, ⟨0o700, 1, 1⟩⟩), (["h", "s"], ⟨.file 6, ⟨0o644, 1, 1⟩⟩)]
      else if k = 1 then memory
        [(["l"], ⟨.link true ["etc", "p"], synthMeta⟩), (["r"], ⟨.link false ["..", "etc", "p"], synthMeta⟩),
         (["x"], ⟨.link true ["h", "s"], synthMeta⟩), (["a"], ⟨.link false ["b"], synthMeta⟩),
         (["b"], ⟨.link false ["a"], synthMeta⟩)]
      else if k = 2 then sqlite [(["self"], ⟨.dir, ⟨0o555, 0, 0⟩⟩), (["self", "fd"], ⟨.dir, ⟨0o500, 2, 2⟩⟩),
        (["self", "fd", "0"], ⟨.file 8, ⟨0o600, 2, 2⟩⟩)]
      else memory [(["stdin"], ⟨.link true ["proc", "self", "fd", "0"], synthMeta⟩)] }

theorem links_resolve_in_the_callers_namespace :
    (cOp linkTrace u2 .readFile ["pc", "l"]).1 = .bytes 5 ∧
    (cOp linkTrace u2 .readFile ["pc", "r"]).1 = .bytes 5 ∧
    (cOp linkTrace u2 .readFile ["dev", "stdin"]).1 = .bytes 8 ∧
    (cOp linkTrace u1 .readFile ["dev", "stdin"]).1 = .err "EACCES" ∧
    (cOp linkTrace u2 .readFile ["pc", "x"]).1 = .err "EACCES" ∧
    (cOp linkTrace u1 .readFile ["pc", "x"]).1 = .bytes 6 ∧
    (cOp linkTrace u1 .readFile ["pc", "a"]).1 = .err "ELOOP" ∧
    (cOp linkTrace u1 .unlink ["pc", "a"]).1 = .ok := by
  decide

/-- `/g` is setgid, group 10, writable by group 10: uid 1 (in group 10) makes a file
    and a directory there; both take group 10, and the directory is setgid. -/
def sgTrace : St :=
  { mounts := [], bks := fun _ => sqlite [(["g"], ⟨.dir, ⟨0o2775, 0, 10⟩⟩)] }

theorem a_setgid_directory_passes_its_group_on :
    let c : Cred := ⟨1, 1, [1, 10]⟩
    let S1 := (cOp sgTrace c (.writeFile 3) ["g", "f"]).2
    let S2 := (cOp S1 c .mkdir ["g", "d"]).2
    (cOp S2 c .stat ["g", "f"]).1 = .stat "file" (some ⟨0o644, 1, 10⟩) ∧
      (cOp S2 c .stat ["g", "d"]).1 = .stat "directory" (some ⟨0o2755, 1, 10⟩) := by
  decide

/-- `/p` and `/q` are 0777; `/p/d` is uid 1's 0555 directory. uid 1 cannot move it
    to `/q` (its `..` would change) but can rename it within `/p`; uid 0 can move it.
    `/` is 0755 root:root: uid 1 cannot create, rename or remove directly in it. -/
def dotdotTrace : St :=
  { mounts := [], bks := fun _ => sqlite [(["p"], ⟨.dir, ⟨0o777, 0, 0⟩⟩), (["q"], ⟨.dir, ⟨0o777, 0, 0⟩⟩),
      (["p", "d"], ⟨.dir, ⟨0o555, 1, 1⟩⟩), (["t"], ⟨.file 2, ⟨0o666, 1, 1⟩⟩)] }

theorem moving_a_directory_needs_write_on_it :
    (cRename dotdotTrace u1 ["p", "d"] ["q", "d"]).1 = .err "EACCES" ∧
    (cRename dotdotTrace u1 ["p", "d"] ["p", "e"]).1 = .ok ∧
    (cRename dotdotTrace kernel ["p", "d"] ["q", "d"]).1 = .ok ∧
    (cOp dotdotTrace u1 (.writeFile 1) ["n"]).1 = .err "EACCES" ∧
    (cOp dotdotTrace u1 .mkdir ["n"]).1 = .err "EACCES" ∧
    (cOp dotdotTrace u1 .unlink ["t"]).1 = .err "EACCES" ∧
    (cRename dotdotTrace u1 ["t"] ["u"]).1 = .err "EACCES" ∧
    (cRename dotdotTrace u1 ["t"] ["p", "t"]).1 = .err "EACCES" ∧
    (cOp dotdotTrace kernel .mkdir ["n"]).1 = .ok := by
  decide

/-- `/a` has default ACL u::rwx g::r-x o::--- and is setgid, group 10; uid 1 makes
    `/a/f` (0666 asked: 0640), `/a/d` (0777 asked: 02750, inheriting the ACL), and
    `/a/d/g` (0640 again). Renaming `/a/f` to `/f` keeps its group. -/
def aclTrace : St :=
  { mounts := [], bks := fun _ => sqlite [(["a"], ⟨.dir, ⟨0o2777, 0, 10⟩⟩)] [(["a"], ⟨7, 5, 0⟩)] }

theorem a_default_acl_masks_and_is_inherited :
    let c : Cred := ⟨1, 1, [1, 10]⟩
    let S1 := (cOp aclTrace c (.writeFile 3) ["a", "f"]).2
    let S2 := (cOp S1 c .mkdir ["a", "d"]).2
    let S3 := (cOp S2 c (.writeFile 4) ["a", "d", "g"]).2
    let S4 := (cRename S3 kernel ["a", "f"] ["f"]).2
    (cOp S3 c .stat ["a", "f"]).1 = .stat "file" (some ⟨0o640, 1, 10⟩) ∧
      (cOp S3 c .stat ["a", "d"]).1 = .stat "directory" (some ⟨0o2750, 1, 10⟩) ∧
      (cOp S3 c .stat ["a", "d", "g"]).1 = .stat "file" (some ⟨0o640, 1, 10⟩) ∧
      daclAt (S3.bks 0) ["a", "d"] = some ⟨7, 5, 0⟩ ∧
      (cOp S4 c .stat ["f"]).1 = .stat "file" (some ⟨0o640, 1, 10⟩) := by
  decide

/-! ## Resolving mount operands (design §3) -/

def operandBackend : Backend := sqlite
  [(["f"], ⟨.file 1, ⟨0o644, 0, 0⟩⟩),
   (["dir"], ⟨.dir, synthMeta⟩),
   (["a"], ⟨.dir, synthMeta⟩), (["a", "b"], ⟨.dir, synthMeta⟩),
   (["a", "f"], ⟨.file 2, ⟨0o644, 0, 0⟩⟩),
   (["a", "x"], ⟨.dir, synthMeta⟩), (["a", "x", "f"], ⟨.file 3, ⟨0o644, 0, 0⟩⟩),
   (["link"], ⟨.link true ["a", "b"], ⟨0o777, 0, 0⟩⟩),
   (["toF"], ⟨.link true ["f"], ⟨0o777, 0, 0⟩⟩),
   (["loop"], ⟨.link true ["loop"], ⟨0o777, 0, 0⟩⟩),
   (["x"], ⟨.file 99, ⟨0o644, 0, 0⟩⟩)]

def operandMounts : List Mnt := [⟨["m"], 1⟩, ⟨["m", "n"], 2⟩, ⟨["m", "a", "n"], 3⟩]

def operandTrace (nestedResolves : Bool := false) : St :=
  { mounts := operandMounts,
    bks := fun k => if k = 0 then sqlite [(["x"], ⟨.file 99, ⟨0o644, 0, 0⟩⟩)]
      else if k = 1 then operandBackend
      else sqlite [(["f"], ⟨.file (if k = 2 then 4 else 5), ⟨0o644, 0, 0⟩⟩)],
    hands := fun q =>
      ((ownerOf operandMounts q).point == ["m"] && decide (1 < q.length)) ||
      (nestedResolves && (ownerOf operandMounts q).point == ["m", "n"] && decide (2 < q.length)) }

def rootOperandMounts : List Mnt := [⟨["n"], 1⟩, ⟨["a", "n"], 2⟩]

def rootOperandTrace : St :=
  { mounts := rootOperandMounts,
    bks := fun k => if k = 0 then operandBackend else sqlite [(["f"], ⟨.file 4, ⟨0o644, 0, 0⟩⟩)],
    hands := fun q => (ownerOf rootOperandMounts q).point == [] && !q.isEmpty }

/-- Exact operands, not merely equal lexical destinations. -/
private theorem the_forwarded_operands :
    let S := operandTrace
    let tail := fun raw => (forwardedTail S ["m"] raw).operand
    tail ["missing", "..", "f"] = some ⟨["m"], ["missing", "..", "f"]⟩ ∧
    tail [".", "f"] = some ⟨["m"], [".", "f"]⟩ ∧
    tail ["", "f"] = some ⟨["m"], ["", "f"]⟩ ∧
    tail ["f", ""] = some ⟨["m"], ["f", ""]⟩ ∧
    tail ["f", "."] = some ⟨["m"], ["f", "."]⟩ ∧
    tail ["n", "..", "f"] = some ⟨["m"], ["f"]⟩ ∧
    tail ["n", "..", "missing", "..", "f"] = some ⟨["m"], ["missing", "..", "f"]⟩ ∧
    tail ["a", "x", "missing", "..", "f"] = some ⟨["m"], ["a", "x", "missing", "..", "f"]⟩ ∧
    tail ["n", "..", "..", "x"] = none ∧
    tail ["dir", ".."] = none ∧
    tail ["x", "..", "n", "f"] = none ∧
    (forwardedTail rootOperandTrace [] ["", "f"]).operand = some ⟨[], ["", "f"]⟩ := by
  decide

/-- The resolution carries the scan unchanged through lexical cursor steps;
    these assertions also cover the implicit root and the deepest resolving mount. -/
private theorem the_resolution_keeps_its_operand :
    (resolveResolution operandTrace kernel true ["m", ".", "f"]).map Resolution.operand =
      .ok (some ⟨["m"], [".", "f"]⟩) ∧
    (resolveResolution operandTrace kernel true ["m", "", "f"]).map Resolution.operand =
      .ok (some ⟨["m"], ["", "f"]⟩) ∧
    (resolveResolution operandTrace kernel true ["m", "f", ""]).map Resolution.operand =
      .ok (some ⟨["m"], ["f", ""]⟩) ∧
    (resolveResolution operandTrace kernel true ["m", "n", "..", "missing", "..", "f"]).map Resolution.operand =
      .ok (some ⟨["m"], ["missing", "..", "f"]⟩) ∧
    (resolveResolution (operandTrace true) kernel true ["m", "missing", "..", "n", "f"]).map Resolution.operand =
      .ok (some ⟨["m", "n"], ["f"]⟩) ∧
    (resolveResolution rootOperandTrace kernel true ["", "f"]).map Resolution.operand =
      .ok (some ⟨[], ["", "f"]⟩) ∧
    (resolveResolution rootOperandTrace kernel true ["..", "missing", "..", "f"]).map Resolution.operand =
      .ok (some ⟨[], ["..", "missing", "..", "f"]⟩) ∧
    (resolveResolution rootOperandTrace kernel true ["..", "f"]).map Resolution.operand =
      .ok (some ⟨[], ["..", "f"]⟩) ∧
    (resolveResolution operandTrace kernel true ["m", "..", "m", "missing", "..", "f"]).map Resolution.operand =
      .ok (some ⟨["m"], ["missing", "..", "f"]⟩) := by
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

private theorem capture_restarts_only_on_entry :
    (captureTail operandTrace ["m"] ["f"] { escaped := [["m"]] }).operand = none ∧
    (captureTail operandTrace ["m"] ["f"]
      (enterCapture operandTrace ["m"] { escaped := [["m"]] })).operand = some ⟨["m"], ["f"]⟩ := by
  decide

/-- Namespace ownership stays lexical, while the operand's backend-local walk
    observes missing/non-directory components and the physical parent of a link. -/
private theorem resolving_backends_walk_physically :
    (cOp operandTrace kernel .readFile ["m", "missing", "..", "f"]).1 = .err "ENOENT" ∧
    (cOp operandTrace kernel .readFile ["m", "..", "m", "missing", "..", "f"]).1 = .err "ENOENT" ∧
    (cOp operandTrace kernel .readFile ["m", "f", ""]).1 = .err "ENOTDIR" ∧
    (cOp operandTrace kernel .readFile ["m", "f", "."]).1 = .err "ENOTDIR" ∧
    (cOp operandTrace kernel .readFile ["m", "link", "..", "f"]).1 = .bytes 2 ∧
    (cOp operandTrace kernel .readFile ["m", "n", "..", "f"]).1 = .bytes 1 ∧
    (cOp operandTrace kernel .readFile ["m", "n", "..", "missing", "..", "f"]).1 = .err "ENOENT" ∧
    (cOp operandTrace kernel .readFile ["m", "missing", "..", "n", "f"]).1 = .bytes 4 ∧
    (cOp operandTrace kernel .readFile ["m", "n", "..", "..", "x"]).1 = .bytes 99 ∧
    (cOp rootOperandTrace kernel .readFile ["link", "..", "f"]).1 = .bytes 2 ∧
    (cOp rootOperandTrace kernel .readFile ["..", "missing", "..", "f"]).1 = .err "ENOENT" ∧
    (cOp rootOperandTrace kernel .readFile ["..", "f"]).1 = .bytes 1 ∧
    (cOp rootOperandTrace kernel .readFile ["missing", "..", "f"]).1 = .err "ENOENT" := by
  decide

private theorem resolving_creation_keeps_the_physical_parent :
    let S := (cOp operandTrace kernel (.writeFile 7) ["m", "link", "new"]).2
    let T := (cOp S kernel (.writeFile 8) ["m", "link", "..", "made"]).2
    (cOp S kernel .readFile ["m", "a", "b", "new"]).1 = .bytes 7 ∧
    (cOp T kernel .readFile ["m", "a", "made"]).1 = .bytes 8 ∧
    look (T.bks 1) ["new"] = none ∧ look (T.bks 1) ["made"] = none := by
  decide

end Nimbus.Vfs.CompositePerm
