/-
  POSITIVE CONTROL for `check-no-false.sh`. This file must ALWAYS compile,
  through the same `lake env lean` invocation and against the same imports the
  probes use; otherwise every "this probe failed" verdict would be free.
-/

import Nimbus.Vfs.RevisionFloor
import Nimbus.Coherence.StoreBugs

theorem control_compiles : 1 + 1 = 2 := rfl

/-- The probes reach into these namespaces, so the control does too. -/
example : Nimbus.Vfs.RevisionFloor.Reachable Nimbus.Vfs.RevisionFloor.init := .init
example : Nimbus.Coherence.Store.Reachable Nimbus.Coherence.Store.init := .init
