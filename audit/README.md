# Universal node.js compat audit

Comprehensive compatibility audit of Nimbus (Cloudflare Workers-based dev env).

## Layout
- `sections/` — per-section findings (01–07)
- `probes/` — raw probe artifacts (node-builtins, packages, wasm, dynamic)
- `UNIVERSAL-NODE-COMPAT.md` — top-level synthesis

## Repo state at audit time
- HEAD: `e93b18d` (Wave 1 close-out — synthetic-entry barrel handling)
- Prod: `c6449d38`

## Phases
- Phase 0: setup
- Phase 1: node:* builtins matrix
- Phase 2: top-30 npm packages
- Phase 3: resolver gaps
- Phase 4: native bindings + WASM mitigation
- Phase 5: postinstall + dynamic semantics + workerd limits
- Phase 6: synthesis (UNIVERSAL-NODE-COMPAT.md)
