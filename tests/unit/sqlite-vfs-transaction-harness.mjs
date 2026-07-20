#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
harness.sql.exec('CREATE TABLE rollback_probe (value INTEGER NOT NULL)');

for (let faultPosition = 1; faultPosition <= 3; faultPosition++) {
  harness.failOnTransactionStatement(faultPosition);
  assert.throws(() => {
    harness.ctx.storage.transactionSync(() => {
      harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 1);
      harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 2);
      harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 3);
    });
  }, /injected SQL fault/);
  assert.deepEqual(
    harness.sql.exec('SELECT value FROM rollback_probe ORDER BY value'),
    [],
    `fault at SQL statement ${faultPosition} must roll back every prior statement`,
  );
}

harness.ctx.storage.transactionSync(() => {
  harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 1);
  harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 2);
  harness.sql.exec('INSERT INTO rollback_probe VALUES (?)', 3);
});
assert.deepEqual(
  harness.sql.exec('SELECT value FROM rollback_probe ORDER BY value'),
  [{ value: 1 }, { value: 2 }, { value: 3 }],
  'a successful transaction must publish every statement',
);
assert.equal(harness.transactionCount, 4);
assert.deepEqual(
  harness.statements
    .filter((statement) => statement.transaction === 4)
    .map((statement) => statement.transactionStatement),
  [1, 2, 3],
  'the harness must number every SQL statement within its transaction',
);

console.log('sqlite-vfs-transaction-harness: all assertions passed');
