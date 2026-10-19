#!/usr/bin/env bun
// file-tree-fix/new/file-tree-retries-failed-root — a first listing of the
// tree's root that fails leaves the tree unloaded, so the next time the
// Editor surface is selected it asks again and lists the session's files.
//
// Driven in a real Chrome: the page's shell socket is wrapped before any of
// its scripts run, and the answer to the first root listing it sends is
// turned into an error (a session that could not list it), every other
// frame passing as it is. The tree shows the error; selecting Agent, then
// Editor (no manual refresh) must send a second root listing and show the
// session's file.
// Red before: the tree recorded itself loaded whether or not its root had
// loaded, so it never asked again and kept the error until Refresh.
//
// The failure stays shown until the root loads: filtering the tree, or the
// editor opening a file (its default welcome page selects itself in the
// tree), drew the unloaded root as "Empty", which reads as a session with
// no files. That raced the probe's first check (2 of 51 runs).

import { BASE, Terminal, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/file-tree-retries-failed-root');
console.log(`file-tree-fix/new/file-tree-retries-failed-root — ${process.env.BASE}`);

/** Runs before the shell's scripts: the shell socket, with the first root listing's answer turned into an error. */
function failFirstRootListing() {
  const Real = window.WebSocket;
  const seen = { rootListings: 0, failed: null };
  window.__probeRoot = seen;
  function Wrapped(url, protocols) {
    const at = new URL(url, location.href);
    if (!/\/s\/[^/]+\/ws$/.test(at.pathname) || at.search) return new Real(url, protocols);
    const real = new Real(url, protocols);
    const send = real.send.bind(real);
    real.send = (data) => {
      try {
        const frame = JSON.parse(data);
        if (frame?.type === 'fs-list' && frame.dir === '/home/user') {
          seen.rootListings++;
          if (seen.failed === null) seen.failed = frame.reqId;
        }
      } catch {}
      return send(data);
    };
    let onmessage = null;
    Object.defineProperty(real, 'onmessage', {
      get: () => onmessage,
      set: (handler) => {
        onmessage = handler;
        Reflect.apply(Object.getOwnPropertyDescriptor(Real.prototype, 'onmessage').set, real, [handler && ((event) => {
          let message = null;
          try { message = JSON.parse(event.data); } catch {}
          if (message?.type === 'fs-list-result' && message.reqId === seen.failed && !seen.answered) {
            seen.answered = true;
            const { entries: _entries, ...rest } = message;
            return handler.call(real, new MessageEvent('message', { data: JSON.stringify({ ...rest, error: 'probe: the listing failed' }) }));
          }
          return handler.call(real, event);
        })]);
      },
    });
    return real;
  }
  Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Wrapped.prototype = Real.prototype;
  window.WebSocket = Wrapped;
}

const sid = await mintSession();
const FILE = `retry-${Date.now().toString(36)}.txt`;
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run(`touch /home/user/${FILE}`, 10_000);
await t.close();

const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.evaluateOnNewDocument(failFirstRootListing);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const failed = await page.waitForFunction(() => /probe: the listing failed/.test(document.getElementById('treeBody')?.textContent ?? ''),
    { timeout: 60_000 }).then(() => true, () => false);
  a.check('the failed root listing is shown', failed, await page.$eval('#treeBody', (el) => el.textContent));
  await page.type('#treeSearch', 'x');
  await page.$eval('#treeSearch', (input) => { input.value = ''; input.dispatchEvent(new Event('input')); });
  const kept = await page.$eval('#treeBody', (el) => el.textContent);
  a.check('and stays shown as the tree is filtered, not drawn as an empty root', /probe: the listing failed/.test(kept), kept);

  await page.click('#btnAgent');
  await page.click('#btnEditor');
  const listed = await page.waitForFunction(
    (file) => [...document.querySelectorAll('#treeBody .tree-node')].some((n) => n.dataset.path?.endsWith(`/${file}`)),
    { timeout: 30_000 }, FILE).then(() => true, () => false);
  const after = await page.evaluate(() => ({
    rootListings: window.__probeRoot.rootListings,
    rows: [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path).slice(0, 20),
    tree: document.getElementById('treeBody').textContent.slice(0, 200),
  }));
  a.check('selecting the Editor again asks for the root again', after.rootListings >= 2, JSON.stringify(after));
  a.check("and lists the session's files", listed, JSON.stringify(after));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
