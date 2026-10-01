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
//   - under enforce auth the pane reaches a host preview through the
//     single-use token exchange's 302, and the isolated shell holds that hop
//     to CORP too: the guest must still load isolated behind it.
//   - inside the @nimbus-sh/react embed's default sandbox, the shell's "open
//     in new tab" still gives the app an isolated top-level tab.
// Guest headers are the ones the router forwarded, untouched.

import { readFileSync } from 'node:fs';
import { makeAsserter } from '../../_driver.mjs';
import { launchBrowser } from '../../_runtime-behavioral-template.mjs';

const { createNimbusHandler } = await import('../../../../packages/worker/src/router/index.ts');
const { issueNimbusToken } = await import('../../../../packages/worker/src/auth/token.ts');
const isolation = await import('../../../../packages/worker/src/_shared/preview-isolation.ts');
const { documentPolicyOf } = await import('../../../../packages/core/src/runtime/document-policy.ts');
const { NIMBUS_TERMINAL_SANDBOX } = await import('../../../../packages/react/src/NimbusTerminal.tsx');

// Every wait is 60 s: each one ends as soon as Chrome answers, and a machine
// running other browsers (the suite's pool) slowed a 15 s one past its limit.
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

// The same preview door under enforce auth, as a deployment with a JWT secret
// serves it: the pane's first request carries a single-use `nimbus_token`,
// exchanged for a cookie by a 302 back to the clean URL.
const consumed = new Set();
const enforceEnv = {
  ...env,
  JWT_SECRET: 'coi-host-preview-rules-secret',
  NIMBUS_SESSION: {
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: (request) => env.NIMBUS_SESSION.get().fetch(request),
      _rpcConsumeAttachBootstrap: async (jti) => !consumed.has(jti) && Boolean(consumed.add(jti)),
    }),
  },
};
const enforceHandler = createNimbusHandler({ auth: { mode: 'enforce' } });
const enforceServer = Bun.serve({ port: 0, fetch: (request) => enforceHandler.fetch(request, enforceEnv, { waitUntil() {} }) });

// An embedder page holding a shell in the React component's default sandbox;
// the shell's ↗ opens the preview the way the real one does.
const embedServer = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/embed') {
      const shell = `http://127.0.0.1:${embedServer.port}/shell?child=${encodeURIComponent(url.searchParams.get('child'))}`;
      return new Response(`<!doctype html><iframe id="embed" sandbox="${NIMBUS_TERMINAL_SANDBOX}" src="${shell}"></iframe>`, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.pathname === '/shell') {
      const child = JSON.stringify(url.searchParams.get('child'));
      return new Response(`<!doctype html><button id="open" onclick='window.open(${child}, "_blank", "noopener")'>open</button>`, { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  },
});
const browser = await launchBrowser({ timeout: 60_000, webSecurity: true });

const SAME_SITE_SHELL = `http://nimbus.localhost:${port}`;
const CROSS_SITE_SHELL = `http://127.0.0.1:${port}`;
const previewUrl = (guestPort) => `http://${guestPort}--${sid}.nimbus.localhost:${port}/`;

/** Load `shell` with the pane on guest `guestPort`; report what Chrome did. */
async function paneOutcome(shellOrigin, guestPort, { isolated = true, allow = true } = {}) {
  const page = await browser.newPage();
  const child = previewUrl(guestPort);
  const query = new URLSearchParams({ child, ...(isolated ? { [isolation.SHELL_ISOLATION_QUERY]: '1' } : {}), ...(allow ? {} : { allow: 'none' }) });
  const response = await page.goto(`${shellOrigin}/s/${sid}/?${query}`, { waitUntil: 'load', timeout: 60_000 });
  const shellHeaders = response.headers();
  const shellIsolated = await page.evaluate(() => self.crossOriginIsolated);
  let outcome = null;
  const deadline = Date.now() + 60_000;
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
    documentPolicyOf(guest.headers),
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

  // Enforce auth: the pane's navigation crosses the token exchange's 302.
  {
    // Single-use, so the header check and the browser each get their own.
    const tokenUrl = async () => {
      const token = await issueNimbusToken(enforceEnv, {
        tn: 'acme', sub: 'alice', scopes: ['session:preview'], sid, jti: crypto.randomUUID(),
      }, { ttlMs: 60_000 });
      return `http://3002--${sid}.nimbus.localhost:${enforceServer.port}/?nimbus_token=${encodeURIComponent(token)}`;
    };
    const exchange = await fetch(await tokenUrl(), { redirect: 'manual' });
    a.check(
      'the preview door’s token exchange is a 302 carrying CORP cross-origin',
      exchange.status === 302 && exchange.headers.get('cross-origin-resource-policy') === 'cross-origin',
      `status=${exchange.status} corp=${exchange.headers.get('cross-origin-resource-policy')}`,
    );
    const page = await browser.newPage();
    const query = new URLSearchParams({ child: await tokenUrl(), [isolation.SHELL_ISOLATION_QUERY]: '1' });
    await page.goto(`${SAME_SITE_SHELL}/s/${sid}/?${query}`, { waitUntil: 'load', timeout: 60_000 });
    let outcome = null;
    const deadline = Date.now() + 60_000;
    while (outcome === null && Date.now() < deadline) {
      const reported = await page.evaluate(() => window.__messages.find((m) => m && m.coiApp)?.coiApp ?? null);
      if (reported) outcome = { loaded: true, ...reported };
      else if (page.frames().some((frame) => frame.url().startsWith('chrome-error://'))) outcome = { loaded: false };
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await page.close();
    a.check(
      'enforce auth, guest CORP cross-origin behind the token exchange: isolated in the pane (SAB + Worker + Atomics)',
      outcome?.loaded === true && outcome.coi === true && outcome.value === 42,
      JSON.stringify(outcome),
    );
  }

  // The React embed's default sandbox: ↗ still gives the app an isolated tab.
  {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${embedServer.port}/embed?child=${encodeURIComponent(previewUrl(3000))}`, { waitUntil: 'load', timeout: 60_000 });
    const shellFrame = page.frames().find((frame) => frame.url().includes('/shell'));
    // The shell is cross-site to the embedder, so it renders in its own
    // process, and a click only reaches it once it has presented a frame:
    // measured, 2 of 20 clicks sent right after `load` never reached the
    // button. Wait for that frame to paint, as a user's eye would.
    await shellFrame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const opened = browser.waitForTarget((target) => target.type() === 'page' && (target.url() === previewUrl(3000) || target.url().startsWith('chrome-error')), { timeout: 60_000 });
    await shellFrame.click('#open');
    const popup = await (await opened).page();
    const result = await popup.waitForFunction(() => window.__result, { timeout: 60_000 }).then((handle) => handle.jsonValue(), () => null);
    await popup.close();
    await page.close();
    a.check(
      `the embed's sandbox (${NIMBUS_TERMINAL_SANDBOX.split(' ').at(-1)}) lets the opened app be isolated: SAB + Worker + Atomics`,
      result?.coi === true && result.value === 42,
      JSON.stringify(result),
    );
  }

  // Its own tab: top-level, isolated by its own headers.
  {
    const page = await browser.newPage();
    await page.goto(previewUrl(3000), { waitUntil: 'load', timeout: 60_000 });
    const result = await (await page.waitForFunction(() => window.__result, { timeout: 60_000 })).jsonValue();
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
  enforceServer.stop(true);
  embedServer.stop(true);
}

const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
