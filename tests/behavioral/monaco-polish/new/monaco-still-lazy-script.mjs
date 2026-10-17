#!/usr/bin/env bun
// monaco-polish/new/monaco-still-lazy-script — Monaco loads when the
// Editor surface is first chosen, once, in a real Chrome. A shell opened
// on the Agent surface (?agent=1) requests nothing of Monaco; choosing
// Editor loads it and shows the welcome file; switching away and back
// loads it no second time. (The editor is the default surface, so a
// shell opened plainly loads Monaco at boot, which is that same choice.)

import { BASE, mintSession, deleteSession, makeAsserter } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/monaco-still-lazy-script');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  const monaco = [];
  page.on('request', (request) => { if (/monaco-editor/.test(request.url())) monaco.push(request.url()); });
  await page.goto(`${BASE}/s/${sid}/?agent=1`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('#agentPanel', { visible: true, timeout: 30_000 });
  a.check('a shell opened on the Agent surface requests nothing of Monaco',
    monaco.length === 0 && await page.evaluate(() => !window.__nimbusMonacoEditor), JSON.stringify(monaco));

  await page.click('#btnEditor');
  await page.waitForFunction(() => window.__nimbusMonacoEditor?.getValue().includes('Welcome to Nimbus'), { timeout: 60_000 });
  const loaders = () => monaco.filter((url) => url.endsWith('/vs/loader.min.js'));
  a.check('choosing Editor loads Monaco\'s loader once and shows the welcome file', loaders().length === 1, JSON.stringify(monaco));

  await page.click('#btnAgent');
  await page.waitForSelector('#agentPanel', { visible: true, timeout: 30_000 });
  await page.click('#btnEditor');
  await page.waitForSelector('#editorPanel .monaco-editor', { visible: true, timeout: 30_000 });
  a.check('switching away and back loads Monaco no second time', loaders().length === 1, JSON.stringify(loaders()));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
