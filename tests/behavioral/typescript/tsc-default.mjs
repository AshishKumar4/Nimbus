#!/usr/bin/env bun
// typescript/tsc-default — `tsc` with no TypeScript in the project runs tsrs,
// the Rust port of TypeScript 7 built to wasm, as a WASI process: it reports
// a type error as tsc does (exit 2), emits JavaScript for a clean project,
// and refuses --watch, which its wasm build lacks. A project that installs
// its own `typescript` runs that one (a native one: bin-tsc-native).

import { mintSession, deleteSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('typescript/tsc-default');
const sid = await mintSession();
const t = new Terminal(sid);
const run = async (line, timeout = 240_000) => {
  const { output, exitCode, elapsed } = await t.run(line, timeout);
  return { output: stripAnsi(output), exitCode, elapsed };
};
const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, rootDir: 'src', outDir: 'out' }, include: ['src'] });

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await run('mkdir -p plain/src && cd plain');
  await t.writeFile('tsconfig.json', TSCONFIG);
  await t.writeFile('src/greet.ts', 'export const greet = (who: string): string => `hello ${who}`;\n');
  await t.writeFile('src/bad.ts', 'export const n: number = "seven";\n');

  {
    const { output, exitCode } = await run('tsc --version');
    a.check('tsc with no typescript installed is tsrs', exitCode === 0 && /\(tsrs 0\.18\.0-ts7\.1\.0-dev\.20260929/.test(output), output.slice(-400));
  }
  {
    const { output, exitCode } = await run('tsc --noEmit');
    a.check('a type error is reported as tsc reports it', /src\/bad\.ts\(1,14\): error TS2322: Type 'string' is not assignable to type 'number'\./.test(output), output.slice(-600));
    a.check('and the run exits 2', exitCode === 2, `exit ${exitCode}`);
  }
  {
    await t.writeFile('src/bad.ts', 'export const n: number = 7;\n');
    const { output, exitCode } = await run('tsc');
    a.check('a clean project compiles', exitCode === 0, output.slice(-600));
    const emitted = await run('cat out/greet.js out/bad.js');
    a.check('and its JavaScript is emitted', emitted.output.includes('export const greet = (who) => `hello ${who}`;') && emitted.output.includes('export const n = 7;'), emitted.output.slice(-600));
  }
  {
    const { output, exitCode } = await run('npx tsc --version');
    a.check('npx tsc runs the same tsrs', exitCode === 0 && /\(tsrs 0\.18\.0/.test(output), output.slice(-400));
  }
  {
    const { output, exitCode } = await run('tsc --watch');
    a.check('--watch is refused, naming the way through', exitCode === 1 && /npm i -D typescript/.test(output), `exit ${exitCode}: ${output.slice(-400)}`);
  }

  await run('cd .. && mkdir -p pinned/src && cd pinned && echo \'{"name":"pinned","private":true}\' > package.json');
  await t.writeFile('tsconfig.json', TSCONFIG);
  await t.writeFile('src/bad.ts', 'export const n: number = "seven";\n');
  {
    const install = await run('npm i -D typescript@6.0.3', 300_000);
    a.check('typescript 6.0.3 installs in the project', install.exitCode === 0, install.output.slice(-600));
    const { output, exitCode } = await run('tsc --version');
    a.check('the project\'s own typescript runs as pinned', exitCode === 0 && /^Version 6\.0\.3\s*$/m.test(output), output.slice(-400));
    const checked = await run('tsc --noEmit');
    a.check('and reports the error itself', checked.exitCode !== 0 && /error TS2322/.test(checked.output), checked.output.slice(-600));
  }

  {
    const { output, exitCode } = await run('cd / && tsrs --version');
    a.check('tsrs runs by its own name too', exitCode === 0 && /\(tsrs 0\.18\.0/.test(output), output.slice(-400));
  }
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
