// One program over Node's `fs` (Kinu ask 67's differential), run inside a
// hosted workspace's node (its facet), inside lifo's node, and through
// createNodeCompat over the same session; what each answers must be the
// same, value for value. It reads `fixture/` (fixtureFiles, made before it
// runs) and makes its own `<label>/`; every path it reports has its label
// taken out.

/** The fixture each run reads, by path under the run's cwd. */
export const fixtureFiles = {
  'fixture/hello.txt': 'hello, differential\n',
  'fixture/stat-me': 'never read, so its access time is the fixture\'s',
  'fixture/sub/inner.txt': 'inner',
};
/** fixture/link, to hello.txt. */
export const fixtureLink = { target: 'hello.txt', path: 'fixture/link' };

/**
 * The program: `fs` is Node's module, `label` names this run's own
 * directory. Its source is also run as a script (programSource).
 */
export async function differential(fs, label) {
  const p = fs.promises;
  const unlabel = (text) => (typeof text === 'string' ? text.split(label).join('<label>') : text);
  const caught = async (work) => {
    try {
      await work;
      return null;
    } catch (error) {
      return { code: error.code, errno: error.errno, syscall: error.syscall, path: unlabel(error.path) };
    }
  };
  const statOf = (stat) => ({
    dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, uid: stat.uid, gid: stat.gid, rdev: stat.rdev,
    size: stat.size, blksize: stat.blksize, blocks: stat.blocks,
    atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs,
    atime: stat.atime.toISOString(), mtime: stat.mtime.toISOString(), ctime: stat.ctime.toISOString(), birthtime: stat.birthtime.toISOString(),
    isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(),
  });
  const out = {};
  out.read = await p.readFile('fixture/hello.txt', 'utf8');
  out.readBytes = [...await p.readFile('fixture/hello.txt')].length;
  out.readByCallback = await new Promise((resolve, reject) => fs.readFile('fixture/hello.txt', 'utf8', (error, text) => (error ? reject(error) : resolve(text))));
  out.missing = await caught(p.readFile('fixture/missing.txt'));
  out.missingStat = await caught(p.stat('fixture/missing.txt'));
  out.stat = statOf(await p.stat('fixture/stat-me'));
  out.lstatLink = statOf(await p.lstat('fixture/link')).isSymbolicLink;
  out.statDir = statOf(await p.stat('fixture/sub')).isDirectory;
  out.dir = (await p.readdir('fixture', { withFileTypes: true }))
    .map((entry) => [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink()])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await p.mkdir(`${label}/a/b/c`, { recursive: true });
  await p.writeFile(`${label}/a/b/c/f.txt`, 'moved');
  await p.rename(`${label}/a/b/c/f.txt`, `${label}/a/g.txt`);
  out.afterRename = (await p.readdir(`${label}/a`)).sort();
  out.moved = await p.readFile(`${label}/a/g.txt`, 'utf8');
  out.unlinkDirectory = await caught(p.unlink(`${label}/a/b`));
  out.mkdirExisting = await caught(p.mkdir(`${label}/a`));
  return out;
}

/** The program as a script for a node: it prints its answer as JSON. */
export function programSource(label) {
  return `const fs = require('fs');\n(${differential.toString()})(fs, ${JSON.stringify(label)})\n`
    + `  .then((out) => console.log(JSON.stringify(out)), (error) => { console.error(error); process.exitCode = 1; });\n`;
}
