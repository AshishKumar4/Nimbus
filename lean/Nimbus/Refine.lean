/-
  Nimbus.Refine — the refinement fixtures. Each case module evaluates a model's
  own definitions on generated inputs; `RefinementFixtures.lean` writes the
  results to `lean/fixtures/`, and a unit test runs the deployed code on the
  same inputs.
-/

import Nimbus.Refine.Json
import Nimbus.Refine.RevisionFloorCases
import Nimbus.Refine.ContentStoreCases
import Nimbus.Refine.NamespaceCases
import Nimbus.Refine.FastCdcCases
import Nimbus.Refine.TierCases
import Nimbus.Refine.VisibleDeltaCases
import Nimbus.Refine.NodeCases
import Nimbus.Refine.CompositeCases
import Nimbus.Refine.ProcessFilesCases
import Nimbus.Refine.CompositeFeedCases
