/**
 * The Worker Loader shim's code, kept in the owning session's store (FAB-2,
 * loader-code-store-design-r7.md). A Worker a `wrangler dev` build's
 * worker_loaders binding loads is written here before its handle is
 * returned, so the shim's heap is only a cache of what is durable.
 *
 * The store is one flat directory per owner, `/.nimbus/loader-code/<sha256
 * of its token>/<sha256 of a module>`, written by its own credential (uid
 * 998: admitted against the unprivileged ceiling, beyond the session user's
 * reach). An owner is one binding of one build: minted with the build's env
 * (`mint`), committed with it, and at its binding's next commit kept as that
 * binding's reuse source, whose files a later owner adopts by a
 * content-sharing copy instead of being sent them again. Every transition of
 * the registry is synchronous; what waits is only the removal of a
 * directory no record names, once nothing reads or writes it.
 *
 * One registry per actor incarnation (keyed by its `ctx`): every directory
 * present when it is made belonged to a dead incarnation, and is swept.
 */
import { sha256Incremental } from '@nimbus-sh/core/_shared/crypto.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
export const LOADER_CODE_ROOT = '/.nimbus/loader-code';
const KERNEL_ROOT = '/.nimbus';
export const CRED_LOADER_STORE = Object.freeze({ uid: 998, gid: 998, groups: Object.freeze([998]), umask: 0o077 });
const OWNER_FILES = 16_384;
const OWNER_BYTES = 256 * 1024 * 1024;
const STORE_BYTES = 1024 * 1024 * 1024;
/** The most one read answers, and the most digests one `has` asks after. */
export const LOADER_STORE_READ_BYTES = 4 * 1024 * 1024;
const HAS_DIGESTS = 256;
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
/** The registry of `ctx`'s incarnation, over its filesystem `engine`. */
export function loaderCodeRegistry(ctx, engine) {
    let registry = registries.get(ctx);
    if (registry === undefined) {
        registry = new LoaderCodeRegistry(engine);
        registries.set(ctx, registry);
    }
    return registry;
}
export class LoaderCodeRegistry {
    engine;
    owners = new Map();
    /** Per (wrangler, binding): its reuse source's token. */
    sources = new Map();
    /** Directories queued for removal, by path, with their bytes until removed. */
    removing = new Map();
    storeBytes = 0;
    removals = Promise.resolve();
    rootChecked = false;
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
        this.queue(() => dead);
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
     * A build of wrangler `wranglerId` committed with `tokens`: they are its
     * bindings' owners now, each binding's previous one its reuse source, and
     * a reuse source before that queued for removal. Synchronous.
     */
    commit(wranglerId, tokens) {
        for (const token of tokens) {
            const owner = this.owners.get(token);
            if (owner === undefined || owner.state !== 'staged' || owner.wranglerId !== wranglerId)
                continue;
            const slot = `${wranglerId}\0${owner.binding}`;
            for (const previous of this.owners.values()) {
                if (previous.wranglerId === wranglerId && previous.binding === owner.binding && previous.state === 'committed') {
                    const before = this.sources.get(slot);
                    if (before !== undefined)
                        this.retire(before);
                    previous.state = 'source';
                    this.sources.set(slot, previous.token);
                }
            }
            owner.state = 'committed';
        }
    }
    /** `token` closed, and its directory queued for removal. Idempotent. Synchronous. */
    release(token) {
        const owner = this.owners.get(token);
        if (owner === undefined || owner.state === 'closed')
            return;
        this.retire(token);
    }
    /** Every owner and reuse source of wrangler `wranglerId`, released. Synchronous. */
    stop(wranglerId) {
        for (const owner of [...this.owners.values()])
            if (owner.wranglerId === wranglerId)
                this.retire(owner.token);
        for (const slot of [...this.sources.keys()])
            if (slot.startsWith(`${wranglerId}\0`))
                this.sources.delete(slot);
    }
    /** Serve a request of the shim; a token this incarnation does not hold open is refused. */
    async serve(request, stream) {
        const owner = this.owners.get(String(request.owner));
        const open = owner !== undefined && (owner.state === 'staged' || owner.state === 'committed');
        if (request.kind === 'alive')
            return open;
        if (!open || owner === undefined)
            throw new LoaderStoreRefusal('this worker\'s loader binding was retired: its build was replaced or stopped', 'EPERM');
        switch (request.kind) {
            case 'has': return this.track(owner, this.has(owner, request.digests));
            case 'put': return this.track(owner, this.put(owner, request.digest, request.size, stream));
            case 'read': return this.track(owner, Promise.resolve().then(() => this.read(owner, request.digest, request.offset, request.length)));
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
            await owner.creating.get(digest);
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
    /** Another live owner's, or a reuse source's, file of `digest`: a put of it in flight there is waited for first. */
    async donor(owner, digest) {
        const fs = this.storeFs();
        for (const candidate of this.owners.values()) {
            if (candidate === owner || !candidate.made || candidate.state === 'closed')
                continue;
            await candidate.creating.get(digest)?.catch(() => { });
            const size = this.size(fs, `${candidate.dir}/${digest}`);
            if (size !== null)
                return { owner: candidate, size };
        }
        return null;
    }
    /** The bytes of module `digest`, `size` long, written from `stream` and published only if they are what `digest` names. */
    async put(owner, digest, size, stream) {
        if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(size) || size < 0 || stream === undefined) {
            throw new LoaderStoreRefusal('put names a SHA-256 digest, a size and its bytes', 'EINVAL');
        }
        const fs = this.ownerFs(owner);
        await owner.creating.get(digest);
        if (this.size(fs, `${owner.dir}/${digest}`) !== null) {
            await stream.cancel();
            return false;
        }
        await this.create(owner, digest, size, () => fs.writeFileFrom(`${owner.dir}/${digest}`, size, verified(stream, digest), { mode: 0o600 }).then(() => { }));
        return true;
    }
    read(owner, digest, offset, length) {
        if (!DIGEST.test(String(digest)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > LOADER_STORE_READ_BYTES) {
            throw new LoaderStoreRefusal(`read names a SHA-256 digest and at most ${LOADER_STORE_READ_BYTES} bytes`, 'EINVAL');
        }
        return this.ownerFs(owner).readRangeUncached(`${owner.dir}/${digest}`, offset, length);
    }
    /**
     * One new file of `owner`, admitted against the caps before `make`
     * creates it: a creation of the same digest under way is joined, and a
     * failed one gives its reservation back. A copy from `from` is in flight
     * on it too, so its removal waits for the copy.
     */
    create(owner, digest, size, make, from) {
        const joined = owner.creating.get(digest);
        if (joined !== undefined)
            return joined;
        if (owner.files + 1 > OWNER_FILES || owner.bytes + size > OWNER_BYTES || this.storeBytes + size > STORE_BYTES) {
            throw new LoaderStoreRefusal(`this owner would hold ${owner.files + 1} files and ${owner.bytes + size} bytes (at most ${OWNER_FILES} and ${OWNER_BYTES}), and the session's loader store ${this.storeBytes + size} bytes (at most ${STORE_BYTES})`, 'ENOSPC');
        }
        owner.files++;
        owner.bytes += size;
        this.storeBytes += size;
        const creation = make().catch((error) => {
            owner.files--;
            owner.bytes -= size;
            this.storeBytes -= size;
            throw error;
        }).finally(() => owner.creating.delete(digest));
        owner.creating.set(digest, creation);
        if (from !== undefined)
            this.track(from, creation);
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
        if (!owner.made)
            return;
        const dir = owner.dir;
        this.removing.set(dir, owner.bytes);
        const drained = Promise.allSettled([...owner.inFlight, ...owner.creating.values()]);
        this.queue(async () => {
            await drained;
            return [dir];
        });
    }
    /** Remove each directory `paths` names, one after another, each with the VFS's paged recursive removal. */
    queue(paths) {
        this.removals = this.removals.then(async () => {
            for (const dir of await paths()) {
                try {
                    this.storeFs().removeRecursive(dir);
                }
                catch (error) {
                    if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')) {
                        console.warn(`[nimbus/loader-code-store] could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                this.storeBytes -= this.removing.get(dir) ?? 0;
                this.removing.delete(dir);
            }
        }).catch(() => { });
    }
    /** The store's credentialed view, its directory made and checked first. */
    storeFs() {
        if (!this.rootChecked) {
            const kernel = this.engine.as(CRED_KERNEL);
            let base = statOrNull(kernel, KERNEL_ROOT);
            if (base === null) {
                kernel.mkdir(KERNEL_ROOT, { mode: 0o755 });
                base = kernel.lstat(KERNEL_ROOT);
            }
            if (base.type !== 'directory' || base.uid !== 0 || (base.mode & 0o022) !== 0) {
                throw new LoaderStoreRefusal(`${KERNEL_ROOT} is not the kernel's own directory; the loader store is not written through it`, 'EPERM');
            }
            let root = statOrNull(kernel, LOADER_CODE_ROOT);
            if (root === null) {
                kernel.mkdir(LOADER_CODE_ROOT, { mode: 0o700 });
                kernel.chown(LOADER_CODE_ROOT, CRED_LOADER_STORE.uid, CRED_LOADER_STORE.gid, { followSymlinks: false });
                root = kernel.lstat(LOADER_CODE_ROOT);
            }
            if (root.type !== 'directory' || root.uid !== CRED_LOADER_STORE.uid || (root.mode & 0o077) !== 0) {
                throw new LoaderStoreRefusal(`${LOADER_CODE_ROOT} is not the loader store's own directory (uid ${CRED_LOADER_STORE.uid}, mode 0700)`, 'EPERM');
            }
            this.rootChecked = true;
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
function statOrNull(fs, path) {
    try {
        return fs.lstat(path);
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')
            return null;
        throw error;
    }
}
/** `stream`'s bytes, hashed as they pass: one that is not what `digest` names fails its last read, so nothing is published. */
async function* verified(stream, digest) {
    const hash = sha256Incremental();
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            await hash.update(value);
            yield value;
        }
    }
    finally {
        reader.releaseLock();
    }
    if (await hash.hex() !== digest)
        throw new LoaderStoreRefusal(`the bytes put are not what digest ${digest} names`, 'EINVAL');
}
