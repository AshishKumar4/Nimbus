/-
  Nimbus.ContentStore.Tier — content-store P6 (work/content-store): a chunk that
  only history references may go cold (its bytes uploaded, `data = ''`,
  `state = 1`). `tier` checks its predicate, awaits the upload, then in one
  transaction re-probes the predicate and marks the chunk cold. A write holding a
  chunk's bytes revives it; a write naming a chunk without its bytes (dedup hit,
  import, copyTree) needs it local; `restore` pre-checks that no chunk it will
  install is cold, and so does a restore resumed after a reset.

  Invariant (`live_never_cold`): no live path ever references a cold chunk, under
  any interleaving of writes, links, unlinks, snapshots, tier passes, restore
  pages and resets. Two rules carry it, and dropping either breaks it
  (`tier_without_reprobe_colds_a_live_chunk`,
  `resume_without_precheck_installs_a_cold_chunk`).

  Abstractions: a file is one chunk; "referenced only by history" is "no live
  path references it" (staging, open descriptors and hot snapshots are further
  exclusions the code adds; they only make tier rarer). One snapshot is the
  restore source. Restore is synchronous (as ContentStoreBuild states), so no
  tier step runs while a restore is mid-run in this isolate: `Quiet`. A reset
  abandons any upload in flight and leaves an unfinished restore needing a
  resume.
-/

namespace Nimbus.ContentStore.Tier

abbrev Path := Nat
abbrev Chunk := Nat

structure Job where
  remaining : List Path
  /-- Running in this isolate after its pre-check (false after a reset). -/
  checked : Bool

structure St where
  live : Path → Option Chunk
  snap : Path → Option Chunk
  cold : Chunk → Bool
  pending : Option Chunk
  job : Option Job

def upd {β : Type} (f : Nat → β) (x : Nat) (b : β) : Nat → β := fun y => if y = x then b else f y

/-- No restore is mid-run in this isolate. -/
def Quiet (s : St) : Prop := ∀ j, s.job = some j → j.checked = false

/-- The rules under test: re-probe before marking cold; pre-check on resume. -/
structure Rules where
  reprobe : Bool
  resumeCheck : Bool

def NoneCold (s : St) (ps : List Path) : Prop := ∀ p ∈ ps, ∀ c, s.snap p = some c → s.cold c = false

inductive Step (R : Rules) : St → St → Prop
  /-- A write holding the bytes: the chunk is local again. -/
  | write (s : St) (p c : Nat) :
      Step R s { s with live := upd s.live p (some c), cold := upd s.cold c false }
  /-- A write naming a chunk without its bytes: refused (want / EIO) when cold. -/
  | link (s : St) (p c : Nat) : s.cold c = false → Step R s { s with live := upd s.live p (some c) }
  | unlink (s : St) (p : Nat) : Step R s { s with live := upd s.live p none }
  | capture (s : St) : s.job = none → Step R s { s with snap := s.live }
  | tierBegin (s : St) (c : Nat) : s.pending = none → (∀ p, s.live p ≠ some c) → Quiet s →
      Step R s { s with pending := some c }
  | tierCommit (s : St) (c : Nat) : s.pending = some c → (R.reprobe = true → ∀ p, s.live p ≠ some c) →
      Quiet s → Step R s { s with cold := upd s.cold c true, pending := none }
  | restoreStart (s : St) (ps : List Path) : s.job = none → NoneCold s ps →
      Step R s { s with job := some ⟨ps, true⟩ }
  | restoreResume (s : St) (j : Job) : s.job = some j → j.checked = false →
      (R.resumeCheck = true → NoneCold s j.remaining) → Step R s { s with job := some ⟨j.remaining, true⟩ }
  | restorePage (s : St) (j : Job) (p : Path) (rest : List Path) : s.job = some j → j.checked = true →
      j.remaining = p :: rest → Step R s { s with live := upd s.live p (s.snap p), job := some ⟨rest, true⟩ }
  | restoreFinish (s : St) (j : Job) : s.job = some j → j.remaining = [] → Step R s { s with job := none }
  | reset (s : St) : Step R s { s with pending := none, job := s.job.map fun j => ⟨j.remaining, false⟩ }

def init : St :=
  { live := fun _ => none, snap := fun _ => none, cold := fun _ => false, pending := none, job := none }

inductive Reachable (R : Rules) : St → Prop
  | init : Reachable R init
  | step {s s' : St} : Reachable R s → Step R s s' → Reachable R s'

def built : Rules := ⟨true, true⟩

structure Inv (s : St) : Prop where
  liveWarm : ∀ p c, s.live p = some c → s.cold c = false
  jobWarm : ∀ j, s.job = some j → j.checked = true → NoneCold s j.remaining

theorem step_inv {s s' : St} (hi : Inv s) (h : Step built s s') : Inv s' := by
  cases h with
  | write p c =>
    refine ⟨fun q c' hq => ?_, fun j hj hc q hq c' hs => ?_⟩
    · simp only [upd] at hq ⊢
      split at hq
      · injection hq with hq; subst hq; simp
      · split
        · rfl
        · exact hi.liveWarm q c' hq
    · simp only [upd]
      split
      · rfl
      · exact hi.jobWarm j hj hc q hq c' hs
  | link p c hc =>
    refine ⟨fun q c' hq => ?_, hi.jobWarm⟩
    simp only [upd] at hq
    split at hq
    · injection hq with hq; subst hq; exact hc
    · exact hi.liveWarm q c' hq
  | unlink p =>
    refine ⟨fun q c' hq => ?_, hi.jobWarm⟩
    simp only [upd] at hq
    split at hq
    · cases hq
    · exact hi.liveWarm q c' hq
  | capture hj =>
    refine ⟨hi.liveWarm, fun j h => ?_⟩
    simp [hj] at h
  | tierBegin c _ _ _ => exact ⟨hi.liveWarm, hi.jobWarm⟩
  | tierCommit c _ hprobe hq =>
    have hp := hprobe rfl
    refine ⟨fun q c' h => ?_, fun j hj hc => ?_⟩
    · simp only [upd]
      split
      · rename_i e; subst e; exact absurd h (hp q)
      · exact hi.liveWarm q c' h
    · rw [hq j hj] at hc; cases hc
  | restoreStart ps _ hn =>
    refine ⟨hi.liveWarm, fun j hj _ => ?_⟩
    simp only [Option.some.injEq] at hj; subst hj; exact hn
  | restoreResume j _ _ hchk =>
    refine ⟨hi.liveWarm, fun j' hj _ => ?_⟩
    simp only [Option.some.injEq] at hj; subst hj; exact hchk rfl
  | restorePage j p rest hj hc hr =>
    have hw := hi.jobWarm j hj hc
    rw [hr] at hw
    refine ⟨fun q c' hq => ?_, fun j' hj' _ => ?_⟩
    · simp only [upd] at hq
      split at hq
      · rename_i e; subst e; exact hw q (List.mem_cons_self _ _) c' hq
      · exact hi.liveWarm q c' hq
    · simp only [Option.some.injEq] at hj'; subst hj'
      exact fun q hq c' hs => hw q (List.mem_cons_of_mem _ hq) c' hs
  | restoreFinish j _ _ =>
    refine ⟨hi.liveWarm, fun j' h => ?_⟩
    cases h
  | reset =>
    refine ⟨hi.liveWarm, fun j hj hc => ?_⟩
    cases h : s.job with
    | none => simp [h] at hj
    | some j0 =>
      simp only [h, Option.map_some', Option.some.injEq] at hj
      subst hj; cases hc

theorem reachable_inv {s : St} (h : Reachable built s) : Inv s := by
  induction h with
  | init => exact ⟨(fun _ _ h => by cases h), (fun _ h => by cases h)⟩
  | step _ hs ih => exact step_inv ih hs

/-- Every live path's chunk is local: a synchronous read never meets ENODATA. -/
theorem live_never_cold {s : St} (h : Reachable built s) {p : Path} {c : Chunk} (hl : s.live p = some c) :
    s.cold c = false :=
  (reachable_inv h).liveWarm p c hl

/-! ## Each rule is needed -/

/-- Without the re-probe: a dedup write links the chunk during the upload's await,
    and the commit marks a live chunk cold. -/
theorem tier_without_reprobe_colds_a_live_chunk :
    ∃ s, Reachable ⟨false, true⟩ s ∧ s.live 0 = some 5 ∧ s.cold 5 = true := by
  let R : Rules := ⟨false, true⟩
  have h1 : Reachable R { init with pending := some 5 } :=
    .step .init (.tierBegin init 5 rfl (fun _ h => by cases h) (fun _ h => by cases h))
  let s1 : St := { init with pending := some 5 }
  have h2 : Reachable R { s1 with live := upd s1.live 0 (some 5) } := .step h1 (.link s1 0 5 rfl)
  let s2 : St := { s1 with live := upd s1.live 0 (some 5) }
  have h3 := Reachable.step h2 (.tierCommit s2 5 rfl (fun h => by cases h) (fun _ h => by cases h))
  exact ⟨_, h3, by simp [s2, s1, upd], by simp [upd]⟩

/-- Without the resume pre-check: a restore interrupted by a reset, a full tier
    pass over the chunk only the snapshot references, and the resumed restore
    installs the cold chunk. -/
theorem resume_without_precheck_installs_a_cold_chunk :
    ∃ s, Reachable ⟨true, false⟩ s ∧ s.live 0 = some 5 ∧ s.cold 5 = true := by
  let R : Rules := ⟨true, false⟩
  let s1 : St := { init with live := upd init.live 0 (some 5), cold := upd init.cold 5 false }
  have h1 : Reachable R s1 := .step .init (.write init 0 5)
  let s2 : St := { s1 with snap := s1.live }
  have h2 : Reachable R s2 := .step h1 (.capture s1 rfl)
  let s3 : St := { s2 with live := upd s2.live 0 none }
  have h3 : Reachable R s3 := .step h2 (.unlink s2 0)
  let s4 : St := { s3 with job := some ⟨[0], true⟩ }
  have h4 : Reachable R s4 := .step h3 (.restoreStart s3 [0] rfl (by
    intro p hp c _; simp [s3, s2, s1, upd, init]))
  let s5 : St := { s4 with pending := none, job := s4.job.map fun j => ⟨j.remaining, false⟩ }
  have h5 : Reachable R s5 := .step h4 (.reset s4)
  have hq5 : Quiet s5 := fun j hj => by simp [s5, s4] at hj; subst hj; rfl
  have hnl5 : ∀ p, s5.live p ≠ some 5 := by
    intro p
    show upd (upd init.live 0 (some 5)) 0 none p ≠ some 5
    unfold upd; by_cases e : p = 0 <;> simp [e, init]
  let s6 : St := { s5 with pending := some 5 }
  have h6 : Reachable R s6 := .step h5 (.tierBegin s5 5 rfl hnl5 hq5)
  let s7 : St := { s6 with cold := upd s6.cold 5 true, pending := none }
  have h7 : Reachable R s7 := .step h6 (.tierCommit s6 5 rfl (fun _ => hnl5) hq5)
  let s8 : St := { s7 with job := some ⟨[0], true⟩ }
  have h8 : Reachable R s8 := .step h7 (.restoreResume s7 ⟨[0], false⟩ (by simp [s7, s6, s5, s4]) rfl
    (fun h => by cases h))
  have h9 := Reachable.step h8 (.restorePage s8 ⟨[0], true⟩ 0 [] rfl rfl rfl)
  exact ⟨_, h9, by simp [s8, s7, s6, s5, s4, s3, s2, s1, upd], by simp [s8, s7, upd]⟩

end Nimbus.ContentStore.Tier
