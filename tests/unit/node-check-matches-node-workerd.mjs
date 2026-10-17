// @serial
// @tier slow — drives a local workerd session through every program.
// `node -c` (--check) checks a CommonJS program's syntax and does not run
// it, as Node 22's check_syntax.js does:
//   - a script, a script with a shebang, TypeScript's own text, and stdin
//     (CommonJS whatever its syntax, Node's warning before its SyntaxError),
//     its preloads run first, and its refusals with -e;
//   - text that would close the CommonJS wrapper's function (and run what
//     follows it there) is the SyntaxError Node reports, and runs nothing.
// A shebang script's lines are its own, checked or run (one that throws on
// its third line). The SyntaxErrors are inside the source: one at its end is
// reported at the CommonJS cell's wrapper, by a run as by a check
// (ticket-commonjs-eof-syntax-errors). One fixture tree, on disk for host
// node and in a local workerd session for the shell's `node`
// (lib/node-differential.mjs): each run's stdout, stderr and exit code must
// be node's.
//
// Then what is refused where Node checks an ES module: TypeScript whose
// module syntax Node retries as one (exit 0 there) exits 9 here, saying why,
// and runs nothing.
//
// Red before: the hosted node ran every program -c named, its wrapper could
// be closed by the program's text, and a shebang script's lines were each
// one less than the file's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const ROOT = '/home/user/chk';
const files = {
  'ok.js': 'console.log("ran");\n',
  'bad.js': 'const x = ;\nconsole.log("ran");\n',
  'shebang.js': '#!/usr/bin/env node\nconst x = ;\nconsole.log("ran");\n',
  'ok.ts': 'const a: number = 1;\nconsole.log("ran");\n',
  'pre.js': 'console.log("preloaded");\n',
  'throws.js': '#!/usr/bin/env node\n\nthrow new Error("on line three");\n',
  // Text that closes the wrapper's function, then calls console.log at the cell's top level.
  'close.cjs': '}; }); console.log("ran"); (0, function () { return function () {\n',
  'close-call.cjs': '}(), globalThis.console.log("ran"), function () {\n',
  // TypeScript whose first error compiling it as CommonJS is not of module syntax: Node's SyntaxError.
  'typed-export.cts': 'const a: number = 1;\nexport {};\n',
};

await matchNodeInWorkerd('node-check-matches-node-workerd', ROOT, files, [
  'node -c ok.js',
  'node --check bad.js',
  'node -c shebang.js',
  'node -c ok.ts',
  'node -r ./pre.js -c ok.js',
  "echo 'console.log(\"ran\")' | node -c",
  "echo 'const x = ;' | node -c",
  "echo 'export const a = 1' | node -c",
  'node -c -e 1',
  'node throws.js',
  'node -c close.cjs',
  'node -c close-call.cjs',
  'node -c typed-export.cts',
]);

// TypeScript of module syntax: Node retries it as an ES module and exits 0; here, exit 9 and why, nothing run.
const modules = {
  'm.mts': 'console.log("ran");\nexport const a = 1;\n',
  'n.ts': 'export const a: number = 1;\nconsole.log("ran");\n',
};
const hostDir = mkdtempSync(join(tmpdir(), 'node-check-modules-'));
try {
  for (const [name, text] of Object.entries(modules)) {
    writeFileSync(join(hostDir, name), text);
    const host = spawnSync('node', ['-c', name], { cwd: hostDir, encoding: 'utf8' });
    assert.deepEqual([host.status, host.stdout], [0, ''], `host node checks ${name} as an ES module, and runs nothing: ${host.stderr}`);
  }
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}
const REFUSED = 'node: -c cannot check an ES module entry in Nimbus without running it\n';
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    await session.run(`mkdir -p ${ROOT}`, 30_000);
    for (const [name, text] of Object.entries(modules)) await session.writeFile(`${ROOT}/${name}`, text);
    for (const name of Object.keys(modules)) {
      const r = await session.run(`cd ${ROOT} && node -c ${name} > out.txt 2> err.txt; echo "exit=$?"; cat out.txt; echo ---; cat err.txt`, 120_000);
      const text = r.stdout.replace(/\r/g, '');
      assert.match(text, /exit=9\n/, `node -c ${name}: exit 9 (${text})`);
      assert.ok(text.includes(`---\n${REFUSED}`), `node -c ${name}: says why (${text})`);
      assert.doesNotMatch(text, /\bran\b/, `node -c ${name}: nothing ran (${text})`);
      console.log(`  ok  node -c ${name}: refused, exit 9, nothing ran`);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-check-matches-node-workerd: ok');
