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
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ensureKernelStoreRoot, KERNEL_STORE_ROOT } from '../facets/kernel-store-root.js';
export const LOADER_CODE_ROOT = `${KERNEL_STORE_ROOT}/loader-code`;
export const CRED_LOADER_STORE = Object.freeze({ uid: 998, gid: 998, groups: Object.freeze([998]), umask: 0o077 });
/**
 * The store's caps: per owner (one binding of one build), and per session
 * incarnation. Each owner's files count as its own, a copy it adopted from
 * another owner included: the incarnation's cap is a logical one, which may
 * refuse before the bytes it counts are all stored (loader-code-store-design-r7,
 * amendment 1).
 */
const OWNER_FILES = 16_384;
const OWNER_BYTES = 256 * 1024 * 1024;
const STORE_BYTES = 1024 * 1024 * 1024;
/** The most one read answers, and the most digests one `has` asks after. */
export const LOADER_STORE_READ_BYTES = 4 * 1024 * 1024;
const HAS_DIGESTS = 256;
/** How long a put waits for each slice of its bytes before it is abandoned. */
const PUT_SLICE_MS = 60_000;
const DIGEST = /^[0-9a-f]{64}$/;
/** A request the store refuses, by name. */
export class LoaderStoreRefusal extends Error {
    code;
    name = 'LoaderStoreRefusal';
    constructor(message, code) {
        super(`Nimbus loader code store: ${message}`);
        this.code = code;
    }
}
const registries = new WeakMap();
/** The registry of the incarnation whose filesystem is `engine`. */
export function loaderCodeRegistry(engine) {
    let registry = registries.get(engine);
    if (registry === undefined) {
        registry = new LoaderCodeRegistry(engine);
        registries.set(engine, registry);
    }
    return registry;
}
export class LoaderCodeRegistry {
    engine;
    owners = new Map();
    /** Per (wrangler, binding): its reuse source's token. */
    sources = new Map();
    /** Directories queued for removal (an owner's, or a dead incarnation's), until they are gone. */
    removing = new Map();
    /**
     * The bytes this incarnation's owners hold, each owner's files counted as
     * its own (an adopted copy too, as r7's cap counts every file a put or an
     * adoption makes): a creation adds its size at admission and a failed one
     * takes it back; an owner's whole count goes once its directory is gone.
     */
    storeBytes = 0;
    removals = Promise.resolve();
    constructor(engine) {
        this.engine = engine;
        // A dead incarnation's directories, listed now, before this one makes any: nothing of this one names them.
        let dead = [];
        try {
            dead = this.storeFs().readdir(LOADER_CODE_ROOT).map(({ name }) => `${LOADER_CODE_ROOT}/${name}`);
        }
        catch (error) {
            console.warn(`[nimbus/loader-code-store] ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const dir of dead)
            this.queueRemoval(dir, null);
    }
    /** What the store holds now, for the session's diagnostics. */
    stats() {
        return { owners: this.owners.size, sources: this.sources.size, removing: this.removing.size, storeBytes: this.storeBytes };
    }
    /** A new owner, staged, for `binding` of the build of wrangler `wranglerId`: its token. */
    mint(wranglerId, binding) {
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
    commit(wranglerId, tokens) {
        const committing = new Map();
        for (const token of tokens) {
            const owner = this.owners.get(token);
            if (owner === undefined || owner.state !== 'staged' || owner.wranglerId !== wranglerId)
                continue;
            // A binding named twice is the last one's, as the env it went into: the earlier owner is retired.
            const earlier = committing.get(owner.binding);
            if (earlier !== undefined)
                this.retire(earlier.token);
            committing.set(owner.binding, owner);
        }
        for (const previous of [...this.owners.values()]) {
            if (previous.wranglerId !== wranglerId || previous.state !== 'committed')
                continue;
            const slot = `${wranglerId}\0${previous.binding}`;
            const before = this.sources.get(slot);
            if (before !== undefined)
                this.retire(before);
            if (committing.has(previous.binding)) {
                previous.state = 'source';
                this.sources.set(slot, previous.token);
            }
            else {
                this.retire(previous.token);
            }
        }
        for (const owner of committing.values())
            owner.state = 'committed';
    }
    /** `token` closed, and its directory queued for removal. Idempotent. Synchronous. */
    release(token) {
        this.retire(token);
    }
    /** Every owner and reuse source of wrangler `wranglerId`, released. Synchronous. */
    stop(wranglerId) {
        for (const owner of [...this.owners.values()])
            if (owner.wranglerId === wranglerId)
                this.retire(owner.token);
    }
    /** Serve a request of the shim; a token this incarnation does not hold open is refused. Every stream it is given is consumed or cancelled. */
    async serve(request, stream) {
        let unused = stream;
        try {
            const owner = this.owners.get(String(request.owner));
            const open = owner !== undefined && (owner.state === 'staged' || owner.state === 'committed');
            if (request.kind === 'alive')
                return open;
            if (!open || owner === undefined)
                throw new LoaderStoreRefusal('this worker\'s loader binding was retired: its build was replaced or stopped', 'EPERM');
            switch (request.kind) {
                case 'has': return await this.track(owner, this.has(owner, request.digests));
                case 'read': return await this.track(owner, Promise.resolve().then(() => this.read(owner, request.digest, request.offset, request.length)));
                case 'put': {
                    const source = unused;
                    unused = undefined;
                    return await this.track(owner, this.put(owner, request.digest, request.size, source));
                }
            }
        }
        finally {
            await unused?.cancel().catch(() => { });
        }
    }
    /** Which of `digests` the owner holds, each it lacks but another owner or reuse source of this incarnation has adopted first. */
    async has(owner, digests) {
        if (!Array.isArray(digests) || digests.length > HAS_DIGESTS || !digests.every((digest) => DIGEST.test(String(digest)))) {
            throw new LoaderStoreRefusal(`has asks after at most ${HAS_DIGESTS} SHA-256 digests`, 'EINVAL');
        }
        const fs = this.ownerFs(owner);
        const held = [];
        for (const digest of digests) {
            await owner.creating.get(digest)?.catch(() => { });
            if (this.size(fs, `${owner.dir}/${digest}`) !== null) {
                held.push(digest);
                continue;
            }
            const donor = await this.donor(owner, digest);
            if (donor === null)
                continue;
            await this.create(owner, digest, donor.size, async () => {
                fs.copyFile(`${donor.owner.dir}/${digest}`, `${owner.dir}/${digest}`);
            }, donor.owner);
            held.push(digest);
        }
        return held;
    }
    /** Another live owner's, or a reuse source's, file of `digest`: a put of it in flight there is waited for first (bounded by the put's own deadline). */
    async donor(owner, digest) {
        const fs = this.storeFs();
        for (const candidate of this.owners.values()) {
            if (candidate === owner || !candidate.made || candidate.state === 'closed')
                continue;
            await candidate.creating.get(digest)?.catch(() => { });
            // Retired while it waited: no record names it any more.
            if (!this.owners.has(candidate.token))
                continue;
            const size = this.size(fs, `${candidate.dir}/${digest}`);
            if (size !== null)
                return { owner: candidate, size };
        }
        return null;
    }
    /** The bytes of module `digest`, `size` long, written from `stream` and published only if they are what `digest` names. */
    async put(owner, digest, size, stream) {
        try {
            if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(size) || size < 0 || stream === undefined) {
                throw new LoaderStoreRefusal('put names a SHA-256 digest, a size and its bytes', 'EINVAL');
            }
            const fs = this.ownerFs(owner);
            await owner.creating.get(digest)?.catch(() => { });
            if (this.size(fs, `${owner.dir}/${digest}`) !== null)
                return false;
            await this.create(owner, digest, size, () => fs.writeFileFrom(`${owner.dir}/${digest}`, size, verified(stream, digest), { mode: 0o600 }).then(() => { }));
            return true;
        }
        finally {
            // Read to its end, or not at all (joined, refused before a byte was read): either way its producer is let go.
            await stream?.cancel().catch(() => { });
        }
    }
    read(owner, digest, offset, length) {
        if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > LOADER_STORE_READ_BYTES) {
            throw new LoaderStoreRefusal(`read names a SHA-256 digest and at most ${LOADER_STORE_READ_BYTES} bytes`, 'EINVAL');
        }
        return this.ownerFs(owner).readRangeUncached(`${owner.dir}/${digest}`, offset, length);
    }
    /**
     * One new file of `owner`, admitted against the caps before `make`
     * creates it, and counted as its own (a put's or an adoption's alike): a
     * creation of the same digest under way is joined (its stream then unread,
     * cancelled by the caller), and a failed one gives its count back. A copy
     * from `from` is in flight on the donor too, so its removal waits for it.
     */
    create(owner, digest, size, make, from) {
        const joined = owner.creating.get(digest);
        if (joined !== undefined)
            return joined;
        const over = owner.files + 1 > OWNER_FILES
            ? `this worker_loaders binding's build would hold ${owner.files + 1} files, over its cap of ${OWNER_FILES}`
            : owner.bytes + size > OWNER_BYTES
                ? `this worker_loaders binding's build would hold ${owner.bytes + size} bytes, over its cap of ${OWNER_BYTES} (256 MiB)`
                : this.storeBytes + size > STORE_BYTES
                    ? `the session's loader store would hold ${this.storeBytes + size} bytes, over its cap of ${STORE_BYTES} (1 GiB per session incarnation, each binding's files counted as its own, a copy shared with another binding's included)`
                    : null;
        if (over !== null)
            return Promise.reject(new LoaderStoreRefusal(over, 'ENOSPC'));
        owner.files++;
        owner.bytes += size;
        this.storeBytes += size;
        const creation = Promise.resolve().then(make).catch((error) => {
            owner.files--;
            owner.bytes -= size;
            this.storeBytes -= size;
            throw error;
        }).finally(() => owner.creating.delete(digest));
        owner.creating.set(digest, creation);
        this.track(owner, creation).catch(() => { });
        if (from !== undefined)
            this.track(from, creation).catch(() => { });
        return creation;
    }
    /** `operation`, which reads or writes `owner`'s directory: its removal waits for it. */
    track(owner, operation) {
        owner.inFlight.add(operation);
        const done = () => { owner.inFlight.delete(operation); };
        operation.then(done, done);
        return operation;
    }
    /** `token` closed, its reuse-source record dropped, its directory queued for removal once nothing reads or writes it. */
    retire(token) {
        const owner = this.owners.get(token);
        if (owner === undefined)
            return;
        owner.state = 'closed';
        this.owners.delete(token);
        for (const [slot, source] of this.sources)
            if (source === token)
                this.sources.delete(slot);
        if (owner.made)
            this.queueRemoval(owner.dir, owner);
    }
    /**
     * Remove `dir` once `owner`'s operations (all of them, however many come
     * after this) have drained, by the VFS's own paged remover; once it is
     * gone, the owner's count goes, once. One not gone stays queued and still
     * counted, whatever part of it went, and every queued directory is tried
     * again at each removal. A dead incarnation's directories were never
     * counted.
     */
    queueRemoval(dir, owner) {
        this.removing.set(dir, owner);
        this.removals = this.removals.then(async () => {
            if (owner !== null)
                while (owner.inFlight.size > 0)
                    await Promise.allSettled([...owner.inFlight]);
            for (const [pending, held] of [...this.removing]) {
                if (held !== null && held.inFlight.size > 0)
                    continue;
                if (!this.removeDir(pending) || !this.removing.delete(pending) || held === null)
                    continue;
                this.storeBytes -= held.bytes;
                held.files = 0;
                held.bytes = 0;
            }
        }).catch(() => { });
    }
    /** Whether `dir` is gone. */
    removeDir(dir) {
        try {
            const removal = this.storeFs().removeRecursive(dir);
            if (removal.failures.length === 0 && removal.kept.length === 0)
                return true;
            console.warn(`[nimbus/loader-code-store] ${dir}: ${removal.failures.length + removal.kept.length} entries could not be removed; tried again later`);
            return false;
        }
        catch (error) {
            if (isMissing(error))
                return true;
            console.warn(`[nimbus/loader-code-store] could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    /** The store's credentialed view: /.nimbus the kernel's (as every kernel store checks it), loader-code the store's own, checked at every use. */
    storeFs() {
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
    ownerFs(owner) {
        const fs = this.storeFs();
        if (!owner.made) {
            fs.mkdir(owner.dir, { mode: 0o700 });
            owner.made = true;
        }
        return fs;
    }
    size(fs, path) {
        const stat = statOrNull(fs, path);
        return stat?.type === 'file' ? stat.size : null;
    }
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
function statOrNull(fs, path) {
    try {
        return fs.lstat(path);
    }
    catch (error) {
        if (isMissing(error))
            return null;
        throw error;
    }
}
/**
 * `stream`'s bytes, hashed as they pass: one that is not what `digest`
 * names fails its last read, so nothing is published. A slice that does not
 * come within PUT_SLICE_MS ends the put; the stream is cancelled whenever the
 * read ends early.
 */
async function* verified(stream, digest) {
    const hash = sha256Incremental();
    const reader = stream.getReader();
    let done = false;
    try {
        for (;;) {
            let timer = null;
            const late = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new LoaderStoreRefusal(`a put's bytes stopped coming for ${PUT_SLICE_MS / 1000} s`, 'ETIMEDOUT')), PUT_SLICE_MS);
            });
            const next = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
            if (next.done)
                break;
            await hash.update(next.value);
            yield next.value;
        }
        done = true;
    }
    finally {
        if (!done)
            await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    if (await hash.hex() !== digest)
        throw new LoaderStoreRefusal(`the bytes put are not what digest ${digest} names`, 'EINVAL');
}
