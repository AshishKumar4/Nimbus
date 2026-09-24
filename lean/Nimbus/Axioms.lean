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
#print axioms Nimbus.ContentStore.atRef_mem'
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
#print axioms Nimbus.ContentStore.liveRef_congr
#print axioms Nimbus.ContentStore.histRef_congr
#print axioms Nimbus.ContentStore.fdRef_congr
#print axioms Nimbus.ContentStore.manRef_congr
#print axioms Nimbus.ContentStore.strongRef_congr
#print axioms Nimbus.ContentStore.writerHeld_congr
#print axioms Nimbus.ContentStore.exists_congr'
#print axioms Nimbus.ContentStore.pinGen_congr
#print axioms Nimbus.ContentStore.atRef_congr
#print axioms Nimbus.ContentStore.commit_core
#print axioms Nimbus.ContentStore.base_job
#print axioms Nimbus.ContentStore.dirty_eq_job
#print axioms Nimbus.ContentStore.commit_inv

/-! ## Nimbus/ContentStore/Lemmas.lean -/

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
#print axioms Nimbus.ContentStore.Ext
#print axioms Nimbus.ContentStore.Ext
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
#print axioms Nimbus.Vfs.RevisionFloor.revision_watermark
#print axioms Nimbus.Vfs.RevisionFloor.revision_monotone
#print axioms Nimbus.Vfs.RevisionFloor.floor_monotone
#print axioms Nimbus.Vfs.RevisionFloor.a_zero_floor_reports_below_the_last_write

