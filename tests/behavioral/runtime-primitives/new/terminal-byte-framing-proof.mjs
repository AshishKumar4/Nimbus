import { deleteSession, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';
const a = makeAsserter('terminal-byte-framing-proof');
const sid = await mintSession(), terminal = new Terminal(sid);
const streams = [];
try {
  await terminal.connect(); await terminal.waitForPrompt(60_000);
  for (const command of [
    'echo $$', 'echo $0',
    'printf "LEFT\\nRIGHT\\n"; echo DONE',
    'printf "  File <module>\\nFINAL_ERROR\\n"',
    'mkdir -p /tmp/frame-proof; echo KEEP > /tmp/frame-sibling; echo x > /tmp/frame-proof/a; rm -rf /tmp/frame-proof; test ! -e /tmp/frame-proof; echo REMOVED=$?; cat /tmp/frame-sibling',
  ]) {
    const frames = [];
    const record = data => { const frame = JSON.parse(data.toString()); if (frame.type === 'output') frames.push(Buffer.from(frame.data)); };
    terminal.ws.on('message', record);
    try { await terminal.run(command, 120_000); }
    finally { terminal.ws.off('message', record); }
    streams.push({ command, bytes: Buffer.concat(frames).toString('base64'), frames: frames.map(frame => frame.length) });
    a.check(`command completed: ${command}`, frames.length > 0);
  }
  console.log('TERMINAL_BYTE_STREAMS ' + JSON.stringify(streams));
} finally {
  await terminal.close();
  const deleted = await deleteSession(sid);
  a.check('session deleted', deleted.ok, deleted.body.slice(-200));
}
process.exit(a.summary().fail ? 1 : 0);
