// W3 functional probe — `sha256sum` shell command produces real SHA-256
//
// echo -n hello > /tmp/x ; sha256sum /tmp/x
//   should output: 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  /tmp/x
//
// Pre-build: FAIL — unix-commands.ts mkSha256sum is FNV-1a fake
//   (independent of node-shims FNV; the second silent-correctness bug
//    discovered during W3 plan grep).
// Post-build: PASS — uses crypto.subtle.digest('SHA-256', ...).

import { runProbe } from '../../_driver.mjs';
import { W3_OUT_DIR, assertProbe, execProbe } from '../_helpers.mjs';
import path from 'path';
import fs from 'fs';

export default function shell_sha256sum() {
  return execProbe(async () => {
    const name = 'shell-sha256sum';
    const artifactPath = path.join(W3_OUT_DIR, name + '.out.txt');
    fs.writeFileSync(artifactPath, '');
    // Use printf to write exactly "hello" (no newline) to /tmp/x, then sha256sum.
    const r = await runProbe(name, [
      { kind: 'cmd', cmd: `printf hello > /tmp/x && sha256sum /tmp/x`, timeoutMs: 10_000 },
    ], { artifactPath, settleMs: 2000 });
    if (!r?.ok) return assertProbe(name, false, 'driver failed', '');
    const out = fs.readFileSync(artifactPath, 'utf8');
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    return assertProbe(name, out.includes(expected),
      'expected sha256("hello") = ' + expected + ' in artifact, got:\n' + out.slice(-2000),
      out);
  });
}
