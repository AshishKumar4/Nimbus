// W10 functional: D1 exec(query) bulk SQL (no params)

import { eq, ok, gte, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/binding-d1.ts';

const { sql } = makeMockSql();
const d1 = new D1Emulator({ sqlStorage: sql, binding: 'DB', onLog: () => {} });

// Multi-statement schema setup
const sqlText = `
  CREATE TABLE foo (id INTEGER PRIMARY KEY, x TEXT);
  CREATE TABLE bar (id INTEGER PRIMARY KEY, y TEXT);
  CREATE INDEX idx_foo_x ON foo(x);
`;
const r = await d1.exec(sqlText);
ok('exec returns object', typeof r === 'object');
ok('exec.duration is number', typeof r.duration === 'number');
gte('exec.count >= 3 statements', r.count, 3);

// Now subsequent prepare() works
const probe = await d1.prepare('SELECT name FROM foo WHERE id = ?').bind(1).all();
ok('post-exec prepare succeeds (empty)', probe.success === true);

summary('w10/functional/d1-exec');
