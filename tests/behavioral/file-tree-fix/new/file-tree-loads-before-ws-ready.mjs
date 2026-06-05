#!/usr/bin/env bun
// file-tree-fix/new/file-tree-loads-before-ws-ready — race-window
// HTML-shape assertions. The browser race (click Editor before
// ws.onopen fires) can't be driven from a WS probe directly, but we
// CAN assert the source-level invariants that make the bug impossible:
//
//   1. Editor.fsRequest does NOT reject synchronously on
//      WS-not-OPEN — it queues instead.
//   2. FileTree.fsRequest does the same.
//   3. ws.onopen drains both queues.
//   4. tree body shows a "Waiting for connection…" hint when the
//      first loadFolder fires before WS is open.
//
// Pre-fix the verbatim error was "fs-list failed: WS not connected"
// rendered into the tree-body. This probe ensures that string is
// no longer the user-visible failure for the race.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-fix/new/file-tree-loads-before-ws-ready');
console.log(`file-tree-fix/new/file-tree-loads-before-ws-ready — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// Pre-fix code: `if (!ws || ws.readyState !== WebSocket.OPEN)
//   return Promise.reject(new Error('WS not connected'));`
// Post-fix code: the same check exists but routes to outQueue.push.
// Assert NO Promise.reject('WS not connected') in fsRequest bodies.

// Strip comments (which still mention the string for documentation).
const stripped = html.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

a.check('No synchronous "WS not connected" rejection in fsRequest',
  !/Promise\.reject\(new Error\(['"]WS not connected['"]\)\)/.test(stripped),
  `synchronous reject still present in source`);

a.check('Loading hint shown when WS not yet open',
  /Waiting for connection/.test(html),
  `loading hint missing`);

a.check('Editor.fsRequest queues frames before WS opens',
  /outQueue\.push\(frame\)/.test(html),
  `Editor outQueue.push missing`);

a.check('Editor.drainFsQueue defined and exported',
  /function drainFsQueue\(\)/.test(html) && /Editor\.drainFsQueue/.test(html),
  `Editor.drainFsQueue not wired`);

a.check('FileTree.drainFsQueue defined and exported',
  /FileTree\.drainFsQueue/.test(html),
  `FileTree.drainFsQueue not wired`);

a.check('drainFsQueue is invoked from ws.onopen',
  /ws\.onopen\s*=[\s\S]{0,800}Editor\.drainFsQueue\(\)/.test(html),
  `onopen drain wiring missing for Editor`);
a.check('drainFsQueue is invoked from ws.onopen (FileTree)',
  /ws\.onopen\s*=[\s\S]{0,800}FileTree\.drainFsQueue\(\)/.test(html),
  `onopen drain wiring missing for FileTree`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
