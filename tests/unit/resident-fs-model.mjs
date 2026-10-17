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

const DIR = 'home/user/other';
const NAMES = ['a', 'b', 'c'];
const MAX_FDS = 3;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** mulberry32: a small seeded generator. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A program of `length` steps from `seed`. */
function program(seed, length = 40) {
  const random = generator(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  const word = () => 'x'.repeat(1 + Math.floor(random() * 3)).replace(/x/g, () => pick(['p', 'q', 'r', 's']));
  const steps = [];
  for (let i = 0; i < length; i++) {
    const roll = random();
    if (roll < 0.22) {
      const access = pick(['r', 'w', 'rw']);
      steps.push({ op: 'open', fd: Math.floor(random() * MAX_FDS), name: pick(NAMES), flags: {
        read: access !== 'w', write: access !== 'r', append: access !== 'r' && random() < 0.25,
        create: random() < 0.6, exclusive: random() < 0.2, truncate: random() < 0.3,
      } });
    } else if (roll < 0.40) steps.push({ op: 'write', fd: Math.floor(random() * MAX_FDS), offset: random() < 0.3 ? null : Math.floor(random() * 6), data: word() });
    else if (roll < 0.46) steps.push({ op: 'ftruncate', fd: Math.floor(random() * MAX_FDS), size: Math.floor(random() * 5) });
    else if (roll < 0.52) steps.push({ op: 'close', fd: Math.floor(random() * MAX_FDS) });
    else if (roll < 0.57) steps.push({ op: 'unlink', name: pick(NAMES) });
    else if (roll < 0.62) steps.push({ op: 'rename', from: pick(NAMES), to: pick(NAMES) });
    else if (roll < 0.66) steps.push({ op: 'chmod', name: pick(NAMES), mode: pick([0o644, 0o444, 0o600]) });
    else if (roll < 0.70) steps.push({ op: 'fchmod', fd: Math.floor(random() * MAX_FDS), mode: pick([0o644, 0o444, 0o600]) });
    else if (roll < 0.75) steps.push({ op: 'writeFile', name: pick(NAMES), data: word() });
    else if (roll < 0.82) steps.push({ op: 'peer', kind: pick(['write', 'write', 'unlink', 'rename', 'chmod']), name: pick(NAMES), to: pick(NAMES), data: word(), mode: pick([0o644, 0o444]) });
    else if (roll < 0.92) steps.push({ op: 'deliver' });
    else steps.push({ op: 'catchUp' });
  }
  return steps;
}

/**
 * What the process's own operations make of a file: write, append, truncate
 * and chmod over its bytes and mode. Bytes not known (null) stay unknown
 * but for their size, until a truncate to nothing makes them known.
 */
function apply(file, op) {
  if (op.kind === 'chmod') return { ...file, mode: op.mode };
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

/** Run `steps`; throws the first divergence from the model, naming its step. */
async function run(steps) {
  // The process's session: its waves wait for `deliver`; no grant is held.
  const control = { held: true, opened: Promise.withResolvers() };
  const s = session({
    view: {},
    acquired: { then: (_resolve, reject) => reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })) },
    gate: { then: (resolve, reject) => (control.held ? control.opened.promise : Promise.resolve()).then(resolve, reject) },
  });
  const ref = session();
  const sync = s.fs.synchronous;
  const direct = ref.filesystem.bind({ pid: 8, cred: user });
  const path = (name) => `/${DIR}/${name}`;

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
    const now = viewOf();
    for (const [fd, opened] of fds) {
      const id = resolve({ opened });
      const file = now.fileOf(id);
      const size = Number(sync.fstat(opened.handle).size);
      if (file !== undefined) assert.equal(size, file.size, `${label}: fd ${fd} fstat size`);
      if (!opened.read) continue;
      let got;
      const code = await errnoOf(() => { got = sync.read(opened.handle, 0, 1 << 12); });
      // Bytes the view does not hold: refused (EAGAIN), or ESTALE once no name leads to them.
      if ((code === 'EAGAIN' || code === 'ESTALE') && (file === undefined || file.bytes === null)) continue;
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
    }
  };

  /** The process's operation `step`, made synchronously: its local refusal, which the model predicts, or its effects. */
  const processStep = async (step, label) => {
    const now = viewOf();
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
      if (logs) undelivered.push({ records, logged: { opened, flags } });
      opened.logs = logs;
      return;
    }
    if (step.op === 'write' || step.op === 'ftruncate' || step.op === 'fchmod' || step.op === 'close') {
      const opened = fds.get(step.fd);
      if (opened === undefined) return;
      if (step.op === 'close') {
        sync.close(opened.handle);
        fds.delete(step.fd);
        if (opened.logs) undelivered.push({ record: { effect: { kind: 'none' }, refused: false }, logged: { close: opened } });
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
        add(effect, { opened, write: effect });
        return;
      }
      if (step.op === 'ftruncate') {
        const code = await errnoOf(() => sync.ftruncate(opened.handle, step.size));
        if (!opened.write) { assert.ok(code !== null, `${label}: ftruncate by a read-only fd answered`); return; }
        assert.equal(code, null, `${label}: ftruncate`);
        add({ kind: 'truncate', ref: { opened }, size: step.size }, { opened, truncate: step.size });
        return;
      }
      // By the name that leads to its file: none, and no file can be named (ESTALE).
      const id = resolve({ opened });
      let name;
      for (const [at, reference] of now.names) if (resolve(reference) === id) name = at;
      const code = await errnoOf(() => sync.fchmod(opened.handle, step.mode));
      if (name === undefined) { assert.ok(code === 'ESTALE' || code === null, `${label}: fchmod of a file no name leads to: ${code}`); if (code !== null) return; }
      else assert.equal(code, null, `${label}: fchmod`);
      add({ kind: 'chmod', ref: { opened }, mode: step.mode }, name === undefined ? null : { chmod: [name, step.mode] });
      return;
    }
    if (step.op === 'unlink') {
      const reference = now.names.get(step.name);
      const code = await errnoOf(() => sync.unlink(path(step.name)));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: unlink ${step.name}`);
      if (code === null) add({ kind: 'name', name: step.name, ref: null }, { unlink: step.name });
      return;
    }
    if (step.op === 'rename') {
      const reference = now.names.get(step.from);
      const code = await errnoOf(() => sync.rename(path(step.from), path(step.to)));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: rename ${step.from} ${step.to}`);
      if (code === null && step.from !== step.to) add({ kind: 'rename', from: step.from, to: step.to }, { rename: [step.from, step.to] });
      return;
    }
    if (step.op === 'chmod') {
      const reference = now.names.get(step.name);
      const code = await errnoOf(() => sync.chmod(path(step.name), step.mode));
      assert.equal(code, reference === undefined ? 'ENOENT' : null, `${label}: chmod ${step.name}`);
      if (code === null) add({ kind: 'chmod', ref: reference, mode: step.mode }, { chmod: [step.name, step.mode] });
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
      undelivered.push({ records, record: written, logged: { opened, flags: { write: true, create: true, truncate: true }, write: { kind: 'write', offset: 0, data }, close: opened } });
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
    for (const { record, records, logged } of undelivered) {
      let refused = false;
      if (logged.unlink) refused = (await errnoOf(() => direct.unlink(path(logged.unlink)))) !== null;
      else if (logged.rename) refused = (await errnoOf(() => direct.rename(path(logged.rename[0]), path(logged.rename[1])))) !== null;
      else if (logged.chmod) refused = (await errnoOf(() => direct.chmod(path(logged.chmod[0]), logged.chmod[1]))) !== null;
      else {
        const opened = logged.opened ?? logged.close;
        if (logged.flags) {
          // The session's open is to write (and to read when asked): its answer names the file it opened.
          refused = (await errnoOf(async () => { opened.refHandle = (await direct.open(path(opened.name), { ...logged.flags, mode: 0o666, umask: 0o022 })).id; })) !== null;
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

  /** The view brought to the session's: what the process sent delivered, a barrier, every name read (the view holds what it read until a barrier reads it again). */
  const catchUp = async () => {
    await deliver();
    s.fs.inbound();
    await s.fs.stat(`/${DIR}`);
    for (const name of NAMES) {
      await errnoOf(() => s.fs.stat(path(name)));
      await errnoOf(() => s.fs.readFile(path(name)));
    }
    // A file a descriptor holds that no name leads to now keeps what the view had of it, by its session number.
    const before = viewOf();
    const held = [...fds.values()].map((opened) => [opened.session ?? resolve({ opened }), before.fileOf(resolve({ opened }))]);
    admitted = await snapshot();
    pending = [];
    for (const [id, file] of held) {
      if (typeof id !== 'number' || admitted.files.has(id) || file === undefined) continue;
      admitted.files.set(id, file);
      unnamed.add(id);
    }
  };
  await catchUp();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `step ${i} ${JSON.stringify(step)}`;
    if (step.op === 'deliver') await deliver();
    else if (step.op === 'catchUp') await catchUp();
    else if (step.op === 'peer') {
      // Between deliveries: the session has it before what the process sends next, and so does the reference.
      for (const target of [s.kernel, ref.kernel]) {
        const key = `${DIR}/${step.name}`;
        try {
          if (step.kind === 'write') { target.writeFile(key, enc.encode(step.data)); target.chown(key, 1000, 1000); }
          else if (step.kind === 'unlink') target.unlink(key);
          else if (step.kind === 'rename') target.rename(key, `${DIR}/${step.to}`);
          else target.chmod(key, step.mode);
        } catch { /* nothing there */ }
      }
    } else await processStep(step, label);
    await check(label);
  }
  await deliver();
  for (const opened of fds.values()) if (opened.refHandle !== undefined) await errnoOf(() => direct.close(opened.refHandle));
  // The end: the session holds what the reference holds.
  const ours = [];
  const theirs = [];
  for (const name of NAMES) {
    const mine = s.kernel.exists(`${DIR}/${name}`) ? `${dec.decode(s.kernel.readFile(`${DIR}/${name}`))}:${(s.kernel.stat(`${DIR}/${name}`).mode & 0o7777).toString(8)}` : '-';
    const other = ref.kernel.exists(`${DIR}/${name}`) ? `${dec.decode(ref.kernel.readFile(`${DIR}/${name}`))}:${(ref.kernel.stat(`${DIR}/${name}`).mode & 0o7777).toString(8)}` : '-';
    ours.push(`${name}=${mine}`);
    theirs.push(`${name}=${other}`);
  }
  assert.equal(ours.join(' '), theirs.join(' '), 'the end: the session differs from the reference');
}

/** The shortest program, made by deleting steps, that still fails. */
async function shrink(steps) {
  let current = steps;
  for (let chunk = Math.ceil(current.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let at = 0; at < current.length;) {
      const candidate = [...current.slice(0, at), ...current.slice(at + chunk)];
      if (await run(candidate).then(() => false, () => true)) current = candidate;
      else at += chunk;
    }
  }
  return current;
}

const seeds = process.env.NIMBUS_MODEL_SEED !== undefined
  ? [Number(process.env.NIMBUS_MODEL_SEED)]
  : Array.from({ length: Number(process.env.NIMBUS_MODEL_SEEDS ?? 200) }, (_, i) => i + 1);
// Every distinct failure (its message less the values it names), each shrunk once.
const failures = new Map();
for (const seed of seeds) {
  const steps = program(seed);
  const failure = await run(steps).then(() => null, (error) => error);
  if (failure === null) continue;
  const kind = String(failure.message).split('\n')[0].replace(/step \d+ /, '').replace(/\{[^}]*\}/g, '{}').replace(/\b[a-c]\b/g, 'N').replace(/fd \d/g, 'fd');
  if (failures.has(kind)) { failures.get(kind).seeds.push(seed); continue; }
  const minimal = await shrink(steps);
  const reason = await run(minimal).then(() => failure, (error) => error);
  failures.set(kind, { seeds: [seed], reason, minimal });
  if (failures.size >= 12) break;
}
for (const [kind, { seeds: failing, reason, minimal }] of failures) {
  console.error(`FAILURE ${kind} (seeds ${failing.slice(0, 8).join(', ')}${failing.length > 8 ? ', ...' : ''}): ${reason.message}\nminimal program (${minimal.length} steps):\n${minimal.map((step) => `  ${JSON.stringify(step)}`).join('\n')}\n`);
}
if (failures.size > 0) process.exit(1);
console.log(`resident-fs-model: ${seeds.length} programs agree with the model`);
