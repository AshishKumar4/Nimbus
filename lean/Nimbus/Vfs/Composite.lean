/-
  Nimbus.Vfs.Composite — `CompositeVFS` (DESIGN.md §2, /mnt/scratch/nimbus/verify/vfs-api):
  one executable model of routing, per-principal sources, synthesized mount-point
  directories, root-symlink resolution and the refusals, over trees for each backend.
  The refinement fixture `lean/fixtures/composite-vfs.json` is this model's output.

  Rules, as modeled (the ones DESIGN.md leaves open are marked DECIDED):
  - A raw path is normalized in the composite namespace (`""`/`.` dropped, `..` pops,
    never above `/`), then resolved through the root backend's symlinks, then routed
    to the longest mount point that is a prefix.
  - DECIDED: a path is absent for a principal when ANY mount whose point is a prefix
    of it answers null for that principal, not only the longest one. A live mount
    nested under an absent one is unreachable through it.
  - Absent: `stat` → null; every other op → ENXIO. Never an empty directory.
  - Synthesized directories: a live, reachable mount point and each ancestor of one
    `stat`s as a directory and shows in its parent's `readdir`. A name whose path is
    absent for the principal is never listed, even if a backend holds it.
  - Root symlinks are followed at a prefix only when that prefix routes to the root
    backend and is not a live mount point or an ancestor of one
    (DECIDED: the synthesized directory wins over a root link of the same name).
    A link inside a mounted backend is never followed by the composite.
    Eight substitutions at most, then ELOOP. The last component is followed for
    `stat`, `readdir`, `readFile` and `writeFile`, never for `mkdir`, `unlink`,
    `rmdir` or `rename`.
  - Order of refusals: ENXIO, then EBUSY (a live mount point, or an ancestor of one,
    for `unlink`/`rmdir`/`rename`), then EXDEV (`rename` across mounts), then the
    backend's own answer. `mkdir -p` of a live mount point or ancestor succeeds and
    changes nothing.

  Proved: `route_spec` (longest matching prefix), `normParts_clean`,
  `absent_refuses`, `busy_refuses`, `exdev_refuses` (and none of them touch a
  backend), `resolve_root_only` (the composite substitutes only root links),
  `readdir_live_only` (no absent name is ever listed) and `noninterference`
  (a backend reachable only through mounts absent for the principal neither
  influences nor receives any of the principal's operations).
-/

namespace Nimbus.Vfs.Composite

abbrev Path := List String
abbrev Principal := Nat
abbrev Backend := Nat

inductive Ent where
  | file (bytes : Nat)
  | dir
  | link (target : String)
  deriving DecidableEq, Repr

/-- A backend's tree, paths relative to its root (the root itself is implicit). -/
abbrev Tree := List (Path × Ent)

structure Mount where
  point : Path
  backend : Backend
  /-- `none`: the source answers for everyone; `some ps`: only for `ps`. -/
  only : Option (List Principal)
  deriving DecidableEq, Repr

structure St where
  mounts : List Mount
  trees : Backend → Tree

def rootMount : Mount := ⟨[], 0, none⟩

/-! ## Normalization -/

def normStep (acc : Path) (c : String) : Path :=
  if c = "" ∨ c = "." then acc else if c = ".." then acc.dropLast else acc ++ [c]

def normParts (base : Path) (parts : List String) : Path := parts.foldl normStep base

def norm (raw : String) : Path := normParts [] (raw.splitOn "/")

def Clean (p : Path) : Prop := ∀ c ∈ p, c ≠ "" ∧ c ≠ "." ∧ c ≠ ".."

theorem normParts_clean : ∀ (parts : List String) (base : Path), Clean base → Clean (normParts base parts) := by
  intro parts
  induction parts with
  | nil => intro base h; exact h
  | cons c cs ih =>
    intro base h
    apply ih
    unfold normStep
    split
    · exact h
    · split
      · intro x hx; exact h x ((List.dropLast_sublist _).subset hx)
      · rename_i h1 h2
        intro x hx
        rcases List.mem_append.mp hx with hx | hx
        · exact h x hx
        · simp at hx; subst hx; exact ⟨fun e => h1 (Or.inl e), fun e => h1 (Or.inr e), h2⟩

/-- A normalized path has no `""`, `.` or `..` component. -/
theorem norm_clean (raw : String) : Clean (norm raw) :=
  normParts_clean _ [] (fun _ h => by cases h)

/-! ## Routing -/

def pfx (a p : Path) : Bool := a.isPrefixOf p

theorem pfx_iff {a p : Path} : pfx a p = true ↔ a <+: p := List.isPrefixOf_iff_prefix

def pick (p : Path) (best m : Mount) : Mount :=
  if pfx m.point p && decide (best.point.length < m.point.length) then m else best

/-- The longest mount point that is a prefix of `p`; the root when none is. -/
def route (ms : List Mount) (p : Path) : Mount := ms.foldl (pick p) rootMount

theorem route_fold (p : Path) : ∀ (ms : List Mount) (best : Mount), best.point <+: p →
    let r := ms.foldl (pick p) best
    r.point <+: p ∧ (r = best ∨ r ∈ ms) ∧ best.point.length ≤ r.point.length ∧
      ∀ m ∈ ms, m.point <+: p → m.point.length ≤ r.point.length := by
  intro ms
  induction ms with
  | nil => intro best h; exact ⟨h, Or.inl rfl, Nat.le_refl _, fun _ h => by cases h⟩
  | cons m ms ih =>
    intro best hb
    simp only [List.foldl_cons]
    have hp : (pick p best m).point <+: p := by
      unfold pick; split
      · rename_i h; simp only [Bool.and_eq_true, decide_eq_true_eq] at h; exact pfx_iff.mp h.1
      · exact hb
    obtain ⟨h1, h2, h3, h4⟩ := ih (pick p best m) hp
    refine ⟨h1, ?_, ?_, ?_⟩
    · rcases h2 with h2 | h2
      · rw [h2]; unfold pick; split
        · exact Or.inr (List.mem_cons_self _ _)
        · exact Or.inl rfl
      · exact Or.inr (List.mem_cons_of_mem _ h2)
    · have : best.point.length ≤ (pick p best m).point.length := by
        unfold pick; split
        · rename_i h; simp only [Bool.and_eq_true, decide_eq_true_eq] at h; omega
        · exact Nat.le_refl _
      omega
    · intro m' hm' hpm
      rcases List.mem_cons.mp hm' with rfl | hm'
      · have : m'.point.length ≤ (pick p best m').point.length := by
          unfold pick; split
          · exact Nat.le_refl _
          · rename_i h
            simp only [Bool.and_eq_true, decide_eq_true_eq, not_and, pfx_iff.mpr hpm, true_implies] at h
            omega
        omega
      · exact h4 m' hm' hpm

/-- Routing picks a mount whose point is a prefix of the path, and no longer one. -/
theorem route_spec (ms : List Mount) (p : Path) :
    (route ms p).point <+: p ∧ (route ms p = rootMount ∨ route ms p ∈ ms) ∧
      ∀ m ∈ ms, m.point <+: p → m.point.length ≤ (route ms p).point.length := by
  obtain ⟨h1, h2, _, h4⟩ := route_fold p ms rootMount (List.nil_prefix)
  exact ⟨h1, h2, h4⟩

/-! ## Per-principal sources -/

def live (P : Principal) (m : Mount) : Bool := m.only.all (·.contains P)

/-- Some mount on the path answers null for `P`. -/
def absent (ms : List Mount) (P : Principal) (p : Path) : Bool := ms.any fun m => pfx m.point p && !live P m

/-- `p` is a live mount point or an ancestor of one that `P` can reach. -/
def synth (ms : List Mount) (P : Principal) (p : Path) : Bool :=
  ms.any fun m => pfx p m.point && live P m && !absent ms P m.point

def isPoint (ms : List Mount) (p : Path) : Bool := ms.any fun m => m.point == p

/-! ## Backends -/

def look (t : Tree) (rp : Path) : Option Ent := if rp = [] then some .dir else (t.find? (·.1 == rp)).map (·.2)

def rel (ms : List Mount) (p : Path) : Path := p.drop (route ms p).point.length

def treeAt (S : St) (p : Path) : Tree := S.trees (route S.mounts p).backend

def setTree (S : St) (b : Backend) (t : Tree) : St :=
  { S with trees := fun c => if c = b then t else S.trees c }

/-! ## Root-symlink resolution -/

/-- The first prefix (ending at `limit` components) that is a root link to follow. -/
def firstLink (S : St) (P : Principal) (p : Path) (limit : Nat) : Option (Nat × String) :=
  ((List.range limit).map (· + 1)).findSome? fun i =>
    let q := p.take i
    if (route S.mounts q).point = [] ∧ synth S.mounts P q = false then
      match look (S.trees 0) q with
      | some (.link t) => some (i, t)
      | _ => none
    else none

def resolve (S : St) (P : Principal) (follow : Bool) : Nat → Path → Option Path
  | 0, _ => none
  | fuel + 1, p =>
    match firstLink S P p (if follow then p.length else p.length - 1) with
    | none => some p
    | some (i, t) =>
      resolve S P follow fuel (normParts (if t.startsWith "/" then [] else (p.take i).dropLast) (t.splitOn "/") ++ p.drop i)

/-- The composite substitutes only links the root backend holds, at prefixes the
    root backend serves: a link inside a mount is the mount's to resolve. -/
theorem resolve_root_only (S : St) (P : Principal) (p : Path) (limit : Nat) {i : Nat} {t : String}
    (h : firstLink S P p limit = some (i, t)) :
    (route S.mounts (p.take i)).point = [] ∧ look (S.trees 0) (p.take i) = some (.link t) ∧
      synth S.mounts P (p.take i) = false := by
  unfold firstLink at h
  obtain ⟨j, _, hj⟩ := List.exists_of_findSome?_eq_some h
  simp only at hj
  split at hj
  · rename_i hc
    split at hj
    · rename_i t' hl; cases hj; exact ⟨hc.1, hl, hc.2⟩
    · cases hj
  · cases hj

/-! ## Operations -/

inductive Op where
  | stat (p : String)
  | readdir (p : String)
  | readFile (p : String)
  | writeFile (p : String) (b : Nat)
  | mkdirp (p : String)
  | unlink (p : String)
  | rmdir (p : String)
  | rename (a b : String)

inductive Out where
  | ok
  | null
  | kind (k : String)
  | bytes (b : Nat)
  | names (l : List String)
  | err (code : String)
  deriving DecidableEq, Repr

def fuel : Nat := 8

def children (t : Tree) (rp : Path) : List String :=
  (t.filter fun x => x.1.length = rp.length + 1 && pfx rp x.1).filterMap (·.1.getLast?)

def mountChildren (ms : List Mount) (P : Principal) (p : Path) : List String :=
  (ms.filter fun m => pfx p m.point && m.point.length > p.length && live P m).filterMap fun m => m.point[p.length]?

def listing (S : St) (P : Principal) (p : Path) : List String :=
  ((children (treeAt S p) (rel S.mounts p) ++ mountChildren S.mounts P p).eraseDups.mergeSort
    (fun a b => decide (a ≤ b))).filter fun n => !absent S.mounts P (p ++ [n])

def kindOf : Ent → String
  | .file _ => "file"
  | .dir => "directory"
  | .link _ => "symlink"

/-- Remove `rp` and everything under it. -/
def cut (t : Tree) (rp : Path) : Tree := t.filter fun x => !pfx rp x.1

def mkdirs (t : Tree) (rp : Path) : Tree :=
  (List.range rp.length).foldl (fun t i =>
    let q := rp.take (i + 1)
    if (look t q).isSome then t else t ++ [(q, .dir)]) t

def moveTree (t : Tree) (a b : Path) : Tree :=
  t.map fun x => if pfx a x.1 then (b ++ x.1.drop a.length, x.2) else x

/-- What an operation does to the backend `P` reaches for a resolved, reachable
    path: the answer, and the new tree for that backend (if any). -/
def backendOp (S : St) (P : Principal) : Op → Path → Path → Out × Option Tree
  | .stat _, p, _ =>
    if synth S.mounts P p then (.kind "directory", none)
    else match look (treeAt S p) (rel S.mounts p) with
      | some e => (.kind (kindOf e), none)
      | none => (.null, none)
  | .readdir _, p, _ =>
    if synth S.mounts P p then (.names (listing S P p), none)
    else match look (treeAt S p) (rel S.mounts p) with
      | some .dir => (.names (listing S P p), none)
      | some _ => (.err "ENOTDIR", none)
      | none => (.err "ENOENT", none)
  | .readFile _, p, _ =>
    if synth S.mounts P p then (.err "EISDIR", none)
    else match look (treeAt S p) (rel S.mounts p) with
      | some (.file b) => (.bytes b, none)
      | some .dir => (.err "EISDIR", none)
      | some _ => (.err "EINVAL", none)
      | none => (.err "ENOENT", none)
  | .writeFile _ b, p, _ =>
    let t := treeAt S p
    let rp := rel S.mounts p
    if synth S.mounts P p then (.err "EISDIR", none)
    else if look t rp.dropLast ≠ some .dir then (.err "ENOENT", none)
    else if look t rp = some .dir then (.err "EISDIR", none)
    else (.ok, some ((t.filter (·.1 != rp)) ++ [(rp, .file b)]))
  | .mkdirp _, p, _ =>
    if synth S.mounts P p then (.ok, none)
    else
      let t := treeAt S p
      let rp := rel S.mounts p
      if (List.range rp.length).any fun i => match look t (rp.take (i + 1)) with
          | some .dir => false | some _ => true | none => false
      then (.err "ENOTDIR", none) else (.ok, some (mkdirs t rp))
  | .unlink _, p, _ =>
    let t := treeAt S p
    let rp := rel S.mounts p
    match look t rp with
    | some .dir => (.err "EISDIR", none)
    | some _ => (.ok, some (t.filter (·.1 != rp)))
    | none => (.err "ENOENT", none)
  | .rmdir _, p, _ =>
    let t := treeAt S p
    let rp := rel S.mounts p
    match look t rp with
    | some .dir => if (children t rp).isEmpty then (.ok, some (t.filter (·.1 != rp))) else (.err "ENOTEMPTY", none)
    | some _ => (.err "ENOTDIR", none)
    | none => (.err "ENOENT", none)
  | .rename _ _, a, b =>
    let t := treeAt S a
    let ra := rel S.mounts a
    let rb := rel S.mounts b
    if (look t ra).isNone then (.err "ENOENT", none)
    else if look t rb.dropLast ≠ some .dir then (.err "ENOENT", none)
    else if (look t rb).isSome then (.err "EEXIST", none)
    else if pfx ra rb then (.err "EINVAL", none)
    else (.ok, some (moveTree t ra rb))

def Op.follow : Op → Bool
  | .stat _ | .readdir _ | .readFile _ | .writeFile _ _ => true
  | _ => false

def Op.raw : Op → String
  | .stat p | .readdir p | .readFile p | .writeFile p _ | .mkdirp p | .unlink p | .rmdir p | .rename p _ => p

def Op.raw2 : Op → Option String
  | .rename _ b => some b
  | _ => none

def Op.guarded : Op → Bool
  | .unlink _ | .rmdir _ | .rename _ _ => true
  | _ => false

/-- The composite's answer on resolved paths `p` (and `q` for `rename`). -/
def execResolved (S : St) (P : Principal) (op : Op) (p q : Path) : Out × St :=
  if absent S.mounts P p || (op.raw2.isSome && absent S.mounts P q) then
    (match op with | .stat _ => .null | _ => .err "ENXIO", S)
  else if op.guarded && (synth S.mounts P p || (op.raw2.isSome && synth S.mounts P q)) then (.err "EBUSY", S)
  else if op.raw2.isSome && (route S.mounts p).point != (route S.mounts q).point then (.err "EXDEV", S)
  else
    let (o, t) := backendOp S P op p q
    match t with
    | some t => (o, setTree S (route S.mounts p).backend t)
    | none => (o, S)

def exec (S : St) (P : Principal) (op : Op) : Out × St :=
  match resolve S P op.follow fuel (norm op.raw) with
  | none => (.err "ELOOP", S)
  | some p =>
    match op.raw2 with
    | none => execResolved S P op p []
    | some r2 =>
      match resolve S P false fuel (norm r2) with
      | none => (.err "ELOOP", S)
      | some q => execResolved S P op p q

/-! ## The refusals -/

/-- An absent path: `stat` is null, every other operation ENXIO, and nothing changes. -/
theorem absent_refuses (S : St) (P : Principal) (op : Op) (p q : Path) (h : absent S.mounts P p = true) :
    execResolved S P op p q = ((match op with | .stat _ => .null | _ => .err "ENXIO"), S) := by
  unfold execResolved; rw [if_pos (by simp [h])]

/-- `unlink`, `rmdir` and `rename` of a live mount point or an ancestor of one: EBUSY. -/
theorem busy_refuses (S : St) (P : Principal) (op : Op) (p q : Path) (hg : op.guarded = true)
    (ha : absent S.mounts P p = false) (ha2 : op.raw2.isSome = false ∨ absent S.mounts P q = false)
    (h : synth S.mounts P p = true) : execResolved S P op p q = (.err "EBUSY", S) := by
  unfold execResolved
  rw [if_neg (by rcases ha2 with h2 | h2 <;> simp [ha, h2]), if_pos (by simp [hg, h])]

/-- `rename` across mounts: EXDEV, never emulated, nothing changes. -/
theorem exdev_refuses (S : St) (P : Principal) (a b : String) (p q : Path)
    (ha : absent S.mounts P p = false) (hb : absent S.mounts P q = false)
    (hs : synth S.mounts P p = false) (hs2 : synth S.mounts P q = false)
    (hx : (route S.mounts p).point ≠ (route S.mounts q).point) :
    execResolved S P (.rename a b) p q = (.err "EXDEV", S) := by
  unfold execResolved
  simp [Op.raw2, Op.guarded, ha, hb, hs, hs2, hx]

/-- `readdir` never lists a name whose path is absent for the principal. -/
theorem readdir_live_only (S : St) (P : Principal) (p : Path) (n : String) (hn : n ∈ listing S P p) :
    absent S.mounts P (p ++ [n]) = false := by
  unfold listing at hn
  simpa using (List.mem_filter.mp hn).2

/-! ## Noninterference -/

/-- `b` is served only by mounts that are unreachable for `P`. -/
def Hidden (ms : List Mount) (P : Principal) (b : Backend) : Prop :=
  b ≠ 0 ∧ ∀ m ∈ ms, m.backend = b → ∃ m' ∈ ms, m'.point <+: m.point ∧ live P m' = false

def Agree (S S' : St) (b : Backend) : Prop := S'.mounts = S.mounts ∧ ∀ c, c ≠ b → S'.trees c = S.trees c

theorem absent_of_prefix {ms : List Mount} {P : Principal} {m : Mount} {p : Path} (hm : m ∈ ms)
    (hp : m.point <+: p) (hl : live P m = false) : absent ms P p = true :=
  List.any_eq_true.mpr ⟨m, hm, by simp [pfx_iff.mpr hp, hl]⟩

/-- A reachable path is served by a backend other than a hidden one. -/
theorem route_not_hidden {ms : List Mount} {P : Principal} {b : Backend} (hb : Hidden ms P b) {p : Path}
    (ha : absent ms P p = false) : (route ms p).backend ≠ b := by
  intro e
  obtain ⟨hpre, hmem, _⟩ := route_spec ms p
  rcases hmem with h | h
  · rw [h] at e; exact hb.1 e.symm
  · obtain ⟨m', hm', hpm, hl⟩ := hb.2 _ h e
    rw [absent_of_prefix hm' (hpm.trans hpre) hl] at ha; cases ha

theorem firstLink_agree {S S' : St} {b : Backend} (hA : Agree S S' b) (hb0 : b ≠ 0) (P : Principal) (p : Path)
    (limit : Nat) : firstLink S' P p limit = firstLink S P p limit := by
  unfold firstLink; rw [hA.1, hA.2 0 (Ne.symm hb0)]

theorem resolve_agree {S S' : St} {b : Backend} (hA : Agree S S' b) (hb0 : b ≠ 0) (P : Principal) (f : Bool) :
    ∀ n p, resolve S' P f n p = resolve S P f n p := by
  intro n
  induction n with
  | zero => intro p; rfl
  | succ n ih =>
    intro p
    simp only [resolve]
    rw [firstLink_agree hA hb0]
    split
    · rfl
    · exact ih _

theorem treeAt_agree {S S' : St} {P : Principal} {b : Backend} (hA : Agree S S' b) (hb : Hidden S.mounts P b)
    {p : Path} (ha : absent S.mounts P p = false) : treeAt S' p = treeAt S p := by
  unfold treeAt; rw [hA.1]; exact hA.2 _ (route_not_hidden hb ha)

theorem listing_agree {S S' : St} {P : Principal} {b : Backend} (hA : Agree S S' b) (hb : Hidden S.mounts P b)
    {p : Path} (ha : absent S.mounts P p = false) : listing S' P p = listing S P p := by
  unfold listing rel; rw [treeAt_agree hA hb ha, hA.1]

theorem backendOp_agree {S S' : St} {P : Principal} {b : Backend} (hA : Agree S S' b) (hb : Hidden S.mounts P b)
    (op : Op) {p q : Path} (ha : absent S.mounts P p = false) : backendOp S' P op p q = backendOp S P op p q := by
  have ht := treeAt_agree hA hb ha
  have hl := listing_agree hA hb ha
  have hm := hA.1
  cases op <;> simp only [backendOp, rel, ht, hl, hm]

/-- A backend served only through mounts absent for `P` neither influences nor
    receives any of `P`'s operations: two states that differ only in it give `P`
    the same answer and stay different only in it. -/
theorem noninterference {S S' : St} {P : Principal} {b : Backend} (hA : Agree S S' b) (hb : Hidden S.mounts P b)
    (op : Op) : (exec S' P op).1 = (exec S P op).1 ∧ Agree (exec S P op).2 (exec S' P op).2 b := by
  have hr := resolve_agree hA hb.1 P
  have core : ∀ p q, (execResolved S' P op p q).1 = (execResolved S P op p q).1 ∧
      Agree (execResolved S P op p q).2 (execResolved S' P op p q).2 b := by
    intro p q
    unfold execResolved
    rw [hA.1]
    split
    · exact ⟨rfl, hA⟩
    · split
      · exact ⟨rfl, hA⟩
      · split
        · exact ⟨rfl, hA⟩
        · rename_i hab _ _
          have ha : absent S.mounts P p = false := by
            revert hab; cases absent S.mounts P p <;> simp
          rw [← hA.1, backendOp_agree hA hb op ha, hA.1]
          obtain ⟨o, t⟩ := backendOp S P op p q
          cases t with
          | none => exact ⟨rfl, hA⟩
          | some t =>
            refine ⟨rfl, hA.1, fun c hc => ?_⟩
            simp only [setTree]
            split
            · rfl
            · exact hA.2 c hc
  unfold exec
  rw [hr]
  split
  · exact ⟨rfl, hA⟩
  · split
    · exact core _ _
    · rw [hr]
      split
      · exact ⟨rfl, hA⟩
      · exact core _ _

end Nimbus.Vfs.Composite
