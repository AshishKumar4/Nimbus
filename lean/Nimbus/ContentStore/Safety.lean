/-
  Nimbus.ContentStore.Safety — the invariant holds in every reachable state,
  so at every transaction boundary and after a DO reset at any of them; and
  what that means for readers.
-/

import Nimbus.ContentStore.Steps

namespace Nimbus.ContentStore

variable (P : Nat)

theorem init_inv : Inv P init := by
  refine ⟨⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩, ?_, ?_⟩
  all_goals first
    | (intro x hx; cases x <;> simp [Exists, init] at hx; done)
    | (intros; rfl)
    | (intro j hj; simp [init] at hj)
    | (intros; simp_all [init, readRef, atRef]; try contradiction)

/-- Every transaction, and a reset, keeps the invariant. -/
theorem step_inv {s s' : St} (hi : Inv P s) (h : Step P s s') : Inv P s' := by
  cases h with
  | writeSmall p h k _ hk => exact writeSmall_inv P hi hk
  | beginLarge p _ => exact beginLarge_inv P hi p
  | appendLarge w ct h k hw hc hst hk => exact appendLarge_inv P hi hw hc hst hk
  | publishNew w ct hw hc hst => exact publishNew_inv P hi hw hc hst
  | publishDedup w ct c2 ct2 hw hc _ hc2 hl2 hd2 => exact publishDedup_inv P hi hw hc hc2 hl2 hd2
  | delete p _ => exact delete_inv P hi p
  | copy src dst r _ hr => exact copy_inv P hi hr
  | rename src dst r _ hne hr => exact rename_inv P hi hne hr
  | editSmallInPlace p r k h hl hr hg ho hm hh hf _ => exact editSmallInPlace_inv P hi hl hr hg ho hm hh hf
  | editSmallCow p r k0 h k _ _ hk => exact editSmallCow_inv P hi hk
  | editLargeInPlace p r c ct i h k hl hr hg hc _ hi' ho hh hf hk =>
    exact editLargeInPlace_inv P hi hl hr hg hc hi' ho hh hf hk
  | editLargeCow p r c ct i h k hl hr hc hlv hi' hk => exact editLargeCow_inv P hi hl hr hc hi' hk
  | memoDigest c ct d hc _ _ hm _ => exact memoDigest_inv P hi hc hm
  | snapshot n hn => exact snapshot_inv P hi hn
  | dropSnapshot n hj => exact dropSnapshot_inv P hi hj
  | dropHist h hh hn => exact dropHist_inv P hi hh hn
  | restoreStart n g _ hs => exact restoreStart_inv P hi hs
  | restoreSkip j r hj hc hl hg => exact restoreSkip_inv P hi hj hc hl hg
  | restoreStep j hj hc _ => exact restoreStep_inv P hi hj hc
  | restoreFinish j _ _ => exact restoreFinish_inv P hi
  | detach p r _ hl => exact detach_inv P hi hl
  | close f _ => exact close_inv P hi f
  | gcChunkDelete k _ _ hn hf => exact gcChunkDelete_inv P hi hn hf
  | gcChunkSkip k _ h => exact gcChunkSkip_inv P hi h
  | gcContentStart c ct _ hc _ hn hf hw => exact gcContentStart_inv P hi hc hn hf hw
  | gcContentPage c ct k rest _ hc hd hch => exact gcContentPage_inv P hi hc hd hch
  | gcContentFinish c ct _ hc hd hch => exact gcContentFinish_inv P hi hc hd hch
  | gcContentSkip c _ h => exact gcContentSkip_inv P hi h
  | reset => exact reset_inv P hi

theorem reachable_inv {s : St} (h : Reachable P s) : Inv P s := by
  induction h with
  | init => exact init_inv P
  | step _ hs ih => exact step_inv P ih hs

/-! ## What readers are promised -/

/-- No chunk or content a live path reads is ever collected or rewritten under
    it: every path reads exactly what was last written to it, in every state
    reachable through any interleaving of writes, snapshots, restores, drops,
    GC pages and DO resets. -/
theorem live_reads_last_write {s : St} (h : Reachable P s) (p : Path) :
    readRef s ((s.live p).map Row.ref) = some (s.view p) :=
  (reachable_inv P h).liveView p

/-- A snapshot reads what the tree held when it was taken. -/
theorem snapshot_reads_its_tree {s : St} (h : Reachable P s) {n g : Nat} (hs : (n, g) ∈ s.snaps) (p : Path) :
    readRef s (atRef s g p) = some (s.snapView n p) :=
  (reachable_inv P h).snapView (n, g) hs p

/-- And what it reads never changes while it exists. -/
theorem snapshot_view_fixed {s s' : St} (h : Step P s s') {x : Nat × Nat} (hx : x ∈ s.snaps)
    (hx' : x ∈ s'.snaps) : s'.snapView x.1 = s.snapView x.1 := by
  cases h with
  | snapshot n hn =>
    show upd s.snapView n s.view x.1 = s.snapView x.1
    rw [upd_ne _ _ (hn x hx)]
  | _ => simp [retire]

/-- A detached descriptor keeps reading what it read when it was unlinked. -/
theorem descriptor_reads_what_it_opened {s : St} (h : Reachable P s) {f : Fd} (hf : f ∈ s.fds) :
    resolve s f.ref = some f.view :=
  (reachable_inv P h).fdView f hf

/-- A restore that ran to its end with no other write in between leaves every
    path reading exactly what the snapshot reads — crashes and resumptions
    included, since the job row and its cursor are durable. -/
theorem restore_yields_the_snapshot {s : St} (h : Reachable P s) {j : Job} (hj : s.job = some j)
    (hclean : j.clean = true) (hdone : j.cursor = P) (p : Path) (hp : p < P) :
    readRef s ((s.live p).map Row.ref) = some (s.snapView j.name p) := by
  have hi := reachable_inv P h
  obtain ⟨_, _, hc⟩ := hi.jobOk j hj
  rw [← hc hclean p (by rw [hdone]; exact hp)]
  exact hi.liveView p

end Nimbus.ContentStore
