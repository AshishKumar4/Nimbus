#!/usr/bin/env bun
// An async read whose barrier comes back with it must not fill the sync view
// when something else moved the cursor further in the meantime.
//
// The read below is answered before the race: its barrier and its bytes are
// answered (old), and held on their way back. Then a dropped ACQUIRE starts a
// repair (a delta from the store's floor), and the repair's ACQUIRE is held in
// flight while a peer writes the file. The repair lands after that write and
// moves the cursor past it without the read's bytes. Dated at its barrier's
// answer, the read installed the old bytes behind a cursor already past the
// change, and the sync view served them for good (review finding,
// ColouredPanda's reproduction). The file is never read synchronously before
// the race, so no store row makes the repair report it. The read goes first
// because a barrier begun while a repair is in flight joins that repair and
// waits for it.

import { createAuthority, facetSupervisor, launchResident, residentDataPlan } from './lib/resident-body.mjs';

// The process the facet runs replaces console and process.exit in this realm.
const report = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);

const authority = createAuthority();
authority.kfs.mkdir('home/user/app', { recursive: true });
authority.kfs.writeFile('home/user/app/f.txt', 'f1');
authority.kfs.writeFile('opt/unplanned.txt', 'old');

let forward;
let drop = false;
let holdRepair = false;
let holdRead = false;
const repairHeld = Promise.withResolvers();
const repairGate = Promise.withResolvers();
const readHeld = Promise.withResolvers();
const readGate = Promise.withResolvers();
// Every barrier here asks: the session grants no read lease (the repair's race is what this is about).
const asked = ([position, options]) => {
  if (options?.lease !== true) return options === undefined ? [position] : [position, options];
  const { lease: _lease, ...rest } = options;
  return [position, rest];
};
const handle = facetSupervisor(authority, {
  fsAcquire: (...args) => {
    if (drop) {
      drop = false;
      holdRepair = true;
      return Promise.reject(new Error('Network connection lost.'));
    }
    if (holdRepair) {
      holdRepair = false;
      repairHeld.resolve();
      return repairGate.promise.then(() => forward('fsAcquire', asked(args)));
    }
    return forward('fsAcquire', asked(args));
  },
  fsReadBatch: async (...args) => {
    const answer = await forward('fsReadBatch', args);
    if (holdRead && args[0].some((request) => request.lstat !== true && request.path.replace(/^\/+/, '') === 'opt/unplanned.txt')) {
      holdRead = false;
      readHeld.resolve();
      await readGate.promise;
    }
    return answer;
  },
});
forward = handle.forward;

await launchResident({
  authority,
  program: `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = { fs, read, resume: (p) => new Promise((resolve) => setTimeout(() => resolve(read(p)), 0)) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`,
  env: { SUPERVISOR: handle.supervisor },
  cwd: '/srv/elsewhere',
  dataPlan: await residentDataPlan(authority, '/home/user/app'),
  cursor: authority.cursor(),
});
const probe = globalThis.__probe;

// The read's barrier and bytes are answered (old), and held on the way back.
holdRead = true;
const reading = probe.fs.promises.readFile('/opt/unplanned.txt', 'utf8');
await readHeld.promise;
// A dropped ACQUIRE starts a repair, whose delta is held in flight.
drop = true;
const repair = probe.resume('/home/user/app/f.txt');
await repairHeld.promise;
// A peer writes; the repair lands after it, past it.
authority.kfs.writeFile('opt/unplanned.txt', 'NEW');
repairGate.resolve();
await repair;
readGate.resolve();

const served = await reading;
if (served !== 'old') { report(`resident-acquired-reads-repair: FAIL — the async read returned ${served}, not what it was served\n`); exit(1); }
const sync = probe.read('/opt/unplanned.txt');
if (sync === 'old') {
  report(`resident-acquired-reads-repair: FAIL — the sync view kept bytes older than its cursor (read ${sync})\n`);
  exit(1);
}
report('resident-acquired-reads-repair: a read raced by a repair fills nothing it cannot date\n');
exit(0);
