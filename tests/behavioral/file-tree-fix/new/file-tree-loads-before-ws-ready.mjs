#!/usr/bin/env bun
// file-tree-fix/new/file-tree-loads-before-ws-ready — the file tree asks for
// its first listing before the shell's WebSocket has opened, and must wait
// for it instead of failing.
//
// The race, driven in a real Chrome: the page's shell socket is held in
// CONNECTING (the page's WebSocket is wrapped before any of its scripts run,
// and the real socket is only dialled when the probe releases it). While it
// is held the tree must show "Waiting for connection…" and must not have
// tried to send; once it opens, the queued fs-list must arrive and the tree
// list the session's files. At no point may the tree show a failure: pre-fix
// fsRequest rejected with "WS not connected" and the tree rendered
// "fs-list failed: WS not connected" for good.

import { BASE, Terminal, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/file-tree-loads-before-ws-ready');
console.log(`file-tree-fix/new/file-tree-loads-before-ws-ready — ${process.env.BASE}`);

const sid = await mintSession();
const FILE = `early-${Date.now().toString(36)}.txt`;
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run(`touch /home/user/${FILE}`, 10_000);
await t.close();

/** Runs in the page before its own scripts: holds the shell socket, records the tree. */
function holdShellSocket() {
  const Real = window.WebSocket;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const held = { sockets: 0, sendsWhileHeld: 0, treeTexts: [] };
  window.__probeHeld = held;
  window.__probeReleaseWs = () => release();
  function Held(url, protocols) {
    const at = new URL(url, location.href);
    // Only the session's shell socket (…/s/<sid>/ws, no query) is held.
    if (!/\/s\/[^/]+\/ws$/.test(at.pathname) || at.search) return new Real(url, protocols);
    held.sockets++;
    let real = null;
    let closed = false;
    const facade = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      get readyState() { return real ? real.readyState : closed ? Real.CLOSED : Real.CONNECTING; },
      get url() { return url; },
      send(data) {
        // What a real socket does while CONNECTING.
        if (!real) { held.sendsWhileHeld++; throw new DOMException('Still in CONNECTING state.', 'InvalidStateError'); }
        real.send(data);
      },
      close(code, reason) { if (real) real.close(code, reason); else closed = true; },
    };
    released.then(() => {
      if (closed) return;
      real = new Real(url, protocols);
      for (const type of ['open', 'message', 'close', 'error']) {
        real.addEventListener(type, (event) => facade[`on${type}`]?.call(facade, event));
      }
    });
    return facade;
  }
  Object.assign(Held, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Held.prototype = Real.prototype;
  window.WebSocket = Held;
  // Every text the tree body shows, as it shows it.
  let last = null;
  new MutationObserver(() => {
    const text = document.getElementById('treeBody')?.textContent ?? null;
    if (text !== null && text !== last) { last = text; held.treeTexts.push(text); }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}

const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.evaluateOnNewDocument(holdShellSocket);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const waiting = await page.waitForFunction(
    () => /Waiting for connection/.test(document.getElementById('treeBody')?.textContent ?? ''),
    { timeout: 30_000 }).then(() => true, () => false);
  const whileHeld = await page.evaluate(() => ({
    sockets: window.__probeHeld.sockets,
    sends: window.__probeHeld.sendsWhileHeld,
    readyState: ws?.readyState,
    tree: document.getElementById('treeBody').textContent,
  }));
  a.check('the shell socket is held in CONNECTING', whileHeld.sockets >= 1 && whileHeld.readyState === 0, JSON.stringify(whileHeld));
  a.check('before the socket opens the tree shows "Waiting for connection…"', waiting, JSON.stringify(whileHeld.tree));
  a.check('nothing is sent on a socket that is not open', whileHeld.sends === 0, `sends while held: ${whileHeld.sends}`);

  await page.evaluate(() => window.__probeReleaseWs());
  const listed = await page.waitForFunction(
    (file) => [...document.querySelectorAll('#treeBody .tree-node')].some((n) => n.dataset.path?.endsWith(`/${file}`)),
    { timeout: 30_000 }, FILE).then(() => true, () => false);
  const after = await page.evaluate(() => ({
    status: document.getElementById('statusDot')?.className,
    rows: [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path).slice(0, 20),
    texts: window.__probeHeld.treeTexts,
  }));
  a.check('once the socket opens the queued listing arrives and the tree lists the session\'s files', listed, JSON.stringify(after.rows));
  a.check('the shell reports itself connected', /\bconnected\b/.test(after.status ?? ''), String(after.status));
  const failure = after.texts.find((text) => /failed|not connected/i.test(text));
  a.check('the tree never shows a failure', failure === undefined, JSON.stringify(failure));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
