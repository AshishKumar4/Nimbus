// W7 regression/rpc-contracts-additive
//
// Confirm that the W7 RPC contract changes are PURELY ADDITIVE:
//   - SupervisorRPC.writeBatch must still exist (legacy callers).
//   - SupervisorRPC.writeBatchStream must exist (new caller).
//   - NimbusSession._rpcWriteBatch must still exist.
//   - NimbusSession._rpcWriteBatchStream must exist.
//   - SqliteVFS.writeBatch must still exist.
//   - SqliteVFS.writeStream must exist.
//
// We use grep against the source files (no module load — keeps the
// regression decoupled from runtime issues).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, includes, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

await group('SupervisorRPC has both writeBatch and writeBatchStream', () => {
  const txt = read('src/supervisor-rpc.ts');
  includes('writeBatch present', txt, 'async writeBatch(');
  includes('writeBatchStream present', txt, 'writeBatchStream');
});

await group('NimbusSession has both _rpcWriteBatch and _rpcWriteBatchStream', () => {
  const txt = read('src/nimbus-session.ts');
  includes('_rpcWriteBatch present', txt, '_rpcWriteBatch(');
  includes('_rpcWriteBatchStream present', txt, '_rpcWriteBatchStream');
});

await group('SqliteVFS has both writeBatch and writeStream', () => {
  const txt = read('src/sqlite-vfs.ts');
  includes('writeBatch present', txt, 'writeBatch(');
  includes('writeStream present', txt, 'writeStream');
});

await group('w7-frame module exists at expected path', () => {
  ok('src/_shared/w7-frame.ts exists',
    fs.existsSync(path.join(ROOT, 'src/_shared/w7-frame.ts')));
});

summary('rpc-contracts-additive [W7 regression]');
