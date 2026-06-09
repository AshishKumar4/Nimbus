#!/usr/bin/env bun
// python/flask-markupsafe-fallback — Flask installs and imports even when
// MarkupSafe ships an optional Pyodide extension module that Workers cannot
// dynamically instantiate at request time.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'python/flask-markupsafe-fallback';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

{
  const { output } = await t.run('pip install flask', 240_000);
  const stripped = stripAnsi(output);
  a.check('pip install flask completes',
    /Successfully installed flask/.test(stripped),
    JSON.stringify(stripped.slice(-1500)));
  a.check('pip install flask does not try to load MarkupSafe extension wasm',
    !/Failed to load MarkupSafe|Failed to load dynamic library|Wasm code generation disallowed/i.test(stripped),
    JSON.stringify(stripped.slice(-1500)));
}

{
  const { output } = await t.run(
    'python -c "import flask, markupsafe; print(\'FLASK_OK\'); print(markupsafe.escape(\'<nimbus>\'))"',
    120_000,
  );
  const stripped = stripAnsi(output);
  a.check('Flask and MarkupSafe import after install',
    /FLASK_OK/.test(stripped) && /&lt;nimbus&gt;/.test(stripped),
    JSON.stringify(stripped.slice(-1500)));
  a.check('import path does not attempt runtime wasm generation',
    !/Wasm code generation disallowed|Failed to load dynamic library/i.test(stripped),
    JSON.stringify(stripped.slice(-1500)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
