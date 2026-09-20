import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import {
  requireVfsCred,
  type NimbusFilesystemAuthority,
  type NimbusFilesystemBinding,
  type NimbusHostFilesystemLease,
  type RuntimeFsBridge,
  type VfsCred,
} from './os-contracts.js';
import {
  createSqliteDescriptorScope,
  SqliteRuntimeFsBridge,
  type SqliteDescriptorScope,
} from './sqlite-runtime-fs-bridge.js';

function immutableCredential(cred: Readonly<VfsCred>): VfsCred {
  const valid = requireVfsCred(cred, 'filesystem binding');
  return Object.freeze({ ...valid, groups: Object.freeze([...valid.groups]) });
}

/** The default authority owns descriptor scopes, not the host's database lifetime. */
export class SqliteFilesystemAuthority implements NimbusFilesystemAuthority {
  readonly namespace: string;
  private readonly processes = new Map<number, SqliteDescriptorScope>();
  private readonly retired = new Set<number>();

  constructor(private readonly vfs: SqliteVFS) {
    this.namespace = vfs.namespace;
  }

  bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('filesystem binding requires a process pid');
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    let scope = this.processes.get(pid);
    if (!scope) { scope = createSqliteDescriptorScope(); this.processes.set(pid, scope); }
    return this.view(scope, immutableCredential(cred), signal, pid);
  }

  openHost(cred: Readonly<VfsCred>, options: { signal?: AbortSignal } = {}): NimbusHostFilesystemLease {
    const scope = createSqliteDescriptorScope();
    const fs = this.view(scope, immutableCredential(cred), options.signal);
    return { fs, dispose: async () => this.closeScope(scope) };
  }

  async releaseProcess(pid: number): Promise<void> {
    this.retired.add(pid);
    const scope = this.processes.get(pid);
    if (scope) this.closeScope(scope);
    this.processes.delete(pid);
    this.vfs.revokeAppendWriters(pid);
  }

  async activateAppendWriter(pid: number, writerId: string): Promise<void> {
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    this.vfs.activateAppendWriter(pid, writerId);
  }
  async revokeAppendWriter(pid: number, writerId: string): Promise<void> { this.vfs.revokeAppendWriter(pid, writerId); }
  async revokeAppendWriters(pid: number): Promise<void> { this.vfs.revokeAppendWriters(pid); }
  async revokeAppendWritersThrough(maxPid: number): Promise<void> { this.vfs.revokeAppendWritersThrough(maxPid); }

  private closeScope(scope: SqliteDescriptorScope): void {
    if (scope.closed) return;
    for (const opened of scope.handles.values()) {
      if (--opened.refs === 0) opened.node.close();
    }
    scope.handles.clear();
    scope.closed = true;
  }

  private view(scope: SqliteDescriptorScope, cred: VfsCred, signal?: AbortSignal, pid?: number): RuntimeFsBridge {
    const target = new SqliteRuntimeFsBridge(this.vfs.as(cred), this.vfs, scope);
    const methods = new Map<PropertyKey, unknown>();
    const view = new Proxy(target, {
      get: (object, key) => {
        if (key === 'synchronous') return view;
        const member = Reflect.get(object, key);
        if (typeof member !== 'function') return member;
        if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
          signal?.throwIfAborted();
          if (scope.closed) throw Object.assign(new Error('EBADF: filesystem scope closed'), { code: 'EBADF' });
          if (key === 'appendOnce' && (pid === undefined || args[1] !== pid)) {
            throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
          }
          if (key === 'acknowledgeAppend' && (pid === undefined || args[0] !== pid)) {
            throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
          }
          return Reflect.apply(member, object, args);
        });
        return methods.get(key);
      },
    });
    return view;
  }
}
