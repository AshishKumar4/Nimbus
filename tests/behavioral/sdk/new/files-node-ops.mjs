#!/usr/bin/env bun
// sdk/files-node-ops — a session's files answer as Node's fs needs them over
// the remote API (Kinu ask 67.2): stat(2)'s whole stat, mkdir(2)'s options,
// unlink and rmdir apart, appendFile, symlink, realpath, truncate and
// utimes; a failed call keeps Node's code, errno, syscall and path, and its
// status says what failed (404 for ENOENT), not a server error.
import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('sdk/files-node-ops');
const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');
const box = Nimbus.connect({ endpoint: BASE, ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}) }).sandbox(`files-node-ops-${Date.now()}`);

async function failure(promise) {
  try { await promise; } catch (error) { return error; }
  return null;
}
const fields = (error) => JSON.stringify(error && { code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, status: error.status });

try {
  const dir = '/home/user/node-ops';
  await box.files.mkdir(dir);
  await box.files.write(`${dir}/a.txt`, 'abc');
  const stat = await box.files.stat(`${dir}/a.txt`);
  a.check('stat is stat(2)\'s', ['dev', 'ino', 'nlink', 'uid', 'gid', 'mode', 'size', 'atime', 'mtime', 'ctime'].every((f) => typeof stat?.[f] === 'number') && stat.uid === 1000, JSON.stringify(stat));

  let error = await failure(box.files.mkdir(`${dir}/x/y`, { recursive: false }));
  a.check('mkdir(2): ENOENT with Node\'s fields, status 404', error?.code === 'ENOENT' && error.errno === -2 && error.syscall === 'mkdir' && error.path === `${dir}/x/y` && error.status === 404, fields(error));

  await box.files.mkdir(`${dir}/d`, {});
  error = await failure(box.files.unlink(`${dir}/d`));
  a.check('unlink of a directory: EISDIR', error?.code === 'EISDIR' && error.syscall === 'unlink', fields(error));
  error = await failure(box.files.rmdir(`${dir}/a.txt`));
  a.check('rmdir of a file: ENOTDIR', error?.code === 'ENOTDIR', fields(error));
  await box.files.rmdir(`${dir}/d`);

  await box.files.appendFile(`${dir}/log`, 'one\n');
  await box.files.appendFile(`${dir}/log`, 'two\n');
  a.check('appendFile', await box.files.read(`${dir}/log`) === 'one\ntwo\n', '');

  await box.files.symlink('a.txt', `${dir}/link`);
  const real = await box.files.realpath(`${dir}/link`);
  a.check('symlink and realpath', real === `${dir}/a.txt`, real);

  await box.files.truncate(`${dir}/a.txt`, 1);
  a.check('truncate', await box.files.read(`${dir}/a.txt`) === 'a', '');

  await box.files.utimes(`${dir}/a.txt`, 1_000_000_000_000, 1_200_000_000_000);
  const touched = await box.files.stat(`${dir}/a.txt`);
  a.check('utimes, in milliseconds', touched.atime === 1_000_000_000_000 && touched.mtime === 1_200_000_000_000, JSON.stringify(touched));

  error = await failure(box.files.chown(`${dir}/a.txt`, 0, null));
  a.check('chown away from the session user: EPERM, 403', error?.code === 'EPERM' && error.status === 403, fields(error));
} finally {
  await box.destroy({ reason: 'files-node-ops-complete' }).catch(() => {});
}
const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
