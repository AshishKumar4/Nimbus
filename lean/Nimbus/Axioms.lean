/-
  Nimbus.Axioms — axiom audit for every published theorem. 0 sorry.

  `#print axioms <thm>` reports at compile time exactly which axioms a proof
  depends on. Expected output for EVERY theorem below: either
  "does not depend on any axioms" or a subset of Lean's three built-in kernel
  axioms [propext, Classical.choice, Quot.sound] — never the proof-placeholder
  axiom, never `Lean.ofReduceBool`/`Lean.trustCompiler`, never a domain axiom.
  `check-traceability.mjs` consumes this file's output; every theorem must be
  enrolled here.
-/

import Nimbus
import Nimbus.Refine

/-! ## Nimbus/Coherence/ContentKey.lean -/

#print axioms Nimbus.Coherence.ContentKey.bytesAt_eq
#print axioms Nimbus.Coherence.ContentKey.lastRev_fold
#print axioms Nimbus.Coherence.ContentKey.lastRev_spec
#print axioms Nimbus.Coherence.ContentKey.le_lastRev
#print axioms Nimbus.Coherence.ContentKey.acqRow_some
#print axioms Nimbus.Coherence.ContentKey.noMut_extend
#print axioms Nimbus.Coherence.ContentKey.noMut_append
#print axioms Nimbus.Coherence.ContentKey.bytesAt_append
#print axioms Nimbus.Coherence.ContentKey.step_inv
#print axioms Nimbus.Coherence.ContentKey.reachable_inv
#print axioms Nimbus.Coherence.ContentKey.no_stale_read
#print axioms Nimbus.Coherence.ContentKey.a_colliding_key_keeps_a_stale_row

/-! ## Nimbus/Coherence/ContentKeyAsync.lean -/

#print axioms Nimbus.Coherence.ContentKeyAsync.lastRev_append
#print axioms Nimbus.Coherence.ContentKeyAsync.entryOf_spec
#print axioms Nimbus.Coherence.ContentKeyAsync.entryOf_none
#print axioms Nimbus.Coherence.ContentKeyAsync.answer_append
#print axioms Nimbus.Coherence.ContentKeyAsync.step_inv
#print axioms Nimbus.Coherence.ContentKeyAsync.reachable_inv
#print axioms Nimbus.Coherence.ContentKeyAsync.no_stale_read

/-! ## Nimbus/Coherence/DurableDelta.lean -/

#print axioms Nimbus.Coherence.DurableDelta.init_inv
#print axioms Nimbus.Coherence.DurableDelta.step_inv
#print axioms Nimbus.Coherence.DurableDelta.reachable_inv
#print axioms Nimbus.Coherence.DurableDelta.sql_delta_exact
#print axioms Nimbus.Coherence.DurableDelta.a_pruned_tombstone_hides_a_delete

/-! ## Nimbus/Coherence/Namespace.lean -/

#print axioms Nimbus.Coherence.Namespace.closed_above
#print axioms Nimbus.Coherence.Namespace.nothing_below
#print axioms Nimbus.Coherence.Namespace.applyEntry_self
#print axioms Nimbus.Coherence.Namespace.applyEntry_other
#print axioms Nimbus.Coherence.Namespace.apply_exact
#print axioms Nimbus.Coherence.Namespace.a_log_naming_only_the_removed_root_leaves_a_ghost

/-! ## Nimbus/Coherence/Refetch.lean -/

#print axioms Nimbus.Coherence.Refetch.new_settles
#print axioms Nimbus.Coherence.Refetch.old_never_settles
#print axioms Nimbus.Coherence.Refetch.livelock_before_eb542b0b
#print axioms Nimbus.Coherence.Refetch.settles_after_eb542b0b

/-! ## Nimbus/Coherence/Relist.lean -/

#print axioms Nimbus.Coherence.Relist.tv_below_none
#print axioms Nimbus.Coherence.Relist.relist_exact
#print axioms Nimbus.Coherence.Relist.overlay_exact

/-! ## Nimbus/Coherence/StoreBugs.lean -/

#print axioms Nimbus.Coherence.Store.no_stale_read
#print axioms Nimbus.Coherence.Store.admitted_below_horizon
#print axioms Nimbus.Coherence.Store.below_floor_poisons
#print axioms Nimbus.Coherence.Store.delta_complete
#print axioms Nimbus.Coherence.Store.fetched_exists
#print axioms Nimbus.Coherence.Store.valAt_two
#print axioms Nimbus.Coherence.Store.valAt_one
#print axioms Nimbus.Coherence.Store.valAt_five
#print axioms Nimbus.Coherence.Store.an_empty_log_without_a_floor_serves_a_stale_row
#print axioms Nimbus.Coherence.Store.a_read_installed_past_a_report_is_stale
#print axioms Nimbus.Coherence.Store.a_listing_below_the_last_commit_keeps_a_stale_row
#print axioms Nimbus.Coherence.Store.a_push_admitted_out_of_order_is_stale
#print axioms Nimbus.Coherence.Store.own_committed_write_is_served_past_a_peer
#print axioms Nimbus.Coherence.Store.own_fresh_when_acks_settled
#print axioms Nimbus.Coherence.Store.overlay_no_stale
#print axioms Nimbus.Coherence.Store.a_per_answer_wait_misses_an_earlier_report

/-! ## Nimbus/Coherence/StoreSafety.lean -/

#print axioms Nimbus.Coherence.Store.valAt_fold
#print axioms Nimbus.Coherence.Store.valAt_spec
#print axioms Nimbus.Coherence.Store.noMut_valAt
#print axioms Nimbus.Coherence.Store.noMut_mono
#print axioms Nimbus.Coherence.Store.noMut_append
#print axioms Nimbus.Coherence.Store.noMut_join
#print axioms Nimbus.Coherence.Store.valAt_append_le
#print axioms Nimbus.Coherence.Store.repOf_ge
#print axioms Nimbus.Coherence.Store.deltaFrom_covers
#print axioms Nimbus.Coherence.Store.deltaFrom_last
#print axioms Nimbus.Coherence.Store.init_inv
#print axioms Nimbus.Coherence.Store.fresh_ext
#print axioms Nimbus.Coherence.Store.commit_inv

/-! ## Nimbus/Coherence/StoreSteps.lean -/

#print axioms Nimbus.Coherence.Store.repOf_fold
#print axioms Nimbus.Coherence.Store.repOf_mem
#print axioms Nimbus.Coherence.Store.mem_map_eq
#print axioms Nimbus.Coherence.Store.covered
#print axioms Nimbus.Coherence.Store.admit_rows
#print axioms Nimbus.Coherence.Store.admit_inv
#print axioms Nimbus.Coherence.Store.admitDelta_inv
#print axioms Nimbus.Coherence.Store.admitMono_inv
#print axioms Nimbus.Coherence.Store.admitPush_inv
#print axioms Nimbus.Coherence.Store.flush_rows
#print axioms Nimbus.Coherence.Store.step_inv
#print axioms Nimbus.Coherence.Store.reachable_inv

/-! ## Nimbus/Coherence/Visibility.lean -/

#print axioms Nimbus.Coherence.Visibility.a_chmod_then_remove_hides_a_listed_path

/-! ## Nimbus/Coherence/VisibleDelta.lean -/

#print axioms Nimbus.Coherence.VisibleDelta.nva_spec
#print axioms Nimbus.Coherence.VisibleDelta.visible_root
#print axioms Nimbus.Coherence.VisibleDelta.no_leak
#print axioms Nimbus.Coherence.VisibleDelta.entry_evicts
#print axioms Nimbus.Coherence.VisibleDelta.coherence
#print axioms Nimbus.Coherence.VisibleDelta.chmod_revokes_rows_below
#print axioms Nimbus.Coherence.VisibleDelta.report_answers
#print axioms Nimbus.Coherence.VisibleDelta.no_leak_any
#print axioms Nimbus.Coherence.VisibleDelta.entry_evicts_any
#print axioms Nimbus.Coherence.VisibleDelta.coherence_any

/-! ## Nimbus/ContentStore/Bugs.lean -/

#print axioms Nimbus.ContentStore.Bugs.pinned_reachable
#print axioms Nimbus.ContentStore.Bugs.an_in_place_rewrite_blind_to_pins_changes_a_descriptor
#print axioms Nimbus.ContentStore.Bugs.snapped_reachable
#print axioms Nimbus.ContentStore.Bugs.an_in_place_rewrite_a_snapshot_can_see_changes_the_snapshot
#print axioms Nimbus.ContentStore.Bugs.lone_reachable
#print axioms Nimbus.ContentStore.Bugs.dropping_a_pinned_queue_row_leaks

/-! ## Nimbus/ContentStore/Frames.lean -/

#print axioms Nimbus.ContentStore.base_ext
#print axioms Nimbus.ContentStore.resolve_upd_chunk
#print axioms Nimbus.ContentStore.readRef_upd_chunk
#print axioms Nimbus.ContentStore.resolve_upd_content
#print axioms Nimbus.ContentStore.readRef_upd_content
#print axioms Nimbus.ContentStore.atRef_mem_gen
#print axioms Nimbus.ContentStore.atRef_of_live_le
#print axioms Nimbus.ContentStore.find_erase_of_false
#print axioms Nimbus.ContentStore.mem_replaceWriter
#print axioms Nimbus.ContentStore.mem_stagingIds
#print axioms Nimbus.ContentStore.requeue_inv
#print axioms Nimbus.ContentStore.not_dying_of_resolves
#print axioms Nimbus.ContentStore.nodup_append_single
#print axioms Nimbus.ContentStore.nodup_map_of_inj
#print axioms Nimbus.ContentStore.mem_erase_writers

/-! ## Nimbus/ContentStore/Gc.lean -/

#print axioms Nimbus.ContentStore.wsum_erase
#print axioms Nimbus.ContentStore.wsum_mono
#print axioms Nimbus.ContentStore.wsum_enq
#print axioms Nimbus.ContentStore.gc_progress
#print axioms Nimbus.ContentStore.star_inv
#print axioms Nimbus.ContentStore.gc_drains
#print axioms Nimbus.ContentStore.no_garbage_after_quiescence

/-! ## Nimbus/ContentStore/Inv.lean -/

#print axioms Nimbus.ContentStore.liveView_resolve
#print axioms Nimbus.ContentStore.resolve_content_live
#print axioms Nimbus.ContentStore.not_writer_of_resolves
#print axioms Nimbus.ContentStore.exists_of_resolves
#print axioms Nimbus.ContentStore.content_lt_of_exists
#print axioms Nimbus.ContentStore.chunk_lt_of_exists
#print axioms Nimbus.ContentStore.resolve_ne_none
#print axioms Nimbus.ContentStore.atRef_mem
#print axioms Nimbus.ContentStore.commit_live
#print axioms Nimbus.ContentStore.mem_commit_hist
#print axioms Nimbus.ContentStore.mem_commit_queue
#print axioms Nimbus.ContentStore.commit_liveRef
#print axioms Nimbus.ContentStore.commit_lost
#print axioms Nimbus.ContentStore.commit_queue_sub
#print axioms Nimbus.ContentStore.commit_coverage
#print axioms Nimbus.ContentStore.commit_gens
#print axioms Nimbus.ContentStore.setView_live
#print axioms Nimbus.ContentStore.setView_hist
#print axioms Nimbus.ContentStore.setView_snaps
#print axioms Nimbus.ContentStore.setView_chunks
#print axioms Nimbus.ContentStore.setView_contents
#print axioms Nimbus.ContentStore.setView_queue
#print axioms Nimbus.ContentStore.setView_writers
#print axioms Nimbus.ContentStore.setView_fds
#print axioms Nimbus.ContentStore.setView_job
#print axioms Nimbus.ContentStore.setView_gen
#print axioms Nimbus.ContentStore.setView_nextChunk
#print axioms Nimbus.ContentStore.setView_nextContent
#print axioms Nimbus.ContentStore.setView_snapView
#print axioms Nimbus.ContentStore.setView_view
#print axioms Nimbus.ContentStore.dirty_live
#print axioms Nimbus.ContentStore.dirty_hist
#print axioms Nimbus.ContentStore.dirty_snaps
#print axioms Nimbus.ContentStore.dirty_chunks
#print axioms Nimbus.ContentStore.dirty_contents
#print axioms Nimbus.ContentStore.dirty_queue
#print axioms Nimbus.ContentStore.dirty_writers
#print axioms Nimbus.ContentStore.dirty_fds
#print axioms Nimbus.ContentStore.dirty_gen
#print axioms Nimbus.ContentStore.dirty_nextChunk
#print axioms Nimbus.ContentStore.dirty_nextContent
#print axioms Nimbus.ContentStore.dirty_snapView
#print axioms Nimbus.ContentStore.dirty_view
#print axioms Nimbus.ContentStore.commit_chunks_eq
#print axioms Nimbus.ContentStore.commit_contents_eq
#print axioms Nimbus.ContentStore.commit_snaps_eq
#print axioms Nimbus.ContentStore.commit_writers
#print axioms Nimbus.ContentStore.commit_fds
#print axioms Nimbus.ContentStore.commit_job
#print axioms Nimbus.ContentStore.commit_gen
#print axioms Nimbus.ContentStore.commit_nextChunk
#print axioms Nimbus.ContentStore.commit_nextContent
#print axioms Nimbus.ContentStore.commit_snapView
#print axioms Nimbus.ContentStore.commit_view
#print axioms Nimbus.ContentStore.updContent_live
#print axioms Nimbus.ContentStore.updContent_hist
#print axioms Nimbus.ContentStore.updContent_snaps
#print axioms Nimbus.ContentStore.updContent_chunks
#print axioms Nimbus.ContentStore.updContent_contents
#print axioms Nimbus.ContentStore.updContent_queue
#print axioms Nimbus.ContentStore.updContent_writers
#print axioms Nimbus.ContentStore.updContent_fds
#print axioms Nimbus.ContentStore.updContent_job
#print axioms Nimbus.ContentStore.updContent_gen
#print axioms Nimbus.ContentStore.updContent_nextChunk
#print axioms Nimbus.ContentStore.updContent_nextContent
#print axioms Nimbus.ContentStore.updContent_view
#print axioms Nimbus.ContentStore.updContent_snapView
#print axioms Nimbus.ContentStore.liveRef_congr
#print axioms Nimbus.ContentStore.histRef_congr
#print axioms Nimbus.ContentStore.fdRef_congr
#print axioms Nimbus.ContentStore.manRef_congr
#print axioms Nimbus.ContentStore.strongRef_congr
#print axioms Nimbus.ContentStore.writerHeld_congr
#print axioms Nimbus.ContentStore.stored_congr
#print axioms Nimbus.ContentStore.pinGen_congr
#print axioms Nimbus.ContentStore.atRef_congr
#print axioms Nimbus.ContentStore.commit_core
#print axioms Nimbus.ContentStore.base_job
#print axioms Nimbus.ContentStore.dirty_eq_job
#print axioms Nimbus.ContentStore.commit_inv

/-! ## Nimbus/ContentStore/Lemmas.lean -/

#print axioms Nimbus.ContentStore.upd_same
#print axioms Nimbus.ContentStore.upd_ne
#print axioms Nimbus.ContentStore.mem_enq
#print axioms Nimbus.ContentStore.mem_enq_of_mem
#print axioms Nimbus.ContentStore.mem_enq_self
#print axioms Nimbus.ContentStore.mem_foldl_enq
#print axioms Nimbus.ContentStore.mapM_mono
#print axioms Nimbus.ContentStore.mapM_congr
#print axioms Nimbus.ContentStore.mapM_some_mem
#print axioms Nimbus.ContentStore.mapM_append
#print axioms Nimbus.ContentStore.mapM_set
#print axioms Nimbus.ContentStore.mapM_length
#print axioms Nimbus.ContentStore.ext_refl
#print axioms Nimbus.ContentStore.ext_trans
#print axioms Nimbus.ContentStore.resolve_ext
#print axioms Nimbus.ContentStore.readRef_ext
#print axioms Nimbus.ContentStore.resolve_congr
#print axioms Nimbus.ContentStore.readRef_congr
#print axioms Nimbus.ContentStore.resolve_live_content
#print axioms Nimbus.ContentStore.resolve_chunk
#print axioms Nimbus.ContentStore.intern_ext
#print axioms Nimbus.ContentStore.intern_chunks_self
#print axioms Nimbus.ContentStore.commit_chunks
#print axioms Nimbus.ContentStore.commit_contents
#print axioms Nimbus.ContentStore.commit_snaps
#print axioms Nimbus.ContentStore.pinGen_ge
#print axioms Nimbus.ContentStore.le_pinGen
#print axioms Nimbus.ContentStore.commit_find_ne
#print axioms Nimbus.ContentStore.commit_live_ne
#print axioms Nimbus.ContentStore.commit_atRef

/-! ## Nimbus/ContentStore/Quiesce.lean -/

#print axioms Nimbus.ContentStore.Quiesce.pin1_snaps
#print axioms Nimbus.ContentStore.Quiesce.settleN_done
#print axioms Nimbus.ContentStore.Quiesce.settled
#print axioms Nimbus.ContentStore.Quiesce.settleN_cases
#print axioms Nimbus.ContentStore.Quiesce.pin1_inv
#print axioms Nimbus.ContentStore.Quiesce.settleN_inv
#print axioms Nimbus.ContentStore.Quiesce.raw_inv
#print axioms Nimbus.ContentStore.Quiesce.inv
#print axioms Nimbus.ContentStore.Quiesce.reach_settled
#print axioms Nimbus.ContentStore.Quiesce.pin_clean
#print axioms Nimbus.ContentStore.Quiesce.gated_on_newest
#print axioms Nimbus.ContentStore.Quiesce.pin_starts_its_waiters
#print axioms Nimbus.ContentStore.Quiesce.gated_on_pending
#print axioms Nimbus.ContentStore.Quiesce.acquire_never_waits
#print axioms Nimbus.ContentStore.Quiesce.settle_cases
#print axioms Nimbus.ContentStore.Quiesce.settle_id
#print axioms Nimbus.ContentStore.Quiesce.countP_map_lt
#print axioms Nimbus.ContentStore.Quiesce.progress
#print axioms Nimbus.ContentStore.Quiesce.wf_settle
#print axioms Nimbus.ContentStore.Quiesce.wf_resp
#print axioms Nimbus.ContentStore.Quiesce.drain
#print axioms Nimbus.ContentStore.Quiesce.deadlock_free
#print axioms Nimbus.ContentStore.Quiesce.stuck
#print axioms Nimbus.ContentStore.Quiesce.clone_pins
#print axioms Nimbus.ContentStore.Quiesce.clone_deadlocks_without_bypass
#print axioms Nimbus.ContentStore.Quiesce.lease_awaiting_copy_deadlocks
#print axioms Nimbus.ContentStore.Quiesce.job_awaiting_stream_deadlocks
#print axioms Nimbus.ContentStore.Quiesce.lease_after_gate

/-! ## Nimbus/ContentStore/Safety.lean -/

#print axioms Nimbus.ContentStore.init_inv
#print axioms Nimbus.ContentStore.step_inv
#print axioms Nimbus.ContentStore.reachable_inv
#print axioms Nimbus.ContentStore.live_reads_last_write
#print axioms Nimbus.ContentStore.snapshot_reads_its_tree
#print axioms Nimbus.ContentStore.snapshot_view_fixed
#print axioms Nimbus.ContentStore.descriptor_reads_what_it_opened
#print axioms Nimbus.ContentStore.restore_yields_the_snapshot

/-! ## Nimbus/ContentStore/Steps.lean -/

#print axioms Nimbus.ContentStore.internOk_fresh
#print axioms Nimbus.ContentStore.intern_base
#print axioms Nimbus.ContentStore.intern_exists
#print axioms Nimbus.ContentStore.intern_refs
#print axioms Nimbus.ContentStore.intern_view
#print axioms Nimbus.ContentStore.intern_snapView
#print axioms Nimbus.ContentStore.intern_gen
#print axioms Nimbus.ContentStore.intern_fds
#print axioms Nimbus.ContentStore.strongRef_intern
#print axioms Nimbus.ContentStore.writerHeld_intern
#print axioms Nimbus.ContentStore.intern_commit_inv
#print axioms Nimbus.ContentStore.jobOk_weak
#print axioms Nimbus.ContentStore.plain_commit_inv
#print axioms Nimbus.ContentStore.writeSmall_inv
#print axioms Nimbus.ContentStore.delete_inv
#print axioms Nimbus.ContentStore.copy_inv
#print axioms Nimbus.ContentStore.editSmallCow_inv
#print axioms Nimbus.ContentStore.beginLarge_inv
#print axioms Nimbus.ContentStore.appendLarge_inv
#print axioms Nimbus.ContentStore.manRef_upd_same
#print axioms Nimbus.ContentStore.publishNew_inv
#print axioms Nimbus.ContentStore.publishDedup_inv
#print axioms Nimbus.ContentStore.snapshot_inv
#print axioms Nimbus.ContentStore.dropSnapshot_inv
#print axioms Nimbus.ContentStore.dropHist_inv
#print axioms Nimbus.ContentStore.restoreStart_inv
#print axioms Nimbus.ContentStore.restoreSkip_inv
#print axioms Nimbus.ContentStore.restoreStep_inv
#print axioms Nimbus.ContentStore.restoreFinish_inv
#print axioms Nimbus.ContentStore.close_inv
#print axioms Nimbus.ContentStore.detach_inv
#print axioms Nimbus.ContentStore.memoDigest_inv
#print axioms Nimbus.ContentStore.rename_inv
#print axioms Nimbus.ContentStore.noMan_of
#print axioms Nimbus.ContentStore.gcChunkDelete_inv
#print axioms Nimbus.ContentStore.gcChunkSkip_inv
#print axioms Nimbus.ContentStore.gcContentSkip_inv
#print axioms Nimbus.ContentStore.dying_unreferenced
#print axioms Nimbus.ContentStore.views_upd_content
#print axioms Nimbus.ContentStore.gcContentStart_inv
#print axioms Nimbus.ContentStore.gcContentPage_inv
#print axioms Nimbus.ContentStore.gcContentFinish_inv
#print axioms Nimbus.ContentStore.reset_inv
#print axioms Nimbus.ContentStore.mem_set_self
#print axioms Nimbus.ContentStore.mem_set_of_ne
#print axioms Nimbus.ContentStore.setView_setView
#print axioms Nimbus.ContentStore.editSmallInPlace_inv
#print axioms Nimbus.ContentStore.editLargeCow_inv
#print axioms Nimbus.ContentStore.editLargeInPlace_inv

/-! ## Nimbus/ContentStore/Tier.lean -/

#print axioms Nimbus.ContentStore.Tier.step_inv
#print axioms Nimbus.ContentStore.Tier.reachable_inv
#print axioms Nimbus.ContentStore.Tier.live_never_cold
#print axioms Nimbus.ContentStore.Tier.tier_without_reprobe_colds_a_live_chunk
#print axioms Nimbus.ContentStore.Tier.resume_without_precheck_installs_a_cold_chunk

/-! ## Nimbus/Refine/ContentStoreCases.lean -/

#print axioms Nimbus.Refine.ContentStoreCases.chunkFor_ok

/-! ## Nimbus/Refine/RevisionFloorCases.lean -/

#print axioms Nimbus.Refine.RevisionFloorCases.dropOnce_step
#print axioms Nimbus.Refine.RevisionFloorCases.dropWhileOver_reach
#print axioms Nimbus.Refine.RevisionFloorCases.execBump_reach

/-! ## Nimbus/Runtime/PipesHeld.lean -/

#print axioms Nimbus.Runtime.Pipes.hstep_core
#print axioms Nimbus.Runtime.Pipes.hrun_core
#print axioms Nimbus.Runtime.Pipes.settles_only_readerless
#print axioms Nimbus.Runtime.Pipes.settle_value
#print axioms Nimbus.Runtime.Pipes.rs_zero_of_dead
#print axioms Nimbus.Runtime.Pipes.all_settle
#print axioms Nimbus.Runtime.Pipes.seq_head
#print axioms Nimbus.Runtime.Pipes.seq_head_without_the_rule
#print axioms Nimbus.Runtime.Pipes.seq_small_head
#print axioms Nimbus.Runtime.Pipes.seq_uniq_wc_held
#print axioms Nimbus.Runtime.Pipes.yes_head_held

/-! ## Nimbus/Runtime/PipesProofs.lean -/

#print axioms Nimbus.Runtime.Pipes.upd_same
#print axioms Nimbus.Runtime.Pipes.upd_ne
#print axioms Nimbus.Runtime.Pipes.sum_snoc
#print axioms Nimbus.Runtime.Pipes.sumTo_succ
#print axioms Nimbus.Runtime.Pipes.sumTo_congr
#print axioms Nimbus.Runtime.Pipes.sumTo_le
#print axioms Nimbus.Runtime.Pipes.sumTo_upd
#print axioms Nimbus.Runtime.Pipes.sumTo_eq_zero
#print axioms Nimbus.Runtime.Pipes.rs_stack
#print axioms Nimbus.Runtime.Pipes.ws_stack
#print axioms Nimbus.Runtime.Pipes.rs_pipes
#print axioms Nimbus.Runtime.Pipes.ws_pipes
#print axioms Nimbus.Runtime.Pipes.settle_procs
#print axioms Nimbus.Runtime.Pipes.settle_n
#print axioms Nimbus.Runtime.Pipes.settle_m
#print axioms Nimbus.Runtime.Pipes.settle_B
#print axioms Nimbus.Runtime.Pipes.settle_err
#print axioms Nimbus.Runtime.Pipes.setProc_pipes
#print axioms Nimbus.Runtime.Pipes.setProc_n
#print axioms Nimbus.Runtime.Pipes.setProc_m
#print axioms Nimbus.Runtime.Pipes.setProc_B
#print axioms Nimbus.Runtime.Pipes.setProc_err
#print axioms Nimbus.Runtime.Pipes.rs_settle
#print axioms Nimbus.Runtime.Pipes.enter_procs
#print axioms Nimbus.Runtime.Pipes.enter_pipes
#print axioms Nimbus.Runtime.Pipes.enter_m
#print axioms Nimbus.Runtime.Pipes.rs_enter
#print axioms Nimbus.Runtime.Pipes.ws_enter
#print axioms Nimbus.Runtime.Pipes.core_refuse
#print axioms Nimbus.Runtime.Pipes.sigpipe_only_readerless
#print axioms Nimbus.Runtime.Pipes.ignored_is_epipe
#print axioms Nimbus.Runtime.Pipes.default_is_sigpipe
#print axioms Nimbus.Runtime.Pipes.eof_only_writerless
#print axioms Nimbus.Runtime.Pipes.sched_some
#print axioms Nimbus.Runtime.Pipes.sched_none
#print axioms Nimbus.Runtime.Pipes.fork_keeps_parked
#print axioms Nimbus.Runtime.Pipes.fork_child_fresh
#print axioms Nimbus.Runtime.Pipes.books_settle
#print axioms Nimbus.Runtime.Pipes.books_upd
#print axioms Nimbus.Runtime.Pipes.books_procs
#print axioms Nimbus.Runtime.Pipes.books_finish
#print axioms Nimbus.Runtime.Pipes.books_abort
#print axioms Nimbus.Runtime.Pipes.books_core
#print axioms Nimbus.Runtime.Pipes.books_step
#print axioms Nimbus.Runtime.Pipes.core_B
#print axioms Nimbus.Runtime.Pipes.step_B
#print axioms Nimbus.Runtime.Pipes.books
#print axioms Nimbus.Runtime.Pipes.accounting
#print axioms Nimbus.Runtime.Pipes.budget
#print axioms Nimbus.Runtime.Pipes.drop_only_readerless
#print axioms Nimbus.Runtime.Pipes.abort_named
#print axioms Nimbus.Runtime.Pipes.meas_setProc
#print axioms Nimbus.Runtime.Pipes.meas_pipes
#print axioms Nimbus.Runtime.Pipes.meas_stack
#print axioms Nimbus.Runtime.Pipes.meas_settle
#print axioms Nimbus.Runtime.Pipes.meas_enter
#print axioms Nimbus.Runtime.Pipes.meas_finish
#print axioms Nimbus.Runtime.Pipes.meas_abort
#print axioms Nimbus.Runtime.Pipes.wt_run_pos
#print axioms Nimbus.Runtime.Pipes.meas_congr
#print axioms Nimbus.Runtime.Pipes.lt_of_set
#print axioms Nimbus.Runtime.Pipes.lt_of_set2
#print axioms Nimbus.Runtime.Pipes.lt_of_abort
#print axioms Nimbus.Runtime.Pipes.wt_next
#print axioms Nimbus.Runtime.Pipes.wt_pos
#print axioms Nimbus.Runtime.Pipes.wt_park
#print axioms Nimbus.Runtime.Pipes.core_run
#print axioms Nimbus.Runtime.Pipes.wt_wait
#print axioms Nimbus.Runtime.Pipes.wt_fin
#print axioms Nimbus.Runtime.Pipes.enabled_wait
#print axioms Nimbus.Runtime.Pipes.core_wait
#print axioms Nimbus.Runtime.Pipes.no_spin
#print axioms Nimbus.Runtime.Pipes.stuck_is_linux

/-! ## Nimbus/Runtime/PipesTraces.lean -/

#print axioms Nimbus.Runtime.PipesTraces.seq_uniq_wc_whole
#print axioms Nimbus.Runtime.PipesTraces.seq_uniq_wc_held_kill_loses
#print axioms Nimbus.Runtime.PipesTraces.fork_loop_whole
#print axioms Nimbus.Runtime.PipesTraces.parked_fork_keeps_the_write
#print axioms Nimbus.Runtime.PipesTraces.parked_fork_drops_the_write
#print axioms Nimbus.Runtime.PipesTraces.yes_head
#print axioms Nimbus.Runtime.PipesTraces.over_budget_fails_named
#print axioms Nimbus.Runtime.PipesTraces.over_budget_silent_truncates
#print axioms Nimbus.Runtime.PipesTraces.bash_middle_whole
#print axioms Nimbus.Runtime.PipesTraces.bash_middle_global_budget_fails
#print axioms Nimbus.Runtime.PipesTraces.ignored_sigpipe_is_epipe
#print axioms Nimbus.Runtime.PipesTraces.ignored_sigpipe_killed_by_5bdfec12

/-! ## Nimbus/Vfs/Composite.lean -/

#print axioms Nimbus.Vfs.Composite.pfx_iff
#print axioms Nimbus.Vfs.Composite.route_fold
#print axioms Nimbus.Vfs.Composite.route_spec
#print axioms Nimbus.Vfs.Composite.resolve_root_only
#print axioms Nimbus.Vfs.Composite.walk_clean
#print axioms Nimbus.Vfs.Composite.absent_refuses
#print axioms Nimbus.Vfs.Composite.busy_refuses
#print axioms Nimbus.Vfs.Composite.exdev_refuses
#print axioms Nimbus.Vfs.Composite.readdir_live_only
#print axioms Nimbus.Vfs.Composite.absent_of_prefix
#print axioms Nimbus.Vfs.Composite.route_not_hidden
#print axioms Nimbus.Vfs.Composite.linkAt_agree
#print axioms Nimbus.Vfs.Composite.treeAt_agree
#print axioms Nimbus.Vfs.Composite.dirErr_agree
#print axioms Nimbus.Vfs.Composite.walk_agree
#print axioms Nimbus.Vfs.Composite.walkRaw_agree
#print axioms Nimbus.Vfs.Composite.listing_agree
#print axioms Nimbus.Vfs.Composite.backendOp_agree
#print axioms Nimbus.Vfs.Composite.noninterference

/-! ## Nimbus/Vfs/CompositeBeneath.lean -/

#print axioms Nimbus.Vfs.CompositeBeneath.prefix_dropLast
#print axioms Nimbus.Vfs.CompositeBeneath.walkB_contained
#print axioms Nimbus.Vfs.CompositeBeneath.beneath_contained
#print axioms Nimbus.Vfs.CompositeBeneath.namedFrom_snoc
#print axioms Nimbus.Vfs.CompositeBeneath.namedFrom_dropLast
#print axioms Nimbus.Vfs.CompositeBeneath.walkB_named
#print axioms Nimbus.Vfs.CompositeBeneath.beneath_named
#print axioms Nimbus.Vfs.CompositeBeneath.beneath_root_searched
#print axioms Nimbus.Vfs.CompositeBeneath.walkB_agrees
#print axioms Nimbus.Vfs.CompositeBeneath.beneath_agrees
#print axioms Nimbus.Vfs.CompositeBeneath.beneath_across_mounts

/-! ## Nimbus/Vfs/CompositeCache.lean -/

#print axioms Nimbus.Vfs.CompositeCache.sync_read_fresh
#print axioms Nimbus.Vfs.CompositeCache.never_cached
#print axioms Nimbus.Vfs.CompositeCache.a_path_keyed_cache_serves_the_old_backend

/-! ## Nimbus/Vfs/CompositeFeed.lean -/

#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_mem
#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_fold_max
#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_fold_none
#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_max
#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_none
#print axioms Nimbus.Vfs.CompositeFeed.ownerPt_between
#print axioms Nimbus.Vfs.CompositeFeed.synthAnc_iff
#print axioms Nimbus.Vfs.CompositeFeed.dropLast_length_lt
#print axioms Nimbus.Vfs.CompositeFeed.structural_dropLast
#print axioms Nimbus.Vfs.CompositeFeed.view_closed
#print axioms Nimbus.Vfs.CompositeFeed.feed_values
#print axioms Nimbus.Vfs.CompositeFeed.feed_exact
#print axioms Nimbus.Vfs.CompositeFeed.an_unfiltered_root_feed_stages_a_shadowed_row
#print axioms Nimbus.Vfs.CompositeFeed.shown_below
#print axioms Nimbus.Vfs.CompositeFeed.shown_view
#print axioms Nimbus.Vfs.CompositeFeed.op_covered
#print axioms Nimbus.Vfs.CompositeFeed.op_other
#print axioms Nimbus.Vfs.CompositeFeed.apply_ops_exact
#print axioms Nimbus.Vfs.CompositeFeed.feedOps_exact
#print axioms Nimbus.Vfs.CompositeFeed.a_subtree_entry_at_a_composite_directory_must_poison
#print axioms Nimbus.Vfs.CompositeFeed.an_aba_window_needs_no_poison
#print axioms Nimbus.Vfs.CompositeFeed.owner_first_routing_is_not_a_tree
#print axioms Nimbus.Vfs.CompositeFeed.view_table_congr
#print axioms Nimbus.Vfs.CompositeFeed.step_exact
#print axioms Nimbus.Vfs.CompositeFeed.a_mount_appearing_is_not_in_any_feed
#print axioms Nimbus.Vfs.CompositeFeed.no_changes_never_staged
#print axioms Nimbus.Vfs.CompositeFeed.fs_inv
#print axioms Nimbus.Vfs.CompositeFeed.staged_closed
#print axioms Nimbus.Vfs.CompositeFeed.cas_inv
#print axioms Nimbus.Vfs.CompositeFeed.revision_unique
#print axioms Nimbus.Vfs.CompositeFeed.gen_only_revisions_collide

/-! ## Nimbus/Vfs/CompositeOps.lean -/

#print axioms Nimbus.Vfs.CompositeOps.fallback_report_exact
#print axioms Nimbus.Vfs.CompositeOps.keeps_mono
#print axioms Nimbus.Vfs.CompositeOps.roots_exact
#print axioms Nimbus.Vfs.CompositeOps.execC_refines
#print axioms Nimbus.Vfs.CompositeOps.frame_refl
#print axioms Nimbus.Vfs.CompositeOps.frame_set
#print axioms Nimbus.Vfs.CompositeOps.removeRecursive_stays_in_mount
#print axioms Nimbus.Vfs.CompositeOps.unsupported_is_enotsup
#print axioms Nimbus.Vfs.CompositeOps.copy_stays_in_target
#print axioms Nimbus.Vfs.CompositeOps.mount_point_mode

/-! ## Nimbus/Vfs/CompositePerm.lean -/

#print axioms Nimbus.Vfs.CompositePerm.setgid_inherits
#print axioms Nimbus.Vfs.CompositePerm.aclMode_classes
#print axioms Nimbus.Vfs.CompositePerm.and_bit
#print axioms Nimbus.Vfs.CompositePerm.acl_never_widens
#print axioms Nimbus.Vfs.CompositePerm.root_dir
#print axioms Nimbus.Vfs.CompositePerm.named_snoc
#print axioms Nimbus.Vfs.CompositePerm.named_dropLast
#print axioms Nimbus.Vfs.CompositePerm.walk_named
#print axioms Nimbus.Vfs.CompositePerm.resolve_named
#print axioms Nimbus.Vfs.CompositePerm.never_widens
#print axioms Nimbus.Vfs.CompositePerm.backend_refusal_stands
#print axioms Nimbus.Vfs.CompositePerm.resolved_frame
#print axioms Nimbus.Vfs.CompositePerm.step_frame
#print axioms Nimbus.Vfs.CompositePerm.held_described
#print axioms Nimbus.Vfs.CompositePerm.privileged_passes
#print axioms Nimbus.Vfs.CompositePerm.synth_meta_open
#print axioms Nimbus.Vfs.CompositePerm.the_perm_trace
#print axioms Nimbus.Vfs.CompositePerm.the_backend_alone_grants_the_leak
#print axioms Nimbus.Vfs.CompositePerm.links_resolve_in_the_callers_namespace
#print axioms Nimbus.Vfs.CompositePerm.a_setgid_directory_passes_its_group_on
#print axioms Nimbus.Vfs.CompositePerm.moving_a_directory_needs_write_on_it
#print axioms Nimbus.Vfs.CompositePerm.a_default_acl_masks_and_is_inherited

/-! ## Nimbus/Vfs/FastCdc.lean -/

#print axioms Nimbus.Vfs.FastCdc.scanFrom_bounds
#print axioms Nimbus.Vfs.FastCdc.scan_bounds
#print axioms Nimbus.Vfs.FastCdc.cdcCut_final
#print axioms Nimbus.Vfs.FastCdc.scanFrom_local
#print axioms Nimbus.Vfs.FastCdc.cdcCut_local
#print axioms Nimbus.Vfs.FastCdc.scanFrom_extend
#print axioms Nimbus.Vfs.FastCdc.cdcCut_prefix
#print axioms Nimbus.Vfs.FastCdc.cuts_tile
#print axioms Nimbus.Vfs.FastCdc.cutContent_tiles

/-! ## Nimbus/Vfs/Hydration.lean -/

#print axioms Nimbus.Vfs.Hydration.sync_never_state1
#print axioms Nimbus.Vfs.Hydration.async_never_state1
#print axioms Nimbus.Vfs.Hydration.resume_local
#print axioms Nimbus.Vfs.Hydration.raw_frame
#print axioms Nimbus.Vfs.Hydration.hLocal_mono
#print axioms Nimbus.Vfs.Hydration.isLocal_mono
#print axioms Nimbus.Vfs.Hydration.hyd_mono
#print axioms Nimbus.Vfs.Hydration.prio_mem
#print axioms Nimbus.Vfs.Hydration.step_covers
#print axioms Nimbus.Vfs.Hydration.queue_covers
#print axioms Nimbus.Vfs.Hydration.settleG_open
#print axioms Nimbus.Vfs.Hydration.settleG_ok
#print axioms Nimbus.Vfs.Hydration.settleG_named
#print axioms Nimbus.Vfs.Hydration.raw_gates
#print axioms Nimbus.Vfs.Hydration.step_gateInv
#print axioms Nimbus.Vfs.Hydration.gateInv
#print axioms Nimbus.Vfs.Hydration.gate_ok_local
#print axioms Nimbus.Vfs.Hydration.bound_reads_never_eio
#print axioms Nimbus.Vfs.Hydration.gate_bounded
#print axioms Nimbus.Vfs.Hydration.nothing_named_starts
#print axioms Nimbus.Vfs.Hydration.jobs_mono
#print axioms Nimbus.Vfs.Hydration.jobs_frame
#print axioms Nimbus.Vfs.Hydration.jobs_hydrate
#print axioms Nimbus.Vfs.Hydration.named_local_within
#print axioms Nimbus.Vfs.Hydration.a_shared_chunk

/-! ## Nimbus/Vfs/Ledger.lean -/

#print axioms Nimbus.Vfs.Ledger.sumB_nil
#print axioms Nimbus.Vfs.Ledger.sumB_cons
#print axioms Nimbus.Vfs.Ledger.sumB_append
#print axioms Nimbus.Vfs.Ledger.sumB_split
#print axioms Nimbus.Vfs.Ledger.sumB_filter_le
#print axioms Nimbus.Vfs.Ledger.fitDrop_some
#print axioms Nimbus.Vfs.Ledger.fitDrop_none
#print axioms Nimbus.Vfs.Ledger.fitDrop_min
#print axioms Nimbus.Vfs.Ledger.step_limit
#print axioms Nimbus.Vfs.Ledger.step_over
#print axioms Nimbus.Vfs.Ledger.admitted_within
#print axioms Nimbus.Vfs.Ledger.step_used
#print axioms Nimbus.Vfs.Ledger.used_le_limit
#print axioms Nimbus.Vfs.Ledger.refuses_when_over
#print axioms Nimbus.Vfs.Ledger.refused_unchanged
#print axioms Nimbus.Vfs.Ledger.refuses_iff
#print axioms Nimbus.Vfs.Ledger.evicts_oldest_minimal
#print axioms Nimbus.Vfs.Ledger.only_eviction_frees
#print axioms Nimbus.Vfs.Ledger.facet_row_stays
#print axioms Nimbus.Vfs.Ledger.a_ledger_trace
#print axioms Nimbus.Vfs.Ledger.an_over_report_refuses

/-! ## Nimbus/Vfs/ProcessFiles.lean -/

#print axioms Nimbus.Vfs.ProcessFiles.mem_map_upd
#print axioms Nimbus.Vfs.ProcessFiles.mem_map_keep
#print axioms Nimbus.Vfs.ProcessFiles.step_accounted
#print axioms Nimbus.Vfs.ProcessFiles.acked_accounted
#print axioms Nimbus.Vfs.ProcessFiles.a_kill_that_drops_buffers_loses_silently
#print axioms Nimbus.Vfs.ProcessFiles.atomic_appends_disjoint
#print axioms Nimbus.Vfs.ProcessFiles.a_two_step_append_overwrites
#print axioms Nimbus.Vfs.ProcessFiles.a_buffered_flush_overwrites_a_concurrent_flush
#print axioms Nimbus.Vfs.ProcessFiles.leases_hold
#print axioms Nimbus.Vfs.ProcessFiles.a_literal_only_check_is_bypassed
#print axioms Nimbus.Vfs.ProcessFiles.receipt_sound
#print axioms Nimbus.Vfs.ProcessFiles.receipt_in_step
#print axioms Nimbus.Vfs.ProcessFiles.a_late_receipt_names_another_write

/-! ## Nimbus/Vfs/RevisionFloor.lean -/

#print axioms Nimbus.Vfs.RevisionFloor.init_inv
#print axioms Nimbus.Vfs.RevisionFloor.under_refl
#print axioms Nimbus.Vfs.RevisionFloor.under_trans
#print axioms Nimbus.Vfs.RevisionFloor.under_ne_nil
#print axioms Nimbus.Vfs.RevisionFloor.under_cases
#print axioms Nimbus.Vfs.RevisionFloor.under_dropLast
#print axioms Nimbus.Vfs.RevisionFloor.under_length
#print axioms Nimbus.Vfs.RevisionFloor.walk_eq
#print axioms Nimbus.Vfs.RevisionFloor.walked_closed
#print axioms Nimbus.Vfs.RevisionFloor.walkAll_eq
#print axioms Nimbus.Vfs.RevisionFloor.bump_inv
#print axioms Nimbus.Vfs.RevisionFloor.drop_inv
#print axioms Nimbus.Vfs.RevisionFloor.step_inv
#print axioms Nimbus.Vfs.RevisionFloor.reachable_inv
#print axioms Nimbus.Vfs.RevisionFloor.revision_ge_last
#print axioms Nimbus.Vfs.RevisionFloor.revision_le_clock
#print axioms Nimbus.Vfs.RevisionFloor.revision_watermark
#print axioms Nimbus.Vfs.RevisionFloor.last_step
#print axioms Nimbus.Vfs.RevisionFloor.steps_facts
#print axioms Nimbus.Vfs.RevisionFloor.revision_increases_across_mutation
#print axioms Nimbus.Vfs.RevisionFloor.floor_monotone
#print axioms Nimbus.Vfs.RevisionFloor.a_zero_floor_reports_below_the_last_write

