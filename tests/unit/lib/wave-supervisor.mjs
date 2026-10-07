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
  supervisor.writeBatchStream = engine !== undefined
    ? (stream) => engine.writeStream(stream)
    : (stream) => replay(supervisor, stream);
  return supervisor;
}

/** Each record of the wave as the supervisor's own call of that name, in order. */
async function replay(supervisor, stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const progress = { committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [] };
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
          if (inode.call === 'write') revision = await supervisor.fsWriteRange(abs(inode.path), inode.offset, data);
          else if (inode.call === 'append' || inode.call === 'appendFile') {
            const prior = typeof supervisor.stat === 'function' ? await supervisor.stat(abs(inode.path)) : null;
            revision = prior ? await supervisor.fsWriteRange(abs(inode.path), Number(prior.size) || 0, data) : await supervisor.writeFile(abs(inode.path), data);
          } else revision = await supervisor.writeFile(abs(inode.path), data);
          progress.receipts.push({
            path: inode.path, ino: 0, mode: 0o100644, size: data.byteLength, mtimeMs: Date.now(), ctimeMs: Date.now(), uid: 0, gid: 0, dev: 0,
            ...(typeof revision === 'number' ? { revision } : {}),
          });
          break;
        }
        case 'call': {
          const call = record.call;
          if (call.call === 'mkdir') await supervisor.mkdir(abs(call.path));
          else if (call.call === 'unlink') await supervisor.unlink(abs(call.path));
          else if (call.call === 'rmdir') await supervisor.rmdir(abs(call.path));
          else if (call.call === 'ftruncate') await supervisor.fsTruncate(abs(call.path), call.size);
          else await supervisor.symlink(call.target, abs(call.path));
          break;
        }
        case 'rename':
          await supervisor.rename(abs(record.from), abs(record.to));
          break;
        case 'truncate':
          await supervisor.fsTruncate(abs(record.path), record.size);
          break;
        case 'setattr':
          if ('mode' in record.attrs) await supervisor.chmod(abs(record.path), record.attrs.mode);
          else if ('uid' in record.attrs) await supervisor.chown(abs(record.path), record.attrs.uid, record.attrs.gid);
          else await supervisor.utimes(abs(record.path), record.attrs.atime, record.attrs.mtime);
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
