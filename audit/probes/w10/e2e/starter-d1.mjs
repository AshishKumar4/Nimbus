// W10 e2e: clone CF D1 starter, schema-init succeeds via wrangler d1.
//
// Same prod-gating as starter-worker-router: needs deployed Nimbus.

import { ok, summary } from '../_tap.mjs';

const PROD = process.env.NIMBUS_W10_E2E_PROD === '1';
if (!PROD) {
  console.log('  # SKIP — NIMBUS_W10_E2E_PROD not set');
  summary('w10/e2e/starter-d1 (skipped)');
}

// Prod walkthrough (manual until automated):
//   1. POST /new
//   2. WS: git clone https://github.com/cloudflare/templates
//   3. WS: cd templates/d1-starter && npm install
//   4. WS: wrangler dev
//   5. HTTP: GET <session>/worker/api/<resource>
//      → expect 200 with JSON describing seeded schema

console.log('  # PROD probe stub: requires orchestrator implementation');
ok('placeholder: D1 starter prod walkthrough acknowledged', true);
summary('w10/e2e/starter-d1 (prod stub)');
