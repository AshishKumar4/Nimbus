#!/usr/bin/env bun
// sdk/start-program — a session starts a program by its argv over the remote
// API (Kinu ask 67): startProgram resolves once the program runs, rejects
// with Node's spawn error when it cannot; its output streams as it is read;
// its exit is waitpid's; kill sends its signal; its input is bytes written
// with writeProcessInput, every value, more than a pipe holds, in order.
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sdk/start-program');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`start-program-${Date.now()}`);

async function finish(started) {
  const out = [];
  const err = [];
  for await (const chunk of started.output) (chunk.stream === 'stdout' ? out : err).push(chunk.data);
  const join = (parts) => { const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } return all; };
  return { out: join(out), err: new TextDecoder().decode(join(err)), exit: await started.exit };
}

try {
  let ran = await finish(await box.startProgram(['sh', '-c', 'echo hi; echo oops >&2; exit 3']));
  a.check('argv start: output, and its exit code', new TextDecoder().decode(ran.out) === 'hi\n' && ran.err === 'oops\n' && ran.exit.code === 3 && ran.exit.signal === null, JSON.stringify({ ...ran, out: new TextDecoder().decode(ran.out) }));

  let refused = null;
  try { await box.startProgram(['no-such-program']); } catch (error) { refused = error; }
  a.check('a start that cannot run: Node\'s spawn error', refused?.code === 'ENOENT' && refused?.syscall === 'spawn no-such-program' && refused?.path === 'no-such-program', String(refused?.message));

  const bytes = new Uint8Array(1024 * 1024 + 256);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  const stdin = new ReadableStream({ start(c) { for (let at = 0; at < bytes.length; at += 64 * 1024) c.enqueue(bytes.subarray(at, at + 64 * 1024)); c.close(); } });
  const cat = await box.startProgram(['cat'], { stdin });
  const echoed = [];
  for await (const chunk of cat.output) { echoed.push(chunk.data); await new Promise((r) => setTimeout(r, 2)); }
  const back = new Uint8Array(echoed.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of echoed) { back.set(p, at); at += p.length; }
  a.check('its input: every byte, in order, to a slow reader', back.length === bytes.length && back.every((b, i) => b === bytes[i]), `${back.length} of ${bytes.length}`);
  a.check('and it ends with its input', (await cat.exit).code === 0, '');

  const sleeper = await box.startProgram(['sleep', '600']);
  sleeper.kill('SIGTERM');
  ran = await finish(sleeper);
  a.check('kill: the program ends by its signal', ran.exit.code === null && ran.exit.signal === 'SIGTERM', JSON.stringify(ran.exit));
} finally {
  await box.destroy({ reason: 'start-program-complete' }).catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
