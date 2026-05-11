#!/usr/bin/env bun
// python/stdlib-import — Python stdlib modules import + work.
//
// Asserts that the python_stdlib.zip is properly mounted at
// /lib/python313.zip and the ZipImporter can resolve modules.
// Uses `json` (pure Python) for the test.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/stdlib-import');
console.log(`python/stdlib-import — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('nimbus install python', 180_000);

// `import json; print(json.dumps([1, 2]))` → `[1, 2]`
{
  const { output, elapsed } = await t.run(
    `python -c 'import json; print(json.dumps([1, 2]))'`, 120_000,
  );
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const has = lines.some((l) => l === '[1, 2]');
  a.check('json stdlib import works; json.dumps([1, 2]) → [1, 2]',
    has, has ? `elapsed=${elapsed}ms` : JSON.stringify(stripped.slice(-400)));
}

// `import re; print(re.sub(r"\\d+", "X", "a1b22c333"))` → `aXbXcX`
{
  const { output } = await t.run(
    `python -c 'import re; print(re.sub(r"\\d+", "X", "a1b22c333"))'`, 60_000,
  );
  const stripped = stripAnsi(output);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  const has = lines.some((l) => l === 'aXbXcX');
  a.check('re stdlib import works; re.sub → "aXbXcX"', has,
    has ? '' : JSON.stringify(stripped.slice(-400)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
