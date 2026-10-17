#!/usr/bin/env bun
// @tier slow — 120 programs and failure shrinking took 67 s wall, 0.99 GiB on armada.
// The model's programs through the real WASI body, against ProcessFiles.
// Each step compares refusals, descriptor bytes and stats, /dev/fd opens,
// and path sizes, modes and bytes. Peers belong to the guest's own session.
// NIMBUS_MODEL_SEEDS: how many seeds (default 120); NIMBUS_MODEL_SEED: one.

import assert from 'node:assert/strict';
import { DIR, NAMES, program } from './lib/fs-programs.mjs';
import { canPark, residentGuest, USER } from './lib/wasi-resident-guest.mjs';

if (!canPark) {
  console.log('resident-fs-model-wasi: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ERRNO = { EACCES: 2, EAGAIN: 6, EBADF: 8, EBUSY: 10, EEXIST: 20, EINVAL: 28, EIO: 29, EISDIR: 31, ENOENT: 44, ENOSPC: 51, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58, EPERM: 63, ESTALE: 72, ENOTCAPABLE: 76 };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const ok = async (work) => { const errno = await work; if (errno !== 0) throw Object.assign(new Error(`errno ${errno}`), { errno }); };
const outcome = async (work) => {
  try { return { errno: 0, value: await work() }; }
  catch (error) {
    const errno = ERRNO[error.code] ?? error.errno;
    if (errno === undefined) throw error;
    return { errno };
  }
};

/** One session, disjoint trees: a guest's and its direct reference process's. */
async function run(steps) {
  const guest = await residentGuest();
  const { authority, processes } = guest.session;
  const { pid } = processes.spawn('model-reference', [], '/', { cred: USER });
  const direct = authority.bind({ pid, cred: USER });
  const reference = 'model-reference';
  const path = (name) => `${DIR}/${name}`;
  const refPath = (name) => `/${reference}/${name}`;
  const fds = new Map();
  let failed = false;
  try {
    for (const root of [DIR, reference]) {
      guest.kernel.mkdir(root, { recursive: true });
      guest.kernel.chown(root, USER.uid, USER.gid);
    }
    guest.inbound();

    /** The codec checks WASI rights before the session checks open access. */
    const compare = async (label, actual, expected, denied) => {
      const want = await outcome(expected);
      if (denied !== undefined && want.errno === ERRNO[denied]) want.errno = ERRNO.ENOTCAPABLE;
      const got = await outcome(actual);
      assert.equal(got.errno, want.errno, `${label} errno (${got.errno} vs ${want.errno})`);
      if (got.errno === 0) assert.deepEqual(got.value, want.value, label);
      return got;
    };
    const stat = async (name) => {
      const st = await direct.stat(refPath(name));
      if (st === null) fail('ENOENT');
      return { size: Number(st.size), nlink: Number(st.nlink), mode: st.mode & 0o7777 };
    };
    const fstat = async (fd) => {
      const st = await direct.fstat(fd);
      return { nlink: Number(st.nlink), size: Number(st.size) };
    };
    const compareStat = async (label, actual, expected) => {
      const want = await outcome(expected), got = await outcome(actual);
      assert.equal(got.errno, want.errno, `${label} errno (${got.errno} vs ${want.errno})`);
      if (got.errno !== 0) return;
      for (const field of Object.keys(want.value)) assert.equal(got.value[field], want.value[field], `${label} ${field}${field === 'nlink' ? ` (${got.value[field]} vs ${want.value[field]})` : ''}`);
    };
    // Attribute operations need live descriptions, not immutable read-only copies.
    const open = (name, flags) => guest.open(name, { ...flags, allocate: true });

    const check = async (label, contents = false) => {
      for (const [fd, opened] of fds) {
        await compareStat(`${label}: fd ${fd} fd_filestat_get`, () => guest.fstat(opened.guest), () => fstat(opened.direct));
        if (opened.flags.read) await compare(`${label}: fd ${fd} fd_pread`, () => guest.pread(opened.guest, 1 << 12), async () => dec.decode(await direct.read(opened.direct, 0, 1 << 12)));
      }
      for (const name of NAMES) {
        await compareStat(`${label}: ${name} path_filestat_get`, () => guest.stat(path(name)), () => stat(name));
        if (!contents) continue;
        await compare(`${label}: ${name} path bytes`, async () => {
          const fd = await open(path(name), { read: true });
          try { return await guest.pread(fd, 1 << 12); }
          finally { await ok(guest.close(fd)); }
        }, async () => {
          const bytes = await direct.readFile(refPath(name));
          if (bytes === null) fail('ENOENT');
          return dec.decode(bytes);
        });
      }
    };

    const processStep = async (step, label) => {
      const opened = fds.get(step.fd);
      if (step.op === 'open' || step.op === 'reopen') {
        if (opened !== undefined) return;
        const via = fds.get(step.via);
        if (step.op === 'reopen' && via === undefined) return;
        let ours, theirs;
        await compare(`${label}: ${step.op === 'reopen' ? '/dev/fd open' : 'open'}`, async () => {
          ours = await open(step.op === 'reopen' ? `dev/fd/${via.guest}` : path(step.name), step.flags);
        }, async () => {
          const flags = { ...step.flags, mode: 0o666, umask: USER.umask };
          theirs = (await (step.op === 'reopen' ? direct.reopen({ handle: via.direct }, flags) : direct.open(refPath(step.name), flags))).id;
        });
        if (ours !== undefined) fds.set(step.fd, { guest: ours, direct: theirs, flags: step.flags });
      } else if (['write', 'ftruncate', 'close', 'read', 'readAsync', 'fchmod', 'futimes'].includes(step.op)) {
        if (opened === undefined) return;
        if (step.op === 'write') await compare(`${label}: fd_write`, () => guest.writeAt(opened.guest, step.data, step.offset), () => direct.write(opened.direct, step.offset, enc.encode(step.data)), opened.flags.write ? undefined : 'EBADF');
        else if (step.op === 'ftruncate') await compare(`${label}: fd_filestat_set_size`, () => ok(guest.ftruncate(opened.guest, step.size)), async () => { await direct.ftruncate(opened.direct, step.size); }, opened.flags.write ? undefined : 'EINVAL');
        else if (step.op === 'fchmod') await compare(`${label}: fd_chmod`, () => ok(guest.fchmod(opened.guest, step.mode)), async () => { await direct.fchmod(opened.direct, step.mode); });
        else if (step.op === 'futimes') await compare(`${label}: fd_filestat_set_times`, () => ok(guest.futimes(opened.guest, step.atime, step.mtime)), async () => { await direct.futimes(opened.direct, step.atime, step.mtime); });
        else if (step.op === 'readAsync') await compare(`${label}: fd_pread`, () => guest.pread(opened.guest, 1 << 12), async () => dec.decode(await direct.read(opened.direct, 0, 1 << 12)), opened.flags.read ? undefined : 'EBADF');
        else if (step.op === 'read') await compare(`${label}: fd_read`, () => guest.read(opened.guest, 1 << 12), async () => dec.decode(await direct.read(opened.direct, null, 1 << 12)), opened.flags.read ? undefined : 'EBADF');
        else {
          await compare(`${label}: fd_close`, () => ok(guest.close(opened.guest)), async () => { await direct.close(opened.direct); });
          fds.delete(step.fd);
        }
      } else if (step.op === 'rename') await compare(`${label}: path_rename`, () => ok(guest.rename(path(step.from), path(step.to))), async () => { await direct.rename(refPath(step.from), refPath(step.to)); });
      else if (step.op === 'unlink') await compare(`${label}: path_unlink_file`, () => ok(guest.unlink(path(step.name))), async () => { await direct.unlink(refPath(step.name)); });
      else if (step.op === 'chmod') await compare(`${label}: path_chmod`, () => ok(guest.chmod(path(step.name), step.mode)), async () => { await direct.chmod(refPath(step.name), step.mode); });
      else if (step.op === 'utimes') await compare(`${label}: path_filestat_set_times`, () => ok(guest.utimes(path(step.name), step.atime, step.mtime)), async () => { await direct.utimes(refPath(step.name), step.atime, step.mtime); });
      else if (step.op === 'writeFile') await compare(`${label}: writeFile`, async () => {
        const fd = await open(path(step.name), { read: false, write: true, create: true, truncate: true });
        try { await guest.writeAt(fd, step.data); }
        finally { await ok(guest.close(fd)); }
      }, async () => { await direct.writeFile(refPath(step.name), enc.encode(step.data)); });
      else assert.fail(`unknown operation ${step.op}`);
    };

    const peerStep = async (step, label) => {
      // The reference received our earlier calls before the peer's; so must this session.
      await guest.flush();
      const change = (kernel, root) => {
        const at = `${root}/${step.name}`;
        if (step.kind === 'write') { kernel.writeFile(at, enc.encode(step.data)); kernel.chown(at, USER.uid, USER.gid); }
        else if (step.kind === 'unlink') kernel.unlink(at);
        else if (step.kind === 'rename') kernel.rename(at, `${root}/${step.to}`);
        else if (step.kind === 'chmod') kernel.chmod(at, step.mode);
        else assert.fail(`unknown peer operation ${step.kind}`);
      };
      await compare(`${label}: peer ${step.kind}`, () => guest.peer((kernel) => change(kernel, DIR)), () => change(guest.kernel, reference));
      // The peer's completion is input to the process, as a child's wait is.
      guest.inbound();
    };

    await check('the start');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], label = `step ${i} ${JSON.stringify(step)}`;
      if (step.op === 'deliver' || step.op === 'catchUp') {
        await guest.flush();
        if (step.op === 'catchUp') guest.inbound();
      } else if (step.op === 'peer') await peerStep(step, label);
      else await processStep(step, label);
      await check(label);
    }
    for (const fd of [...fds.keys()]) await processStep({ op: 'close', fd }, 'the end');
    assert.equal(await guest.settle(), null, 'the end: unsettled writes');
    guest.inbound();
    await check('the end', true);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      for (const opened of fds.values()) {
        await outcome(() => ok(guest.close(opened.guest)));
        await direct.close(opened.direct);
      }
      await guest.end();
    } catch (error) { if (!failed) throw error; }
    finally { await authority.releaseProcess(pid); await guest.dispose(); }
  }
}

/** A failure's kind, with the step, its values and names removed. */
const kindOf = (error) => String(error.message).split('\n')[0].replace(/^step \d+ \{.*\}: /, '').replace(/\b[a-c]\b/g, 'N').replace(/fd \d/g, 'fd');

/** Delete steps until no single deletion preserves this failure's kind. */
async function shrink(steps, kind) {
  let current = steps;
  for (let chunk = Math.ceil(current.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let at = 0; at < current.length;) {
      const candidate = [...current.slice(0, at), ...current.slice(at + chunk)];
      if (await run(candidate).then(() => false, (error) => kindOf(error) === kind)) { current = candidate; if (chunk === 1) at = 0; }
      else at += chunk;
    }
  }
  return current;
}

const seeds = process.env.NIMBUS_MODEL_SEED !== undefined
  ? [Number(process.env.NIMBUS_MODEL_SEED)]
  : Array.from({ length: Number(process.env.NIMBUS_MODEL_SEEDS ?? 120) }, (_, i) => i + 1);
const failures = new Map();
const WRITER = { read: true, write: true, append: false, create: true, exclusive: false, truncate: true };
const FOUND = [
  { name: '/dev/fd after a rename in a busy subtree', steps: [
    ...Array.from({ length: 8 }, () => ({ op: 'writeFile', name: 'c', data: 'p' })),
    { op: 'unlink', name: 'c' },
    { op: 'open', fd: 0, name: 'a', flags: WRITER },
    { op: 'rename', from: 'a', to: 'b' },
    { op: 'reopen', fd: 1, via: 0, flags: { ...WRITER, create: false } },
  ] },
  { name: 'fd_filestat_get after a peer unlinks the written file', steps: [
    { op: 'open', fd: 0, name: 'a', flags: WRITER },
    { op: 'write', fd: 0, offset: null, data: 'pqr' },
    { op: 'peer', kind: 'unlink', name: 'a' },
  ] },
];
for (const found of FOUND) {
  const failure = await run(found.steps).then(() => null, (error) => error);
  if (failure === null) continue;
  const kind = kindOf(failure);
  const minimal = await shrink(found.steps, kind);
  const reason = await run(minimal).then(() => failure, (error) => error);
  failures.set(`found: ${found.name} (${kind})`, { seeds: [0], reason, minimal });
}
for (const seed of seeds) {
  const steps = program(seed, 40, { wasi: true });
  const failure = await run(steps).then(() => null, (error) => error);
  if (failure === null) continue;
  const kind = kindOf(failure);
  if (failures.has(kind)) { failures.get(kind).seeds.push(seed); continue; }
  const minimal = await shrink(steps, kind);
  const reason = await run(minimal).then(() => failure, (error) => error);
  failures.set(kind, { seeds: [seed], reason, minimal });
  if (failures.size >= 12) break;
}
for (const [kind, { seeds: failing, reason, minimal }] of failures) {
  console.error(`FAILURE ${kind} (seeds ${failing.slice(0, 8).join(', ')}${failing.length > 8 ? ', ...' : ''}): ${reason.message}\nminimal program (${minimal.length} steps):\n${minimal.map((step) => `  ${JSON.stringify(step)}`).join('\n')}\n`);
}
if (failures.size > 0) process.exit(1);
console.log(`resident-fs-model-wasi: ${seeds.length} programs agree with the authority`);
