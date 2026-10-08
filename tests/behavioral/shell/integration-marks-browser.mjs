#!/usr/bin/env bun
import { mintSession, deleteSession, makeAsserter, stripAnsi, BASE } from '../_driver.mjs';
import {
  launchBrowser, applyProbeCookies, exchangeAttachCookie,
  sessionTerminalText, waitForSessionTerminalText,
} from '../_runtime-behavioral-template.mjs';

const a = makeAsserter('shell/integration-marks-browser');
const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
const page = await browser.newPage();
const marks = (raw) => [...raw.matchAll(/\x1b\]133;([ABCD](?:;\d+)?)\x07/g)].map((m) => m[1]);
let raw = '';
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
cdp.on('Network.webSocketFrameReceived', ({ response }) => {
  const frame = JSON.parse(response.payloadData);
  if (frame.type === 'output') raw += frame.data;
});

async function execute(line) {
  return page.evaluate((command) => new Promise((resolve, reject) => {
    let output = '';
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', receive); };
    const receive = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type !== 'output') return;
      output += frame.data;
      if (output.includes('\x1b]133;B\x07')) { cleanup(); resolve(output); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('shell sent no B in 15 s')); }, 15_000);
    ws.addEventListener('message', receive);
    ws.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
  }), line);
}

try {
  await applyProbeCookies(page);
  await exchangeAttachCookie(page, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSessionTerminalText(page, /user@nimbus:/, 60_000);
  a.check('a real shell prompt carries A and B', marks(raw).includes('A') && marks(raw).includes('B'), JSON.stringify(marks(raw)));
  await page.evaluate(() => {
    globalThis.shellProbeRaw = '';
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === 'output') globalThis.shellProbeRaw += frame.data;
    });
  });
  const readRaw = () => page.evaluate(() => globalThis.shellProbeRaw);

  const echo = await execute('echo SHELL_IMAGE');
  a.check('a command produces one execution, one status and one prompt',
    JSON.stringify(marks(echo)) === JSON.stringify(['C', 'D;0', 'A', 'B']), JSON.stringify(marks(echo)));
  const repeated = await execute('!!');
  a.check('history expansion repeats the user command, without a driver sentinel',
    /\r?\nSHELL_IMAGE\r?\n/.test(stripAnsi(repeated)) && marks(repeated).includes('D;0'), repeated);

  await page.evaluate(() => new Promise((resolve) => {
    term.options.cursorBlink = false;
    term.write('\x1b[?25l', () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const terminal = await page.$('#terminal-container');
  const beforeText = await sessionTerminalText(page);
  const before = Buffer.from(await terminal.screenshot({ type: 'png' }));
  await page.evaluate(() => new Promise((resolve) => {
    term.write('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;7\x07',
      () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const after = Buffer.from(await terminal.screenshot({ type: 'png' }));
  a.check('xterm renders no text or pixels for OSC 133 marks',
    beforeText === await sessionTerminalText(page) && before.equals(after),
    `before=${before.length} bytes after=${after.length} bytes`);
  console.log(`SCREENSHOT_BEFORE ${before.toString('base64')}`);
  console.log(`SCREENSHOT_AFTER ${after.toString('base64')}`);

  let cursor = (await readRaw()).length;
  await page.setViewport({ width: 1100, height: 720 });
  await execute('echo RESIZED');
  const resized = (await readRaw()).slice(cursor);
  a.check('resize adds no command-end mark',
    marks(resized).filter((mark) => mark.startsWith('D')).length === 1, JSON.stringify(marks(resized)));

  cursor = (await readRaw()).length;
  await page.evaluate(() => ws.send(JSON.stringify({ type: 'input', data: '\x0c' })));
  await execute('echo CLEARED');
  const cleared = (await readRaw()).slice(cursor);
  a.check('Ctrl-L adds no command-end mark',
    marks(cleared).filter((mark) => mark.startsWith('D')).length === 1, JSON.stringify(marks(cleared)));

  await execute('sleep 0.1 &');
  const notice = await execute('sleep 1');
  a.check('a background-job notice appears without an extra command-end mark',
    /\[\d+\] Done\s+sleep 0\.1/.test(notice)
      && JSON.stringify(marks(notice)) === JSON.stringify(['C', 'D;0', 'A', 'B']), notice);
} finally {
  await browser.close();
  const deleted = await deleteSession(sid);
  a.check('probe session deleted', deleted.ok, `status=${deleted.status}`);
}
process.exit(a.summary().fail ? 1 : 0);
