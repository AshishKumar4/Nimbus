#!/usr/bin/env bun
// Experiment (not for landing): what a clang compile+link and a tsc run ask of
// the session, in the session and from the peer, paired, 6 rounds: the
// resident filesystem's own count of its session calls and the wall it spent
// waiting on them (NIMBUS_WASI_FS_STATS=1).
import { mintSession, deleteSession, Terminal, heredocCommand } from '../_driver.mjs';
import { peer, warmFor, mark, hostsSince } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const KINDS = [
  { kind: 'clang', line: 'NIMBUS_WASI_FS_STATS=1 clang x.c -o x', tags: ['clang-runner-clang', 'clang-runner-wasm-ld'] },
  { kind: 'tsc', line: 'cd ~/tsp && NIMBUS_WASI_FS_STATS=1 tsc -p . --noEmit; cd ~', tags: ['tsrs'] },
];
const TS_FILES = Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`,
  `export interface Shape${i} { id: number; name: string }\nexport const all${i}: Shape${i}[] = Array.from({ length: 50 }, (_, k) => ({ id: k, name: 'm${i}-' + k }));\n`]);
const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install clang', heredocCommand('x.c', '#include <stdio.h>\nint main(void) { printf("%d\\n", 6 * 7); return 0; }\n'), 'mkdir -p ~/tsp/src',
    heredocCommand('tsp/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true }, include: ['src'] })),
    ...TS_FILES.map(([path, body]) => heredocCommand(`tsp/${path}`, body))]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  for (const { kind, line, tags } of KINDS) {
    await peer(sid, 'forget');
    await t.run(line, 600_000);
    for (let i = 1; i <= 6; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        if (host === 'session') await peer(sid, 'forget');
        else for (const tag of tags) await warmFor(sid, tag);
        const marked = await mark(sid);
        const started = Date.now();
        const r = await t.run(line, 600_000);
        const ms = Date.now() - started;
        const stats = [...r.output.matchAll(/\[wasi-fs\] (\S+)(?: wallMs=(\d+))? (\{.*\}|null)/g)].map((m) => ({ step: m[1], wallMs: m[2] ? Number(m[2]) : null, stats: JSON.parse(m[3]) }));
        out({ kind, round: i, host, ms, exit: r.exitCode, ranOn: await hostsSince(sid, marked), steps: stats });
      }
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
