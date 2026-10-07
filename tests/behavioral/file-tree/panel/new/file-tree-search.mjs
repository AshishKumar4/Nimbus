#!/usr/bin/env bun
// file-tree/panel/new/file-tree-search — typing in the tree's filter box
// narrows the tree to the paths that contain the text, says so when nothing
// matches, and clearing it brings every row back. Driven in a real Chrome
// against files the session wrote.

import { BASE, Terminal, deleteSession, makeAsserter, mintSession } from '../../../_driver.mjs';
import { launchBrowser, openPage } from '../../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree/panel/new/file-tree-search');
console.log(`file-tree/panel/new/file-tree-search — ${process.env.BASE}`);

const sid = await mintSession();
const stamp = Date.now().toString(36);
const ALPHA = `alpha-${stamp}.txt`;
const BETA = `beta-${stamp}.txt`;

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);
await t.run(`touch /home/user/${ALPHA} /home/user/${BETA}`, 10_000);
await t.close();

const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rows = () => page.evaluate(() =>
    [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path));
  const listed = await page.waitForFunction((alpha, beta) => {
    const paths = [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path);
    return paths.some((p) => p.endsWith(alpha)) && paths.some((p) => p.endsWith(beta));
  }, { timeout: 30_000 }, ALPHA, BETA).then(() => true, () => false);
  a.check('the tree lists both files', listed, JSON.stringify(await rows()));

  await page.type('#treeSearch', `alpha-${stamp}`);
  const narrowed = await page.waitForFunction((alpha) => {
    const paths = [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path);
    return paths.length > 0 && paths.every((p) => p.toLowerCase().includes(alpha));
  }, { timeout: 10_000 }, `alpha-${stamp}`).then(() => true, () => false);
  const shown = await rows();
  a.check('typing a name narrows the tree to the paths containing it',
    narrowed && shown.some((p) => p.endsWith(ALPHA)) && !shown.some((p) => p.endsWith(BETA)),
    JSON.stringify(shown));

  await page.click('#treeSearch', { clickCount: 3 });
  await page.type('#treeSearch', `nothing-is-called-this-${stamp}`);
  const empty = await page.waitForFunction(
    () => /No matches for/.test(document.querySelector('#treeBody .tree-empty')?.textContent ?? ''),
    { timeout: 10_000 }).then(() => true, () => false);
  a.check('a filter nothing matches says "No matches for …"', empty,
    await page.evaluate(() => document.getElementById('treeBody').textContent.slice(0, 200)));

  await page.click('#treeSearch', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  const restored = await page.waitForFunction((alpha, beta) => {
    const paths = [...document.querySelectorAll('#treeBody .tree-node')].map((n) => n.dataset.path);
    return paths.some((p) => p.endsWith(alpha)) && paths.some((p) => p.endsWith(beta));
  }, { timeout: 10_000 }, ALPHA, BETA).then(() => true, () => false);
  a.check('clearing the filter brings every row back', restored, JSON.stringify(await rows()));

  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
