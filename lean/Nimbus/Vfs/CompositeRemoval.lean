/-
  The shared GNU-style postorder removal walk. Discovery does not follow the final
  symlink. A child whose lstat fails is still unlinked; an unreadable directory is
  still rmdir'd. Only a refused removal keeps its ancestors, and a kept directory
  is never attempted again. ENOENT is gone; the policy bit additionally keeps its
  ancestors for rm -r (without -f). The API, Node, and rm -rf leave that bit off.

  Faults describe backend answers, not an extra traversal: an ENOENT fault models
  an entry vanishing between enumeration and the indicated call. Mount read-only
  flags and the backend's unlink/rmdir pins are independent of its native rm.
-/
import Nimbus.Vfs.Composite

namespace Nimbus.Vfs.CompositeRemoval

open Nimbus.Vfs.Composite

structure Faults where
  stat : List (Path × String) := []
  readdir : List (Path × String) := []
  remove : List (Path × String) := []
  deriving DecidableEq, Repr

structure Config where
  readOnly : Bool := false
  pins : List Path := []
  faults : Faults := {}
  deriving DecidableEq, Repr

structure Failure where
  path : Path
  code : String
  syscall : String
  deriving DecidableEq, Repr

/-- A plan entry carries its scope proof: the walk cannot invent a path outside
    the operand, even when it enters another backend through a live mount. -/
structure Entry (operand : Path) where
  path : Path
  under : pfx operand path = true
  dir : Bool
  vanished : Bool := false
  unread : Option String := none

structure Result where
  state : St
  gone : List Path := []
  kept : List Path := []
  failures : List Failure := []
  vanished : List Path := []

def fault (fs : List (Path × String)) (p : Path) : Option String :=
  (fs.find? (·.1 == p)).map (·.2)

def owner (S : St) (composed : Bool) (operand q : Path) : Mount :=
  route S.mounts (if composed then q else operand)

def localPath (S : St) (composed : Bool) (operand q : Path) : Path :=
  q.drop (owner S composed operand q).point.length

def isStructural (S : St) (P : Principal) (q : Path) : Bool :=
  q == [] || synth S.mounts P q

def observed (S : St) (P : Principal) (composed : Bool) (operand q : Path) : Option Ent :=
  if composed && isStructural S P q then some .dir
  else if composed && (absent S.mounts P q || shadowed S P q q) then none
  else look (S.trees (owner S composed operand q).backend) (localPath S composed operand q)

def namesAt (S : St) (P : Principal) (composed : Bool) (operand q : Path) : List String :=
  if composed then
    -- Fixture backends start in path order. Composite readdirOf keeps those own
    -- names first and appends mount names in table order, not lexical order.
    -- Alias races make that order observable even when the report is sorted.
    let extra := (mountChildren S.mounts P q).eraseDups
    let own := if synth S.mounts P q && look (treeAt S q) (rel S.mounts q) != some .dir then []
      else (children (treeAt S q) (rel S.mounts q)).eraseDups.mergeSort (fun a b => decide (a ≤ b))
    ((own.filter (fun n => !extra.contains n)) ++ extra).filter (fun n => !absent S.mounts P (q ++ [n]))
  else (children (S.trees (owner S composed operand q).backend) (localPath S composed operand q)).eraseDups.mergeSort
    (fun a b => decide (a ≤ b))

/-- A successful unlink/rmdir deletes only that entry. ENOENT faults stand for an
    external disappearance of the entry (and its subtree, if a directory). -/
def erase (S : St) (b : Backend) (rp : Path) (vanished : Bool := false) : St :=
  setTree S b (if vanished then cut (S.trees b) rp else (S.trees b).filter (·.1 != rp))

/-- Discovery observes external disappearances immediately. In particular, when
    two mount points alias a backend, a child that vanishes through the first
    mount is not invented again in the second mount's later directory listing. -/
def applyVanished (base : St) (composed : Bool) (operand : Path) (entries : List (Entry operand)) : St :=
  entries.foldl (fun S e => if e.vanished then
    erase S (owner base composed operand e.path).backend (localPath base composed operand e.path) true else S) base

variable (cfg : Backend → Config)

/-- The operand's lstat error aborts. A non-ENOENT child lstat error schedules an
    unlink, not an error report. A failed scandir schedules rmdir, not a refusal. -/
def discoverFrom (S : St) (P : Principal) (composed : Bool) (operand : Path) :
    Nat → (q : Path) → pfx operand q = true → Bool → List (Entry operand) → Except String (List (Entry operand))
  | 0, _, _, _, _ => .error "ELOOP"
  | n + 1, q, hq, top, prior =>
    let current := applyVanished S composed operand prior
    let m := owner S composed operand q
    let rp := localPath S composed operand q
    let statError := fault (cfg m.backend).faults.stat rp
    let base : Entry operand := ⟨q, hq, false, false, none⟩
    match statError with
    | some code =>
      if top then .error code
      else if code = "ENOENT" then .ok (prior ++ [{ base with vanished := true }])
      else .ok (prior ++ [base])
    | none =>
      match observed current P composed operand q with
      | none => if top then .error "ENOENT" else .ok (prior ++ [{ base with vanished := true }])
      | some .dir =>
        let dir := { base with dir := true }
        match fault (cfg m.backend).faults.readdir rp with
        | some "ENOENT" => .ok (prior ++ [{ dir with vanished := true }])
        | some code => .ok (prior ++ [{ dir with unread := some code }])
        | none =>
          -- A mount point is not entered (rm --one-file-system): it stays, its rmdir EBUSY.
          if composed && S.mounts.any (fun mount => mount.point == q && mount.point != [] && live P mount) then .ok (prior ++ [dir]) else
          let plans := (namesAt current P composed operand q).foldl (fun result name => do
            let prior ← result
            discoverFrom S P composed operand n (q ++ [name])
              (pfx_iff.mpr ((pfx_iff.mp hq).trans (List.prefix_append q [name]))) false prior) (.ok prior)
          plans.map (· ++ [dir])
      | some _ => .ok (prior ++ [base])

def discover (S : St) (P : Principal) (composed : Bool) (operand : Path) (n : Nat)
    (q : Path) (hq : pfx operand q = true) (top : Bool) : Except String (List (Entry operand)) :=
  discoverFrom cfg S P composed operand n q hq top []

/-- All ancestors, including the failed entry, through the operand. -/
def ancestors (operand q : Path) : List Path :=
  (List.range (q.length + 1)).filterMap fun i =>
    let p := q.take i
    if pfx operand p then some p else none

def mergePaths (ps qs : List Path) : List Path :=
  ps ++ qs.filter (fun q => !ps.contains q)

theorem mem_mergePaths (p : Path) (ps qs : List Path) :
    p ∈ mergePaths ps qs ↔ p ∈ ps ∨ p ∈ qs := by
  by_cases hp : p ∈ ps <;> simp [mergePaths, List.contains_iff_mem, hp]

def keep (operand q : Path) (r : Result) : Result :=
  { r with kept := mergePaths r.kept (ancestors operand q) }

def gone (operand q : Path) (vanished strict : Bool) (S' : St) (r : Result) : Result :=
  let r' : Result := { r with
    state := S'
    gone := mergePaths r.gone [q]
    vanished := if vanished then mergePaths r.vanished [q] else r.vanished }
  if vanished && strict && q != operand then keep operand q.dropLast r' else r'

def refused (operand : Path) (f : Failure) (r : Result) : Result :=
  keep operand f.path { r with failures := r.failures ++ [f] }

def backendError (base : St) (composed : Bool) {operand : Path}
    (S : St) (e : Entry operand) : Option String :=
  let m := owner base composed operand e.path
  let rp := localPath base composed operand e.path
  let c := cfg m.backend
  match fault c.faults.remove rp with
    | some code => some code
    | none =>
      if c.pins.contains rp then some "EBUSY"
      else match look (S.trees m.backend) rp with
        | none => some "ENOENT"
        | some .dir =>
          if !e.dir then some "EISDIR"
          else if !(children (S.trees m.backend) rp).isEmpty then some "ENOTEMPTY"
          else none
        | some _ => if e.dir then some "ENOTDIR" else none

def syscall {operand : Path} (e : Entry operand) : String := if e.dir then "rmdir" else "unlink"

def busyCode {operand : Path} (e : Entry operand) : String := if e.dir then "EBUSY" else "EISDIR"

def attempt (base : St) (P : Principal) (composed : Bool) {operand : Path}
    (S : St) (e : Entry operand) : Except Failure St :=
  if composed && isStructural base P e.path then .error ⟨e.path, busyCode e, syscall e⟩
  else if (cfg (owner base composed operand e.path).backend).readOnly then .error ⟨e.path, "EROFS", syscall e⟩
  else match backendError cfg base composed S e with
    | none => .ok (erase S (owner base composed operand e.path).backend (localPath base composed operand e.path))
    | some code =>
      let useUnread := ["ENOTEMPTY", "EISDIR", "ENOTDIR", "EEXIST"].contains code
      .error ⟨e.path, if useUnread then e.unread.getD code else code,
        if useUnread && e.unread.isSome then "scandir" else syscall e⟩

/-- The single policy-parameterized walk. In particular, a failed child prevents
    its parent's rmdir: there is no additional ancestor error or mount EBUSY. -/
def step (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (r : Result) (e : Entry operand) : Result :=
  if r.gone.contains e.path || r.kept.contains e.path then r
  else if e.vanished then
    gone operand e.path true strict
      (erase r.state (owner base composed operand e.path).backend (localPath base composed operand e.path) true) r
  else match attempt cfg base P composed r.state e with
    | .ok S' => gone operand e.path false strict S' r
    | .error f =>
      if f.code = "ENOENT" then
        gone operand e.path true strict
          (erase r.state (owner base composed operand e.path).backend (localPath base composed operand e.path) true) r
      else refused operand f r

def run (base : St) (P : Principal) (composed strict : Bool) (operand : Path)
    (entries : List (Entry operand)) : Result :=
  entries.foldl (step cfg base P composed strict) { state := applyVanished base composed operand entries }

/-! ## Contract and scope proofs -/

theorem kept_skips (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (r : Result) (e : Entry operand) (h : e.path ∈ r.kept) :
    step cfg base P composed strict r e = r := by
  simp [step, List.contains_iff_mem, h]

theorem ancestors_exact (operand q p : Path) :
    p ∈ ancestors operand q ↔ pfx operand p = true ∧ p <+: q := by
  simp only [ancestors, List.mem_filterMap]
  constructor
  · rintro ⟨i, hi, h⟩
    split at h
    · cases h
      exact ⟨by assumption, List.take_prefix _ _⟩
    · contradiction
  · rintro ⟨hp, hq⟩
    refine ⟨p.length, List.mem_range.mpr (Nat.lt_succ_of_le hq.length_le), ?_⟩
    rw [← List.prefix_iff_eq_take.mp hq]
    simp [hp]

/-- A refused child keeps every ancestor through the operand. Processing any of
    those directories is an identity step, including its failure list. -/
theorem child_failure_skips_ancestors (base : St) (P : Principal) (composed strict : Bool)
    {operand : Path} (r : Result) (f : Failure) (e : Entry operand)
    (hp : e.path <+: f.path) :
    step cfg base P composed strict (refused operand f r) e = refused operand f r := by
  apply kept_skips
  simp only [refused, keep, mem_mergePaths]
  exact Or.inr ((ancestors_exact _ _ _).mpr ⟨e.under, hp⟩)

theorem gone_kept_mono (operand q p : Path) (vanished strict : Bool) (S' : St)
    (r : Result) (hp : p ∈ r.kept) : p ∈ (gone operand q vanished strict S' r).kept := by
  cases vanished <;> cases strict <;> by_cases h : q = operand <;>
    simp [gone, keep, mem_mergePaths, h, hp]

theorem step_kept_mono (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (r : Result) (e : Entry operand) (p : Path) (hp : p ∈ r.kept) :
    p ∈ (step cfg base P composed strict r e).kept := by
  unfold step
  split
  · exact hp
  · split
    · exact gone_kept_mono _ _ _ _ _ _ _ hp
    · split
      · exact gone_kept_mono _ _ _ _ _ _ _ hp
      · split
        · exact gone_kept_mono _ _ _ _ _ _ _ hp
        · simp only [refused, keep, mem_mergePaths]
          exact Or.inl hp

theorem fold_kept_mono (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (entries : List (Entry operand)) (r : Result) (p : Path) (hp : p ∈ r.kept) :
    p ∈ (entries.foldl (step cfg base P composed strict) r).kept := by
  induction entries generalizing r with
  | nil => exact hp
  | cons e es ih => exact ih _ (step_kept_mono cfg base P composed strict r e p hp)

/-- Siblings processed between a child's refusal and its parent's postorder slot
    cannot undo the guard: the parent is still skipped, with no new failure line. -/
theorem failed_ancestor_skipped_after_siblings (base : St) (P : Principal) (composed strict : Bool)
    {operand : Path} (r : Result) (f : Failure) (entries : List (Entry operand))
    (parent : Entry operand) (hp : parent.path <+: f.path) :
    let after := entries.foldl (step cfg base P composed strict) (refused operand f r)
    step cfg base P composed strict after parent = after := by
  apply kept_skips
  apply fold_kept_mono
  simp only [refused, keep, mem_mergePaths]
  exact Or.inr ((ancestors_exact _ _ _).mpr ⟨parent.under, hp⟩)

theorem gone_failures (operand q : Path) (vanished strict : Bool) (S' : St) (r : Result) :
    (gone operand q vanished strict S' r).failures = r.failures := by
  cases vanished <;> cases strict <;> by_cases h : q = operand <;> simp [gone, keep, h]

theorem attempt_failure_path (base : St) (P : Principal) (composed : Bool) {operand : Path}
    (S : St) (e : Entry operand) (f : Failure) (h : attempt cfg base P composed S e = .error f) :
    f.path = e.path := by
  unfold attempt at h
  split at h
  · cases h; rfl
  · split at h
    · cases h; rfl
    · split at h
      · contradiction
      · cases h; rfl

/-- Failures are exact call refusals, not directory-retention notifications:
    each step adds either no failure or its one non-ENOENT removal failure. -/
theorem step_failures_exact (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (r : Result) (e : Entry operand) :
    (step cfg base P composed strict r e).failures = r.failures ∨
    ∃ f, (step cfg base P composed strict r e).failures = r.failures ++ [f] ∧
      attempt cfg base P composed r.state e = .error f ∧ f.code ≠ "ENOENT" ∧ f.path = e.path := by
  unfold step
  split
  · exact Or.inl rfl
  · split
    · exact Or.inl (gone_failures _ _ _ _ _ _)
    · split
      · exact Or.inl (gone_failures _ _ _ _ _ _)
      · rename_i f hf
        split
        · exact Or.inl (gone_failures _ _ _ _ _ _)
        · rename_i hne
          exact Or.inr ⟨f, rfl, hf, hne, attempt_failure_path cfg base P composed r.state e f hf⟩

/-- Strict ENOENT retains ancestors but never the vanished child and never adds a
    refusal: rm -r prints its vanished list, while API/Node/rm -rf count it gone. -/
theorem vanished_policy (operand q : Path) (S' : St) (r : Result) :
    (gone operand q true false S' r).kept = r.kept ∧
    (gone operand q true false S' r).failures = r.failures ∧
    (gone operand q true true S' r).failures = r.failures ∧
    (q ≠ operand → ∀ p, pfx operand p = true → p <+: q.dropLast →
      p ∈ (gone operand q true true S' r).kept) := by
  refine ⟨by simp [gone], by simp [gone], ?_, ?_⟩
  · by_cases h : q = operand <;> simp [gone, keep, h]
  · intro hq p hp hpar
    have hne : (q != operand) = true := by simpa using hq
    simp only [gone, hne, Bool.and_self, ite_true, keep, mem_mergePaths]
    exact Or.inr ((ancestors_exact _ _ _).mpr ⟨hp, hpar⟩)

theorem lstat_failure_unlinks (S : St) (P : Principal) (composed : Bool)
    (operand q : Path) (hq : pfx operand q = true) (n : Nat) (code : String)
    (h : fault (cfg (owner S composed operand q).backend).faults.stat
      (localPath S composed operand q) = some code) (hne : code ≠ "ENOENT") :
    discover cfg S P composed operand (n + 1) q hq false =
      .ok [⟨q, hq, false, false, none⟩] := by
  simp [discover, discoverFrom, h, hne]

theorem unreadable_still_rmdir (S : St) (P : Principal) (composed : Bool)
    (operand q : Path) (hq : pfx operand q = true) (n : Nat) (code : String)
    (hs : fault (cfg (owner S composed operand q).backend).faults.stat
      (localPath S composed operand q) = none)
    (hd : observed S P composed operand q = some .dir)
    (hr : fault (cfg (owner S composed operand q).backend).faults.readdir
      (localPath S composed operand q) = some code) (hne : code ≠ "ENOENT") :
    discover cfg S P composed operand (n + 1) q hq false =
      .ok [⟨q, hq, true, false, some code⟩] := by
  simp [discover, discoverFrom, applyVanished, hs, hd, hr, hne]

/-- An unreadable directory's failed scandir is not itself a refusal. When its
    rmdir succeeds (notably an empty unreadable directory), no error is emitted. -/
theorem unreadable_empty_removed (base : St) (P : Principal) (composed : Bool)
    {operand : Path} (S : St) (e : Entry operand)
    (hd : e.dir = true) (hs : (composed && isStructural base P e.path) = false)
    (hro : (cfg (owner base composed operand e.path).backend).readOnly = false)
    (hf : fault (cfg (owner base composed operand e.path).backend).faults.remove
      (localPath base composed operand e.path) = none)
    (hp : (cfg (owner base composed operand e.path).backend).pins.contains
      (localPath base composed operand e.path) = false)
    (he : look (S.trees (owner base composed operand e.path).backend)
      (localPath base composed operand e.path) = some .dir)
    (hc : children (S.trees (owner base composed operand e.path).backend)
      (localPath base composed operand e.path) = []) :
    attempt cfg base P composed S e = .ok
      (erase S (owner base composed operand e.path).backend (localPath base composed operand e.path)) := by
  have hp' : localPath base composed operand e.path ∉ (cfg (owner base composed operand e.path).backend).pins := by
    simpa using hp
  simp [attempt, backendError, hd, hs, hro, hf, hp', he, hc]

theorem readonly_child_refused (base : St) (P : Principal) (composed : Bool)
    {operand : Path} (S : St) (e : Entry operand)
    (hs : (composed && isStructural base P e.path) = false)
    (hro : (cfg (owner base composed operand e.path).backend).readOnly = true) :
    attempt cfg base P composed S e = .error ⟨e.path, "EROFS", syscall e⟩ := by
  simp [attempt, hs, hro]

/-- This is an attempted mount rmdir, not a whole-call refusal: step invokes it
    only after the kept-child guard passed. Even an empty read-only mount is busy. -/
theorem mount_rmdir_busy (base : St) (P : Principal) {operand : Path}
    (S : St) (e : Entry operand) (hd : e.dir = true)
    (hs : isStructural base P e.path = true) :
    attempt cfg base P true S e = .error ⟨e.path, "EBUSY", "rmdir"⟩ := by
  simp [attempt, hs, hd, busyCode, syscall]

theorem erase_mounts (S : St) (b : Backend) (rp : Path) (vanished : Bool) :
    (erase S b rp vanished).mounts = S.mounts := rfl

theorem erase_other (S : St) (b c : Backend) (rp : Path) (vanished : Bool) (h : c ≠ b) :
    (erase S b rp vanished).trees c = S.trees c := by
  simp [erase, setTree, h]

/-- Successful local removals are exact: the named entry is absent and every
    other row in that backend is unchanged. Hidden rows are not deleted just
    because the walk removed a visible name on a different backend. -/
theorem erase_exact (S : St) (b : Backend) (rp : Path) :
    (∀ x ∈ (erase S b rp false).trees b, x.1 ≠ rp) ∧
    (∀ x, x.1 ≠ rp → (x ∈ (erase S b rp false).trees b ↔ x ∈ S.trees b)) := by
  constructor
  · intro x hx
    have hx' : x ∈ (S.trees b).filter (·.1 != rp) := by simpa [erase, setTree] using hx
    simpa using (List.mem_filter.mp hx').2
  · intro x hx
    simp [erase, setTree, hx]

theorem attempt_frame (base : St) (P : Principal) (composed : Bool) {operand : Path}
    (S S' : St) (e : Entry operand) (h : attempt cfg base P composed S e = .ok S') :
    S'.mounts = S.mounts ∧ ∀ c, c ≠ (owner base composed operand e.path).backend → S'.trees c = S.trees c := by
  unfold attempt at h
  split at h
  · contradiction
  · split at h
    · contradiction
    · split at h
      · cases h
        exact ⟨rfl, fun c hc => erase_other _ _ _ _ _ hc⟩
      · contradiction

theorem step_frame (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (r : Result) (e : Entry operand) :
    (step cfg base P composed strict r e).state.mounts = r.state.mounts ∧
    ∀ c, c ≠ (owner base composed operand e.path).backend →
      (step cfg base P composed strict r e).state.trees c = r.state.trees c := by
  unfold step
  split
  · exact ⟨rfl, fun _ _ => rfl⟩
  · split
    · simp only [gone]
      split <;> exact ⟨rfl, fun _ h => erase_other _ _ _ _ _ h⟩
    · split
      · rename_i S' h
        obtain ⟨hm, ht⟩ := attempt_frame cfg base P composed r.state S' e h
        simpa [gone] using And.intro hm ht
      · split
        · simp only [gone]
          split <;> exact ⟨rfl, fun _ h => erase_other _ _ _ _ _ h⟩
        · exact ⟨rfl, fun _ _ => rfl⟩

theorem fold_frame (base : St) (P : Principal) (composed strict : Bool) {operand : Path}
    (entries : List (Entry operand)) (r : Result) (c : Backend)
    (hc : ∀ e ∈ entries, c ≠ (owner base composed operand e.path).backend) :
    (entries.foldl (step cfg base P composed strict) r).state.mounts = r.state.mounts ∧
    (entries.foldl (step cfg base P composed strict) r).state.trees c = r.state.trees c := by
  induction entries generalizing r with
  | nil => exact ⟨rfl, rfl⟩
  | cons e es ih =>
    obtain ⟨hm, ht⟩ := step_frame cfg base P composed strict r e
    obtain ⟨hm', ht'⟩ := ih (step cfg base P composed strict r e)
      (fun e' he' => hc e' (List.mem_cons_of_mem _ he'))
    exact ⟨hm'.trans hm, ht'.trans (ht c (hc e (List.mem_cons_self _ _)))⟩

theorem vanished_fold_frame (base : St) (composed : Bool) (operand : Path)
    (entries : List (Entry operand)) (S : St) (c : Backend)
    (hc : ∀ e ∈ entries, c ≠ (owner base composed operand e.path).backend) :
    let after := entries.foldl (fun S e => if e.vanished then
      erase S (owner base composed operand e.path).backend (localPath base composed operand e.path) true else S) S
    after.mounts = S.mounts ∧ after.trees c = S.trees c := by
  induction entries generalizing S with
  | nil => exact ⟨rfl, rfl⟩
  | cons e es ih =>
    simp only [List.foldl_cons]
    split
    · obtain ⟨hm, ht⟩ := ih (erase S (owner base composed operand e.path).backend
        (localPath base composed operand e.path) true) (fun e' he' => hc e' (List.mem_cons_of_mem _ he'))
      exact ⟨hm, ht.trans (erase_other _ _ _ _ _ (hc e (List.mem_cons_self _ _)))⟩
    · exact ih S (fun e' he' => hc e' (List.mem_cons_of_mem _ he'))

/-- The write frame covers both discovery-time races and later removal calls. -/
theorem run_frame (base : St) (P : Principal) (composed strict : Bool) (operand : Path)
    (entries : List (Entry operand)) (c : Backend)
    (hc : ∀ e ∈ entries, c ≠ (owner base composed operand e.path).backend) :
    (run cfg base P composed strict operand entries).state.mounts = base.mounts ∧
    (run cfg base P composed strict operand entries).state.trees c = base.trees c := by
  obtain ⟨hm, ht⟩ := fold_frame cfg base P composed strict entries
    { state := applyVanished base composed operand entries } c hc
  obtain ⟨hm', ht'⟩ := vanished_fold_frame base composed operand entries base c hc
  exact ⟨hm.trans hm', ht.trans ht'⟩

/-- Crossing a mount expands the write frame precisely to routed descendants of
    the operand; every other backend and the entire mount table are unchanged. -/
theorem walk_subtree_frame (base : St) (P : Principal) (composed strict : Bool)
    (operand : Path) (entries : List (Entry operand)) (c : Backend)
    (hc : c ≠ (route base.mounts operand).backend)
    (hsub : ∀ q, pfx operand q = true → c ≠ (route base.mounts q).backend) :
    (run cfg base P composed strict operand entries).state.mounts = base.mounts ∧
    (run cfg base P composed strict operand entries).state.trees c = base.trees c := by
  apply run_frame
  intro e _
  cases composed with
  | false => exact hc
  | true => exact hsub e.path e.under

/-- Without a crossing walk the old single-backend frame still holds. -/
theorem walk_single_mount (base : St) (P : Principal) (strict : Bool)
    (operand : Path) (entries : List (Entry operand)) (c : Backend)
    (hc : c ≠ (route base.mounts operand).backend) :
    (run cfg base P false strict operand entries).state.mounts = base.mounts ∧
    (run cfg base P false strict operand entries).state.trees c = base.trees c := by
  apply run_frame
  exact fun _ _ => hc

end Nimbus.Vfs.CompositeRemoval
