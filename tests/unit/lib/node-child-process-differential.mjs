// One program over Node's `child_process` (Kinu ask 67's child_process
// differential), run inside a hosted workspace's node (its facet) and
// through createNodeCompat over the same session: what each answers must be
// the same, value for value.
//   - exec exiting 3: its code and both outputs;
//   - a program killed by SIGTERM: code null, signal 'SIGTERM';
//   - execFile of a missing program: the 'error' event, ENOENT, 'spawn <file>';
//   - spawn('cat') echoing input written after the start: every byte value
//     0x00-0xff, and 1 MiB to a slow reader, in order.

/** The program: `cp` is Node's module. */
export async function childDifferential(cp) {
  const out = {};
  out.exit3 = await new Promise((resolve) => cp.exec('echo out; echo err >&2; exit 3', (error, stdout, stderr) => resolve({
    code: error?.code, killed: error?.killed, signal: error?.signal, cmd: error?.cmd, message: error?.message, stdout, stderr,
  })));
  out.sigterm = await new Promise((resolve) => {
    const child = cp.spawn('sleep', ['600']);
    child.on('spawn', () => child.kill('SIGTERM'));
    child.on('exit', (code, signal) => resolve({ code, signal, killed: child.killed }));
  });
  out.missing = await new Promise((resolve) => {
    const child = cp.execFile('no-such-program-67', ['a']);
    child.on('error', (error) => resolve({ code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, spawnargs: error.spawnargs }));
  });
  const echo = (bytes, slow) => new Promise((resolve, reject) => {
    const child = cp.spawn('cat');
    const parts = [];
    let length = 0;
    child.stdout.on('data', (chunk) => {
      parts.push(chunk);
      length += chunk.length;
      if (slow && length % (64 * 1024) < chunk.length) {
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 2);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const got = Buffer.concat(parts);
      let same = got.length === bytes.length;
      for (let i = 0; same && i < got.length; i++) same = got[i] === bytes[i];
      resolve({ code, length: got.length, same });
    });
    child.on('spawn', () => {
      child.stdin.write(bytes);
      child.stdin.end();
    });
  });
  out.bytes = await echo(Buffer.from(Array.from({ length: 256 }, (_, i) => i)), false);
  out.mebibyte = await echo(Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff)), true);
  return out;
}

/** The program as a script for a node: it prints its answer as JSON. */
export function programSource() {
  return `const cp = require('child_process');\n(${childDifferential.toString()})(cp)\n`
    + `  .then((out) => console.log(JSON.stringify(out)), (error) => { console.error(error); process.exitCode = 1; });\n`;
}
