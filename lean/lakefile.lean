import Lake
open Lake DSL

package nimbus where
  leanOptions := #[
    ⟨`autoImplicit, false⟩
  ]

@[default_target]
lean_lib Nimbus where
  roots := #[`Nimbus, `Nimbus.Axioms, `Nimbus.Refine]

/-- `lake exe fixtures <dir>` writes every refinement fixture (compiled: the
    generators replay whole executions of the models). -/
lean_exe fixtures where
  root := `RefinementFixtures
