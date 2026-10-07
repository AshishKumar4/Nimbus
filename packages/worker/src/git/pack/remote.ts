/**
 * git/pack/remote.ts — a remote's refs, a fetch's pack and a push, as the
 * git network facet runs them for a remote helper (git/engine.ts): the
 * three raw operations git-remote-http(s) needs of the network. None of
 * them writes a ref: git does, after.
 *
 *   listRefs   the refs upload-pack (or, for a push, receive-pack)
 *              advertises, the symbolic HEAD, and the object format
 *   fetchPack  one request (wants, the repository's ref tips as haves, its
 *              shallow commits, the deepen and filter options): the pack is
 *              stored with its .idx and .rev (a .promisor for a filtered
 *              one) and .git/shallow updated as git's fetch-pack updates it;
 *              a pack past one invocation's decoding budget is stored whole
 *              and finished by fetchPackResume
 *   pushPack   the ref updates and the caller's pack in one request, and
 *              receive-pack's report
 *
 * The pack a fetch asks for is never thin: every delta's base is in it, so
 * none is read from the repository's packs or loose objects.
 */
import { resumePack, storePackResumable, type CloneContext, type PendingPack } from './clone.js';
import { PackFormatError } from './format.js';
import { discoverReceivePack, sendPack, type ReceiveCommand } from './receive-pack.js';
import { discover, requestPack, type Advertisement, type GitTransportAuth, type UploadPackOptions } from './upload-pack.js';

/** The remote, as an operation reaches it. */
export interface RemoteTransport {
  url: string;
  auth?: GitTransportAuth;
  fetch?: typeof fetch;
  onProgress?(line: string): void;
}

export interface RemoteRef {
  name: string;
  oid: string | null;
  symref?: string;
}

const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function transportOf(remote: RemoteTransport): UploadPackOptions {
  return { url: remote.url, auth: remote.auth, fetch: remote.fetch, onProgress: remote.onProgress };
}

function objectFormat(advertisement: Advertisement): 'sha1' | 'sha256' {
  return advertisement.capabilities.has('object-format=sha256') ? 'sha256' : 'sha1';
}

/** The refs the remote advertises (its peeled tags as "<name>^{}"), a symbolic ref's target with it. */
export async function listRefs(remote: RemoteTransport, request: { forPush: boolean }): Promise<{ refs: RemoteRef[]; objectFormat: 'sha1' | 'sha256' }> {
  const advertisement = request.forPush ? await discoverReceivePack(transportOf(remote)) : await discover(transportOf(remote));
  const refs: RemoteRef[] = [];
  for (const [name, oid] of advertisement.refs) {
    const symref = advertisement.symrefs.get(name);
    refs.push(symref === undefined ? { name, oid } : { name, oid, symref });
  }
  // An unborn HEAD: named, with nothing it points at yet.
  for (const [name, symref] of advertisement.symrefs) {
    if (!advertisement.refs.has(name)) refs.push({ name, oid: null, symref });
  }
  return { refs, objectFormat: objectFormat(advertisement) };
}

export interface FetchPackRequest {
  jobId: string;
  wants: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
  deepenRelative?: boolean;
  filter?: string;
  includeTag: boolean;
  updateShallow: boolean;
  budgetUnits?: number;
}

/** A fetch's outcome; `pending` while its pack's decoding goes on (fetchPackResume). */
export interface FetchPackStep {
  pending: (PendingPack & { shallow: ShallowUpdate }) | null;
  packName: string | null;
  objects: number;
  bytes: number;
  shallow: boolean;
  promisor: boolean;
  selfContained: boolean;
}

/** What the server said of the receiver's shallow boundary, and whether .git/shallow takes it. */
interface ShallowUpdate {
  write: boolean;
  shallows: string[];
  unshallows: string[];
  /** The repository was complete before (no shallow commits, no promisor pack). */
  complete: boolean;
  filtered: boolean;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const join = (dir: string, path: string) => dir + '/' + path;

/** A file of the repository's .git, or null when there is none. */
async function gitFile(context: CloneContext, path: string): Promise<string | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await context.supervisor.fsReadRange(join(context.dir, '.git/' + path), 0, 64 * 1024 * 1024);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  }
  return bytes === null ? null : decoder.decode(bytes);
}

/** Every ref's value: loose refs under .git/refs, and packed-refs (a loose one wins). */
async function refTips(context: CloneContext): Promise<string[]> {
  const tips = new Map<string, string>();
  const packed = await gitFile(context, 'packed-refs');
  for (const line of (packed ?? '').split('\n')) {
    const match = /^([0-9a-f]{40,64}) (refs\/\S+)$/.exec(line);
    if (match !== null) tips.set(match[2], match[1]);
  }
  const walk = async (dir: string): Promise<void> => {
    for (const name of await context.supervisor.readdir(join(context.dir, '.git/' + dir))) {
      const path = dir + '/' + name;
      // A directory lists its refs; a file is one (a symbolic ref names another, already listed).
      if ((await context.supervisor.readdir(join(context.dir, '.git/' + path))).length > 0) {
        await walk(path);
        continue;
      }
      const oid = (await gitFile(context, path))?.trim();
      if (oid !== undefined && HEX_OID.test(oid)) tips.set(path, oid);
    }
  };
  await walk('refs');
  return [...new Set(tips.values())];
}

/** The repository's promisor packs: whether any pack is one. */
async function hasPromisorPack(context: CloneContext): Promise<boolean> {
  return (await context.supervisor.readdir(join(context.dir, '.git/objects/pack'))).some((name) => name.endsWith('.promisor'));
}

/** One request for `wants`, the pack stored; or where its decoding stopped. */
export async function fetchPack(context: CloneContext, request: FetchPackRequest): Promise<FetchPackStep> {
  for (const oid of request.wants) if (!HEX_OID.test(oid)) throw new PackFormatError('not an object id: ' + oid);
  const transport = transportOf(context);
  const advertisement = await discover(transport);
  const shallowText = await gitFile(context, 'shallow');
  const shallows = (shallowText ?? '').split('\n').filter((line) => HEX_OID.test(line));
  const filtered = request.filter !== undefined;
  const deepen = request.depth !== undefined || request.deepenSince !== undefined || (request.deepenNot?.length ?? 0) > 0;
  const response = await requestPack(transport, advertisement.capabilities, {
    wants: [...new Set(request.wants)],
    haves: await refTips(context),
    shallows,
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(request.deepenSince !== undefined ? { deepenSince: request.deepenSince } : {}),
    ...(request.deepenNot?.length ? { deepenNot: request.deepenNot } : {}),
    ...(request.deepenRelative ? { deepenRelative: true } : {}),
    ...(filtered ? { filter: request.filter } : {}),
    includeTag: request.includeTag,
  });
  const shallow: ShallowUpdate = {
    // fetch-pack.c: the boundary moves with a deepen, or when the fetch may update it (--update-shallow, clone).
    write: (deepen || request.updateShallow) && (response.shallows.length > 0 || response.unshallows.length > 0),
    shallows: response.shallows,
    unshallows: response.unshallows,
    complete: shallows.length === 0 && !await hasPromisorPack(context),
    filtered,
  };
  if (response.pack === null) {
    const wrote = await updateShallow(context, shallow, shallows);
    return { pending: null, packName: null, objects: 0, bytes: 0, shallow: wrote, promisor: false, selfContained: shallow.complete && !filtered && !wrote };
  }
  const writer = context.writer();
  const stored = await storePackResumable(context, writer, response.pack, 'tmp_pack_' + request.jobId, {
    budgetUnits: request.budgetUnits,
    ...(filtered ? { promisor: request.wants.map((oid) => oid + ' ' + oid + '\n').join('') } : {}),
  });
  await writer.flush();
  if ('pending' in stored) return { ...emptyStep(filtered), pending: { ...stored.pending, shallow } };
  return await finished(context, stored.summary, shallow, shallows);
}

/** A fetch whose pack's decoding stopped at the budget, continued from its stored bytes. */
export async function fetchPackResume(context: CloneContext, request: { pending: PendingPack & { shallow: ShallowUpdate }; budgetUnits?: number }): Promise<FetchPackStep> {
  const writer = context.writer();
  const stored = await resumePack(context, writer, request.pending, { budgetUnits: request.budgetUnits });
  await writer.flush();
  const { shallow } = request.pending;
  if ('pending' in stored) return { ...emptyStep(shallow.filtered), pending: { ...stored.pending, shallow } };
  const before = ((await gitFile(context, 'shallow')) ?? '').split('\n').filter((line) => HEX_OID.test(line));
  return await finished(context, stored.summary, shallow, before);
}

function emptyStep(filtered: boolean): FetchPackStep {
  return { pending: null, packName: null, objects: 0, bytes: 0, shallow: false, promisor: filtered, selfContained: false };
}

async function finished(
  context: CloneContext,
  summary: { packSha: string; packBytes: number; objects: number },
  shallow: ShallowUpdate,
  before: string[],
): Promise<FetchPackStep> {
  const wrote = await updateShallow(context, shallow, before);
  return {
    pending: null,
    packName: 'pack-' + summary.packSha,
    objects: summary.objects,
    bytes: summary.packBytes,
    shallow: wrote,
    promisor: shallow.filtered,
    // What the wants reach is here when the repository was complete and the pack is neither filtered nor shallow.
    selfContained: shallow.complete && !shallow.filtered && !wrote,
  };
}

/** .git/shallow as fetch-pack leaves it: what was there and what the server named shallow, less what it unshallowed. */
async function updateShallow(context: CloneContext, update: ShallowUpdate, before: readonly string[]): Promise<boolean> {
  if (!update.write) return false;
  const next = new Set(before);
  for (const oid of update.shallows) next.add(oid);
  for (const oid of update.unshallows) next.delete(oid);
  const writer = context.writer();
  if (next.size === 0) {
    if (before.length > 0) await writer.remove('.git/shallow');
  } else {
    await writer.file('.git/shallow', 0o644, encoder.encode([...next].sort().join('\n') + '\n'));
  }
  await writer.flush();
  return true;
}

export interface PushPackRequest {
  commands: ReceiveCommand[];
  atomic: boolean;
  pushOptions: string[];
}

/** The ref updates and the pack of what the remote lacks, and the remote's report. */
export async function pushPack(
  remote: RemoteTransport,
  request: PushPackRequest,
  pack: AsyncIterable<Uint8Array> | null,
): Promise<{ refs: Array<{ ref: string; ok: boolean; reason?: string }> }> {
  for (const command of request.commands) {
    if (!HEX_OID.test(command.old) || !HEX_OID.test(command.new)) throw new PackFormatError('a push command needs object ids: ' + command.ref);
  }
  const transport = transportOf(remote);
  const advertisement = await discoverReceivePack(transport);
  const report = await sendPack(transport, advertisement, { commands: request.commands, pack, atomic: request.atomic, pushOptions: request.pushOptions });
  // A pack the remote could not unpack fails every ref, as send-pack reports it.
  if (!report.unpack.ok) {
    const reason = 'unpacker error';
    return { refs: request.commands.map((command) => ({ ref: command.ref, ok: false, reason })) };
  }
  const reported = new Map(report.refs.map((entry) => [entry.ref, entry]));
  return {
    refs: request.commands.map((command) => reported.get(command.ref) ?? { ref: command.ref, ok: false, reason: 'the remote did not report this ref' }),
  };
}
