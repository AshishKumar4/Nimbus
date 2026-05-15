#!/usr/bin/env bun
// seed-refresh/new/seeded-docs-mentions-multilang — the seeded React
// starter's Docs.tsx page MUST surface the multi-language story so
// new users browsing the `/docs` route in the preview pane discover
// clang/python/ruby + `nimbus install` without leaving the UI.
//
// Pre-fix Docs.tsx had 4 sections (Open the terminal / Install
// packages / Clone a real repo / Ship) — all JS-stack focused, no
// runtime-pkg-manager mention.
//
// Category: H (structural — the user-visible bug is "I never knew
// nimbus could compile C / run Python because the Docs page doesn't
// say so"). Asserts on the seeded source file content rather than
// driving the Vite preview through Chrome, because the user could
// equally well read the file via `cat` or click through GitHub —
// the assertion is "the docs are wired to surface these features".

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('seed-refresh/seeded-docs-mentions-multilang');
console.log(`seed-refresh/seeded-docs-mentions-multilang — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Docs.tsx
{
  const { output } = await t.run('cat /home/user/app/src/pages/Docs.tsx', 15_000);
  const out = stripAnsi(output);

  a.check('Docs.tsx has a "Compile native code" section', /Compile native code/.test(out),
    out.slice(-500));
  a.check('Docs.tsx has a "Run Python and Ruby" section', /Run Python and Ruby/.test(out),
    out.slice(-500));
  a.check('Docs.tsx has an "Install more runtimes" section', /Install more runtimes/.test(out),
    out.slice(-500));
  a.check('Docs.tsx mentions `nimbus install`',     /nimbus install/.test(out), out.slice(-500));
  a.check('Docs.tsx mentions Pyodide',              /Pyodide/.test(out),         out.slice(-500));
  a.check('Docs.tsx mentions ruby.wasm',            /ruby\.wasm/.test(out),      out.slice(-500));
}

// Home.tsx — the landing card grid should now feature multi-language.
{
  const { output } = await t.run('cat /home/user/app/src/pages/Home.tsx', 15_000);
  const out = stripAnsi(output);
  a.check('Home.tsx hero features a "Multi-language" card', /Multi-language/.test(out),
    out.slice(-500));
  a.check('Home.tsx Multi-language card mentions clang+python+ruby together',
    /clang/.test(out) && /python/.test(out) && /ruby/.test(out),
    out.slice(-500));
}

// README.md — Beyond JS section.
{
  const { output } = await t.run('cat /home/user/app/README.md', 15_000);
  const out = stripAnsi(output);
  a.check('starter README has "Beyond JS" section', /## Beyond JS/.test(out), out.slice(-500));
  a.check('starter README shows the clang demo command', /clang ~\/hello\.c -o hello/.test(out),
    out.slice(-500));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
