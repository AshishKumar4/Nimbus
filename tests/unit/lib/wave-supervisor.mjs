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
import { WaveIngest } from '../../../packages/core/src/runtime/wave-ingest.ts';

/** `supervisor` with openWaveWriter and writeBatchStream (unless it has them). */
export function waveSupervisor(supervisor, engine) {
  if (typeof supervisor.writeBatchStream === 'function') return supervisor;
  const waves = engine === undefined ? null : new WaveIngest(null);
  supervisor.openWaveWriter = async () => null;
  // A method of whichever supervisor it is called on: a test that copies
  // this one ({ ...supervisor, mkdir }) observes the calls of its copy.
  supervisor.writeBatchStream = engine !== undefined
    ? (stream) => waves.writeStream(engine, stream)
    : function writeBatchStream(stream) { return replay(this, stream); };
  return supervisor;
}

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
  // The receipt is the session's stat of the file, as it answers one: the mock's own.
  const receipt = async (path, revision) => {
    const stat = typeof supervisor.lstat === 'function' ? await supervisor.lstat(abs(path)) : null;
    if (!stat) return;
    progress.receipts.push({
      path, ino: Number(stat.ino) || 0, mode: Number(stat.mode) || 0, size: Number(stat.size) || 0,
      mtimeMs: Number(stat.mtime ?? stat.mtimeMs) || 0, ctimeMs: Number(stat.ctime ?? stat.ctimeMs) || 0,
      uid: Number(stat.uid) || 0, gid: Number(stat.gid) || 0, dev: Number(stat.dev) || 0,
      ...(typeof revision === 'number' ? { revision } : {}),
    });
  };
  const refusal = (code, key) => Object.assign(new Error(`${code}: open '${abs(key)}'`), { code });
  // A mock's stat of a name not there: null, or its ENOENT.
  const present = async (stat, key) => {
    try { return (await stat.call(supervisor, abs(key))) ?? null; } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
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
          else if (inode.call === 'append' || inode.call === 'appendFile') {
            const prior = typeof supervisor.stat === 'function' ? await supervisor.stat(abs(inode.path)) : null;
            if (prior) noted(await supervisor.fsWriteRange(abs(inode.path), Number(prior.size) || 0, data));
            else revision = await supervisor.writeFile(abs(inode.path), data);
          } else revision = await supervisor.writeFile(abs(inode.path), data);
          await receipt(inode.path, revision);
          break;
        }
        case 'call': {
          const call = record.call;
          if (call.call === 'mkdir') await supervisor.mkdir(abs(call.path));
          else if (call.call === 'unlink') await supervisor.unlink(abs(call.path));
          else if (call.call === 'rmdir') await supervisor.rmdir(abs(call.path));
          else if (call.call === 'ftruncate') noted(await supervisor.fsTruncate(abs(call.path), call.size));
          else if (call.call === 'rm') {
            try {
              // A mock without fsRemove removes a file as unlink does.
              if (typeof supervisor.fsRemove === 'function') await supervisor.fsRemove(abs(call.path), { recursive: call.recursive === true, force: call.force === true });
              else await supervisor.unlink(abs(call.path));
            } catch (error) {
              if (!(call.force === true && error?.code === 'ENOENT')) throw error;
            }
          }
          else if (call.call === 'lchown') noted(await supervisor.chown(abs(call.path), call.uid, call.gid, { followSymlinks: false }));
          else if (call.call === 'lutimes') noted(await supervisor.utimes(abs(call.path), call.atime, call.mtime));
          // A node process's write open, judged as the session judges one
          // (sqlite-vfs openToWrite) over the mock's own calls; its receipt is the opened file's stat.
          else if (call.call === 'open' && call.description === undefined) {
            const stat = typeof supervisor.stat === 'function' ? supervisor.stat : null;
            const lstat = typeof supervisor.lstat === 'function' ? supervisor.lstat : stat;
            let revision;
            if (lstat === null) {
              // A mock that answers no stat: the file the open makes or empties is a whole write of nothing.
              if (call.create === true || call.truncate === true) revision = await supervisor.writeFile(abs(call.path), new Uint8Array(0));
            } else {
              const name = await present(lstat, call.path);
              if (name && call.create === true && call.exclusive === true) throw refusal('EEXIST', call.path);
              if (call.nofollow === true && name?.type === 'symlink') throw refusal('ELOOP', call.path);
              const there = call.nofollow === true || stat === null ? name : await present(stat, call.path);
              if (!there && call.create !== true) throw refusal('ENOENT', call.path);
              if (there?.type === 'directory') throw refusal('EISDIR', call.path);
              if (!there) revision = await supervisor.writeFile(abs(call.path), new Uint8Array(0));
              else if (call.truncate === true) noted(await supervisor.fsTruncate(abs(call.path), 0));
            }
            await receipt(call.path, revision);
          }
          // A write description's open or close (a WASI process's): no test that drives this supervisor makes one.
          else if (call.call === 'open' || call.call === 'close') throw new Error(`wave-supervisor: ${call.call} calls of a description are not modeled`);
          // A copy is the session's: its own copy where the mock has one, else its read of the source and write of the copy.
          else if (call.call === 'copyFile') {
            if (typeof supervisor.fsCopyFile === 'function') await supervisor.fsCopyFile(abs(call.from), abs(call.path));
            else {
              const bytes = typeof supervisor.readFileBytes === 'function' ? await supervisor.readFileBytes(abs(call.from)) : await supervisor.readFile(abs(call.from));
              if (bytes === null || bytes === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, copyfile '${abs(call.from)}'`), { code: 'ENOENT' });
              await supervisor.writeFile(abs(call.path), typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
            }
          }
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
