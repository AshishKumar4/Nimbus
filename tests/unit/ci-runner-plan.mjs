// The CI runner's timing history and shard count (apps/ci-runner/src/plan.ts):
//   - a file's times are the median of its last five passes, so one outlier
//     does not move them; a failure keeps the entry's times and takes the
//     file's tier;
//   - a timeout bounds a file that has never passed (it ran at least that
//     long), and a pass replaces that bound; a timeout of a file that has
//     passed is a hang and changes nothing (one 900 s hang of a 3 s file
//     once planned it as a shard of its own);
//   - the default shard count fits the target, is never below what the
//     longest file needs, is capped, and counts only the commit's files
//     when the client names them.
import assert from 'node:assert/strict';
import { MAX_SHARDS, TARGET_MS, defaultShards, emptyHistory, mergeHistory } from '../../apps/ci-runner/src/plan.ts';

const file = (name, wallMs, extra = {}) => ({ name, ok: true, tier: 'fast', serial: false, wallMs, cpuMs: wallMs, memoryPeakBytes: 1 << 20, ...extra });
const timedOut = (name, wallMs) => file(name, wallMs, { ok: false, reason: `file exceeded --timeout ${wallMs}ms (SIGKILL)` });

// The median of the last five passes, and a failure's times are not its duration.
let h = mergeHistory(emptyHistory(), [file('a.mjs', 1000)], 20_000, 1);
h = mergeHistory(h, [file('a.mjs', 3000)], 30_000, 2);
h = mergeHistory(h, [file('a.mjs', 2000)], null, 2);
assert.equal(h.files['a.mjs'].wallMs, 2000);
assert.equal(h.files['a.mjs'].samples, 3);
assert.equal(h.setupMs, 25_000);
// One outlier moves nothing: a 450 s pass of a 2 s file.
const steady = mergeHistory(h, [file('a.mjs', 450_000)], null, 2);
assert.equal(steady.files['a.mjs'].wallMs, 3000, 'the median of 1, 2, 3, 450 s is the third');
let decayed = steady;
for (let i = 0; i < 5; i++) decayed = mergeHistory(decayed, [file('a.mjs', 2000)], null, 2);
assert.equal(decayed.files['a.mjs'].wallMs, 2000, 'and is gone after five passes');
h = mergeHistory(h, [file('a.mjs', 50, { ok: false, reason: 'exit code=1', tier: 'slow' })], null, 3);
assert.equal(h.files['a.mjs'].wallMs, 2000, 'a failure keeps the times');
assert.equal(h.files['a.mjs'].tier, 'slow', 'and takes the tier');

// A hang of a file that has passed changes nothing but its tier.
h = mergeHistory(h, [timedOut('a.mjs', 900_000)], null, 4);
assert.equal(h.files['a.mjs'].wallMs, 2000, 'a hang is not a duration');

// A timeout bounds a file never seen passing; a pass replaces the bound.
h = mergeHistory(h, [timedOut('long.mjs', 600_000)], null, 5);
assert.equal(h.files['long.mjs'].wallMs, 600_000);
assert.equal(h.files['long.mjs'].samples, 0);
h = mergeHistory(h, [timedOut('long.mjs', 900_000)], null, 6);
assert.equal(h.files['long.mjs'].wallMs, 900_000, 'a longer timeout raises the bound');
h = mergeHistory(h, [file('long.mjs', 700_000)], null, 7);
assert.equal(h.files['long.mjs'].wallMs, 700_000, 'the first pass replaces the bound, not averaged with it');
assert.equal(h.files['long.mjs'].samples, 1);

// A failure of a file never seen adds nothing.
h = mergeHistory(h, [file('new.mjs', 10, { ok: false, reason: 'exit code=1' })], null, 8);
assert.equal(h.files['new.mjs'], undefined);

// Shard counts.
const history = (files) => ({ ...emptyHistory(), setupMs: 30_000, files: Object.fromEntries(files.map((f) => [f.name, { ...f, samples: 1, updatedAt: 0 }])) });
assert.equal(defaultShards(emptyHistory(), 'all', 4), 16, 'no history: 16, and the run measures');
const many = Array.from({ length: 400 }, (_, i) => file(`f${i}.mjs`, 20_000));
const shards = defaultShards(history(many), 'all', 4);
const perShard = (400 * 20_000) / 4 / shards;
assert.ok(perShard <= TARGET_MS, `${shards} shards leave ${perShard} ms each, over the target`);
assert.ok(defaultShards(history(many), 'all', 4) > defaultShards(history(many.slice(0, 100)), 'all', 4), 'more work, more shards');
assert.equal(defaultShards(history([file('one.mjs', 30 * 60_000)]), 'all', 4), 1, 'one long file needs one shard, not many');
assert.equal(defaultShards(history(Array.from({ length: 5000 }, (_, i) => file(`g${i}.mjs`, 60_000))), 'all', 4), MAX_SHARDS);
assert.equal(defaultShards(history(many), 'slow', 4), 16, 'nothing measured in the tier: 16, as with no history');
// Another branch's entries do not size this commit's run: a 30 min file
// the commit lacks leaves its count alone, and a file the history lacks
// costs the median.
const others = history([...many, file('elsewhere.mjs', 30 * 60_000)]);
// A timeout's bound does not set the budget: a hang is planned around, not for.
const hung = { ...history(many), files: { ...history(many).files, 'hang.mjs': { ...file('hang.mjs', 900_000), samples: 0, updatedAt: 0 } } };
assert.ok(defaultShards(hung, 'all', 4) >= shards, 'a hung file does not shrink the run');
const names = many.map((f) => f.name);
assert.equal(defaultShards(others, 'all', 4, [], names), shards, 'a file outside the commit is ignored');
assert.ok(defaultShards(others, 'all', 4, [], [...names, ...Array.from({ length: 400 }, (_, i) => `new${i}.mjs`)]) > shards, 'unmeasured files count');
console.log('ci-runner-plan: history merge, timeout bounds and shard counts');
