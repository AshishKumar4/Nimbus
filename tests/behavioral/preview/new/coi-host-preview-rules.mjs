// @serial — browser probe: launches a real Chrome under the run's shared profile root, which the runner's orphan reaper cannot scope to one probe mid-run
// preview/new/coi-host-preview-rules — the host-based preview door
// (`<port>--<sid>.<suffix>`), cross-origin to the shell, against the
// browser's own isolation rules. Local: the real router and the real shell's
// preview <iframe> tag, served on `*.localhost` (a secure context Chrome
// resolves to loopback), because host previews need a zone route that
// throwaway targets do not have.
//
// For each guest the rules module predicts what the pane can do
// (`planPreviewPane`), and Chrome must agree:
//   - CORP same-site from a subdomain of the shell host: isolated in the pane.
//   - CORP cross-origin: isolated in the pane from any site.
//   - CORP same-origin (halo-web's headers), or CORP same-site from another
//     site: blocked in the pane, so its own tab — where it is isolated.
//   - no COEP: blocked by the isolated shell, so the default shell.
//   - without the shell's `allow="cross-origin-isolated"` a cross-origin
//     preview loads but is not isolated.
// Guest headers are the ones the router forwarded, untouched.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';
import { launchBrowser } from '../../_runtime-behavioral-template.mjs';

const { createNimbusHandler } = await import('../../../../packages/worker/src/router/index.ts');
const isolation = await import('../../../../packages/worker/src/_shared/preview-isolation.ts');

const label = 'preview/new/coi-host-preview-rules';
const a = makeAsserter(label);
console.log(`${label} — local`);

const sid = 'nimble-otter-4271';
const shellHtml = readFileSync(new URL('../../../../packages/worker/public/s/index.html', import.meta.url), 'utf8');
const paneTag = shellHtml.match(/<iframe id="preview-frame"[^>]*><\/iframe>/)?.[0];
if (!paneTag) throw new Error('the shell has no #preview-frame iframe');

const appPage = `<!doctype html><title>coi-app</title><script>
(async () => {
  const result = { coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer };
  try {
    const cell = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker('worker.js');
    worker.postMessage(cell.buffer);
    Atomics.store(cell, 0, 1);
    Atomics.notify(cell, 0);
    const deadline = Date.now() + 10000;
    while (Atomics.load(cell, 1) !== 42 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    result.value = Atomics.load(cell, 1);
  } catch (error) {
    result.error = String(error);
  }
  window.__result = result;
  if (parent !== self) parent.postMessage({ coiApp: result }, '*');
})();
</script>`;
const workerJs = 'onmessage = (e) => { const cell = new Int32Array(e.data); Atomics.wait(cell, 0, 0); Atomics.store(cell, 1, 42); Atomics.notify(cell, 1); };';

// What each guest port answers with: its own headers, nothing added.
const GUESTS = {
  3000: { name: 'CORP same-origin (halo-web)', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } },
  3001: { name: 'CORP same-site', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-site' } },
  3002: { name: 'CORP cross-origin', headers: { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'cross-origin' } },
  3003: { name: 'no COEP', headers: {} },
};

const env = {
  NIMBUS_PREVIEW_HOST_SUFFIX: 'nimbus.localhost',
  ASSETS: {
    async fetch() {
      // The shell's own pane element, pointed where the test says.
      const frame = paneTag.replace('src="about:blank"', 'src="about:blank" data-pane');
      return new Response(`<!doctype html><title>shell</title>${frame}<script>
        window.__messages = [];
        addEventListener('message', (event) => window.__messages.push(event.data));
        const child = new URLSearchParams(location.search).get('child');
        const pane = document.getElementById('preview-frame');
        if (new URLSearchParams(location.search).get('allow') === 'none') pane.removeAttribute('allow');
        pane.src = child;
      </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  },
  NIMBUS_SESSION: {
    idFromName: (name) => ({ name }),
    get: () => ({
      async fetch(request) {
        const match = new URL(request.url).pathname.match(/^\/port\/(\d+)(\/.*)$/);
        const guest = match && GUESTS[match[1]];
        if (!guest) return new Response('no guest', { status: 502 });
        const js = match[2].endsWith('/worker.js');
        return new Response(js ? workerJs : appPage, {
          headers: { ...guest.headers, 'Content-Type': js ? 'text/javascript' : 'text/html; charset=utf-8' },
        });
      },
    }),
  },
};

const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request, env, { waitUntil() {} }) });
const port = server.port;
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true });

const SAME_SITE_SHELL = `http://nimbus.localhost:${port}`;
const CROSS_SITE_SHELL = `http://127.0.0.1:${port}`;
const previewUrl = (guestPort) => `http://${guestPort}--${sid}.nimbus.localhost:${port}/`;

/** Load `shell` with the pane on guest `guestPort`; report what Chrome did. */
async function paneOutcome(shellOrigin, guestPort, { isolated = true, allow = true } = {}) {
  const page = await browser.newPage();
  const child = previewUrl(guestPort);
  const query = new URLSearchParams({ child, ...(isolated ? { [isolation.SHELL_ISOLATION_QUERY]: '1' } : {}), ...(allow ? {} : { allow: 'none' }) });
  const response = await page.goto(`${shellOrigin}/s/${sid}/?${query}`, { waitUntil: 'load' });
  const shellHeaders = response.headers();
  const shellIsolated = await page.evaluate(() => self.crossOriginIsolated);
  let outcome = null;
  const deadline = Date.now() + 15_000;
  while (outcome === null && Date.now() < deadline) {
    const reported = await page.evaluate(() => window.__messages.find((m) => m && m.coiApp)?.coiApp ?? null);
    if (reported) outcome = { loaded: true, ...reported };
    else if (page.frames().some((frame) => frame.url().startsWith('chrome-error://'))) outcome = { loaded: false };
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.close();
  const guest = await fetch(child);
  await guest.body?.cancel();
  const plan = isolation.planPreviewPane(
    {
      embedderPolicy: isolation.parseEmbedderPolicy(guest.headers.get('cross-origin-embedder-policy')),
      resourcePolicy: isolation.parseResourcePolicy(guest.headers.get('cross-origin-resource-policy')),
    },
    isolation.previewRelation(new URL(child), new URL(shellOrigin)),
    { requested: isolated, isolated: shellIsolated, topLevel: true },
  );
  return { outcome, plan, shellHeaders, shellIsolated, guestHeaders: guest.headers };
}

try {
  // The router's own answer on both doors.
  {
    const { shellHeaders, shellIsolated, guestHeaders } = await paneOutcome(SAME_SITE_SHELL, 3002);
    a.check(
      'the router serves the isolated shell with COOP same-origin + COEP credentialless, and Chrome isolates it',
      shellHeaders['cross-origin-opener-policy'] === 'same-origin'
        && shellHeaders['cross-origin-embedder-policy'] === 'credentialless'
        && shellIsolated === true,
      JSON.stringify(shellHeaders),
    );
    a.check(
      'the preview host passes the guest’s headers through untouched',
      guestHeaders.get('cross-origin-embedder-policy') === 'credentialless'
        && guestHeaders.get('cross-origin-resource-policy') === 'cross-origin'
        && guestHeaders.get('cross-origin-opener-policy') === null,
      JSON.stringify(Object.fromEntries(guestHeaders)),
    );
  }

  const cases = [
    { shell: SAME_SITE_SHELL, guest: 3001, plan: 'none', isolatedPane: true },
    { shell: CROSS_SITE_SHELL, guest: 3002, plan: 'none', isolatedPane: true },
    { shell: SAME_SITE_SHELL, guest: 3000, plan: 'own-tab', isolatedPane: false },
    { shell: CROSS_SITE_SHELL, guest: 3001, plan: 'own-tab', isolatedPane: false },
    { shell: SAME_SITE_SHELL, guest: 3003, plan: 'default-shell', isolatedPane: false },
  ];
  for (const expected of cases) {
    const site = expected.shell === SAME_SITE_SHELL ? 'same-site shell' : 'cross-site shell';
    const { outcome, plan } = await paneOutcome(expected.shell, expected.guest);
    a.check(
      `isolated ${site}, guest ${GUESTS[expected.guest].name}: rules say ${expected.plan}`,
      plan === expected.plan,
      `plan=${plan}`,
    );
    a.check(
      `isolated ${site}, guest ${GUESTS[expected.guest].name}: Chrome ${expected.isolatedPane ? 'isolates it in the pane (SAB + Worker + Atomics)' : 'blocks it in the pane'}`,
      expected.isolatedPane
        ? outcome?.loaded === true && outcome.coi === true && outcome.value === 42
        : outcome?.loaded === false,
      JSON.stringify(outcome),
    );
  }

  // The default shell: nothing is blocked, nothing is isolated, and the
  // rules offer the isolated shell only where it would work.
  {
    const embeddable = await paneOutcome(SAME_SITE_SHELL, 3001, { isolated: false });
    a.check(
      'default shell, guest CORP same-site: loads unisolated, rules offer the isolated shell',
      embeddable.outcome?.loaded === true && embeddable.outcome.coi === false && embeddable.plan === 'isolate-shell'
        && embeddable.shellHeaders['cross-origin-embedder-policy'] === undefined,
      JSON.stringify({ outcome: embeddable.outcome, plan: embeddable.plan }),
    );
    const refused = await paneOutcome(SAME_SITE_SHELL, 3000, { isolated: false });
    a.check(
      'default shell, guest CORP same-origin: loads unisolated, rules offer its own tab',
      refused.outcome?.loaded === true && refused.outcome.coi === false && refused.plan === 'own-tab',
      JSON.stringify({ outcome: refused.outcome, plan: refused.plan }),
    );
  }

  // The permission the shell delegates is load-bearing.
  {
    const { outcome } = await paneOutcome(CROSS_SITE_SHELL, 3002, { allow: false });
    a.check(
      'without allow="cross-origin-isolated" a cross-origin preview loads but is not isolated',
      outcome?.loaded === true && outcome.coi === false,
      JSON.stringify(outcome),
    );
  }

  // Its own tab: top-level, isolated by its own headers.
  {
    const page = await browser.newPage();
    await page.goto(previewUrl(3000), { waitUntil: 'load' });
    const result = await (await page.waitForFunction(() => window.__result, { timeout: 15_000 })).jsonValue();
    await page.close();
    a.check(
      'guest CORP same-origin in its own tab: isolated, SAB + Worker + Atomics',
      result.coi === true && result.value === 42,
      JSON.stringify(result),
    );
  }
} catch (error) {
  a.check('probe completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close().catch(() => {});
  server.stop(true);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
