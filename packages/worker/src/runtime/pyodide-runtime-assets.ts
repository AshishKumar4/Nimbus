import pyodideWorkerdAdapter from '../../runtime-contracts/pyodide-workerd-adapter.json';
import type { RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

interface PyodideAdapterContract {
  id: string;
  pyodideVersion: string;
  artifactPath: string;
  sentinel: string;
}

const WORKERD_ADAPTER = pyodideWorkerdAdapter as PyodideAdapterContract;

export interface PyodideRuntimeAssetPaths {
  asmWasmVfs: string | null;
  asmJsVfs: string | null;
  stdlibVfs: string | null;
  lockfileVfs: string | null;
  manifest: RuntimeManifest;
  vfs: SqliteVFS;
}

export interface PyodideRuntimeFiles {
  asmWasmBytes: Uint8Array;
  asmJsSrc: string;
  stdlibB64: string;
  lockfileText: string;
}

export function readPyodideRuntimeFiles(args: PyodideRuntimeAssetPaths): PyodideRuntimeFiles {
  if (!args.asmWasmVfs || !args.asmJsVfs || !args.stdlibVfs) {
    throw new Error('installed Pyodide manifest is missing required files');
  }

  const asmWasmBytes = args.vfs.readFile(args.asmWasmVfs);
  const asmJsSrc = new TextDecoder('utf-8').decode(args.vfs.readFile(args.asmJsVfs));
  const stdlibBytes = args.vfs.readFile(args.stdlibVfs);
  const lockfileText = args.lockfileVfs && args.vfs.exists(args.lockfileVfs)
    ? new TextDecoder('utf-8').decode(args.vfs.readFile(args.lockfileVfs))
    : '{"packages":{}}';

  assertPyodideWorkerdAdapter(args.manifest, asmJsSrc);

  return {
    asmWasmBytes,
    asmJsSrc,
    stdlibB64: uint8ToBase64(stdlibBytes),
    lockfileText,
  };
}

function assertPyodideWorkerdAdapter(manifest: RuntimeManifest, asmJsSrc: string): void {
  const metadata = (manifest.runtime_artifacts || []).find(
    (entry) => entry.path === WORKERD_ADAPTER.artifactPath && entry.kind === 'workerd-adapter',
  );
  if (!metadata) {
    throw new Error(
      `pyodide.asm.js is missing Nimbus workerd adapter metadata (${WORKERD_ADAPTER.id}); ` +
      `sync the python runtime and reinstall it with 'nimbus install python --reinstall'`,
    );
  }
  if (metadata.id !== WORKERD_ADAPTER.id) {
    throw new Error(
      `pyodide.asm.js adapter mismatch: installed ${metadata.id}, expected ${WORKERD_ADAPTER.id}`,
    );
  }
  if (manifest.version !== WORKERD_ADAPTER.pyodideVersion) {
    throw new Error(
      `Pyodide version mismatch: installed ${manifest.version}, expected ${WORKERD_ADAPTER.pyodideVersion}`,
    );
  }
  if (!asmJsSrc.startsWith(WORKERD_ADAPTER.sentinel)) {
    throw new Error(
      `pyodide.asm.js does not contain the Nimbus workerd adapter sentinel (${WORKERD_ADAPTER.id})`,
    );
  }
}

export function uint8ToBase64(u8: Uint8Array): string {
  const chunk = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, Math.min(i + chunk, u8.length))),
    );
  }
  return btoa(s);
}
