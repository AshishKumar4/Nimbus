/**
 * The editor pane's filesystem messages, over the terminal's WebSocket
 * (fs-read, fs-write, fs-list, each answered by a `<type>-result` frame):
 * read and written as the kernel, each answer computed whole.
 *
 * Binary refuse: fs-read uses readFile(bytes) + fatal:true UTF-8 decode.
 * Throws on invalid bytes → reply { binary:true } with no content. The
 * editor pane shows a friendly placeholder; this is the same heuristic
 * hardening-r5 already uses for VFS<->facet serialization (see manager.ts
 * _readBundleCell).
 */
import { parentVfsPath, stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';
import { recallOf, withRecall } from '@nimbus-sh/core/vfs/recall.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

type EditorFs = Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'readFile' | 'mkdir' | 'writeFile' | 'readdir'>;

/**
 * The frame answering `msg`, computed again once a delegation it meets is
 * recalled (withRecall): the editor's reads and writes wait for a process
 * holding the subtree rather than failing; its listings (`views.tree`, a
 * `landed` view) read what has landed and wait for nothing. Any other
 * failure is the frame's error.
 */
export function serveEditorFs(views: { files: EditorFs; tree: EditorFs }, msg: any): Promise<any> {
  // A listing is the file tree's, which reads after each wave lands (fs-watch):
  // it reads what has landed. Opening and saving a file wait for its holder.
  const kernelFs = msg?.type === 'fs-list' ? views.tree : views.files;
  return withRecall(() => answerEditorFs(kernelFs, msg)).catch((e: any) => ({
    type: msg.type + '-result',
    path: msg.path,
    dir: msg.dir,
    ok: false,
    error: (e?.message || String(e)),
  }));
}

function answerEditorFs(kernelFs: EditorFs, msg: any): any {
  if (msg.type === 'fs-read') {
    const p = stripLeadingSlashes(String(msg.path || ''));
    if (!kernelFs.exists(p)) {
      return { type: 'fs-read-result', path: msg.path, error: 'ENOENT: no such file or directory' };
    }
    if (kernelFs.isDirectory(p)) {
      return { type: 'fs-read-result', path: msg.path, error: 'EISDIR: is a directory' };
    }
    // Read bytes; attempt strict UTF-8 decode. Non-UTF-8 → mark
    // binary so the editor shows a friendly placeholder rather
    // than mojibake.
    const bytes = kernelFs.readFile(p);
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { type: 'fs-read-result', path: msg.path, content };
    } catch {
      return {
        type: 'fs-read-result',
        path: msg.path,
        binary: true,
        error: 'binary file (non-UTF-8) — editor cannot display',
      };
    }
  }
  if (msg.type === 'fs-write') {
    const p = stripLeadingSlashes(String(msg.path || ''));
    if (!p) {
      return { type: 'fs-write-result', path: msg.path, ok: false, error: 'empty path' };
    }
    const parent = parentVfsPath(p);
    if (parent) try { kernelFs.mkdir(parent, { recursive: true }); } catch (error) { if (recallOf(error) !== null) throw error; }
    const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
    kernelFs.writeFile(p, content);
    return { type: 'fs-write-result', path: msg.path, ok: true };
  }
  if (msg.type === 'fs-list') {
    const dir = stripLeadingSlashes(String(msg.dir || ''));
    const recursive = msg.recursive === true;
    if (dir && !kernelFs.exists(dir)) {
      return { type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOENT' };
    }
    if (dir && !kernelFs.isDirectory(dir)) {
      return { type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOTDIR' };
    }
    // BFS walk with per-call cap so a 10k-file project doesn't
    // ship a megabyte JSON frame. 2000 entries is well above
    // typical project sizes (vite scaffold = ~30 files; even
    // node_modules tree of a 50-dep project under 2000).
    const MAX_ENTRIES = 2000;
    const out: { path: string; type: string }[] = [];
    const queue: string[] = [dir];
    while (queue.length > 0 && out.length < MAX_ENTRIES) {
      const cur = queue.shift()!;
      let entries: { name: string; type: string }[];
      // A directory it cannot list is left out; a delegation it meets is recalled (the walk runs again).
      try { entries = kernelFs.readdir(cur); } catch (error) { if (recallOf(error) !== null) throw error; continue; }
      for (const e of entries) {
        if (out.length >= MAX_ENTRIES) break;
        if (e.name === 'node_modules' || e.name === '.git') continue;  // skip noisy
        const child = cur ? cur + '/' + e.name : e.name;
        out.push({ path: '/' + child, type: e.type });
        if (recursive && e.type === 'directory') queue.push(child);
      }
    }
    return {
      type: 'fs-list-result',
      dir: msg.dir,
      entries: out,
      truncated: out.length >= MAX_ENTRIES,
    };
  }
  return { type: msg.type + '-result', ok: false, error: 'unknown fs message type' };
}
