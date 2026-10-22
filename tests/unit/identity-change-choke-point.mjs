#!/usr/bin/env bun
// @tier slow — builds the root tsconfig's program: on armada 1.32 GiB peak, 21.8 s CPU, 9.0 s wall
// The identity policy (identity-change-policy.mjs) is asked in the one place
// a process is made: SessionProcessSupervisor.spawn, before it calls
// ProcessTable.spawn. This holds that by what each reference resolves to (the
// type checker), not its spelling, so an alias (`const t = this.table`, a
// bound `spawn`, `const T = ProcessTable`) is still found: ProcessTable.spawn
// is referred to only there, and the ProcessTable class only as the
// supervisor's own table. A process's cred is readonly outside the table
// (ProcessEntry), so tsrs refuses any other write to it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processTableReferences } from './lib/identity-choke-point-scan.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const SUPERVISOR = join(repo, 'packages/core/src/runtime/session-process-supervisor.ts');
const { spawnReferences, tableValues } = processTableReferences();
const supervisor = relative(repo, SUPERVISOR);
assert.deepEqual(spawnReferences, [`${supervisor} SessionProcessSupervisor.spawn`], 'ProcessTable.spawn is referred to only in the supervisor\'s spawn');
assert.deepEqual(tableValues, [`${supervisor} SessionProcessSupervisor.table`], 'the one process table is the supervisor\'s');
const spawn = readFileSync(SUPERVISOR, 'utf8').match(/\n {2}spawn\([^]*?\n {2}\}\n/)?.[0] ?? '';
const asks = spawn.indexOf('this.identityPolicy(');
assert.ok(asks !== -1 && asks < spawn.indexOf('this.table.spawn('), 'which asks the policy before it makes the process');
console.log('identity-change-choke-point: a process is made in one place, which asks the identity policy');
