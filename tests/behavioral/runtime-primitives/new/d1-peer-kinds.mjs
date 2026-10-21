#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): each kind of one-shot run in
// the session and on a warm peer session, paired within one session, with the
// session's thread watched from outside (a request every 100 ms while it runs).
// Node's one-shots are facets of the session, not moved: they are the control.
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';
import { out, heredoc, PY_IMPORTS, RB_REQUIRES, setHost, watched, sampleStats } from './_d1-lib.mjs';

const ROUNDS = 6;
const NEXT_ROUNDS = 3;
const KINDS = {
  'node print': 'node -e "console.log(1)"',
  'node burn': 'node -e "let h=0;for(let i=0;i<2e8;i++)h=Math.imul(h^i,16777619);console.log(h)"',
  'tsc noEmit': 'cd ~/tsp && tsc -p . --noEmit; cd ~',
  'git status mid': 'cd ~/repo && git status --short | wc -l; cd ~',
  'clang': 'clang x.c -o x',
  'python print': 'python3 -c "print(1)"',
  'python imports': `python3 -c "${PY_IMPORTS}"`,
  'ruby requires': `ruby -e "${RB_REQUIRES}"`,
};
const NEXT = ['git status next.js', 'cd ~/nx && git status --short | wc -l; cd ~'];
const TS_FILES = Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`,
  `export interface Shape${i} { id: number; name: string; tags: readonly string[] }\n` +
  `export function make${i}(id: number): Shape${i} { return { id, name: 'm${i}-' + id, tags: [String(id)] }; }\n` +
  `export const all${i}: Shape${i}[] = Array.from({ length: 50 }, (_, k) => make${i}(k));\n`]);
const CSRC = '#include <stdio.h>\n#include <string.h>\nint main(void) { char b[64]; snprintf(b, sizeof b, "%d", 42); puts(b); return (int)strlen(b) - 2; }\n';

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const setup = [
    'nimbus install python', 'nimbus install ruby', 'nimbus install clang',
    heredoc('x.c', CSRC),
    'mkdir -p ~/tsp/src',
    heredoc('tsp/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }) + '\n'),
    ...TS_FILES.map(([path, body]) => heredoc(`tsp/${path}`, body)),
    'mkdir -p ~/repo && cd ~/repo && git init -q && for i in $(seq 1 200); do echo "line $i" > f$i.txt; done && git add -A && git -c user.email=p@x -c user.name=p commit -qm one && for i in $(seq 1 20); do echo more >> f$i.txt; done; cd ~',
  ];
  for (const line of setup) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  const clone = await t.run('git clone --depth 1 https://github.com/vercel/next.js nx', 400_000);
  out({ kind: 'clone', exit: clone.exitCode, tail: clone.output.slice(-200) });
  const kinds = Object.entries(KINDS);
  if (clone.exitCode === 0) kinds.push(NEXT);

  const runOn = async (kind, line, host, phase, i) => {
    await setHost(sid, host === 'peer' ? 'kinds' : null);
    const w = await watched(sid, () => t.run(line, 600_000));
    out({ kind: phase, arm: kind, host, i, startedAt: w.startedAt, ms: w.ms, exit: w.value.exitCode,
      ...(phase === 'cold' ? { tail: w.value.output.slice(-160) } : {}), ...sampleStats(w.samples) });
  };
  for (const [kind, line] of kinds) for (const host of ['session', 'peer']) await runOn(kind, line, host, 'cold', 0);
  for (let i = 1; i <= ROUNDS; i++) {
    for (let k = 0; k < kinds.length; k++) {
      const [kind, line] = kinds[(k + i) % kinds.length];
      if (kind === NEXT[0] && i > NEXT_ROUNDS) continue;
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) await runOn(kind, line, host, 'warm', i);
    }
  }
  out({ kind: 'peer-stats', ...(await setHost(sid, 'kinds', true)) });
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await setHost(sid, null).catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
