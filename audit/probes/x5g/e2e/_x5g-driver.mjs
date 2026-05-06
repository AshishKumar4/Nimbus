// X5G e2e driver: install + require a single package via wrangler dev.
// Reuses the post-phase5-verification local probe pattern (BASE must
// be set to http://127.0.0.1:8787; per AGENTS.md, port 8787 +
// --ip 0.0.0.0).
//
// Usage:
//   BASE=http://127.0.0.1:8787 bun audit/probes/x5g/e2e/<probe>.mjs

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runOnePkg({ name, pkg, smoke, expectations }) {
  if (!process.env.BASE) {
    console.error(`FATAL: must set BASE (e.g. http://127.0.0.1:8787) for x5g e2e probes.`);
    process.exit(2);
  }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ARTIFACT = path.join(HERE, `${name}.out.txt`);
  fs.writeFileSync(ARTIFACT, '');

  console.log(`[X5G E2E] ${name} starting…`);
  const id = `x5g_${Date.now().toString(36)}`;
  const b64 = Buffer.from(smoke, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd   = `cd /home/user/app && node .${id}.js`;

  const r = await runProbe(name, [
    { kind: 'cmd', cmd: `cd app && npm install ${pkg}`, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
  ], { artifactPath: ARTIFACT, settleMs: 3000 });

  // Classify outcome.
  const out = fs.readFileSync(ARTIFACT, 'utf8');
  let verdict = 'unknown';
  if (/npm install rejected:/.test(out)) verdict = '⛔ loud-reject';
  else if (expectations.success && new RegExp(expectations.success).test(out)) verdict = '✅ success';
  else if (/Cannot find module|UNHANDLED|Cannot read properties/.test(out)) verdict = '⚠ install OK runtime fail';
  else verdict = '? indeterminate';

  fs.appendFileSync(ARTIFACT, `\n\n==== X5G VERDICT: ${verdict} ====\n`);
  console.log(`[X5G E2E] ${name} → ${verdict}`);
  return { name, ok: r.ok, verdict };
}
