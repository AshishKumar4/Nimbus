#!/usr/bin/env bun
/**
 * barrier-oracle — the model barrier schedules are judged against
 * (lib/barrier-schedule.mjs createModel) admits the answers the session's
 * files gave, and refuses every answer they never gave: a harness that
 * admitted an impossible state would hide the very bugs it exists to find.
 * No engine runs here; the model is driven as a schedule drives it.
 */

import assert from 'node:assert/strict';
import { createModel } from './lib/barrier-schedule.mjs';

const file = (size, mode = 0o644, uid = 1000) => ({ type: 'file', mode, size, uid });
const dir = (mode = 0o755, uid = 1000) => ({ type: 'directory', mode, size: 0, uid });
/** A change begun and returned. */
const done = (model, step) => model.finish(model.begin(step));

{
  // A write that returned is never read back as the truncated file it passed through; one in flight may be.
  const model = createModel();
  const write = model.begin(['own', 'write', 'top', 'new bytes']);
  const during = model.seq();
  assert.ok(model.admits('readFile', 'top', '', during, during), 'in flight, the truncated file');
  assert.ok(model.admits('readFile', 'top', 't0000000', during, during), 'in flight, the file before');
  assert.ok(model.admits('readFile', 'top', 'new bytes', during, during), 'in flight, the file after');
  model.finish(write);
  const after = model.seq();
  assert.ok(!model.admits('readFile', 'top', '', after, after), 'returned: never the truncated file');
  assert.ok(!model.admits('readFile', 'top', 't0000000', after, after), 'returned: never the file before');
  assert.ok(model.admits('readFile', 'top', 'new bytes', after, after));
  assert.ok(!model.admits('stat', 'top', file(0), after, after), 'nor its size truncated');
}
{
  // A peer's write is whole: no truncated state, even in flight.
  const model = createModel();
  model.begin(['peer', 'write', 'top', 'peer bytes']);
  assert.ok(!model.admits('readFile', 'top', '', model.seq(), model.seq()));
}
{
  // A listing is one a directory held: changes that never coexisted are not combined.
  const model = createModel();
  const from = model.seq();
  done(model, ['peer', 'write', 'x/f', 'f']);
  done(model, ['peer', 'unlink', 'x/h']);
  const to = model.seq();
  for (const listing of [['h'], ['f', 'h'], ['f']]) assert.ok(model.admits('readdir', 'x', listing, from, to), `[${listing}]`);
  assert.ok(!model.admits('readdir', 'x', [], from, to), 'never the empty directory: h went only after f came');
  assert.ok(!model.admits('readdir', 'x', ['g'], from, to));
}
{
  // An answer from before the last landed barrier is stale.
  const model = createModel();
  done(model, ['peer', 'unlink', 'top']);
  const landed = model.seq();
  assert.ok(!model.admits('stat', 'top', file(8), landed, landed), 'the removed file');
  assert.ok(model.admits('stat', 'top', null, landed, landed));
  assert.ok(model.admits('stat', 'top', file(8), 0, landed), 'from before the barrier it may still show');
}
{
  // A change in flight may show its effect; one begun after the read was answered is not in its window.
  const model = createModel();
  const from = model.seq();
  model.begin(['peer', 'rename', 'x/h', 'd/n']);
  assert.ok(model.admits('stat', 'd/n', file(3), from, model.seq()), 'the rename in flight may have landed');
  assert.ok(model.admits('stat', 'd/n', null, from, model.seq()), 'or not');
  const other = createModel();
  const read = other.seq();
  assert.ok(!other.admits('stat', 'd/n', file(3), read, read), 'nothing put it there');
}
{
  // The process's credential: beneath a directory it may not search, a name is EACCES; its bytes are no miss.
  const model = createModel();
  done(model, ['root', 'chown', 'd', 0]);
  done(model, ['root', 'chmod', 'd', 0o700]);
  const now = model.seq();
  assert.ok(!model.admits('stat', 'd/f', file(2), now, now), 'a file it cannot reach');
  assert.ok(!model.admits('stat', 'd/f', null, now, now), 'nor absent');
  assert.ok(model.admits('stat', 'd/f', { code: 'EACCES' }, now, now));
  assert.ok(model.admits('stat', 'd', dir(0o700, 0), now, now), 'the directory itself it may see');
  assert.ok(!model.admits('readdir', 'd', ['e', 'f'], now, now), 'nor list');
  assert.ok(!model.readable('d/f', now, now), 'a refusal of bytes it may not read is no miss');
}
{
  // What a refusal of bytes (EAGAIN) can be about: a file the process may read, and nothing else.
  const model = createModel();
  const now = model.seq();
  assert.ok(model.readable('top', now, now));
  assert.ok(!model.readable('new', now, now), 'an absent name: ENOENT, not a miss');
  assert.ok(!model.readable('d', now, now), 'a directory');
  done(model, ['own', 'chmod', 'top', 0o200]);
  assert.ok(!model.readable('top', model.seq(), model.seq()), 'a file it may not read');
}

{
  // The process's own changes land in the order it made them: a later one shows only with every earlier one it overlaps.
  const model = createModel();
  const from = model.seq();
  model.begin(['own', 'rename', 'top', 'new']);
  model.begin(['own', 'write', 'new', 'rewritten']);
  const to = model.seq();
  assert.ok(model.admits('readdir', '', ['d', 'top', 'x'], from, to), 'neither landed');
  assert.ok(model.admits('readdir', '', ['d', 'new', 'x'], from, to), 'the rename landed');
  assert.ok(!model.admits('readdir', '', ['d', 'new', 'top', 'x'], from, to), 'never the write without the rename it follows');
  assert.ok(model.admits('readFile', 'new', 'rewritten', from, to));
  assert.ok(model.admits('readFile', 'new', 't0000000', from, to), 'the rename alone');
}
{
  // A change the process decides when it calls it is shown, decided, to its own calls that cannot wait.
  const model = createModel();
  model.begin(['own', 'rename', 'x/h', 'd/n']);
  const now = model.seq();
  assert.ok(model.admits('stat', 'd/n', null, now, now), 'to a reader that cannot know it');
  assert.ok(!model.admits('stat', 'd/n', null, now, now, true), 'not to the process that decided it');
  assert.ok(model.admits('stat', 'd/n', file(3), now, now, true));
  assert.ok(!model.admits('stat', 'x/h', file(3), now, now, true));
}

{
  // A descriptor follows what it opened: a directory a peer renamed after the open lists where it went, with what was made there since.
  const model = createModel();
  const from = model.seq();
  model.finish(model.begin(['peer', 'rename', 'd', 'x/e']));
  model.finish(model.begin(['peer', 'write', 'x/e/g', 'new']));
  const to = model.seq();
  assert.ok(model.followed('opendir', 'd', ['e', 'f', 'g'], from, to), 'd, opened before the rename, read after the write');
  assert.ok(!model.followed('opendir', 'd', ['e', 'f', 'g'], to, to), 'not opened after it moved');
  assert.ok(!model.followed('opendir', 'd', ['g'], from, to), 'never a listing it did not hold');
}

console.log('barrier-oracle: ok');
