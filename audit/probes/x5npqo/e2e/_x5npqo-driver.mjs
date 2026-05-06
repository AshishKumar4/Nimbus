// X.5-NPQO e2e driver. Mirrors x5m driver shape.
// Requires BASE env var pointing to a wrangler dev URL.

import { runProbe } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runOnePkg({ name, pkg, smoke, expectations, retries = 1 }) {
  if (!process.env.BASE) {
    console.error(`FATAL: must set BASE (e.g. http://127.0.0.1:8788) for x5npqo e2e probes.`);
    process.exit(2);
  }

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ARTIFACT = path.join(HERE, `${name}.out.txt`);
  fs.writeFileSync(ARTIFACT, '');

  let lastVerdict = '? unknown';
  let lastOk = false;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (attempt > 1) {
      console.log(`[X5NPQO E2E] ${name} retry ${attempt}/${retries}`);
      fs.appendFileSync(ARTIFACT, `\n\n==== RETRY ${attempt} ====\n\n`);
    }
    console.log(`[X5NPQO E2E] ${name} starting…`);
    const id = `x5npqo_${Date.now().toString(36)}_${attempt}`;
    const b64 = Buffer.from(smoke, 'utf8').toString('base64');
    const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
    const runCmd   = `cd /home/user/app && node .${id}.js`;

    const r = await runProbe(name, [
      { kind: 'cmd', cmd: `cd app && npm install ${pkg}`, timeoutMs: 240_000 },
      { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
    ], { artifactPath: ARTIFACT, settleMs: 3000 });

    const out = fs.readFileSync(ARTIFACT, 'utf8');
    let verdict = '? indeterminate';
    if (/npm install rejected:/.test(out)) verdict = '⛔ loud-reject';
    else if (expectations.success && new RegExp(expectations.success).test(out)) verdict = '✅ success';
    else if (expectations.charterPass && new RegExp(expectations.charterPass).test(out)) verdict = '⚠ charter-pass (deeper-fail-out-of-scope)';
    else if (/Cannot find module|UNHANDLED|Cannot read properties|Invalid URL|TypeError|ReferenceError|ENOENT|Cannot load module|Unexpected token|pre-compile failed/.test(out)) verdict = '⚠ install OK runtime fail';

    lastVerdict = verdict;
    lastOk = r.ok;
    if (verdict.startsWith('✅') || verdict.startsWith('⚠ charter-pass')) break;
  }

  fs.appendFileSync(ARTIFACT, `\n\n==== X5NPQO VERDICT: ${lastVerdict} ====\n`);
  console.log(`[X5NPQO E2E] ${name} → ${lastVerdict}`);
  return { name, ok: lastOk, verdict: lastVerdict };
}
