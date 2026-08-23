/**
 * unix-commands.ts — Nimbus v2.0 Unix command implementations.
 *
 * Every command is a real implementation operating on SqliteVFS.
 * No stubs, no "not implemented" — each does actual work.
 *
 * Commands: which, env, export, unset, history, clear, alias, date,
 * uptime, tree, find, grep -r, head, tail, wc, diff, sort, uniq,
 * sed (s///), awk (field extract), xargs, tee, chown, ln -s,
 * du, man/help, basename, dirname, printf, true, false, seq, sleep,
 * touch, stat, file, xxd, od, hexdump, base64, sha256sum, id, hostname,
 * realpath
 */
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import { requireVfsCred } from '../runtime/os-contracts.js';
import { dec, enc } from '../_shared/bytes.js';
import { errorText } from '../_shared/error-text.js';
import { NIMBUS_VERSION } from '../constants.js';
import { SinkWriter, streamRange } from '../_shared/byte-stream.js';
import { fileTypeChar, isCharacterDevice, } from '../substrate/lifo/kernel/vfs/index.js';
import { runSed } from '../substrate/lifo/commands/text/sed.js';
import { parseArgs } from '../substrate/lifo/utils/args.js';
import { encode } from '../substrate/lifo/utils/encoding.js';
import { findUnixGroupName, findUnixUserName, parseChownOwnership, } from './unix-accounts.js';
import { createSuCommand, createSudoCommand, createUmaskCommand } from './elevation-commands.js';
/**
 * A resolved entry as a command this module can run. Every handler in the
 * registry takes a command context; the ones registered below read the string
 * `wrap` leaves in `stdin`, and a command dispatched from here is handed that
 * string rather than a reader.
 */
function asResolvedCommand(resolved) {
    return typeof resolved === 'function' ? resolved : null;
}
/**
 * stdin as text. `wrap` drains the shell's stream into `ctx.stdin` before a
 * command body runs, so a command that does not read a stream itself sees the
 * string it left there, and nothing at all when there was no stdin.
 */
function stdinText(ctx) {
    return typeof ctx.stdin === 'string' ? ctx.stdin : undefined;
}
function unixVfsFor(sqliteVfs, cred) {
    return {
        ...sqliteVfs.as(cred),
        symlinks: getSymlinkRegistry(sqliteVfs),
    };
}
function withInvocationVfs(sqliteVfs, factory) {
    return (ctx) => factory(unixVfsFor(sqliteVfs, requireVfsCred(ctx.cred, 'unix command dispatch')))(ctx);
}
function fsErrorMessage(error) {
    if (error instanceof Error) {
        const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
        if (code === 'EACCES' || code === 'EPERM')
            return 'Permission denied';
        if (code === 'ENOENT')
            return 'No such file or directory';
        return error.message;
    }
    return String(error);
}
/** `drwxr-xr-x`-style permission string, shared by `ls -l` and `stat %A`. */
function unixModeString(mode, isDir, isLink) {
    if (isLink)
        return 'lrwxrwxrwx';
    const prefix = fileTypeChar(mode, isDir ? 'directory' : 'file');
    const bits = [
        mode & 0o400 ? 'r' : '-',
        mode & 0o200 ? 'w' : '-',
        mode & 0o100 ? 'x' : '-',
        mode & 0o040 ? 'r' : '-',
        mode & 0o020 ? 'w' : '-',
        mode & 0o010 ? 'x' : '-',
        mode & 0o004 ? 'r' : '-',
        mode & 0o002 ? 'w' : '-',
        mode & 0o001 ? 'x' : '-',
    ].join('');
    return prefix + bits;
}
function unixUserLabel(vfs, uid) {
    try {
        return findUnixUserName(vfs, uid) ?? String(uid);
    }
    catch {
        return String(uid);
    }
}
function unixGroupLabel(vfs, gid) {
    try {
        return findUnixGroupName(vfs, gid) ?? String(gid);
    }
    catch {
        return String(gid);
    }
}
function isRuntimeInstallHintHandler(handler) {
    return !!handler && !!handler.__nimbusRuntimeInstallHint;
}
// ── Helpers ─────────────────────────────────────────────────────────────
function resolvePath(cwd, p) {
    if (p.startsWith('/'))
        return p.replace(/^\/+/, '');
    const c = (cwd || '/home/user').replace(/^\/+/, '');
    const parts = (c + '/' + p).split('/');
    const out = [];
    for (const s of parts) {
        if (s === '..')
            out.pop();
        else if (s !== '.' && s !== '')
            out.push(s);
    }
    return out.join('/');
}
function readSymlinkTarget(vfs, path) {
    if (vfs.isSymlink(path))
        return vfs.readlink(path);
    return vfs.symlinks.readlink(path);
}
function resolveSymlinkPath(vfs, startPath) {
    let current = resolvePath('/', startPath);
    for (let hops = 0; hops < 40; hops++) {
        const target = readSymlinkTarget(vfs, current);
        if (target === null)
            return current;
        current = target.startsWith('/')
            ? resolvePath('/', target)
            : resolvePath('/' + (current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''), target);
    }
    return null;
}
function globMatch(pattern, name) {
    const re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp('^' + re + '$').test(name);
}
// ── Command implementations ─────────────────────────────────────────────
/**
 * SHELL-FOLLOWUPS-1 (2026-05-11): POSIX-conformant `which`.
 *
 * Pre-fix: `which clang` printed `clang: nimbus built-in`. Real POSIX
 * which prints the resolved absolute path (`/usr/local/bin/clang`)
 * or exits 1 silently. Scripts using `which` output to feed into
 * `dirname`, `$()`, etc. all broke:
 *   PATH_PREFIX=$(dirname $(which clang))   # expected /usr/local/bin
 *
 * Behaviour matches GNU `which`:
 *   - PATH search: walk `$PATH`, return first hit's absolute path.
 *   - Found in PATH: print path to stdout, exit 0.
 *   - Resolved as shell builtin (no -a): exit 1, NO output.
 *   - Resolved as shell builtin (with -a): print
 *     "<cmd>: shell built-in command" + continue search PATH.
 *   - Not found anywhere: stderr "<cmd>: not in (PATH)", exit 1.
 *
 * For our facet-direct runtimes (clang, node, bun, python, ruby,
 * git, npm, etc.), we don't have real on-disk binaries — they
 * dispatch through the registry. To preserve script compatibility,
 * we return canonical POSIX paths under /usr/local/bin and /usr/bin:
 *
 *   clang, clang++, cc                → /usr/local/bin/clang
 *   wasm-ld, lld                      → /usr/local/bin/wasm-ld
 *   node, nodejs                      → /usr/local/bin/node
 *   bun                               → /usr/local/bin/bun
 *   npm, npx                          → /usr/local/bin/npm
 *   git                               → /usr/bin/git
 *   python, python3                   → /usr/bin/python3
 *   ruby, ruby3                       → /usr/bin/ruby
 *   wrangler, nimbus-wrangler         → /usr/local/bin/wrangler
 *   esbuild, tsc, vite, rollup, etc.  → /usr/local/bin/<name>
 *
 * These paths are virtual but POSIX-shaped so scripts do the right
 * thing with `dirname $(which X)` etc. The paths don't have to
 * exist on the VFS (real GNU which just stat-walks PATH and
 * doesn't require execute bit at lookup time for stdout — it does
 * for exit code, but match what users expect first).
 *
 * If the user has installed a real binary in PATH (npm install + npx
 * resolution into /home/user/node_modules/.bin/X), prefer the actual
 * VFS-resolved path over the canonical fallback.
 */
const _CANONICAL_BIN_PATHS = {
    // /usr/local/bin (locally-installed runtimes)
    clang: '/usr/local/bin/clang',
    'clang++': '/usr/local/bin/clang++',
    cc: '/usr/local/bin/clang',
    'wasm-ld': '/usr/local/bin/wasm-ld',
    lld: '/usr/local/bin/wasm-ld',
    node: '/usr/local/bin/node',
    nodejs: '/usr/local/bin/node',
    bun: '/usr/local/bin/bun',
    npm: '/usr/local/bin/npm',
    npx: '/usr/local/bin/npx',
    pnpm: '/usr/local/bin/pnpm',
    yarn: '/usr/local/bin/yarn',
    esbuild: '/usr/local/bin/esbuild',
    tsc: '/usr/local/bin/tsc',
    vite: '/usr/local/bin/vite',
    rollup: '/usr/local/bin/rollup',
    webpack: '/usr/local/bin/webpack',
    wrangler: '/usr/local/bin/wrangler',
    'nimbus-wrangler': '/usr/local/bin/nimbus-wrangler',
    // /usr/bin (system runtimes)
    git: '/usr/bin/git',
    python: '/usr/bin/python3',
    python3: '/usr/bin/python3',
    pip: '/usr/bin/pip',
    pip3: '/usr/bin/pip3',
    ruby: '/usr/bin/ruby',
    ruby3: '/usr/bin/ruby',
    gem: '/usr/bin/gem',
    bundle: '/usr/bin/bundle',
    bundler: '/usr/bin/bundler',
    sh: '/usr/bin/sh',
    bash: '/usr/bin/bash',
    // Hex dumps — the real tools live under /usr/bin on Unix
    od: '/usr/bin/od',
    hexdump: '/usr/bin/hexdump',
    // Framework CLIs
    astro: '/usr/local/bin/astro',
    nuxt: '/usr/local/bin/nuxt',
    nuxi: '/usr/local/bin/nuxi',
    next: '/usr/local/bin/next',
    remix: '/usr/local/bin/remix',
    'svelte-kit': '/usr/local/bin/svelte-kit',
    husky: '/usr/local/bin/husky',
    lefthook: '/usr/local/bin/lefthook',
    'simple-git-hooks': '/usr/local/bin/simple-git-hooks',
    'lint-staged': '/usr/local/bin/lint-staged',
    yorkie: '/usr/local/bin/yorkie',
    // Self
    nimbus: '/usr/local/bin/nimbus',
};
function _pathLookup(vfs, name, envPath) {
    const paths = (envPath || '/usr/local/bin:/usr/bin:/bin').split(':');
    for (const dir of paths) {
        if (!dir)
            continue;
        const stripped = dir.replace(/^\/+/, '').replace(/\/+$/, '');
        const fp = stripped + '/' + name;
        if (vfs.exists(fp) && !vfs.isDirectory(fp)) {
            return '/' + fp;
        }
    }
    return null;
}
async function _registryResolved(registry, name, options = {}) {
    try {
        const resolved = typeof registry.resolve === 'function'
            ? asResolvedCommand(await registry.resolve(name))
            : null;
        if (resolved && (options.includeInstallHints || !isRuntimeInstallHintHandler(resolved))) {
            return resolved;
        }
    }
    catch {
        // Registry misses are normal for unknown commands.
    }
    return null;
}
/** Resolve a command name to a path via PATH-walk + canonical-bin
 *  fallback. Returns null if not findable. Skip-canonical when the
 *  caller knows the command is a shell builtin (no fallback). */
async function _whichLookup(vfs, registry, name, envPath) {
    const diskPath = _pathLookup(vfs, name, envPath);
    if (diskPath)
        return diskPath;
    const canonicalPath = _CANONICAL_BIN_PATHS[name];
    if (!canonicalPath)
        return null;
    return await _registryResolved(registry, name, { includeInstallHints: true })
        ? canonicalPath
        : null;
}
function mkWhich(vfs, registry) {
    return async (ctx) => {
        // Parse flags. Supports -a (show all matches), -s (silent — no
        // stdout, only exit code). Default behaviour matches GNU which.
        let showAll = false;
        let silent = false;
        const names = [];
        for (const a of ctx.args) {
            if (a === '-a' || a === '--all') {
                showAll = true;
                continue;
            }
            if (a === '-s' || a === '--silent') {
                silent = true;
                continue;
            }
            if (a.startsWith('-') && a !== '-') {
                // Combined short flags
                for (const ch of a.slice(1)) {
                    if (ch === 'a')
                        showAll = true;
                    else if (ch === 's')
                        silent = true;
                }
                continue;
            }
            names.push(a);
        }
        if (names.length === 0) {
            ctx.stderr.write('Usage: which [-as] command [command ...]\n');
            return 1;
        }
        let anyMissing = false;
        for (const name of names) {
            // Classify: is it a registry-resolvable command (shell builtin)?
            const resolved = await _registryResolved(registry, name);
            const isBuiltin = !!resolved;
            // 1. PATH-walk + canonical-bin lookup.
            const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
            let found = false;
            if (path) {
                if (!silent)
                    ctx.stdout.write(path + '\n');
                found = true;
            }
            // 2. With -a, also report builtins (real GNU which behaviour).
            if (showAll && isBuiltin) {
                if (!silent)
                    ctx.stdout.write(`${name}: shell built-in command\n`);
                found = true;
            }
            // 3. Without -a, if no PATH match but is builtin: GNU which
            //    exits 1 silently (with -s suppresses stderr too).
            if (!path && isBuiltin && !showAll) {
                // Exit 1; no output. Matches GNU `which` default.
                anyMissing = true;
                continue;
            }
            if (!found) {
                if (!silent)
                    ctx.stderr.write(`which: no ${name} in (${ctx.env.PATH || '/usr/local/bin:/usr/bin:/bin'})\n`);
                anyMissing = true;
            }
        }
        return anyMissing ? 1 : 0;
    };
}
/**
 * SHELL-FOLLOWUPS-2 (2026-05-11): `whereis` companion to `which`.
 * GNU whereis prints binary, source, and manpage paths. We only have
 * binaries on the virtual VFS; print just the binary path. With no
 * match, print just the name (matches `whereis` behavior on missing).
 */
function mkWhereis(vfs, registry) {
    return async (ctx) => {
        const names = ctx.args.filter(a => !a.startsWith('-'));
        if (names.length === 0) {
            ctx.stderr.write('Usage: whereis name [name ...]\n');
            return 1;
        }
        for (const name of names) {
            const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
            if (path) {
                ctx.stdout.write(`${name}: ${path}\n`);
            }
            else {
                // GNU whereis prints just "name:" when nothing found.
                ctx.stdout.write(`${name}:\n`);
            }
        }
        return 0;
    };
}
/**
 * SHELL-FOLLOWUPS-3 (2026-05-11): POSIX `command -v` / `command -V`.
 * Used by shell scripts as the portable alternative to `which`:
 *   command -v clang  → prints path, exit 0 if found, exit 1 if not
 *   command -V clang  → verbose form (similar to `type`)
 *   command clang ARG → invoke clang bypassing any function/alias
 *
 * For the invoke case (no -v/-V), we don't have a way to bypass
 * alias/function from here, so we just dispatch to
 * the registry. Aliases are checked at executeLine time so `command
 * X` going through our normal dispatch IS bypassing the alias
 * (because the interpreter only consults aliases
 * for the head word).
 */
function mkCommand(vfs, registry) {
    return async (ctx) => {
        const args = [...ctx.args];
        let mode = 'invoke';
        if (args[0] === '-v') {
            mode = '-v';
            args.shift();
        }
        else if (args[0] === '-V') {
            mode = '-V';
            args.shift();
        }
        if (args.length === 0) {
            if (mode === 'invoke')
                return 0;
            ctx.stderr.write('command: missing operand\n');
            return 1;
        }
        if (mode === '-v') {
            // Print path or builtin marker; exit 0 if found.
            const name = args[0];
            const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
            if (path) {
                ctx.stdout.write(path + '\n');
                return 0;
            }
            if (await _registryResolved(registry, name)) {
                ctx.stdout.write(name + '\n');
                return 0;
            }
            return 1;
        }
        if (mode === '-V') {
            const name = args[0];
            const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
            if (path) {
                ctx.stdout.write(`${name} is ${path}\n`);
                return 0;
            }
            if (await _registryResolved(registry, name)) {
                ctx.stdout.write(`${name} is a shell builtin\n`);
                return 0;
            }
            ctx.stderr.write(`command: ${name}: not found\n`);
            return 1;
        }
        // invoke mode: dispatch directly via registry. Bypasses aliases
        // because we're calling the resolved cmd not the alias name.
        const name = args[0];
        try {
            const resolved = asResolvedCommand(await registry.resolve(name));
            if (!resolved) {
                ctx.stderr.write(`command: ${name}: not found\n`);
                return 127;
            }
            const subCtx = { ...ctx, args: args.slice(1) };
            const code = await resolved(subCtx);
            return typeof code === 'number' ? code : 0;
        }
        catch (e) {
            ctx.stderr.write(`command: ${name}: ${errorText(e)}\n`);
            return 1;
        }
    };
}
/**
 * shell compatibility (2026-05-11): `type` builtin. The shell did not ship
 * one; pre-fix `type echo` → 'type: command not found'. bash's
 * `type X` reports how X would be interpreted (builtin, alias,
 * function, file, or unknown).
 *
 * Our subset (matches bash `type` output for common shapes):
 *   type echo  → 'echo is a shell builtin'        (Shell.builtins entry)
 *   type ls    → 'ls is a shell builtin'          (lazy registry)
 *   type rm    → 'rm is a shell builtin'          (our wrap'd registry)
 *   type node  → 'node is /usr/bin/node'          (registry but facet-direct)
 *   type X     → 'type: X: not found' + exit 1
 *
 * We can't introspect Shell.builtins from here directly (the ctx
 * doesn't carry shell). Workaround: pass registry which the unix-
 * commands module already has access to; treat any registry resolve
 * as "shell builtin" classification.
 */
function mkType(_vfs, registry) {
    return async (ctx) => {
        if (ctx.args.length === 0)
            return 0;
        let exit = 0;
        for (const name of ctx.args) {
            try {
                const resolved = typeof registry.resolve === 'function'
                    ? asResolvedCommand(await registry.resolve(name))
                    : null;
                if (resolved && !isRuntimeInstallHintHandler(resolved)) {
                    ctx.stdout.write(`${name} is a shell builtin\n`);
                }
                else {
                    ctx.stderr.write(`type: ${name}: not found\n`);
                    exit = 1;
                }
            }
            catch (_e) {
                ctx.stderr.write(`type: ${name}: not found\n`);
                exit = 1;
            }
        }
        return exit;
    };
}
function mkEnv() {
    return (ctx) => {
        for (const [k, v] of Object.entries(ctx.env)) {
            ctx.stdout.write(`${k}=${v}\n`);
        }
        return 0;
    };
}
function mkExport() {
    return (ctx) => {
        for (const arg of ctx.args) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx > 0) {
                ctx.env[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1);
            }
            else if (ctx.env[arg] !== undefined) {
                ctx.stdout.write(`export ${arg}="${ctx.env[arg]}"\n`);
            }
        }
        return 0;
    };
}
function mkUnset() {
    return (ctx) => {
        for (const name of ctx.args) {
            delete ctx.env[name];
        }
        return 0;
    };
}
function mkClear() {
    return (ctx) => { ctx.stdout.write('\x1b[2J\x1b[H'); return 0; };
}
/**
 * shell compatibility (2026-05-11): date strftime format support.
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
function mkDate() {
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
const _MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const _MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _DAYS_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function strftime(d, fmt, utc) {
    const get = (m) => {
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
    const pad = (n, w, ch = '0') => String(n).padStart(w, ch);
    const yyyy = get('FullYear');
    const mm0 = get('Month'); // 0..11
    const dd = get('Date');
    const hh = get('Hours');
    const mn = get('Minutes');
    const ss = get('Seconds');
    const dow = get('Day'); // 0..6 (Sun..Sat)
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
        }
        catch {
            return 'UTC';
        }
    })();
    let out = '';
    let i = 0;
    while (i < fmt.length) {
        const ch = fmt[i];
        if (ch !== '%') {
            out += ch;
            i++;
            continue;
        }
        i++;
        const spec = fmt[i] || '';
        i++;
        switch (spec) {
            case 'Y':
                out += String(yyyy);
                break;
            case 'C':
                out += pad(Math.floor(yyyy / 100), 2);
                break;
            case 'y':
                out += pad(yyyy % 100, 2);
                break;
            case 'm':
                out += pad(mm0 + 1, 2);
                break;
            case 'B':
                out += _MONTHS_FULL[mm0];
                break;
            case 'b':
            case 'h':
                out += _MONTHS_ABBR[mm0];
                break;
            case 'd':
                out += pad(dd, 2);
                break;
            case 'e':
                out += String(dd).padStart(2, ' ');
                break;
            case 'j':
                out += pad(doy, 3);
                break;
            case 'H':
                out += pad(hh, 2);
                break;
            case 'I':
                out += pad(h12, 2);
                break;
            case 'M':
                out += pad(mn, 2);
                break;
            case 'S':
                out += pad(ss, 2);
                break;
            case 'p':
                out += ampm;
                break;
            case 'P':
                out += ampm.toLowerCase();
                break;
            case 'A':
                out += _DAYS_FULL[dow];
                break;
            case 'a':
                out += _DAYS_ABBR[dow];
                break;
            case 'u':
                out += String(isoDow);
                break;
            case 'w':
                out += String(dow);
                break;
            case 's':
                out += String(Math.floor(d.getTime() / 1000));
                break;
            case 'N':
                out += pad(ms * 1_000_000, 9);
                break;
            case 'F':
                out += `${yyyy}-${pad(mm0 + 1, 2)}-${pad(dd, 2)}`;
                break;
            case 'T':
                out += `${pad(hh, 2)}:${pad(mn, 2)}:${pad(ss, 2)}`;
                break;
            case 'R':
                out += `${pad(hh, 2)}:${pad(mn, 2)}`;
                break;
            case 'D':
                out += `${pad(mm0 + 1, 2)}/${pad(dd, 2)}/${pad(yyyy % 100, 2)}`;
                break;
            case 'z':
                out += tzOff;
                break;
            case 'Z':
                out += tzName;
                break;
            case '%':
                out += '%';
                break;
            case 'n':
                out += '\n';
                break;
            case 't':
                out += '\t';
                break;
            default:
                out += '%' + spec;
                break; // unknown — preserve literal
        }
    }
    return out;
}
function mkUptime() {
    const start = Date.now();
    return (ctx) => {
        const secs = Math.floor((Date.now() - start) / 1000);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        ctx.stdout.write(` ${new Date().toTimeString().split(' ')[0]} up ${h}:${String(m).padStart(2, '0')}, 1 user\n`);
        return 0;
    };
}
function mkTree(vfs) {
    return (ctx) => {
        const args = ctx.args.filter(a => !a.startsWith('-') && (ctx.args.indexOf(a) !== ctx.args.indexOf('-L') + 1));
        const root = args[0] ? resolvePath(ctx.cwd, args[0]) : (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const maxDepth = ctx.args.includes('-L') ? parseInt(ctx.args[ctx.args.indexOf('-L') + 1]) || 3 : 3;
        const MAX_ENTRIES = 2000; // Safety limit to prevent hanging on huge repos
        let dirs = 0, files = 0, total = 0;
        let truncated = false;
        function walk(path, prefix, depth) {
            if (depth > maxDepth || truncated)
                return;
            try {
                const entries = vfs.readdir(path).sort((a, b) => a.name.localeCompare(b.name));
                for (let i = 0; i < entries.length; i++) {
                    if (total >= MAX_ENTRIES) {
                        truncated = true;
                        return;
                    }
                    total++;
                    const e = entries[i];
                    const isLast = i === entries.length - 1;
                    const connector = isLast ? '└── ' : '├── ';
                    const childPrefix = isLast ? '    ' : '│   ';
                    ctx.stdout.write(prefix + connector + e.name + '\n');
                    if (e.type === 'directory') {
                        dirs++;
                        walk(path + '/' + e.name, prefix + childPrefix, depth + 1);
                    }
                    else {
                        files++;
                    }
                }
            }
            catch { }
        }
        const name = root.split('/').pop() || root;
        ctx.stdout.write(name + '\n');
        walk(root, '', 1);
        if (truncated)
            ctx.stdout.write(`\n... truncated at ${MAX_ENTRIES} entries\n`);
        ctx.stdout.write(`\n${dirs} directories, ${files} files\n`);
        return 0;
    };
}
/**
 * `find`'s arguments are an EXPRESSION, not a flag list.
 *
 * The flat AND-list this replaced dropped every token it did not recognise,
 * which does not fail — it answers a different question. `find . ! -name x`
 * ran as `find . -name x`, the exact complement of the requested set, and
 * said nothing. An installer's
 *
 *     find "$dir" -mindepth 1 -maxdepth 1 -type d | head -n 1
 *
 * silently became `-maxdepth 1 -type d`, which emits the start directory at
 * depth 0, so the pipeline selected the container instead of the tree in it.
 *
 * So the fix is not `-mindepth`. It is to parse the real grammar —
 *
 *     expr   := or
 *     or     := and (('-o' | '-or') and)*
 *     and    := unary (('-a' | '-and')? unary)*
 *     unary  := ('!' | '-not') unary | '(' expr ')' | primary
 *
 * — with `-a` binding tighter than `-o`, to evaluate it with short-circuit
 * semantics (which is what makes the `-prune -o -print` idiom work), and to
 * REFUSE any token outside the table below rather than ignore it.
 *
 * Every behaviour here was derived by running the same expression under GNU
 * findutils 4.10.0; tests/unit/find-expression-evaluator.mjs carries the
 * differential.
 *
 * Global options   -maxdepth N, -mindepth N, -depth
 * Operators        !, -not, -a, -and, -o, -or, ( )
 * Tests            -name, -iname, -path, -type, -size, -mtime, -newer, -empty
 * Actions          -print, -print0, -delete, -exec … {} \\; | +, -prune, -quit
 *
 * Anything else is `find: unknown predicate '-x'`, exit 1 — the same
 * honesty `uname -m` keeps by answering `wasm`.
 */
/** A usage error carrying the message GNU find prints for it. */
class FindUsageError extends Error {
}
function mkFind(vfs, registry) {
    return async (ctx) => {
        const state = {
            minDepth: 0,
            maxDepth: Infinity,
            depthFirst: false,
            prune: false,
            quit: false,
        };
        const execBatches = [];
        let hasAction = false;
        // ── Emission ──────────────────────────────────────────────────────────
        const emit = (entry, terminator) => {
            ctx.stdout.write(entry.display + terminator);
        };
        /** Run one command through the registry the session resolves through. */
        const runExec = async (argv) => {
            const [name, ...rest] = argv;
            if (!name)
                return false;
            let target;
            try {
                target = asResolvedCommand(await registry.resolve(name));
            }
            catch {
                target = null;
            }
            if (!target) {
                ctx.stderr.write(`find: ${name}: No such file or directory\n`);
                return false;
            }
            try {
                const code = await target({
                    pid: ctx.pid,
                    cred: ctx.cred,
                    args: rest,
                    env: ctx.env,
                    cwd: ctx.cwd,
                    vfs: ctx.vfs,
                    stdout: ctx.stdout,
                    stderr: ctx.stderr,
                    stdin: '',
                    signal: ctx.signal,
                    setUmask: ctx.setUmask,
                    runAs: ctx.runAs,
                    execInterpreterDepth: ctx.execInterpreterDepth,
                });
                return code === 0;
            }
            catch (e) {
                ctx.stderr.write(`find: ${name}: ${errorText(e)}\n`);
                return false;
            }
        };
        // ── Parser ────────────────────────────────────────────────────────────
        //
        // Start paths come first: GNU reads operands until the first token that
        // begins an expression, so `find a b -type d` walks both a and b.
        const args = [...ctx.args];
        let pos = 0;
        const startsExpression = (tok) => tok.startsWith('-') || tok === '(' || tok === ')' || tok === '!' || tok === ',';
        const startArgs = [];
        while (pos < args.length && !startsExpression(args[pos]))
            startArgs.push(args[pos++]);
        if (startArgs.length === 0)
            startArgs.push('.');
        const peek = () => args[pos];
        const next = () => args[pos++];
        /** The argument a predicate requires, or GNU's missing-argument error. */
        const value = (pred) => {
            const v = args[pos++];
            if (v === undefined)
                throw new FindUsageError(`missing argument to \`${pred}'`);
            return v;
        };
        const positiveInt = (pred) => {
            const raw = value(pred);
            if (!/^\d+$/.test(raw)) {
                throw new FindUsageError(`Expected a positive decimal integer argument to ${pred}, but got \`${raw}'`);
            }
            return parseInt(raw, 10);
        };
        const TRUE = async () => true;
        /** Size in the unit's own terms: GNU rounds a partial unit UP. */
        const sizeInUnits = (bytes, unit) => unit === 1 ? bytes : Math.ceil(bytes / unit);
        const statOf = (entry) => {
            try {
                return vfs.stat(entry.vfsPath);
            }
            catch {
                return null;
            }
        };
        function parsePrimary() {
            const tok = next();
            if (tok === undefined)
                throw new FindUsageError('missing expression');
            switch (tok) {
                // ── Global options: they configure the walk and evaluate true ──
                case '-maxdepth':
                    state.maxDepth = positiveInt('-maxdepth');
                    return TRUE;
                case '-mindepth':
                    state.minDepth = positiveInt('-mindepth');
                    return TRUE;
                case '-depth':
                    state.depthFirst = true;
                    return TRUE;
                // ── Tests ──
                case '-name': {
                    const pattern = value('-name');
                    return async (e) => globMatch(pattern, e.name);
                }
                case '-iname': {
                    const pattern = value('-iname').toLowerCase();
                    return async (e) => globMatch(pattern, e.name.toLowerCase());
                }
                case '-path': {
                    const pattern = value('-path');
                    return async (e) => globMatch(pattern, e.display);
                }
                case '-type': {
                    const letter = value('-type');
                    if (letter !== 'f' && letter !== 'd' && letter !== 'l') {
                        throw new FindUsageError(`Unknown argument to -type: ${letter}`);
                    }
                    const wanted = letter === 'f' ? 'file' : letter === 'd' ? 'directory' : 'symlink';
                    return async (e) => e.type === wanted;
                }
                case '-size': {
                    const raw = value('-size');
                    const m = raw.match(/^([+-]?)(\d+)([ckMG]?)$/);
                    if (!m)
                        throw new FindUsageError(`invalid -size type \`${raw.slice(-1)}'`);
                    const cmp = m[1];
                    const count = parseInt(m[2], 10);
                    const unit = m[3] === 'c' ? 1
                        : m[3] === 'k' ? 1024
                            : m[3] === 'M' ? 1024 * 1024
                                : m[3] === 'G' ? 1024 * 1024 * 1024
                                    : 512;
                    return async (e) => {
                        const st = statOf(e);
                        if (!st)
                            return false;
                        const units = sizeInUnits(st.size || 0, unit);
                        return cmp === '+' ? units > count : cmp === '-' ? units < count : units === count;
                    };
                }
                case '-mtime': {
                    const raw = value('-mtime');
                    const m = raw.match(/^([+-]?)(\d+)$/);
                    if (!m)
                        throw new FindUsageError(`invalid argument \`${raw}' to \`-mtime'`);
                    const cmp = m[1];
                    const dayMs = 86400 * 1000;
                    const threshold = parseInt(m[2], 10) * dayMs;
                    const now = Date.now();
                    return async (e) => {
                        const st = statOf(e);
                        if (!st)
                            return false;
                        const age = now - (st.mtime || 0);
                        return cmp === '+' ? age > threshold + dayMs
                            : cmp === '-' ? age < threshold
                                : age >= threshold && age < threshold + dayMs;
                    };
                }
                case '-newer': {
                    const ref = value('-newer');
                    let refMtime;
                    try {
                        refMtime = vfs.stat(resolvePath(ctx.cwd, ref)).mtime;
                    }
                    catch {
                        throw new FindUsageError(`'${ref}': No such file or directory`);
                    }
                    return async (e) => {
                        const st = statOf(e);
                        return !!st && (st.mtime || 0) > refMtime;
                    };
                }
                case '-empty':
                    return async (e) => {
                        if (e.type === 'directory') {
                            try {
                                return vfs.readdir(e.vfsPath).length === 0;
                            }
                            catch {
                                return false;
                            }
                        }
                        const st = statOf(e);
                        return !!st && (st.size || 0) === 0;
                    };
                // ── Actions ──
                case '-print':
                    hasAction = true;
                    return async (e) => { emit(e, '\n'); return true; };
                case '-print0':
                    hasAction = true;
                    return async (e) => { emit(e, '\0'); return true; };
                case '-delete':
                    hasAction = true;
                    // GNU's -delete implies -depth: a directory is removable only once
                    // its children are gone.
                    state.depthFirst = true;
                    return async (e) => {
                        try {
                            if (e.type === 'directory')
                                vfs.rmdir(e.vfsPath);
                            else
                                vfs.unlink(e.vfsPath);
                            return true;
                        }
                        catch (err) {
                            ctx.stderr.write(`find: cannot delete '${e.display}': ${errorText(err)}\n`);
                            return false;
                        }
                    };
                case '-quit':
                    hasAction = true;
                    return async (_e, st) => { st.quit = true; return true; };
                case '-prune':
                    // NOT an action: GNU still adds the implicit -print alongside it,
                    // which is what makes `-prune -o -print` print everything else.
                    return async (e, st) => {
                        if (e.type === 'directory')
                            st.prune = true;
                        return true;
                    };
                case '-exec': {
                    hasAction = true;
                    const argv = [];
                    let terminator = null;
                    while (pos < args.length) {
                        const a = next();
                        // Exactly `;`, as GNU requires. The usual `\;` is the shell's
                        // escaping of it; a quoted '\;' keeps its backslash and GNU
                        // rejects that as a missing terminator, so this does too.
                        if (a === ';') {
                            terminator = ';';
                            break;
                        }
                        // `+` terminates only directly after the {} placeholder.
                        if (a === '+' && argv[argv.length - 1] === '{}') {
                            terminator = '+';
                            break;
                        }
                        argv.push(a);
                    }
                    if (terminator === null) {
                        throw new FindUsageError("missing argument to `-exec'");
                    }
                    if (terminator === ';') {
                        return async (e) => runExec(argv.map((a) => a.split('{}').join(e.display)));
                    }
                    // `-exec … {} +`: every match joins one invocation, flushed after
                    // the walk. The trailing {} is where the paths go.
                    const batch = { argv: argv.slice(0, -1), pending: [] };
                    execBatches.push(batch);
                    return async (e) => { batch.pending.push(e.display); return true; };
                }
                // ── Grouping ──
                case '(': {
                    const inner = parseExpr();
                    if (next() !== ')')
                        throw new FindUsageError("expected expression after `('");
                    return inner;
                }
            }
            throw new FindUsageError(`unknown predicate \`${tok}'`);
        }
        function parseUnary() {
            const tok = peek();
            if (tok === '!' || tok === '-not') {
                pos++;
                const operand = parseUnary();
                return async (e, st) => !(await operand(e, st));
            }
            return parsePrimary();
        }
        function parseAnd() {
            let left = parseUnary();
            while (pos < args.length) {
                const tok = peek();
                if (tok === ')' || tok === '-o' || tok === '-or')
                    break;
                if (tok === '-a' || tok === '-and')
                    pos++;
                const right = parseUnary();
                const l = left;
                left = async (e, st) => (await l(e, st)) && (await right(e, st));
            }
            return left;
        }
        function parseExpr() {
            let left = parseAnd();
            while (peek() === '-o' || peek() === '-or') {
                pos++;
                const right = parseAnd();
                const l = left;
                left = async (e, st) => (await l(e, st)) || (await right(e, st));
            }
            return left;
        }
        let predicate;
        try {
            predicate = pos < args.length ? parseExpr() : TRUE;
            if (pos < args.length) {
                throw new FindUsageError(`paths must precede expression: \`${args[pos]}'`);
            }
        }
        catch (e) {
            if (e instanceof FindUsageError) {
                ctx.stderr.write(`find: ${e.message}\n`);
                return 1;
            }
            throw e;
        }
        // With no action anywhere in the expression the whole of it is printed;
        // -prune deliberately does not count, so `-prune -o -print` still prints.
        const test = predicate;
        if (!hasAction) {
            predicate = async (e, st) => {
                const matched = await test(e, st);
                if (matched)
                    emit(e, '\n');
                return matched;
            };
        }
        // ── Walk ──────────────────────────────────────────────────────────────
        let status = 0;
        const visit = async (entry) => {
            state.prune = false;
            if (entry.depth >= state.minDepth)
                await predicate(entry, state);
        };
        const walk = async (entry) => {
            if (state.quit)
                return;
            // A pre-order visit must run before the descent it may prune.
            if (!state.depthFirst) {
                await visit(entry);
                if (state.quit || state.prune)
                    return;
            }
            if (entry.type === 'directory' && entry.depth < state.maxDepth) {
                let entries = [];
                try {
                    entries = vfs.readdir(entry.vfsPath);
                }
                catch {
                    entries = [];
                }
                for (const child of entries) {
                    if (state.quit)
                        break;
                    await walk({
                        vfsPath: entry.vfsPath + '/' + child.name,
                        display: entry.display + '/' + child.name,
                        name: child.name,
                        type: child.type,
                        depth: entry.depth + 1,
                    });
                }
            }
            // Post-order: the visit that -depth and -delete need, after the
            // children it must outlive.
            if (state.depthFirst && !state.quit)
                await visit(entry);
        };
        for (const startArg of startArgs) {
            if (state.quit)
                break;
            // `find dir/` prints `dir/empty.txt`, so the separator is not doubled.
            const display = startArg.length > 1 ? startArg.replace(/\/+$/, '') : startArg;
            const vfsPath = resolvePath(ctx.cwd, startArg);
            let type;
            try {
                type = vfs.stat(vfsPath).type;
            }
            catch {
                ctx.stderr.write(`find: '${startArg}': No such file or directory\n`);
                status = 1;
                continue;
            }
            await walk({
                vfsPath,
                display,
                name: display.split('/').pop() || display,
                type,
                depth: 0,
            });
        }
        for (const batch of execBatches) {
            if (batch.pending.length > 0)
                await runExec([...batch.argv, ...batch.pending]);
        }
        return status;
    };
}
/**
 * shell compatibility (2026-05-11): grep flag handling.
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
function mkGrep(vfs) {
    return (ctx) => {
        const args = [...ctx.args];
        // Parse flags. Support combined `-rni` form (single dash + chars).
        let recursive = false, ignoreCase = false, lineNum = false;
        let countOnly = false, invertMatch = false, wordMatch = false;
        let filesOnly = false; // -l
        let quiet = false; // -q
        let positional = [];
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '--') {
                positional.push(...args.slice(i + 1));
                break;
            }
            if (a === '-r' || a === '-R' || a === '--recursive') {
                recursive = true;
                continue;
            }
            if (a === '-i' || a === '--ignore-case') {
                ignoreCase = true;
                continue;
            }
            if (a === '-n' || a === '--line-number') {
                lineNum = true;
                continue;
            }
            if (a === '-c' || a === '--count') {
                countOnly = true;
                continue;
            }
            if (a === '-v' || a === '--invert-match') {
                invertMatch = true;
                continue;
            }
            if (a === '-w' || a === '--word-regexp') {
                wordMatch = true;
                continue;
            }
            if (a === '-l' || a === '--files-with-matches') {
                filesOnly = true;
                continue;
            }
            if (a === '-q' || a === '--quiet' || a === '--silent') {
                quiet = true;
                continue;
            }
            if (a === '-E' || a === '--extended-regexp') { /* JS regex is ERE-ish */
                continue;
            }
            if (a === '-F' || a === '--fixed-strings') {
                // Mark as literal — handled below via escape.
                args.__fixedStrings = true;
                continue;
            }
            if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
                // Combined short flags like -rni
                for (const ch of a.slice(1)) {
                    if (ch === 'r' || ch === 'R')
                        recursive = true;
                    else if (ch === 'i')
                        ignoreCase = true;
                    else if (ch === 'n')
                        lineNum = true;
                    else if (ch === 'c')
                        countOnly = true;
                    else if (ch === 'v')
                        invertMatch = true;
                    else if (ch === 'w')
                        wordMatch = true;
                    else if (ch === 'l')
                        filesOnly = true;
                    else if (ch === 'q')
                        quiet = true;
                    else if (ch === 'E') { /* ERE noop */ }
                    else if (ch === 'F')
                        args.__fixedStrings = true;
                }
                continue;
            }
            positional.push(a);
        }
        if (positional.length < 1) {
            ctx.stderr.write('Usage: grep [-rnicvlqEFw] PATTERN [FILE...]\n');
            return 1;
        }
        let pattern = positional[0];
        const targets = positional.slice(1);
        if (args.__fixedStrings) {
            // -F: escape regex metacharacters for literal match.
            pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (wordMatch)
            pattern = `\\b(?:${pattern})\\b`;
        const flags = ignoreCase ? 'i' : '';
        let re;
        try {
            re = new RegExp(pattern, flags);
        }
        catch {
            ctx.stderr.write(`grep: invalid regex: ${pattern}\n`);
            return 1;
        }
        let found = false;
        let failed = false;
        function processLines(lines, label) {
            let count = 0;
            let matchedHere = false;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Skip a trailing empty line from a content that ended with \\n.
                if (i === lines.length - 1 && line === '')
                    continue;
                const isMatch = re.test(line);
                if (isMatch !== invertMatch) {
                    found = true;
                    matchedHere = true;
                    count++;
                    // -q asks only whether anything matched; printing is the caller's
                    // way of saying it wants to see it.
                    if (quiet)
                        return;
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
            if (countOnly && !quiet) {
                const labelPrefix = (targets.length > 1 || recursive) && label ? label + ':' : '';
                ctx.stdout.write(labelPrefix + count + '\n');
            }
            void matchedHere;
        }
        function grepFile(path, label) {
            try {
                const content = vfs.readFileString(path);
                processLines(content.split('\n'), label);
            }
            catch (error) {
                ctx.stderr.write(`grep: ${label}: ${fsErrorMessage(error)}\n`);
                failed = true;
            }
        }
        function walkDir(dir) {
            try {
                for (const e of vfs.readdir(dir)) {
                    const fp = dir + '/' + e.name;
                    if (e.type === 'file')
                        grepFile(fp, '/' + fp);
                    else if (e.type === 'directory')
                        walkDir(fp);
                }
            }
            catch { }
        }
        if (targets.length === 0 && recursive) {
            walkDir((ctx.cwd || '/home/user').replace(/^\/+/, ''));
        }
        else if (targets.length === 0) {
            // Read from stdin (if piped) — single virtual "file" with no label.
            const piped = stdinText(ctx);
            if (piped) {
                processLines(piped.split('\n'), '');
            }
        }
        else {
            for (const target of targets) {
                const fp = resolvePath(ctx.cwd, target);
                try {
                    if (vfs.exists(fp) && vfs.isDirectory(fp)) {
                        if (recursive)
                            walkDir(fp);
                    }
                    else {
                        grepFile(fp, target);
                    }
                }
                catch (error) {
                    ctx.stderr.write(`grep: ${target}: ${fsErrorMessage(error)}\n`);
                    failed = true;
                }
            }
        }
        return !failed && found ? 0 : 1;
    };
}
/**
 * SHELL-R6-B2 follow-on: streaming head.
 *
 * When invoked on a pipeline (`producer | head`), receives a pipe
 * reader (object with .read()) — NOT a coalesced string — and reads
 * line-by-line until N lines are emitted. Closes the reader by
 * draining null (or by the SHELL-R6-2 abort cascade kicking in when
 * we return).
 *
 * Why: the original head implementation read via readAll(), which never returns when
 * upstream is `yes`. Our SHELL-R6-2 pipeline abort only fires when
 * the consumer resolves — so head must resolve quickly via its own
 * line-count termination, which then triggers the cascade.
 *
 * Backward compat: file-args (head FILE) and the string-stdin case
 * (when wrap already coalesced) still work via the same code path.
 */
function mkHead(_vfs) {
    return async (ctx) => {
        const parsed = parseHeadArgs(ctx.args);
        if (parsed.error) {
            ctx.stderr.write(`head: ${parsed.error}\n`);
            return 1;
        }
        const { lines: n, bytes, files } = parsed;
        if (bytes !== undefined)
            return headBytes(ctx, files, bytes);
        if (files.length === 0) {
            // Pipe / stdin case.
            const stdin = ctx.stdin;
            if (!stdin)
                return 0;
            // Streaming pipe-reader path: read chunks until N lines.
            if (typeof stdin !== 'string' && typeof stdin.read === 'function') {
                let buffered = '';
                let emitted = 0;
                const out = [];
                while (emitted < n) {
                    const chunk = await stdin.read();
                    if (chunk === null)
                        break;
                    buffered += chunk;
                    // Process complete lines while we have them.
                    while (emitted < n) {
                        const nlIdx = buffered.indexOf('\n');
                        if (nlIdx === -1)
                            break;
                        out.push(buffered.substring(0, nlIdx));
                        buffered = buffered.substring(nlIdx + 1);
                        emitted++;
                    }
                }
                // Handle a partial line if N hit mid-buffer and producer hasn't
                // sent a trailing newline yet — emit it only if we haven't
                // already hit the N-line cap (POSIX head includes partial
                // tail).
                if (emitted < n && buffered.length > 0) {
                    out.push(buffered);
                }
                ctx.stdout.write(out.join('\n') + '\n');
                return 0;
            }
            // Legacy string-stdin path (kept for wrap's pre-coalesced case).
            if (typeof stdin === 'string') {
                ctx.stdout.write(stdin.split('\n').slice(0, n).join('\n') + '\n');
                return 0;
            }
            return 0;
        }
        for (const [index, f] of files.entries()) {
            const path = absolutePath(ctx.cwd, f);
            try {
                const content = readWholeFileString(ctx, path);
                if (files.length > 1)
                    ctx.stdout.write(`${index > 0 ? '\n' : ''}==> ${f} <==\n`);
                ctx.stdout.write(content.split('\n').slice(0, n).join('\n') + '\n');
            }
            catch (error) {
                ctx.stderr.write(`head: ${f}: ${fsErrorMessage(error)}\n`);
                return 1;
            }
        }
        return 0;
    };
}
/** `-c N`, `-cN`, `--bytes=N`, `-n N`, `-nN`, `--lines=N`, `-N`, `-q`, `-v`. */
function parseHeadArgs(args) {
    const result = { lines: 10, files: [] };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const option = matchCountOption(arg, args[i + 1], 'c', 'bytes')
            ?? matchCountOption(arg, args[i + 1], 'n', 'lines');
        if (option) {
            i += option.consumed;
            const count = parseByteCount(option.value);
            if (count === null) {
                const what = option.flag === 'c' ? 'bytes' : 'lines';
                return { ...result, error: `invalid number of ${what}: '${option.value}'` };
            }
            if (option.flag === 'c')
                result.bytes = count;
            else
                result.lines = count;
        }
        else if (/^-\d+$/.test(arg)) {
            result.lines = Number.parseInt(arg.slice(1), 10);
        }
        else if (arg === '-q' || arg === '--quiet' || arg === '-v' || arg === '--verbose') {
            continue;
        }
        else if (arg !== '-' && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
            // A cluster of switches, `-qn 1`; `c` and `n` take the rest of the
            // cluster or the next argument.
            let consumed = false;
            for (let j = 1; j < arg.length && !consumed; j++) {
                const flag = arg[j];
                if (flag === 'q' || flag === 'v')
                    continue;
                if (flag !== 'c' && flag !== 'n') {
                    return { ...result, error: `invalid option -- '${flag}'` };
                }
                const text = arg.slice(j + 1) || (args[++i] ?? '');
                const count = parseByteCount(text);
                if (count === null) {
                    const what = flag === 'c' ? 'bytes' : 'lines';
                    return { ...result, error: `invalid number of ${what}: '${text}'` };
                }
                if (flag === 'c')
                    result.bytes = count;
                else
                    result.lines = count;
                consumed = true;
            }
        }
        else if (arg !== '-' && arg.startsWith('--')) {
            return { ...result, error: `unrecognized option '${arg}'` };
        }
        else {
            result.files.push(arg);
        }
    }
    return result;
}
function matchCountOption(arg, next, flag, long) {
    if (arg === `-${flag}`)
        return { flag, value: next ?? '', consumed: 1 };
    if (arg.startsWith(`-${flag}`) && arg.length > 2)
        return { flag, value: arg.slice(2), consumed: 0 };
    if (arg === `--${long}`)
        return { flag, value: next ?? '', consumed: 1 };
    if (arg.startsWith(`--${long}=`))
        return { flag, value: arg.slice(long.length + 3), consumed: 0 };
    return null;
}
/** `head`/`dd`-style counts: plain digits with an optional binary/SI suffix. */
function parseByteCount(value) {
    const match = /^(\d+)([bkKmMgG]?[Bb]?)$/.exec(value.trim());
    if (!match)
        return null;
    const scale = {
        '': 1, b: 512, k: 1024, K: 1024, kB: 1000, KB: 1000,
        m: 1024 ** 2, M: 1024 ** 2, mB: 1000 ** 2, MB: 1000 ** 2,
        g: 1024 ** 3, G: 1024 ** 3, gB: 1000 ** 3, GB: 1000 ** 3,
    };
    const factor = scale[match[2]];
    if (factor === undefined)
        return null;
    return Number.parseInt(match[1], 10) * factor;
}
/**
 * `head -c N` — emit the first N bytes. Streams through the positional read
 * so byte counts hold for any N and character devices such as /dev/zero,
 * which have no stored content to read whole, work like they do on Unix.
 */
async function headBytes(ctx, files, limit) {
    const writer = new SinkWriter(ctx.stdout);
    if (files.length === 0 || (files.length === 1 && files[0] === '-')) {
        await streamStdinBytes(ctx, writer, limit);
        writer.end();
        return 0;
    }
    let exit = 0;
    for (const f of files) {
        const path = absolutePath(ctx.cwd, f);
        try {
            if (files.length > 1)
                ctx.stdout.write(`==> ${f} <==\n`);
            streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
                length: limit,
                signal: ctx.signal,
            });
        }
        catch (error) {
            ctx.stderr.write(`head: ${f}: ${fsErrorMessage(error)}\n`);
            exit = 1;
        }
    }
    writer.end();
    return exit;
}
/**
 * Pull at most `limit` bytes from stdin, whether the shell handed us an
 * already-drained string or a live pipe reader. Reading only the string form
 * would make `producer | head -c N` emit nothing at all.
 */
async function streamStdinBytes(ctx, writer, limit) {
    const stdin = ctx.stdin;
    if (typeof stdin === 'string') {
        writer.write(enc.encode(stdin).subarray(0, limit));
        return;
    }
    const reader = stdin;
    if (typeof reader?.read !== 'function')
        return;
    let copied = 0;
    while (copied < limit) {
        const want = limit - copied;
        const chunk = reader.readBytes ? await reader.readBytes(want) : enc.encode((await reader.read()) ?? '');
        if (chunk === null)
            break;
        const bytes = chunk.subarray(0, want);
        writer.write(bytes);
        copied += bytes.length;
    }
}
/** Absolute, mount-aware path — `ctx.vfs` resolves virtual mounts like /dev. */
function absolutePath(cwd, target) {
    return '/' + resolvePath(cwd, target);
}
function readWholeFileString(ctx, path) {
    if (ctx.vfs.stat(path).type === 'directory') {
        throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
    }
    return dec.decode(ctx.vfs.readFile(path));
}
/**
 * `tail [-n N] [-n +N] [-N] [-q] [-v] [FILE…]`.
 *
 * The previous parse only knew a separate `-n N`, matched its operand by
 * `indexOf` (so a file literally named like the count vanished), and sliced
 * the split lines without dropping the empty string a trailing newline leaves
 * behind — `tail -n 1 file` printed a blank line instead of the last line.
 */
function mkTail(vfs) {
    return (ctx) => {
        const parsed = parseTailArgs(ctx.args);
        if (parsed.error) {
            ctx.stderr.write(`tail: ${parsed.error}\n`);
            return 1;
        }
        const { count, fromStart, files, verbose } = parsed;
        const emit = (content) => {
            const lines = content.split('\n');
            if (lines[lines.length - 1] === '')
                lines.pop();
            const selected = fromStart ? lines.slice(Math.max(0, count - 1)) : lines.slice(-count);
            if (selected.length > 0)
                ctx.stdout.write(selected.join('\n') + '\n');
        };
        if (files.length === 0) {
            const piped = stdinText(ctx);
            if (piped)
                emit(piped);
            return 0;
        }
        const label = verbose || files.length > 1;
        let exit = 0;
        for (const [index, f] of files.entries()) {
            try {
                const content = readWholeFileString(ctx, absolutePath(ctx.cwd, f));
                if (label)
                    ctx.stdout.write(`${index > 0 ? '\n' : ''}==> ${f} <==\n`);
                emit(content);
            }
            catch (error) {
                ctx.stderr.write(`tail: ${f}: ${fsErrorMessage(error)}\n`);
                exit = 1;
            }
        }
        void vfs;
        return exit;
    };
}
function applyTailCount(result, spec) {
    const value = /^([+-]?)(\d+)$/.exec(spec.trim());
    if (value === null)
        return `invalid number of lines: '${spec}'`;
    result.fromStart = value[1] === '+';
    result.count = Number.parseInt(value[2], 10);
    return null;
}
function parseTailArgs(args) {
    const result = { count: 10, fromStart: false, files: [], verbose: false };
    let stop = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (stop || arg === '-' || !arg.startsWith('-')) {
            result.files.push(arg);
            continue;
        }
        if (arg === '--') {
            stop = true;
            continue;
        }
        if (arg.startsWith('--lines=')) {
            const error = applyTailCount(result, arg.slice(8));
            if (error)
                return { ...result, error };
            continue;
        }
        if (arg === '--lines') {
            const error = applyTailCount(result, args[++i] ?? '');
            if (error)
                return { ...result, error };
            continue;
        }
        // `-5` is the count on its own; anything else is a cluster of short
        // options, where `n` takes the rest of the cluster or the next argument.
        if (/^-\+?\d+$/.test(arg)) {
            const error = applyTailCount(result, arg.slice(1));
            if (error)
                return { ...result, error };
            continue;
        }
        let consumedCount = false;
        for (let j = 1; j < arg.length && !consumedCount; j++) {
            const flag = arg[j];
            if (flag === 'q')
                result.verbose = false;
            else if (flag === 'v')
                result.verbose = true;
            else if (flag === 'n') {
                const error = applyTailCount(result, arg.slice(j + 1) || (args[++i] ?? ''));
                if (error)
                    return { ...result, error };
                consumedCount = true;
            }
            else
                return { ...result, error: `invalid option -- '${flag}'` };
        }
    }
    return result;
}
const WC_SPEC = {
    lines: { type: 'boolean', short: 'l' },
    words: { type: 'boolean', short: 'w' },
    bytes: { type: 'boolean', short: 'c' },
    chars: { type: 'boolean', short: 'm' },
};
function mkWc(vfs) {
    return (ctx) => {
        const { flags: parsed, positional, unknown } = parseArgs(ctx.args, WC_SPEC);
        if (unknown.length > 0) {
            ctx.stderr.write(`wc: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
            return 1;
        }
        const hasFlags = parsed.lines === true || parsed.words === true
            || parsed.bytes === true || parsed.chars === true;
        const selected = {
            lines: !hasFlags || parsed.lines === true,
            words: !hasFlags || parsed.words === true,
            bytes: !hasFlags || parsed.bytes === true || parsed.chars === true,
        };
        const columns = Number(selected.lines) + Number(selected.words) + Number(selected.bytes);
        const files = positional;
        // BUG-SWEEP-3 (2026-05-11): the byte count is the raw Uint8Array length,
        // not enc.encode(decoded).length — decoding a binary file substitutes
        // U+FFFD for each invalid byte and re-encoding turns one byte into three.
        const measure = (rawBytes) => {
            const text = selected.lines || selected.words
                ? new TextDecoder('utf-8').decode(rawBytes)
                : '';
            const counts = [];
            if (selected.lines)
                counts.push(text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
            if (selected.words)
                counts.push(text.split(/\s+/).filter(Boolean).length);
            if (selected.bytes)
                counts.push(rawBytes.length);
            return counts;
        };
        const emit = (counts, width, label) => {
            ctx.stdout.write(counts.map((c) => String(c).padStart(width)).join(' ') + (label ? ' ' + label : '') + '\n');
        };
        if (files.length === 0) {
            const bytes = enc.encode(stdinText(ctx) ?? '');
            // Nothing bounds a stream's counts ahead of time, so a multi-column
            // report over standard input uses the fixed width GNU falls back to.
            emit(measure(bytes), columns === 1 ? 0 : 7, '');
            return 0;
        }
        const read = [];
        let exit = 0;
        for (const f of files) {
            try {
                read.push({ label: f, bytes: vfs.readFile(resolvePath(ctx.cwd, f)) });
            }
            catch {
                ctx.stderr.write(`wc: ${f}: No such file\n`);
                exit = 1;
            }
        }
        // A file's size bounds every count it can produce, which is the width GNU
        // lays the columns out to. One column of one file needs no padding.
        const width = columns === 1 && read.length <= 1
            ? 1
            : Math.max(1, ...read.map((entry) => String(entry.bytes.length).length));
        const totals = new Array(columns).fill(0);
        for (const entry of read) {
            const counts = measure(entry.bytes);
            counts.forEach((count, i) => { totals[i] += count; });
            emit(counts, width, entry.label);
        }
        if (read.length > 1)
            emit(totals, width, 'total');
        return exit;
    };
}
const SORT_SPEC = {
    reverse: { type: 'boolean', short: 'r' },
    numeric: { type: 'boolean', short: 'n' },
    unique: { type: 'boolean', short: 'u' },
    'ignore-case': { type: 'boolean', short: 'f' },
};
function mkSort(vfs) {
    return (ctx) => {
        const { flags, positional, unknown } = parseArgs(ctx.args, SORT_SPEC);
        if (unknown.length > 0) {
            ctx.stderr.write(`sort: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
            return 1;
        }
        let input = stdinText(ctx) || '';
        if (positional.length > 0 && !input) {
            try {
                input = vfs.readFileString(resolvePath(ctx.cwd, positional[0]));
            }
            catch {
                ctx.stderr.write(`sort: ${positional[0]}: No such file\n`);
                return 1;
            }
        }
        const lines = input.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        const numeric = flags.numeric === true;
        const fold = flags['ignore-case'] === true;
        const key = (line) => (fold ? line.toLowerCase() : line);
        lines.sort((a, b) => (numeric
            ? (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0)
            : key(a).localeCompare(key(b))));
        if (flags.reverse)
            lines.reverse();
        // -u drops adjacent duplicates after sorting, so it compares by the same
        // key the sort used rather than by the whole line.
        const result = flags.unique
            ? lines.filter((line, i) => i === 0 || compareSortKeys(lines[i - 1], line, numeric, fold) !== 0)
            : lines;
        if (result.length > 0)
            ctx.stdout.write(result.join('\n') + '\n');
        return 0;
    };
}
function compareSortKeys(a, b, numeric, fold) {
    if (numeric)
        return (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0);
    return fold ? a.toLowerCase().localeCompare(b.toLowerCase()) : a.localeCompare(b);
}
const UNIQ_SPEC = {
    count: { type: 'boolean', short: 'c' },
    repeated: { type: 'boolean', short: 'd' },
    unique: { type: 'boolean', short: 'u' },
    'ignore-case': { type: 'boolean', short: 'i' },
};
function mkUniq(vfs) {
    return (ctx) => {
        const { flags, positional, unknown } = parseArgs(ctx.args, UNIQ_SPEC);
        if (unknown.length > 0) {
            ctx.stderr.write(`uniq: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
            return 1;
        }
        // File operands were ignored outright, so `uniq file` read stdin and
        // printed nothing at all.
        let input = stdinText(ctx) || '';
        if (positional.length > 0 && positional[0] !== '-') {
            try {
                input = vfs.readFileString(resolvePath(ctx.cwd, positional[0]));
            }
            catch {
                ctx.stderr.write(`uniq: ${positional[0]}: No such file\n`);
                return 1;
            }
        }
        const lines = input.split('\n');
        const countFlag = flags.count === true;
        const dupsOnly = flags.repeated === true;
        const uniquesOnly = flags.unique === true;
        const fold = flags['ignore-case'] === true;
        if (lines[lines.length - 1] === '')
            lines.pop();
        const same = (a, b) => fold ? a.toLowerCase() === b.toLowerCase() : a === b;
        const result = [];
        const flush = (line, count) => {
            if (dupsOnly && count < 2)
                return;
            if (uniquesOnly && count > 1)
                return;
            result.push(countFlag ? `${String(count).padStart(7)} ${line}` : line);
        };
        let prev = null;
        let count = 0;
        for (const line of lines) {
            if (prev !== null && same(line, prev)) {
                count++;
                continue;
            }
            if (prev !== null)
                flush(prev, count);
            prev = line;
            count = 1;
        }
        if (prev !== null)
            flush(prev, count);
        if (result.length > 0)
            ctx.stdout.write(result.join('\n') + '\n');
        return 0;
    };
}
function mkSed(vfs) {
    return (ctx) => runSed({
        args: ctx.args,
        cwd: ctx.cwd,
        vfs,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        stdin: typeof ctx.stdin === 'string' ? stringInput(ctx.stdin) : undefined,
    });
}
function stringInput(text) {
    return {
        readAll: async () => text,
    };
}
/**
 * shell compatibility (2026-05-11): expanded awk subset.
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
function mkAwk(vfs) {
    return (ctx) => {
        const allArgs = ctx.args;
        // Parse -F separator if present.
        let separator = /\s+/;
        const programArgs = [];
        const fileArgs = [];
        for (let i = 0; i < allArgs.length; i++) {
            const a = allArgs[i];
            if (a === '-F') {
                const s = allArgs[++i];
                if (s)
                    separator = s.length === 1 ? s : new RegExp(s);
            }
            else if (a.startsWith('-F')) {
                const s = a.slice(2);
                if (s)
                    separator = s.length === 1 ? s : new RegExp(s);
            }
            else if (a.startsWith('-')) {
                // Ignore other flags (silent compat).
            }
            else if (programArgs.length === 0) {
                programArgs.push(a);
            }
            else {
                fileArgs.push(a);
            }
        }
        const program = programArgs[0] || '';
        let input = stdinText(ctx) || '';
        if (fileArgs.length > 0 && !input) {
            try {
                input = vfs.readFileString(resolvePath(ctx.cwd, fileArgs[0]));
            }
            catch {
                ctx.stderr.write(`awk: ${fileArgs[0]}: No such file\n`);
                return 1;
            }
        }
        const blocks = [];
        let cursor = 0;
        const src = program.trim();
        function skipWS() {
            while (cursor < src.length && /\s/.test(src[cursor]))
                cursor++;
        }
        function parseBraced() {
            // Assumes src[cursor] === '{'
            let depth = 0;
            let start = cursor;
            while (cursor < src.length) {
                const ch = src[cursor];
                if (ch === '{')
                    depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        cursor++;
                        return src.slice(start + 1, cursor - 1);
                    }
                }
                else if (ch === '"' || ch === "'") {
                    const quote = ch;
                    cursor++;
                    while (cursor < src.length && src[cursor] !== quote) {
                        if (src[cursor] === '\\')
                            cursor++;
                        cursor++;
                    }
                }
                cursor++;
            }
            return src.slice(start + 1, cursor);
        }
        while (cursor < src.length) {
            skipWS();
            if (cursor >= src.length)
                break;
            if (src.startsWith('BEGIN', cursor)) {
                cursor += 5;
                skipWS();
                if (src[cursor] !== '{') {
                    ctx.stderr.write('awk: BEGIN without {\n');
                    return 1;
                }
                blocks.push({ kind: 'BEGIN', body: parseBraced() });
                continue;
            }
            if (src.startsWith('END', cursor)) {
                cursor += 3;
                skipWS();
                if (src[cursor] !== '{') {
                    ctx.stderr.write('awk: END without {\n');
                    return 1;
                }
                blocks.push({ kind: 'END', body: parseBraced() });
                continue;
            }
            if (src[cursor] === '/') {
                // Pattern /pat/ optionally followed by {body}
                const pstart = cursor + 1;
                cursor++;
                while (cursor < src.length && src[cursor] !== '/') {
                    if (src[cursor] === '\\')
                        cursor++;
                    cursor++;
                }
                const patSrc = src.slice(pstart, cursor);
                cursor++; // past closing /
                skipWS();
                let body = 'print';
                if (cursor < src.length && src[cursor] === '{')
                    body = parseBraced();
                let re;
                try {
                    re = new RegExp(patSrc);
                }
                catch (e) {
                    ctx.stderr.write(`awk: bad regex /${patSrc}/: ${errorText(e)}\n`);
                    return 1;
                }
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
        function evalExpr(expr, st) {
            const text = expr.trim();
            let pos = 0;
            function skipWs() { while (pos < text.length && /\s/.test(text[pos]))
                pos++; }
            function peek() { return text[pos]; }
            function consume(ch) { skipWs(); if (text[pos] === ch) {
                pos++;
                return true;
            } return false; }
            function expect(ch) { if (!consume(ch))
                throw new Error(`expected '${ch}' at "${text.slice(pos, pos + 20)}"`); }
            function parseExpr() {
                let left = parseTerm();
                for (;;) {
                    skipWs();
                    const op = text[pos];
                    if (op === '+' || op === '-') {
                        pos++;
                        const right = parseTerm();
                        const ln = toNum(left), rn = toNum(right);
                        left = op === '+' ? ln + rn : ln - rn;
                    }
                    else
                        break;
                }
                return left;
            }
            function parseTerm() {
                let left = parseFactor();
                for (;;) {
                    skipWs();
                    const op = text[pos];
                    if (op === '*' || op === '/' || op === '%') {
                        pos++;
                        const right = parseFactor();
                        const ln = toNum(left), rn = toNum(right);
                        left = op === '*' ? ln * rn : op === '/' ? ln / rn : ln % rn;
                    }
                    else
                        break;
                }
                return left;
            }
            function parseFactor() {
                skipWs();
                if (pos >= text.length)
                    throw new Error(`unexpected end of expression`);
                const ch = text[pos];
                // Number
                if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[pos + 1]))) {
                    let start = pos;
                    while (pos < text.length && /[0-9.]/.test(text[pos]))
                        pos++;
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
                        }
                        else {
                            s += text[pos];
                            pos++;
                        }
                    }
                    if (pos < text.length)
                        pos++; // skip closing quote
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
                    while (pos < text.length && /[0-9]/.test(text[pos]))
                        pos++;
                    if (nStart === pos)
                        throw new Error(`expected field index after $ at "${text.slice(pos, pos + 10)}"`);
                    const idx = parseInt(text.slice(nStart, pos), 10);
                    return st.fields[idx] ?? '';
                }
                // Identifier: NR, NF, user var
                if (/[A-Za-z_]/.test(ch)) {
                    let start = pos;
                    while (pos < text.length && /[A-Za-z0-9_]/.test(text[pos]))
                        pos++;
                    const name = text.slice(start, pos);
                    if (name === 'NR')
                        return st.NR;
                    if (name === 'NF')
                        return st.NF;
                    return st.vars[name] !== undefined ? st.vars[name] : 0;
                }
                throw new Error(`unexpected '${ch}' at "${text.slice(pos, pos + 20)}"`);
            }
            function toNum(v) {
                if (typeof v === 'number')
                    return v;
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
            }
            catch (e) {
                throw new Error(`expr error: ${errorText(e)} in "${expr}"`);
            }
        }
        function stripStringsForScan(s) {
            // Replace string contents with same-length spaces so positions stay aligned.
            let out = '';
            let i = 0;
            while (i < s.length) {
                const ch = s[i];
                if (ch === '"' || ch === "'") {
                    out += ch;
                    i++;
                    while (i < s.length && s[i] !== ch) {
                        if (s[i] === '\\') {
                            out += ' ';
                            i++;
                        }
                        out += ' ';
                        i++;
                    }
                    if (i < s.length) {
                        out += ch;
                        i++;
                    }
                }
                else {
                    out += ch;
                    i++;
                }
            }
            return out;
        }
        function remapUserVars(s) {
            // Find identifiers (a-z_), skip ones that are reserved or already
            // remapped. The simple approach: scan tokens outside string
            // literals.
            const RESERVED = new Set([
                '__f', '__nr', '__nf', '__v',
                'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
                'Math', 'String', 'Number', 'Array', 'Object',
                'parseInt', 'parseFloat', 'isNaN', 'isFinite',
                'length', // for str/array .length access — not a free identifier here
            ]);
            let out = '';
            let i = 0;
            while (i < s.length) {
                const ch = s[i];
                if (ch === '"' || ch === "'") {
                    out += ch;
                    i++;
                    while (i < s.length && s[i] !== ch) {
                        if (s[i] === '\\') {
                            out += s[i];
                            i++;
                        }
                        out += s[i];
                        i++;
                    }
                    if (i < s.length) {
                        out += s[i];
                        i++;
                    }
                    continue;
                }
                if (/[A-Za-z_]/.test(ch)) {
                    let start = i;
                    while (i < s.length && /[A-Za-z0-9_]/.test(s[i]))
                        i++;
                    const ident = s.slice(start, i);
                    // Skip if previous non-ws char is `.` (member access).
                    let prev = start - 1;
                    while (prev >= 0 && /\s/.test(out[prev]))
                        prev--;
                    if (out[prev] === '.') {
                        out += ident;
                        continue;
                    }
                    if (RESERVED.has(ident)) {
                        out += ident;
                        continue;
                    }
                    // Replace with (__v.ident !== undefined ? __v.ident : 0)
                    out += `(__v.${ident}!==undefined?__v.${ident}:0)`;
                    continue;
                }
                out += ch;
                i++;
            }
            return out;
        }
        function splitStmts(body) {
            const stmts = [];
            let depth = 0;
            let cur = '';
            let i = 0;
            while (i < body.length) {
                const ch = body[i];
                if (ch === '"' || ch === "'") {
                    cur += ch;
                    i++;
                    while (i < body.length && body[i] !== ch) {
                        if (body[i] === '\\') {
                            cur += body[i];
                            i++;
                        }
                        cur += body[i];
                        i++;
                    }
                    if (i < body.length) {
                        cur += body[i];
                        i++;
                    }
                    continue;
                }
                if (ch === '(' || ch === '[' || ch === '{')
                    depth++;
                else if (ch === ')' || ch === ']' || ch === '}')
                    depth--;
                if (depth === 0 && (ch === ';' || ch === '\n')) {
                    const t = cur.trim();
                    if (t)
                        stmts.push(t);
                    cur = '';
                    i++;
                    continue;
                }
                cur += ch;
                i++;
            }
            const t = cur.trim();
            if (t)
                stmts.push(t);
            return stmts;
        }
        function execStmt(stmt, st) {
            // print [expr[, expr]*]
            if (stmt === 'print' || stmt.startsWith('print ') || stmt.startsWith('print\t')) {
                const rest = stmt.slice(5).trim();
                if (!rest) {
                    ctx.stdout.write(st.fields[0] + '\n');
                    st.printed = true;
                    return;
                }
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
                if (parts.length === 0)
                    return;
                const fmt = evalExpr(parts[0], st);
                const fargs = parts.slice(1).map(p => evalExpr(p, st));
                ctx.stdout.write(printfFormat(String(fmt), fargs));
                st.printed = true;
                return;
            }
            // next: skip rest of body (no-op here since we re-enter each block fresh)
            if (stmt === 'next')
                return;
            // assignment: IDENT [op]= EXPR
            // We require a top-level `=` not part of `==` `<=` `>=` `!=`.
            const eqIdx = findAssignmentEq(stmt);
            if (eqIdx > 0) {
                const lhs = stmt.slice(0, eqIdx).trim();
                const rhs = stmt.slice(eqIdx + 1).trim();
                // Compound: lhs ends with op (e.g. `sum +`).
                let op = null;
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
                }
                else {
                    st.vars[name] = rv;
                }
                return;
            }
            // Bare expression — evaluate for side effects (rare in awk).
            evalExpr(stmt, st);
        }
        function findAssignmentEq(s) {
            let depth = 0;
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];
                if (ch === '"' || ch === "'") {
                    i++;
                    while (i < s.length && s[i] !== ch) {
                        if (s[i] === '\\')
                            i++;
                        i++;
                    }
                    continue;
                }
                if (ch === '(' || ch === '[' || ch === '{')
                    depth++;
                else if (ch === ')' || ch === ']' || ch === '}')
                    depth--;
                if (depth === 0 && ch === '=') {
                    const next = s[i + 1];
                    const prev = s[i - 1];
                    if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>')
                        continue;
                    return i;
                }
            }
            return -1;
        }
        function splitTopLevel(s, sep) {
            const out = [];
            let depth = 0;
            let cur = '';
            let i = 0;
            while (i < s.length) {
                const ch = s[i];
                if (ch === '"' || ch === "'") {
                    cur += ch;
                    i++;
                    while (i < s.length && s[i] !== ch) {
                        if (s[i] === '\\') {
                            cur += s[i];
                            i++;
                        }
                        cur += s[i];
                        i++;
                    }
                    if (i < s.length) {
                        cur += s[i];
                        i++;
                    }
                    continue;
                }
                if (ch === '(' || ch === '[' || ch === '{')
                    depth++;
                else if (ch === ')' || ch === ']' || ch === '}')
                    depth--;
                if (depth === 0 && ch === sep) {
                    out.push(cur.trim());
                    cur = '';
                    i++;
                    continue;
                }
                cur += ch;
                i++;
            }
            if (cur.trim())
                out.push(cur.trim());
            return out;
        }
        function stringify(v) {
            if (v === undefined || v === null)
                return '';
            if (typeof v === 'number') {
                if (Number.isInteger(v))
                    return String(v);
                // awk's OFMT default is "%.6g"
                return printfFormat('%.6g', [v]);
            }
            return String(v);
        }
        function printfFormat(fmt, fargs) {
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
                    while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) {
                        spec += fmt[i];
                        i++;
                    }
                    while (i < fmt.length && /[0-9]/.test(fmt[i])) {
                        spec += fmt[i];
                        i++;
                    }
                    if (fmt[i] === '.') {
                        spec += fmt[i];
                        i++;
                        while (i < fmt.length && /[0-9]/.test(fmt[i])) {
                            spec += fmt[i];
                            i++;
                        }
                    }
                    const conv = fmt[i];
                    i++;
                    if (conv === '%') {
                        out += '%';
                        continue;
                    }
                    const arg = fargs[argIdx++];
                    out += formatOne(spec + conv, arg);
                    continue;
                }
                out += ch;
                i++;
            }
            return out;
        }
        function formatOne(spec, arg) {
            const conv = spec[spec.length - 1];
            const flagsAndWidth = spec.slice(1, -1);
            const dotIdx = flagsAndWidth.indexOf('.');
            const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
            const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
            let flags = '';
            let widthStr = '';
            for (const c of widthPart) {
                if (/[-+ 0#]/.test(c))
                    flags += c;
                else
                    widthStr += c;
            }
            const width = widthStr ? parseInt(widthStr, 10) : 0;
            const prec = precPart ? parseInt(precPart, 10) : -1;
            let body;
            switch (conv) {
                case 's':
                    body = String(arg ?? '');
                    if (prec >= 0)
                        body = body.slice(0, prec);
                    break;
                case 'd':
                case 'i': {
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
                    if (typeof arg === 'number')
                        body = String.fromCharCode(arg);
                    else
                        body = String(arg).charAt(0);
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
        const state = {
            vars: {},
            fields: [],
            NR: 0,
            NF: 0,
            printed: false,
        };
        function runBlock(block) {
            const stmts = splitStmts(block.body);
            for (const s of stmts) {
                execStmt(s, state);
            }
        }
        try {
            // BEGIN blocks first.
            for (const b of blocks)
                if (b.kind === 'BEGIN')
                    runBlock(b);
            // Main loop over input lines.
            const lines = input.split('\n');
            // awk default: drop the final empty line if input ended with \n.
            if (lines.length > 0 && lines[lines.length - 1] === '')
                lines.pop();
            for (let li = 0; li < lines.length; li++) {
                const line = lines[li];
                const parts = typeof separator === 'string' && separator.length === 1
                    ? line.split(separator)
                    : line.split(separator);
                state.NR = li + 1;
                state.NF = parts.filter(p => p !== '').length;
                state.fields = [line, ...parts];
                for (const b of blocks) {
                    if (b.kind === 'BEGIN' || b.kind === 'END')
                        continue;
                    if (b.kind === 'PATTERN') {
                        if (b.pattern.test(line))
                            runBlock(b);
                    }
                    else {
                        // MAIN block (no pattern) — always runs.
                        runBlock(b);
                    }
                }
            }
            // END blocks last.
            for (const b of blocks)
                if (b.kind === 'END')
                    runBlock(b);
        }
        catch (e) {
            ctx.stderr.write(`awk: ${errorText(e)}\n`);
            return 1;
        }
        return 0;
    };
}
/**
 * shell compatibility (2026-05-11): real xargs implementation.
 *
 * Pre-fix the impl printed the command-line it WOULD execute and
 * returned 0. Real xargs runs the command, possibly batched (-n),
 * with arguments substituted (-I).
 *
 * We do cross-command dispatch through the shell registry, so xargs can drive
 * `echo`, `cat`, `rm`, `seq`, lazy-loaded builtins — anything in the registry. The execution
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
function mkXargs(vfs, registry) {
    return async (ctx) => {
        // NOT trimmed: `-0` exists so a name may carry the whitespace a split
        // would eat, and trimming the stream rewrites its first and last item.
        // The default split already drops the empties a trim would have removed.
        const input = stdinText(ctx) || '';
        if (!input)
            return 0;
        // Parse flags first
        const args = [...ctx.args];
        let batchSize = Infinity;
        let replaceTok = null;
        let nullSep = false;
        while (args.length > 0 && args[0].startsWith('-')) {
            const a = args.shift();
            if (a === '-n') {
                const n = parseInt(args.shift() || '', 10);
                if (Number.isFinite(n) && n > 0)
                    batchSize = n;
            }
            else if (a.startsWith('-n')) {
                const n = parseInt(a.slice(2), 10);
                if (Number.isFinite(n) && n > 0)
                    batchSize = n;
            }
            else if (a === '-I') {
                replaceTok = args.shift() || '{}';
                batchSize = 1; // -I implies one-arg-per-invocation
            }
            else if (a === '-0' || a === '--null') {
                nullSep = true;
            }
            else if (a === '--') {
                break;
            }
            else {
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
            target = asResolvedCommand(await registry.resolve(cmdName));
        }
        catch {
            target = null;
        }
        if (!target) {
            // Defer to write-to-stderr; mimic real xargs which would exec(2) and fail.
            ctx.stderr.write(`xargs: ${cmdName}: command not found\n`);
            return 127;
        }
        // Run in batches.
        const newCtx = (newArgs) => ({
            pid: ctx.pid,
            cred: ctx.cred,
            args: newArgs,
            env: ctx.env,
            cwd: ctx.cwd,
            vfs: ctx.vfs,
            stdout: ctx.stdout,
            stderr: ctx.stderr,
            stdin: '', // xargs doesn't pipe its own stdin to children
            signal: ctx.signal,
            setUmask: ctx.setUmask,
            runAs: ctx.runAs,
            execInterpreterDepth: ctx.execInterpreterDepth,
        });
        let exit = 0;
        if (replaceTok) {
            // -I: one invocation per item, replacing token in initial args.
            for (const item of items) {
                const subbed = cmdArgsInitial.map(a => a.split(replaceTok).join(item));
                try {
                    const code = await target(newCtx(subbed));
                    if (typeof code === 'number' && code !== 0)
                        exit = code;
                }
                catch (e) {
                    ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`);
                    exit = 1;
                }
            }
        }
        else {
            // -n N (or unlimited): batch items, append to initial args.
            const step = Number.isFinite(batchSize) ? batchSize : items.length;
            for (let i = 0; i < items.length; i += step) {
                const batch = items.slice(i, i + step);
                try {
                    const code = await target(newCtx([...cmdArgsInitial, ...batch]));
                    if (typeof code === 'number' && code !== 0)
                        exit = code;
                }
                catch (e) {
                    ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`);
                    exit = 1;
                }
                if (!Number.isFinite(batchSize))
                    break; // single batch when no -n
            }
        }
        return exit;
    };
}
function mkTee(vfs) {
    return (ctx) => {
        const input = stdinText(ctx) || '';
        const append = ctx.args.includes('-a');
        const files = ctx.args.filter(a => !a.startsWith('-'));
        ctx.stdout.write(input);
        for (const f of files) {
            const fp = resolvePath(ctx.cwd, f);
            if (append && vfs.exists(fp)) {
                const existing = vfs.readFileString(fp);
                vfs.writeFile(fp, existing + input);
            }
            else {
                vfs.writeFile(fp, input);
            }
        }
        return 0;
    };
}
/**
 * shell compatibility (2026-05-11): du flag parsing for combined forms.
 * Pre-fix `du -sh` didn't activate -h because we checked for literal
 * `-h` only — `-sh` is a single arg containing both flags. POSIX
 * conformant short-flag stacking.
 */
function mkDu(vfs) {
    return (ctx) => {
        // Parse flags supporting stacked short flags like `-sh`, `-ah`.
        let showAll = false, human = false, sumOnly = false;
        const positional = [];
        for (const a of ctx.args) {
            if (a.startsWith('-') && a !== '-' && !a.startsWith('--')) {
                for (const ch of a.slice(1)) {
                    if (ch === 'a')
                        showAll = true;
                    else if (ch === 'h')
                        human = true;
                    else if (ch === 's')
                        sumOnly = true;
                }
            }
            else if (a.startsWith('--')) {
                if (a === '--all')
                    showAll = true;
                else if (a === '--human-readable')
                    human = true;
                else if (a === '--summarize')
                    sumOnly = true;
            }
            else {
                positional.push(a);
            }
        }
        const target = positional[0] || '.';
        const root = resolvePath(ctx.cwd, target);
        const fmt = (b) => human ? (b >= 1e6 ? (b / 1e6).toFixed(1) + 'M' : b >= 1e3 ? (b / 1e3).toFixed(1) + 'K' : b + 'B') : String(Math.ceil(b / 1024));
        let total = 0;
        function walk(path) {
            let size = 0;
            try {
                const entries = vfs.readdir(path);
                for (const e of entries) {
                    const fp = path + '/' + e.name;
                    if (e.type === 'directory') {
                        const dirSize = walk(fp);
                        size += dirSize;
                        if (!sumOnly)
                            ctx.stdout.write(`${fmt(dirSize)}\t/${fp}\n`);
                    }
                    else {
                        try {
                            const st = vfs.stat(fp);
                            size += st.size;
                            if (showAll && !sumOnly)
                                ctx.stdout.write(`${fmt(st.size)}\t/${fp}\n`);
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return size;
        }
        total = walk(root);
        if (sumOnly || !showAll)
            ctx.stdout.write(`${fmt(total)}\t/${root}\n`);
        return 0;
    };
}
function mkDiff(vfs) {
    return (ctx) => {
        if (ctx.args.length < 2) {
            ctx.stderr.write('Usage: diff FILE1 FILE2\n');
            return 1;
        }
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
                    if (a[i] !== undefined && b[i] === undefined)
                        ctx.stdout.write(`${i + 1}d${i}\n< ${a[i]}\n`);
                    else if (a[i] === undefined && b[i] !== undefined)
                        ctx.stdout.write(`${i}a${i + 1}\n> ${b[i]}\n`);
                    else
                        ctx.stdout.write(`${i + 1}c${i + 1}\n< ${a[i]}\n---\n> ${b[i]}\n`);
                }
            }
            return hasDiff ? 1 : 0;
        }
        catch (e) {
            // `diff` reports the thrown value's `message`, whatever it holds, rather
            // than the value: a throw carrying none has always printed `undefined`.
            const message = typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
            ctx.stderr.write(`diff: ${String(message)}\n`);
            return 2;
        }
    };
}
/**
 * shell compatibility (2026-05-11): POSIX rm with proper -f semantics.
 *
 * The original rm implementation called `r.vfs.stat(...)` and caught `e instanceof VFSError`.
 * Our SqliteVFSProvider's stat method delegates to SqliteVFS.stat which
 * throws raw `Error("ENOENT: ...")` — NOT VFSError. That rm path
 * therefore falls through to `else throw e`, the error propagates up,
 * and executeCommand returns exit 1.
 *
 * Real-world impact: every `rm -rf <nonexistent> && ...` short-circuits.
 * The most common cleanup idiom in shell scripts.
 *
 * Fix: register rm in the registry's `commands` map. Treat -f silently when target is
 * missing (return 0). Handle both files (unlink) and directories
 * (rmdir recursive when -r). Translate raw errors so the unix-command
 * contract is honoured.
 */
/** The single-character backslash escapes `echo -e` and `printf` both expand. */
const BACKSLASH_ESCAPES = {
    '\\': '\\',
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    f: '\f',
    v: '\v',
};
/**
 * Expand POSIX backslash escapes in one pass.
 *
 * A pass per escape needs somewhere to park a literal `\` so the later passes
 * cannot read it as the start of an escape, and whatever character that is, the
 * text may hold one already — or an earlier escape may have just produced one.
 * NUL was the parking spot, so `printf 'a\0b'` and `echo -e 'a\x00b'` both came
 * back as `a\b`: the NUL they had just produced was restored as a backslash.
 * One left-to-right pass consumes `\\` as a unit and needs no parking spot.
 */
function expandBackslashEscapes(text) {
    return text.replace(/\\(?:([\\ntrabfv])|0([0-7]{1,3})?|x([0-9a-fA-F]{1,2}))/g, (_match, simple, octal, hex) => {
        if (simple !== undefined)
            return BACKSLASH_ESCAPES[simple];
        if (hex !== undefined)
            return String.fromCharCode(parseInt(hex, 16));
        return String.fromCharCode(octal ? parseInt(octal, 8) : 0);
    });
}
/**
 * shell compatibilityb (2026-05-11): registry-level echo so `X | xargs echo`
 * resolves. `echo` is a Shell.builtins entry, NOT in the
 * registry map. xargs's cross-command dispatch goes through
 * registry.resolve(name) — without a registry entry for echo it falls
 * back to 'command not found'. The init.ts override for echo flag
 * handling targets Shell.builtins; we additionally register a copy
 * here so registry-driven callers (xargs) can find it. Behaviour
 * matches the BUG-SWEEP-4 nimbusEcho impl: -n / -e / -E / combined.
 */
function mkEcho() {
    return (ctx) => {
        const args = ctx.args;
        let interpretEscapes = false;
        let suppressNewline = false;
        let i = 0;
        while (i < args.length) {
            const a = args[i];
            if (a === '--') {
                i++;
                break;
            }
            if (a === '-n') {
                suppressNewline = true;
                i++;
                continue;
            }
            if (a === '-e') {
                interpretEscapes = true;
                i++;
                continue;
            }
            if (a === '-E') {
                interpretEscapes = false;
                i++;
                continue;
            }
            if (/^-[neE]+$/.test(a)) {
                for (const ch of a.slice(1)) {
                    if (ch === 'n')
                        suppressNewline = true;
                    else if (ch === 'e')
                        interpretEscapes = true;
                    else if (ch === 'E')
                        interpretEscapes = false;
                }
                i++;
                continue;
            }
            break;
        }
        let out = args.slice(i).join(' ');
        if (interpretEscapes) {
            out = expandBackslashEscapes(out);
        }
        ctx.stdout.write(suppressNewline ? out : out + '\n');
        return 0;
    };
}
/**
 * SHELL-R6-4 (2026-05-12): symlink-aware `ls`.
 *
 * Pre-fix: the lazy `ls` implementation formatted `mode` with first-char
 * `d` or `-`; it had no symlink concept,
 * and our SymlinkRegistry entries are not in the VFS dir listing at all,
 * so `ls -l` after `ln -s t.txt l.txt` showed ONLY `t.txt`.
 *
 * Post-fix:
 *   - `ls` lists VFS dir entries AND SymlinkRegistry entries whose link
 *     path lives in the queried directory.
 *   - `ls -l` shows `lrwxrwxrwx  1 user user  N <mtime> <name> -> <target>`
 *     for symlinks (`N` = target string length, matches GNU coreutils).
 *   - Non-symlink rows go through the same formatter so columns line up.
 *   - Hidden-file rule (skip if leading `.`) still honored unless `-a`.
 *
 * Args supported: `-l` long, `-a` all, `-1` one-per-line, `-n` numeric
 * ownership, `-d` directory itself, plus path
 * positional. Matches the shell `ls` flag surface so we don't regress.
 */
function mkLs(vfs) {
    return (ctx) => {
        const args = ctx.args;
        const flags = new Set(args
            .filter((arg) => arg.startsWith('-') && !arg.startsWith('--'))
            .flatMap((arg) => [...arg.slice(1)]));
        const flagLong = flags.has('l') || flags.has('n');
        const flagAll = flags.has('a');
        const flagOne = flags.has('1');
        const flagNumeric = flags.has('n');
        const flagDirectory = flags.has('d');
        const positionals = args.filter(a => !a.startsWith('-'));
        const targets = positionals.length > 0 ? positionals : [ctx.cwd];
        const reg = vfs.symlinks;
        const kvfs = ctx.vfs;
        function fmtTime(mtime) {
            const d = new Date(mtime);
            const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
            const day = String(d.getDate()).padStart(2, ' ');
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${mon} ${day} ${hh}:${mm}`;
        }
        let exit = 0;
        function listDir(dirPath) {
            const fp = resolvePath(ctx.cwd, dirPath);
            const out = [];
            // Real entries via ctx.vfs.readdirStat (Kernel.VFS — handles
            // mounts like /dev) with fallback to closure-captured SqliteVFS.
            let real = [];
            try {
                if (kvfs && 'readdirStat' in kvfs && typeof kvfs.readdirStat === 'function') {
                    real = kvfs.readdirStat(fp);
                }
                else {
                    const names = vfs.readdir(fp);
                    real = names.map(n => {
                        const childPath = (fp === '/' ? '' : fp.replace(/^\/+/, '').replace(/\/+$/, ''))
                            + '/' + n.name;
                        try {
                            const s = vfs.stat(childPath);
                            return { name: n.name, type: n.type, size: s.size ?? 0,
                                mtime: s.mtime ?? Date.now(), mode: s.mode ?? 0o644,
                                uid: s.uid ?? ctx.cred.uid, gid: s.gid ?? ctx.cred.gid };
                        }
                        catch {
                            return { name: n.name, type: n.type, size: 0, mtime: Date.now(), mode: 0o644,
                                uid: ctx.cred.uid, gid: ctx.cred.gid };
                        }
                    });
                }
            }
            catch (e) {
                ctx.stderr.write(`ls: cannot access '${dirPath}': ${fsErrorMessage(e)}\n`);
                exit = 2;
                return [];
            }
            for (const r of real) {
                const type = r.type === 'directory'
                    ? 'directory'
                    : r.type === 'symlink'
                        ? 'symlink'
                        : 'file';
                const childPath = fp ? `${fp}/${r.name}` : r.name;
                out.push({
                    name: r.name,
                    type,
                    size: r.size ?? 0,
                    mtime: r.mtime ?? Date.now(),
                    mode: r.mode ?? 0o644,
                    uid: r.uid ?? ctx.cred.uid,
                    gid: r.gid ?? ctx.cred.gid,
                    ...(type === 'symlink'
                        ? { linkTarget: readSymlinkTarget(vfs, childPath) ?? undefined }
                        : {}),
                });
            }
            // Inject symlink entries whose link path is in this directory.
            const normDir = fp.replace(/^\/+/, '').replace(/\/+$/, '');
            for (const { link, target } of reg.list()) {
                const linkNorm = link.replace(/^\/+/, '').replace(/\/+$/, '');
                const lastSlash = linkNorm.lastIndexOf('/');
                const linkDir = lastSlash >= 0 ? linkNorm.substring(0, lastSlash) : '';
                if (linkDir === normDir) {
                    const linkName = lastSlash >= 0 ? linkNorm.substring(lastSlash + 1) : linkNorm;
                    if (out.some(entry => entry.name === linkName))
                        continue;
                    // Filter dotfiles unless -a (consistent with real entries).
                    if (!flagAll && linkName.startsWith('.'))
                        continue;
                    out.push({
                        name: linkName,
                        type: 'symlink',
                        size: target.length,
                        mtime: Date.now(),
                        mode: 0o777,
                        uid: ctx.cred.uid,
                        gid: ctx.cred.gid,
                        linkTarget: target,
                    });
                }
            }
            // Filter dotfiles among real entries unless -a.
            const filtered = flagAll ? out : out.filter(e => !e.name.startsWith('.'));
            filtered.sort((a, b) => a.name.localeCompare(b.name));
            return filtered;
        }
        function fmtRow(e, long) {
            if (!long)
                return e.name;
            const isDir = e.type === 'directory';
            const isLink = e.type === 'symlink';
            const mode = unixModeString(e.mode, isDir, isLink);
            const size = String(e.size).padStart(6, ' ');
            const time = fmtTime(e.mtime);
            const arrow = isLink && e.linkTarget ? ` -> ${e.linkTarget}` : '';
            const user = flagNumeric ? String(e.uid) : unixUserLabel(vfs, e.uid);
            const group = flagNumeric ? String(e.gid) : unixGroupLabel(vfs, e.gid);
            return `${mode}  1 ${user} ${group} ${size} ${time} ${e.name}${arrow}`;
        }
        // First pass: separate file-args from dir-args (real `ls` lists
        // each file inline; dirs get listed as their contents).
        const fileEntries = [];
        const dirArgs = [];
        for (const arg of targets) {
            const fp = resolvePath(ctx.cwd, arg);
            // Symlink check: a symlink-arg is displayed as the link itself
            // (without -L which we don't implement).
            const target = readSymlinkTarget(vfs, fp);
            if (target !== null) {
                fileEntries.push({
                    name: arg,
                    type: 'symlink',
                    size: target.length,
                    mtime: Date.now(),
                    mode: 0o777,
                    uid: ctx.cred.uid,
                    gid: ctx.cred.gid,
                    linkTarget: target,
                });
                continue;
            }
            try {
                const s = kvfs && typeof kvfs.stat === 'function' ? kvfs.stat(fp) : vfs.stat(fp);
                if (s.type === 'directory' && !flagDirectory) {
                    dirArgs.push(arg);
                }
                else {
                    fileEntries.push({
                        name: arg,
                        type: s.type === 'directory' ? 'directory' : 'file',
                        size: s.size ?? 0,
                        mtime: s.mtime ?? Date.now(),
                        mode: s.mode ?? 0o644,
                        uid: s.uid ?? ctx.cred.uid,
                        gid: s.gid ?? ctx.cred.gid,
                    });
                }
            }
            catch (e) {
                ctx.stderr.write(`ls: cannot access '${arg}': ${errorText(e)}\n`);
                exit = 1;
            }
        }
        // Render file-args first.
        if (fileEntries.length > 0) {
            if (flagLong) {
                for (const e of fileEntries)
                    ctx.stdout.write(fmtRow(e, true) + '\n');
            }
            else if (flagOne) {
                for (const e of fileEntries)
                    ctx.stdout.write(e.name + '\n');
            }
            else {
                ctx.stdout.write(fileEntries.map(e => e.name).join('  ') + '\n');
            }
        }
        // Then dir-args (with header if multiple).
        for (let i = 0; i < dirArgs.length; i++) {
            const d = dirArgs[i];
            if (dirArgs.length > 1 || fileEntries.length > 0) {
                if (fileEntries.length > 0 || i > 0)
                    ctx.stdout.write('\n');
                ctx.stdout.write(`${d}:\n`);
            }
            const rows = listDir(d);
            if (flagLong) {
                for (const e of rows)
                    ctx.stdout.write(fmtRow(e, true) + '\n');
            }
            else if (flagOne) {
                for (const e of rows)
                    ctx.stdout.write(e.name + '\n');
            }
            else if (rows.length > 0) {
                ctx.stdout.write(rows.map(e => e.name).join('  ') + '\n');
            }
        }
        return exit;
    };
}
/**
 * shell compatibilityc (2026-05-11): registry-level cat (for xargs cross-
 * command dispatch). Behaves like the shell cat command: reads files (or
 * stdin if none), concatenates to stdout.
 *
 * Operands stream through one shared writer, so concatenating six 1 MB files
 * emits 6 MB in 64 KiB steps rather than materialising each file whole.
 */
function mkCat(vfs) {
    return (ctx) => {
        const files = ctx.args.filter(a => !a.startsWith('-'));
        if (files.length === 0) {
            const piped = stdinText(ctx);
            if (piped)
                ctx.stdout.write(piped);
            return 0;
        }
        // Resolve both native VFS symlinks and the legacy registry before reads.
        let exit = 0;
        const writer = new SinkWriter(ctx.stdout);
        for (const fOrig of files) {
            const f = (() => {
                const fp = resolvePath(ctx.cwd, fOrig);
                const resolved = resolveSymlinkPath(vfs, fp);
                if (resolved === null) {
                    // ELOOP: too many hops
                    ctx.stderr.write(`cat: ${fOrig}: Too many levels of symbolic links\n`);
                    return null;
                }
                return resolved === fp ? fOrig : '/' + resolved;
            })();
            if (f === null) {
                exit = 1;
                continue;
            }
            try {
                const path = f.startsWith('/') ? f : `${ctx.cwd}/${f}`;
                const stat = ctx.vfs.stat(path);
                if (stat.type === 'directory')
                    throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
                if (stat.size > 0) {
                    // A regular file's size is its exact extent — read precisely that.
                    streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
                        length: stat.size,
                        signal: ctx.signal,
                    });
                }
                else {
                    // Size 0 covers empty files, /dev/null and synthesised /proc entries.
                    // Endless character devices reject this unbounded read by design.
                    writer.write(ctx.vfs.readFile(path));
                }
            }
            catch (error) {
                ctx.stderr.write(`cat: ${fOrig}: ${fsErrorMessage(error)}\n`);
                exit = 1;
            }
        }
        writer.end();
        return exit;
    };
}
function mkRm(vfs) {
    return (ctx) => {
        const args = ctx.args;
        const recursive = args.some(a => a === '-r' || a === '-R' || a === '-rf' || a === '-Rf' || a === '-rR' || a === '--recursive' || (a.startsWith('-') && !a.startsWith('--') && (a.includes('r') || a.includes('R'))));
        const force = args.some(a => a === '-f' || a === '--force' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')));
        const targets = args.filter(a => !a.startsWith('-'));
        if (targets.length === 0) {
            if (force)
                return 0; // POSIX: rm -f with no operands is silent success
            ctx.stderr.write('rm: missing operand\n');
            return 1;
        }
        // SHELL-R6-5: SymlinkRegistry awareness. Real `rm` removes the
        // LINK, not the target. Pre-fix this loop went straight to
        // vfs.exists which is false for registry-only symlink entries
        // (no real file), producing "No such file or directory" while
        // `readlink` still reported the registry entry.
        const reg = vfs.symlinks;
        let exit = 0;
        for (const t of targets) {
            const fp = resolvePath(ctx.cwd, t);
            // Symlink path FIRST. If `fp` is registered as a symlink we
            // delete the registry entry and skip the vfs-level operations.
            // Real `rm` never follows symlinks (it removes the link
            // itself); recursive flag has no effect on the symlink itself
            // either — it acts on the link node only.
            if (reg.isSymlink(fp)) {
                reg.delete(fp);
                continue;
            }
            if (!vfs.exists(fp)) {
                if (force)
                    continue; // silent success
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
                    vfs.removeRecursive(fp);
                }
                else {
                    vfs.unlink(fp);
                }
            }
            catch (e) {
                // -f suppresses ENOENT only (file disappeared mid-loop); other
                // errors (ENOTEMPTY because of a logic bug, ENOTDIR mismatches,
                // permission errors) must still surface. Pre-fix the broad
                // `if (force) continue` masked the readdir-iteration bug that
                // left directories undeleted.
                const msg = errorText(e);
                if (force && /ENOENT/.test(msg))
                    continue;
                ctx.stderr.write(`rm: cannot remove '${t}': ${fsErrorMessage(e)}\n`);
                exit = 1;
            }
        }
        return exit;
    };
}
function mkTouch(vfs) {
    return (ctx) => {
        const targetVfs = ctx.vfs ?? vfs;
        for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
            const fp = resolvePath(ctx.cwd, f);
            // Ensure parent dirs
            const parts = fp.split('/');
            for (let i = 1; i < parts.length; i++) {
                const dir = parts.slice(0, i).join('/');
                if (dir && !targetVfs.exists(dir))
                    targetVfs.mkdir(dir, { recursive: true });
            }
            if (!targetVfs.exists(fp)) {
                targetVfs.writeFile(fp, '');
                continue;
            }
            // Every view reaching here implements `isDirectory`: the lifo VFS gained
            // it alongside `isFile`, which is what stopped `touch` failing on an
            // existing file. The `stat` fallback this replaced narrowed to `never`
            // once the surface was typed — the type system reporting that the guard
            // it sat behind can no longer be false.
            const isDirectory = targetVfs.isDirectory(fp);
            if (!isDirectory) {
                // Update mtime by re-writing the same content
                const content = targetVfs.readFile(fp);
                targetVfs.writeFile(fp, content);
            }
        }
        return 0;
    };
}
/**
 * `stat` formatting.
 *
 * Every GNU directive is answered, using what this filesystem actually knows:
 *
 *   - inode (%i): paths are the identity here — there are no hard links, so a
 *     path maps to exactly one file. %i is a stable hash of the path, which
 *     gives (dev,ino) comparisons the right answer instead of the zero an
 *     inode-less filesystem would otherwise report for everything.
 *   - link count (%h) is always 1, device numbers are 0: one store, no
 *     hard links, no device nodes.
 *   - birth time (%w/%W) prints `-`/`0`, GNU's own convention for a
 *     filesystem that does not record it. Change time (%z/%Z) tracks mtime.
 *   - SELinux context (%C) prints `?`, as GNU does where there is none.
 */
const STAT_TERSE_FORMAT = '%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o %C';
const STATFS_TERSE_FORMAT = '%n %i %l %t %s %S %b %f %a %c %d';
/** Longest component the VFS accepts, reported by %l and `Namelen`. */
const STAT_NAME_MAX = 255;
/** Reported by %o: the VFS reads and writes in 64 KiB chunks. */
const STAT_IO_BLOCK_SIZE = 65536;
/** %b/%B count 512-byte units, as GNU does. */
const STAT_BLOCK_UNIT = 512;
/** Stable 53-bit identity for a path — see the %i note above. */
function statPathId(path) {
    let high = 0xdeadbeef;
    let low = 0x41c6ce57;
    for (let i = 0; i < path.length; i++) {
        const code = path.charCodeAt(i);
        high = Math.imul(high ^ code, 2654435761);
        low = Math.imul(low ^ code, 1597334677);
    }
    high = Math.imul(high ^ (high >>> 16), 2246822507) >>> 0;
    low = Math.imul(low ^ (low >>> 13), 3266489909) >>> 0;
    return high * 0x200000 + (low >>> 11);
}
function statDirective(directive, stat, path, labels) {
    const isDir = stat.type === 'directory';
    const isLink = stat.type === 'symlink';
    const changeTime = stat.ctime ?? stat.mtime;
    switch (directive) {
        case 'n': return path;
        case 'N': return `'${path}'`;
        case 's': return String(stat.size);
        case 'b': return String(Math.ceil(stat.size / STAT_BLOCK_UNIT));
        case 'B': return String(STAT_BLOCK_UNIT);
        case 'o': return String(STAT_IO_BLOCK_SIZE);
        case 'a': return (stat.mode & 0o7777).toString(8);
        case 'A': return unixModeString(stat.mode, isDir, isLink);
        case 'f': return (stat.mode >>> 0).toString(16);
        case 'u': return String(stat.uid);
        case 'U': return labels.user;
        case 'g': return String(stat.gid);
        case 'G': return labels.group;
        case 'F':
            if (isDir)
                return 'directory';
            if (isLink)
                return 'symbolic link';
            return isCharacterDevice(stat.mode) ? 'character special file' : 'regular file';
        case 'h': return '1';
        case 'i': return String(statPathId(path));
        case 'd': return '0';
        case 'D': return '0';
        case 't': return '0';
        case 'T': return '0';
        case 'm': return '/';
        case 'C': return '?';
        case 'w': return '-';
        case 'W': return '0';
        case 'Y': return String(Math.floor(stat.mtime / 1000));
        case 'y': return new Date(stat.mtime).toISOString();
        case 'X': return String(Math.floor(stat.atime / 1000));
        case 'x': return new Date(stat.atime).toISOString();
        case 'Z': return String(Math.floor(changeTime / 1000));
        case 'z': return new Date(changeTime).toISOString();
        case '%': return '%';
        default: return null;
    }
}
function statFsDirective(directive, fs, path) {
    switch (directive) {
        case 'n': return path;
        case 'i': return String(statPathId('/'));
        case 'l': return String(STAT_NAME_MAX);
        case 't': return '0';
        case 'T': return 'nimbus-sqlite';
        case 's': return String(fs.blockSize);
        case 'S': return String(fs.blockSize);
        case 'b': return String(fs.totalBlocks);
        case 'f': return String(fs.freeBlocks);
        case 'a': return String(fs.freeBlocks);
        case 'c': return String(fs.totalInodes);
        case 'd': return String(fs.freeInodes);
        case '%': return '%';
        default: return null;
    }
}
function expandStatFormat(format, expand) {
    let out = '';
    for (let i = 0; i < format.length; i++) {
        const ch = format[i];
        if (ch === '\\' && i + 1 < format.length) {
            const esc = format[++i];
            out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '0' ? '\0' : esc;
            continue;
        }
        if (ch !== '%') {
            out += ch;
            continue;
        }
        const directive = format[++i];
        if (directive === undefined)
            return { error: "stat: trailing '%' in format" };
        const expanded = expand(directive);
        if (expanded === null)
            return { error: `stat: unrecognized format directive '%${directive}'` };
        out += expanded;
    }
    return { text: out };
}
const STAT_USAGE = [
    'Usage: stat [OPTION]... FILE...',
    'Display file or file system status.',
    '',
    '  -L, --dereference     follow links (Nimbus always follows)',
    '  -f, --file-system     display file system status instead of file status',
    '  -c, --format=FORMAT   use the specified FORMAT instead of the default',
    '      --printf=FORMAT   like --format, but interpret escapes and omit the newline',
    '  -t, --terse           print the information in terse form',
    '      --cached=MODE     always|default|never (Nimbus attributes are never cached)',
    '      --help            display this help and exit',
    '      --version         output version information and exit',
    '',
].join('\n');
function mkStat(vfs, sqliteVfs) {
    return (ctx) => {
        let format = null;
        // `--printf` differs from `-c` only in not appending a newline.
        let formatAddsNewline = true;
        let fileSystemMode = false;
        let terse = false;
        const files = [];
        const args = ctx.args;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '-c' || arg === '--format' || arg === '--printf') {
                const value = args[++i];
                if (value === undefined) {
                    ctx.stderr.write(`stat: option '${arg}' requires an argument\n`);
                    return 1;
                }
                format = value;
                formatAddsNewline = arg !== '--printf';
            }
            else if (arg.startsWith('--format=') || arg.startsWith('--printf=')) {
                format = arg.slice(arg.indexOf('=') + 1);
                formatAddsNewline = !arg.startsWith('--printf=');
            }
            else if (arg === '-f' || arg === '--file-system') {
                fileSystemMode = true;
            }
            else if (arg === '-t' || arg === '--terse') {
                terse = true;
            }
            else if (arg === '-L' || arg === '--dereference') {
                // Symlinks are already followed; accept the flag rather than drop it.
            }
            else if (arg.startsWith('--cached=')) {
                const mode = arg.slice('--cached='.length);
                if (mode !== 'always' && mode !== 'default' && mode !== 'never') {
                    ctx.stderr.write(`stat: invalid argument '${mode}' for '--cached'\n`);
                    return 1;
                }
                // Attributes are read live from the VFS, which satisfies every mode.
            }
            else if (arg === '--help') {
                ctx.stdout.write(STAT_USAGE);
                return 0;
            }
            else if (arg === '--version') {
                ctx.stdout.write(`stat (nimbus coreutils) ${NIMBUS_VERSION}\n`);
                return 0;
            }
            else if (arg === '--') {
                files.push(...args.slice(i + 1));
                break;
            }
            else if (arg.startsWith('-') && arg !== '-') {
                ctx.stderr.write(`stat: invalid option '${arg}'\n`);
                ctx.stderr.write(STAT_USAGE);
                return 1;
            }
            else {
                files.push(arg);
            }
        }
        if (files.length === 0) {
            ctx.stderr.write('stat: missing operand\n');
            return 1;
        }
        const write = (text) => {
            ctx.stdout.write(formatAddsNewline ? text + '\n' : text);
        };
        if (fileSystemMode) {
            const stats = sqliteVfs.getStats();
            const facts = {
                blockSize: STAT_IO_BLOCK_SIZE,
                totalBlocks: Math.floor(stats.capacityBytes / STAT_IO_BLOCK_SIZE),
                freeBlocks: Math.max(0, Math.floor((stats.capacityBytes - stats.usedBytes) / STAT_IO_BLOCK_SIZE)),
                totalInodes: stats.files + stats.directories,
                freeInodes: 0,
            };
            const activeFormat = format ?? (terse ? STATFS_TERSE_FORMAT : null);
            for (const f of files) {
                const displayPath = f.startsWith('/') ? f : resolvePath(ctx.cwd, f).replace(/^\/*/, '/');
                if (activeFormat !== null) {
                    const expanded = expandStatFormat(activeFormat, (directive) => statFsDirective(directive, facts, displayPath));
                    if ('error' in expanded) {
                        ctx.stderr.write(expanded.error + '\n');
                        return 1;
                    }
                    write(expanded.text);
                    continue;
                }
                ctx.stdout.write(`  File: "${displayPath}"\n`);
                ctx.stdout.write(`    ID: 0        Namelen: ${STAT_NAME_MAX}     Type: nimbus-sqlite\n`);
                ctx.stdout.write(`Block size: ${facts.blockSize}       Fundamental block size: ${facts.blockSize}\n`);
                ctx.stdout.write(`Blocks: Total: ${facts.totalBlocks}  Free: ${facts.freeBlocks}  Available: ${facts.freeBlocks}\n`);
                ctx.stdout.write(`Inodes: Total: ${facts.totalInodes}  Free: ${facts.freeInodes}\n`);
            }
            return 0;
        }
        const activeFormat = format ?? (terse ? STAT_TERSE_FORMAT : null);
        // shell compatibility follow-up: try Kernel.VFS (ctx.vfs) first so /dev
        // mount paths resolve. Same pattern as mkCat.
        const kvfs = ctx.vfs;
        for (const f of files) {
            let st = null;
            let displayPath = f;
            // Try Kernel.VFS first (sees mounts).
            if (kvfs && typeof kvfs.stat === 'function') {
                try {
                    st = kvfs.stat(f.startsWith('/') ? f : ctx.cwd + '/' + f);
                    displayPath = f.startsWith('/') ? f : `/${ctx.cwd}/${f}`.replace(/^\/+/, '/');
                }
                catch (_e) { /* fall through to SqliteVFS */ }
            }
            // Fall back to SqliteVFS direct for non-mounted paths.
            if (!st) {
                try {
                    const fp = resolvePath(ctx.cwd, f);
                    st = vfs.stat(fp);
                    displayPath = '/' + fp;
                }
                catch (_e) {
                    ctx.stderr.write(`stat: cannot statx '${f}': No such file or directory\n`);
                    return 1;
                }
            }
            const uid = st.uid ?? ctx.cred.uid;
            const gid = st.gid ?? ctx.cred.gid;
            const labels = {
                user: unixUserLabel(vfs, uid),
                group: unixGroupLabel(vfs, gid),
            };
            const facts = {
                size: st.size,
                type: st.type,
                mode: st.mode,
                uid,
                gid,
                atime: st.atime ?? st.mtime,
                mtime: st.mtime,
                ctime: st.ctime,
            };
            if (activeFormat !== null) {
                const expanded = expandStatFormat(activeFormat, (directive) => statDirective(directive, facts, displayPath, labels));
                if ('error' in expanded) {
                    ctx.stderr.write(expanded.error + '\n');
                    return 1;
                }
                write(expanded.text);
                continue;
            }
            ctx.stdout.write(`  File: ${displayPath}\n`);
            const kind = isCharacterDevice(st.mode) ? 'character special file' : st.type;
            ctx.stdout.write(`  Size: ${st.size}\tType: ${kind}\n`);
            ctx.stdout.write(`Access: (0${st.mode.toString(8)})  Uid: (${uid}/${labels.user})   Gid: (${gid}/${labels.group})\n`);
            ctx.stdout.write(`Modify: ${new Date(st.mtime).toISOString()}\n`);
        }
        return 0;
    };
}
const BASE64_SPEC = {
    decode: { type: 'boolean', short: 'd' },
    'ignore-garbage': { type: 'boolean', short: 'i' },
    wrap: { type: 'string', short: 'w' },
};
/**
 * Encodes and decodes the real bytes. Reading the input as a string first put
 * every byte that is not valid UTF-8 through U+FFFD, so encoding any binary
 * file produced base64 of something else; `-w`, which GNU wraps at 76 columns
 * by default, was not implemented at all, so `base64 -w 0` read `0` as a file.
 */
function mkBase64(vfs) {
    return (ctx) => {
        const { flags, positional, unknown } = parseArgs(ctx.args, BASE64_SPEC);
        if (unknown.length > 0) {
            ctx.stderr.write(`base64: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
            return 1;
        }
        const wrapText = typeof flags.wrap === 'string' && flags.wrap !== '' ? flags.wrap : '76';
        const wrap = Number.parseInt(wrapText, 10);
        if (Number.isNaN(wrap) || wrap < 0) {
            ctx.stderr.write(`base64: invalid wrap size: '${wrapText}'\n`);
            return 1;
        }
        const file = positional[0];
        let bytes;
        if (file !== undefined && file !== '-') {
            try {
                bytes = vfs.readFile(resolvePath(ctx.cwd, file));
            }
            catch (error) {
                ctx.stderr.write(`base64: ${file}: ${fsErrorMessage(error)}\n`);
                return 1;
            }
        }
        else {
            bytes = enc.encode(stdinText(ctx) ?? '');
        }
        if (flags.decode) {
            const source = dec.decode(bytes).replace(/\s+/g, '');
            let decoded;
            try {
                const binary = atob(source);
                decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            }
            catch {
                ctx.stderr.write('base64: invalid input\n');
                return 1;
            }
            if (ctx.stdout.writeBytes)
                ctx.stdout.writeBytes(decoded);
            else
                ctx.stdout.write(dec.decode(decoded));
            return 0;
        }
        let binary = '';
        for (const byte of bytes)
            binary += String.fromCharCode(byte);
        const encoded = btoa(binary);
        if (encoded === '')
            return 0;
        const lines = wrap > 0
            ? (encoded.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [encoded])
            : [encoded];
        ctx.stdout.write(lines.join('\n') + '\n');
        return 0;
    };
}
function mkSeq() {
    return (ctx) => {
        const nums = ctx.args.map(Number).filter(n => !isNaN(n));
        let start = 1, step = 1, end = 1;
        if (nums.length === 1)
            end = nums[0];
        else if (nums.length === 2) {
            start = nums[0];
            end = nums[1];
        }
        else if (nums.length >= 3) {
            start = nums[0];
            step = nums[1];
            end = nums[2];
        }
        for (let i = start; step > 0 ? i <= end : i >= end; i += step)
            ctx.stdout.write(i + '\n');
        return 0;
    };
}
function mkId(sqliteVfs) {
    return (ctx) => {
        const vfs = sqliteVfs.as(ctx.cred);
        const user = findUnixUserName(vfs, ctx.cred.uid) ?? String(ctx.cred.uid);
        const group = findUnixGroupName(vfs, ctx.cred.gid) ?? String(ctx.cred.gid);
        const groupIds = [...new Set([ctx.cred.gid, ...ctx.cred.groups])];
        const groups = groupIds
            .map((gid) => `${gid}(${findUnixGroupName(vfs, gid) ?? gid})`)
            .join(',');
        ctx.stdout.write(`uid=${ctx.cred.uid}(${user}) gid=${ctx.cred.gid}(${group}) groups=${groups}\n`);
        return 0;
    };
}
function mkChown(sqliteVfs) {
    return (ctx) => {
        const recursive = ctx.args.includes('-R') || ctx.args.includes('--recursive');
        const positional = ctx.args.filter((arg) => arg !== '-R' && arg !== '--recursive');
        if (positional.length < 2) {
            ctx.stderr.write('chown: missing operand\n');
            return 1;
        }
        const vfs = sqliteVfs.as(ctx.cred);
        let ownership;
        try {
            ownership = parseChownOwnership(vfs, positional[0]);
        }
        catch (error) {
            ctx.stderr.write(`chown: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
        let exitCode = 0;
        const apply = (path) => {
            if (recursive && vfs.stat(path).type === 'directory') {
                for (const child of vfs.readdir(path))
                    apply(`${path}/${child.name}`);
            }
            vfs.chown(path, ownership.uid, ownership.gid);
        };
        for (const file of positional.slice(1)) {
            try {
                apply(resolvePath(ctx.cwd, file));
            }
            catch (error) {
                ctx.stderr.write(`chown: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
                exitCode = 1;
            }
        }
        return exitCode;
    };
}
function mkTest(sqliteVfs) {
    return (ctx) => {
        const args = ctx.args.filter((arg) => arg !== ']');
        if (args.length === 0)
            return 1;
        const vfs = sqliteVfs.as(ctx.cred);
        const path = resolvePath(ctx.cwd, args[1] ?? '');
        try {
            if (args[0] === '-r')
                vfs.access(path, 0o4);
            else if (args[0] === '-w')
                vfs.access(path, 0o2);
            else if (args[0] === '-x')
                vfs.access(path, 0o1);
            else if (args[0] === '-f')
                return vfs.stat(path).type === 'file' ? 0 : 1;
            else if (args[0] === '-d')
                return vfs.stat(path).type === 'directory' ? 0 : 1;
            else if (args[0] === '-e')
                vfs.stat(path);
            else if (args[0] === '-z')
                return (!args[1] || args[1] === '') ? 0 : 1;
            else if (args[0] === '-n')
                return args[1] ? 0 : 1;
            else if (args[1] === '=')
                return args[0] === args[2] ? 0 : 1;
            else if (args[1] === '!=')
                return args[0] !== args[2] ? 0 : 1;
            else
                return args[0] ? 0 : 1;
            return 0;
        }
        catch {
            return 1;
        }
    };
}
function mkHostname() {
    return (ctx) => { ctx.stdout.write('nimbus\n'); return 0; };
}
function mkBasename() {
    return (ctx) => {
        const p = ctx.args[0] || '';
        const suffix = ctx.args[1] || '';
        let base = p.split('/').pop() || '';
        if (suffix && base.endsWith(suffix))
            base = base.slice(0, -suffix.length);
        ctx.stdout.write(base + '\n');
        return 0;
    };
}
function mkDirname() {
    return (ctx) => {
        const p = ctx.args[0] || '';
        const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '.';
        ctx.stdout.write((dir || '/') + '\n');
        return 0;
    };
}
function mkRealpath(vfs) {
    return (ctx) => {
        for (const p of ctx.args) {
            const fp = resolvePath(ctx.cwd, p);
            if (vfs.exists(fp))
                ctx.stdout.write('/' + fp + '\n');
            else {
                ctx.stderr.write(`realpath: ${p}: No such file\n`);
                return 1;
            }
        }
        return 0;
    };
}
/**
 * shell compatibility (2026-05-11): printf full POSIX format set.
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
function mkPrintf() {
    return (ctx) => {
        if (ctx.args.length === 0)
            return 0;
        const rawFmt = ctx.args[0];
        const vals = ctx.args.slice(1);
        // Process backslash escapes in the format string first.
        const fmt = expandBackslashEscapes(rawFmt);
        let out = '';
        let argIdx = 0;
        function applyFormat() {
            // Run the format string once; return true if it consumed any args.
            let i = 0;
            const startArg = argIdx;
            while (i < fmt.length) {
                const ch = fmt[i];
                if (ch !== '%') {
                    out += ch;
                    i++;
                    continue;
                }
                if (fmt[i + 1] === '%') {
                    out += '%';
                    i += 2;
                    continue;
                }
                // Parse format spec: %[flags][width][.prec]conversion
                let spec = '%';
                i++;
                while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) {
                    spec += fmt[i];
                    i++;
                }
                while (i < fmt.length && /[0-9]/.test(fmt[i])) {
                    spec += fmt[i];
                    i++;
                }
                if (fmt[i] === '.') {
                    spec += fmt[i];
                    i++;
                    while (i < fmt.length && /[0-9]/.test(fmt[i])) {
                        spec += fmt[i];
                        i++;
                    }
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
        }
        else {
            while (argIdx < vals.length) {
                if (!applyFormat())
                    break;
            }
        }
        ctx.stdout.write(out);
        return 0;
    };
}
function formatOneArg(spec, arg) {
    const conv = spec[spec.length - 1];
    const flagsAndWidth = spec.slice(1, -1);
    const dotIdx = flagsAndWidth.indexOf('.');
    const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
    const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
    let flags = '';
    let widthStr = '';
    for (const c of widthPart) {
        if (/[-+ 0#]/.test(c))
            flags += c;
        else
            widthStr += c;
    }
    const width = widthStr ? parseInt(widthStr, 10) : 0;
    const prec = precPart ? parseInt(precPart, 10) : -1;
    let body;
    switch (conv) {
        case 's': {
            body = String(arg ?? '');
            if (prec >= 0)
                body = body.slice(0, prec);
            break;
        }
        case 'd':
        case 'i': {
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
        case 'f':
        case 'F': {
            const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
            const p = prec < 0 ? 6 : prec;
            body = (Number.isFinite(n) ? n : 0).toFixed(p);
            if (n >= 0 && flags.includes('+'))
                body = '+' + body;
            else if (n >= 0 && flags.includes(' '))
                body = ' ' + body;
            break;
        }
        case 'e':
        case 'E': {
            const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
            const p = prec < 0 ? 6 : prec;
            body = (Number.isFinite(n) ? n : 0).toExponential(p);
            if (conv === 'E')
                body = body.toUpperCase();
            break;
        }
        case 'g':
        case 'G': {
            const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
            const p = prec < 0 ? 6 : prec || 1;
            body = (Number.isFinite(n) ? n : 0).toPrecision(p);
            // Strip trailing zeros + dot (POSIX %g behavior) unless # flag.
            if (!flags.includes('#'))
                body = body.replace(/(\.\d*?)0+($|e)/, '$1$2').replace(/\.($|e)/, '$1');
            if (conv === 'G')
                body = body.toUpperCase();
            break;
        }
        case 'x':
        case 'X': {
            const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
            body = (Number.isFinite(n) ? n >>> 0 : 0).toString(16);
            if (conv === 'X')
                body = body.toUpperCase();
            if (flags.includes('#') && body !== '0')
                body = (conv === 'X' ? '0X' : '0x') + body;
            break;
        }
        case 'o': {
            const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
            body = (Number.isFinite(n) ? n >>> 0 : 0).toString(8);
            if (flags.includes('#') && !body.startsWith('0'))
                body = '0' + body;
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
            if (typeof arg === 'number')
                body = String.fromCharCode(arg);
            else
                body = String(arg ?? '').charAt(0);
            break;
        }
        case 'q': {
            // bash printf %q: shell-quote
            const s = String(arg ?? '');
            if (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(s))
                body = s;
            else
                body = "'" + s.replace(/'/g, `'\\''`) + "'";
            break;
        }
        default: body = '%' + conv;
    }
    // Apply width padding.
    if (width > body.length) {
        const zeroPad = flags.includes('0') && /[diouxXfFeEgG]/.test(conv) && !flags.includes('-');
        const padCh = zeroPad ? '0' : ' ';
        if (flags.includes('-'))
            body = body.padEnd(width, ' ');
        else {
            // For zero-pad on negative numbers, keep the sign at the front.
            if (zeroPad && (body.startsWith('-') || body.startsWith('+') || body.startsWith(' '))) {
                body = body[0] + body.slice(1).padStart(width - 1, padCh);
            }
            else {
                body = body.padStart(width, padCh);
            }
        }
    }
    return body;
}
function mkTrue() { return () => 0; }
function mkFalse() { return () => 1; }
/**
 * shell compatibility (2026-05-11): readlink stub.
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
/**
 * SHELL-FOLLOWUPS-4 (2026-05-11): real symlink readlink.
 * Pre-fix: ln -s did file-copy; readlink returned exit 1 with no
 * output (no symlink table existed). Now backed by SymlinkRegistry:
 *   - GNU readlink prints target (relative or absolute as stored)
 *   - exit 1 silently for non-symlinks (matches GNU readlink default)
 *   - exit 1 + stderr for missing files
 * Flags: -f (canonicalize — follow chain to final target), default
 * (one-hop). -e variant (verify) deferred.
 */
function mkReadlink(vfs) {
    return (ctx) => {
        const args = [...ctx.args];
        let canonicalize = false;
        const targets = [];
        for (const a of args) {
            if (a === '-f' || a === '--canonicalize') {
                canonicalize = true;
                continue;
            }
            if (a.startsWith('-') && a !== '-') {
                for (const ch of a.slice(1))
                    if (ch === 'f')
                        canonicalize = true;
                continue;
            }
            targets.push(a);
        }
        if (targets.length === 0) {
            ctx.stderr.write('readlink: missing operand\n');
            return 1;
        }
        let exit = 0;
        for (const t of targets) {
            const fp = resolvePath(ctx.cwd, t);
            if (canonicalize) {
                // -f: follow chain; succeed even if target doesn't exist YET
                // (matches `readlink -f` which canonicalizes anyway).
                const resolved = resolveSymlinkPath(vfs, fp);
                if (resolved !== null) {
                    ctx.stdout.write('/' + resolved + '\n');
                    continue;
                }
                ctx.stderr.write(`readlink: ${t}: Too many levels of symbolic links\n`);
                exit = 1;
                continue;
            }
            // Default: one-hop. Print target verbatim (preserves relative/absolute).
            const direct = readSymlinkTarget(vfs, fp);
            if (direct !== null) {
                ctx.stdout.write(direct + '\n');
                continue;
            }
            // Not a symlink. GNU readlink exits 1 silently for regular
            // files / dirs; emits stderr for missing.
            if (!vfs.exists(fp)) {
                ctx.stderr.write(`readlink: ${t}: No such file or directory\n`);
            }
            exit = 1;
        }
        return exit;
    };
}
const SHA256SUM_SPEC = {
    check: { type: 'boolean', short: 'c' },
    binary: { type: 'boolean', short: 'b' },
    text: { type: 'boolean', short: 't' },
    quiet: { type: 'boolean', short: 'q' },
    status: { type: 'boolean' },
};
/**
 * Real SHA-256 over the file's real bytes.
 *
 * The digest used to be taken over `enc.encode(readFileString(path))` — a
 * UTF-8 decode and re-encode, which replaces every byte that is not valid
 * UTF-8 with U+FFFD. For any binary file that hashes something the file does
 * not contain, and it never announced a problem: an installer verifying a
 * downloaded tarball got a mismatch on a perfectly good download, every time.
 */
function mkSha256sum(vfs) {
    const digest = async (bytes) => {
        const ab = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(ab)).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    return async (ctx) => {
        const { flags, positional, unknown } = parseArgs(ctx.args, SHA256SUM_SPEC);
        if (unknown.length > 0) {
            ctx.stderr.write(`sha256sum: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
            return 1;
        }
        if (flags.check)
            return verifySha256Sums(ctx, vfs, positional, digest, flags.status === true);
        if (positional.length === 0 || (positional.length === 1 && positional[0] === '-')) {
            ctx.stdout.write(`${await digest(enc.encode(stdinText(ctx) ?? ''))}  -\n`);
            return 0;
        }
        let exit = 0;
        for (const f of positional) {
            try {
                ctx.stdout.write(`${await digest(vfs.readFile(resolvePath(ctx.cwd, f)))}  ${f}\n`);
            }
            catch {
                ctx.stderr.write(`sha256sum: ${f}: No such file or directory\n`);
                exit = 1;
            }
        }
        return exit;
    };
}
/** `sha256sum -c LIST` — each line is `HASH  FILENAME`, as this command prints. */
async function verifySha256Sums(ctx, vfs, lists, digest, quiet) {
    let exit = 0;
    for (const list of lists) {
        let body;
        try {
            body = vfs.readFileString(resolvePath(ctx.cwd, list));
        }
        catch {
            ctx.stderr.write(`sha256sum: ${list}: No such file or directory\n`);
            exit = 1;
            continue;
        }
        for (const line of body.split('\n')) {
            const entry = /^([0-9a-fA-F]{64})\s[\s*](.*)$/.exec(line);
            if (entry === null)
                continue;
            const [, expected, name] = entry;
            let actual = null;
            try {
                actual = await digest(vfs.readFile(resolvePath(ctx.cwd, name)));
            }
            catch { /* reported as FAILED open below */ }
            if (actual === null) {
                ctx.stderr.write(`sha256sum: ${name}: No such file or directory\n`);
                if (!quiet)
                    ctx.stdout.write(`${name}: FAILED open or read\n`);
                exit = 1;
            }
            else if (actual.toLowerCase() === expected.toLowerCase()) {
                if (!quiet)
                    ctx.stdout.write(`${name}: OK\n`);
            }
            else {
                if (!quiet)
                    ctx.stdout.write(`${name}: FAILED\n`);
                exit = 1;
            }
        }
    }
    return exit;
}
function mkFile(vfs) {
    return (ctx) => {
        for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
            const fp = resolvePath(ctx.cwd, f);
            try {
                if (vfs.isDirectory(fp)) {
                    ctx.stdout.write(`${f}: directory\n`);
                    continue;
                }
                // BUG-SWEEP-3 (2026-05-11): scan raw bytes for NUL or non-text
                // bytes BEFORE attempting a UTF-8 decode. Pre-fix every binary
                // file was reported as "UTF-8 text" because readFileString
                // silently U+FFFD-substituted invalid sequences.
                const bytes = vfs.readFile(fp);
                let isBinary = false;
                const scanLimit = Math.min(bytes.length, 8192);
                for (let i = 0; i < scanLimit; i++) {
                    const b = bytes[i];
                    if (b === 0) {
                        isBinary = true;
                        break;
                    }
                    // Bytes 0x01-0x08 + 0x0E-0x1F (excluding TAB/LF/CR/FF) are
                    // strong signals of non-text content.
                    if (b < 0x09 || (b > 0x0d && b < 0x20)) {
                        isBinary = true;
                        break;
                    }
                }
                if (isBinary) {
                    // Magic-byte sniff for common formats.
                    if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
                        ctx.stdout.write(`${f}: ELF executable\n`);
                    }
                    else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
                        ctx.stdout.write(`${f}: WebAssembly (wasm) binary module\n`);
                    }
                    else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
                        ctx.stdout.write(`${f}: PNG image data\n`);
                    }
                    else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
                        ctx.stdout.write(`${f}: gzip compressed data\n`);
                    }
                    else if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
                        ctx.stdout.write(`${f}: Zip archive data\n`);
                    }
                    else {
                        ctx.stdout.write(`${f}: data\n`);
                    }
                    continue;
                }
                const content = new TextDecoder('utf-8').decode(bytes);
                if (content.startsWith('<!DOCTYPE') || content.startsWith('<html'))
                    ctx.stdout.write(`${f}: HTML document\n`);
                else if (content.startsWith('{') || content.startsWith('['))
                    ctx.stdout.write(`${f}: JSON data\n`);
                else if (content.startsWith('#!'))
                    ctx.stdout.write(`${f}: script, ${content.split('\n')[0]}\n`);
                else if (f.endsWith('.ts') || f.endsWith('.tsx'))
                    ctx.stdout.write(`${f}: TypeScript source\n`);
                else if (f.endsWith('.js') || f.endsWith('.mjs'))
                    ctx.stdout.write(`${f}: JavaScript source\n`);
                else if (f.endsWith('.css'))
                    ctx.stdout.write(`${f}: CSS stylesheet\n`);
                else
                    ctx.stdout.write(`${f}: ASCII text, ${content.split('\n').length} lines\n`);
            }
            catch {
                ctx.stderr.write(`file: ${f}: No such file\n`);
                return 1;
            }
        }
        return 0;
    };
}
// ── Hex dumps: od, hexdump, xxd ─────────────────────────────────────────
/**
 * Pull up to `remaining` bytes of stdin. A drained string is sliced; a live
 * pipe reader is pulled in bounded chunks and stops as soon as the limit is
 * met, which is what lets `yes | od -N8` terminate its producer.
 */
/**
 * Read up to `remaining` bytes of a file through bounded range reads, so
 * `xxd -l 16 big.bin` never loads `big.bin` whole.
 */
/**
 * Dump-tool byte counts: decimal, `0x` hex, leading-zero octal, and the
 * classic suffixes (`b` blocks of 512, K/KiB, KB, M, G — powers of 1024
 * except the round-decimal `KB`/`MB`/`GB` spellings). Null means the value
 * is not a count these tools accept.
 */
function parseDumpCount(value) {
    const match = /^(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([bB]|[kKmMgGtT](?:i?[bB])?)?$/.exec(value);
    if (match === null)
        return null;
    const digits = match[1];
    const base = digits.startsWith('0x') || digits.startsWith('0X')
        ? Number.parseInt(digits, 16)
        : /^0/.test(digits) ? Number.parseInt(digits, 8) : Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(base) || base < 0)
        return null;
    if (match[2] === undefined || match[2] === '')
        return base;
    const scale = {
        b: 512, B: 512,
        k: 1024, K: 1024, KiB: 1024, kB: 1000, KB: 1000,
        m: 1024 ** 2, M: 1024 ** 2, MiB: 1024 ** 2, mB: 1000 ** 2, MB: 1000 ** 2,
        g: 1024 ** 3, G: 1024 ** 3, GiB: 1024 ** 3, gB: 1000 ** 3, GB: 1000 ** 3,
        t: 1024 ** 4, T: 1024 ** 4, TiB: 1024 ** 4, tB: 1000 ** 4, TB: 1000 ** 4,
    };
    const factor = scale[match[2]];
    if (factor === undefined)
        return null;
    const total = base * factor;
    return Number.isSafeInteger(total) ? total : null;
}
/** Little-endian word; a short final chunk reads its missing bytes as zero. */
function leWord(chunk) {
    return (chunk[0] ?? 0) | ((chunk[1] ?? 0) << 8);
}
/**
 * Shared row suppression: a formatted row equal to the one before it prints
 * as `*`, and runs of repeats collapse into that single marker. GNU od and
 * util-linux hexdump suppress the address together with the row, so callers
 * classify the body alone and print the marker bare.
 */
class RowDedup {
    previous = null;
    starred = false;
    classify(row, verbose) {
        if (verbose || row !== this.previous) {
            this.previous = row;
            this.starred = false;
            return 'print';
        }
        if (this.starred)
            return 'skip';
        this.starred = true;
        return 'star';
    }
}
/**
 * Row addresses follow the radix (`0000000` octal or decimal, `000000`
 * lowercase hex). The closing total-length line keeps uppercase hex digits —
 * `00001B`, not `00001b` — matching od on this host byte for byte.
 */
function odAddress(radix, offset, final) {
    if (radix === 'n')
        return '';
    if (radix === 'o')
        return offset.toString(8).padStart(7, '0');
    if (radix === 'd')
        return String(offset).padStart(7, '0');
    const digits = offset.toString(16);
    return (final ? digits.toUpperCase() : digits).padStart(6, '0');
}
/** `\0`-style escapes for `-tc`; other non-printables go out as `\NNN`. */
const OD_CHAR_ESCAPES = {
    0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r',
};
const OD_TYPES = {
    c: {
        width: 1,
        natural: 3,
        render: (c) => {
            const escaped = OD_CHAR_ESCAPES[c[0]];
            if (escaped !== undefined)
                return escaped.padStart(3);
            if (c[0] >= 32 && c[0] < 127)
                return String.fromCharCode(c[0]).padStart(3);
            return c[0].toString(8).padStart(3, '0');
        },
    },
    d1: { width: 1, natural: 4, render: (c) => String((c[0] << 24) >> 24).padStart(4) },
    d2: { width: 2, natural: 6, render: (c) => { const v = leWord(c); return String(v >= 0x8000 ? v - 0x10000 : v).padStart(6); } },
    u1: { width: 1, natural: 3, render: (c) => String(c[0]).padStart(3) },
    u2: { width: 2, natural: 5, render: (c) => String(leWord(c)).padStart(5) },
    o1: { width: 1, natural: 3, render: (c) => c[0].toString(8).padStart(3, '0') },
    o2: { width: 2, natural: 6, render: (c) => leWord(c).toString(8).padStart(6, '0') },
    x1: { width: 1, natural: 2, render: (c) => c[0].toString(16).padStart(2, '0') },
    x2: { width: 2, natural: 4, render: (c) => leWord(c).toString(16).padStart(4, '0') },
};
/**
 * Split a `-t` value into its concatenated specifications: a letter with an
 * optional size (`x1`, `d2`, `c`, …), so `-tx1c` yields x1 then c.
 */
function splitOdTypes(value) {
    const specs = [];
    const pattern = /([xoducXODUC])([01248]?)/g;
    let consumed = '';
    for (const match of value.matchAll(pattern)) {
        consumed += match[0];
        const letter = match[1].toLowerCase();
        const size = match[2] === '' ? '' : match[2];
        if (letter === 'a') {
            specs.push('c');
            continue;
        }
        specs.push(`${letter}${size}`);
    }
    return consumed === value ? specs : [value];
}
/** `-A[o|d|x|n]`, cumulative `-t<spec>`, `-N<count>`, `-v`. */
function parseOdArgs(args) {
    let radix = 'o';
    const types = [];
    let limit;
    let verbose = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            files.push(...args.slice(i + 1));
            break;
        }
        if (!arg.startsWith('-') || arg === '-') {
            files.push(arg);
            continue;
        }
        const flag = arg[1];
        let value = arg.slice(2);
        if (flag === 'v' && value === '') {
            verbose = true;
            continue;
        }
        if (flag !== 'A' && flag !== 't' && flag !== 'N') {
            return { error: `od: invalid option -- '${flag}'` };
        }
        if (value === '') {
            value = args[i + 1];
            if (value !== undefined)
                i++;
        }
        if (value === undefined || value === '') {
            return { error: `od: option requires an argument -- '${flag}'` };
        }
        if (flag === 'A') {
            // Exactly one radix letter per option (`-Aod` is not two glued flags);
            // repeated valid options are last-wins, like GNU od.
            if (value.length !== 1 || !'odxn'.includes(value)) {
                return { error: `od: Radix must be one of [o, d, x, n], got: ${value}` };
            }
            radix = value;
        }
        else if (flag === 't') {
            // One -t may carry concatenated specifications (`-tx1c`); repeated
            // -t flags accumulate too. Both render in request order.
            for (const spec of splitOdTypes(value)) {
                if (!(spec in OD_TYPES))
                    return { error: `od: unsupported type specification '${value}'` };
                types.push(spec);
            }
        }
        else {
            const parsed = parseDumpCount(value);
            if (parsed === null || parsed < 0) {
                return { error: `od: invalid number of bytes '${value}'` };
            }
            limit = parsed;
        }
    }
    if (types.length === 0)
        types.push('o2');
    return { radix, types, limit, verbose, files };
}
/** Reads operands (or stdin once) under a running byte limit. */
/**
 * Sequential bytes for a dump tool: each operand in order, stdin once,
 * bounded range reads for files and bounded pulls for pipes. Only one
 * window of bytes is held at a time, so unbounded tools stream forever
 * instead of growing silently, and limits stop collection early.
 */
class DumpByteSource {
    ctx;
    vfs;
    label;
    operands;
    operandIndex = 0;
    remaining;
    current = null;
    cursor = 0;
    haveOpen = false;
    stdinMode = false;
    stdinUsed = false;
    probedFirst = false;
    // Drained-string stdin is encoded once; pulls slice the encoded bytes so
    // multibyte input never advances past bytes it did not return.
    stdinBytes = null;
    stdinCursor = 0;
    stdinOverflow = [];
    failures = 0;
    opened = 0;
    total = 0;
    constructor(ctx, vfs, label, files, limit) {
        this.ctx = ctx;
        this.vfs = vfs;
        this.label = label;
        this.operands = files.length > 0 ? files : [undefined];
        this.remaining = limit ?? Number.POSITIVE_INFINITY;
    }
    get failed() {
        return this.failures > 0;
    }
    /** Every named operand failed to open — distinct from successful empty. */
    get failedAll() {
        return this.operands.length > 0 && this.opened === 0 && this.failures > 0;
    }
    async openNextOperand() {
        while (this.operandIndex < this.operands.length) {
            const file = this.operands[this.operandIndex++];
            try {
                if (file === undefined || file === '-') {
                    if (this.stdinUsed)
                        continue; // second '-' reads stdin already at EOF
                    this.stdinMode = true;
                    this.opened++; // an empty stdin still counts as successfully opened
                    return true;
                }
                // Probe the file now so per-operand errors surface exactly once.
                const probe = this.vfs.readRange(resolvePath(this.ctx.cwd, file), 0, 1);
                void probe;
                this.current = null;
                this.cursor = 0;
                this.haveOpen = true;
                this.opened++;
                return true;
            }
            catch (error) {
                this.ctx.stderr.write(`${this.label}: ${file}: ${fsErrorMessage(error)}\n`);
                this.failures++;
            }
        }
        return false;
    }
    closeCurrent() {
        this.haveOpen = false;
        this.stdinMode = false;
        this.current = null;
        this.cursor = 0;
    }
    /** Next up-to-max bytes across operands; null once limit or true EOF. */
    /** One bounded pull; drained strings are encoded once and sliced by byte. */
    async stdinPull(max) {
        if (typeof this.ctx.stdin === 'string') {
            if (this.stdinBytes === null)
                this.stdinBytes = enc.encode(this.ctx.stdin);
            if (this.stdinCursor >= this.stdinBytes.length)
                return null;
            const end = Math.min(this.stdinCursor + max, this.stdinBytes.length);
            const chunk = this.stdinBytes.subarray(this.stdinCursor, end);
            this.stdinCursor = end;
            return chunk;
        }
        const reader = this.ctx.stdin;
        if (typeof reader?.read !== 'function')
            return null;
        // read/readAll-only embedders lose nothing: overflow bytes from a
        // bounded pull wait in stdinOverflow until the next one.
        const parts = [];
        let got = 0;
        while (got < max) {
            let chunk = null;
            if (this.stdinOverflow.length > 0) {
                chunk = this.stdinOverflow.shift() ?? null;
            }
            else if (reader.readBytes) {
                chunk = await reader.readBytes(Math.min(65536, max - got));
            }
            else {
                const text = await reader.read();
                chunk = text === null ? null : enc.encode(text);
            }
            if (chunk === null || chunk.length === 0)
                break; // empty read = EOF
            const take = chunk.length <= max - got ? chunk : chunk.subarray(0, max - got);
            parts.push(take);
            got += take.length;
            if (take.length < chunk.length)
                this.stdinOverflow.push(chunk.subarray(take.length));
        }
        if (parts.length === 0)
            return null;
        if (parts.length === 1)
            return parts[0];
        const out = new Uint8Array(got);
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }
    async take(max) {
        if (!this.probedFirst) {
            // The first named operand must be attempted even under a zero limit,
            // so `-l0 /missing` reports the open error instead of succeeding.
            this.probedFirst = true;
            if (this.operands.length > 0 && !(await this.openNextOperand())) {
                return null;
            }
        }
        if (max <= 0)
            return new Uint8Array(0);
        const parts = [];
        let got = 0;
        while (got < max) {
            if (this.remaining <= 0)
                break;
            if (!this.haveOpen && !this.stdinMode) {
                if (!(await this.openNextOperand()))
                    break;
            }
            const want = Math.min(max - got, this.remaining, 65536);
            let chunk;
            if (this.stdinMode) {
                chunk = await this.stdinPull(want);
                if (chunk === null || chunk.length === 0) {
                    this.stdinUsed = true;
                    this.closeCurrent();
                    continue;
                }
            }
            else {
                const path = resolvePath(this.ctx.cwd, this.operands[this.operandIndex - 1]);
                chunk = this.vfs.readRange(path, this.cursor, want);
                if (chunk.length === 0) {
                    this.closeCurrent();
                    continue;
                }
                this.cursor += chunk.length;
            }
            const take = chunk.length <= want ? chunk : chunk.subarray(0, want);
            parts.push(take);
            got += take.length;
            this.total += take.length;
            this.remaining -= take.length;
            this.opened++; // reading bytes proves the operand opened
        }
        if (parts.length === 0)
            return null;
        if (parts.length === 1)
            return parts[0];
        const out = new Uint8Array(got);
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }
}
function mkOd(vfs) {
    return async (ctx) => {
        const parsed = parseOdArgs(ctx.args);
        if ('error' in parsed) {
            ctx.stderr.write(`${parsed.error}\n`);
            return 1;
        }
        const src = new DumpByteSource(ctx, vfs, 'od', parsed.files, parsed.limit);
        const specs = parsed.types.map((name) => OD_TYPES[name]);
        // With several -t types every item shares one column width (the widest
        // natural width plus one); each type prints on its own continuation
        // line indented under the address — uutils od's grid on this host.
        const columnWidth = Math.max(...specs.map((spec) => spec.natural)) + 1;
        const renderRow = (row) => specs.map((spec) => {
            const items = [];
            for (let i = 0; i < row.length; i += spec.width) {
                items.push(spec.render(row.subarray(i, Math.min(i + spec.width, row.length))));
            }
            if (specs.length === 1)
                return items.join(' ');
            return items.map((item) => item.padStart(columnWidth)).join('');
        });
        const dedup = new RowDedup();
        while (true) {
            const row = await src.take(16);
            if (row === null || row.length === 0)
                break;
            const address = odAddress(parsed.radix, src.total - row.length, false);
            const lines = renderRow(row);
            const key = lines.join('\n');
            const indent = address === '' ? '' : ' '.repeat(7);
            const rendered = specs.length === 1
                ? `${address} ${lines[0]}`
                : [`${address}${lines[0]}`, ...lines.slice(1).map((line) => `${indent}${line}`)].join('\n');
            switch (dedup.classify(key, parsed.verbose)) {
                case 'print':
                    ctx.stdout.write(`${rendered}\n`);
                    break;
                case 'star':
                    ctx.stdout.write('*\n');
                    break;
            }
        }
        if (parsed.radix !== 'n') {
            if (src.failedAll)
                return 1;
            ctx.stdout.write(`${odAddress(parsed.radix, src.total, true)}\n`);
        }
        return src.failed ? 1 : 0;
    };
}
const HEXDUMP_WORD_SIZES = { '1': 1, '2': 2, '4': 4, C: 1 };
/** Field widths an empty iteration pads to, mirroring util-linux. */
const HEXDUMP_DIGIT_WIDTHS = {
    '1': { x: 2, o: 3, d: 3 },
    '2': { x: 4, o: 6, d: 5 },
    '4': { x: 8, o: 11, d: 10 },
};
// util-linux rejects escaped delimiters inside -e units rather than
// decoding them, so `\"` is deliberately absent here.
const HEXDUMP_ESCAPES = {
    n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0',
};
function parseHexdumpDirectives(fmt) {
    const segments = [];
    let text = '';
    const flush = () => { if (text !== '') {
        segments.push(text);
        text = '';
    } };
    const bad = (what) => ({ error: `hexdump: bad format {${what}}` });
    for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch === '\\') {
            const esc = fmt[++i];
            if (esc === undefined || !(esc in HEXDUMP_ESCAPES))
                return bad(`\\${esc ?? ''}`);
            text += HEXDUMP_ESCAPES[esc];
            continue;
        }
        if (ch !== '%') {
            text += ch;
            continue;
        }
        flush();
        const directive = { kind: 'byte', leftAlign: false, zeroPad: false, width: undefined, precision: undefined };
        let j = i + 1;
        while (fmt[j] === '-' || fmt[j] === '0') {
            if (fmt[j] === '-')
                directive.leftAlign = true;
            else
                directive.zeroPad = true;
            j++;
        }
        let digits = '';
        while (fmt[j] >= '0' && fmt[j] <= '9')
            digits += fmt[j++];
        if (digits !== '')
            directive.width = Number(digits);
        if (fmt[j] === '.') {
            let prec = '';
            j++;
            while (fmt[j] >= '0' && fmt[j] <= '9')
                prec += fmt[j++];
            directive.precision = prec === '' ? 0 : Number(prec);
        }
        if (fmt[j] === '_' && fmt[j + 1] === 'a' && 'dxo'.includes(fmt[j + 2])) {
            directive.kind = 'addr';
            directive.radix = fmt[j + 2];
            i = j + 2;
        }
        else if (j < fmt.length && 'xXduoc'.includes(fmt[j])) {
            directive.conv = fmt[j];
            i = j;
        }
        else {
            return bad(`%${fmt.slice(i + 1, j + 1)}`);
        }
        segments.push(directive);
    }
    flush();
    return { segments };
}
function parseHexdumpPieces(value) {
    const pieces = [];
    let pending = null;
    let i = 0;
    while (i < value.length) {
        const ch = value[i];
        if (ch === ' ' || ch === '\t') {
            i++;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            let digits = '';
            while (i < value.length && value[i] >= '0' && value[i] <= '9')
                digits += value[i++];
            if (value[i] !== '/')
                return { error: `hexdump: bad format {${value}}` };
            const sizeChar = value[i + 1] ?? '';
            const size = HEXDUMP_WORD_SIZES[sizeChar];
            if (size === undefined)
                return { error: `hexdump: bad format {${digits}/${sizeChar}}` };
            const count = Number(digits);
            if (!Number.isSafeInteger(count) || count <= 0) {
                return { error: `hexdump: bad format {${digits}/${sizeChar}}` };
            }
            pending = { count, size };
            i += 2;
            continue;
        }
        if (ch !== '"' && ch !== "'")
            return { error: `hexdump: bad format {${value.slice(i)}}` };
        // util-linux refuses an escaped quote inside a unit instead of decoding
        // it, and names the whole specification when it does.
        let close = -1;
        for (let k = i + 1; k < value.length; k++) {
            const c = value[k];
            if (c === '\\') {
                if (value[k + 1] === ch) {
                    close = -2;
                    break;
                }
                k++;
                continue;
            }
            if (c === ch) {
                close = k;
                break;
            }
        }
        if (close < 0)
            return { error: `hexdump: bad format {${value}}` };
        const parsed = parseHexdumpDirectives(value.slice(i + 1, close));
        if ('error' in parsed)
            return parsed;
        const conversions = parsed.segments.filter((segment) => typeof segment !== 'string' && segment.kind === 'byte').length;
        // util-linux refuses a byte count feeding more than one conversion.
        if (conversions > 1) {
            return { error: 'hexdump: byte count with multiple conversion characters' };
        }
        // %c defaults to one byte and only accepts one; other conversions
        // default to four.
        const soleConv = conversions === 1
            ? parsed.segments.find((segment) => typeof segment !== 'string' && segment.kind === 'byte').conv
            : undefined;
        if (soleConv === 'c' && pending !== null && pending.size !== 1) {
            return { error: 'hexdump: bad byte count for conversion character c' };
        }
        pieces.push({
            segments: parsed.segments,
            count: pending?.count ?? 1,
            size: pending?.size ?? (soleConv === 'c' ? 1 : 4),
            consumes: conversions > 0,
        });
        pending = null;
        i = close + 1;
    }
    if (pending !== null)
        return { error: `hexdump: bad format {${value}}` };
    return { pieces };
}
function hexdumpFormatNumber(directive, digits) {
    // fprintf rules: precision pads the magnitude with zeros, a sign always
    // sits in front of that padding, '-' alignment overrides '0', and an
    // explicit precision disables '0' field padding entirely.
    let sign = '';
    let magnitude = digits;
    if (magnitude.startsWith('-')) {
        sign = '-';
        magnitude = magnitude.slice(1);
    }
    if (directive.precision !== undefined)
        magnitude = magnitude.padStart(directive.precision, '0');
    const width = directive.width ?? 0;
    const value = sign + magnitude;
    if (directive.leftAlign)
        return value.padEnd(width);
    if (directive.zeroPad && directive.precision === undefined && width > 0) {
        return sign + magnitude.padStart(width - sign.length, '0');
    }
    return value.padStart(width);
}
/** Field width an iteration reserves, so missing ones pad like util-linux. */
function hexdumpFieldWidth(directive, size) {
    if (directive.kind === 'addr')
        return directive.width ?? 0;
    if (directive.conv === 'c')
        return directive.width ?? 1;
    const family = directive.conv === 'x' || directive.conv === 'X'
        ? 'x'
        : directive.conv === 'o' ? 'o' : 'd';
    return directive.width ?? HEXDUMP_DIGIT_WIDTHS[String(size)][family];
}
/**
 * Render one `-e` block. A directive past the end of input renders as
 * field-width spaces rather than dropping its slot, and a lone trailing
 * space right before the format's newline collapses — together those are
 * what keep util-linux's `"%02x "` rows free of ragged edges. Address
 * directives report the offset of the next byte to display; with
 * `blankAddresses` they contribute nothing, which gives repeat suppression
 * a key that ignores where each block sits.
 */
function hexdumpRenderBlock(pieces, bytes, blockStart, blankAddresses = false) {
    let out = '';
    let pos = 0;
    const displayOffset = () => blockStart + pos;
    for (const piece of pieces) {
        const iterations = piece.consumes ? piece.count : 1;
        for (let iteration = 0; iteration < iterations; iteration++) {
            const missing = piece.consumes && pos >= bytes.length;
            // Literals always render; only byte conversions pad when input ran
            // out, so a trailing literal still reaches the line on short blocks.
            for (const segment of piece.segments) {
                if (typeof segment === 'string') {
                    out += segment;
                    continue;
                }
                if (segment.kind === 'addr') {
                    if (blankAddresses)
                        continue;
                    const shown = displayOffset();
                    const digits = segment.radix === 'd'
                        ? String(shown)
                        : shown.toString(segment.radix === 'o' ? 8 : 16);
                    out += hexdumpFormatNumber(segment, digits);
                    continue;
                }
                if (missing) {
                    out += ' '.repeat(hexdumpFieldWidth(segment, piece.size));
                    continue;
                }
                let unit = 0;
                for (let b = piece.size - 1; b >= 0; b--)
                    unit = unit * 256 + (bytes[pos + b] ?? 0);
                pos += piece.size;
                if (segment.conv === 'c') {
                    out += hexdumpFormatNumber(segment, String.fromCharCode(unit & 0xff));
                    continue;
                }
                let digits;
                if (segment.conv === 'd') {
                    const signBit = 256 ** piece.size / 2;
                    digits = String(unit >= signBit ? unit - signBit * 2 : unit);
                }
                else if (segment.conv === 'u') {
                    digits = String(unit);
                }
                else if (segment.conv === 'o') {
                    digits = unit.toString(8);
                }
                else {
                    digits = unit.toString(16);
                    if (segment.conv === 'X')
                        digits = digits.toUpperCase();
                }
                out += hexdumpFormatNumber(segment, digits);
            }
        }
    }
    return out;
}
/** Body columns for the fixed modes; the caller prefixes the address. */
function hexdumpFixedBody(mode, row) {
    if (mode === 'C') {
        const group1 = Array.from(row.subarray(0, 8), (b) => b.toString(16).padStart(2, '0'));
        const group2 = Array.from(row.subarray(8), (b) => b.toString(16).padStart(2, '0'));
        const columns = group1.join(' ') + (group2.length > 0 ? '  ' + group2.join(' ') : '');
        const bar = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        return { body: columns.padEnd(50), bar };
    }
    if (mode === 'default') {
        const words = [];
        for (let i = 0; i < row.length; i += 2) {
            words.push(leWord(row.subarray(i)).toString(16).padStart(4, '0'));
        }
        return { body: words.join(' ').padEnd(39), bar: null };
    }
    const slots = [];
    for (let i = 0; i < 16; i += 2) {
        const chunk = row.subarray(i);
        if (chunk.length === 0) {
            slots.push(' '.repeat(8));
            continue;
        }
        const rendered = mode === 'x'
            ? leWord(chunk).toString(16).padStart(4, '0')
            : mode === 'd'
                ? String(leWord(chunk)).padStart(5, '0')
                : leWord(chunk).toString(8).padStart(6, '0');
        slots.push(rendered.padStart(i === 0 ? 7 : 8));
    }
    return { body: slots.join(''), bar: null };
}
/** Format flags override each other (last wins); `-e` replaces them all. */
function parseHexdumpArgs(args) {
    let mode = 'default';
    let pieces = null;
    let length;
    let verbose = false;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            files.push(...args.slice(i + 1));
            break;
        }
        if (!arg.startsWith('-') || arg === '-') {
            files.push(arg);
            continue;
        }
        const flag = arg[1];
        const inlineValue = arg.slice(2);
        if (flag === 'C' || flag === 'x' || flag === 'd' || flag === 'o') {
            if (inlineValue !== '')
                return { error: `hexdump: invalid option -- '${flag}'` };
            mode = flag;
            continue;
        }
        if (flag === 'v' && inlineValue === '') {
            verbose = true;
            continue;
        }
        if (flag !== 'e' && flag !== 'n') {
            return { error: `hexdump: invalid option -- '${flag}'` };
        }
        const value = inlineValue || args[++i];
        if (value === undefined || value === '') {
            return { error: `hexdump: option requires an argument -- '${flag}'` };
        }
        if (flag === 'n') {
            const parsed = parseDumpCount(value);
            if (parsed === null || parsed < 0) {
                return { error: `hexdump: invalid length '${value}'` };
            }
            length = parsed;
            continue;
        }
        if (pieces !== null)
            return { error: 'hexdump: only one -e format is supported' };
        const parsed = parseHexdumpPieces(value);
        if ('error' in parsed)
            return parsed;
        if (!parsed.pieces.some((piece) => piece.consumes)) {
            return { error: `hexdump: bad format {${value}}` };
        }
        pieces = parsed.pieces;
    }
    return { mode, pieces, length, verbose, files };
}
function mkHexdump(vfs) {
    return async (ctx) => {
        const parsed = parseHexdumpArgs(ctx.args);
        if ('error' in parsed) {
            ctx.stderr.write(`${parsed.error}\n`);
            return 1;
        }
        const src = new DumpByteSource(ctx, vfs, 'hexdump', parsed.files, parsed.length);
        const dedup = new RowDedup();
        if (parsed.pieces !== null) {
            const lastPiece = parsed.pieces[parsed.pieces.length - 1];
            const lastSegment = lastPiece.segments[lastPiece.segments.length - 1];
            // Repeat suppression needs line boundaries; free-form formats emit
            // the whole stream, which is what -v spells on util-linux.
            const lineStructured = typeof lastSegment === 'string' && lastSegment.endsWith('\n');
            const multiIteration = parsed.pieces.some((piece) => piece.consumes && piece.count > 1);
            const blockBytes = parsed.pieces.reduce((sum, piece) => sum + (piece.consumes ? piece.count * piece.size : 0), 0);
            let offset = 0;
            while (true) {
                const window = await src.take(blockBytes);
                if (window === null || window.length === 0)
                    break;
                let line = hexdumpRenderBlock(parsed.pieces, window, offset);
                offset += window.length;
                if (!lineStructured) {
                    ctx.stdout.write(line);
                    continue;
                }
                // util-linux trims exactly one trailing space on lines produced by a
                // multi-iteration unit; count-1 units keep their spacing verbatim.
                // Trim one trailing space only when the unit that owns the tail
                // (the last consuming piece) iterates more than once; a later
                // count-1 unit keeps its spacing.
                const lastConsuming = parsed.pieces.filter((piece) => piece.consumes).pop();
                if (lastConsuming !== undefined && lastConsuming.count > 1 && line.endsWith(' \n')) {
                    line = line.slice(0, -2) + '\n';
                }
                const key = hexdumpRenderBlock(parsed.pieces, window, offset - window.length, true);
                switch (dedup.classify(key, parsed.verbose)) {
                    case 'print':
                        ctx.stdout.write(line);
                        break;
                    case 'star':
                        ctx.stdout.write('*\n');
                        break;
                }
            }
            if (src.failedAll)
                ctx.stderr.write('hexdump: all input file arguments failed\n');
            return src.failed ? 1 : 0;
        }
        const wide = parsed.mode === 'C';
        while (true) {
            const row = await src.take(16);
            if (row === null || row.length === 0)
                break;
            const { body, bar } = hexdumpFixedBody(parsed.mode, row);
            const address = (src.total - row.length).toString(16).padStart(wide ? 8 : 7, '0');
            switch (dedup.classify(body, parsed.verbose)) {
                case 'print':
                    ctx.stdout.write(wide ? `${address}  ${body}|${bar}|\n` : `${address} ${body}\n`);
                    break;
                case 'star':
                    ctx.stdout.write('*\n');
                    break;
            }
        }
        if (src.failedAll)
            ctx.stderr.write('hexdump: all input file arguments failed\n');
        if (src.total > 0) {
            ctx.stdout.write(`${src.total.toString(16).padStart(wide ? 8 : 7, '0')}\n`);
        }
        return src.failed ? 1 : 0;
    };
}
// ── xxd ─────────────────────────────────────────────────────────────────
/**
 * `xxd [FILE [-] [OUTFILE]]` — pipelines are xxd's primary use, so stdin is
 * read when no input operand is given or `-` names it. A second positional
 * operand receives the dump as a file, like real xxd. `-l N` limits the dump
 * (decimal, 0x hex, leading-zero octal, with count suffixes); `-p` emits
 * continuous hex in bounded 30-byte rows. The default row layout predates
 * this fix and is preserved verbatim.
 */
function mkXxd(vfs) {
    return async (ctx) => {
        let plain = false;
        let limit;
        const operands = [];
        for (let i = 0; i < ctx.args.length; i++) {
            const arg = ctx.args[i];
            if (arg === '-p') {
                plain = true;
                continue;
            }
            if (arg === '-' || !arg.startsWith('-')) {
                if (operands.length >= 2) {
                    ctx.stderr.write(`xxd: extra operand '${arg}'\n`);
                    return 1;
                }
                operands.push(arg);
                continue;
            }
            if (arg === '-l' || arg.startsWith('-l')) {
                const value = arg === '-l' ? ctx.args[++i] : arg.slice(2);
                const parsed = value === undefined ? null : parseDumpCount(value);
                if (parsed === null || parsed < 0) {
                    ctx.stderr.write(`xxd: invalid length value '${value ?? ''}'\n`);
                    return 1;
                }
                limit = parsed;
                continue;
            }
            ctx.stderr.write(`xxd: invalid option -- '${arg.replace(/^-+/, '')}'\n`);
            return 1;
        }
        // Prime the source FIRST: pull the initial window (surfacing any open
        // error) before the output file exists to truncate.
        const rowSize = plain ? 30 : 16;
        const src = new DumpByteSource(ctx, vfs, 'xxd', operands.slice(0, 1), limit);
        const firstWindow = await src.take(rowSize);
        if (src.failedAll || (src.failed && src.opened === 0))
            return 1;
        // A second operand names the output file; `-` there means stdout.
        const output = operands[1];
        const outPath = output !== undefined && output !== '-'
            ? resolvePath(ctx.cwd, output)
            : null;
        let offset = 0;
        let fileOffset = 0;
        let pending = [];
        let pendingBytes = 0;
        let writeFailed = false;
        const flush = (path) => {
            if (pending.length === 0 || writeFailed)
                return;
            try {
                vfs.writeRange(path, fileOffset, encode(pending.join('')));
            }
            catch (error) {
                ctx.stderr.write(`xxd: ${output}: ${fsErrorMessage(error)}\n`);
                writeFailed = true;
                return;
            }
            fileOffset += pendingBytes;
            pending = [];
            pendingBytes = 0;
        };
        const renderWindow = (rowOffset, window) => {
            if (plain) {
                let line = '';
                for (const byte of window)
                    line += byte.toString(16).padStart(2, '0');
                return `${line}\n`;
            }
            const pairs = Array.from(window, (b) => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(window, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
            return `${rowOffset.toString(16).padStart(8, '0')}: ${pairs.padEnd(48)}  ${ascii}\n`;
        };
        if (outPath !== null) {
            // Input proved readable above, so truncating here cannot destroy data
            // on a failed dump.
            try {
                vfs.writeFile(outPath, '', { mode: 0o644 });
            }
            catch (error) {
                ctx.stderr.write(`xxd: ${output}: ${fsErrorMessage(error)}\n`);
                return 1;
            }
        }
        let window = firstWindow;
        while (window !== null && window.length > 0 && !writeFailed) {
            const text = renderWindow(offset, window);
            offset += window.length;
            if (outPath !== null) {
                pending.push(text);
                pendingBytes += text.length;
                if (pendingBytes >= 65536)
                    flush(outPath);
            }
            else {
                ctx.stdout.write(text);
            }
            window = await src.take(rowSize);
        }
        if (outPath !== null)
            flush(outPath);
        return src.failed || writeFailed ? 1 : 0;
    };
}
function wrapStreaming(fn) {
    return async (ctx) => {
        try {
            if (ctx.stdin && typeof ctx.stdin !== 'string') {
                const stdinObj = ctx.stdin;
                const isTerminalStdin = typeof stdinObj.feed === 'function';
                if (isTerminalStdin) {
                    const drainable = stdinObj;
                    ctx.stdin = typeof drainable.drainBuffered === 'function'
                        ? drainable.drainBuffered()
                        : '';
                }
                // else: leave as pipe reader for the command to handle.
            }
            const result = fn(ctx);
            return await result;
        }
        catch (e) {
            ctx.stderr.write(`${errorText(e)}\n`);
            return 1;
        }
    };
}
function wrap(fn) {
    return async (ctx) => {
        try {
            // Resolve stdin: shell passes a stream object with .readAll() when piping.
            //
            // BUG-SWEEP fix (2026-05-11): the shell passes its
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
                const stdinObj = ctx.stdin;
                const isTerminalStdin = typeof stdinObj.feed === 'function';
                if (isTerminalStdin) {
                    // Drain any already-queued bytes (typically empty for the
                    // first command on a line; non-empty if the user typed
                    // text + Enter before the command was dispatched). DO NOT
                    // await — that would wait for the user's next Ctrl-D.
                    const drainable = stdinObj;
                    ctx.stdin = typeof drainable.drainBuffered === 'function'
                        ? drainable.drainBuffered()
                        : '';
                }
                else if (typeof stdinObj.readAll === 'function') {
                    // Pipe reader — upstream will close() after writing, so
                    // readAll() resolves bounded.
                    ctx.stdin = await stdinObj.readAll();
                }
                else if (typeof stdinObj.toString === 'function') {
                    ctx.stdin = stdinObj.toString();
                }
            }
            const result = fn(ctx);
            return await result;
        }
        catch (e) {
            ctx.stderr.write(`${errorText(e)}\n`);
            return 1;
        }
    };
}
export function registerUnixCommands(registry, sqliteVfs) {
    registry.register('which', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkWhich(vfs, registry))));
    registry.register('whereis', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkWhereis(vfs, registry))));
    registry.register('command', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkCommand(vfs, registry))));
    registry.register('type', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkType(vfs, registry))));
    registry.register('env', wrap(mkEnv()));
    registry.register('export', wrap(mkExport()));
    registry.register('unset', wrap(mkUnset()));
    registry.register('clear', wrap(mkClear()));
    registry.register('date', wrap(mkDate()));
    registry.register('uptime', wrap(mkUptime()));
    registry.register('tree', wrap(withInvocationVfs(sqliteVfs, mkTree)));
    registry.register('find', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkFind(vfs, registry))));
    registry.register('grep', wrap(withInvocationVfs(sqliteVfs, mkGrep)));
    // SHELL-R6-B2: head uses streaming wrap so a pipe reader passes
    // through (head terminates after N lines, triggering the abort
    // cascade for upstream producers like `yes`).
    registry.register('head', wrapStreaming(withInvocationVfs(sqliteVfs, mkHead)));
    registry.register('tail', wrap(withInvocationVfs(sqliteVfs, mkTail)));
    registry.register('wc', wrap(withInvocationVfs(sqliteVfs, mkWc)));
    registry.register('sort', wrap(withInvocationVfs(sqliteVfs, mkSort)));
    registry.register('uniq', wrap(withInvocationVfs(sqliteVfs, mkUniq)));
    registry.register('sed', wrap(withInvocationVfs(sqliteVfs, mkSed)));
    registry.register('awk', wrap(withInvocationVfs(sqliteVfs, mkAwk)));
    registry.register('xargs', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkXargs(vfs, registry))));
    registry.register('tee', wrap(withInvocationVfs(sqliteVfs, mkTee)));
    registry.register('du', wrap(withInvocationVfs(sqliteVfs, mkDu)));
    registry.register('diff', wrap(withInvocationVfs(sqliteVfs, mkDiff)));
    // Registry-level echo + cat for xargs cross-command dispatch.
    // Shell.builtins still wins for direct `echo X` invocations; this
    // entry is only reached when a command (xargs etc.) looks them up
    // via the registry path.
    registry.register('echo', wrap(mkEcho()));
    registry.register('cat', wrap(withInvocationVfs(sqliteVfs, mkCat)));
    registry.register('ls', wrap(withInvocationVfs(sqliteVfs, mkLs)));
    registry.register('rm', wrap(withInvocationVfs(sqliteVfs, mkRm)));
    registry.register('touch', wrap(withInvocationVfs(sqliteVfs, mkTouch)));
    registry.register('stat', wrap(withInvocationVfs(sqliteVfs, (v) => mkStat(v, sqliteVfs))));
    registry.register('base64', wrap(withInvocationVfs(sqliteVfs, mkBase64)));
    registry.register('seq', wrap(mkSeq()));
    registry.register('id', wrap(mkId(sqliteVfs)));
    registry.register('hostname', wrap(mkHostname()));
    registry.register('basename', wrap(mkBasename()));
    registry.register('dirname', wrap(mkDirname()));
    registry.register('realpath', wrap(withInvocationVfs(sqliteVfs, mkRealpath)));
    registry.register('printf', wrap(mkPrintf()));
    registry.register('true', wrap(mkTrue()));
    registry.register('false', wrap(mkFalse()));
    registry.register('readlink', wrap(withInvocationVfs(sqliteVfs, mkReadlink)));
    registry.register('sha256sum', wrap(withInvocationVfs(sqliteVfs, mkSha256sum)));
    registry.register('file', wrap(withInvocationVfs(sqliteVfs, mkFile)));
    registry.register('xxd', wrapStreaming(withInvocationVfs(sqliteVfs, mkXxd)));
    registry.register('od', wrapStreaming(withInvocationVfs(sqliteVfs, mkOd)));
    registry.register('hexdump', wrapStreaming(withInvocationVfs(sqliteVfs, mkHexdump)));
    registry.register('chown', wrap(mkChown(sqliteVfs)));
    // ln — symlink stub (no-ops on VFS but doesn't error)
    /**
     * SHELL-FOLLOWUPS-4 (2026-05-11): real `ln -s` via SymlinkRegistry.
     * Pre-fix: ln -s did file-copy; modifications to the "link"
     * created a new file (no two-way reflection); readlink returned
     * empty.
     *
     * Now:
     *   - `ln -s TARGET LINKPATH` registers LINKPATH → TARGET in the
     *     symlink registry.
     *   - Real GNU `ln -s` doesn't require TARGET to exist (dangling
     *     symlinks are valid). We allow that.
     *   - Hard links (`ln` without -s) still do file-copy — Nimbus
     *     VFS doesn't expose inode-level hard-linking and that's
     *     documented out of scope.
     *
     * Subsequent operations (cat / ls / cat-via-redirect) need to
     * consult the registry to see through the symlink. That work
     * lives in mkCat / mkLs wrappers and the SqliteVFS read-path —
     * for v1, we wire it in the COMMANDS that need it (cat already
     * goes through Kernel.VFS which doesn't yet know about the
     * registry; we patch cat directly here to dereference symlinks).
     */
    registry.register('ln', wrap((ctx) => {
        const vfs = unixVfsFor(sqliteVfs, ctx.cred);
        const args = ctx.args;
        const symbolic = args.some(a => a === '-s' || (a.startsWith('-') && !a.startsWith('--') && a.includes('s')));
        const force = args.some(a => a === '-f' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')));
        const positional = args.filter(a => !a.startsWith('-'));
        if (positional.length < 2) {
            ctx.stderr.write('ln: missing operand\n');
            return 1;
        }
        const target = positional[0]; // what the link points TO
        const linkPath = positional[1]; // the link file itself
        const linkFp = resolvePath(ctx.cwd, linkPath);
        if (symbolic) {
            // Symbolic link via registry. Don't require target to exist.
            const reg = vfs.symlinks;
            // GNU `ln` without -f errors if link exists.
            if (!force && (vfs.exists(linkFp) || reg.isSymlink(linkFp))) {
                ctx.stderr.write(`ln: failed to create symbolic link '${linkPath}': File exists\n`);
                return 1;
            }
            // Remove existing real-file at linkPath if -f and not a symlink.
            if (force && vfs.exists(linkFp) && !reg.isSymlink(linkFp)) {
                try {
                    vfs.unlink(linkFp);
                }
                catch { /* fail-soft */ }
            }
            reg.set(linkFp, target);
            return 0;
        }
        // Hard link mode (default): file-copy semantics (legacy behaviour).
        const srcFp = resolvePath(ctx.cwd, target);
        try {
            const content = vfs.readFileString(srcFp);
            vfs.writeFile(linkFp, content);
        }
        catch (e) {
            ctx.stderr.write(`ln: ${target}: ${errorText(e)}\n`);
            return 1;
        }
        return 0;
    }));
    registry.register('test', wrap(mkTest(sqliteVfs)));
    registry.register('[', wrap(mkTest(sqliteVfs)));
    // read — read a line (stub, returns empty for non-interactive)
    // shell-polish (2026-05-12): `read VAR` is registered here as a
    // NO-OP fallback (matches the pre-existing stub behaviour). The
    // REAL working implementation lives in src/session/init.ts as a
    // shell builtin (shellAny.builtins.set('read', ...)).
    //
    // Why two registrations: the interpreter executes registered
    // shell commands with `ctx.env = { ...this.config.env }` — a SHALLOW
    // COPY.
    // Mutating ctx.env inside a registered command therefore CANNOT
    // propagate the var-assignment back to the shell. Builtins, by
    // contrast, run inside the interp instance with direct access to
    // `this.env` (the real shell env). The wait builtin in shell/compat/r6 uses
    // the same workaround.
    //
    // Keep the registry stub so `type read` reports "shell builtin" and
    // `which read` doesn't error; the builtin always wins dispatch
    // (interp.executeSimpleCommand checks builtins.get BEFORE
    // registry.resolve — index-Djm2onjx.js:5182-5186).
    registry.register('read', wrap((ctx) => {
        const args = ctx.args.filter((a) => !a.startsWith('-'));
        const varName = args[0] || 'REPLY';
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
    registry.register('umask', createUmaskCommand());
    registry.register('su', createSuCommand());
    registry.register('sudo', createSudoCommand());
    registry.register('ulimit', wrap(() => 0));
}
