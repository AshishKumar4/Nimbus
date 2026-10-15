// busybox.applets: the applet manifest the bash-runner aliases onto the
// busybox module, as `busybox --list` prints it (on stderr, under this
// harness), one name a line. build-in-bwrap.sh writes it after the build.
//
//   node list-applets.mjs <busybox.wasm> > busybox.applets
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';

const listed = join(tmpdir(), `busybox-applets-${process.pid}`);
const stderr = openSync(listed, 'w');
const wasi = new WASI({ version: 'preview1', args: ['busybox', '--list'], stderr, returnOnExit: true });
const mod = await WebAssembly.compile(await readFile(process.argv[2]));
let instance;
instance = await WebAssembly.instantiate(mod, { ...wasi.getImportObject(), nimbus_proc: {
  startup_cwd(ptr, capacity) { if (capacity) new Uint8Array(instance.exports.memory.buffer).set([47, 0], ptr); return 1; },
  identity: (field) => field === 2 ? 1 : 0,
  stat_metadata: () => 52,
  chmod: () => 63, fchmod: () => 63, chown: () => 63,
} });
wasi.start(instance);
closeSync(stderr);
process.stdout.write(readFileSync(listed, 'utf8'));
rmSync(listed);
