#!/usr/bin/env bun
// preview-isolation — the rules the session shell and the router share for
// cross-origin isolated previews (packages/worker/src/_shared/preview-isolation.ts).
//
// Two halves. The router serves the isolated shell only when its URL asks,
// and never adds a policy to anything a guest serves. The pure rules decide
// what the preview pane offers from a preview document's own COEP/CORP (as
// the port registry reports it, tests/unit/port-registry-document-policy.mjs),
// its relation to the shell, and the shell's own state — the browser
// behaviour they encode is proven in Chrome by tests/behavioral/preview/new/coi-*.

import assert from 'node:assert/strict';
import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import {
  ISOLATED_SHELL_HEADERS,
  SHELL_ISOLATION_QUERY,
  isIsolatedShellUrl,
  planPreviewPane,
  previewRelation,
  shellUrlInMode,
} from '../../packages/worker/src/_shared/preview-isolation.ts';

const sid = 'nimble-otter-4271';
const ctx = { waitUntil() {} };
const guestHeaders = {
  'Content-Type': 'text/html',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Accept-Ranges': 'bytes',
  'Content-Range': 'bytes 0-3/10',
  ETag: '"guest-etag"',
};

function legacyEnv() {
  return {
    NIMBUS_PREVIEW_HOST_SUFFIX: 'nimbus-os.dev',
    ASSETS: {
      async fetch(request) {
        assert.equal(new URL(request.url).pathname, '/s/index.html');
        return new Response('<!doctype html>shell', {
          status: 200,
          headers: { 'Content-Type': 'text/html', ETag: '"shell"' },
        });
      },
    },
    NIMBUS_SESSION: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () => new Response('guest', { status: 206, headers: guestHeaders }),
      }),
    },
  };
}

// ── the router: the isolated shell on request, guests untouched ──────────
{
  const handler = createNimbusHandler({ auth: { mode: 'legacy' } });
  const env = legacyEnv();

  const plain = await handler.fetch(new Request(`https://nimbus-os.dev/s/${sid}/`), env, ctx);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('Cross-Origin-Opener-Policy'), null, 'the default shell keeps no COOP');
  assert.equal(plain.headers.get('Cross-Origin-Embedder-Policy'), null, 'the default shell keeps no COEP');
  assert.equal(await plain.text(), '<!doctype html>shell');

  const isolated = await handler.fetch(
    new Request(`https://nimbus-os.dev/s/${sid}/?${SHELL_ISOLATION_QUERY}=1&agent=1`),
    env,
    ctx,
  );
  assert.equal(isolated.status, 200);
  for (const [name, value] of Object.entries(ISOLATED_SHELL_HEADERS)) {
    assert.equal(isolated.headers.get(name), value, `isolated shell carries ${name}`);
  }
  assert.equal(isolated.headers.get('ETag'), '"shell"', 'the asset headers survive');
  assert.equal(await isolated.text(), '<!doctype html>shell', 'the same page, only the headers differ');

  const otherValue = await handler.fetch(new Request(`https://nimbus-os.dev/s/${sid}/?${SHELL_ISOLATION_QUERY}=0`), env, ctx);
  assert.equal(otherValue.headers.get('Cross-Origin-Embedder-Policy'), null, 'only =1 asks');

  // Both preview doors hand back exactly what the guest answered: no policy
  // is added to a preview that did not ask, none is rewritten on one that did.
  for (const url of [
    `https://nimbus-os.dev/s/${sid}/port/3000/map.bin?${SHELL_ISOLATION_QUERY}=1`,
    `https://3000--${sid}.nimbus-os.dev/map.bin?${SHELL_ISOLATION_QUERY}=1`,
  ]) {
    const guest = await handler.fetch(new Request(url), env, ctx);
    assert.equal(guest.status, 206, url);
    assert.deepEqual(
      Object.fromEntries(guest.headers),
      Object.fromEntries(new Headers(guestHeaders)),
      `${url} passes guest headers through untouched`,
    );
  }
}

// ── shell URLs ───────────────────────────────────────────────────────────
{
  const base = `https://nimbus-os.dev/s/${sid}/?agent=1`;
  const isolated = shellUrlInMode(base, true);
  assert.equal(isolated, `https://nimbus-os.dev/s/${sid}/?agent=1&isolated=1`);
  assert.equal(isIsolatedShellUrl(new URL(isolated)), true);
  assert.equal(shellUrlInMode(isolated, false), base, 'leaving isolation keeps every other parameter');
  assert.equal(isIsolatedShellUrl(new URL(base)), false);
}

// ── relation: same-site only where it is provable without the PSL ────────
{
  const shell = new URL(`https://nimbus-os.dev/s/${sid}/`);
  assert.equal(previewRelation(new URL(`https://nimbus-os.dev/s/${sid}/port/3000/`), shell), 'same-origin');
  assert.equal(previewRelation(new URL(`https://3000--${sid}.nimbus-os.dev/`), shell), 'same-site');
  assert.equal(previewRelation(new URL('https://evilnimbus-os.dev/'), shell), 'cross-site');
  assert.equal(previewRelation(new URL(`http://3000--${sid}.nimbus-os.dev/`), shell), 'cross-site');
  // A sibling of the shell host may be same site, but proving it needs the
  // registrable domain; it is under-reported, never over-reported.
  assert.equal(
    previewRelation(new URL('https://3000--x.preview.example.com/'), new URL('https://app.example.com/')),
    'cross-site',
  );
}

// ── what the pane offers ─────────────────────────────────────────────────
{
  const halo = { embedderPolicy: 'require-corp', resourcePolicy: 'same-origin' };
  const plain = { embedderPolicy: 'unsafe-none', resourcePolicy: null };
  const openToAll = { embedderPolicy: 'credentialless', resourcePolicy: 'cross-origin' };
  const openToSite = { embedderPolicy: 'require-corp', resourcePolicy: 'same-site' };
  const defaultShell = { requested: false, isolated: false, topLevel: true };
  const embeddedShell = { requested: false, isolated: false, topLevel: false };
  const declinedShell = { requested: true, isolated: false, topLevel: true };
  const isolatedShell = { requested: true, isolated: true, topLevel: true };

  // Default shell: nothing changes for a preview that does not ask.
  assert.equal(planPreviewPane(plain, 'same-origin', defaultShell), 'none');
  assert.equal(planPreviewPane(plain, 'cross-site', embeddedShell), 'none');
  // One that asks is offered the isolated shell when the pane can embed it.
  assert.equal(planPreviewPane(halo, 'same-origin', defaultShell), 'isolate-shell');
  assert.equal(planPreviewPane(openToAll, 'cross-site', defaultShell), 'isolate-shell');
  assert.equal(planPreviewPane(openToSite, 'same-site', defaultShell), 'isolate-shell');
  // Its own tab when no shell mode can: CORP refuses the cross-origin shell…
  assert.equal(planPreviewPane(halo, 'same-site', defaultShell), 'own-tab');
  assert.equal(planPreviewPane(openToSite, 'cross-site', defaultShell), 'own-tab');
  assert.equal(planPreviewPane({ embedderPolicy: 'require-corp', resourcePolicy: null }, 'same-site', defaultShell), 'own-tab');
  // …the shell is embedded, so its COOP is ignored…
  assert.equal(planPreviewPane(halo, 'same-origin', embeddedShell), 'own-tab');
  // …or the browser was asked and declined (no credentialless support).
  assert.equal(planPreviewPane(halo, 'same-origin', declinedShell), 'own-tab');
  assert.equal(planPreviewPane(plain, 'same-origin', declinedShell), 'none');

  // Isolated shell: the pane shows what asks and it can embed…
  assert.equal(planPreviewPane(halo, 'same-origin', isolatedShell), 'none');
  assert.equal(planPreviewPane(openToAll, 'cross-site', isolatedShell), 'none');
  assert.equal(planPreviewPane(openToSite, 'same-site', isolatedShell), 'none');
  // …sends what it cannot embed to a tab of its own…
  assert.equal(planPreviewPane(halo, 'same-site', isolatedShell), 'own-tab');
  // …and blocks what does not ask, so it offers the default shell back.
  assert.equal(planPreviewPane(plain, 'same-origin', isolatedShell), 'default-shell');
  assert.equal(planPreviewPane(plain, 'cross-site', isolatedShell), 'default-shell');
}

console.log('preview-isolation: ok');
