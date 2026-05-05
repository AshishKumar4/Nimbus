// W10 functional: two D1 bindings on the same supervisor sqlStorage do NOT
// see each other's tables.
//
// Per the §14.1 amendment, real production uses one DO facet per binding
// (full isolation, separate SqlStorage instance). For unit-level testing we
// pass a SHARED MockSqlStorage to two emulators, so isolation must come from
// the emulator's table-naming scheme. Either way the test contract is
// "binding A's CREATE TABLE users does NOT clash with binding B's CREATE
// TABLE users".

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/binding-d1.ts';

const { sql } = makeMockSql();

const dbA = new D1Emulator({ sqlStorage: sql, binding: 'DB_A', onLog: () => {} });
const dbB = new D1Emulator({ sqlStorage: sql, binding: 'DB_B', onLog: () => {} });

await dbA.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
await dbB.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

await dbA.prepare('INSERT INTO users (name) VALUES (?)').bind('alice-A').run();
await dbB.prepare('INSERT INTO users (name) VALUES (?)').bind('alice-B').run();

const aRows = await dbA.prepare('SELECT * FROM users').all();
const bRows = await dbB.prepare('SELECT * FROM users').all();

eq('A has 1 row, A only', aRows.results.length, 1);
eq('B has 1 row, B only', bRows.results.length, 1);
eq('A.name', aRows.results[0].name, 'alice-A');
eq('B.name', bRows.results[0].name, 'alice-B');

// Cross-binding queries with bare table name don't leak across
const aOnly = await dbA.prepare('SELECT name FROM users WHERE name = ?').bind('alice-B').all();
eq('A cannot see B rows', aOnly.results.length, 0);

summary('w10/functional/d1-table-prefix-isolation');
