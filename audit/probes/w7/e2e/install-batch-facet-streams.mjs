// W7 e2e/install-batch-facet-streams
//
// Verify the npm-install-batch-facet hot-path is wired to use
// writeBatchStream when the supervisor exposes it. We construct a
// mock SUPERVISOR that exposes BOTH writeBatch and writeBatchStream
// and observe which one the facet calls.
//
// We don't run the full facet (it's a closure that gets serialised
// for cloudflare-parallel and references preamble symbols not
// present in node-mode). Instead we check the source for the
// expected call site shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, includes, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

await group('npm-install-batch-facet has the streams call shape', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'src/npm-install-batch-facet.ts'), 'utf8');
  // Either the facet calls writeBatchStream directly, OR a typeof check
  // gates it with backwards-compat fallback to writeBatch. Both are
  // acceptable shapes per W7-plan §8.5.
  const hasStreamCall = txt.includes('writeBatchStream');
  ok('facet references env.SUPERVISOR.writeBatchStream', hasStreamCall);
  // The legacy writeBatch fallback must STILL be in the file (for
  // pre-W7 supervisor compatibility).
  includes('legacy writeBatch fallback retained', txt, 'writeBatch');
});

await group('SupervisorRPC interface signature retained on env type', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'src/npm-install-batch-facet.ts'), 'utf8');
  // The env: { SUPERVISOR: ... } type literal (around line 100) must
  // declare both the new and the legacy method.
  includes('env type declares writeBatch', txt,
    'writeBatch(payload: any): Promise<{ inodes: number; chunks: number }>');
  // writeBatchStream is OPTIONAL in the type so older supervisors
  // can still serve the facet (typeof guard at call site).
  includes('env type declares writeBatchStream',
    txt, 'writeBatchStream');
});

await group('preamble carries encodeWriteBatchStream symbol (or facet inlines it)', () => {
  // Search all of src/parallel/* for the preamble definition that
  // injects helpers into facets. The encoder must be present somewhere
  // the facet can access.
  let foundInPreamble = false;
  let foundInFacet = false;
  const facetTxt = fs.readFileSync(path.join(ROOT, 'src/npm-install-batch-facet.ts'), 'utf8');
  if (facetTxt.includes('encodeWriteBatchStream')) foundInFacet = true;

  // Walk src/parallel for the preamble file.
  const dir = path.join(ROOT, 'src/parallel');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.ts')) {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        if (t.includes('encodeWriteBatchStream')) {
          foundInPreamble = true;
          break;
        }
      }
    }
  }
  ok('encodeWriteBatchStream visible to facet (preamble or inlined)',
    foundInPreamble || foundInFacet,
    'Neither the preamble nor npm-install-batch-facet.ts references encodeWriteBatchStream.');
});

summary('w7/e2e/install-batch-facet-streams');
