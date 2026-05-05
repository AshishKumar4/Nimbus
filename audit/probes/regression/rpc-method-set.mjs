#!/usr/bin/env bun
// audit/probes/regression/rpc-method-set.mjs
//
// Static-analysis probe — does NOT need wrangler.
//
// Asserts: NimbusSession class has every method in EXPECTED_METHODS as a
// method declaration. Methods must remain by NAME because the DO RPC
// fabric calls them by name from the stub.
//
// Implementation: scans the slice of nimbus-session.ts (or
// nimbus-session*.ts after refactor) between the line declaring
// `class NimbusSession` and the next top-level `export class` declaration.
// We look for `<name>(` after a method-modifier keyword or at the start of
// a line of indented code. This is line-oriented (no AST), robust against
// strings/templates because we only match start-of-line indented patterns.
//
// Exit 0 = all expected methods present. Exit 1 = missing methods.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'nimbus-session.ts');

const EXPECTED_METHODS = [
  // DO contract
  'fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError',
  // Supervisor RPC
  '_rpcReadFile', '_rpcReadFileBytes', '_rpcInnerDoFetch',
  '_rpcWriteFile', '_rpcStat', '_rpcReaddir', '_rpcExists', '_rpcMkdir',
  '_rpcHmrRelay', '_rpcUnlink', '_rpcWriteBatch', '_rpcWriteBatchStream',
  '_rpcPutRegistryEntries', '_rpcGetEsbuildWasm',
  '_rpcStdout', '_rpcStderr', '_rpcReportExit',
  '_rpcPrefetch', '_rpcRegisterPort', '_rpcUnregisterPort', '_rpcTransform',
  // W8 child_process RPC
  '_rpcCpSpawn', '_rpcCpStdinWrite', '_rpcCpStdinEnd', '_rpcCpReadOutput',
  '_rpcCpDrainOutput', '_rpcCpKill', '_rpcCpWait',
  // Legacy VFS
  'vfsReadFile', 'vfsReadFileString', 'vfsStat', 'vfsExists', 'vfsReaddir', 'vfsWriteFile',
  // W3 emitters / external-exit
  '_emitExitDump', '_emitShellExecDone', '_reportExternalExit',
  // Lazy ensure
  'ensureSqliteFs', 'ensureFacetManager', '_ensureFacetProcessManager',
  'ensureFetchProxy', 'buildFetchFn', 'ensureNpmInstaller', '_ensureLogJanitor',
  // W9 hibernation
  '_w9WireProcessLogPersist', '_w9EnsureSchema', '_w9ScheduleFlush',
  '_w9MaybeBumpIsolateGen', '_w9FlushOnClose',
  // W5 ring persist
  '_w5RehydrateRingFromStorage', '_w5PersistRing', '_w5SafePersistRing',
  // Heap probe
  '_diagReadNodeMem', '_diagReadPerfMem', '_diagSampleMemory',
  // W12
  'getReplicaState',
  // Hydration / seeding / boot
  'hydrateSessionBasePath', 'seedFilesystem', 'initSession',
  // W8 registry handle
  '_setCpRegistry',
  // Env flag
  '_envFlagDefaultOn',
];

function findClassRange(src, className) {
  const lines = src.split('\n');
  let startLine = -1;
  let endLine = -1;
  const startPat = new RegExp(`^export class ${className} extends `);
  for (let i = 0; i < lines.length; i++) {
    if (startPat.test(lines[i])) { startLine = i; break; }
  }
  if (startLine < 0) throw new Error(`class ${className} not found`);
  // Walk forward; class ends at line that's exactly `}` at indent 0.
  for (let i = startLine + 1; i < lines.length; i++) {
    if (/^\}\s*$/.test(lines[i])) { endLine = i; break; }
    // Also stop on next top-level export class (just in case)
    if (/^export (class|function|const|let|var|interface|type)\b/.test(lines[i])) {
      // But ONLY if we haven't seen a closing brace yet — bail out
      // since a properly-formed class would have hit `}` first.
      endLine = i - 1;
      break;
    }
  }
  if (endLine < 0) endLine = lines.length - 1;
  return { startLine, endLine, body: lines.slice(startLine, endLine + 1).join('\n') };
}

const src = fs.readFileSync(SRC, 'utf8');
const { startLine, endLine, body } = findClassRange(src, 'NimbusSession');
console.log(`[rpc-method-set] class NimbusSession spans lines ${startLine + 1}-${endLine + 1}`);

const missing = [];
const present = [];
for (const m of EXPECTED_METHODS) {
  // Match method declarations: line starts with whitespace, optional
  // modifiers, then NAME `(`. Also accepts get/set accessors but we
  // don't expect any in EXPECTED_METHODS.
  const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The regex: ^<spaces><optional modifiers><name>(
  // Modifiers: private/public/protected/readonly/static/async/get/set
  // (in any order, separated by whitespace).
  const pat = new RegExp(
    `^\\s+(?:(?:private|public|protected|readonly|static|async|get|set)\\s+)*${escaped}\\s*\\(`,
    'm',
  );
  if (pat.test(body)) present.push(m);
  else missing.push(m);
}

console.log(`[rpc-method-set] checked ${EXPECTED_METHODS.length} expected methods`);
console.log(`[rpc-method-set] present: ${present.length}`);
console.log(`[rpc-method-set] missing: ${missing.length}`);

if (missing.length > 0) {
  console.error(`[rpc-method-set] FAIL — missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('[rpc-method-set] PASS');
process.exit(0);
