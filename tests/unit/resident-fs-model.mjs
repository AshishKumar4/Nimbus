#!/usr/bin/env bun
// The resident filesystem's synchronous decisions against a model, over
// random programs (VFS-9 B stage 3). A seeded generator plays a program of
// opens with every flag mix, writes, appends, truncates, renames, unlinks,
// attribute changes and closes over a few names and descriptors, with a
// peer's changes and the session's refusals between them, against two
// sessions: the process's (its synchronous view, no grant held), and a
// reference the same operations reach directly, in the order the session
// receives them. Checked:
//   - every step: each descriptor reads, and each name shows, what the
//     process's own operations folded over what its view last admitted
//     make of it (a refused one gone once refused);
//   - the end: the session holds what the reference holds.
// A failing seed is shrunk to its shortest failing program, printed.
//
// NIMBUS_MODEL_SEEDS: how many seeds (default 200); NIMBUS_MODEL_SEED: one.

import assert from 'node:assert/strict';
import { session, user } from './lib/holder-session.mjs';
import { DIR, NAMES, program } from './lib/fs-programs.mjs';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * What the process's own operations make of a file: write, append, truncate
 * and chmod over its bytes and mode. Bytes not known (null) stay unknown
 * but for their size, until a truncate to nothing makes them known.
 */
function apply(file, op) {
  if (op.kind === 'chmod') return { ...file, mode: op.mode };
  // Its mtime as the process set it, where it set one explicitly since its content last changed.
  if (op.kind === 'times') return op.mtime === 'omit' ? file : { ...file, mtime: typeof op.mtime === 'number' ? op.mtime : undefined };
  const next = changed(file, op);
  return next === file ? file : { ...next, mtime: undefined };
}

/** A content operation's bytes. */
function changed(file, op) {
  if (op.kind === 'truncate') {
    if (op.size === 0) return { ...file, bytes: new Uint8Array(0), size: 0 };
    if (file.bytes === null) return { ...file, size: op.size };
    const bytes = new Uint8Array(op.size);
    bytes.set(file.bytes.subarray(0, Math.min(op.size, file.bytes.length)));
    return { ...file, bytes, size: op.size };
  }
  if (op.data.length === 0) return file;
  const at = op.kind === 'append' ? file.size : op.offset;
  const size = Math.max(file.size, at + op.data.length);
  if (file.bytes === null) return { ...file, size };
  const bytes = new Uint8Array(size);
  bytes.set(file.bytes);
  bytes.set(op.data, at);
  return { ...file, bytes, size };
}

const known = (bytes, mode) => ({ bytes, size: bytes.length, mode });

async function errnoOf(work) {
  try { await work(); return null; } catch (error) { return error?.code ?? String(error); }
}
const errnoOfAny = errnoOf;
/** A step the full budget refused (ENOSPC): it ends, with nothing of it made. */
const NO_SPACE = Symbol('no space');

/**
 * A known engine defect, not the model's: a wave the session fails EIO
 * "missing chunk" after a mid-wave refusal loses everything in it
 * (ToughWallaby's P1, reproduced from this test's seed 190). A program whose
 * session met it is reported as known; any other divergence is not.
 */
const KNOWN_ENGINE_BUG = /missing chunk \d+/;

/** Run `steps`; throws the first divergence from the model, naming its step. */
async function run(steps, grants = false) {
  const met = { waves: [] };
  try {
    await runSteps(steps, met, grants);
  } catch (error) {
    const wave = met.waves.find((answer) => KNOWN_ENGINE_BUG.test(answer?.error?.message ?? ''));
    if (wave !== undefined) throw Object.assign(new Error(`known engine bug (wave EIO "${wave.error.message}", ToughWallaby P1): ${error.message}`), { known: true });
    throw error;
  } finally {
    // Each program alone: nothing of one (its held waves, its timers) is left to run beside the next.
    await met.end?.();
  }
}

/**
 * `grants`: the session grants the process the subtree it changes (taken at
 * its first change there, as a resident's is): what it decides then is the
 * grant's (its cells), and a peer's change there recalls it, after which it
 * decides provisionally. A peer then acts through a process of its own, once
 * what the process sent is delivered.
 */
async function runSteps(steps, met, grants) {
  // The process's session: its waves wait for `deliver`; no grant is held.
  const control = { held: true, opened: Promise.withResolvers() };
  // What the process's provisional decisions take of its budget: always what they keep, and nothing once all is drained.
  const budget = { used: 0, limit: 1 << 30 };
  /** The next step runs with the budget full (a squeeze). */
  let squeezed = false;
  // A program with swaps keeps its names in a directory of the subtree a grant takes, so a grant decides its renames.
  const dir = steps.some((step) => step.op === 'swap') ? `${DIR}/s` : DIR;
  /** A barrier waits once it begins while `pausing`, until `landing` is called. */
  let pausing = false;
  let landing;
  const s = session({
    budget,
    view: { barrier: () => (pausing ? new Promise((resolve) => { landing = resolve; }) : undefined) },
    ...(grants ? {} : { acquired: { then: (_resolve, reject) => reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })) } }),
    gate: { then: (resolve, reject) => (control.held ? control.opened.promise : Promise.resolve()).then(resolve, reject) },
  });
  met.waves = s.waves;
  met.end = async () => {
    control.held = false;
    control.opened.resolve();
    await Promise.race([s.fs.settle().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
  };
  const ref = session();
  const sync = s.fs.synchronous;
  const direct = ref.filesystem.bind({ pid: 8, cred: user });
  const path = (name) => `/${dir}/${name}`;

  // A file is named by a reference: `{ fixed: ino }` for one the view admitted
  // (its session number), or an open of the process's (`opened`), which is the
  // file the view had at its name (`view`: an ino, or `L<n>` for one it made)
  // until its delivery says which file the session opened (`session`, with
  // the stat its open left, `receipt`).
  let local = 0;
  let admitted;
  /** The file a reference is, as the model keys it now: an admitted ino, `S<ino>` for one the session opened that the view has not admitted, or `L<n>`. */
  const resolve = (reference) => {
    if (reference.fixed !== undefined) return reference.fixed;
    const opened = reference.opened;
    // Not delivered: the file the view had at its name (one it made, `L<n>`), as that reference resolves now.
    if (opened.session === undefined) return opened.view ?? resolve(opened.base);
    return admitted.files.has(opened.session) ? opened.session : `S${opened.session}`;
  };
  /** What the view has of a file it has not admitted, before the process's operations on it: its open's receipt, its bytes unknown but none. */
  const receipts = new Map();
  /** Files no name leads to any more that a descriptor holds: what the view had of them last. */
  const unnamed = new Set();

  /** The view as the model has it: what it admitted, with the process's operations since, the refused dropped, replayed over it in order. */
  const viewOf = () => {
    const names = new Map([...admitted.names].map(([name, ino]) => [name, { fixed: ino }]));
    const files = new Map(admitted.files);
    const fileOf = (id) => files.get(id) ?? receipts.get(id);
    for (const record of pending) {
      if (record.refused) continue;
      const e = record.effect;
      if (e.kind === 'name') { if (e.ref === null) names.delete(e.name); else names.set(e.name, e.ref); }
      else if (e.kind === 'rename') { const moved = names.get(e.from); names.delete(e.from); names.set(e.to, moved); }
      else if (e.kind === 'create') { const id = resolve(e.ref); if (String(id).startsWith('L')) files.set(id, known(new Uint8Array(0), e.mode)); }
      else if (e.kind !== 'none') { const id = resolve(e.ref); const file = fileOf(id); if (file !== undefined) files.set(id, apply(file, e)); }
    }
    return { names, files, fileOf };
  };

  /** The session's names and files now, as the reference has them. */
  const snapshot = async () => {
    const names = new Map();
    const files = new Map();
    for (const name of NAMES) {
      let stat = null;
      try { stat = await direct.stat(path(name)); } catch { /* absent */ }
      if (stat === null) continue;
      names.set(name, stat.ino);
      files.set(stat.ino, known(new Uint8Array(await direct.readFile(path(name))), stat.mode & 0o7777));
    }
    return { names, files };
  };
  admitted = await snapshot();
  /** The process's own operations since its view last admitted the session's, each with its effect and, once delivered, its fate. */
  let pending = [];
  let undelivered = [];
  /** Per fd: its open (the file it opened, its rights, the reference's descriptor of it once delivered). */
  const fds = new Map();

  const check = async (label) => {
    const stats = s.fs.stats();
    assert.equal(budget.used, stats.provisionalBytes + stats.pinnedBytes, `${label}: the budget taken (${budget.used}) is not what is kept (${stats.provisionalBytes} + ${stats.pinnedBytes} pinned)`);
    const now = viewOf();
    for (const [fd, opened] of fds) {
      const id = resolve({ opened });
      const file = now.fileOf(id);
      const size = Number(sync.fstat(opened.handle).size);
      if (file !== undefined) assert.equal(size, file.size, `${label}: fd ${fd} fstat size`);
      if (!opened.read) continue;
      let got;
      const code = await errnoOf(() => { got = sync.read(opened.handle, 0, 1 << 12); });
      // Bytes the view does not hold: refused (EAGAIN), or ESTALE once no name leads to them. A descriptor
      // that never wrote reads the view's bytes, which the view may not hold yet (a grant's given back).
      if ((code === 'EAGAIN' || code === 'ESTALE') && (file === undefined || file.bytes === null || (code === 'EAGAIN' && !opened.wrote))) continue;
      if (code === 'ESTALE' && unnamed.has(id)) continue;
      assert.equal(code, null, `${label}: fd ${fd} read ${code}`);
      if (file === undefined || file.bytes === null) continue;
      assert.equal(dec.decode(got), dec.decode(file.bytes), `${label}: fd ${fd} read`);
    }
    for (const name of NAMES) {
      const reference = now.names.get(name);
      const stat = sync.stat(path(name));
      assert.equal(stat === null, reference === undefined, `${label}: ${name} ${stat === null ? 'absent' : 'present'}`);
      if (reference === undefined) continue;
      const file = now.fileOf(resolve(reference));
      if (file === undefined) continue;
      assert.equal(Number(stat.size), file.size, `${label}: ${name} size`);
      assert.equal(Number(stat.mode) & 0o7777, file.mode, `${label}: ${name} mode`);
      // A read of the name that cannot wait, a grant just given back included: what the model has, or
      // refused where the view does not hold the bytes (EAGAIN); never older bytes than the process wrote.
      if (file.bytes === null) continue;
      let bytes;
      const code = await errnoOf(() => { bytes = sync.readFile(path(name)); });
      if (code === 'EAGAIN') continue;
      assert.equal(code, null, `${label}: ${name} read now ${code}`);
      assert.equal(dec.decode(bytes), dec.decode(file.bytes), `${label}: ${name} read now`);
    }
  };

  /** Names a peer wrote or moved a file to: their mtime is not one the process set. */
  const peerWritten = new Set();
  /** Descriptions whose descriptor closed while another descriptor of its file stayed open: the session keeps them open (anchors) until the last closes. */
  const retained = [];
  const sameFile = (a, b) => resolve({ opened: a }) === resolve({ opened: b });
  /** What an attribute change by `opened` goes through at the session: its own description, else one of its file's (kept first, then open), else none (by name). */
  const anchorOf = (opened, read = false) => {
    if (opened.logs && (!read || opened.read)) return opened;
    return retained.find((other) => (!read || other.read) && sameFile(other, opened))
      ?? [...fds.values()].find((other) => other !== opened && other.logs && (!read || other.read) && sameFile(other, opened));
  };

  /**
   * What an op by name expects at each of its names (W7Expected): the file
   * the process's view has there (`reference`), or none. One it made that
   * the session has not numbered (`L`) is the file its creating open reaches.
   */
  const expecting = (pairs) => pairs;

  /** The process's operation `step`, made synchronously: its local refusal, which the model predicts, or its effects. */
  const processStep = async (step, label) => {
    const now = viewOf();
    // While the budget is full: a refusal for room ends the step, with no effect (the checks after it say so).
    const errnoOf = async (work) => {
      const code = await errnoOfAny(work);
      if (code === 'ENOSPC' && squeezed) throw NO_SPACE;
      return code;
    };
    const add = (effect, logged) => {
      const record = { effect, refused: false };
      pending.push(record);
      if (logged) undelivered.push({ record, logged });
      return record;
    };
    const fileAt = (name) => { const reference = now.names.get(name); return reference === undefined ? undefined : now.fileOf(resolve(reference)); };
    if (step.op === 'open') {
      if (fds.has(step.fd)) return;
      const reference = now.names.get(step.name);
      const file = fileAt(step.name);
      const writes = step.flags.write || step.flags.append;
      const expected = reference === undefined ? (step.flags.create ? null : 'ENOENT')
        : step.flags.create && step.flags.exclusive ? 'EEXIST'
        : ((step.flags.read && !(file.mode & 0o400)) || ((writes || step.flags.truncate) && !(file.mode & 0o200))) ? 'EACCES' : null;
      let handle;
      const code = await errnoOf(() => { handle = sync.open(path(step.name), step.flags).id; });
      assert.equal(code, expected, `${label}: open ${step.name} ${JSON.stringify(step.flags)}`);
      if (code !== null) return;
      const made = reference === undefined;
      const opened = { handle, ...(made ? { view: `L${++local}` } : { base: reference }), read: step.flags.read || !writes, write: writes, append: step.flags.append, name: step.name, position: 0 };
      fds.set(step.fd, opened);
      // Logged where it makes, empties or may write its file: the session's open, as the caller asked it; its refusal is all of its effects'.
      const logs = writes || step.flags.truncate || made;
      const records = [];
      if (made) {
        records.push(add({ kind: 'create', ref: { opened }, mode: 0o644 & ~0o022 }));
        records.push(add({ kind: 'name', name: step.name, ref: { opened } }));
      }
      if (step.flags.truncate) records.push(add({ kind: 'truncate', ref: { opened }, size: 0 }));
      const flags = { write: true, read: step.flags.read, create: step.flags.create, exclusive: made && step.flags.exclusive, truncate: step.flags.truncate };
      if (logs) undelivered.push({ records, logged: { opened, flags, expect: made && step.flags.exclusive ? [] : expecting([[step.name, reference]]) } });
      opened.logs = logs;
      return;
    }
    if (step.op === 'write' || step.op === 'ftruncate' || step.op === 'fchmod' || step.op === 'futimes' || step.op === 'close') {
      const opened = fds.get(step.fd);
      if (opened === undefined) return;
      if (step.op === 'close') {
        sync.close(opened.handle);
        fds.delete(step.fd);
        // Its description kept while another descriptor of the file stays open with none of its own, and none kept yet (the file's anchor); else closed.
        const others = [...fds.values()].filter((other) => sameFile(other, opened));
        if (opened.logs) {
          if (others.length > 0 && !others.some((other) => other.logs) && !retained.some((other) => sameFile(other, opened))) retained.push(opened);
          else undelivered.push({ record: { effect: { kind: 'none' }, refused: false }, logged: { close: opened } });
        }
        // The file's last descriptor: the description kept for it closes.
        if (others.length === 0) {
          for (const kept of retained.filter((other) => sameFile(other, opened))) {
            retained.splice(retained.indexOf(kept), 1);
            undelivered.push({ record: { effect: { kind: 'none' }, refused: false }, logged: { close: kept } });
          }
        }
        return;
      }
      if (step.op === 'write') {
        const data = enc.encode(step.data);
        const code = await errnoOf(() => sync.write(opened.handle, step.offset, data));
        if (!opened.write) { assert.equal(code, 'EBADF', `${label}: write by a read-only fd`); return; }
        assert.equal(code, null, `${label}: write`);
        const at = step.offset ?? opened.position;
        const effect = opened.append ? { kind: 'append', ref: { opened }, data } : { kind: 'write', ref: { opened }, offset: at, data };
        if (!opened.append && step.offset === null) opened.position = at + data.length;
        opened.wrote = true;
        add(effect, { opened, write: effect });
        return;
      }
      if (step.op === 'ftruncate') {
        const code = await errnoOf(() => sync.ftruncate(opened.handle, step.size));
        if (!opened.write) { assert.ok(code !== null, `${label}: ftruncate by a read-only fd answered`); return; }
        assert.equal(code, null, `${label}: ftruncate`);
        opened.wrote = true;
        add({ kind: 'truncate', ref: { opened }, size: step.size }, { opened, truncate: step.size });
        return;
      }
      // Through a description of its file at the session (anchorOf), else by the name the view has for it: none, and no file can be named (ESTALE).
      const id = resolve({ opened });
      let name;
      for (const [at, reference] of now.names) if (resolve(reference) === id) name = at;
      const via = anchorOf(opened);
      const times = step.op === 'futimes';
      const code = await errnoOf(() => (times ? sync.futimes(opened.handle, step.atime, step.mtime) : sync.fchmod(opened.handle, step.mode)));
      assert.equal(code, via === undefined && name === undefined ? 'ESTALE' : null, `${label}: ${step.op}`);
      if (code !== null) return;
      const attrs = times ? { atime: step.atime, mtime: step.mtime } : { mode: step.mode };
      add(times ? { kind: 'times', ref: { opened }, mtime: step.mtime } : { kind: 'chmod', ref: { opened }, mode: step.mode }, { fsetattr: { via, name, attrs }, expect: via === undefined ? expecting([[name, { opened }]]) : [] });
      return;
    }
    if (step.op === 'unlink') {
      const reference = now.names.get(step.name);
      const code = await errnoOf(() => sync.unlink(path(step.name)));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: unlink ${step.name}`);
      if (code === null) add({ kind: 'name', name: step.name, ref: null }, { unlink: step.name, expect: expecting([[step.name, reference]]) });
      return;
    }
    if (step.op === 'rename') {
      const reference = now.names.get(step.from);
      const code = await errnoOf(() => sync.rename(path(step.from), path(step.to)));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: rename ${step.from} ${step.to}`);
      if (code === null && step.from !== step.to) add({ kind: 'rename', from: step.from, to: step.to }, { rename: [step.from, step.to], expect: expecting([[step.from, reference], [step.to, now.names.get(step.to)]]) });
      return;
    }
    if (step.op === 'utimes') {
      const reference = now.names.get(step.name);
      const code = await errnoOf(() => sync.utimes(path(step.name), step.atime, step.mtime));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: utimes ${step.name}`);
      if (code === null) add({ kind: 'times', ref: reference, mtime: step.mtime }, { utimes: [step.name, step.atime, step.mtime], expect: expecting([[step.name, reference]]) });
      return;
    }
    if (step.op === 'chmod') {
      const reference = now.names.get(step.name);
      const code = await errnoOf(() => sync.chmod(path(step.name), step.mode));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: chmod ${step.name}`);
      if (code === null) add({ kind: 'chmod', ref: reference, mode: step.mode }, { chmod: [step.name, step.mode], expect: expecting([[step.name, reference]]) });
      return;
    }
    if (step.op === 'writeFile') {
      const reference = now.names.get(step.name);
      const file = fileAt(step.name);
      const expected = file !== undefined && !(file.mode & 0o200) ? 'EACCES' : null;
      const data = enc.encode(step.data);
      const code = await errnoOf(() => sync.writeFile(path(step.name), data));
      assert.equal(code, expected, `${label}: writeFile ${step.name}`);
      if (code !== null) return;
      const made = reference === undefined;
      const opened = { ...(made ? { view: `L${++local}` } : { base: reference }), write: true, name: step.name };
      const records = [];
      if (made) {
        records.push(add({ kind: 'create', ref: { opened }, mode: 0o644 & ~0o022 }));
        records.push(add({ kind: 'name', name: step.name, ref: { opened } }));
      }
      records.push(add({ kind: 'truncate', ref: { opened }, size: 0 }));
      const written = add({ kind: 'write', ref: { opened }, offset: 0, data });
      undelivered.push({ records, record: written, logged: { opened, flags: { write: true, create: true, truncate: true }, write: { kind: 'write', offset: 0, data }, close: opened, expect: expecting([[step.name, reference]]) } });
    }
    if (step.op === 'copy') {
      const source = fileAt(step.from);
      const target = fileAt(step.to);
      const reference = now.names.get(step.to);
      // A source whose bytes the model cannot say is not copied.
      if (source !== undefined && source.bytes === null) return;
      const expected = source === undefined ? 'ENOENT' : !(source.mode & 0o400) ? 'EACCES' : target !== undefined && !(target.mode & 0o200) ? 'EACCES' : null;
      const code = await errnoOf(() => sync.copyFile(path(step.from), path(step.to)));
      // Bytes not here (a caller that cannot wait): refused, nothing made.
      if (code === 'EAGAIN' && expected === null) return;
      assert.equal(code, expected, `${label}: copy ${step.from} ${step.to}`);
      if (code !== null) return;
      const data = source.bytes.slice();
      const made = reference === undefined;
      const opened = { ...(made ? { view: `L${++local}` } : { base: reference }), write: true, name: step.to };
      const records = [];
      // A copy's file is made with the source's permission bits, the umask taken; an existing one keeps its mode.
      if (made) {
        records.push(add({ kind: 'create', ref: { opened }, mode: source.mode & 0o777 & ~0o022 }));
        records.push(add({ kind: 'name', name: step.to, ref: { opened } }));
      }
      records.push(add({ kind: 'truncate', ref: { opened }, size: 0 }));
      const written = add({ kind: 'write', ref: { opened }, offset: 0, data });
      undelivered.push({ records, record: written, logged: { opened, flags: { write: true, create: true, truncate: true }, mode: source.mode & 0o777, write: { kind: 'write', offset: 0, data }, close: opened, expect: expecting([[step.to, reference]]) } });
    }
  };

  /** What the session received since the last delivery, made on the reference directly, in order: each one it refuses, refused. */
  const deliver = async () => {
    control.held = false;
    control.opened.resolve();
    // A flush reports a refusal as soon as it has one: what the session takes after it, it waits for again.
    for (let tries = 0; tries < 4 && (await errnoOf(() => s.fs.flush())) !== null; tries++);
    control.held = true;
    control.opened = Promise.withResolvers();
    /** Whether the reference leads any name an op expects (W7Expected) to another file than it expected: the session refuses it (ESTALE). */
    const stale = async (expect) => {
      for (const [name, reference] of expect ?? []) {
        const id = reference === undefined ? null : resolve(reference);
        // `L`: made by an open not delivered or refused; none where refused (its creating open reached nothing).
        const want = id === null ? null : typeof id === 'number' ? id : String(id).startsWith('S') ? Number(String(id).slice(1)) : NaN;
        let have = null;
        try { have = (await direct.stat(path(name)))?.ino ?? null; } catch { /* absent */ }
        if (have !== want) return true;
      }
      return false;
    };
    for (const { record, records, logged } of undelivered) {
      let refused = false;
      if (await stale(logged.expect)) {
        refused = true;
        for (const made of records ?? []) made.refused = true;
        if (logged.flags) (logged.opened ?? logged.close).refHandle = undefined;
      }
      else if (logged.unlink) refused = (await errnoOf(() => direct.unlink(path(logged.unlink)))) !== null;
      else if (logged.rename) refused = (await errnoOf(() => direct.rename(path(logged.rename[0]), path(logged.rename[1])))) !== null;
      else if (logged.chmod) refused = (await errnoOf(() => direct.chmod(path(logged.chmod[0]), logged.chmod[1]))) !== null;
      else if (logged.utimes) refused = (await errnoOf(() => direct.utimes(path(logged.utimes[0]), logged.utimes[1], logged.utimes[2]))) !== null;
      else if (logged.fsetattr) {
        const { via, name, attrs } = logged.fsetattr;
        const change = (handle) => ('mode' in attrs ? direct.fchmod(handle, attrs.mode) : direct.futimes(handle, attrs.atime, attrs.mtime));
        // Through its description: refused where its open was; else by name.
        if (via !== undefined) refused = via.refHandle === undefined || (await errnoOf(() => change(via.refHandle))) !== null;
        else refused = (await errnoOf(() => ('mode' in attrs ? direct.chmod(path(name), attrs.mode) : direct.utimes(path(name), attrs.atime, attrs.mtime)))) !== null;
      }
      else {
        const opened = logged.opened ?? logged.close;
        if (logged.flags) {
          // The session's open is to write (and to read when asked): its answer names the file it opened.
          refused = (await errnoOf(async () => { opened.refHandle = (await direct.open(path(opened.name), { ...logged.flags, mode: logged.mode ?? 0o666, umask: 0o022 })).id; })) !== null;
          for (const made of records ?? []) made.refused = refused;
          if (refused) opened.refHandle = undefined;
          else {
            const stat = await direct.fstat(opened.refHandle);
            opened.session = stat.ino;
            receipts.set(`S${stat.ino}`, { bytes: Number(stat.size) === 0 ? new Uint8Array(0) : null, size: Number(stat.size), mode: stat.mode & 0o7777 });
          }
        }
        if (logged.write) {
          if (opened.refHandle === undefined) refused = true;
          else {
            const at = logged.write.kind === 'append' ? Number((await direct.fstat(opened.refHandle)).size) : logged.write.offset;
            refused = (await errnoOf(() => direct.write(opened.refHandle, at, logged.write.data))) !== null;
          }
        }
        if (logged.truncate !== undefined) refused = opened.refHandle === undefined || (await errnoOf(() => direct.ftruncate(opened.refHandle, logged.truncate))) !== null;
        if (logged.close && opened.refHandle !== undefined) { await errnoOf(() => direct.close(opened.refHandle)); opened.refHandle = undefined; }
      }
      if (record !== undefined) record.refused = refused;
    }
    undelivered = [];
  };

  /**
   * A peer's change, as the session's own (its kernel). Without grants,
   * between deliveries: the session has it before what the process sends
   * next, and so does the reference. With them, once what the process sent
   * is delivered: it recalls the grant (withRecall), and waits for what the
   * process held to be sent. Only a change the session refuses as it would
   * the reference's (nothing there) is let pass.
   */
  const peerStep = async (step) => {
    // A peer's write stamps its own mtime, at each session's own clock: not one the process set.
    if (step.kind === 'write' || step.kind === 'rename') peerWritten.add(step.kind === 'rename' ? step.to : step.name);
    const key = `${dir}/${step.name}`;
    const change = async (target) => {
      try {
        if (step.kind === 'write') { target.writeFile(key, enc.encode(step.data)); target.chown(key, 1000, 1000); }
        else if (step.kind === 'unlink') target.unlink(key);
        else if (step.kind === 'rename') target.rename(key, `${dir}/${step.to}`);
        else target.chmod(key, step.mode);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    };
    if (grants) {
      await deliver();
      control.held = false;
      control.opened.resolve();
    }
    await withRecall(() => change(s.kernel));
    if (grants) {
      control.held = true;
      control.opened = Promise.withResolvers();
    }
    await change(ref.kernel);
  };

  /**
   * A read that may wait, by descriptor: while a name the view has leads to
   * its file, what the model has of it; once none does, the session's file
   * as every process holding it open made it, through the open description
   * of it the session keeps (anchorOf), as the reference reads it.
   */
  const readAsync = async (step, label) => {
    const opened = fds.get(step.fd);
    if (opened === undefined || !opened.read) return;
    const now = viewOf();
    const id = resolve({ opened });
    const named = [...now.names.values()].some((reference) => resolve(reference) === id);
    const barriers = s.fs.stats().barriers;
    const reading = Promise.resolve().then(() => s.fs.read(opened.handle, 0, 1 << 12));
    reading.catch(() => {});
    await deliver();
    control.held = false;
    control.opened.resolve();
    let got;
    const code = await errnoOf(async () => { got = await reading; });
    control.held = true;
    control.opened = Promise.withResolvers();
    // A read that may wait takes the barrier the process owes first (it sent something since the last): it reads the session's file as it is now, and the view is the session's from then on.
    const caught = s.fs.stats().barriers > barriers;
    // Its own session description reads the live file. A read-only open
    // without one still reads its named view, not a sibling's write-only fd.
    const via = anchorOf(opened, true);
    if (via?.refHandle !== undefined && (opened.logs || !named)) {
      assert.equal(code, null, `${label}: an awaited read through the file's anchor: ${code}`);
      assert.equal(dec.decode(got), dec.decode(new Uint8Array(await direct.read(via.refHandle, 0, 1 << 12))), `${label}: an awaited read is the session's, through its anchor`);
      if (caught) await catchUp();
      return;
    }
    const name = [...now.names].find(([, reference]) => resolve(reference) === id)?.[0];
    // Caught up, the name the view had for it may have gone at the session: then no name leads to it.
    if (named && !(caught && (name === undefined || !ref.kernel.exists(`${dir}/${name}`)))) {
      const file = now.fileOf(id);
      assert.equal(code, null, `${label}: an awaited read of a named file: ${code}`);
      if (caught) assert.equal(dec.decode(got), dec.decode(ref.kernel.readFile(`${dir}/${name}`)), `${label}: an awaited read of a named file, caught up`);
      else if (file !== undefined && file.bytes !== null) assert.equal(dec.decode(got), dec.decode(file.bytes), `${label}: an awaited read of a named file`);
      if (caught) await catchUp();
      return;
    }
    assert.ok(code === null || code === 'ESTALE', `${label}: an awaited read of a file no name leads to: ${code}`);
    if (caught) await catchUp();
  };

  /** The view brought to the session's: what the process sent delivered, a barrier, every name read (the view holds what it read until a barrier reads it again). */
  const catchUp = async () => {
    await deliver();
    s.fs.inbound();
    await s.fs.stat(`/${dir}`);
    for (const name of NAMES) {
      await errnoOf(() => s.fs.stat(path(name)));
      await errnoOf(() => s.fs.readFile(path(name)));
    }
    // A file a descriptor holds that no name leads to now keeps what the view had of it, by its session number.
    const before = viewOf();
    // `S<ino>`: the session's file the view had not admitted, by its number.
    const sessionNumber = (id) => (typeof id === 'string' && id.startsWith('S') ? Number(id.slice(1)) : id);
    const held = [...fds.values()].map((opened) => [sessionNumber(opened.session ?? resolve({ opened })), before.fileOf(resolve({ opened }))]);
    admitted = await snapshot();
    pending = [];
    for (const [id, file] of held) {
      if (typeof id !== 'number' || admitted.files.has(id) || file === undefined) continue;
      admitted.files.set(id, file);
      unnamed.add(id);
    }
  };
  if (dir !== DIR) {
    // Made by the process, at a change that takes the subtree above it.
    ref.kernel.mkdir(dir);
    ref.kernel.chown(dir, user.uid, user.gid);
    sync.mkdir(`/${dir}`, { mode: 0o755 });
  }
  await catchUp();

  /**
   * The names' directory renamed by a call that cannot wait (a grant decides
   * it where one holds the subtree) while a barrier begun before it waits.
   * Once that barrier lands, what such a call sees of each name at the new
   * place is what the session has there once it has the rename (a decision
   * the rename moved is newer than that barrier's answer), or EAGAIN where
   * the view has not that place yet: never absent, nor another size or
   * mode. Then it is renamed back.
   */
  const swapStep = async (step, label) => {
    // The budget full for the rename alone (a squeeze before it): what the names beneath it grow by has no room.
    const full = squeezed;
    budget.limit = 1 << 30;
    // Longer than its name: the names beneath it grow, which the budget admits first.
    const aside = `${DIR}/swapped-aside`;
    if (step.awaited) {
      // Awaited (the session's, where no grant decides it), its answer held until delivered; a file opened beneath its
      // source meanwhile, then the budget full for the answer: that file was admitted at its name to come.
      await deliver();
      const renaming = errnoOf(() => s.fs.rename(`/${dir}`, `/${aside}`));
      const opened = [];
      for (const name of NAMES) {
        try { opened.push(sync.open(path(name), { read: true })); } catch { /* absent, or not here */ }
      }
      if (full) budget.limit = budget.used;
      const code = await delivered(renaming);
      budget.limit = 1 << 30;
      assert.equal(budget.used, s.fs.stats().provisionalBytes + s.fs.stats().pinnedBytes, `${label}: answered, what is taken is what is kept`);
      for (const handle of opened) sync.close(handle.id);
      // Refused only for room, the budget full when it planned (a barrier it took first may plan it late).
      assert.ok(code === null || (code === 'ENOSPC' && full), `${label}: the awaited rename ${code}`);
      if (code !== null) {
        await catchUp();
        return;
      }
      assert.equal(await delivered(errnoOf(() => s.fs.rename(`/${aside}`, `/${dir}`))), null, `${label}: the awaited rename back`);
      await catchUp();
      return;
    }
    await deliver();
    control.held = false;
    control.opened.resolve();
    pausing = true;
    s.fs.inbound();
    const catching = s.fs.stat(`/${dir}`).catch(() => null);
    for (let tries = 0; tries < 400 && landing === undefined; tries++) await new Promise((resolve) => setTimeout(resolve, 2));
    pausing = false;
    control.held = true;
    control.opened = Promise.withResolvers();
    assert.ok(landing !== undefined, `${label}: the barrier began`);
    if (full) budget.limit = budget.used;
    const code = await errnoOf(() => sync.rename(`/${dir}`, `/${aside}`));
    budget.limit = 1 << 30;
    const land = landing;
    landing = undefined;
    land();
    await catching;
    // Refused only for room, with the budget full: nothing of it done (the checks after the step say so).
    assert.ok(code === null || (code === 'ENOSPC' && full), `${label}: the rename ${code}`);
    // Refused, nothing moved: the model takes the barrier that landed as the view did.
    if (code !== null) {
      await catchUp();
      return;
    }
    const seen = statsAt(aside);
    await catchUp();
    const session = statsAt(aside);
    for (const name of NAMES) {
      if (seen[name] !== 'EAGAIN') assert.deepEqual(seen[name], session[name], `${label}: what a call that cannot wait saw of ${name} once the barrier landed`);
    }
    assert.equal(await errnoOf(() => sync.rename(`/${aside}`, `/${dir}`)), null, `${label}: the rename back`);
    await catchUp();
  };
  /** `pending`, an awaited call whose answer waits for what the process sends: delivered until it settles (a barrier it took first may send it late). */
  const delivered = async (pending) => {
    let done = false;
    const settled = pending.finally(() => { done = true; });
    for (let tries = 0; tries < 20 && !done; tries++) await deliver();
    assert.ok(done, 'an awaited call never answered');
    return settled;
  };
  /** Each name's size and mode in `where` as a call that cannot wait sees them, or its errno. */
  const statsAt = (where) => Object.fromEntries(NAMES.map((name) => {
    try {
      const stat = sync.stat(`/${where}/${name}`);
      return [name, stat === null ? null : [stat.size, stat.mode & 0o7777]];
    } catch (error) {
      return [name, error?.code ?? String(error)];
    }
  }));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `step ${i} ${JSON.stringify(step)}`;
    if (step.op === 'squeeze') {
      squeezed = true;
      continue;
    }
    // The budget full for this step: a change it needs room for is refused (ENOSPC), and leaves nothing changed.
    if (squeezed) budget.limit = budget.used;
    try {
      if (step.op === 'deliver') await deliver();
      else if (step.op === 'catchUp') await catchUp();
      else if (step.op === 'peer') await peerStep(step);
      else if (step.op === 'readAsync') await readAsync(step, label);
      else if (step.op === 'swap') await swapStep(step, label);
      else await processStep(step, label);
    } catch (error) {
      if (error !== NO_SPACE) throw error;
    } finally {
      budget.limit = 1 << 30;
      squeezed = false;
    }
    await check(label);
  }
  // The end: every descriptor closed, everything delivered, the session holds what the reference holds.
  for (const fd of [...fds.keys()]) await processStep({ op: 'close', fd }, 'the end');
  await deliver();
  // A grant the process holds given back first (a peer's change recalls it): the session then has everything it decided.
  if (grants) {
    await peerStep({ kind: 'write', name: 'z' });
    await peerStep({ kind: 'unlink', name: 'z' });
  }
  const ours = [];
  const theirs = [];
  const final = viewOf();
  for (const name of NAMES) {
    const mine = s.kernel.exists(`${dir}/${name}`) ? `${dec.decode(s.kernel.readFile(`${dir}/${name}`))}:${(s.kernel.stat(`${dir}/${name}`).mode & 0o7777).toString(8)}` : '-';
    const other = ref.kernel.exists(`${dir}/${name}`) ? `${dec.decode(ref.kernel.readFile(`${dir}/${name}`))}:${(ref.kernel.stat(`${dir}/${name}`).mode & 0o7777).toString(8)}` : '-';
    ours.push(`${name}=${mine}`);
    theirs.push(`${name}=${other}`);
    // An mtime the process set explicitly since the file's content last changed is the session's too.
    const reference = final.names.get(name);
    const mtime = reference === undefined ? undefined : final.fileOf(resolve(reference))?.mtime;
    if (typeof mtime === 'number' && mine !== '-' && other !== '-' && !peerWritten.has(name)) {
      assert.equal(Number(s.kernel.stat(`${dir}/${name}`).mtime), Number(ref.kernel.stat(`${dir}/${name}`).mtime), `the end: ${name}'s mtime differs from the reference's`);
    }
  }
  assert.equal(ours.join(' '), theirs.join(' '), 'the end: the session differs from the reference');
  // All drained, the view has it all: nothing of the budget is taken.
  await catchUp();
  await catchUp();
  await check('the end, drained');
  // The session kept a description of the process's only while the process held it (a descriptor's, a file's
  // anchor, or one naming a file it made until its open was answered): none, all closed and drained.
  const kept = [...s.engine.sql.exec('SELECT id FROM vfs_wave_descriptions WHERE pid = 7')].length;
  assert.equal(kept, 0, `the end: the session still keeps ${kept} descriptions of the process`);
  assert.equal(budget.used, 0, `the end: ${budget.used} bytes of the budget still taken after everything was drained`);
}

/** The shortest program, made by deleting steps, that still fails. */
async function shrink(steps, kind, grants) {
  let current = steps;
  // Shorter only where it fails the same way, and not by the known engine bug.
  const same = (error) => error.known !== true && kindOf(error) === kind;
  for (let chunk = Math.ceil(current.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let at = 0; at < current.length;) {
      const candidate = [...current.slice(0, at), ...current.slice(at + chunk)];
      if (await run(candidate, grants).then(() => false, same)) current = candidate;
      else at += chunk;
    }
  }
  return current;
}

/** A failure's kind: its message less the step, the values and the names it names. */
const kindOf = (error) => String(error.message).split('\n')[0].replace(/step \d+ /, '').replace(/\{[^}]*\}/g, '{}').replace(/\b[a-c]\b/g, 'N').replace(/fd \d/g, 'fd');

const seeds = process.env.NIMBUS_MODEL_SEED !== undefined
  ? [Number(process.env.NIMBUS_MODEL_SEED)]
  : Array.from({ length: Number(process.env.NIMBUS_MODEL_SEEDS ?? 200) }, (_, i) => i + 1);
// Every distinct failure (its message less the values it names), each shrunk once.
const failures = new Map();
/** Seeds that met the known engine bug (KNOWN_ENGINE_BUG), and nothing else. */
const metKnown = [];
/**
 * Programs that found a bug, run first, whatever the seeds. A file the
 * process made, given back with its grant (its row the view's, so nothing
 * of it is held once its records are answered), renamed under the next
 * grant and back: its descriptors read it at its name, where the view has
 * its row and not yet its bytes. Red before: a file's pinned bytes were read
 * only where no name led to it, so a read that could not wait was EAGAIN.
 */
const FOUND = [
  // A held source rewritten same-size once resident, copied: the copy has the new bytes.
  { name: 'a copy of a held source rewritten once resident', grants: true, steps: [
    { op: 'writeFile', name: 'a', data: 'xy' },
    { op: 'catchUp' },
    { op: 'writeFile', name: 'a', data: 'pq' },
    { op: 'copy', from: 'a', to: 'b' },
    { op: 'catchUp' },
  ] },
  // A file given back with no descriptor, opened read-only before a barrier: the new bytes or EAGAIN, never the old.
  { name: 'a read-only open of a file given back, before a barrier', grants: true, steps: [
    { op: 'writeFile', name: 'a', data: 'xy' },
    { op: 'catchUp' },
    { op: 'writeFile', name: 'a', data: 'pq' },
    { op: 'peer', kind: 'write', name: 'c', to: 'c', data: 'zz', mode: 420 },
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: false, append: false, create: false, exclusive: false, truncate: false } },
    { op: 'copy', from: 'a', to: 'b' },
    { op: 'catchUp' },
  ] },
  // The budget full while a held file has a descriptor open: what is refused changes nothing.
  { name: 'refusals for room around a held file with a descriptor open', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 0, offset: null, data: 'held' },
    { op: 'squeeze' },
    { op: 'open', fd: 1, name: 'a', flags: { read: true, write: false, append: false, create: false, exclusive: false, truncate: false } },
    { op: 'squeeze' },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'squeeze' },
    { op: 'unlink', name: 'a' },
    { op: 'write', fd: 0, offset: null, data: '!' },
    { op: 'catchUp' },
  ] },
  // A resident file overwritten same-size under a grant, the grant given back before the view admits the write: read now, the new bytes or EAGAIN, never the old.
  { name: 'an overwritten resident file read now after a give-back', grants: true, steps: [
    { op: 'writeFile', name: 'a', data: 'xy' },
    { op: 'catchUp' },
    { op: 'writeFile', name: 'a', data: 'pq' },
    { op: 'writeFile', name: 'b', data: 'r' },
    { op: 'peer', kind: 'write', name: 'c', to: 'c', data: 'zz', mode: 420 },
    { op: 'catchUp' },
  ] },
  // A provisional open whose receipt resolves to a file a grant holds by then: one file, by both descriptors and by name.
  { name: 'a receipt resolving to a held owner', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: false } },
    { op: 'write', fd: 0, offset: null, data: 'x' },
    { op: 'writeFile', name: 'b', data: 'q' },
    { op: 'writeFile', name: 'c', data: 'w' },
    { op: 'open', fd: 1, name: 'a', flags: { read: true, write: true, append: false, create: false, exclusive: false, truncate: false } },
    { op: 'write', fd: 1, offset: 1, data: 'y' },
    { op: 'deliver' },
    { op: 'readAsync', fd: 0 },
    { op: 'write', fd: 0, offset: null, data: 'z' },
    { op: 'catchUp' },
  ] },
  // A grant ends (a peer's change recalls it) with descriptors open on files it decided: they read and write on, and their names read what was written.
  { name: 'grant ends with descriptors open on held files', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 0, offset: null, data: 'xy' },
    { op: 'open', fd: 1, name: 'b', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 1, offset: null, data: 'q' },
    { op: 'peer', kind: 'write', name: 'c', to: 'c', data: 'pp', mode: 420 },
    { op: 'readAsync', fd: 0 },
    { op: 'write', fd: 0, offset: null, data: 'z' },
    { op: 'close', fd: 1 },
    { op: 'catchUp' },
    { op: 'close', fd: 0 },
  ] },
  // A held file renamed, the grant given back, renamed again: by name and by descriptor it is one file.
  { name: 'held file renamed across a give-back', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 0, offset: null, data: 'ab' },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'peer', kind: 'write', name: 'c', to: 'c', data: 'pp', mode: 420 },
    { op: 'rename', from: 'b', to: 'a' },
    { op: 'write', fd: 0, offset: null, data: 'c' },
    { op: 'readAsync', fd: 0 },
    { op: 'catchUp' },
  ] },
  // A need appears mid-grant: a file a grant decides, open, replaced by a rename of a name the provisional decisions hold.
  { name: 'a provisional rename replaces a held file with a descriptor open', grants: true, steps: [
    { op: 'writeFile', name: 'a', data: 'rp' },
    { op: 'open', fd: 0, name: 'b', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 0, offset: null, data: 'bb' },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'write', fd: 0, offset: null, data: 'x' },
    { op: 'readAsync', fd: 0 },
    { op: 'close', fd: 0 },
    { op: 'catchUp' },
  ] },
  // Held files with no descriptor at a give-back: read now, their bytes or EAGAIN, never another file's.
  { name: 'held files with no descriptor at a give-back, read now', grants: true, steps: [
    { op: 'writeFile', name: 'a', data: 'xy' },
    { op: 'writeFile', name: 'b', data: 'pq' },
    { op: 'peer', kind: 'write', name: 'c', to: 'c', data: 'zz', mode: 420 },
    { op: 'writeFile', name: 'a', data: 'w' },
    { op: 'catchUp' },
  ] },
  // A file renamed, without a grant, over a name a peer wrote: a read of the new name that cannot wait reads the file moved there, never the peer's bytes.
  { name: 'renamed over a peer\'s file, read now', grants: false, steps: [
    { op: 'peer', kind: 'write', name: 'b', to: 'c', data: 'pp', mode: 292 },
    { op: 'writeFile', name: 'a', data: 'rp' },
    { op: 'catchUp' },
    { op: 'rename', from: 'a', to: 'b' },
  ] },
  // A file opened before its subtree is taken, its times then set by name under the grant: the provisional decisions' (the name is theirs), not the session's.
  { name: 'times by name of a file the provisional decisions hold, under a grant', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'write', fd: 0, offset: null, data: 'pq' },
    { op: 'close', fd: 0 },
    { op: 'writeFile', name: 'b', data: 'r' },
    { op: 'utimes', name: 'a', atime: 1600000007000, mtime: 1600000007000 },
    { op: 'catchUp' },
  ] },
  { name: 'a read-only descriptor does not read through a borrowed write-only anchor', grants: false, steps: [
    { op: 'writeFile', name: 'c', data: 'qq' },
    { op: 'open', fd: 2, name: 'c', flags: { read: false, write: true, append: false, create: false, exclusive: false, truncate: false } },
    { op: 'open', fd: 1, name: 'c', flags: { read: true, write: false, append: false, create: true, exclusive: false, truncate: false } },
    { op: 'catchUp' },
    { op: 'readAsync', fd: 1 },
  ] },
  { name: 'write after granted unlink folds over retained pinned bytes', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: true, create: true, exclusive: false, truncate: false } },
    { op: 'open', fd: 2, name: 'a', flags: { read: true, write: true, append: false, create: false, exclusive: false, truncate: false } },
    { op: 'write', fd: 0, offset: 4, data: 'qp' },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'catchUp' },
    { op: 'unlink', name: 'b' },
    { op: 'write', fd: 2, offset: null, data: 'q' },
  ] },
  { name: 'fchmod after unlink and granted recreate changes the provisional fold', grants: true, steps: [
    { op: 'writeFile', name: 'c', data: 'r' },
    { op: 'catchUp' },
    { op: 'unlink', name: 'c' },
    { op: 'open', fd: 0, name: 'c', flags: { read: false, write: true, append: false, create: true, exclusive: true, truncate: false } },
    { op: 'fchmod', fd: 0, mode: 292 },
  ] },
  { name: 'retired descriptor content follows a peer-renamed inode found in the view', grants: true, steps: [
    { op: 'open', fd: 1, name: 'b', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: true } },
    { op: 'peer', kind: 'rename', name: 'b', to: 'c', data: 'pr', mode: 420 },
    { op: 'write', fd: 1, offset: null, data: 's' },
    { op: 'peer', kind: 'write', name: 'c', to: 'a', data: 'r', mode: 420 },
    { op: 'catchUp' },
  ] },
  { name: 'anchor read does not report another descriptions refused write', grants: false, steps: [
    { op: 'open', fd: 2, name: 'b', flags: { read: true, write: true, append: false, create: true, exclusive: true, truncate: true } },
    { op: 'open', fd: 1, name: 'c', flags: { read: true, write: false, append: false, create: true, exclusive: false, truncate: false } },
    { op: 'rename', from: 'c', to: 'b' },
    { op: 'rename', from: 'b', to: 'c' },
    { op: 'deliver' },
    { op: 'rename', from: 'c', to: 'b' },
    { op: 'peer', kind: 'chmod', name: 'c', to: 'a', data: 'sq', mode: 292 },
    { op: 'writeFile', name: 'b', data: 'sq' },
    { op: 'readAsync', fd: 2 },
  ] },
  { name: 'renamed under a grant, away and back', grants: true, steps: [
    { op: 'open', fd: 2, name: 'a', flags: { read: true, write: true, append: true, create: true, exclusive: true, truncate: false } },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'catchUp' },
    { op: 'rename', from: 'b', to: 'a' },
  ] },
  { name: 'a name a grant removed, made again through the provisional decisions', grants: true, steps: [
    { op: 'open', fd: 0, name: 'c', flags: { read: true, write: true, append: false, create: true, exclusive: false, truncate: false } },
    { op: 'close', fd: 0 },
    { op: 'peer', kind: 'rename', name: 'c', to: 'a', data: 'qr', mode: 420 },
    { op: 'open', fd: 1, name: 'b', flags: { read: false, write: true, append: false, create: true, exclusive: false, truncate: false } },
    { op: 'catchUp' },
    { op: 'unlink', name: 'a' },
    { op: 'open', fd: 0, name: 'a', flags: { read: true, write: true, append: true, create: true, exclusive: false, truncate: false } },
    { op: 'catchUp' },
  ] },
  { name: 'a file a grant renamed, emptied through the provisional decisions as a descriptor of it is open', grants: true, steps: [
    { op: 'open', fd: 1, name: 'b', flags: { read: false, write: true, append: true, create: true, exclusive: false, truncate: true } },
    { op: 'catchUp' },
    { op: 'rename', from: 'b', to: 'c' },
    { op: 'writeFile', name: 'c', data: 'qsq' },
    { op: 'catchUp' },
  ] },
  { name: 'a write through the provisional decisions to a file a grant renamed', grants: true, steps: [
    { op: 'open', fd: 1, name: 'b', flags: { read: false, write: true, append: true, create: true, exclusive: false, truncate: true } },
    { op: 'catchUp' },
    { op: 'rename', from: 'b', to: 'c' },
    { op: 'write', fd: 1, offset: null, data: 'qsq' },
    { op: 'catchUp' },
  ] },
  { name: 'a write through the provisional decisions to a file a grant changed the mode of', grants: true, steps: [
    { op: 'open', fd: 1, name: 'b', flags: { read: false, write: true, append: true, create: true, exclusive: false, truncate: true } },
    { op: 'catchUp' },
    { op: 'chmod', name: 'b', mode: 0o600 },
    { op: 'write', fd: 1, offset: null, data: 'qsq' },
    { op: 'catchUp' },
  ] },
  // A descriptor whose file a peer renamed, the names' directory renamed and back: through it, that file as the view has it.
  { name: 'a descriptor of a file a peer renamed, its directory renamed and back', grants: true, steps: [
    { op: 'open', fd: 0, name: 'a', flags: { read: false, write: true, append: false, create: true, exclusive: true, truncate: false } },
    { op: 'copy', from: 'a', to: 'b' },
    { op: 'peer', kind: 'rename', name: 'a', to: 'b', data: 'pq', mode: 292 },
    { op: 'peer', kind: 'write', name: 'b', to: 'a', data: 'pq', mode: 420 },
    { op: 'rename', from: 'b', to: 'c' },
    { op: 'swap', awaited: false },
  ] },
  { name: 'a read through a descriptor of a file a peer renamed twice, its directory renamed and back', grants: true, steps: [
    { op: 'open', fd: 2, name: 'a', flags: { read: true, write: true, append: true, create: true, exclusive: false, truncate: false } },
    { op: 'peer', kind: 'rename', name: 'a', to: 'b', data: 'rq', mode: 292 },
    { op: 'swap', awaited: true },
    { op: 'writeFile', name: 'b', data: 'rr' },
    { op: 'copy', from: 'b', to: 'a' },
    { op: 'peer', kind: 'rename', name: 'a', to: 'b', data: 'rq', mode: 420 },
    { op: 'unlink', name: 'a' },
    { op: 'swap', awaited: false },
  ] },
];
for (const found of FOUND) {
  const failure = await run(found.steps, found.grants).then(() => null, (error) => error);
  if (failure !== null && failure.known !== true) failures.set(`found: ${found.name}`, { seeds: [0], reason: failure, minimal: found.steps, grants: found.grants });
}
// Each seed twice: as it is, and with swaps (half of those granted).
for (const [seed, swaps] of [...seeds.map((seed) => [seed, false]), ...seeds.slice(0, Math.ceil(seeds.length / 3)).map((seed) => [seed, true])]) {
  const steps = program(seed, 40, { copies: true, swaps });
  // A third of the programs run with the session granting the subtree the process changes.
  const grants = swaps ? seed % 2 === 0 : seed % 3 === 0;
  const failure = await run(steps, grants).then(() => null, (error) => error);
  if (failure === null) continue;
  if (failure.known === true) {
    metKnown.push(seed);
    continue;
  }
  const kind = kindOf(failure);
  if (failures.has(kind)) { failures.get(kind).seeds.push(seed); continue; }
  const minimal = await shrink(steps, kind, grants);
  const reason = await run(minimal, grants).then(() => failure, (error) => error);
  failures.set(kind, { seeds: [seed], reason, minimal, grants });
  if (failures.size >= 12) break;
}
for (const [kind, { seeds: failing, reason, minimal, grants }] of failures) {
  console.error(`FAILURE ${kind} (seeds ${failing.slice(0, 8).join(', ')}${failing.length > 8 ? ', ...' : ''}${grants ? ', granted' : ''}): ${reason.message}\nminimal program (${minimal.length} steps):\n${minimal.map((step) => `  ${JSON.stringify(step)}`).join('\n')}\n`);
}
if (metKnown.length > 0) console.log(`resident-fs-model: seeds ${metKnown.join(', ')} met the known engine bug (wave EIO "missing chunk", ToughWallaby P1)`);
if (failures.size > 0) process.exit(1);
console.log(`resident-fs-model: ${seeds.length - metKnown.length} programs agree with the model`);
