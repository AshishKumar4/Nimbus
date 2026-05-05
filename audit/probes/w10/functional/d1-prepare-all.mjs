// W10 functional: D1 prepare(...).all() multi-row results + meta

import { eq, gte, ok, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/binding-d1.ts';

const { sql } = makeMockSql();
const d1 = new D1Emulator({ sqlStorage: sql, binding: 'DB', onLog: () => {} });

await d1.exec('CREATE TABLE animals (id INTEGER PRIMARY KEY, kind TEXT, name TEXT)');
for (const [k, n] of [['cat', 'whiskers'], ['cat', 'felix'], ['dog', 'rex'], ['dog', 'buddy'], ['bird', 'tweety']]) {
  await d1.prepare('INSERT INTO animals (kind, name) VALUES (?, ?)').bind(k, n).run();
}

const r = await d1.prepare('SELECT name FROM animals WHERE kind = ? ORDER BY name ASC').bind('cat').all();
eq('all.success', r.success, true);
ok('all.results array', Array.isArray(r.results));
eq('all.results length', r.results.length, 2);
eq('all.results[0]', r.results[0], { name: 'felix' });
eq('all.results[1]', r.results[1], { name: 'whiskers' });
gte('rows_read accounting', r.meta.rows_read, 2);

// All rows of a table
const r2 = await d1.prepare('SELECT * FROM animals').all();
eq('all w/o WHERE returns 5', r2.results.length, 5);

// raw() — array of arrays
const raw = await d1.prepare('SELECT name, kind FROM animals WHERE kind = ?').bind('dog').raw();
ok('raw returns array', Array.isArray(raw));
eq('raw row count', raw.length, 2);
ok('raw rows are arrays', raw.every(r => Array.isArray(r)));
eq('raw first row contents', raw[0], ['rex', 'dog']);

summary('w10/functional/d1-prepare-all');
