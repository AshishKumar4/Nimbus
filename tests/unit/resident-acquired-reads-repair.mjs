#!/usr/bin/env bun
// An async read whose bytes the session answered before a peer's write must not
// fill the sync view once something else has moved the cursor past that write.
//
// The read below is answered by the session before a peer writes the file: its
// barrier is answered and its bytes are held on their way back. A barrier whose
// ACQUIRE is dropped then repairs from the store's floor, and the repair lands
// after the write, moving the cursor past it without the read's bytes. Dated at
// its barrier's answer, the read installed the old bytes behind a cursor already
// past the change, and the sync view served them for good (review finding,
// ColouredPanda's reproduction). The file is never read synchronously before
// the race, so no store row holds it.

import { createAuthority, facetSupervisor, launchResident, residentDataPlan } from './lib/resident-body.mjs';

// The process the facet runs replaces console and process.exit in this realm.
const report = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);

const OPT = 'opt/unplanned.txt';
const authority = createAuthority();
authority.kfs.mkdir('home/user/app', { recursive: true });
authority.kfs.writeFile('home/user/app/f.txt', 'f1');
authority.kfs.writeFile(OPT, 'old');

let forward;
let dropNext = false;
let holdRead = false;
const readHeld = Promise.withResolvers();
const readGate = Promise.withResolvers();
// Every barrier here asks: the session grants no read lease (the race is what this is about).
const asked = ([position, options]) => {
  if (options?.lease !== true) return options === undefined ? [position] : [position, options];
  const { lease: _lease, ...rest } = options;
  return [position, rest];
};
const handle = facetSupervisor(authority, {
  fsAcquire: (...args) => {
    if (dropNext) {
      dropNext = false;
      return Promise.reject(new Error('Network connection lost.'));
    }
    return forward('fsAcquire', asked(args));
  },
  fsReadBatch: async (...args) => {
    const answer = await forward('fsReadBatch', args);
    if (holdRead && args[0].some((request) => request.path.replace(/^\/+/, '') === OPT && request.lstat !== true)) {
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
const reading = probe.fs.promises.readFile(`/${OPT}`, 'utf8');
await readHeld.promise;
// A peer writes; a barrier whose ACQUIRE is dropped repairs from the floor, and the repair lands after it.
authority.kfs.writeFile(OPT, 'NEW');
dropNext = true;
await probe.resume('/home/user/app/f.txt');
readGate.resolve();

const served = await reading;
if (served !== 'old') { report(`resident-acquired-reads-repair: FAIL — the async read returned ${served}, not what it was served\n`); exit(1); }
const sync = probe.read(`/${OPT}`);
if (sync === 'old') {
  report(`resident-acquired-reads-repair: FAIL — the sync view kept bytes older than its cursor (read ${sync})\n`);
  exit(1);
}
report('resident-acquired-reads-repair: a read raced by a repair fills nothing it cannot date\n');
exit(0);
