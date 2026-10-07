// @serial
// @tier slow — drives a local workerd
// A program that reads a module file through fs gets the file's bytes, as
// Node's fs does, even when the launch staged that file as a module cell
// and lowered it to CommonJS: the module map's code is the launch's, the
// file is the program's. A read-modify-write of an installed ES module
// (patching node_modules) used to write the lowered CommonJS back, which
// the next launch then ran as a CommonJS cell ("Identifier '__dirname' has
// already been declared" for vite 8's node.js chunk).
import assert from 'node:assert/strict';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const MODULE = [
  "import { join } from 'node:path';",
  "const __dirname = join('/a', 'b');",
  'export const where = __dirname;',
  '',
].join('\n');
const READER = [
  "const fs = require('fs');",
  "const file = '/home/user/lowered/m.mjs';",
  // A static import of it too, so the launch stages it as a module cell.
  "require('./m.mjs');",
  "process.stdout.write(JSON.stringify(fs.readFileSync(file, 'utf8')));",
  '',
].join('\n');

const probe = await startLocalProbe();
try {
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal, stripAnsi } = await import('../behavioral/_driver.mjs');
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  try {
    const b64 = (s) => Buffer.from(s).toString('base64');
    await t.run('mkdir -p /home/user/lowered', 15_000);
    await t.run(`printf '%s' '${b64(MODULE)}' | base64 -d > /home/user/lowered/m.mjs`, 15_000);
    await t.run(`printf '%s' '${b64(READER)}' | base64 -d > /home/user/lowered/read.cjs`, 15_000);
    const run = await t.run('cd /home/user/lowered && node read.cjs; echo; echo "STATUS=$?"', 120_000);
    const text = stripAnsi(run.output).replace(/\r/g, '');
    const line = text.split('\n').find((l) => l.startsWith('"'));
    assert.ok(line, `the program printed the file: ${text.slice(-600)}`);
    assert.equal(JSON.parse(line), MODULE, 'fs.readFileSync of a module cell is the file, not its lowered code');
    // And a program that writes back what it read leaves a module the next launch runs.
    await t.run(`cd /home/user/lowered && node -e "const fs=require('fs'); fs.writeFileSync('m.mjs', fs.readFileSync('m.mjs','utf8') + '// patched\\n')"`, 120_000);
    const after = await t.run(`cd /home/user/lowered && node --input-type=module -e "import { where } from './m.mjs'; console.log('WHERE=' + where)"`, 120_000);
    assert.match(stripAnsi(after.output), /WHERE=\/a\/b/, stripAnsi(after.output).slice(-600));
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('module-file-reads-source-workerd: a module cell reads back as its file');
