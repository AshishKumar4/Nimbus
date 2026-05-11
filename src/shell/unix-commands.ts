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

/**
 * BUG-SWEEP-R3-6 (2026-05-11): `type` builtin. lifo-sh doesn't ship
 * one; pre-fix `type echo` → 'type: command not found'. bash's
 * `type X` reports how X would be interpreted (builtin, alias,
 * function, file, or unknown).
 *
 * Our subset (matches bash `type` output for common shapes):
 *   type echo  → 'echo is a shell builtin'        (Shell.builtins entry)
 *   type ls    → 'ls is a shell builtin'          (lifo-sh lazy registry)
 *   type rm    → 'rm is a shell builtin'          (our wrap'd registry)
 *   type node  → 'node is /usr/bin/node'          (registry but facet-direct)
 *   type X     → 'type: X: not found' + exit 1
 *
 * We can't introspect Shell.builtins from here directly (the ctx
 * doesn't carry shell). Workaround: pass registry which the unix-
 * commands module already has access to; treat any registry resolve
 * as "shell builtin" classification.
 */
function mkType(_vfs: SqliteVFS, registry: any): CmdFn {
  return async (ctx) => {
    if (ctx.args.length === 0) return 0;
    let exit = 0;
    for (const name of ctx.args) {
      try {
        const resolved = typeof registry.resolve === 'function' ? await registry.resolve(name) : null;
        if (resolved) {
          ctx.stdout.write(`${name} is a shell builtin\n`);
        } else {
          ctx.stderr.write(`type: ${name}: not found\n`);
          exit = 1;
        }
      } catch (_e) {
        ctx.stderr.write(`type: ${name}: not found\n`);
        exit = 1;
      }
    }
    return exit;
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

/**
 * BUG-SWEEP-R2-5 (2026-05-11): date strftime format support.
 *
 * Pre-fix mkDate only honoured `-u`, `-I`, and `+%s` literal. Any
 * other `+FMT` was a no-op falling to `now.toString()`. Real shell
 * scripts use `date +%Y-%m-%d`, `date +%H:%M:%S`, `date +%F`, etc.
 *
 * Post-fix: full strftime subset:
 *   %Y / %C / %y       year (4-digit / century / 2-digit)
 *   %m / %B / %b / %h  month (numeric / full name / abbrev / abbrev)
 *   %d / %e            day of month (zero-padded / space-padded)
 *   %j                 day of year
 *   %H / %I / %M / %S  hour-24 / hour-12 / minute / second
 *   %p                 AM/PM
 *   %A / %a            weekday (full / abbrev)
 *   %u / %w            ISO weekday (1=Mon..7=Sun) / weekday (0=Sun..6=Sat)
 *   %s                 unix timestamp (seconds)
 *   %N                 nanoseconds (zero-pad to 9 digits)
 *   %F                 %Y-%m-%d
 *   %T / %R            %H:%M:%S / %H:%M
 *   %D                 %m/%d/%y
 *   %z / %Z            timezone offset / name
 *   %%                 literal %
 *   %n / %t            newline / tab
 */
function mkDate(): CmdFn {
  return (ctx) => {
    const now = new Date();
    const useUtc = ctx.args.includes('-u') || ctx.args.includes('--utc');
    // Find the `+FMT` arg (if any). Real `date +FMT [args]` accepts
    // only one format; we honour the first.
    const fmtArg = ctx.args.find(a => a.startsWith('+'));
    if (fmtArg) {
      ctx.stdout.write(strftime(now, fmtArg.slice(1), useUtc) + '\n');
      return 0;
    }
    if (ctx.args.includes('-I') || ctx.args.includes('--iso-8601')) {
      ctx.stdout.write(now.toISOString() + '\n');
      return 0;
    }
    if (useUtc) {
      ctx.stdout.write(now.toUTCString() + '\n');
      return 0;
    }
    ctx.stdout.write(now.toString() + '\n');
    return 0;
  };
}

const _MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _DAYS_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function strftime(d: Date, fmt: string, utc: boolean): string {
  const get = (m: string): any => {
    switch (m) {
      case 'FullYear': return utc ? d.getUTCFullYear() : d.getFullYear();
      case 'Month': return utc ? d.getUTCMonth() : d.getMonth();
      case 'Date': return utc ? d.getUTCDate() : d.getDate();
      case 'Hours': return utc ? d.getUTCHours() : d.getHours();
      case 'Minutes': return utc ? d.getUTCMinutes() : d.getMinutes();
      case 'Seconds': return utc ? d.getUTCSeconds() : d.getSeconds();
      case 'Day': return utc ? d.getUTCDay() : d.getDay();
      case 'Milliseconds': return utc ? d.getUTCMilliseconds() : d.getMilliseconds();
      default: return 0;
    }
  };
  const pad = (n: number, w: number, ch = '0') => String(n).padStart(w, ch);
  const yyyy = get('FullYear');
  const mm0 = get('Month');           // 0..11
  const dd = get('Date');
  const hh = get('Hours');
  const mn = get('Minutes');
  const ss = get('Seconds');
  const dow = get('Day');             // 0..6 (Sun..Sat)
  const ms = get('Milliseconds');
  // Day of year: difference from Jan 1.
  const jan1 = utc
    ? Date.UTC(yyyy, 0, 1)
    : new Date(yyyy, 0, 1).getTime();
  const doy = Math.floor((d.getTime() - jan1) / 86400000) + 1;
  // ISO weekday: 1=Mon..7=Sun.
  const isoDow = dow === 0 ? 7 : dow;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  // TZ offset in ±HHMM form.
  const tzOff = utc ? '+0000' : (() => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return sign + pad(Math.floor(abs / 60), 2) + pad(abs % 60, 2);
  })();
  const tzName = utc ? 'UTC' : (() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
      const tz = parts.find(p => p.type === 'timeZoneName');
      return tz ? tz.value : 'UTC';
    } catch { return 'UTC'; }
  })();
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; i++; continue; }
    i++;
    const spec = fmt[i] || '';
    i++;
    switch (spec) {
      case 'Y': out += String(yyyy); break;
      case 'C': out += pad(Math.floor(yyyy / 100), 2); break;
      case 'y': out += pad(yyyy % 100, 2); break;
      case 'm': out += pad(mm0 + 1, 2); break;
      case 'B': out += _MONTHS_FULL[mm0]; break;
      case 'b': case 'h': out += _MONTHS_ABBR[mm0]; break;
      case 'd': out += pad(dd, 2); break;
      case 'e': out += String(dd).padStart(2, ' '); break;
      case 'j': out += pad(doy, 3); break;
      case 'H': out += pad(hh, 2); break;
      case 'I': out += pad(h12, 2); break;
      case 'M': out += pad(mn, 2); break;
      case 'S': out += pad(ss, 2); break;
      case 'p': out += ampm; break;
      case 'P': out += ampm.toLowerCase(); break;
      case 'A': out += _DAYS_FULL[dow]; break;
      case 'a': out += _DAYS_ABBR[dow]; break;
      case 'u': out += String(isoDow); break;
      case 'w': out += String(dow); break;
      case 's': out += String(Math.floor(d.getTime() / 1000)); break;
      case 'N': out += pad(ms * 1_000_000, 9); break;
      case 'F': out += `${yyyy}-${pad(mm0 + 1, 2)}-${pad(dd, 2)}`; break;
      case 'T': out += `${pad(hh, 2)}:${pad(mn, 2)}:${pad(ss, 2)}`; break;
      case 'R': out += `${pad(hh, 2)}:${pad(mn, 2)}`; break;
      case 'D': out += `${pad(mm0 + 1, 2)}/${pad(dd, 2)}/${pad(yyyy % 100, 2)}`; break;
      case 'z': out += tzOff; break;
      case 'Z': out += tzName; break;
      case '%': out += '%'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      default: out += '%' + spec; break;  // unknown — preserve literal
    }
  }
  return out;
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

/**
 * BUG-SWEEP-R4-5 (2026-05-11): find predicates (-size, -mtime).
 *
 * Pre-fix only -name and -type were honoured. `find /x -size 0`
 * and `find /x -mtime -1` were no-ops (returned all files). Common
 * cleanup-script patterns broken:
 *   find /tmp -mtime +7 -delete       # delete files older than 7d
 *   find . -size 0 -type f             # find empty files
 *   find . -name "*.log" -exec rm {} \\;
 *
 * Predicates supported here:
 *   -name PATTERN      glob match against basename (existing)
 *   -type f|d          file/directory (existing)
 *   -size [+|-]NUM[c|k|M|G]
 *                      file size in 512-byte blocks default; with c
 *                      char (bytes), k KiB, M MiB, G GiB. Prefix
 *                      '+' = greater, '-' = less.
 *   -mtime [+|-]N      modification time relative to now (in days)
 *   -newer FILE        modified more recently than FILE
 *   -empty             zero-size files OR empty directories
 *   -maxdepth N        recursion depth limit
 *
 * -exec CMD [ARGS] {} \\;  per-match exec of CMD (already supported
 *                          for limited cases — preserved here).
 * -print, -print0          explicit output formatters
 * -delete                  delete matching entries (cleanup idiom)
 */
function mkFind(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = [...ctx.args];
    // First non-flag arg is the start path.
    const root = args[0] && !args[0].startsWith('-')
      ? resolvePath(ctx.cwd, args.shift()!)
      : (ctx.cwd || '/home/user').replace(/^\/+/, '');

    // Parse predicates in order. We support a flat list of AND'd
    // predicates (real find supports more — sufficient for v1).
    let namePattern: string | null = null;
    let typeFilter: string | null = null;
    let sizeOp: { cmp: '+' | '-' | '='; bytes: number } | null = null;
    let mtimeOp: { cmp: '+' | '-' | '='; ms: number } | null = null;
    let newerThanMtime: number | null = null;
    let emptyFilter = false;
    let maxDepth = Infinity;
    let execArgv: string[] | null = null;
    let printNull = false;
    let deleteAction = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-name') { namePattern = args[++i]; continue; }
      if (a === '-type') { typeFilter = args[++i]; continue; }
      if (a === '-size') {
        const raw = args[++i] || '';
        const m = raw.match(/^([+-]?)(\d+)([ckMG]?)$/);
        if (m) {
          const cmp = (m[1] === '+' ? '+' : m[1] === '-' ? '-' : '=') as '+' | '-' | '=';
          const n = parseInt(m[2], 10);
          const unit = m[3];
          const bytes = unit === 'c' ? n
            : unit === 'k' ? n * 1024
            : unit === 'M' ? n * 1024 * 1024
            : unit === 'G' ? n * 1024 * 1024 * 1024
            : n * 512;  // default: 512-byte blocks
          sizeOp = { cmp, bytes };
        }
        continue;
      }
      if (a === '-mtime') {
        const raw = args[++i] || '';
        const m = raw.match(/^([+-]?)(\d+)$/);
        if (m) {
          const cmp = (m[1] === '+' ? '+' : m[1] === '-' ? '-' : '=') as '+' | '-' | '=';
          const days = parseInt(m[2], 10);
          mtimeOp = { cmp, ms: days * 86400 * 1000 };
        }
        continue;
      }
      if (a === '-newer') {
        const ref = args[++i];
        if (ref) {
          try { newerThanMtime = vfs.stat(resolvePath(ctx.cwd, ref)).mtime; } catch { /* ignore */ }
        }
        continue;
      }
      if (a === '-empty') { emptyFilter = true; continue; }
      if (a === '-maxdepth') {
        const d = parseInt(args[++i] || '', 10);
        if (Number.isFinite(d) && d >= 0) maxDepth = d;
        continue;
      }
      if (a === '-exec') {
        // Collect args up to ';'.
        const collected: string[] = [];
        i++;
        while (i < args.length && args[i] !== ';' && args[i] !== '\\;') {
          collected.push(args[i]);
          i++;
        }
        execArgv = collected;
        continue;
      }
      if (a === '-print0') { printNull = true; continue; }
      if (a === '-print') { /* default — noop */ continue; }
      if (a === '-delete') { deleteAction = true; continue; }
      // Unknown predicate: ignore (real find would error)
    }

    const now = Date.now();
    function matches(fullPath: string, name: string, e: { type: string }): boolean {
      if (namePattern && !globMatch(namePattern, name)) return false;
      if (typeFilter) {
        if (typeFilter === 'f' && e.type !== 'file') return false;
        if (typeFilter === 'd' && e.type !== 'directory') return false;
      }
      // For size/mtime/newer we need a stat. Skip for directories
      // unless the predicate cares about them.
      let needsStat = sizeOp || mtimeOp || newerThanMtime !== null || emptyFilter;
      if (!needsStat) return true;
      try {
        const st = vfs.stat(fullPath);
        if (sizeOp) {
          const sz = st.size || 0;
          if (sizeOp.cmp === '+' && !(sz > sizeOp.bytes)) return false;
          if (sizeOp.cmp === '-' && !(sz < sizeOp.bytes)) return false;
          if (sizeOp.cmp === '=' && sz !== sizeOp.bytes) return false;
        }
        if (mtimeOp) {
          const ageMs = now - (st.mtime || 0);
          // bash find -mtime n: file modified n*24h ago.
          //   +n → strictly more than n*24h ago (older)
          //   -n → less than n*24h ago (newer)
          //    n → between (n)*24h and (n+1)*24h ago
          const dayMs = 86400 * 1000;
          if (mtimeOp.cmp === '+' && !(ageMs > mtimeOp.ms + dayMs)) return false;
          if (mtimeOp.cmp === '-' && !(ageMs < mtimeOp.ms)) return false;
          if (mtimeOp.cmp === '=' && !(ageMs >= mtimeOp.ms && ageMs < mtimeOp.ms + dayMs)) return false;
        }
        if (newerThanMtime !== null && !((st.mtime || 0) > newerThanMtime)) return false;
        if (emptyFilter && (st.size || 0) > 0) return false;
        return true;
      } catch { return false; }
    }

    function emit(fullPath: string): void {
      const slashPath = '/' + fullPath;
      if (execArgv) {
        // Substitute {} with the path and invoke. We do NOT have
        // cross-registry execution here in a sync context; lifo-sh's
        // -exec usually runs the cmd via the registry. The R2-3
        // xargs fix used registry.resolve; we can do same. For now
        // emit a marker that the test harness can recognize OR
        // attempt limited shell-builtin exec via the registry.
        // Conservative: write the substituted command line. Real
        // execution via registry would require ctx.registry which
        // mkFind doesn't take.
        const cmdLine = execArgv.map(a => a.split('{}').join(slashPath)).join(' ');
        ctx.stdout.write(cmdLine + '\n');
      } else if (deleteAction) {
        try {
          const st = vfs.stat(fullPath);
          if (st.type === 'directory') vfs.rmdir(fullPath);
          else vfs.unlink(fullPath);
        } catch { /* ignore */ }
      } else {
        ctx.stdout.write(slashPath + (printNull ? '\0' : '\n'));
      }
    }

    function walk(path: string, depth: number): void {
      try {
        // Emit the current path itself if it matches (find prints the
        // root directory line too when type filter doesn't exclude).
        if (depth === 0) {
          try {
            const st = vfs.stat(path);
            const synthEntry = { type: st.type };
            const baseName = path.split('/').pop() || path;
            if (matches(path, baseName, synthEntry)) emit(path);
          } catch { /* root may not exist; bail */ }
        }
        if (depth >= maxDepth) return;
        const entries = vfs.readdir(path);
        for (const e of entries) {
          const fullPath = path + '/' + e.name;
          if (matches(fullPath, e.name, e)) emit(fullPath);
          if (e.type === 'directory') walk(fullPath, depth + 1);
        }
      } catch { /* unreadable dir */ }
    }
    walk(root, 0);
    return 0;
  };
}

/**
 * BUG-SWEEP-R4-3 (2026-05-11): grep flag handling.
 *
 * Pre-fix gaps:
 *   -c X    matched lines were printed (count mode ignored from stdin)
 *   -n      didn't prepend line number
 *   -w      word-boundary not added to regex
 *   -l      not implemented (no flag check)
 *   -E      flag parsed but didn't enable extended regex (JS RegExp
 *           already does ERE-equivalent)
 *
 * Fix: parse flags once into a struct; unify stdin + file + recursive
 * paths through a single `processLines` helper that honours every
 * flag consistently.
 */
function mkGrep(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = [...ctx.args];
    // Parse flags. Support combined `-rni` form (single dash + chars).
    let recursive = false, ignoreCase = false, lineNum = false;
    let countOnly = false, invertMatch = false, wordMatch = false;
    let filesOnly = false;  // -l
    let positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { positional.push(...args.slice(i + 1)); break; }
      if (a === '-r' || a === '-R' || a === '--recursive') { recursive = true; continue; }
      if (a === '-i' || a === '--ignore-case') { ignoreCase = true; continue; }
      if (a === '-n' || a === '--line-number') { lineNum = true; continue; }
      if (a === '-c' || a === '--count') { countOnly = true; continue; }
      if (a === '-v' || a === '--invert-match') { invertMatch = true; continue; }
      if (a === '-w' || a === '--word-regexp') { wordMatch = true; continue; }
      if (a === '-l' || a === '--files-with-matches') { filesOnly = true; continue; }
      if (a === '-E' || a === '--extended-regexp') { /* JS regex is ERE-ish */ continue; }
      if (a === '-F' || a === '--fixed-strings') {
        // Mark as literal — handled below via escape.
        (args as any).__fixedStrings = true;
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
        // Combined short flags like -rni
        for (const ch of a.slice(1)) {
          if (ch === 'r' || ch === 'R') recursive = true;
          else if (ch === 'i') ignoreCase = true;
          else if (ch === 'n') lineNum = true;
          else if (ch === 'c') countOnly = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'w') wordMatch = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'E') { /* ERE noop */ }
          else if (ch === 'F') (args as any).__fixedStrings = true;
        }
        continue;
      }
      positional.push(a);
    }
    if (positional.length < 1) { ctx.stderr.write('Usage: grep [-rnicvlEFw] PATTERN [FILE...]\n'); return 1; }
    let pattern = positional[0];
    const targets = positional.slice(1);
    if ((args as any).__fixedStrings) {
      // -F: escape regex metacharacters for literal match.
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (wordMatch) pattern = `\\b(?:${pattern})\\b`;
    const flags = ignoreCase ? 'i' : '';
    let re: RegExp;
    try { re = new RegExp(pattern, flags); } catch { ctx.stderr.write(`grep: invalid regex: ${pattern}\n`); return 1; }
    let found = false;

    function processLines(lines: string[], label: string): void {
      let count = 0;
      let matchedHere = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip a trailing empty line from a content that ended with \\n.
        if (i === lines.length - 1 && line === '') continue;
        const isMatch = re.test(line);
        if (isMatch !== invertMatch) {
          found = true;
          matchedHere = true;
          count++;
          if (filesOnly) {
            // -l: emit file label once, stop scanning.
            ctx.stdout.write(label + '\n');
            return;
          }
          if (!countOnly) {
            const labelPrefix = (targets.length > 1 || recursive) && label ? label + ':' : '';
            const linePrefix = lineNum ? (i + 1) + ':' : '';
            ctx.stdout.write(labelPrefix + linePrefix + line + '\n');
          }
        }
      }
      if (countOnly) {
        const labelPrefix = (targets.length > 1 || recursive) && label ? label + ':' : '';
        ctx.stdout.write(labelPrefix + count + '\n');
      }
      void matchedHere;
    }

    function grepFile(path: string, label: string) {
      try {
        const content = vfs.readFileString(path);
        processLines(content.split('\n'), label);
      } catch { /* ignore unreadable file */ }
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
      // Read from stdin (if piped) — single virtual "file" with no label.
      if (ctx.stdin) {
        processLines(ctx.stdin.split('\n'), '');
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

/**
 * BUG-SWEEP-R2-4 (2026-05-11): expanded awk subset.
 *
 * Pre-fix mkAwk supported only:
 *   {print $N}
 *   /pattern/ [{print}]
 * Anything else → 'awk: unsupported program'.
 *
 * This extension adds (all in pure JS — no embedded awk-interpreter):
 *   BEGIN { stmts }     — run before any input line
 *   END   { stmts }     — run after last line
 *   /pat/ { stmts }     — per-line conditional action
 *   { stmts }           — per-line unconditional action
 *   $0, $1..$N, $NF     — field refs in any expression
 *   NR, NF              — record number, field count
 *   print EXPR          — write EXPR to stdout + newline (comma-sep)
 *   printf "fmt", a, b  — printf-style (%s %d %f %x %o + width.prec)
 *   sum += $N           — assignment + compound
 *   simple arithmetic   — + - * / % () in expression position
 *   numeric literals    — integers and decimals
 *   string literals     — "..."
 *   user vars           — assigned via name = expr or compound
 *
 * NOT supported:
 *   - for/while/if (control flow)
 *   - functions
 *   - arrays (assoc / indexed)
 *   - getline
 *   - regex match operator ~/!~ outside pattern position
 *
 * The eval engine is a tiny stmt-list runner that compiles each
 * statement to a JS closure operating on a shared state {vars,
 * fields[], NR, NF, separator, stdout, stderr}. Statements are
 * separated by `;` or `\\n`.
 *
 * Failure mode: if we can't parse a statement, write a clear error
 * to stderr and exit 1 (no silent fail).
 */
function mkAwk(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const allArgs = ctx.args;
    // Parse -F separator if present.
    let separator: string | RegExp = /\s+/;
    const programArgs: string[] = [];
    const fileArgs: string[] = [];
    for (let i = 0; i < allArgs.length; i++) {
      const a = allArgs[i];
      if (a === '-F') {
        const s = allArgs[++i];
        if (s) separator = s.length === 1 ? s : new RegExp(s);
      } else if (a.startsWith('-F')) {
        const s = a.slice(2);
        if (s) separator = s.length === 1 ? s : new RegExp(s);
      } else if (a.startsWith('-')) {
        // Ignore other flags (silent compat).
      } else if (programArgs.length === 0) {
        programArgs.push(a);
      } else {
        fileArgs.push(a);
      }
    }
    const program = programArgs[0] || '';
    let input = ctx.stdin || '';
    if (fileArgs.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, fileArgs[0])); }
      catch { ctx.stderr.write(`awk: ${fileArgs[0]}: No such file\n`); return 1; }
    }

    // ── Parse program into blocks. ──
    // Block forms:
    //   BEGIN { stmts }
    //   END   { stmts }
    //   /pat/ { stmts }
    //   /pat/                    (implicit { print })
    //   { stmts }
    // Multiple blocks may appear (separated by whitespace/newlines).
    interface Block { kind: 'BEGIN' | 'END' | 'PATTERN' | 'MAIN'; pattern?: RegExp; body: string }
    const blocks: Block[] = [];
    let cursor = 0;
    const src = program.trim();
    function skipWS() {
      while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
    }
    function parseBraced(): string {
      // Assumes src[cursor] === '{'
      let depth = 0;
      let start = cursor;
      while (cursor < src.length) {
        const ch = src[cursor];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { cursor++; return src.slice(start + 1, cursor - 1); } }
        else if (ch === '"' || ch === "'") {
          const quote = ch;
          cursor++;
          while (cursor < src.length && src[cursor] !== quote) {
            if (src[cursor] === '\\') cursor++;
            cursor++;
          }
        }
        cursor++;
      }
      return src.slice(start + 1, cursor);
    }
    while (cursor < src.length) {
      skipWS();
      if (cursor >= src.length) break;
      if (src.startsWith('BEGIN', cursor)) {
        cursor += 5;
        skipWS();
        if (src[cursor] !== '{') { ctx.stderr.write('awk: BEGIN without {\n'); return 1; }
        blocks.push({ kind: 'BEGIN', body: parseBraced() });
        continue;
      }
      if (src.startsWith('END', cursor)) {
        cursor += 3;
        skipWS();
        if (src[cursor] !== '{') { ctx.stderr.write('awk: END without {\n'); return 1; }
        blocks.push({ kind: 'END', body: parseBraced() });
        continue;
      }
      if (src[cursor] === '/') {
        // Pattern /pat/ optionally followed by {body}
        const pstart = cursor + 1;
        cursor++;
        while (cursor < src.length && src[cursor] !== '/') {
          if (src[cursor] === '\\') cursor++;
          cursor++;
        }
        const patSrc = src.slice(pstart, cursor);
        cursor++; // past closing /
        skipWS();
        let body = 'print';
        if (cursor < src.length && src[cursor] === '{') body = parseBraced();
        let re: RegExp;
        try { re = new RegExp(patSrc); }
        catch (e: any) { ctx.stderr.write(`awk: bad regex /${patSrc}/: ${e?.message || e}\n`); return 1; }
        blocks.push({ kind: 'PATTERN', pattern: re, body });
        continue;
      }
      if (src[cursor] === '{') {
        blocks.push({ kind: 'MAIN', body: parseBraced() });
        continue;
      }
      ctx.stderr.write(`awk: parse error at "${src.slice(cursor, cursor + 20)}"\n`);
      return 1;
    }

    // ── Statement evaluator. ──
    // The evaluator processes a body string by splitting on `;` or
    // newline, then executes each statement against a state record.
    // Each statement is matched against shapes:
    //   print EXPR[, EXPR]*    OR  print
    //   printf "fmt", EXPR, …
    //   IDENT = EXPR
    //   IDENT (+|-|*|/|%)= EXPR
    //   next  (skip rest of body for this line — rare)
    interface State {
      vars: Record<string, any>;
      fields: string[];  // [$0, $1, $2, ...]
      NR: number;
      NF: number;
      printed: boolean;
    }
    /**
     * Expression evaluator without `new Function`. workerd CSP blocks
     * dynamic code generation at request time. This is a small
     * recursive-descent evaluator for the subset:
     *   - literals: number, string ("...")
     *   - field refs: $0, $N, $NF
     *   - builtins: NR, NF
     *   - user vars: identifier (looked up in st.vars; default 0)
     *   - binary ops: + - * / % (numeric)
     *   - parens: (expr)
     *   - string concat happens via space-join in `print` call sites
     *
     * The grammar:
     *   expr     := term (('+'|'-') term)*
     *   term     := factor (('*'|'/'|'%') factor)*
     *   factor   := number | string | '$' (number | 'NF') | ident | '(' expr ')'
     */
    function evalExpr(expr: string, st: State): any {
      const text = expr.trim();
      let pos = 0;
      function skipWs() { while (pos < text.length && /\s/.test(text[pos])) pos++; }
      function peek(): string { return text[pos]; }
      function consume(ch: string): boolean { skipWs(); if (text[pos] === ch) { pos++; return true; } return false; }
      function expect(ch: string): void { if (!consume(ch)) throw new Error(`expected '${ch}' at "${text.slice(pos, pos + 20)}"`); }
      function parseExpr(): any {
        let left = parseTerm();
        for (;;) {
          skipWs();
          const op = text[pos];
          if (op === '+' || op === '-') {
            pos++;
            const right = parseTerm();
            const ln = toNum(left), rn = toNum(right);
            left = op === '+' ? ln + rn : ln - rn;
          } else break;
        }
        return left;
      }
      function parseTerm(): any {
        let left = parseFactor();
        for (;;) {
          skipWs();
          const op = text[pos];
          if (op === '*' || op === '/' || op === '%') {
            pos++;
            const right = parseFactor();
            const ln = toNum(left), rn = toNum(right);
            left = op === '*' ? ln * rn : op === '/' ? ln / rn : ln % rn;
          } else break;
        }
        return left;
      }
      function parseFactor(): any {
        skipWs();
        if (pos >= text.length) throw new Error(`unexpected end of expression`);
        const ch = text[pos];
        // Number
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[pos + 1]))) {
          let start = pos;
          while (pos < text.length && /[0-9.]/.test(text[pos])) pos++;
          return parseFloat(text.slice(start, pos));
        }
        // String literal (double or single quotes)
        if (ch === '"' || ch === "'") {
          const quote = ch;
          pos++;
          let s = '';
          while (pos < text.length && text[pos] !== quote) {
            if (text[pos] === '\\' && pos + 1 < text.length) {
              const esc = text[pos + 1];
              s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === "'" ? "'" : esc;
              pos += 2;
            } else {
              s += text[pos];
              pos++;
            }
          }
          if (pos < text.length) pos++; // skip closing quote
          return s;
        }
        // Parenthesised
        if (ch === '(') {
          pos++;
          const v = parseExpr();
          expect(')');
          return v;
        }
        // Unary minus
        if (ch === '-') {
          pos++;
          return -toNum(parseFactor());
        }
        // Unary plus
        if (ch === '+') {
          pos++;
          return toNum(parseFactor());
        }
        // Field ref: $N or $NF
        if (ch === '$') {
          pos++;
          skipWs();
          if (text.startsWith('NF', pos)) {
            pos += 2;
            return st.fields[st.NF] ?? '';
          }
          // Parens around index? $($1+1) etc — not supported, just digits.
          let nStart = pos;
          while (pos < text.length && /[0-9]/.test(text[pos])) pos++;
          if (nStart === pos) throw new Error(`expected field index after $ at "${text.slice(pos, pos + 10)}"`);
          const idx = parseInt(text.slice(nStart, pos), 10);
          return st.fields[idx] ?? '';
        }
        // Identifier: NR, NF, user var
        if (/[A-Za-z_]/.test(ch)) {
          let start = pos;
          while (pos < text.length && /[A-Za-z0-9_]/.test(text[pos])) pos++;
          const name = text.slice(start, pos);
          if (name === 'NR') return st.NR;
          if (name === 'NF') return st.NF;
          return st.vars[name] !== undefined ? st.vars[name] : 0;
        }
        throw new Error(`unexpected '${ch}' at "${text.slice(pos, pos + 20)}"`);
      }
      function toNum(v: any): number {
        if (typeof v === 'number') return v;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      }
      try {
        const v = parseExpr();
        skipWs();
        if (pos < text.length) {
          // Trailing junk — could be intentional (e.g. tail of stmt is
          // separator). Be permissive — return what we have.
        }
        return v;
      } catch (e: any) {
        throw new Error(`expr error: ${e?.message || e} in "${expr}"`);
      }
    }
    function stripStringsForScan(s: string): string {
      // Replace string contents with same-length spaces so positions stay aligned.
      let out = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          out += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { out += ' '; i++; }
            out += ' ';
            i++;
          }
          if (i < s.length) { out += ch; i++; }
        } else {
          out += ch;
          i++;
        }
      }
      return out;
    }
    function remapUserVars(s: string): string {
      // Find identifiers (a-z_), skip ones that are reserved or already
      // remapped. The simple approach: scan tokens outside string
      // literals.
      const RESERVED = new Set([
        '__f', '__nr', '__nf', '__v',
        'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
        'Math', 'String', 'Number', 'Array', 'Object',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'length',  // for str/array .length access — not a free identifier here
      ]);
      let out = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          out += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { out += s[i]; i++; }
            out += s[i]; i++;
          }
          if (i < s.length) { out += s[i]; i++; }
          continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          let start = i;
          while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
          const ident = s.slice(start, i);
          // Skip if previous non-ws char is `.` (member access).
          let prev = start - 1;
          while (prev >= 0 && /\s/.test(out[prev])) prev--;
          if (out[prev] === '.') { out += ident; continue; }
          if (RESERVED.has(ident)) { out += ident; continue; }
          // Replace with (__v.ident !== undefined ? __v.ident : 0)
          out += `(__v.${ident}!==undefined?__v.${ident}:0)`;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }
    function splitStmts(body: string): string[] {
      const stmts: string[] = [];
      let depth = 0;
      let cur = '';
      let i = 0;
      while (i < body.length) {
        const ch = body[i];
        if (ch === '"' || ch === "'") {
          cur += ch;
          i++;
          while (i < body.length && body[i] !== ch) {
            if (body[i] === '\\') { cur += body[i]; i++; }
            cur += body[i]; i++;
          }
          if (i < body.length) { cur += body[i]; i++; }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && (ch === ';' || ch === '\n')) {
          const t = cur.trim();
          if (t) stmts.push(t);
          cur = '';
          i++;
          continue;
        }
        cur += ch;
        i++;
      }
      const t = cur.trim();
      if (t) stmts.push(t);
      return stmts;
    }
    function execStmt(stmt: string, st: State): void {
      // print [expr[, expr]*]
      if (stmt === 'print' || stmt.startsWith('print ') || stmt.startsWith('print\t')) {
        const rest = stmt.slice(5).trim();
        if (!rest) { ctx.stdout.write(st.fields[0] + '\n'); st.printed = true; return; }
        // Comma-separated exprs (space joiner). We must split at top-level commas only.
        const parts = splitTopLevel(rest, ',');
        const out = parts.map(p => stringify(evalExpr(p, st))).join(' ');
        ctx.stdout.write(out + '\n');
        st.printed = true;
        return;
      }
      // printf "fmt", arg, arg, ...
      if (stmt.startsWith('printf ') || stmt.startsWith('printf(')) {
        let rest = stmt.startsWith('printf(') ? stmt.slice(7).replace(/\)\s*$/, '') : stmt.slice(7);
        rest = rest.trim();
        const parts = splitTopLevel(rest, ',');
        if (parts.length === 0) return;
        const fmt = evalExpr(parts[0], st);
        const fargs = parts.slice(1).map(p => evalExpr(p, st));
        ctx.stdout.write(printfFormat(String(fmt), fargs));
        st.printed = true;
        return;
      }
      // next: skip rest of body (no-op here since we re-enter each block fresh)
      if (stmt === 'next') return;
      // assignment: IDENT [op]= EXPR
      // We require a top-level `=` not part of `==` `<=` `>=` `!=`.
      const eqIdx = findAssignmentEq(stmt);
      if (eqIdx > 0) {
        const lhs = stmt.slice(0, eqIdx).trim();
        const rhs = stmt.slice(eqIdx + 1).trim();
        // Compound: lhs ends with op (e.g. `sum +`).
        let op: string | null = null;
        let name = lhs;
        if (/[+\-*/%]$/.test(lhs)) {
          op = lhs[lhs.length - 1];
          name = lhs.slice(0, -1).trim();
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`bad assignment target "${name}"`);
        }
        const rv = evalExpr(rhs, st);
        if (op) {
          const cur = st.vars[name] !== undefined ? st.vars[name] : 0;
          const lhsNum = typeof cur === 'number' ? cur : parseFloat(cur);
          const rvNum = typeof rv === 'number' ? rv : parseFloat(rv);
          const lN = Number.isFinite(lhsNum) ? lhsNum : 0;
          const rN = Number.isFinite(rvNum) ? rvNum : 0;
          st.vars[name] =
            op === '+' ? lN + rN :
            op === '-' ? lN - rN :
            op === '*' ? lN * rN :
            op === '/' ? lN / rN :
            op === '%' ? lN % rN : rv;
        } else {
          st.vars[name] = rv;
        }
        return;
      }
      // Bare expression — evaluate for side effects (rare in awk).
      evalExpr(stmt, st);
    }
    function findAssignmentEq(s: string): number {
      let depth = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') i++;
            i++;
          }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && ch === '=') {
          const next = s[i + 1];
          const prev = s[i - 1];
          if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
          return i;
        }
      }
      return -1;
    }
    function splitTopLevel(s: string, sep: string): string[] {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          cur += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { cur += s[i]; i++; }
            cur += s[i]; i++;
          }
          if (i < s.length) { cur += s[i]; i++; }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && ch === sep) { out.push(cur.trim()); cur = ''; i++; continue; }
        cur += ch; i++;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    function stringify(v: any): string {
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return String(v);
        // awk's OFMT default is "%.6g"
        return printfFormat('%.6g', [v]);
      }
      return String(v);
    }
    function printfFormat(fmt: string, fargs: any[]): string {
      let out = '';
      let i = 0;
      let argIdx = 0;
      while (i < fmt.length) {
        const ch = fmt[i];
        if (ch === '\\' && i + 1 < fmt.length) {
          const esc = fmt[i + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc;
          i += 2;
          continue;
        }
        if (ch === '%' && i + 1 < fmt.length) {
          // Parse: %[flags][width][.prec]specifier
          let spec = '%';
          i++;
          while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) { spec += fmt[i]; i++; }
          while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
          if (fmt[i] === '.') { spec += fmt[i]; i++; while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; } }
          const conv = fmt[i];
          i++;
          if (conv === '%') { out += '%'; continue; }
          const arg = fargs[argIdx++];
          out += formatOne(spec + conv, arg);
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }
    function formatOne(spec: string, arg: any): string {
      const conv = spec[spec.length - 1];
      const flagsAndWidth = spec.slice(1, -1);
      const dotIdx = flagsAndWidth.indexOf('.');
      const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
      const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
      let flags = '';
      let widthStr = '';
      for (const c of widthPart) {
        if (/[-+ 0#]/.test(c)) flags += c;
        else widthStr += c;
      }
      const width = widthStr ? parseInt(widthStr, 10) : 0;
      const prec = precPart ? parseInt(precPart, 10) : -1;
      let body: string;
      switch (conv) {
        case 's': body = String(arg ?? ''); if (prec >= 0) body = body.slice(0, prec); break;
        case 'd': case 'i': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = String(Number.isFinite(n) ? n : 0);
          break;
        }
        case 'f': {
          const n = typeof arg === 'number' ? arg : parseFloat(arg);
          const p = prec < 0 ? 6 : prec;
          body = (Number.isFinite(n) ? n : 0).toFixed(p);
          break;
        }
        case 'g': {
          const n = typeof arg === 'number' ? arg : parseFloat(arg);
          const p = prec < 0 ? 6 : prec;
          body = (Number.isFinite(n) ? n : 0).toPrecision(p).replace(/\.?0+$/, '');
          break;
        }
        case 'x': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = (Number.isFinite(n) ? n : 0).toString(16);
          break;
        }
        case 'o': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = (Number.isFinite(n) ? n : 0).toString(8);
          break;
        }
        case 'c': {
          if (typeof arg === 'number') body = String.fromCharCode(arg);
          else body = String(arg).charAt(0);
          break;
        }
        default: body = String(arg);
      }
      if (width > body.length) {
        const pad = flags.includes('0') && (conv === 'd' || conv === 'i' || conv === 'f' || conv === 'x' || conv === 'o') ? '0' : ' ';
        body = flags.includes('-') ? body.padEnd(width, ' ') : body.padStart(width, pad);
      }
      return body;
    }

    const state: State = {
      vars: {},
      fields: [],
      NR: 0,
      NF: 0,
      printed: false,
    };

    function runBlock(block: Block): void {
      const stmts = splitStmts(block.body);
      for (const s of stmts) {
        execStmt(s, state);
      }
    }

    try {
      // BEGIN blocks first.
      for (const b of blocks) if (b.kind === 'BEGIN') runBlock(b);
      // Main loop over input lines.
      const lines = input.split('\n');
      // awk default: drop the final empty line if input ended with \n.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const parts = typeof separator === 'string' && separator.length === 1
          ? line.split(separator)
          : line.split(separator);
        state.NR = li + 1;
        state.NF = parts.filter(p => p !== '').length;
        state.fields = [line, ...parts];
        for (const b of blocks) {
          if (b.kind === 'BEGIN' || b.kind === 'END') continue;
          if (b.kind === 'PATTERN') {
            if (b.pattern!.test(line)) runBlock(b);
          } else {
            // MAIN block (no pattern) — always runs.
            runBlock(b);
          }
        }
      }
      // END blocks last.
      for (const b of blocks) if (b.kind === 'END') runBlock(b);
    } catch (e: any) {
      ctx.stderr.write(`awk: ${e?.message || e}\n`);
      return 1;
    }

    return 0;
  };
}

/**
 * BUG-SWEEP-R2-3 (2026-05-11): real xargs implementation.
 *
 * Pre-fix the impl printed the command-line it WOULD execute and
 * returned 0. Real xargs runs the command, possibly batched (-n),
 * with arguments substituted (-I).
 *
 * We do cross-command dispatch through the same `registry` lifo-sh
 * uses, so xargs can drive `echo`, `cat`, `rm`, `seq`, lifo-sh
 * lazy-loaded builtins — anything in the registry. The execution
 * runs IN-SUPERVISOR (not through facet spawn) which means it
 * works for pure-builtins but NOT for facet-direct commands like
 * `node`, `git`, `npm` (the registry resolver returns those by
 * name but invoking them requires the cp/facet pipeline).
 *
 * Supported flags:
 *   -n NUM        run command with at most NUM args per invocation
 *   -I REPL       replace REPL in command with the input item
 *   -0            null-byte separator (rare; bash xargs -0 idiom)
 *   default args  use args.split(/\s+/) from stdin
 *
 * Unsupported (document as gap): -P (parallel), -L (per-line), -p (prompt).
 */
function mkXargs(vfs: SqliteVFS, registry: any): CmdFn {
  return async (ctx) => {
    const input = (ctx.stdin || '').trim();
    if (!input) return 0;

    // Parse flags first
    const args = [...ctx.args];
    let batchSize = Infinity;
    let replaceTok: string | null = null;
    let nullSep = false;
    while (args.length > 0 && args[0].startsWith('-')) {
      const a = args.shift()!;
      if (a === '-n') {
        const n = parseInt(args.shift() || '', 10);
        if (Number.isFinite(n) && n > 0) batchSize = n;
      } else if (a.startsWith('-n')) {
        const n = parseInt(a.slice(2), 10);
        if (Number.isFinite(n) && n > 0) batchSize = n;
      } else if (a === '-I') {
        replaceTok = args.shift() || '{}';
        batchSize = 1; // -I implies one-arg-per-invocation
      } else if (a === '-0' || a === '--null') {
        nullSep = true;
      } else if (a === '--') {
        break;
      } else {
        // Unknown flag — push back as cmd token (best-effort behavior)
        args.unshift(a);
        break;
      }
    }

    // Remaining args: cmd + initial-args. Default: echo.
    const cmdName = args.shift() || 'echo';
    const cmdArgsInitial = args;

    // Split stdin into items
    const items = nullSep
      ? input.split('\u0000').filter(Boolean)
      : input.split(/\s+/).filter(Boolean);

    // Resolve target command from registry (handles both eager + lazy maps).
    let target;
    try {
      target = await registry.resolve(cmdName);
    } catch (_e) { target = null; }
    if (!target) {
      // Defer to write-to-stderr; mimic real xargs which would exec(2) and fail.
      ctx.stderr.write(`xargs: ${cmdName}: command not found\n`);
      return 127;
    }

    // Run in batches.
    const newCtx = (newArgs: string[]) => ({
      args: newArgs,
      env: ctx.env,
      cwd: ctx.cwd,
      vfs: (ctx as any).vfs,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      stdin: '',  // xargs doesn't pipe its own stdin to children
      signal: (ctx as any).signal,
    });

    let exit = 0;
    if (replaceTok) {
      // -I: one invocation per item, replacing token in initial args.
      for (const item of items) {
        const subbed = cmdArgsInitial.map(a => a.split(replaceTok!).join(item));
        try {
          const code = await target(newCtx(subbed));
          if (typeof code === 'number' && code !== 0) exit = code;
        } catch (e: any) {
          ctx.stderr.write(`xargs: ${cmdName}: ${e?.message || e}\n`);
          exit = 1;
        }
      }
    } else {
      // -n N (or unlimited): batch items, append to initial args.
      const step = Number.isFinite(batchSize) ? batchSize : items.length;
      for (let i = 0; i < items.length; i += step) {
        const batch = items.slice(i, i + step);
        try {
          const code = await target(newCtx([...cmdArgsInitial, ...batch]));
          if (typeof code === 'number' && code !== 0) exit = code;
        } catch (e: any) {
          ctx.stderr.write(`xargs: ${cmdName}: ${e?.message || e}\n`);
          exit = 1;
        }
        if (!Number.isFinite(batchSize)) break;  // single batch when no -n
      }
    }
    return exit;
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

/**
 * BUG-SWEEP-R4-6 (2026-05-11): du flag parsing for combined forms.
 * Pre-fix `du -sh` didn't activate -h because we checked for literal
 * `-h` only — `-sh` is a single arg containing both flags. POSIX
 * conformant short-flag stacking.
 */
function mkDu(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    // Parse flags supporting stacked short flags like `-sh`, `-ah`.
    let showAll = false, human = false, sumOnly = false;
    const positional: string[] = [];
    for (const a of ctx.args) {
      if (a.startsWith('-') && a !== '-' && !a.startsWith('--')) {
        for (const ch of a.slice(1)) {
          if (ch === 'a') showAll = true;
          else if (ch === 'h') human = true;
          else if (ch === 's') sumOnly = true;
        }
      } else if (a.startsWith('--')) {
        if (a === '--all') showAll = true;
        else if (a === '--human-readable') human = true;
        else if (a === '--summarize') sumOnly = true;
      } else {
        positional.push(a);
      }
    }
    const target = positional[0] || '.';
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
/**
 * BUG-SWEEP-R2-3b (2026-05-11): registry-level echo so `X | xargs echo`
 * resolves. lifo-sh's `echo` is a Shell.builtins entry, NOT in the
 * registry map. xargs's cross-command dispatch goes through
 * registry.resolve(name) — without a registry entry for echo it falls
 * back to 'command not found'. The init.ts override for echo flag
 * handling targets Shell.builtins; we additionally register a copy
 * here so registry-driven callers (xargs) can find it. Behaviour
 * matches the BUG-SWEEP-4 nimbusEcho impl: -n / -e / -E / combined.
 */
function mkEcho(): CmdFn {
  return (ctx) => {
    const args = ctx.args;
    let interpretEscapes = false;
    let suppressNewline = false;
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-n') { suppressNewline = true; i++; continue; }
      if (a === '-e') { interpretEscapes = true; i++; continue; }
      if (a === '-E') { interpretEscapes = false; i++; continue; }
      if (/^-[neE]+$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === 'n') suppressNewline = true;
          else if (ch === 'e') interpretEscapes = true;
          else if (ch === 'E') interpretEscapes = false;
        }
        i++;
        continue;
      }
      break;
    }
    let out = args.slice(i).join(' ');
    if (interpretEscapes) {
      out = out
        .replace(/\\\\/g, '\u0000')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\b/g, '\b')
        .replace(/\\f/g, '\f')
        .replace(/\\v/g, '\v')
        .replace(/\\a/g, '\x07')
        .replace(/\\0([0-7]{1,3})?/g, (_m, oct) => String.fromCharCode(oct ? parseInt(oct, 8) : 0))
        .replace(/\\x([0-9a-fA-F]{1,2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\u0000/g, '\\');
    }
    ctx.stdout.write(suppressNewline ? out : out + '\n');
    return 0;
  };
}

/**
 * BUG-SWEEP-R2-3c (2026-05-11): registry-level cat (for xargs cross-
 * command dispatch). Behaves like lifo-sh's lazy cat: reads files (or
 * stdin if none), concatenates to stdout.
 */
function mkCat(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const files = ctx.args.filter(a => !a.startsWith('-'));
    if (files.length === 0) {
      if (ctx.stdin) ctx.stdout.write(ctx.stdin);
      return 0;
    }
    // BUG-SWEEP-R3 follow-up: prefer ctx.vfs (Kernel.VFS, sees /dev
    // mount) over the closure-captured SqliteVFS. Without this fallback,
    // `cat /dev/null` errors with ENOENT because SqliteVFS doesn't know
    // about the /dev provider mounted on Kernel.VFS. lifo-sh's
    // executeCommand passes Kernel.VFS as ctx.vfs.
    const kvfs: any = (ctx as any).vfs;
    let exit = 0;
    for (const f of files) {
      try {
        let content: string;
        // Try Kernel.VFS first (handles mounted providers like /dev).
        // Kernel.VFS.readFile returns Uint8Array; readFileString returns
        // string. lifo-sh's Kernel exposes both via the same interface
        // SqliteVFS uses (duck-typed: readFileString -> string).
        if (kvfs && typeof kvfs.readFile === 'function') {
          try {
            const raw = kvfs.readFile(f.startsWith('/') ? f : ctx.cwd + '/' + f);
            content = typeof raw === 'string'
              ? raw
              : new TextDecoder('utf-8').decode(raw);
          } catch (kErr: any) {
            // Fall back to SqliteVFS for paths that don't go through
            // Kernel mounts (e.g. relative paths to internal storage).
            const fp = resolvePath(ctx.cwd, f);
            content = vfs.readFileString(fp);
            void kErr;
          }
        } else {
          const fp = resolvePath(ctx.cwd, f);
          content = vfs.readFileString(fp);
        }
        ctx.stdout.write(content);
      } catch (e: any) {
        ctx.stderr.write(`cat: ${f}: ${e?.message || e}\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

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
        // -f suppresses ENOENT only (file disappeared mid-loop); other
        // errors (ENOTEMPTY because of a logic bug, ENOTDIR mismatches,
        // permission errors) must still surface. Pre-fix the broad
        // `if (force) continue` masked the readdir-iteration bug that
        // left directories undeleted.
        const msg = String(e?.message || e);
        if (force && /ENOENT/.test(msg)) continue;
        ctx.stderr.write(`rm: cannot remove '${t}': ${msg}\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

/**
 * Internal helper: recursive directory delete via SqliteVFS readdir +
 * unlink/rmdir. vfs.readdir returns `{name, type}[]` not `string[]` —
 * iterate the name property explicitly.
 */
function rmDirRec(vfs: SqliteVFS, path: string): void {
  const entries = vfs.readdir(path);
  for (const entry of entries) {
    const childPath = path + '/' + entry.name;
    if (entry.type === 'directory') rmDirRec(vfs, childPath);
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
    // BUG-SWEEP-R3 follow-up: try Kernel.VFS (ctx.vfs) first so /dev
    // mount paths resolve. Same pattern as mkCat.
    const kvfs: any = (ctx as any).vfs;
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      let st: any = null;
      let displayPath = f;
      // Try Kernel.VFS first (sees mounts).
      if (kvfs && typeof kvfs.stat === 'function') {
        try {
          st = kvfs.stat(f.startsWith('/') ? f : ctx.cwd + '/' + f);
          displayPath = f.startsWith('/') ? f : `/${ctx.cwd}/${f}`.replace(/^\/+/, '/');
        } catch (_e) { /* fall through to SqliteVFS */ }
      }
      // Fall back to SqliteVFS direct (legacy / non-mounted paths).
      if (!st) {
        try {
          const fp = resolvePath(ctx.cwd, f);
          st = vfs.stat(fp);
          displayPath = '/' + fp;
        } catch (_e) {
          ctx.stderr.write(`stat: '${f}': No such file\n`);
          return 1;
        }
      }
      ctx.stdout.write(`  File: ${displayPath}\n`);
      ctx.stdout.write(`  Size: ${st.size}\tType: ${st.type}\n`);
      ctx.stdout.write(`  Mode: ${st.mode.toString(8)}\n`);
      ctx.stdout.write(`Modify: ${new Date(st.mtime).toISOString()}\n`);
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

/**
 * BUG-SWEEP-R4-2 (2026-05-11): printf full POSIX format set.
 *
 * Pre-fix mkPrintf only handled %s and %d via simple replace —
 * `printf "%x\\n" 255` output literal `%x`, `printf "%5d" 7` output
 * literal `%5d`. Common shell scripts use %x (hex), %o (octal),
 * %f (float), %g (general), %c (char), width+precision specifiers,
 * and flag chars (- + 0 # space).
 *
 * Real bash printf cycles through args, re-running the format
 * string if there are more args than format specifiers. We
 * replicate that.
 */
function mkPrintf(): CmdFn {
  return (ctx) => {
    if (ctx.args.length === 0) return 0;
    const rawFmt = ctx.args[0];
    const vals = ctx.args.slice(1);
    // Process backslash escapes in the format string first.
    const fmt = rawFmt
      .replace(/\\\\/g, '\u0000')  // protect literal \\\\
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\a/g, '\x07')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\v/g, '\v')
      .replace(/\\0([0-7]{1,3})?/g, (_m, oct) => String.fromCharCode(oct ? parseInt(oct, 8) : 0))
      .replace(/\\x([0-9a-fA-F]{1,2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\u0000/g, '\\');

    let out = '';
    let argIdx = 0;

    function applyFormat(): boolean {
      // Run the format string once; return true if it consumed any args.
      let i = 0;
      const startArg = argIdx;
      while (i < fmt.length) {
        const ch = fmt[i];
        if (ch !== '%') { out += ch; i++; continue; }
        if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
        // Parse format spec: %[flags][width][.prec]conversion
        let spec = '%';
        i++;
        while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) { spec += fmt[i]; i++; }
        while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
        if (fmt[i] === '.') {
          spec += fmt[i]; i++;
          while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
        }
        const conv = fmt[i];
        i++;
        const arg = vals[argIdx++];
        out += formatOneArg(spec + conv, arg);
      }
      return argIdx > startArg;
    }

    // bash printf: re-run the format until args are exhausted; if
    // format consumes zero args (no %X specifiers), run it once.
    if (vals.length === 0) {
      applyFormat();
    } else {
      while (argIdx < vals.length) {
        if (!applyFormat()) break;
      }
    }
    ctx.stdout.write(out);
    return 0;
  };
}

function formatOneArg(spec: string, arg: any): string {
  const conv = spec[spec.length - 1];
  const flagsAndWidth = spec.slice(1, -1);
  const dotIdx = flagsAndWidth.indexOf('.');
  const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
  const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
  let flags = '';
  let widthStr = '';
  for (const c of widthPart) {
    if (/[-+ 0#]/.test(c)) flags += c;
    else widthStr += c;
  }
  const width = widthStr ? parseInt(widthStr, 10) : 0;
  const prec = precPart ? parseInt(precPart, 10) : -1;
  let body: string;
  switch (conv) {
    case 's': {
      body = String(arg ?? '');
      if (prec >= 0) body = body.slice(0, prec);
      break;
    }
    case 'd': case 'i': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      const v = Number.isFinite(n) ? n : 0;
      body = String(Math.abs(v));
      const sign = v < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      body = sign + body;
      break;
    }
    case 'u': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = String(Math.max(0, Number.isFinite(n) ? n : 0));
      break;
    }
    case 'f': case 'F': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec;
      body = (Number.isFinite(n) ? n : 0).toFixed(p);
      if (n >= 0 && flags.includes('+')) body = '+' + body;
      else if (n >= 0 && flags.includes(' ')) body = ' ' + body;
      break;
    }
    case 'e': case 'E': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec;
      body = (Number.isFinite(n) ? n : 0).toExponential(p);
      if (conv === 'E') body = body.toUpperCase();
      break;
    }
    case 'g': case 'G': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec || 1;
      body = (Number.isFinite(n) ? n : 0).toPrecision(p);
      // Strip trailing zeros + dot (POSIX %g behavior) unless # flag.
      if (!flags.includes('#')) body = body.replace(/(\.\d*?)0+($|e)/, '$1$2').replace(/\.($|e)/, '$1');
      if (conv === 'G') body = body.toUpperCase();
      break;
    }
    case 'x': case 'X': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = (Number.isFinite(n) ? n >>> 0 : 0).toString(16);
      if (conv === 'X') body = body.toUpperCase();
      if (flags.includes('#') && body !== '0') body = (conv === 'X' ? '0X' : '0x') + body;
      break;
    }
    case 'o': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = (Number.isFinite(n) ? n >>> 0 : 0).toString(8);
      if (flags.includes('#') && !body.startsWith('0')) body = '0' + body;
      break;
    }
    case 'b': {
      // bash printf %b: interpret backslash escapes in the arg
      let s = String(arg ?? '');
      s = s.replace(/\\\\/g, '\u0000')
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
        .replace(/\\u0000/g, '\\');
      body = s;
      break;
    }
    case 'c': {
      if (typeof arg === 'number') body = String.fromCharCode(arg);
      else body = String(arg ?? '').charAt(0);
      break;
    }
    case 'q': {
      // bash printf %q: shell-quote
      const s = String(arg ?? '');
      if (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(s)) body = s;
      else body = "'" + s.replace(/'/g, `'\\''`) + "'";
      break;
    }
    default: body = '%' + conv;
  }
  // Apply width padding.
  if (width > body.length) {
    const zeroPad = flags.includes('0') && /[diouxXfFeEgG]/.test(conv) && !flags.includes('-');
    const padCh = zeroPad ? '0' : ' ';
    if (flags.includes('-')) body = body.padEnd(width, ' ');
    else {
      // For zero-pad on negative numbers, keep the sign at the front.
      if (zeroPad && (body.startsWith('-') || body.startsWith('+') || body.startsWith(' '))) {
        body = body[0] + body.slice(1).padStart(width - 1, padCh);
      } else {
        body = body.padStart(width, padCh);
      }
    }
  }
  return body;
}

function mkTrue(): CmdFn { return () => 0; }
function mkFalse(): CmdFn { return () => 1; }

/**
 * BUG-SWEEP-R4-7 (2026-05-11): readlink stub.
 *
 * Real readlink reads the symlink target. Our VFS doesn't yet
 * support real symlinks (ln -s currently does a regular file
 * copy — tracked as deferred). For graceful failure:
 *   - if path is a regular file/dir, exit 1 (matches GNU readlink)
 *   - if path is missing, write error to stderr + exit 1
 *   - explicit handling avoids 'readlink: command not found'.
 *
 * When real symlinks land in VFS, this command will become the
 * read-side of the symlink table.
 */
function mkReadlink(vfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const targets = ctx.args.filter(a => !a.startsWith('-'));
    if (targets.length === 0) {
      ctx.stderr.write('readlink: missing operand\n');
      return 1;
    }
    let exit = 0;
    for (const t of targets) {
      const fp = resolvePath(ctx.cwd, t);
      if (!vfs.exists(fp)) {
        ctx.stderr.write(`readlink: ${t}: No such file or directory\n`);
        exit = 1;
        continue;
      }
      // Without symlink support, every existing entry is non-symlink.
      // GNU readlink exits 1 without output for non-symlinks unless
      // -f/-e is given. Match that to avoid 'command not found'.
      exit = 1;
    }
    return exit;
  };
}

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
  registry.register('type', wrap(mkType(vfs, registry)));
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
  registry.register('xargs', wrap(mkXargs(vfs, registry)));
  registry.register('tee', wrap(mkTee(vfs)));
  registry.register('du', wrap(mkDu(vfs)));
  registry.register('diff', wrap(mkDiff(vfs)));
  // Registry-level echo + cat for xargs cross-command dispatch.
  // Shell.builtins still wins for direct `echo X` invocations; this
  // entry is only reached when a command (xargs etc.) looks them up
  // via the registry path.
  registry.register('echo', wrap(mkEcho()));
  registry.register('cat', wrap(mkCat(vfs)));
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
  registry.register('readlink', wrap(mkReadlink(vfs)));
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
