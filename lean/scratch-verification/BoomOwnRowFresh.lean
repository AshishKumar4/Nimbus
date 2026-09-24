/-
  Negative regression probe — OWN-ROW-FRESH FAMILY. This file must NEVER
  compile.

  The tempting axiom: a facet's own row whose write the authority already
  committed is always as fresh as a dated row. It is false without the
  acknowledgement wait (own_committed_write_is_served_past_a_peer). Should
  anyone assume it outright rather than prove it from a guard, `False`
  follows. With the axiom absent this must fail as an UNKNOWN IDENTIFIER.
-/

import Nimbus.Coherence.StoreBugs

open Nimbus.Coherence.Store

theorem boom_own_row_fresh : False := by
  obtain ⟨s, h, _, hg, hp, _, _, hstale⟩ := own_committed_write_is_served_past_a_peer
  have := Nimbus.Coherence.Store.own_row_fresh s h ⟨0, 0, some 1⟩ hg 1 rfl hp
  obtain ⟨t, ht, hv⟩ := this
  exact hstale t ht hv
