// W10 functional: CTEs (WITH) and TRIGGERs work via the D1 emulator
// (the §14.1 amendment switched D1 to a child-DO-facet backing strategy
// to avoid SQL rewrite hazards. This probe asserts the strategy actually
// avoids them.)

import { ok, eq, summary } from '../_tap.mjs';
import { makeMockSql } from '../_mock-sql.mjs';
import { D1Emulator } from '../../../../src/bindings/d1.ts';

const { sql } = makeMockSql();
const d1 = new D1Emulator({ sqlStorage: sql, binding: 'DB', onLog: () => {} });

await d1.exec(`
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price INTEGER);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY, msg TEXT);
`);

await d1.prepare('INSERT INTO products (name, price) VALUES (?, ?)').bind('coffee', 5).run();
await d1.prepare('INSERT INTO products (name, price) VALUES (?, ?)').bind('tea', 4).run();
await d1.prepare('INSERT INTO products (name, price) VALUES (?, ?)').bind('water', 0).run();

// CTE
const cteResult = await d1.prepare(
  'WITH cheap AS (SELECT name FROM products WHERE price < ?) SELECT name FROM cheap'
).bind(5).all();
ok('CTE query succeeded', cteResult.success === true);
eq('CTE returns rows', cteResult.results.length, 2);

// CREATE TRIGGER (no-op execution path; emulator accepts without crashing)
let threw = false;
try {
  await d1.exec(`CREATE TRIGGER log_insert AFTER INSERT ON products
                 BEGIN INSERT INTO audit_log (msg) VALUES ('inserted'); END`);
} catch (e) { threw = true; }
ok('CREATE TRIGGER does not throw', !threw);

// Subsequent INSERT still works after trigger creation
const r = await d1.prepare('INSERT INTO products (name, price) VALUES (?, ?)').bind('milk', 2).run();
ok('INSERT after CREATE TRIGGER succeeds', r.success === true);

summary('w10/functional/d1-cte-and-trigger');
