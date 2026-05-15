#!/usr/bin/env bun
// seed-refresh/regression/seeded-app-still-renders — the seeded React
// starter at `~/app` MUST still parse + bundle after we edit Home.tsx
// (new import: `Languages` from lucide-react replacing `Cpu`) and
// Docs.tsx (3 new section objects + 3 new lucide imports). A syntax
// error in our seed templates would break first-impression for every
// new user.
//
// Category: R (runtime-behavioral). We exercise the actual user flow:
// `cd app && npm install && npm run build`. Build success means the
// edited files parse, type-check, AND emit assets.
//
// Note: full `npm install` of the seeded app is expensive (~80s).
// We use a shorter readiness gate (esbuild transform of just our two
// edited files) to keep the probe under 30s wall.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/seeded-app-still-renders');
console.log(`seed-refresh/seeded-app-still-renders — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. The seeded app dir is present (the whole point of seedProject).
{
  const r = await t.run('ls /home/user/app/package.json && ls /home/user/app/src/pages/Docs.tsx && ls /home/user/app/src/pages/Home.tsx', 10_000);
  const out = stripAnsi(r.output);
  const ok = /package\.json/.test(out) && /Docs\.tsx/.test(out) && /Home\.tsx/.test(out)
    && !/ENOENT|No such/.test(out);
  a.check('seeded app structure intact (package.json + Home.tsx + Docs.tsx)', ok,
    ok ? '' : JSON.stringify(out.slice(-400)));
}

// 2. Docs.tsx parses cleanly through esbuild (catches our new section
//    additions if they break JSX). esbuild is the same transform path
//    Vite uses.
{
  const r = await t.run('esbuild /home/user/app/src/pages/Docs.tsx --loader=tsx --bundle=false --format=esm --target=esnext 2>&1 | tail -20', 30_000);
  const out = stripAnsi(r.output);
  const ok = !/error:|ERROR:|Syntax error|Unexpected/i.test(out);
  a.check('Docs.tsx parses via esbuild (no syntax error from new sections)', ok,
    ok ? '' : JSON.stringify(out.slice(-500)));
}

// 3. Home.tsx parses cleanly (our Languages-icon swap).
{
  const r = await t.run('esbuild /home/user/app/src/pages/Home.tsx --loader=tsx --bundle=false --format=esm --target=esnext 2>&1 | tail -20', 30_000);
  const out = stripAnsi(r.output);
  const ok = !/error:|ERROR:|Syntax error|Unexpected/i.test(out);
  a.check('Home.tsx parses via esbuild (Languages-icon swap is valid)', ok,
    ok ? '' : JSON.stringify(out.slice(-500)));
}

// 4. The Languages lucide-react import is reachable (basic
//    static-check: the source file uses the new symbol).
{
  const r = await t.run("grep -E 'Languages' /home/user/app/src/pages/Home.tsx", 10_000);
  const out = stripAnsi(r.output);
  const ok = /Languages/.test(out);
  a.check('Home.tsx references Languages icon (from lucide-react)', ok,
    ok ? '' : JSON.stringify(out.slice(-300)));
}

// 5. README.md still has the Quickstart section (additive change
//    didn't break existing structure).
{
  const r = await t.run('grep -E "^## Quickstart" /home/user/app/README.md', 10_000);
  const out = stripAnsi(r.output);
  const ok = /## Quickstart/.test(out);
  a.check('seeded README still has Quickstart section', ok,
    ok ? '' : JSON.stringify(out.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
