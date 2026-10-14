#!/usr/bin/env bun
// A project's D1 database is the facet its project root and database name,
// each whole: no two (root, database) pairs name one facet, so no project's
// migrations or statements run in another's database. Red before: the name
// joined the two with ':', so root 'home/user/a' with database 'b:c' and
// root 'home/user/a:b' with database 'c' named one facet.
import assert from 'node:assert/strict';
import { d1DatabaseFacetName } from '../../packages/worker/src/bindings/d1.ts';

const pairs = [
  ['home/user/a', 'b:c'],
  ['home/user/a:b', 'c'],
  ['home/user/a', 'b'],
  ['home/user', 'a:b'],
  ['home/user/a"', 'b'],
  ['home/user/a', '"b'],
];
const names = pairs.map(([root, database]) => d1DatabaseFacetName(root, database));
assert.equal(new Set(names).size, pairs.length, `each (root, database) its own facet: ${JSON.stringify(names)}`);
for (const name of names) assert.ok(name.startsWith('d1:'), `a D1 database's facet is in the d1: names: ${name}`);
console.log('d1-database-facet-name: ok');
