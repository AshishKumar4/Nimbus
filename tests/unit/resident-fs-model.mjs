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

/** What the process's own operations make of a file: write, append, truncate and chmod over its bytes and mode. */
function apply(file, op) {
  if (op.kind === 'chmod') return { bytes: file.bytes, mode: op.mode };
  if (op.kind === 'truncate') {
    const bytes = new Uint8Array(op.size);
    bytes.set(file.bytes.subarray(0, Math.min(op.size, file.bytes.length)));
    return { bytes, mode: file.mode };
  }
  if (op.data.length === 0) return file;
  const at = op.kind === 'append' ? file.bytes.length : op.offset;
  const bytes = new Uint8Array(Math.max(file.bytes.length, at + op.data.length));
  bytes.set(file.bytes);
  bytes.set(op.data, at);
  return { bytes, mode: file.mode };
}

/**
 * The process's view as the model has it: the names and files its view
 * last admitted (a snapshot of the session), with its own operations since,
 * the session's refusals among them dropped, replayed over them in order.
 */
function viewOf(admitted, pending, key) {
  const names = new Map(admitted.names);
  const files = new Map([...admitted.files].map(([id, file]) => [id, { ...file }]));
  for (const step of pending) {
    if (step.refused) continue;
    const e = step.effect;
    if (e.kind === 'name') { if (e.id === null) names.delete(e.name); else names.set(e.name, e.id); }
    else if (e.kind === 'rename') { const id = names.get(e.from); names.delete(e.from); names.set(e.to, id); }
    // A file it made that the session's answer names as one the view has: that file, as the view has it.
    else if (e.kind === 'create') { if (key(e.id) === e.id) files.set(e.id, { bytes: new Uint8Array(0), mode: e.mode }); }
    else if (e.kind !== 'none') files.set(key(e.id), apply(files.get(key(e.id)) ?? { bytes: new Uint8Array(0), mode: 0o644 }, e));
  }
  return { names, files };
}

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
  // The view's ids are the session's inode numbers; a file the process makes is `L<n>` until its open is delivered.
  let local = 0;
  const alias = new Map();
  /** A file the process made, as the model keys it: the session's file once its open is answered, if the view has that one. */
  const key = (id) => { const named = alias.get(id); return named !== undefined && admitted.files.has(named) ? named : id; };
  /** A file the process made that the session's answer names as one the view has not admitted: the view may not hold its bytes. */
  const unadmitted = (id) => alias.has(id) && !admitted.files.has(alias.get(id));
  /** Files no name leads to any more that a descriptor holds: what the view had of them last. */
  const unnamed = new Set();
  /** The session's names and files now, as the reference has them. */
  const snapshot = async () => {
    const names = new Map();
    const files = new Map();
    for (const name of NAMES) {
      let stat = null;
      try { stat = await direct.stat(path(name)); } catch { /* absent */ }
      if (stat === null) continue;
      names.set(name, stat.ino);
      files.set(stat.ino, { bytes: new Uint8Array(await direct.readFile(path(name))), mode: stat.mode & 0o7777 });
    }
    return { names, files };
  };
  let admitted = await snapshot();
  /** The process's own operations since its view last admitted the session's, each with its effect and, once delivered, its fate. */
  let pending = [];
  let undelivered = [];
  /** Per fd: the file it opened (as the view had it), its rights, and the reference's descriptor of it once delivered. */
  const fds = new Map();
  const view = () => viewOf(admitted, pending, key);
  /** The name the view has `id` at, if any. */
  const nameOf = (now, id) => { for (const [name, at] of now.names) if (key(at) === key(id)) return name; return undefined; };

  const check = async (label) => {
    const now = view();
    for (const [fd, open] of fds) {
      if (!open.read) continue;
      const file = now.files.get(key(open.id));
      let got;
      const code = await errnoOf(() => { got = sync.read(open.handle, 0, 1 << 12); });
      // ESTALE: a file no name leads to whose bytes the view no longer holds; EAGAIN: bytes the view has not admitted.
      if (code === 'ESTALE' && (file === undefined || unnamed.has(key(open.id)))) continue;
      if (code === 'EAGAIN' && unadmitted(open.id)) continue;
      assert.equal(code, null, `${label}: fd ${fd} read ${code}`);
      assert.equal(dec.decode(got), dec.decode(file?.bytes ?? new Uint8Array(0)), `${label}: fd ${fd} read`);
      assert.equal(Number(sync.fstat(open.handle).size), (file?.bytes ?? new Uint8Array(0)).length, `${label}: fd ${fd} fstat size`);
    }
    for (const name of NAMES) {
      const id = now.names.get(name);
      const stat = sync.stat(path(name));
      assert.equal(stat === null, id === undefined, `${label}: ${name} ${stat === null ? 'absent' : 'present'}`);
      if (id === undefined || unadmitted(id)) continue;
      const file = now.files.get(key(id));
      assert.equal(Number(stat.size), file.bytes.length, `${label}: ${name} size`);
      assert.equal(Number(stat.mode) & 0o7777, file.mode, `${label}: ${name} mode`);
    }
  };

  /** The process's operation `step`, made synchronously: its local refusal, which the model predicts, or its effects. */
  const processStep = async (step, label) => {
    const now = view();
    const add = (effect, logged) => {
      const record = { step, effect, refused: false };
      pending.push(record);
      if (logged) undelivered.push({ record, logged });
      return record;
    };
    if (step.op === 'open') {
      if (fds.has(step.fd)) return;
      const id = now.names.get(step.name);
      const file = id === undefined ? undefined : now.files.get(key(id));
      const writes = step.flags.write || step.flags.append;
      const expected = id === undefined ? (step.flags.create ? null : 'ENOENT')
        : step.flags.create && step.flags.exclusive ? 'EEXIST'
        : ((step.flags.read && !(file.mode & 0o400)) || ((writes || step.flags.truncate) && !(file.mode & 0o200))) ? 'EACCES' : null;
      let handle;
      const code = await errnoOf(() => { handle = sync.open(path(step.name), step.flags).id; });
      assert.equal(code, expected, `${label}: open ${step.name} ${JSON.stringify(step.flags)}`);
      if (code !== null) return;
      let target = id;
      if (id === undefined) {
        target = `L${++local}`;
        add({ kind: 'create', id: target, mode: 0o644 & ~0o022 });
        add({ kind: 'name', name: step.name, id: target });
      }
      const logs = writes || step.flags.truncate || id === undefined;
      const open = { handle, id: target, read: step.flags.read || !writes, write: writes, append: step.flags.append, name: step.name, logs };
      fds.set(step.fd, open);
      const record = add(step.flags.truncate && id !== undefined ? { kind: 'truncate', id: target, size: 0 } : { kind: 'none' }, logs ? { open, flags: step.flags } : null);
      record.open = open;
      return;
    }
    if (step.op === 'write' || step.op === 'ftruncate' || step.op === 'fchmod' || step.op === 'close') {
      const open = fds.get(step.fd);
      if (open === undefined) return;
      if (step.op === 'close') {
        sync.close(open.handle);
        fds.delete(step.fd);
        if (open.logs) undelivered.push({ record: { step, effect: { kind: 'none' }, refused: false }, logged: { close: open } });
        return;
      }
      if (step.op === 'write') {
        const data = enc.encode(step.data);
        const code = await errnoOf(() => sync.write(open.handle, step.offset, data));
        if (!open.write) { assert.equal(code, 'EBADF', `${label}: write by a read-only fd`); return; }
        assert.equal(code, null, `${label}: write`);
        const at = step.offset ?? open.position ?? 0;
        const effect = open.append ? { kind: 'append', id: open.id, data } : { kind: 'write', id: open.id, offset: at, data };
        if (!open.append && step.offset === null) open.position = at + data.length;
        add(effect, { open, write: effect });
        return;
      }
      if (step.op === 'ftruncate') {
        const code = await errnoOf(() => sync.ftruncate(open.handle, step.size));
        if (!open.write) { assert.ok(code !== null, `${label}: ftruncate by a read-only fd answered`); return; }
        assert.equal(code, null, `${label}: ftruncate`);
        add({ kind: 'truncate', id: open.id, size: step.size }, { open, truncate: step.size });
        return;
      }
      // By the name that leads to its file: none, and the view cannot say which file it would change (ESTALE).
      const name = nameOf(now, open.id);
      const code = await errnoOf(() => sync.fchmod(open.handle, step.mode));
      if (name === undefined) { assert.equal(code, 'ESTALE', `${label}: fchmod of a file no name leads to`); return; }
      assert.equal(code, null, `${label}: fchmod`);
      add({ kind: 'chmod', id: open.id, mode: step.mode }, { chmod: [name, step.mode] });
      return;
    }
    if (step.op === 'unlink') {
      const id = now.names.get(step.name);
      const code = await errnoOf(() => sync.unlink(path(step.name)));
      assert.equal(code, id === undefined ? 'ENOENT' : null, `${label}: unlink ${step.name}`);
      if (code === null) add({ kind: 'name', name: step.name, id: null }, { unlink: step.name });
      return;
    }
    if (step.op === 'rename') {
      const id = now.names.get(step.from);
      const code = await errnoOf(() => sync.rename(path(step.from), path(step.to)));
      assert.equal(code, id === undefined ? 'ENOENT' : null, `${label}: rename ${step.from} ${step.to}`);
      if (code === null && step.from !== step.to) add({ kind: 'rename', from: step.from, to: step.to }, { rename: [step.from, step.to] });
      return;
    }
    if (step.op === 'chmod') {
      const id = now.names.get(step.name);
      const code = await errnoOf(() => sync.chmod(path(step.name), step.mode));
      assert.equal(code, id === undefined ? 'ENOENT' : null, `${label}: chmod ${step.name}`);
      if (code === null) add({ kind: 'chmod', id, mode: step.mode }, { chmod: [step.name, step.mode] });
      return;
    }
    if (step.op === 'writeFile') {
      const id = now.names.get(step.name);
      const file = id === undefined ? undefined : now.files.get(key(id));
      const expected = file !== undefined && !(file.mode & 0o200) ? 'EACCES' : null;
      const data = enc.encode(step.data);
      const code = await errnoOf(() => sync.writeFile(path(step.name), data));
      assert.equal(code, expected, `${label}: writeFile ${step.name}`);
      if (code !== null) return;
      let target = id;
      if (id === undefined) {
        target = `L${++local}`;
        add({ kind: 'create', id: target, mode: 0o644 & ~0o022 });
        add({ kind: 'name', name: step.name, id: target });
      } else {
        add({ kind: 'truncate', id: target, size: 0 });
      }
      const open = { id: target, write: true, name: step.name, logs: true };
      const record = add({ kind: 'write', id: target, offset: 0, data }, { open, flags: { write: true, create: true, truncate: true }, write: { kind: 'write', offset: 0, data }, close: open });
      record.open = open;
    }
  };

  /** What the session received since the last delivery, made on the reference directly, in order: each one it refuses, refused. */
  const deliver = async () => {
    control.held = false;
    control.opened.resolve();
    await errnoOf(() => s.fs.flush());
    control.held = true;
    control.opened = Promise.withResolvers();
    for (const { record, logged } of undelivered) {
      let refused = false;
      if (logged.unlink) refused = (await errnoOf(() => direct.unlink(path(logged.unlink)))) !== null;
      else if (logged.rename) refused = (await errnoOf(() => direct.rename(path(logged.rename[0]), path(logged.rename[1])))) !== null;
      else if (logged.chmod) refused = (await errnoOf(() => direct.chmod(path(logged.chmod[0]), logged.chmod[1]))) !== null;
      else {
        const open = logged.open ?? logged.close;
        if (logged.flags) {
          refused = (await errnoOf(async () => { open.refHandle = (await direct.open(path(open.name), { ...logged.flags, mode: 0o666, umask: 0o022 })).id; })) !== null;
          if (!refused && String(open.id).startsWith('L')) alias.set(open.id, (await direct.fstat(open.refHandle)).ino);
          if (refused) open.refHandle = undefined;
        }
        if (logged.write && open.refHandle !== undefined) refused = (await errnoOf(() => direct.write(open.refHandle, logged.write.kind === 'append' ? null : logged.write.offset, logged.write.data))) !== null;
        else if (logged.write) refused = true;
        if (logged.truncate !== undefined) refused = open.refHandle === undefined || (await errnoOf(() => direct.ftruncate(open.refHandle, logged.truncate))) !== null;
        if (logged.close && open.refHandle !== undefined) { await errnoOf(() => direct.close(open.refHandle)); open.refHandle = undefined; }
      }
      record.refused = refused;
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
  };
  await catchUp();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = `step ${i} ${JSON.stringify(step)}`;
    if (step.op === 'deliver') await deliver();
    else if (step.op === 'catchUp') {
      await catchUp();
      // A file a descriptor holds that no name leads to now keeps what the view had of it, by its session identity.
      const before = view();
      const held = [...fds.values()].map((open) => [alias.get(open.id) ?? open.id, before.files.get(key(open.id))]);
      admitted = await snapshot();
      pending = [];
      for (const [id, file] of held) {
        if (admitted.files.has(id) || file === undefined) continue;
        admitted.files.set(id, file);
        unnamed.add(id);
      }
    } else if (step.op === 'peer') {
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
  for (const open of fds.values()) if (open.refHandle !== undefined) await errnoOf(() => direct.close(open.refHandle));
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
for (const seed of seeds) {
  const steps = program(seed);
  const failure = await run(steps).then(() => null, (error) => error);
  if (failure === null) continue;
  const minimal = await shrink(steps);
  const reason = await run(minimal).then(() => failure, (error) => error);
  console.error(`seed ${seed} fails: ${reason.message}\nminimal program (${minimal.length} steps):\n${minimal.map((step) => `  ${JSON.stringify(step)}`).join('\n')}`);
  process.exit(1);
}
console.log(`resident-fs-model: ${seeds.length} programs agree with the model`);
