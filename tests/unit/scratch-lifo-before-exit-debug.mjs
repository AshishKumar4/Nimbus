#!/usr/bin/env bun
// Scratch: the shell's node with a capped beforeExit, to see what runs its loop again.
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';
const LINES = [
  `node -e 'let n = 0; process.on("beforeExit", () => { if (++n > 4) process.exit(9); console.error("be", n) })'; echo "status=$?"`,
  `node -e 'let n = 0; process.on("beforeExit", () => { if (++n > 4) process.exit(9) })'; echo "status=$?"`,
  `node -e 'let n = 0; process.on("beforeExit", () => { if (++n > 4) process.exit(9) }); console.log("main")'; echo "status=$?"`,
  `node -e 'console.log(process.stdout.fd)' > /dev/full; echo "full=$?"`,
  `node -e 'process.stdout.once("error", (e) => { console.error("once", e.code); process.exitCode = 3 }); process.stdout.write("x\\n")' > /dev/full; echo "full=$?"`,
];
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  for (const line of LINES) {
    const t = performance.now();
    const r = await ws.exec(line, { cwd: '/home/user', timeout: 8_000 });
    console.log(JSON.stringify({ line: line.slice(0, 90), ms: Math.round(performance.now() - t), stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 300), exitCode: r.exitCode }));
  }
} finally {
  await ws.close();
}
process.exitCode = 1;
