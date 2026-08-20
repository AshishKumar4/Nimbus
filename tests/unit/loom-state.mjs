#!/usr/bin/env bun
// State sync: `initialState` / `this.state` / `setState` persisted in the
// actor's SQLite and broadcast as `cf_agent_state` frames (the Agents SDK
// protocol, verified in agents 0.20.1 dist):
//
//   - validateStateChange is a SYNCHRONOUS veto that runs before anything
//     persists; a refused connection update earns the sender a
//     cf_agent_state_error frame and nothing else changes.
//   - a client update broadcasts to every OTHER connection (the sender
//     already has the state it sent) and reaches onStateChanged with the
//     connection as its source; server-side setState broadcasts to all.
//   - state survives an incarnation swap: it lives in the row, not the
//     instance.
//   - everything that is not a loom protocol frame passes through to
//     onMessage untouched.

import assert from 'node:assert/strict';
import {
  loadLoom,
  createActorCtx,
  fakeSocket,
  attachSocket,
  frames,
  lastFrame,
} from './lib/loom-harness.mjs';

const { Actor } = await loadLoom();

class Counter extends Actor {
  static options = { hibernate: true };
  initialState = { count: 0 };
  changes = [];
  passedThrough = [];
  validateStateChange(next, _source) {
    if (typeof next?.count !== 'number' || next.count < 0) throw new Error('count must be a non-negative number');
  }
  onStateChanged(state, source) {
    this.changes.push({ state, source: source === 'server' ? 'server' : source.id });
  }
  onMessage(_connection, message) {
    this.passedThrough.push(message);
  }
}

// ── 1. initialState serves reads; nothing persists until a set ─────────────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  assert.deepEqual(actor.state, { count: 0 });
  const rows = ctx.storage.sql.exec(`SELECT * FROM loom_state`);
  assert.equal([...rows].length, 0);
}

// ── 2. setState: persist, broadcast to all, notify with source 'server' ────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  const a = attachSocket(ctx, fakeSocket('conn-a'));
  const b = attachSocket(ctx, fakeSocket('conn-b'));

  actor.setState({ count: 3 });
  assert.deepEqual(actor.state, { count: 3 });
  assert.deepEqual(lastFrame(a), { type: 'cf_agent_state', state: { count: 3 } });
  assert.deepEqual(lastFrame(b), { type: 'cf_agent_state', state: { count: 3 } });
  assert.deepEqual(actor.changes, [{ state: { count: 3 }, source: 'server' }]);

  const [row] = ctx.storage.sql.exec(`SELECT state FROM loom_state WHERE id = 1`);
  assert.deepEqual(JSON.parse(row.state), { count: 3 });

  // A server-side set that fails validation throws at the caller.
  assert.throws(() => actor.setState({ count: -1 }), /non-negative/);
  assert.deepEqual(actor.state, { count: 3 });
}

// ── 3. A client update: echo to the others, source is the connection ───────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  const sender = attachSocket(ctx, fakeSocket('sender'));
  const other = attachSocket(ctx, fakeSocket('other'));

  await actor.webSocketMessage(sender, JSON.stringify({ type: 'cf_agent_state', state: { count: 7 } }));
  assert.deepEqual(actor.state, { count: 7 });
  assert.deepEqual(actor.changes, [{ state: { count: 7 }, source: 'sender' }]);
  assert.deepEqual(lastFrame(other), { type: 'cf_agent_state', state: { count: 7 } });
  // The sender is not echoed its own update.
  assert.equal(sender.sent.length, 0);
}

// ── 4. A refused client update: error frame to the sender, nothing else ────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  const sender = attachSocket(ctx, fakeSocket('sender'));
  const other = attachSocket(ctx, fakeSocket('other'));

  await actor.webSocketMessage(sender, JSON.stringify({ type: 'cf_agent_state', state: { count: -5 } }));
  assert.deepEqual(actor.state, { count: 0 });
  assert.deepEqual(lastFrame(sender), { type: 'cf_agent_state_error', error: 'State update rejected' });
  assert.equal(other.sent.length, 0);
  assert.deepEqual(actor.changes, []);
}

// ── 5. State lives in the row: the next incarnation reads it back ──────────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  actor.setState({ count: 42 });

  const wokenCtx = createActorCtx({ backing: ctx.backing });
  const woken = new Counter(wokenCtx, {});
  assert.deepEqual(woken.state, { count: 42 });
}

// ── 6. onConnect pushes the current state; a stateless actor stays quiet ───

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  actor.setState({ count: 9 });
  const conn = attachSocket(ctx, fakeSocket('late-joiner'));
  await actor.onConnect(conn, { request: new Request('http://test/parties/counter/x') });
  assert.deepEqual(frames(conn)[frames(conn).length - 1], { type: 'cf_agent_state', state: { count: 9 } });

  class Stateless extends Actor { static options = { hibernate: true }; }
  const quietCtx = createActorCtx();
  const quiet = new Stateless(quietCtx, {});
  assert.equal(quiet.state, undefined);
  const quietConn = attachSocket(quietCtx, fakeSocket('nobody'));
  await quiet.onConnect(quietConn, { request: new Request('http://test/parties/s/x') });
  assert.equal(quietConn.sent.length, 0);
}

// ── 7. Everything that is not a protocol frame reaches onMessage ───────────

{
  const ctx = createActorCtx();
  const actor = new Counter(ctx, {});
  const conn = attachSocket(ctx, fakeSocket('speaker'));

  await actor.webSocketMessage(conn, 'plain text');
  await actor.webSocketMessage(conn, '{"type":"my-own-frame","state":1}'.replace('my-own-frame', 'custom'));
  await actor.webSocketMessage(conn, '{not json');
  const binary = new Uint8Array([1, 2, 3]).buffer;
  await actor.webSocketMessage(conn, binary);
  assert.deepEqual(actor.passedThrough, ['plain text', '{"type":"custom","state":1}', '{not json', binary]);
}

// ── 8. An onStateChanged failure is contained, sync or async ────────────────

{
  const ctx = createActorCtx();
  class Grumpy extends Actor {
    initialState = { ok: true };
    onStateChanged() { return Promise.reject(new Error('hook exploded')); }
  }
  const actor = new Grumpy(ctx, {});
  actor.setState({ ok: false });
  await ctx.drainWaits();
  assert.deepEqual(actor.state, { ok: false });
}

{
  // A SYNC hook throw after a client update: the change persisted and
  // broadcast, so the sender must NOT be told the update was rejected.
  const ctx = createActorCtx();
  class SyncGrumpy extends Actor {
    static options = { hibernate: true };
    initialState = { n: 0 };
    onStateChanged() { throw new Error('sync hook exploded'); }
  }
  const actor = new SyncGrumpy(ctx, {});
  const sender = attachSocket(ctx, fakeSocket('sender'));
  const other = attachSocket(ctx, fakeSocket('other'));
  await actor.webSocketMessage(sender, JSON.stringify({ type: 'cf_agent_state', state: { n: 5 } }));
  assert.deepEqual(actor.state, { n: 5 });
  assert.deepEqual(lastFrame(other), { type: 'cf_agent_state', state: { n: 5 } });
  assert.equal(sender.sent.length, 0);
}

// ── 9. Undefined is refused as a state by name, not by an SQL error ─────────

{
  const ctx = createActorCtx();
  class Plain extends Actor { initialState = { ok: true }; }
  const actor = new Plain(ctx, {});
  assert.throws(() => actor.setState(undefined), /state must be JSON-serializable/);
  assert.deepEqual(actor.state, { ok: true });
}

console.log('loom-state: all assertions passed');
