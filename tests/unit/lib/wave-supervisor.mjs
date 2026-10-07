/**
 * A test supervisor's wave calls: what a node process's filesystem client
 * (core _shared/process-fs-client.ts, carried by the write ledger) sends
 * every mutation through. A process's client opens no writer epoch here
 * (nothing between it and the session loses a call), and its waves reach:
 *   - `engine`, a SqliteVFS view, when the test has one: the session's own
 *     writeStream, so the calls are made exactly as the session makes them;
 *   - otherwise the supervisor's own single-call methods (writeFile, mkdir,
 *     unlink, rmdir, rename, fsTruncate, fsWriteRange, chmod, chown, utimes,
 *     symlink), one per record, for a mock that keeps its files itself.
 */

import { decodeWriteBatchStream } from '../../../packages/platform/src/w7-frame.ts';

/** `supervisor` with openWaveWriter and writeBatchStream (unless it has them). */
export function waveSupervisor(supervisor, engine) {
  if (typeof supervisor.writeBatchStream === 'function') return supervisor;
  supervisor.openWaveWriter = async () => null;
  // A method of whichever supervisor it is called on: a test that copies
  // this one ({ ...supervisor, mkdir }) observes the calls of its copy.
  supervisor.writeBatchStream = engine !== undefined
    ? (stream) => engine.writeStream(stream)
    : function writeBatchStream(stream) { return replay(this, stream); };
  return supervisor;
}

/** Appends replayed through a mock's own fsAppend, numbered under one module incarnation. */
let appends = 0;
const APPEND_MODULE = crypto.randomUUID();

/** Each record of the wave as the supervisor's own call of that name, in order. */
async function replay(supervisor, stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const progress = { committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [], mutations: [] };
  // A call's receipt (VfsMutationReceipt), kept as the op's mutation.
  const noted = (answer) => {
    if (answer && typeof answer.before === 'number' && typeof answer.after === 'number') {
      progress.mutations.push({ index: progress.committedOps, before: answer.before, after: answer.after });
    }
  };
  const abs = (key) => '/' + key;
  let file = null;
  try {
    for await (const record of decoded.records) {
      switch (record.type) {
        case 'file-begin':
          file = { inode: record.inode, parts: [] };
          continue;
        case 'file-chunk':
          file.parts.push(record.data.slice());
          record.retention.release();
          continue;
        case 'file-end': {
          const { inode, parts } = file;
          file = null;
          const data = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
          let at = 0;
          for (const part of parts) { data.set(part, at); at += part.byteLength; }
          let revision;
          if (inode.call === 'write') noted(await supervisor.fsWriteRange(abs(inode.path), inode.offset, data));
          else if ((inode.call === 'append' || inode.call === 'appendFile') && typeof supervisor.fsAppend === 'function') {
            // A mock that keeps appends itself takes each as its own append.
            const id = String(++appends);
            await supervisor.fsAppend(abs(inode.path), APPEND_MODULE, id, data);
            await supervisor.fsAppendAck?.(APPEND_MODULE, id);
          } else if (inode.call === 'append' || inode.call === 'appendFile') {
            const prior = typeof supervisor.stat === 'function' ? await supervisor.stat(abs(inode.path)) : null;
            if (prior) noted(await supervisor.fsWriteRange(abs(inode.path), Number(prior.size) || 0, data));
            else revision = await supervisor.writeFile(abs(inode.path), data);
          } else revision = await supervisor.writeFile(abs(inode.path), data);
          // The receipt is the session's stat of the file, as it answers one: the mock's own.
          const stat = typeof supervisor.lstat === 'function' ? await supervisor.lstat(abs(inode.path)) : null;
          if (stat) {
            progress.receipts.push({
              path: inode.path, ino: Number(stat.ino) || 0, mode: Number(stat.mode) || 0, size: Number(stat.size) || 0,
              mtimeMs: Number(stat.mtime ?? stat.mtimeMs) || 0, ctimeMs: Number(stat.ctime ?? stat.ctimeMs) || 0,
              uid: Number(stat.uid) || 0, gid: Number(stat.gid) || 0, dev: Number(stat.dev) || 0,
              ...(typeof revision === 'number' ? { revision } : {}),
            });
          }
          break;
        }
        case 'call': {
          const call = record.call;
          if (call.call === 'mkdir') await supervisor.mkdir(abs(call.path));
          else if (call.call === 'unlink') await supervisor.unlink(abs(call.path));
          else if (call.call === 'rmdir') await supervisor.rmdir(abs(call.path));
          else if (call.call === 'ftruncate') noted(await supervisor.fsTruncate(abs(call.path), call.size));
          else await supervisor.symlink(call.target, abs(call.path));
          break;
        }
        case 'rename':
          await supervisor.rename(abs(record.from), abs(record.to));
          break;
        case 'truncate':
          noted(await supervisor.fsTruncate(abs(record.path), record.size));
          break;
        case 'setattr':
          if ('mode' in record.attrs) noted(await supervisor.chmod(abs(record.path), record.attrs.mode));
          else if ('uid' in record.attrs) noted(await supervisor.chown(abs(record.path), record.attrs.uid, record.attrs.gid));
          else noted(await supervisor.utimes(abs(record.path), record.attrs.atime, record.attrs.mtime));
          break;
        case 'batch-end':
          return { ok: true, ...progress };
        default:
          continue;
      }
      progress.committedOps++;
    }
    throw new Error('w7-frame: stream ended without batch-end');
  } catch (error) {
    return {
      ok: false,
      ...progress,
      error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { errno: error.code } : {}) },
    };
  }
}
