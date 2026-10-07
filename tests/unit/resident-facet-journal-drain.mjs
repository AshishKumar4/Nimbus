#!/usr/bin/env bun
// A resident's write log is drained from its facet's store before the store
// goes (workerd-facet-host.ts, spawnResident's release; process-fs-journal.ts).
//
// The process logs every change in its facet's SQLite before its program is
// told it succeeded. When the process is released (killed, out of memory or
// CPU, or ended), the facet is aborted, and its store is opened again with
// the journal reader class (facetJournal) and handed to the session's drain:
// only once that drain lands is the store deleted and the release settled, so
// the exit its caller reports after comes after the files. A drain that
// fails keeps the store and its slot. Red before: release deleted the store
// at once, with whatever the process had logged and the session not answered.

import assert from 'node:assert/strict';
import { processes, reservedFacetNames, residentFacetName } from '../../packages/fabric/src/workerd-facet-host.ts';

/** A `ctx.facets` that records each call in order, and opens the reader over a name's store. */
function makeCtx(id) {
  const events = [];
  const stored = new Set();
  const loaded = [];
  const readers = new Map();
  return {
    id: { toString: () => id },
    storage: { async get() { return undefined; }, async put() {} },
    events,
    stored,
    loaded,
    readers,
    facets: {
      get(name, start) {
        events.push(`get ${name}`);
        stored.add(name);
        const reader = readers.get(name);
        if (reader) {
          // The class the name is opened with is the reader's.
          return {
            async numberings() {
              const { class: cls } = await start();
              assert.equal(cls, 'NimbusFsJournalReader');
              events.push(`read ${name}`);
              return reader.numberings;
            },
          };
        }
        return {
          async startProcess() { return { ok: true }; },
          async handleHttpRequest() { return new Response('ok'); },
        };
      },
      abort(name) { events.push(`abort ${name}`); },
      delete(name) { events.push(`delete ${name}`); stored.delete(name); readers.delete(name); },
    },
  };
}

function envFor(ctx) {
  return {
    LOADER: {
      get: () => ({ getDurableObjectClass: () => class {} }),
      load(code) {
        ctx.loaded.push(code);
        return { getDurableObjectClass: (name) => name };
      },
    },
  };
}

const disk = () => ({});

function open(ctx, pid, journal) {
  return processes(ctx, envFor(ctx)).spawn(
    disk,
    { doId: ctx.id.toString(), pid, writerId: `w${pid}` },
    { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} }, ...(journal ? { journal } : {}) },
  );
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Opened: the session books the name; released: drained, then deleted ───
{
  const ctx = makeCtx('drain-then-delete');
  const opened = [];
  const gate = deferred();
  let numberings;
  const facet = open(ctx, 10, {
    opened: (name) => opened.push(name),
    drain: async (journal) => {
      ctx.readers.set(residentFacetName(facet.slot), { numberings: [{ writer: 'w', jid: 3 }] });
      numberings = await journal.numberings();
      await gate.promise;
    },
  });
  const name = residentFacetName(facet.slot);
  assert.deepEqual(opened, [name], 'the session was not told the facet it must drain');
  let settled = false;
  const released = facet.release().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(numberings, [{ writer: 'w', jid: 3 }], 'the drain was not handed the store\'s journal');
  assert.equal(ctx.loaded.length, 1);
  assert.match(ctx.loaded[0].modules['reader.js'], /NimbusFsJournalReader/);
  assert.equal(settled, false, 'the release settled before its drain landed');
  assert.ok(ctx.stored.has(name), 'the store went before its drain landed');
  gate.resolve();
  await released;
  // From its first get on (minting deleted what the name held before).
  const after = ctx.events.slice(ctx.events.indexOf(`get ${name}`));
  const at = (event) => after.indexOf(event);
  assert.ok(at(`abort ${name}`) >= 0 && at(`abort ${name}`) < at(`read ${name}`), 'read while the process could still run');
  assert.ok(at(`read ${name}`) < at(`delete ${name}`), `the store was deleted before it was read: ${after.join(', ')}`);
  assert.ok(!ctx.stored.has(name));
  // The slot is free again.
  const next = open(ctx, 11);
  assert.equal(next.slot, facet.slot);
}

// ── A drain that fails keeps the store and the slot, and says so, named ────
{
  const ctx = makeCtx('drain-fails');
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let facet;
  try {
    facet = open(ctx, 20, { opened() {}, drain: async () => { throw new Error('facet unreachable'); } });
    await facet.release();
  } finally {
    console.error = realError;
  }
  const name = residentFacetName(facet.slot);
  assert.ok(ctx.stored.has(name), 'a store whose log was not drained was deleted');
  assert.ok(!ctx.events.slice(ctx.events.indexOf(`get ${name}`)).includes(`delete ${name}`));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /pid 20/);
  assert.match(errors[0], new RegExp(`'${name}'`));
  assert.match(errors[0], /facet unreachable/);
  const next = open(ctx, 21);
  assert.notEqual(next.slot, facet.slot, 'the slot of an undrained store was handed out again');
}

// ── A name reserved for an undrained log (a previous incarnation's) is never minted ──
{
  const ctx = makeCtx('reserved');
  reservedFacetNames(ctx).add(residentFacetName(0));
  reservedFacetNames(ctx).add(residentFacetName(2));
  const a = open(ctx, 30);
  const b = open(ctx, 31);
  assert.deepEqual([a.slot, b.slot], [1, 3]);
  assert.ok(!ctx.events.includes(`delete ${residentFacetName(0)}`), 'minting wiped a reserved store');
}

console.log('resident-facet-journal-drain: ok');
