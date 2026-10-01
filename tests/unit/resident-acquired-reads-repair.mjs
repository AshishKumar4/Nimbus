#!/usr/bin/env bun
// An async read whose barrier comes back with it must not fill the sync view
// when something else moved the cursor further in the meantime.
//
// The read below is begun while a repair (a dropped ACQUIRE's reconciliation)
// is in flight. Its barrier and its bytes are answered before a peer writes
// the file; the repair then lands after that write and moves the cursor past
// it without reporting the file, which no store row holds. Dated at its
// barrier's answer, the read installed the old bytes behind a cursor already
// past the change, and the sync view served them for good (review finding,
// ColouredPanda's reproduction). The file is never read synchronously before
// the race, so no store row makes the repair report it.

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
let holdList = false;
let holdRead = false;
const listHeld = Promise.withResolvers();
const listGate = Promise.withResolvers();
const readHeld = Promise.withResolvers();
const readGate = Promise.withResolvers();
const handle = facetSupervisor(authority, {
  fsAcquire: (...args) => (drop ? Promise.reject(new Error('Network connection lost.')) : forward('fsAcquire', args)),
  fsList: async (...args) => {
    if (holdList) {
      holdList = false;
      listHeld.resolve();
      await listGate.promise;
    }
    return forward('fsList', args);
  },
  fsAcquired: async (...args) => {
    const answer = await forward('fsAcquired', args);
    if (holdRead && args[1] === 'fsReadBatch') {
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

// A dropped ACQUIRE starts a repair, whose listing is held.
drop = true;
holdList = true;
const repair = probe.resume('/home/user/app/f.txt');
await listHeld.promise;
// The read's barrier and bytes are answered (old), and held on the way back.
holdRead = true;
const reading = probe.fs.promises.readFile('/opt/unplanned.txt', 'utf8');
await readHeld.promise;
// A peer writes; the repair lands after it, past it.
authority.kfs.writeFile('opt/unplanned.txt', 'NEW');
drop = false;
listGate.resolve();
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
