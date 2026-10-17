// @serial
// @tier slow — builds the pipe model and asks the Lean kernel to check boundary writes
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cwd = new URL('../../lean/', import.meta.url).pathname;
const lake = [process.env.LAKE, join(homedir(), '.elan/bin/lake'), 'lake']
  .find(candidate => candidate && (candidate === 'lake' || existsSync(candidate)));
const source = `import Nimbus.Runtime.Pipes
open Nimbus.Runtime.Pipes

def boundary (mode : Mode) (budget : Nat) : St :=
  Cmd.init { C := 4, B := budget, m := 1, slots := [
    { mode := mode, prog := [.write 0 7, .write 0 1], writes := [0] },
    { mode := .jspi, prog := [.read 0 20], reads := [0] }] }

example : (execHead Rules.ok (boundary .bash 6) 0).1 = .wrote 7 := by decide
example : (execHead Rules.ok (boundary .plain 6) 0).1 = .wrote 7 := by decide
example : (execHead Rules.ok (boundary .jspi 0) 0).1 = .wrote 7 := by decide
example : (execHead Rules.ok (execHead Rules.ok (boundary .plain 6) 0).2 0).1 = .suspended := by decide
example : (execHead Rules.ok (execHead Rules.ok (boundary .jspi 0) 0).2 0).1 = .parked := by decide

def crossing : St := Cmd.init { C := 4, B := 1, m := 1, slots := [
  { mode := .jspi, prog := [.write 0 3, .write 0 4], writes := [0] },
  { mode := .jspi, prog := [.read 0 20], reads := [0] }] }
example : (execHead Rules.ok (execHead Rules.ok crossing 0).2 0).1 = .wrote 4 := by decide
`;
for (const [args, input] of [[['build', 'Nimbus.Runtime.Pipes'], undefined], [['env', 'lean', '--stdin'], source]]) {
  const result = spawnSync(lake, args, { cwd, input, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
}
console.log('lean-pipe-acceptance: local oversize writes and JSPI capacity pass the kernel');
