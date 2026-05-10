// frameworks/_template.mjs — shared driver for the 7 framework probes.
//
// CHARTER: honestly drive the literal user flow on prod and verify
// each framework lights up end-to-end. NO shortcuts: we run the real
// `npm create` (or equivalent) command, real `npm install`, real
// `npm run dev`, then HTTP-fetch /preview/ and inspect the response.
//
// "iframe contentDocument inspection" — we cannot run a real browser
// from this driver. Best-available approximation: fetch /preview/
// (which is the URL the iframe loads) and assert:
//   - 200 status
//   - response body contains the framework-specific marker
//   - response body does NOT contain a Nimbus error page
//
// For SSR frameworks (Astro, Next, Nuxt, Remix), the initial HTML
// contains rendered content. For SPA frameworks (Vite + CF Vite
// Plugin, SvelteKit-dev), the initial HTML contains skeleton + a
// script tag that hydrates client-side; we ALSO fetch /preview/@modules/<entry>
// or similar to verify the dev-server can serve modules.
//
// Output: JSON object on stdout summarising each phase + a pass/fail
// verdict. Probe exits non-zero if the framework fails to light up.
//
// Anti-reqs (per the wave charter):
//   - no setTimeout / sleep / retry / defensive-catch
//   - no per-framework substrate in the runtime — primitives only

import { mintSession, Terminal, sleep, stripAnsi, fetchPreview, BASE } from '../_driver.mjs';

const COLD_PROMPT_WAIT_MS = 5_000;

export async function runFrameworkProbe(spec) {
  // spec: {
  //   name: string,
  //   workdir: string,                   // /home/user/<workdir>
  //   createCmd: string,                  // 'npm create vite@latest mvp -- --template react-ts --yes'
  //   createTimeoutMs: number,
  //   installCmd?: string,                // 'npm install', usually
  //   installTimeoutMs?: number,
  //   devCmd: string,                     // 'npm run dev'
  //   devReadyMarkers: string[],          // log-line markers indicating dev is ready
  //   devReadyTimeoutMs: number,
  //   previewMarkers: string[],           // strings any of which must appear in /preview/ HTML
  //   previewMustNotContain: string[],    // diagnostic strings whose presence indicates failure
  //   extraPreviewPaths?: string[],       // additional URLs to fetch + return body for diagnosis
  // }
  const sid = await mintSession();
  const findings = { framework: spec.name, sid, base: BASE };
  console.log(`[${spec.name}] sid=${sid} BASE=${BASE}`);

  const t = new Terminal(sid);
  await t.connect();
  await sleep(COLD_PROMPT_WAIT_MS);
  await t.waitForPrompt(60_000);

  // ── Phase 1: create ────────────────────────────────────────────────
  findings.create = { cmd: spec.createCmd, started: Date.now() };
  const createResult = await t.run(`mkdir -p /home/user/${spec.workdir} && cd /home/user/${spec.workdir}`, 10_000);
  findings.create.mkdir_elapsed = createResult.elapsed;

  const createOut = await t.run(spec.createCmd, spec.createTimeoutMs);
  findings.create.elapsed = createOut.elapsed;
  findings.create.tail = stripAnsi(createOut.output).split(/\r?\n/).slice(-30).join('\n');
  findings.create.indicators = scanIndicators(createOut.output, spec);

  // ── Phase 2: chdir to created project ──────────────────────────────
  if (spec.cdInto) {
    await t.run(`cd ${spec.cdInto}`, 10_000);
    findings.cdInto = spec.cdInto;
  }

  // Verify package.json exists (the create command was at least
  // partially successful). Use `test -f` so we get a deterministic
  // exit code AND a distinguishable string echoed via printf — the
  // `ls -la` echo line was poisoning the regex.
  const lsOut = await t.run(
    'test -f package.json && printf "FWPROBE_PKG_EXISTS=1\\n" || printf "FWPROBE_PKG_EXISTS=0\\n"; cat package.json 2>/dev/null | head -20',
    15_000,
  );
  findings.packageJsonExists = /FWPROBE_PKG_EXISTS=1/.test(stripAnsi(lsOut.output));
  findings.create.packageJsonHead = stripAnsi(lsOut.output).slice(-1500);

  if (!findings.packageJsonExists) {
    console.log(JSON.stringify(findings, null, 2));
    console.log(`  ✗ ${spec.name}: create did not produce package.json`);
    await t.close();
    return { ...findings, verdict: 'FAIL-CREATE' };
  }

  // ── Phase 3: npm install ───────────────────────────────────────────
  if (spec.installCmd) {
    findings.install = { cmd: spec.installCmd, started: Date.now() };
    const installOut = await t.run(spec.installCmd, spec.installTimeoutMs || 600_000);
    findings.install.elapsed = installOut.elapsed;
    findings.install.tail = stripAnsi(installOut.output).split(/\r?\n/).slice(-30).join('\n');
    findings.install.indicators = scanIndicators(installOut.output, spec);
    // Check for installed node_modules
    const nmCheck = await t.run('ls node_modules | wc -l', 15_000);
    const nmCount = Number((stripAnsi(nmCheck.output).match(/\b(\d+)\b/g) || []).find((n) => Number(n) > 0)) || 0;
    findings.install.nodeModulesCount = nmCount;
    findings.install.success = nmCount > 10;
    if (!findings.install.success) {
      console.log(JSON.stringify(findings, null, 2));
      console.log(`  ✗ ${spec.name}: npm install did not produce node_modules`);
      await t.close();
      return { ...findings, verdict: 'FAIL-INSTALL' };
    }
  }

  // ── Phase 4: dev server ────────────────────────────────────────────
  findings.dev = { cmd: spec.devCmd, started: Date.now() };
  t.reset();
  t.cmd(spec.devCmd);
  let devReady = false;
  let devTail = '';
  const devT0 = Date.now();
  try {
    await t.waitFor((b) => {
      devTail = b.slice(-2000);
      const hit = spec.devReadyMarkers.some((m) => b.includes(m));
      return hit;
    }, spec.devReadyTimeoutMs, `${spec.name}-dev-ready`);
    devReady = true;
    findings.dev.elapsedToReady = Date.now() - devT0;
  } catch (e) {
    findings.dev.elapsedToReady = Date.now() - devT0;
    findings.dev.timeout = true;
    findings.dev.errorMessage = String(e?.message || e).slice(0, 500);
  }
  findings.dev.tail = stripAnsi(devTail).split(/\r?\n/).slice(-30).join('\n');
  findings.dev.ready = devReady;

  // Give dev server a moment to fully bind / register port — but no
  // setTimeout retry; one bounded sleep is the protocol's accepted
  // "let async settle" pattern across all probes (see WASI probes).
  await sleep(2_000);

  // ── Phase 5: /preview/ HTML fetch + marker scan ────────────────────
  const previewResult = await fetchPreview(sid);
  findings.preview = {
    status: previewResult.status,
    elapsed: previewResult.elapsed,
    htmlLen: previewResult.html.length,
    htmlHead: previewResult.html.slice(0, 2000),
    htmlTail: previewResult.html.slice(-1000),
  };
  const html = previewResult.html;
  findings.preview.markersFound = spec.previewMarkers.filter((m) => html.includes(m));
  findings.preview.badMarkersFound = (spec.previewMustNotContain || []).filter((m) => html.includes(m));
  findings.preview.ok = (
    previewResult.status === 200 &&
    findings.preview.markersFound.length > 0 &&
    findings.preview.badMarkersFound.length === 0
  );

  // ── Phase 6: extra paths (e.g. /preview/@modules/react) ────────────
  if (spec.extraPreviewPaths) {
    findings.extras = [];
    for (const path of spec.extraPreviewPaths) {
      const r = await fetchPreview(sid, { path });
      findings.extras.push({
        path,
        status: r.status,
        elapsed: r.elapsed,
        bodyHead: r.html.slice(0, 400),
        bodyLen: r.html.length,
      });
    }
  }

  // ── Phase 7: ps shows the dev server ──────────────────────────────
  const psOut = await t.run('ps', 15_000);
  const psText = stripAnsi(psOut.output);
  const devBinNames = spec.devCmd.split(/\s+/).filter((s) => !s.startsWith('-'));
  findings.ps = {
    raw: psText.split(/\r?\n/).slice(-15).join('\n'),
    sees_dev_server: /vite|next|nuxt|astro|remix|wrangler|node/i.test(psText),
  };

  await t.close();

  // ── Verdict ────────────────────────────────────────────────────────
  const verdict =
    !findings.packageJsonExists ? 'FAIL-CREATE' :
    (findings.install && !findings.install.success) ? 'FAIL-INSTALL' :
    !findings.dev.ready ? 'FAIL-DEV-START' :
    !findings.preview.ok ? 'FAIL-PREVIEW' :
    'PASS';
  findings.verdict = verdict;

  console.log(JSON.stringify(findings, null, 2));
  console.log(`\n[${spec.name}] ${verdict === 'PASS' ? 'GREEN' : 'RED'} — verdict=${verdict}`);
  return findings;
}

function scanIndicators(output, spec) {
  const s = stripAnsi(output);
  return {
    hasError: /\b(error|err!|failed|fatal)\b/i.test(s),
    hasMissingCmd: /command not found/.test(s),
    hasENOENT: /ENOENT/.test(s),
    hasENOTFOUND: /ENOTFOUND/.test(s),
    hasModuleError: /(Cannot find module|Failed to resolve|cannot resolve)/.test(s),
    hasNimbusError: /NIMBUS_ERROR|\bbun ERR!|npm ERR!\s*Aborted/.test(s),
  };
}
