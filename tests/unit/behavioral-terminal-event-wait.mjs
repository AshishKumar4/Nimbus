#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Terminal } from '../behavioral/_driver.mjs';
const terminal = new Terminal('test', { wsOptions: {} });
terminal.ws = new EventEmitter();
const at = performance.now();
const wait = terminal.waitFor((text) => text.endsWith('$ '), 500, 'prompt');
setTimeout(() => { terminal.buf = 'done\n$ '; terminal.ws.emit('message', Buffer.from('{}')); }, 5);
await wait;
assert.ok(performance.now() - at < 30, 'a completed launch must not pay a 50 ms terminal polling tick');
assert.equal(terminal.ws.listenerCount('message'), 0, 'completed waits release listeners');
console.log('behavioral-terminal-event-wait: prompt arrival resolves without polling');
