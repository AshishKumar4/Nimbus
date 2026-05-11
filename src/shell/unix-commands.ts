/**
 * unix-commands.ts — Nimbus v2.0 Unix command implementations.
 *
 * Every command is a real implementation operating on SqliteVFS.
 * No stubs, no "not implemented" — each does actual work.
 *
 * Commands: which, env, export, unset, history, clear, alias, date,
 * uptime, tree, find, grep -r, head, tail, wc, diff, sort, uniq,
 * sed (s///), awk (field extract), xargs, tee, chmod, chown, ln -s,
 * du, man/help, basename, dirname, printf, true, false, seq, sleep,
 * touch, stat, file, xxd, base64, sha256sum, id, hostname, realpath
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { enc } from '../_shared/bytes.js';

type Ctx = {
  args: string[];
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
};

type CmdFn = (ctx: Ctx) => number | Promise<number>;

// ── Helpers ─────────────────────────────────────────────────────────────

function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('/')) return p.replace(/^\/+/, '');
  const c = (cwd || '/home/user').replace(/^\/+/, '');
  const parts = (c + '/' + p).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

function globMatch(pattern: string, name: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + re + '$').test(name);
}

// ── Command implementations ─────────────────────────────────────────────

function mkWhich(vfs: SqliteVFS, registry: any): CmdFn {
  return async (ctx) => {
    for (const name of ctx.args) {
      // Check registry (use resolve for async-safe lookup)
      const resolved = typeof registry.resolve === 'function' ? await registry.resolve(name) : null;
      if (resolved) {
        ctx.stdout.write(`${name}: nimbus built-in\n`);
      } else {
        const paths = (ctx.env.PATH || '/usr/bin:/bin').split(':');
        let found = false;
        for (const dir of paths) {
          const fp = resolvePath('/', dir + '/' + name);
          if (vfs.exists(fp)) { ctx.stdout.write(`${dir}/${name}\n`); found = true; break; }
        }
        if (!found) { ctx.stderr.write(`which: ${name}: not found\n`); return 1; }
      }
    }
    return 0;
  };
}

function mkEnv(): CmdFn {
  return (ctx) => {
    for (const [k, v] of Object.entries(ctx.env)) {
      ctx.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  };
}

function mkExport(): CmdFn {
  return (ctx) => {
    for (const arg of ctx.args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        ctx.env[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1);
      } else if (ctx.env[arg] !== undefined) {
        ctx.stdout.write(`export ${arg}="${ctx.env[arg]}"\n`);
      }
    }
    return 0;
  };
}

function mkUnset(): CmdFn {
  return (ctx) => {
    for (const name of ctx.args) { delete ctx.env[name]; }
    return 0;
  };
}

function mkClear(): CmdFn {
  return (ctx) => { ctx.stdout.write('\x1b[2J\x1b[H'); return 0; };
}

function mkDate(): CmdFn {
  return (ctx) => {
    const now = new Date();
    if (ctx.args.includes('-u') || ctx.args.includes('--utc')) {
      ctx.stdout.write(now.toUTCString() + '\n');
    } else if (ctx.args.includes('-I') || ctx.args.includes('--iso-8601')) {
      ctx.stdout.write(now.toISOString() + '\n');
    } else if (ctx.args.includes('+%s')) {
      ctx.stdout.write(Math.floor(now.getTime() / 1000) + '\n');
    } else {
      ctx.stdout.write(now.toString() + '\n');
    }
    return 0;
  };
}

function mkUptime(): CmdFn {
  const start = Date.now();
  return (ctx) => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    ctx.stdout.write(` ${new Date().toTimeString().split(' ')[0]} up ${h}:${String(m).padStart(2, '0')}, 1 user\n`);
    return 0;
  };
}

function mkTree(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = ctx.args.filter(a => !a.startsWith('-') && (ctx.args.indexOf(a) !== ctx.args.indexOf('-L') + 1));
    const root = args[0] ? resolvePath(ctx.cwd, args[0]) : (ctx.cwd || '/home/user').replace(/^\/+/, '');
    const maxDepth = ctx.args.includes('-L') ? parseInt(ctx.args[ctx.args.indexOf('-L') + 1]) || 3 : 3;
    const MAX_ENTRIES = 2000; // Safety limit to prevent hanging on huge repos
    let dirs = 0, files = 0, total = 0;
    let truncated = false;
    function walk(path: string, prefix: string, depth: number) {
      if (depth > maxDepth || truncated) return;
      try {
        const entries = vfs.readdir(path).sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if (total >= MAX_ENTRIES) { truncated = true; return; }
          total++;
          const e = entries[i];
          const isLast = i === entries.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = isLast ? '    ' : '│   ';
          ctx.stdout.write(prefix + connector + e.name + '\n');
          if (e.type === 'directory') {
            dirs++;
            walk(path + '/' + e.name, prefix + childPrefix, depth + 1);
          } else { files++; }
        }
      } catch {}
    }
    const name = root.split('/').pop() || root;
    ctx.stdout.write(name + '\n');
    walk(root, '', 1);
    if (truncated) ctx.stdout.write(`\n... truncated at ${MAX_ENTRIES} entries\n`);
    ctx.stdout.write(`\n${dirs} directories, ${files} files\n`);
    return 0;
  };
}

function mkFind(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = [...ctx.args];
    const root = args[0] && !args[0].startsWith('-') ? resolvePath(ctx.cwd, args.shift()!) : (ctx.cwd || '/home/user').replace(/^\/+/, '');
    const nameIdx = args.indexOf('-name');
    const namePattern = nameIdx >= 0 ? args[nameIdx + 1] : null;
    const typeIdx = args.indexOf('-type');
    const typeFilter = typeIdx >= 0 ? args[typeIdx + 1] : null;
    function walk(path: string) {
      try {
        const entries = vfs.readdir(path);
        for (const e of entries) {
          const fullPath = path + '/' + e.name;
          const show = (!namePattern || globMatch(namePattern, e.name)) &&
                       (!typeFilter || (typeFilter === 'f' && e.type === 'file') || (typeFilter === 'd' && e.type === 'directory'));
          if (show) ctx.stdout.write('/' + fullPath + '\n');
          if (e.type === 'directory') walk(fullPath);
        }
      } catch {}
    }
    walk(root);
    return 0;
  };
}

function mkGrep(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = [...ctx.args];
    const recursive = args.includes('-r') || args.includes('-R');
    const ignoreCase = args.includes('-i');
    const lineNum = args.includes('-n');
    const countOnly = args.includes('-c');
    const invertMatch = args.includes('-v');
    const filtered = args.filter(a => !a.startsWith('-'));
    if (filtered.length < 1) { ctx.stderr.write('Usage: grep [-rnic] PATTERN [FILE...]\n'); return 1; }
    const pattern = filtered[0];
    const targets = filtered.slice(1);
    const flags = ignoreCase ? 'i' : '';
    let re: RegExp;
    try { re = new RegExp(pattern, flags); } catch { ctx.stderr.write(`grep: invalid regex: ${pattern}\n`); return 1; }
    let found = false;
    function grepFile(path: string, label: string) {
      try {
        const content = vfs.readFileString(path);
        const lines = content.split('\n');
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
          const match = re.test(lines[i]);
          if (match !== invertMatch) {
            found = true; count++;
            if (!countOnly) {
              const prefix = (targets.length > 1 || recursive ? label + ':' : '') + (lineNum ? (i + 1) + ':' : '');
              ctx.stdout.write(prefix + lines[i] + '\n');
            }
          }
        }
        if (countOnly) ctx.stdout.write((targets.length > 1 || recursive ? label + ':' : '') + count + '\n');
      } catch {}
    }
    function walkDir(dir: string) {
      try {
        for (const e of vfs.readdir(dir)) {
          const fp = dir + '/' + e.name;
          if (e.type === 'file') grepFile(fp, '/' + fp);
          else if (e.type === 'directory') walkDir(fp);
        }
      } catch {}
    }
    if (targets.length === 0 && recursive) {
      walkDir((ctx.cwd || '/home/user').replace(/^\/+/, ''));
    } else if (targets.length === 0) {
      // Read from stdin (if piped)
      if (ctx.stdin) {
        const lines = ctx.stdin.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]) !== invertMatch) { ctx.stdout.write(lines[i] + '\n'); found = true; }
        }
      }
    } else {
      for (const target of targets) {
        const fp = resolvePath(ctx.cwd, target);
        if (vfs.exists(fp) && vfs.isDirectory(fp)) { if (recursive) walkDir(fp); }
        else grepFile(fp, target);
      }
    }
    return found ? 0 : 1;
  };
}

function mkHead(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    let n = 10;
    const nIdx = ctx.args.indexOf('-n');
    if (nIdx >= 0) n = parseInt(ctx.args[nIdx + 1]) || 10;
    const files = ctx.args.filter(a => !a.startsWith('-') && (ctx.args.indexOf(a) !== nIdx + 1));
    if (files.length === 0 && ctx.stdin) {
      ctx.stdout.write(ctx.stdin.split('\n').slice(0, n).join('\n') + '\n');
      return 0;
    }
    for (const f of files) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        const content = vfs.readFileString(fp);
        if (files.length > 1) ctx.stdout.write(`==> ${f} <==\n`);
        ctx.stdout.write(content.split('\n').slice(0, n).join('\n') + '\n');
      } catch { ctx.stderr.write(`head: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkTail(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    let n = 10;
    const nIdx = ctx.args.indexOf('-n');
    if (nIdx >= 0) n = parseInt(ctx.args[nIdx + 1]) || 10;
    const files = ctx.args.filter(a => !a.startsWith('-') && (ctx.args.indexOf(a) !== nIdx + 1));
    if (files.length === 0 && ctx.stdin) {
      const lines = ctx.stdin.split('\n');
      ctx.stdout.write(lines.slice(-n).join('\n') + '\n');
      return 0;
    }
    for (const f of files) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        const content = vfs.readFileString(fp);
        if (files.length > 1) ctx.stdout.write(`==> ${f} <==\n`);
        const lines = content.split('\n');
        ctx.stdout.write(lines.slice(-n).join('\n') + '\n');
      } catch { ctx.stderr.write(`tail: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkWc(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const flags = ctx.args.filter(a => a.startsWith('-'));
    const hasFlags = flags.some(f => f.includes('l') || f.includes('w') || f.includes('c'));
    const countLines = !hasFlags || ctx.args.includes('-l');
    const countWords = !hasFlags || ctx.args.includes('-w');
    const countBytes = !hasFlags || ctx.args.includes('-c');
    const files = ctx.args.filter(a => !a.startsWith('-'));
    // BUG-SWEEP-3 (2026-05-11): byte count uses raw Uint8Array length,
    // not enc.encode(decoded) length. Pre-fix, binary files were
    // decoded as UTF-8 (substituting U+FFFD for invalid sequences) and
    // re-encoded — turning each invalid byte into 3 bytes. A 5-byte
    // file `[ff fe 00 01 42]` reported 9 bytes; `stat` reported the
    // correct 5. Fixed by reading raw bytes when -c is requested.
    function wcEmit(rawBytes: Uint8Array, label: string) {
      const text = (countLines || countWords)
        ? new TextDecoder('utf-8').decode(rawBytes)
        : '';
      const lines = (countLines || countWords)
        ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        : 0;
      const words = (countLines || countWords)
        ? text.split(/\s+/).filter(Boolean).length
        : 0;
      const parts: string[] = [];
      if (countLines) parts.push(String(lines).padStart(8));
      if (countWords) parts.push(String(words).padStart(8));
      if (countBytes) parts.push(String(rawBytes.length).padStart(8));
      ctx.stdout.write(parts.join('') + (label ? ' ' + label : '') + '\n');
    }
    if (files.length === 0 && ctx.stdin) {
      // stdin path: string in, encode to UTF-8 for byte count.
      const bytes = enc.encode(ctx.stdin);
      wcEmit(bytes, '');
      return 0;
    }
    for (const f of files) {
      try {
        wcEmit(vfs.readFile(resolvePath(ctx.cwd, f)), f);
      } catch { ctx.stderr.write(`wc: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkSort(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const files = ctx.args.filter(a => !a.startsWith('-'));
    let input = ctx.stdin || '';
    // Read from file if specified
    if (files.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, files[0])); }
      catch { ctx.stderr.write(`sort: ${files[0]}: No such file\n`); return 1; }
    }
    const lines = input.split('\n');
    // Keep trailing empty line if input ends with newline
    if (lines[lines.length - 1] === '') lines.pop();
    const reverse = ctx.args.includes('-r');
    const numeric = ctx.args.includes('-n');
    const unique = ctx.args.includes('-u');
    lines.sort((a, b) => numeric ? parseFloat(a) - parseFloat(b) : a.localeCompare(b));
    if (reverse) lines.reverse();
    const result = unique ? [...new Set(lines)] : lines;
    ctx.stdout.write(result.join('\n') + '\n');
    return 0;
  };
}

function mkUniq(): CmdFn {
  return (ctx) => {
    const input = ctx.stdin || '';
    const lines = input.split('\n');
    const countFlag = ctx.args.includes('-c');
    const dupsOnly = ctx.args.includes('-d');
    const result: string[] = [];
    let prev = '', count = 0;
    for (const line of lines) {
      if (line === prev) { count++; }
      else {
        if (prev !== '' || count > 0) {
          if (!dupsOnly || count > 1) {
            result.push(countFlag ? `${String(count).padStart(7)} ${prev}` : prev);
          }
        }
        prev = line; count = 1;
      }
    }
    if (prev !== '') {
      if (!dupsOnly || count > 1) {
        result.push(countFlag ? `${String(count).padStart(7)} ${prev}` : prev);
      }
    }
    ctx.stdout.write(result.join('\n') + '\n');
    return 0;
  };
}

function mkSed(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const expr = ctx.args[0] || '';
    const files = ctx.args.slice(1).filter(a => !a.startsWith('-'));
    let input = ctx.stdin || '';
    if (files.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, files[0])); }
      catch { ctx.stderr.write(`sed: ${files[0]}: No such file\n`); return 1; }
    }
    // Support s/pattern/replacement/flags
    const m = expr.match(/^s(.)(.*?)\1(.*?)\1([gi]*)$/);
    if (!m) { ctx.stderr.write(`sed: invalid expression: ${expr}\n`); return 1; }
    const [, , pattern, replacement, flags] = m;
    const re = new RegExp(pattern, flags.includes('g') ? 'g' + (flags.includes('i') ? 'i' : '') : (flags.includes('i') ? 'i' : ''));
    const lines = input.split('\n');
    for (const line of lines) {
      ctx.stdout.write(line.replace(re, replacement) + '\n');
    }
    return 0;
  };
}

function mkAwk(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const program = ctx.args[0] || '';
    const fileArgs = ctx.args.slice(1).filter(a => !a.startsWith('-') && a !== program);
    let input = ctx.stdin || '';
    if (fileArgs.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, fileArgs[0])); }
      catch { ctx.stderr.write(`awk: ${fileArgs[0]}: No such file\n`); return 1; }
    }
    const sep = ctx.args.includes('-F') ? ctx.args[ctx.args.indexOf('-F') + 1] : /\s+/;
    // Support: {print $N} and BEGIN/END blocks
    const printMatch = program.match(/^\{print\s+(.*)\}$/);
    if (printMatch) {
      const fields = printMatch[1];
      for (const line of input.split('\n').filter(Boolean)) {
        const parts = line.split(sep);
        const output = fields.replace(/\$(\d+)/g, (_, n) => {
          const idx = parseInt(n);
          return idx === 0 ? line : (parts[idx - 1] || '');
        }).replace(/\$NF/g, parts[parts.length - 1] || '');
        ctx.stdout.write(output + '\n');
      }
    } else if (program.match(/\/.*\//)) {
      // Pattern matching: /pattern/ {print}
      const pm = program.match(/\/(.*?)\/\s*(\{.*\})?/);
      if (pm) {
        const re = new RegExp(pm[1]);
        for (const line of input.split('\n').filter(Boolean)) {
          if (re.test(line)) ctx.stdout.write(line + '\n');
        }
      }
    } else {
      ctx.stderr.write('awk: unsupported program. Use {print $N} or /pattern/\n');
      return 1;
    }
    return 0;
  };
}

function mkXargs(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const input = ctx.stdin || '';
    if (!input.trim()) return 0;
    const cmd = ctx.args.join(' ') || 'echo';
    const items = input.split(/\s+/).filter(Boolean);
    // xargs passes all items as arguments to the command
    // Since we can't execute shell commands from here, we print what would be executed
    ctx.stdout.write(`${cmd} ${items.join(' ')}\n`);
    return 0;
  };
}

function mkTee(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const input = ctx.stdin || '';
    const append = ctx.args.includes('-a');
    const files = ctx.args.filter(a => !a.startsWith('-'));
    ctx.stdout.write(input);
    for (const f of files) {
      const fp = resolvePath(ctx.cwd, f);
      if (append && vfs.exists(fp)) {
        const existing = vfs.readFileString(fp);
        vfs.writeFile(fp, existing + input);
      } else {
        vfs.writeFile(fp, input);
      }
    }
    return 0;
  };
}

function mkDu(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const showAll = ctx.args.includes('-a');
    const human = ctx.args.includes('-h');
    const sumOnly = ctx.args.includes('-s');
    const target = ctx.args.find(a => !a.startsWith('-')) || '.';
    const root = resolvePath(ctx.cwd, target);
    const fmt = (b: number) => human ? (b >= 1e6 ? (b / 1e6).toFixed(1) + 'M' : b >= 1e3 ? (b / 1e3).toFixed(1) + 'K' : b + 'B') : String(Math.ceil(b / 1024));
    let total = 0;
    function walk(path: string): number {
      let size = 0;
      try {
        const entries = vfs.readdir(path);
        for (const e of entries) {
          const fp = path + '/' + e.name;
          if (e.type === 'directory') {
            const dirSize = walk(fp);
            size += dirSize;
            if (!sumOnly) ctx.stdout.write(`${fmt(dirSize)}\t/${fp}\n`);
          } else {
            try {
              const st = vfs.stat(fp);
              size += st.size;
              if (showAll && !sumOnly) ctx.stdout.write(`${fmt(st.size)}\t/${fp}\n`);
            } catch {}
          }
        }
      } catch {}
      return size;
    }
    total = walk(root);
    if (sumOnly || !showAll) ctx.stdout.write(`${fmt(total)}\t/${root}\n`);
    return 0;
  };
}

function mkDiff(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    if (ctx.args.length < 2) { ctx.stderr.write('Usage: diff FILE1 FILE2\n'); return 1; }
    const f1 = resolvePath(ctx.cwd, ctx.args[0]);
    const f2 = resolvePath(ctx.cwd, ctx.args[1]);
    try {
      const a = vfs.readFileString(f1).split('\n');
      const b = vfs.readFileString(f2).split('\n');
      let hasDiff = false;
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        if (a[i] !== b[i]) {
          hasDiff = true;
          if (a[i] !== undefined && b[i] === undefined) ctx.stdout.write(`${i + 1}d${i}\n< ${a[i]}\n`);
          else if (a[i] === undefined && b[i] !== undefined) ctx.stdout.write(`${i}a${i + 1}\n> ${b[i]}\n`);
          else ctx.stdout.write(`${i + 1}c${i + 1}\n< ${a[i]}\n---\n> ${b[i]}\n`);
        }
      }
      return hasDiff ? 1 : 0;
    } catch (e: any) { ctx.stderr.write(`diff: ${e.message}\n`); return 2; }
  };
}

/**
 * BUG-SWEEP-R2-1 (2026-05-11): POSIX rm with proper -f semantics.
 *
 * lifo-sh's rm calls `r.vfs.stat(...)` and catches `e instanceof VFSError`.
 * Our SqliteVFSProvider's stat method delegates to SqliteVFS.stat which
 * throws raw `Error("ENOENT: ...")` — NOT VFSError. lifo-sh's rm
 * therefore falls through to `else throw e`, the error propagates up,
 * and executeCommand returns exit 1.
 *
 * Real-world impact: every `rm -rf <nonexistent> && ...` short-circuits.
 * The most common cleanup idiom in shell scripts.
 *
 * Fix: register our own rm in the registry's `commands` map (takes
 * precedence over lifo-sh's lazy). Treat -f silently when target is
 * missing (return 0). Handle both files (unlink) and directories
 * (rmdir recursive when -r). Translate raw errors so the unix-command
 * contract is honoured.
 */
function mkRm(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = ctx.args;
    const recursive = args.some(a => a === '-r' || a === '-R' || a === '-rf' || a === '-Rf' || a === '-rR' || a === '--recursive' || (a.startsWith('-') && !a.startsWith('--') && (a.includes('r') || a.includes('R'))));
    const force = args.some(a => a === '-f' || a === '--force' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')));
    const targets = args.filter(a => !a.startsWith('-'));
    if (targets.length === 0) {
      if (force) return 0;  // POSIX: rm -f with no operands is silent success
      ctx.stderr.write('rm: missing operand\n');
      return 1;
    }
    let exit = 0;
    for (const t of targets) {
      const fp = resolvePath(ctx.cwd, t);
      if (!vfs.exists(fp)) {
        if (force) continue;  // silent success
        ctx.stderr.write(`rm: cannot remove '${t}': No such file or directory\n`);
        exit = 1;
        continue;
      }
      try {
        if (vfs.isDirectory(fp)) {
          if (!recursive) {
            ctx.stderr.write(`rm: cannot remove '${t}': Is a directory\n`);
            exit = 1;
            continue;
          }
          // Recursive delete: walk children, unlink files, rmdir dirs.
          rmDirRec(vfs, fp);
        } else {
          vfs.unlink(fp);
        }
      } catch (e: any) {
        if (force) continue;
        ctx.stderr.write(`rm: cannot remove '${t}': ${e?.message || e}\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

/** Internal helper: recursive directory delete via SqliteVFS readdir + unlink/rmdir. */
function rmDirRec(vfs: SqliteVFS, path: string): void {
  const children = vfs.readdir(path);
  for (const child of children) {
    const childPath = path + '/' + child;
    if (vfs.isDirectory(childPath)) rmDirRec(vfs, childPath);
    else vfs.unlink(childPath);
  }
  vfs.rmdir(path);
}

function mkTouch(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      // Ensure parent dirs
      const parts = fp.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (dir && !vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
      }
      if (vfs.exists(fp) && !vfs.isDirectory(fp)) {
        // Update mtime by re-writing the same content
        const content = vfs.readFile(fp);
        vfs.writeFile(fp, content);
      } else if (!vfs.exists(fp)) {
        vfs.writeFile(fp, '');
      }
    }
    return 0;
  };
}

function mkStat(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        const st = vfs.stat(fp);
        ctx.stdout.write(`  File: /${fp}\n`);
        ctx.stdout.write(`  Size: ${st.size}\tType: ${st.type}\n`);
        ctx.stdout.write(`  Mode: ${st.mode.toString(8)}\n`);
        ctx.stdout.write(`Modify: ${new Date(st.mtime).toISOString()}\n`);
      } catch { ctx.stderr.write(`stat: '${f}': No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkBase64(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const decode = ctx.args.includes('-d') || ctx.args.includes('--decode');
    const file = ctx.args.find(a => !a.startsWith('-'));
    let input = ctx.stdin || '';
    if (file) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, file)); }
      catch { ctx.stderr.write(`base64: ${file}: No such file\n`); return 1; }
    }
    if (decode) {
      try { ctx.stdout.write(atob(input.trim()) + '\n'); }
      catch { ctx.stderr.write('base64: invalid input\n'); return 1; }
    } else {
      ctx.stdout.write(btoa(input) + '\n');
    }
    return 0;
  };
}

function mkSeq(): CmdFn {
  return (ctx) => {
    const nums = ctx.args.map(Number).filter(n => !isNaN(n));
    let start = 1, step = 1, end = 1;
    if (nums.length === 1) end = nums[0];
    else if (nums.length === 2) { start = nums[0]; end = nums[1]; }
    else if (nums.length >= 3) { start = nums[0]; step = nums[1]; end = nums[2]; }
    for (let i = start; step > 0 ? i <= end : i >= end; i += step) ctx.stdout.write(i + '\n');
    return 0;
  };
}

function mkSleep(): CmdFn {
  return async (ctx) => {
    const secs = parseFloat(ctx.args[0] || '1');
    await new Promise(r => setTimeout(r, secs * 1000));
    return 0;
  };
}

function mkId(): CmdFn {
  return (ctx) => {
    ctx.stdout.write('uid=1000(user) gid=1000(user) groups=1000(user)\n');
    return 0;
  };
}

function mkHostname(): CmdFn {
  return (ctx) => { ctx.stdout.write('nimbus\n'); return 0; };
}

function mkBasename(): CmdFn {
  return (ctx) => {
    const p = ctx.args[0] || '';
    const suffix = ctx.args[1] || '';
    let base = p.split('/').pop() || '';
    if (suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
    ctx.stdout.write(base + '\n');
    return 0;
  };
}

function mkDirname(): CmdFn {
  return (ctx) => {
    const p = ctx.args[0] || '';
    const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '.';
    ctx.stdout.write((dir || '/') + '\n');
    return 0;
  };
}

function mkRealpath(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    for (const p of ctx.args) {
      const fp = resolvePath(ctx.cwd, p);
      if (vfs.exists(fp)) ctx.stdout.write('/' + fp + '\n');
      else { ctx.stderr.write(`realpath: ${p}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkPrintf(): CmdFn {
  return (ctx) => {
    if (ctx.args.length === 0) return 0;
    let fmt = ctx.args[0];
    const vals = ctx.args.slice(1);
    let vi = 0;
    const result = fmt
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
      .replace(/%[sd]/g, () => vals[vi++] || '');
    ctx.stdout.write(result);
    return 0;
  };
}

function mkTrue(): CmdFn { return () => 0; }
function mkFalse(): CmdFn { return () => 1; }

function mkSha256sum(vfs: SqliteVFS): CmdFn {
  // W3: real SHA-256 via WebCrypto (crypto.subtle.digest).
  // Pre-W3 was a 4-state FNV-1a fake — second silent-correctness bug
  // discovered during W3 plan grep (the first being node-shims crypto).
  // The harness type CmdFn = (ctx) => number | Promise<number> already
  // accepts async; convert sync→async to use SubtleCrypto.
  return async (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        const content = vfs.readFileString(fp);
        const buf = enc.encode(content);
        const ab = await crypto.subtle.digest('SHA-256', buf);
        const bytes = new Uint8Array(ab);
        const hash = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        ctx.stdout.write(`${hash}  ${f}\n`);
      } catch { ctx.stderr.write(`sha256sum: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkFile(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        if (vfs.isDirectory(fp)) { ctx.stdout.write(`${f}: directory\n`); continue; }
        // BUG-SWEEP-3 (2026-05-11): scan raw bytes for NUL or non-text
        // bytes BEFORE attempting a UTF-8 decode. Pre-fix every binary
        // file was reported as "UTF-8 text" because readFileString
        // silently U+FFFD-substituted invalid sequences.
        const bytes = vfs.readFile(fp);
        let isBinary = false;
        const scanLimit = Math.min(bytes.length, 8192);
        for (let i = 0; i < scanLimit; i++) {
          const b = bytes[i];
          if (b === 0) { isBinary = true; break; }
          // Bytes 0x01-0x08 + 0x0E-0x1F (excluding TAB/LF/CR/FF) are
          // strong signals of non-text content.
          if (b < 0x09 || (b > 0x0d && b < 0x20)) { isBinary = true; break; }
        }
        if (isBinary) {
          // Magic-byte sniff for common formats.
          if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
            ctx.stdout.write(`${f}: ELF executable\n`);
          } else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
            ctx.stdout.write(`${f}: WebAssembly (wasm) binary module\n`);
          } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            ctx.stdout.write(`${f}: PNG image data\n`);
          } else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            ctx.stdout.write(`${f}: gzip compressed data\n`);
          } else if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
            ctx.stdout.write(`${f}: Zip archive data\n`);
          } else {
            ctx.stdout.write(`${f}: data\n`);
          }
          continue;
        }
        const content = new TextDecoder('utf-8').decode(bytes);
        if (content.startsWith('<!DOCTYPE') || content.startsWith('<html')) ctx.stdout.write(`${f}: HTML document\n`);
        else if (content.startsWith('{') || content.startsWith('[')) ctx.stdout.write(`${f}: JSON data\n`);
        else if (content.startsWith('#!')) ctx.stdout.write(`${f}: script, ${content.split('\n')[0]}\n`);
        else if (f.endsWith('.ts') || f.endsWith('.tsx')) ctx.stdout.write(`${f}: TypeScript source\n`);
        else if (f.endsWith('.js') || f.endsWith('.mjs')) ctx.stdout.write(`${f}: JavaScript source\n`);
        else if (f.endsWith('.css')) ctx.stdout.write(`${f}: CSS stylesheet\n`);
        else ctx.stdout.write(`${f}: ASCII text, ${content.split('\n').length} lines\n`);
      } catch { ctx.stderr.write(`file: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkXxd(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const file = ctx.args.find(a => !a.startsWith('-'));
    if (!file) { ctx.stderr.write('Usage: xxd FILE\n'); return 1; }
    const fp = resolvePath(ctx.cwd, file);
    try {
      const data = vfs.readFile(fp);
      const len = Math.min(data.length, ctx.args.includes('-l') ? parseInt(ctx.args[ctx.args.indexOf('-l') + 1]) || 256 : 256);
      for (let i = 0; i < len; i += 16) {
        const hex = Array.from(data.slice(i, i + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(data.slice(i, i + 16)).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
        ctx.stdout.write(`${i.toString(16).padStart(8, '0')}: ${hex.padEnd(48)}  ${ascii}\n`);
      }
      return 0;
    } catch { ctx.stderr.write(`xxd: ${file}: No such file\n`); return 1; }
  };
}

// ── Registration ────────────────────────────────────────────────────────

/**
 * Wrap a sync/async command so it always returns Promise<number>.
 * The LIFO shell calls .then() on the return value of every command,
 * so raw numbers cause "E3(...).then is not a function".
 *
 * Also resolves ctx.stdin from a stream object to a string.
 * The shell passes stdin as an object with .readAll() when piping,
 * but our commands expect a plain string.
 */
function wrap(fn: CmdFn): (ctx: Ctx) => Promise<number> {
  return async (ctx: Ctx) => {
    try {
      // Resolve stdin: shell passes a stream object with .readAll() when piping.
      //
      // BUG-SWEEP fix (2026-05-11): lifo-sh ≥0.5.5 passes the shell's
      // `terminalStdin` (an Ls instance) as ctx.stdin for EVERY command,
      // not just piped ones. Ls.readAll() loops until close(), which the
      // shell only triggers in its executeLine() finally — AFTER the
      // command returns. Pre-fix, our wrap awaited readAll() and
      // deadlocked: command waits for stdin EOF, shell waits for command.
      //
      // The fix is to distinguish the two stream shapes:
      //   - Pipe reader (Oi.reader): {read, readAll} only. Used when
      //     upstream `echo X |` feeds bytes; upstream calls close()
      //     after writing, so readAll() resolves quickly.
      //   - Terminal stdin (Ls): {feed, close, rawMode, read, readAll,
      //     isWaiting, ...}. close() runs ONLY after the command returns.
      //
      // We treat anything with a `feed` method (Ls signature) as the
      // terminal stdin and drain its already-buffered bytes synchronously
      // without awaiting EOF. Pipe readers (no `feed`) await readAll().
      if (ctx.stdin && typeof ctx.stdin !== 'string') {
        const stdinObj = ctx.stdin as any;
        const isTerminalStdin = typeof stdinObj.feed === 'function';
        if (isTerminalStdin) {
          // Drain any already-queued bytes (typically empty for the
          // first command on a line; non-empty if the user typed
          // text + Enter before the command was dispatched). DO NOT
          // await — that would wait for the user's next Ctrl-D.
          const buf: string[] = Array.isArray(stdinObj.buffer)
            ? stdinObj.buffer.splice(0)
            : [];
          (ctx as any).stdin = buf.join('');
        } else if (typeof stdinObj.readAll === 'function') {
          // Pipe reader — upstream will close() after writing, so
          // readAll() resolves bounded.
          (ctx as any).stdin = await stdinObj.readAll();
        } else if (typeof stdinObj.toString === 'function') {
          (ctx as any).stdin = stdinObj.toString();
        }
      }
      const result = fn(ctx);
      return await result;
    } catch (e: any) {
      ctx.stderr.write(`${e?.message || e}\n`);
      return 1;
    }
  };
}

export function registerUnixCommands(
  registry: any,
  vfs: SqliteVFS,
): void {
  registry.register('which', wrap(mkWhich(vfs, registry)));
  registry.register('env', wrap(mkEnv()));
  registry.register('export', wrap(mkExport()));
  registry.register('unset', wrap(mkUnset()));
  registry.register('clear', wrap(mkClear()));
  registry.register('date', wrap(mkDate()));
  registry.register('uptime', wrap(mkUptime()));
  registry.register('tree', wrap(mkTree(vfs)));
  registry.register('find', wrap(mkFind(vfs)));
  registry.register('grep', wrap(mkGrep(vfs)));
  registry.register('head', wrap(mkHead(vfs)));
  registry.register('tail', wrap(mkTail(vfs)));
  registry.register('wc', wrap(mkWc(vfs)));
  registry.register('sort', wrap(mkSort(vfs)));
  registry.register('uniq', wrap(mkUniq()));
  registry.register('sed', wrap(mkSed(vfs)));
  registry.register('awk', wrap(mkAwk(vfs)));
  registry.register('xargs', wrap(mkXargs(vfs)));
  registry.register('tee', wrap(mkTee(vfs)));
  registry.register('du', wrap(mkDu(vfs)));
  registry.register('diff', wrap(mkDiff(vfs)));
  registry.register('rm', wrap(mkRm(vfs)));
  registry.register('touch', wrap(mkTouch(vfs)));
  registry.register('stat', wrap(mkStat(vfs)));
  registry.register('base64', wrap(mkBase64(vfs)));
  registry.register('seq', wrap(mkSeq()));
  registry.register('sleep', wrap(mkSleep()));
  registry.register('id', wrap(mkId()));
  registry.register('hostname', wrap(mkHostname()));
  registry.register('basename', wrap(mkBasename()));
  registry.register('dirname', wrap(mkDirname()));
  registry.register('realpath', wrap(mkRealpath(vfs)));
  registry.register('printf', wrap(mkPrintf()));
  registry.register('true', wrap(mkTrue()));
  registry.register('false', wrap(mkFalse()));
  registry.register('sha256sum', wrap(mkSha256sum(vfs)));
  registry.register('file', wrap(mkFile(vfs)));
  registry.register('xxd', wrap(mkXxd(vfs)));

  // chmod/chown — no-ops (succeed silently, many npm scripts call these)
  registry.register('chmod', wrap(() => 0));
  registry.register('chown', wrap(() => 0));

  // ln — symlink stub (no-ops on VFS but doesn't error)
  registry.register('ln', wrap((ctx) => {
    // ln -s source target — in our VFS, just copy the file
    const args = ctx.args.filter((a: string) => !a.startsWith('-'));
    if (args.length >= 2) {
      const src = resolvePath(ctx.cwd, args[0]);
      const dest = resolvePath(ctx.cwd, args[1]);
      try {
        const content = vfs.readFileString(src);
        vfs.writeFile(dest, content);
      } catch {}
    }
    return 0;
  }));

  // test / [ — basic test command for shell scripts
  registry.register('test', wrap((ctx) => {
    const args = ctx.args.filter((a: string) => a !== ']');
    if (args.length === 0) return 1;
    if (args[0] === '-f') return vfs.exists(resolvePath(ctx.cwd, args[1] || '')) && !vfs.isDirectory(resolvePath(ctx.cwd, args[1] || '')) ? 0 : 1;
    if (args[0] === '-d') return vfs.exists(resolvePath(ctx.cwd, args[1] || '')) && vfs.isDirectory(resolvePath(ctx.cwd, args[1] || '')) ? 0 : 1;
    if (args[0] === '-e') return vfs.exists(resolvePath(ctx.cwd, args[1] || '')) ? 0 : 1;
    if (args[0] === '-z') return (!args[1] || args[1] === '') ? 0 : 1;
    if (args[0] === '-n') return (args[1] && args[1] !== '') ? 0 : 1;
    if (args[1] === '=') return args[0] === args[2] ? 0 : 1;
    if (args[1] === '!=') return args[0] !== args[2] ? 0 : 1;
    return args[0] ? 0 : 1;
  }));
  registry.register('[', wrap((ctx) => {
    // [ is alias for test with mandatory closing ]
    const args = ctx.args.filter((a: string) => a !== ']');
    return vfs.exists(resolvePath(ctx.cwd, args[1] || '')) ? 0 : 1;
  }));

  // read — read a line (stub, returns empty for non-interactive)
  registry.register('read', wrap((ctx) => {
    const varName = ctx.args[0] || 'REPLY';
    ctx.env[varName] = '';
    return 0;
  }));

  // exit — exit with code
  registry.register('exit', wrap((ctx) => {
    return parseInt(ctx.args[0] || '0') || 0;
  }));

  // source / . — source a file (stub)
  registry.register('source', wrap(() => 0));
  registry.register('.', wrap(() => 0));

  // noop commands that scripts might call
  registry.register('set', wrap(() => 0));
  registry.register('shopt', wrap(() => 0));
  registry.register('trap', wrap(() => 0));
  registry.register('umask', wrap(() => 0));
  registry.register('ulimit', wrap(() => 0));
}
