/**
 * The Worker Loader shim's code, kept in the owning session's store (FAB-2,
 * loader-code-store-design-r7.md). A Worker a `wrangler dev` build's
 * worker_loaders binding loads is written here before its handle is
 * returned, so the shim's heap is only a cache of what is durable.
 *
 * The store is one flat directory per owner, `/.nimbus/loader-code/<random
 * name>/<sha256 of a module>`, written by its own credential (uid 998:
 * admitted against the unprivileged ceiling, beyond the session user's
 * reach). An owner is one binding of one build: minted with the build's env
 * (`mint`), committed with it, and at its binding's next commit kept as that
 * binding's reuse source, whose files a later owner adopts by a
 * content-sharing copy instead of being sent them again. Every transition of
 * the registry is synchronous; what waits is only the removal of a directory
 * no record names, once nothing reads or writes it.
 *
 * One registry per filesystem engine, which is per incarnation of the
 * session (a destroy opens a new one): every directory present when it is
 * made belonged to a dead incarnation, and is swept.
 */
import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { CRED_KERNEL, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { ensureKernelStoreRoot, KERNEL_STORE_ROOT } from '../facets/kernel-store-root.js';

export const LOADER_CODE_ROOT = `${KERNEL_STORE_ROOT}/loader-code`;
export const CRED_LOADER_STORE: VfsCred = Object.freeze({ uid: 998, gid: 998, groups: Object.freeze([998]), umask: 0o077 });
const OWNER_FILES = 16_384;
const OWNER_BYTES = 256 * 1024 * 1024;
const STORE_BYTES = 1024 * 1024 * 1024;
/** The most one read answers, and the most digests one `has` asks after. */
export const LOADER_STORE_READ_BYTES = 4 * 1024 * 1024;
const HAS_DIGESTS = 256;
/** How long a put waits for each slice of its bytes before it is abandoned. */
const PUT_SLICE_MS = 60_000;
const DIGEST = /^[0-9a-f]{64}$/;

type OwnerState = 'staged' | 'committed' | 'source' | 'closed';

interface PutsInFlight {
  count: number;
  readonly size: number;
  chargedBytes: number;
}

/** How many files a removal unlinks between turns. */
const REMOVE_PAGE = 256;

interface Owner {
  readonly token: string;
  /** A random name, not its token: the token never touches the disk. Made at its first file. */
  readonly dir: string;
  made: boolean;
  readonly wranglerId: string;
  readonly binding: string;
  state: OwnerState;
  files: number;
  bytes: number;
  /** Creations under way, by digest: a second creation of one joins it. */
  readonly creating: Map<string, Promise<void>>;
  /** Every operation reading or writing its directory: its removal waits for them. */
  readonly inFlight: Set<Promise<unknown>>;
}

export type LoaderStoreRequest =
  | { readonly kind: 'has'; readonly owner: string; readonly digests: readonly string[] }
  | { readonly kind: 'put'; readonly owner: string; readonly digest: string; readonly size: number }
  | { readonly kind: 'read'; readonly owner: string; readonly digest: string; readonly offset: number; readonly length: number }
  | { readonly kind: 'alive'; readonly owner: string };

/** A request the store refuses, by name. */
export class LoaderStoreRefusal extends Error {
  override readonly name = 'LoaderStoreRefusal';
  constructor(message: string, readonly code: 'ENOSPC' | 'EPERM' | 'ENOENT' | 'EINVAL' | 'ETIMEDOUT') {
    super(`Nimbus loader code store: ${message}`);
  }
}

const registries = new WeakMap<SqliteVFS, LoaderCodeRegistry>();

/** The registry of the incarnation whose filesystem is `engine`. */
export function loaderCodeRegistry(engine: SqliteVFS): LoaderCodeRegistry {
  let registry = registries.get(engine);
  if (registry === undefined) {
    registry = new LoaderCodeRegistry(engine);
    registries.set(engine, registry);
  }
  return registry;
}

export class LoaderCodeRegistry {
  private readonly owners = new Map<string, Owner>();
  /** Per (wrangler, binding): its reuse source's token. */
  private readonly sources = new Map<string, string>();
  /** Directories queued for removal (an owner's, or a dead incarnation's), until they are gone. */
  private readonly removing = new Map<string, Owner | null>();
  /**
   * The bytes of content this incarnation's directories hold, each digest
   * counted once however many directories share it. The VFS is the only
   * inventory: a digest is held while any of this incarnation's directories
   * (an owner's, a source's, one queued for removal) has its file, and only
   * puts in flight are kept here, transiently.
   */
  private storeBytes = 0;
  /** Puts in flight, by digest: how many, their one size, and the content's charge they carry (0: a directory carries it). */
  private readonly putting = new Map<string, PutsInFlight>();
  private removals: Promise<void> = Promise.resolve();

  constructor(private readonly engine: SqliteVFS) {
    // A dead incarnation's directories, listed now, before this one makes any: nothing of this one names them.
    let dead: string[] = [];
    try {
      dead = this.storeFs().readdir(LOADER_CODE_ROOT).map(({ name }) => `${LOADER_CODE_ROOT}/${name}`);
    } catch (error) {
      console.warn(`[nimbus/loader-code-store] ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const dir of dead) this.queueRemoval(dir, null);
  }

  /** What the store holds now, for the session's diagnostics. */
  stats(): { owners: number; sources: number; removing: number; storeBytes: number; putting: number } {
    return { owners: this.owners.size, sources: this.sources.size, removing: this.removing.size, storeBytes: this.storeBytes, putting: this.putting.size };
  }

  /** A new owner, staged, for `binding` of the build of wrangler `wranglerId`: its token. */
  mint(wranglerId: string, binding: string): string {
    const token = crypto.randomUUID();
    const dir = `${LOADER_CODE_ROOT}/${crypto.randomUUID().replaceAll('-', '')}`;
    this.owners.set(token, {
      token, dir, made: false, wranglerId, binding, state: 'staged', files: 0, bytes: 0, creating: new Map(), inFlight: new Set(),
    });
    return token;
  }

  /**
   * A build of wrangler `wranglerId` committed with `tokens`, one per binding
   * it has: they are its bindings' owners now. Each binding's previous owner
   * is its reuse source, the source before that is retired, and a binding
   * the build no longer has is retired with its source. Synchronous.
   */
  commit(wranglerId: string, tokens: readonly string[]): void {
    const committing = new Map<string, Owner>();
    for (const token of tokens) {
      const owner = this.owners.get(token);
      if (owner === undefined || owner.state !== 'staged' || owner.wranglerId !== wranglerId) continue;
      // A binding named twice is the last one's, as the env it went into: the earlier owner is retired.
      const earlier = committing.get(owner.binding);
      if (earlier !== undefined) this.retire(earlier.token);
      committing.set(owner.binding, owner);
    }
    for (const previous of [...this.owners.values()]) {
      if (previous.wranglerId !== wranglerId || previous.state !== 'committed') continue;
      const slot = `${wranglerId}\0${previous.binding}`;
      const before = this.sources.get(slot);
      if (before !== undefined) this.retire(before);
      if (committing.has(previous.binding)) {
        previous.state = 'source';
        this.sources.set(slot, previous.token);
      } else {
        this.retire(previous.token);
      }
    }
    for (const owner of committing.values()) owner.state = 'committed';
  }

  /** `token` closed, and its directory queued for removal. Idempotent. Synchronous. */
  release(token: string): void {
    this.retire(token);
  }

  /** Every owner and reuse source of wrangler `wranglerId`, released. Synchronous. */
  stop(wranglerId: string): void {
    for (const owner of [...this.owners.values()]) if (owner.wranglerId === wranglerId) this.retire(owner.token);
  }

  /** Serve a request of the shim; a token this incarnation does not hold open is refused. Every stream it is given is consumed or cancelled. */
  async serve(request: LoaderStoreRequest, stream?: ReadableStream<Uint8Array>): Promise<unknown> {
    let unused = stream;
    try {
      const owner = this.owners.get(String(request.owner));
      const open = owner !== undefined && (owner.state === 'staged' || owner.state === 'committed');
      if (request.kind === 'alive') return open;
      if (!open || owner === undefined) throw new LoaderStoreRefusal('this worker\'s loader binding was retired: its build was replaced or stopped', 'EPERM');
      switch (request.kind) {
        case 'has': return await this.track(owner, this.has(owner, request.digests));
        case 'read': return await this.track(owner, Promise.resolve().then(() => this.read(owner, request.digest, request.offset, request.length)));
        case 'put': {
          const source = unused;
          unused = undefined;
          return await this.track(owner, this.put(owner, request.digest, request.size, source));
        }
      }
    } finally {
      await unused?.cancel().catch(() => {});
    }
  }

  /** Which of `digests` the owner holds, each it lacks but another owner or reuse source of this incarnation has adopted first. */
  private async has(owner: Owner, digests: readonly string[]): Promise<string[]> {
    if (!Array.isArray(digests) || digests.length > HAS_DIGESTS || !digests.every((digest) => DIGEST.test(String(digest)))) {
      throw new LoaderStoreRefusal(`has asks after at most ${HAS_DIGESTS} SHA-256 digests`, 'EINVAL');
    }
    const fs = this.ownerFs(owner);
    const held: string[] = [];
    for (const digest of digests) {
      await owner.creating.get(digest)?.catch(() => {});
      if (this.size(fs, `${owner.dir}/${digest}`) !== null) { held.push(digest); continue; }
      const donor = await this.donor(owner, digest);
      if (donor === null) continue;
      await this.create(owner, digest, donor.size, false, async () => {
        fs.copyFile(`${donor.owner.dir}/${digest}`, `${owner.dir}/${digest}`);
      }, donor.owner);
      held.push(digest);
    }
    return held;
  }

  /** Another live owner's, or a reuse source's, file of `digest`: a put of it in flight there is waited for first (bounded by the put's own deadline). */
  private async donor(owner: Owner, digest: string): Promise<{ owner: Owner; size: number } | null> {
    const fs = this.storeFs();
    for (const candidate of this.owners.values()) {
      if (candidate === owner || !candidate.made || candidate.state === 'closed') continue;
      await candidate.creating.get(digest)?.catch(() => {});
      // Retired while it waited: no record names it any more.
      if (!this.owners.has(candidate.token)) continue;
      const size = this.size(fs, `${candidate.dir}/${digest}`);
      if (size !== null) return { owner: candidate, size };
    }
    return null;
  }

  /** The bytes of module `digest`, `size` long, written from `stream` and published only if they are what `digest` names. */
  private async put(owner: Owner, digest: string, size: number, stream: ReadableStream<Uint8Array> | undefined): Promise<boolean> {
    try {
      if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(size) || size < 0 || stream === undefined) {
        throw new LoaderStoreRefusal('put names a SHA-256 digest, a size and its bytes', 'EINVAL');
      }
      const fs = this.ownerFs(owner);
      await owner.creating.get(digest)?.catch(() => {});
      if (this.size(fs, `${owner.dir}/${digest}`) !== null) return false;
      // A digest names one content, so one size: one held, or being put, of another size refuses this put.
      const known = this.heldSize(digest) ?? this.putting.get(digest)?.size;
      if (known !== undefined && known !== size) throw new LoaderStoreRefusal(`digest ${digest} names ${known} bytes, not ${size}`, 'EINVAL');
      await this.create(owner, digest, size, true, () => fs.writeFileFrom(`${owner.dir}/${digest}`, size, verified(stream, digest), { mode: 0o600 }).then(() => {}));
      return true;
    } finally {
      // Read to its end, or not at all (joined, refused before a byte was read): either way its producer is let go.
      await stream?.cancel().catch(() => {});
    }
  }

  private read(owner: Owner, digest: string, offset: number, length: number): Uint8Array {
    if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > LOADER_STORE_READ_BYTES) {
      throw new LoaderStoreRefusal(`read names a SHA-256 digest and at most ${LOADER_STORE_READ_BYTES} bytes`, 'EINVAL');
    }
    return this.ownerFs(owner).readRangeUncached(`${owner.dir}/${digest}`, offset, length);
  }

  /**
   * One new file of `owner`, admitted against the caps before `make`
   * creates it: a creation of the same digest under way is joined (its
   * stream then unread, cancelled by the caller), and a failed one gives its
   * reservation back. The session's cap counts content once: a put charges
   * its digest when no directory holds it and no put in flight has charged
   * it, and keeps that charge until it settles (a directory holding it then
   * keeps it counted; one that failed with nothing holding it gives it back).
   * An adoption shares its donor's charge. A copy from `from` is in flight
   * on the donor too, so its removal waits for the copy.
   */
  private create(owner: Owner, digest: string, size: number, isPut: boolean, make: () => Promise<void>, from?: Owner): Promise<void> {
    const joined = owner.creating.get(digest);
    if (joined !== undefined) return joined;
    const pending = isPut ? this.putting.get(digest) : undefined;
    const charge = isPut && (pending?.chargedBytes ?? 0) === 0 && this.heldSize(digest) === null ? size : 0;
    if (owner.files + 1 > OWNER_FILES || owner.bytes + size > OWNER_BYTES || this.storeBytes + charge > STORE_BYTES) {
      return Promise.reject(new LoaderStoreRefusal(
        `this owner would hold ${owner.files + 1} files and ${owner.bytes + size} bytes (at most ${OWNER_FILES} and ${OWNER_BYTES}), and the session's loader store ${this.storeBytes + charge} bytes (at most ${STORE_BYTES})`,
        'ENOSPC'));
    }
    owner.files++;
    owner.bytes += size;
    this.storeBytes += charge;
    let put: PutsInFlight | undefined;
    if (isPut) {
      put = pending ?? { count: 0, size, chargedBytes: 0 };
      put.count++;
      put.chargedBytes += charge;
      this.putting.set(digest, put);
    }
    const settle = (): void => {
      if (put === undefined || --put.count > 0) return;
      this.putting.delete(digest);
      // The last put of it settled: a directory holding it carries its charge now; nothing holding it, it is given back.
      if (this.heldSize(digest) === null) this.storeBytes -= put.chargedBytes;
    };
    const creation = Promise.resolve().then(make).then(settle, (error: unknown) => {
      owner.files--;
      owner.bytes -= size;
      settle();
      throw error;
    }).finally(() => owner.creating.delete(digest));
    owner.creating.set(digest, creation);
    this.track(owner, creation).catch(() => {});
    if (from !== undefined) this.track(from, creation).catch(() => {});
    return creation;
  }

  /** The size of `digest`'s file in a directory of this incarnation that counts (a live owner's, a source's, or one queued for removal), or null. */
  private heldSize(digest: string): number | null {
    const fs = this.storeFs();
    const dirs = [...[...this.owners.values()].filter((owner) => owner.made).map((owner) => owner.dir), ...[...this.removing].filter(([, owner]) => owner !== null).map(([dir]) => dir)];
    for (const dir of dirs) {
      const size = this.size(fs, `${dir}/${digest}`);
      if (size !== null) return size;
    }
    return null;
  }

  /** `digest`'s file, `size` bytes, was just removed from a directory that counts: its charge goes with it unless something else carries it. */
  private released(digest: string, size: number): void {
    if (this.heldSize(digest) !== null) return;
    const put = this.putting.get(digest);
    if (put === undefined) this.storeBytes -= size;
    // A put of it in flight with no charge of its own carries this one now; one with its own, this file never had one.
    else if (put.chargedBytes === 0) put.chargedBytes = size;
  }

  /** `operation`, which reads or writes `owner`'s directory: its removal waits for it. */
  private track<T>(owner: Owner, operation: Promise<T>): Promise<T> {
    owner.inFlight.add(operation);
    const done = (): void => { owner.inFlight.delete(operation); };
    operation.then(done, done);
    return operation;
  }

  /** `token` closed, its reuse-source record dropped, its directory queued for removal once nothing reads or writes it. */
  private retire(token: string): void {
    const owner = this.owners.get(token);
    if (owner === undefined) return;
    owner.state = 'closed';
    this.owners.delete(token);
    for (const [slot, source] of this.sources) if (source === token) this.sources.delete(slot);
    if (owner.made) this.queueRemoval(owner.dir, owner);
  }

  /**
   * Remove `dir` once `owner`'s operations (all of them, however many come
   * after this) have drained. A directory that is not gone stays queued and
   * is tried again at each removal; whatever of it was unlinked was given
   * back as it went.
   */
  private queueRemoval(dir: string, owner: Owner | null): void {
    this.removing.set(dir, owner);
    this.removals = this.removals.then(async () => {
      if (owner !== null) while (owner.inFlight.size > 0) await Promise.allSettled([...owner.inFlight]);
      for (const [pending, held] of [...this.removing]) {
        if (held !== null && held.inFlight.size > 0) continue;
        if (await this.removeDir(pending, held !== null)) this.removing.delete(pending);
      }
    }).catch(() => {});
  }

  /**
   * Remove `dir`, a flat directory of at most OWNER_FILES files, whether it
   * is gone. Its names are listed once (the VFS's one listing), and each
   * file is stat'ed, unlinked and, when `counted`, given back the moment it
   * is gone, in pages of REMOVE_PAGE with a turn between; so a removal that
   * fails part way has given back exactly what it unlinked. The directory
   * goes last. An entry that is not a file (none is made here) goes by the
   * VFS's recursive removal.
   */
  private async removeDir(dir: string, counted: boolean): Promise<boolean> {
    const fs = this.storeFs();
    let names: string[];
    try {
      names = fs.readdir(dir).map(({ name }) => name);
    } catch (error) {
      if (isMissing(error)) return true;
      console.warn(`[nimbus/loader-code-store] could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    let left = 0;
    for (let at = 0; at < names.length; at++) {
      if (at > 0 && at % REMOVE_PAGE === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const path = `${dir}/${names[at]}`;
      try {
        const stat = statOrNull(fs, path);
        if (stat === null) continue;
        if (stat.type === 'directory') {
          const removal = fs.removeRecursive(path);
          if (removal.failures.length > 0 || removal.kept.length > 0) left++;
          continue;
        }
        fs.unlink(path);
        if (counted && stat.type === 'file') this.released(names[at], stat.size);
      } catch (error) {
        if (!isMissing(error)) left++;
      }
    }
    if (left > 0) {
      console.warn(`[nimbus/loader-code-store] ${dir}: ${left} entries could not be removed; tried again later`);
      return false;
    }
    try {
      fs.rmdir(dir);
      return true;
    } catch (error) {
      return isMissing(error);
    }
  }

  /** The store's credentialed view: /.nimbus the kernel's (as every kernel store checks it), loader-code the store's own, checked at every use. */
  private storeFs(): CredentialedVfs {
    const kernel = this.engine.as(CRED_KERNEL);
    ensureKernelStoreRoot({
      stat: (path) => statOrNull(kernel, path),
      mkdir: (path, mode) => kernel.mkdir(path, { mode }),
    });
    let root = statOrNull(kernel, LOADER_CODE_ROOT);
    if (root === null) {
      kernel.mkdir(LOADER_CODE_ROOT, { mode: 0o700 });
      kernel.chown(LOADER_CODE_ROOT, CRED_LOADER_STORE.uid, CRED_LOADER_STORE.gid, { followSymlinks: false });
      root = kernel.lstat(LOADER_CODE_ROOT);
    }
    if (root.type !== 'directory' || root.uid !== CRED_LOADER_STORE.uid || (root.mode & 0o077) !== 0) {
      throw new LoaderStoreRefusal(`${LOADER_CODE_ROOT} is not the loader store's own directory (uid ${CRED_LOADER_STORE.uid}, mode 0700)`, 'EPERM');
    }
    return this.engine.as(CRED_LOADER_STORE);
  }

  /** The store's view, with `owner`'s directory made at its first use. */
  private ownerFs(owner: Owner): CredentialedVfs {
    const fs = this.storeFs();
    if (!owner.made) {
      fs.mkdir(owner.dir, { mode: 0o700 });
      owner.made = true;
    }
    return fs;
  }

  private size(fs: CredentialedVfs, path: string): number | null {
    const stat = statOrNull(fs, path);
    return stat?.type === 'file' ? stat.size : null;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function statOrNull(fs: CredentialedVfs, path: string): ReturnType<CredentialedVfs['lstat']> | null {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * `stream`'s bytes, hashed as they pass: one that is not what `digest`
 * names fails its last read, so nothing is published. A slice that does not
 * come within PUT_SLICE_MS ends the put; the stream is cancelled whenever the
 * read ends early.
 */
async function* verified(stream: ReadableStream<Uint8Array>, digest: string): AsyncGenerator<Uint8Array> {
  const hash = sha256Incremental();
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LoaderStoreRefusal(`a put's bytes stopped coming for ${PUT_SLICE_MS / 1000} s`, 'ETIMEDOUT')), PUT_SLICE_MS);
      });
      const next = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
      if (next.done) break;
      await hash.update(next.value);
      yield next.value;
    }
    done = true;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (await hash.hex() !== digest) throw new LoaderStoreRefusal(`the bytes put are not what digest ${digest} names`, 'EINVAL');
}
