#!/usr/bin/env bun
// auth/new/hosted-demo-anon-launch — the landing page's no-sign-in path,
// followed from the page a visitor actually loads to a shell that actually
// runs a command.
//
// WHY THIS EXISTS
//   `GET /try` has worked on production the whole time. The landing page
//   never linked it, so the capability was unreachable for weeks and
//   nothing went red — the only probe that reads `public/index.html`
//   (`hosted-demo-launch-oauth`) asserted the modal's actions and had no
//   opinion about an anonymous one existing. A capability with no
//   affordance is a capability nobody has.
//
//   So this probe starts where the visitor starts. It does not grep the
//   HTML for "/try": it parses the launch dialog, takes whatever href the
//   secondary action actually points at, and then FOLLOWS that href
//   through the redirect chain into a live session and runs a command in
//   it. Leaving the link in place while breaking the flow fails here, and
//   so does breaking the flow while leaving the link.
//
// THE CHAIN
//   GET /                        landing page → the modal's anon action
//   GET /try                     303 → /s/<sid>/?nimbus_token=…
//   GET /s/<sid>/?nimbus_token   302 + Set-Cookie __Host-nimbus_token
//   GET /s/<sid>/                200, the shell
//   WS  /s/<sid>/ws              echo → the bytes come back
//
//   Every hop is unauthenticated apart from what the previous hop handed
//   over. The suite's bearer token is deliberately NOT sent: a visitor
//   clicking this button has no credential, and a probe that carried one
//   would prove nothing about the path being open.
//
// TARGET REQUIREMENT — read this before adding it to a skip list
//   `/try` is a hosted-demo route backed by the demo's D1
//   (`demo_sessions`) and its `ANON_RATE_LIMITER` binding. `apps/probe`
//   declares no D1, no ratelimits and no DEMO_* vars, and its handler
//   routes nothing but the core Nimbus surface — so this chain cannot
//   complete there, and this probe is on `_probe-target-skips.mjs` for
//   that reason, stated there in full. Run it against a hosted-demo
//   deployment (`nimbus-staging`, `bun run staging:test`).
//
//   Because a skipped probe is exactly how the affordance hid in the
//   first place, the landing-page half is ALSO asserted in the unit
//   suite (`tests/unit/hosted-demo-anon-session.mjs`), which runs on
//   every target and cannot be skipped by a target's shape.
//
// SESSION HYGIENE
//   `DEMO_ANON_MAX_ACTIVE` is small and shared with the public docs
//   terminal, so this takes exactly one session and releases it. Anon
//   sessions answer DELETE with 401 by design — they are owned by nobody
//   — and reap on their own ~600s TTL, so a refused delete is reported,
//   not failed.

import { BASE, Terminal, makeAsserter, requestHeaders } from '../../_driver.mjs';

const a = makeAsserter('auth/new/hosted-demo-anon-launch');

// ── 1. the landing page offers a way in without an account ───────────

const landing = await fetch(`${BASE}/`, { headers: requestHeaders({ Accept: 'text/html' }) });
const html = await landing.text();
a.check('landing page serves', landing.status === 200, `${landing.status}`);

const dialog = html.match(/<div class="launch-dialog"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
a.check('launch dialog is present', dialog.length > 0);

// Accessibility contract of the dialog, so a change here cannot quietly
// trade the affordance for a broken modal.
a.check('dialog keeps its accessibility contract',
  /role="dialog"/.test(dialog)
  && /aria-modal="true"/.test(dialog)
  && /aria-labelledby="launch-title"/.test(dialog)
  && /aria-describedby="[^"]*launch-copy/.test(dialog)
  && /id="launch-close"/.test(dialog)
  && /id="launch-status"/.test(dialog),
  dialog.slice(0, 200));

const actions = dialog.match(/<div class="launch-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
const anchors = [...actions.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
  attrs: m[1],
  text: m[2].replace(/<[^>]*>/g, '').trim(),
  href: m[1].match(/href="([^"]*)"/)?.[1] ?? '',
  primary: /\bbtn-primary\b/.test(m[1]),
}));

const signIn = anchors.find((x) => /id="launch-login"/.test(x.attrs));
a.check('sign-in action is still the primary action',
  !!signIn && signIn.primary && signIn.href.startsWith('/login'),
  JSON.stringify(signIn));

// The affordance, taken from the page rather than assumed: any action in
// the modal that is not the sign-in one and does not leave the origin.
const anon = anchors.find((x) => x !== signIn && x.href.startsWith('/'));
a.check('modal offers a second, non-login way to launch',
  !!anon,
  `actions: ${JSON.stringify(anchors.map((x) => x.href))}`);
a.check('the second action reads as secondary, not primary',
  !!anon && !anon.primary,
  JSON.stringify(anon));

if (!anon) {
  a.summary();
  console.log('\n  the landing page offers no way to launch without an account — chain cannot be followed');
  process.exit(1);
}

console.log(`\n  following the modal's secondary action: ${anon.href} ("${anon.text}")`);

// ── 2. that href reaches a session, with no credential of our own ────

const noCredential = { Accept: 'text/html' };

const tryRes = await fetch(new URL(anon.href, BASE), { redirect: 'manual', headers: noCredential });
const tryLocation = tryRes.headers.get('location') ?? '';
a.check('anon action mints a session and redirects to it',
  tryRes.status === 303 && /^\/s\/[^/]+\/\?/.test(tryLocation),
  `${tryRes.status} ${tryLocation || (await tryRes.text().catch(() => '')).slice(0, 200)}`);

if (tryRes.status !== 303) {
  const sum = a.summary();
  console.log(`\n  ${BASE} did not answer ${anon.href} with a session redirect.`);
  console.log('  If this target is apps/probe, it has no demo D1 or rate limiter and cannot');
  console.log('  serve /try — run this against a hosted-demo deployment (bun run staging:test).');
  process.exit(1);
}

const attachUrl = new URL(tryLocation, BASE);
const sid = attachUrl.pathname.match(/^\/s\/([^/]+)\//)?.[1] ?? '';
a.check('redirect carries an attach token for a real session id',
  sid.length > 0 && !!attachUrl.searchParams.get('nimbus_token'),
  attachUrl.pathname);

// ── 3. the attach exchange hands the browser a session cookie ────────

const attachRes = await fetch(attachUrl, { redirect: 'manual', headers: noCredential });
const setCookies = attachRes.headers.getSetCookie();
const sessionCookie = setCookies
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('__Host-nimbus_token='));

a.check('attach exchange swaps the query token for a session cookie',
  attachRes.status === 302 && !!sessionCookie,
  `${attachRes.status} ${JSON.stringify(setCookies)}`);
a.check('attach exchange lands on the clean session URL',
  attachRes.headers.get('location') === `/s/${sid}/`,
  attachRes.headers.get('location') ?? '');

if (!sessionCookie) {
  a.summary();
  process.exit(1);
}

// ── 4. the shell is actually there, and actually runs things ─────────

const shellRes = await fetch(new URL(`/s/${sid}/`, BASE), {
  headers: { ...noCredential, Cookie: sessionCookie },
});
const shellHtml = await shellRes.text();
a.check('session shell serves to the cookie the chain produced',
  shellRes.status === 200 && shellHtml.includes('<'),
  `${shellRes.status} ${shellHtml.length}b`);

const nonce = `anon-${Date.now().toString(36)}`;
const term = new Terminal(sid, { wsOptions: { headers: { Cookie: sessionCookie } } });
let ranCommand = false;
let commandDetail = '';

try {
  await term.connect(30_000);
  await term.waitForPrompt(45_000);
  const { output } = await term.run(`echo ${nonce}`, 45_000);
  // The echoed command line contains the nonce too, so require it on a
  // line of its own — that is the shell's output, not our input coming back.
  ranCommand = output.split('\n').some((line) => line.trim() === nonce);
  commandDetail = JSON.stringify(output.slice(-200));
} catch (e) {
  commandDetail = e?.message ?? String(e);
} finally {
  await term.close().catch(() => {});
}

a.check('anonymous session runs a command and returns its output',
  ranCommand,
  commandDetail);

// ── 5. give the session back ─────────────────────────────────────────

const released = await fetch(new URL(`/s/${sid}/`, BASE), {
  method: 'DELETE',
  headers: { Cookie: sessionCookie, 'X-Nimbus-Cleanup-Reason': 'behavioral-probe-cleanup' },
}).then((r) => r.status).catch((e) => `error: ${e?.message ?? e}`);

// Not an assertion: an anon session is owned by nobody, so DELETE is 401
// by design and the ~600s TTL reaps it either way. Reported so a change
// in that behaviour is visible rather than silently absorbed.
console.log(`\n  released ${sid}: DELETE → ${released} (401 expected; anon sessions reap on TTL)`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
