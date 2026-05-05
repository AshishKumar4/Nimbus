// W10 functional: D1 prepare/bind/run roundtrip

import { ok, eq, gte, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/binding-d1.ts';

const { sql } = makeMockSql();
const d1 = new D1Emulator({ sqlStorage: sql, binding: 'DB', onLog: () => {} });

// CREATE TABLE via exec (no params)
const exec1 = await d1.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
ok('exec returns object', typeof exec1 === 'object');
ok('exec.count is number', typeof exec1.count === 'number');

// prepare + bind + run
const stmt = d1.prepare('INSERT INTO users (name, age) VALUES (?, ?)');
ok('prepare returns object', typeof stmt === 'object');
ok('stmt has bind method', typeof stmt.bind === 'function');

const bound = stmt.bind('alice', 30);
ok('bind returns a (new) prepared statement', typeof bound === 'object' && typeof bound.run === 'function');

const r = await bound.run();
eq('run.success', r.success, true);
ok('run.meta exists', !!r.meta);
gte('run.meta.changes', r.meta.changes, 1);
ok('run.meta.duration is number', typeof r.meta.duration === 'number');
gte('run.meta.last_row_id positive', r.meta.last_row_id, 1);

// Insert another row
await d1.prepare('INSERT INTO users (name, age) VALUES (?, ?)').bind('bob', 25).run();

// Read back via .first
const first = await d1.prepare('SELECT name FROM users WHERE name = ?').bind('alice').first();
eq('first returns row object', first, { name: 'alice' });

// .first(colName) returns scalar
const ageOnly = await d1.prepare('SELECT age FROM users WHERE name = ?').bind('alice').first('age');
eq('first(colName) returns scalar', ageOnly, 30);

// Missing row
const missing = await d1.prepare('SELECT * FROM users WHERE name = ?').bind('zara').first();
eq('first on no-match returns null', missing, null);

summary('w10/functional/d1-prepare-bind-run');
