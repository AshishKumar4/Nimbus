#!/usr/bin/env bun
// Every identity change asks the host (Kinu ask 61): a process made under a
// credential other than its parent's (sudo, su, any command's ctx.runAs, a
// raw spawn with a parent and a cred) is made only if the workspace's
// `mayChangeIdentity(from, to, command)` allows it; a refusal is EPERM and no
// process. Before, sudo and su gave the session user uid 0 with nothing asked.
// The last block keeps it one choke point: a process is made, and its
// credential chosen, only where the policy is asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const asked = [];
let allowed = false;
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  mayChangeIdentity: (from, to, command) => {
    asked.push([from.uid, to.uid, command]);
    return allowed;
  },
});
ws.registry.register('elevate', async (ctx) => (await ctx.runAs(CRED_KERNEL, ['whoami'])).status);
const run = async (line) => {
  asked.length = 0;
  const result = await ws.exec(line);
  return { out: [result.stdout, result.stderr, result.exitCode], asked: [...asked] };
};
try {
  // Refused: the session user (uid 1000) becomes root by no path.
  assert.deepEqual(await run('sudo whoami'), {
    out: ['', 'sudo: EPERM: operation not permitted, uid 1000 may not become uid 0 (whoami)\n', 1],
    asked: [[1000, 0, 'whoami']],
  }, 'sudo, refused');
  assert.deepEqual(await run('su -c "whoami"'), {
    out: ['', 'su: EPERM: operation not permitted, uid 1000 may not become uid 0 (sh -c whoami)\n', 1],
    asked: [[1000, 0, 'sh -c whoami']],
  }, 'su, refused');
  const elevate = await run('elevate');
  assert.equal(elevate.out[0], '', 'a command\'s ctx.runAs, refused: nothing ran as root');
  assert.notEqual(elevate.out[2], 0);
  assert.match(elevate.out[1], /EPERM: operation not permitted, uid 1000 may not become uid 0 \(whoami\)/);
  assert.deepEqual(elevate.asked, [[1000, 0, 'whoami']]);

  // The same identity is no change: not asked.
  assert.deepEqual(await run('sudo -u user whoami'), { out: ['user\n', '', 0], asked: [] }, 'sudo to oneself');

  // A raw spawn with a parent and another cred is refused; a parentless one is the host's own choice.
  asked.length = 0;
  const parent = ws.processes.spawn('host', ['host'], '/');
  assert.throws(() => ws.processes.spawn('id', ['id'], '/', { parentPid: parent.pid, cred: CRED_KERNEL }), { code: 'EPERM' });
  assert.deepEqual(asked, [[1000, 0, 'id']]);
  const root = ws.processes.spawn('root', ['root'], '/', { cred: CRED_KERNEL });
  assert.equal(ws.processes.cred(root.pid).uid, 0);
  assert.deepEqual(asked, [[1000, 0, 'id']], 'a parentless spawn is not asked');
  ws.processes.exit(parent.pid, 0);
  ws.processes.exit(root.pid, 0);

  // Allowed: as before, and root's own change is asked too.
  allowed = true;
  assert.deepEqual(await run('sudo whoami'), { out: ['root\n', '', 0], asked: [[1000, 0, 'whoami']] }, 'sudo, allowed');
  assert.deepEqual(await run('sudo sh -c "sudo -u user whoami"'), {
    out: ['user\n', '', 0],
    asked: [[1000, 0, 'sh -c sudo -u user whoami'], [0, 1000, 'whoami']],
  }, 'root becoming the user');
} finally {
  await ws.close();
}

// No policy: allowed, as today.
{
  const plain = await NimbusWorkspace.create({ sql: createSqliteVfsTestHarness().sql, transactions: createSqliteVfsTestHarness().ctx });
  try {
    const result = await plain.exec('sudo whoami');
    assert.deepEqual([result.stdout, result.exitCode], ['root\n', 0]);
  } finally {
    await plain.close();
  }
}

// One choke point, by what each call resolves to (the type checker), not its spelling: a process is
// made only by ProcessTable.spawn, called only from SessionProcessSupervisor.spawn, after it asks the
// policy; the one table is the supervisor's; a process's cred is written only by the table itself.
{
  const ts = createRequire(import.meta.url)('typescript');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const config = ts.getParsedCommandLineOfConfigFile(join(repo, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const TABLE = join(repo, 'packages/core/src/runtime/process-table.ts');
  const SUPERVISOR = join(repo, 'packages/core/src/runtime/session-process-supervisor.ts');
  /** The declaration `node` names, through aliases, as `file:Class.member`. */
  const declared = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return '';
    const owner = declaration.parent && (ts.isClassDeclaration(declaration.parent) || ts.isInterfaceDeclaration(declaration.parent)) ? `${declaration.parent.name?.text}.` : '';
    return `${declaration.getSourceFile().fileName}:${owner}${symbol.name}`;
  };
  /** `node`'s enclosing method or function, as `Class.member`. */
  const enclosing = (node) => {
    for (let at = node.parent; at; at = at.parent) {
      if ((ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at)) && ts.isClassDeclaration(at.parent)) return `${at.parent.name?.text}.${at.name?.getText() ?? 'constructor'}`;
      if (ts.isPropertyDeclaration(at) && ts.isClassDeclaration(at.parent)) return `${at.parent.name?.text}.${at.name.getText()}`;
      if (ts.isFunctionDeclaration(at)) return at.name?.text ?? '';
    }
    return '';
  };
  const spawns = [];
  const tables = [];
  const credWrites = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(repo) || file.fileName.includes('.generated.')) continue;
    const where = (node) => `${relative(repo, file.fileName)} ${enclosing(node)}`;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && declared(node.expression.name) === `${TABLE}:ProcessTable.spawn`) {
        spawns.push(where(node));
      }
      if (ts.isNewExpression(node) && declared(node.expression) === `${TABLE}:ProcessTable`) tables.push(where(node));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
        && declared(node.left.name) === `${TABLE}:ProcessEntry.cred`) credWrites.push(where(node));
      // An entry made whole: a literal whose type is ProcessEntry, giving it a cred.
      if (ts.isObjectLiteralExpression(node) && node.properties.some((property) => property.name?.getText() === 'cred')
        && checker.getContextualType(node)?.getProperty('cred')?.declarations?.some((d) => d.getSourceFile().fileName === TABLE && d.parent.name?.text === 'ProcessEntry')) credWrites.push(where(node));
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const supervisor = relative(repo, SUPERVISOR);
  const table = relative(repo, TABLE);
  assert.deepEqual(spawns, [`${supervisor} SessionProcessSupervisor.spawn`], 'a process is made only in the supervisor\'s spawn');
  assert.deepEqual(tables, [`${supervisor} SessionProcessSupervisor.table`], 'the one process table is the supervisor\'s');
  assert.deepEqual([...new Set(credWrites)].sort(), [`${table} ProcessTable.setUmask`, `${table} ProcessTable.spawn`], 'a process\'s cred is written only as it is made, and by umask');
  const spawn = readFileSync(SUPERVISOR, 'utf8').match(/\n {2}spawn\([^]*?\n {2}\}\n/)?.[0] ?? '';
  assert.ok(spawn.indexOf('this.identityPolicy(') !== -1 && spawn.indexOf('this.identityPolicy(') < spawn.indexOf('table.spawn('), 'which asks the policy first');
}

console.log('identity-change-policy: every identity change asks the host');
