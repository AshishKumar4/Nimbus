# two-tier-fanout progress

## Brief
Two-tier fan-out wave on `two-tier-fanout` off `origin/main` @ `5995e15`.

Charter: V8 hard cap of 4 concurrent loaders per DO method.
Two validated topologies:
- POC C in-DO (4.03× at N=4) for width < 5
- POC B peer-DO (7.75× at N=8, flat to N=32) for width ≥ 5

## Phases
- [x] Setup worktree (HEAD: 5995e15; tsc baseline: 2)
- [x] P0 progress.md (cff21d7)
- [x] P1 audit — `audit/sections/FANOUT-AUDIT.md` (8319334)
- [x] P2 wins — `audit/sections/FANOUT-WINS.md` (81ae8ef)
- [x] P3 NimbusFanoutPool primitive — `src/loaders/fanout-pool.ts` (455501a)
- [x] P4a F-1 install-batch refactor + probe (52e4064)
- [x] P4b F-3 in-DO POC-C structural probe (621e7c8)
- [x] P5 README topology diagram + horizontal-scaling section (8f3229f)
- [x] P6 cross-wave + tsc baseline (a2e6a29)
- [x] P7 retro — `audit/sections/TWO-TIER-FANOUT-retro.md`

## Final state
- tsc baseline: 2 errors (unchanged from main)
- F-1 install-batch probe: 5/5 PASS, ratios 5.09×–5.74×, median 5.54×
- F-3 in-DO probe: PASS structural (4 distinct slots, in-order results)
- Phase 5 regression: 28 PASS, 1 FAIL (D'.1 pre-existing on main),
  0 SKIP, 0 TIMEOUT
- src/ touch: 4 files
  - new: src/loaders/fanout-pool.ts (NimbusFanoutPool primitive)
  - modified: src/loaders/loader-pool.ts (added mapSource)
  - modified: src/npm/installer.ts (F-1 fetchViaBatchFacet via NimbusFanoutPool)
  - modified: src/session/rpc.ts + nimbus-session.ts (_rpcFanoutExecute)
- 1 cross-wave-regression-free; primitive ready for future wide sites.

## Anti-requirements honored
- NO "increase the cap" hacks — primitive sidesteps it via topology choice.
- NO ad-hoc peer-DO selection — deterministic stable-id router (djb2, verified 8 distinct shards).
- NO refactor of GREEN/bounded sites that never approach cap.
- NO Cloudchamber mentions (scrubbed in prior wave; not reintroduced).
- NO setTimeout/sleep/retry-with-delay.
- NO fallback on missing bindings — hard-fail throws BindingError.
- NO files outside worktree, NO push to main, NO redeploy, NO pause.
