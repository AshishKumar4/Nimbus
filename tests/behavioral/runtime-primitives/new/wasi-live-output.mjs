import { mintSession, deleteSession, Terminal, makeAsserter, sleep } from '../../_driver.mjs';
import { terminalCommandRunner } from '../../../unit/lib/workerd-probe.mjs';
if (!process.env.BASE) throw new Error('BASE is required');
const a = makeAsserter('wasi-live-output');
const sid = await mintSession(), terminal = new Terminal(sid);
const read = (path) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { terminal.ws.off('message', answer); reject(new Error('fs-read timed out: ' + path)); }, 15_000);
  const answer = (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type !== 'fs-read-result' || frame.path !== path) return;
    clearTimeout(timeout); terminal.ws.off('message', answer); resolve(frame);
  };
  terminal.ws.on('message', answer);
  terminal.ws.send(JSON.stringify({ type: 'fs-read', path }));
});
try {
  await terminal.connect(); await terminal.waitForPrompt(60_000);
  const run = terminalCommandRunner(terminal);
  const installed = await run('nimbus install python', 900_000);
  a.check('Python runtime installed', installed.status === 0, installed.stdout.slice(-300));
  const code = 'import time\nfor i in range(16):\n  print("LIVE "+str(i),flush=True)\n  time.sleep(0.5)\nopen("/home/user/live-output.done","w").write("DONE")';
  const command = `python3 -c '${code}' > /home/user/live-output.log 2> /home/user/live-output.err &`;
  const launch = await run(command, 60_000);
  a.check('printing loop launched', launch.status === 0, launch.stdout);
  const deadline = Date.now() + 60_000;
  let output, done;
  for (;;) {
    output = await read('/home/user/live-output.log');
    done = await read('/home/user/live-output.done');
    if (output.content?.includes('LIVE 0') || done.content || Date.now() >= deadline) break;
    await sleep(100);
  }
  a.check('redirected output reaches the file while Python is still running',
    output.content?.includes('LIVE 0') && !done.content,
    JSON.stringify({ output, done, stderr: await read('/home/user/live-output.err') }));
  const binary = await run(`python3 -c 'import sys;sys.stdout.buffer.write(bytes([255,254]));sys.stdout.buffer.flush()' | xxd -p`, 60_000);
  a.check('Python binary stdout reaches a shell pipe without decoding', binary.status === 0 && /^fffe\s*$/m.test(binary.stdout), binary.stdout);
} finally {
  await terminal.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, cleanup.body.slice(-300));
}
const { fail } = a.summary(); process.exit(fail ? 1 : 0);
