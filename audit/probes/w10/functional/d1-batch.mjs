// W10 functional: D1 batch() multi-statement, atomic

import { eq, ok, gte, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/binding-d1.ts';

const { sql } = makeMockSql();
const d1 = new D1Emulator({ sqlStorage: sql, binding: 'DB', onLog: () => {} });

await d1.exec('CREATE TABLE counters (key TEXT PRIMARY KEY, val INTEGER)');

// batch of mixed statements
const results = await d1.batch([
  d1.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').bind('a', 1),
  d1.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').bind('b', 2),
  d1.prepare('SELECT val FROM counters WHERE key = ?').bind('a'),
]);
ok('batch returns array', Array.isArray(results));
eq('batch returns 3 results', results.length, 3);
eq('first INSERT success', results[0].success, true);
gte('first INSERT changes', results[0].meta.changes, 1);
eq('second INSERT success', results[1].success, true);
ok('SELECT result is the row', results[2].results && results[2].results[0]?.val === 1);

// Atomicity: failing statement rolls back entire batch
const before = await d1.prepare('SELECT * FROM counters').all();
let threw = false;
try {
  await d1.batch([
    d1.prepare('INSERT INTO counters (key, val) VALUES (?, ?)').bind('c', 3),
    d1.prepare('INSERT INTO bad_table_does_not_exist (k) VALUES (?)').bind('x'),
  ]);
} catch (e) { threw = true; }
ok('batch with failure throws', threw);

const after = await d1.prepare('SELECT * FROM counters').all();
eq('failed batch did NOT persist partial', after.results.length, before.results.length);

summary('w10/functional/d1-batch');
