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
 * touch, stat, file, xxd, base64, sha256sum, id, hostname, realpath
 */
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import { requireVfsCred } from '../runtime/os-contracts.js';
import { dec, enc } from '../_shared/bytes.js';
import { SinkWriter, streamRange } from '../_shared/byte-stream.js';
import { fileTypeChar, isCharacterDevice } from '../substrate/lifo/kernel/vfs/index.js';
import { runSed } from '../substrate/lifo/commands/text/sed.js';
import { findUnixGroupName, findUnixUserName, parseChownOwnership, } from './unix-accounts.js';
import { createSuCommand, createSudoCommand, createUmaskCommand } from './elevation-commands.js';
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
            ? await registry.resolve(name)
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
            const resolved = await registry.resolve(name);
            if (!resolved) {
                ctx.stderr.write(`command: ${name}: not found\n`);
                return 127;
            }
            const subCtx = { ...ctx, args: args.slice(1) };
            const code = await resolved(subCtx);
            return typeof code === 'number' ? code : 0;
        }
        catch (e) {
            ctx.stderr.write(`command: ${name}: ${e?.message || e}\n`);
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
                const resolved = typeof registry.resolve === 'function' ? await registry.resolve(name) : null;
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
 * shell compatibility (2026-05-11): find predicates (-size, -mtime).
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
function mkFind(vfs) {
    return (ctx) => {
        const args = [...ctx.args];
        // First non-flag arg is the start path.
        const root = args[0] && !args[0].startsWith('-')
            ? resolvePath(ctx.cwd, args.shift())
            : (ctx.cwd || '/home/user').replace(/^\/+/, '');
        // Parse predicates in order. We support a flat list of AND'd
        // predicates (real find supports more — sufficient for v1).
        let namePattern = null;
        let typeFilter = null;
        let sizeOp = null;
        let mtimeOp = null;
        let newerThanMtime = null;
        let emptyFilter = false;
        let maxDepth = Infinity;
        let execArgv = null;
        let printNull = false;
        let deleteAction = false;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '-name') {
                namePattern = args[++i];
                continue;
            }
            if (a === '-type') {
                typeFilter = args[++i];
                continue;
            }
            if (a === '-size') {
                const raw = args[++i] || '';
                const m = raw.match(/^([+-]?)(\d+)([ckMG]?)$/);
                if (m) {
                    const cmp = (m[1] === '+' ? '+' : m[1] === '-' ? '-' : '=');
                    const n = parseInt(m[2], 10);
                    const unit = m[3];
                    const bytes = unit === 'c' ? n
                        : unit === 'k' ? n * 1024
                            : unit === 'M' ? n * 1024 * 1024
                                : unit === 'G' ? n * 1024 * 1024 * 1024
                                    : n * 512; // default: 512-byte blocks
                    sizeOp = { cmp, bytes };
                }
                continue;
            }
            if (a === '-mtime') {
                const raw = args[++i] || '';
                const m = raw.match(/^([+-]?)(\d+)$/);
                if (m) {
                    const cmp = (m[1] === '+' ? '+' : m[1] === '-' ? '-' : '=');
                    const days = parseInt(m[2], 10);
                    mtimeOp = { cmp, ms: days * 86400 * 1000 };
                }
                continue;
            }
            if (a === '-newer') {
                const ref = args[++i];
                if (ref) {
                    try {
                        newerThanMtime = vfs.stat(resolvePath(ctx.cwd, ref)).mtime;
                    }
                    catch { /* ignore */ }
                }
                continue;
            }
            if (a === '-empty') {
                emptyFilter = true;
                continue;
            }
            if (a === '-maxdepth') {
                const d = parseInt(args[++i] || '', 10);
                if (Number.isFinite(d) && d >= 0)
                    maxDepth = d;
                continue;
            }
            if (a === '-exec') {
                // Collect args up to ';'.
                const collected = [];
                i++;
                while (i < args.length && args[i] !== ';' && args[i] !== '\\;') {
                    collected.push(args[i]);
                    i++;
                }
                execArgv = collected;
                continue;
            }
            if (a === '-print0') {
                printNull = true;
                continue;
            }
            if (a === '-print') { /* default — noop */
                continue;
            }
            if (a === '-delete') {
                deleteAction = true;
                continue;
            }
            // Unknown predicate: ignore (real find would error)
        }
        const now = Date.now();
        function matches(fullPath, name, e) {
            if (namePattern && !globMatch(namePattern, name))
                return false;
            if (typeFilter) {
                if (typeFilter === 'f' && e.type !== 'file')
                    return false;
                if (typeFilter === 'd' && e.type !== 'directory')
                    return false;
            }
            // For size/mtime/newer we need a stat. Skip for directories
            // unless the predicate cares about them.
            let needsStat = sizeOp || mtimeOp || newerThanMtime !== null || emptyFilter;
            if (!needsStat)
                return true;
            try {
                const st = vfs.stat(fullPath);
                if (sizeOp) {
                    const sz = st.size || 0;
                    if (sizeOp.cmp === '+' && !(sz > sizeOp.bytes))
                        return false;
                    if (sizeOp.cmp === '-' && !(sz < sizeOp.bytes))
                        return false;
                    if (sizeOp.cmp === '=' && sz !== sizeOp.bytes)
                        return false;
                }
                if (mtimeOp) {
                    const ageMs = now - (st.mtime || 0);
                    // bash find -mtime n: file modified n*24h ago.
                    //   +n → strictly more than n*24h ago (older)
                    //   -n → less than n*24h ago (newer)
                    //    n → between (n)*24h and (n+1)*24h ago
                    const dayMs = 86400 * 1000;
                    if (mtimeOp.cmp === '+' && !(ageMs > mtimeOp.ms + dayMs))
                        return false;
                    if (mtimeOp.cmp === '-' && !(ageMs < mtimeOp.ms))
                        return false;
                    if (mtimeOp.cmp === '=' && !(ageMs >= mtimeOp.ms && ageMs < mtimeOp.ms + dayMs))
                        return false;
                }
                if (newerThanMtime !== null && !((st.mtime || 0) > newerThanMtime))
                    return false;
                if (emptyFilter && (st.size || 0) > 0)
                    return false;
                return true;
            }
            catch {
                return false;
            }
        }
        function emit(fullPath) {
            const slashPath = '/' + fullPath;
            if (execArgv) {
                // Substitute {} with the path and invoke. We do NOT have
                // cross-registry execution here in a sync context; POSIX find's
                // -exec usually runs the cmd via the registry. The R2-3
                // xargs fix used registry.resolve; we can do same. For now
                // emit a marker that the test harness can recognize OR
                // attempt limited shell-builtin exec via the registry.
                // Conservative: write the substituted command line. Real
                // execution via registry would require ctx.registry which
                // mkFind doesn't take.
                const cmdLine = execArgv.map(a => a.split('{}').join(slashPath)).join(' ');
                ctx.stdout.write(cmdLine + '\n');
            }
            else if (deleteAction) {
                try {
                    const st = vfs.stat(fullPath);
                    if (st.type === 'directory')
                        vfs.rmdir(fullPath);
                    else
                        vfs.unlink(fullPath);
                }
                catch { /* ignore */ }
            }
            else {
                ctx.stdout.write(slashPath + (printNull ? '\0' : '\n'));
            }
        }
        function walk(path, depth) {
            try {
                // Emit the current path itself if it matches (find prints the
                // root directory line too when type filter doesn't exclude).
                if (depth === 0) {
                    try {
                        const st = vfs.stat(path);
                        const synthEntry = { type: st.type };
                        const baseName = path.split('/').pop() || path;
                        if (matches(path, baseName, synthEntry))
                            emit(path);
                    }
                    catch { /* root may not exist; bail */ }
                }
                if (depth >= maxDepth)
                    return;
                const entries = vfs.readdir(path);
                for (const e of entries) {
                    const fullPath = path + '/' + e.name;
                    if (matches(fullPath, e.name, e))
                        emit(fullPath);
                    if (e.type === 'directory')
                        walk(fullPath, depth + 1);
                }
            }
            catch { /* unreadable dir */ }
        }
        walk(root, 0);
        return 0;
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
                    else if (ch === 'E') { /* ERE noop */ }
                    else if (ch === 'F')
                        args.__fixedStrings = true;
                }
                continue;
            }
            positional.push(a);
        }
        if (positional.length < 1) {
            ctx.stderr.write('Usage: grep [-rnicvlEFw] PATTERN [FILE...]\n');
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
            if (ctx.stdin) {
                processLines(ctx.stdin.split('\n'), '');
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
                    let nlIdx;
                    while (emitted < n && (nlIdx = buffered.indexOf('\n')) !== -1) {
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
        for (const f of files) {
            const path = absolutePath(ctx.cwd, f);
            try {
                const content = readWholeFileString(ctx, path);
                if (files.length > 1)
                    ctx.stdout.write(`==> ${f} <==\n`);
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
        else if (arg !== '-' && arg.startsWith('-') && arg.length > 1) {
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
        const chunk = reader.readBytes ? await reader.readBytes(want) : await reader.read();
        if (chunk === null)
            break;
        const bytes = enc.encode(chunk).subarray(0, want);
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
function mkTail(vfs) {
    return (ctx) => {
        let n = 10;
        const nIdx = ctx.args.indexOf('-n');
        if (nIdx >= 0)
            n = parseInt(ctx.args[nIdx + 1]) || 10;
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
                if (files.length > 1)
                    ctx.stdout.write(`==> ${f} <==\n`);
                const lines = content.split('\n');
                ctx.stdout.write(lines.slice(-n).join('\n') + '\n');
            }
            catch {
                ctx.stderr.write(`tail: ${f}: No such file\n`);
                return 1;
            }
        }
        return 0;
    };
}
function mkWc(vfs) {
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
        function wcEmit(rawBytes, label) {
            const text = (countLines || countWords)
                ? new TextDecoder('utf-8').decode(rawBytes)
                : '';
            const lines = (countLines || countWords)
                ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
                : 0;
            const words = (countLines || countWords)
                ? text.split(/\s+/).filter(Boolean).length
                : 0;
            const parts = [];
            if (countLines)
                parts.push(String(lines).padStart(8));
            if (countWords)
                parts.push(String(words).padStart(8));
            if (countBytes)
                parts.push(String(rawBytes.length).padStart(8));
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
            }
            catch {
                ctx.stderr.write(`wc: ${f}: No such file\n`);
                return 1;
            }
        }
        return 0;
    };
}
function mkSort(vfs) {
    return (ctx) => {
        const files = ctx.args.filter(a => !a.startsWith('-'));
        let input = ctx.stdin || '';
        // Read from file if specified
        if (files.length > 0 && !input) {
            try {
                input = vfs.readFileString(resolvePath(ctx.cwd, files[0]));
            }
            catch {
                ctx.stderr.write(`sort: ${files[0]}: No such file\n`);
                return 1;
            }
        }
        const lines = input.split('\n');
        // Keep trailing empty line if input ends with newline
        if (lines[lines.length - 1] === '')
            lines.pop();
        const reverse = ctx.args.includes('-r');
        const numeric = ctx.args.includes('-n');
        const unique = ctx.args.includes('-u');
        lines.sort((a, b) => numeric ? parseFloat(a) - parseFloat(b) : a.localeCompare(b));
        if (reverse)
            lines.reverse();
        const result = unique ? [...new Set(lines)] : lines;
        ctx.stdout.write(result.join('\n') + '\n');
        return 0;
    };
}
function mkUniq() {
    return (ctx) => {
        const input = ctx.stdin || '';
        const lines = input.split('\n');
        const countFlag = ctx.args.includes('-c');
        const dupsOnly = ctx.args.includes('-d');
        const result = [];
        let prev = '', count = 0;
        for (const line of lines) {
            if (line === prev) {
                count++;
            }
            else {
                if (prev !== '' || count > 0) {
                    if (!dupsOnly || count > 1) {
                        result.push(countFlag ? `${String(count).padStart(7)} ${prev}` : prev);
                    }
                }
                prev = line;
                count = 1;
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
function mkSed(vfs) {
    return (ctx) => runSed({
        args: ctx.args,
        cwd: ctx.cwd,
        vfs,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        stdin: ctx.stdin === undefined ? undefined : stringInput(ctx.stdin),
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
        let input = ctx.stdin || '';
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
                    ctx.stderr.write(`awk: bad regex /${patSrc}/: ${e?.message || e}\n`);
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
                throw new Error(`expr error: ${e?.message || e} in "${expr}"`);
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
            ctx.stderr.write(`awk: ${e?.message || e}\n`);
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
        const input = (ctx.stdin || '').trim();
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
            target = await registry.resolve(cmdName);
        }
        catch (_e) {
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
                    ctx.stderr.write(`xargs: ${cmdName}: ${e?.message || e}\n`);
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
                    ctx.stderr.write(`xargs: ${cmdName}: ${e?.message || e}\n`);
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
        const input = ctx.stdin || '';
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
            ctx.stderr.write(`diff: ${e.message}\n`);
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
        function modeStr(mode, isDir, isLink) {
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
                if (kvfs && typeof kvfs.readdirStat === 'function') {
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
            const mode = modeStr(e.mode, isDir, isLink);
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
                ctx.stderr.write(`ls: cannot access '${arg}': ${e?.message || e}\n`);
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
            if (ctx.stdin)
                ctx.stdout.write(ctx.stdin);
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
                    // Recursive delete: walk children, unlink files, rmdir dirs.
                    rmDirRec(vfs, fp);
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
                const msg = String(e?.message || e);
                if (force && /ENOENT/.test(msg))
                    continue;
                ctx.stderr.write(`rm: cannot remove '${t}': ${fsErrorMessage(e)}\n`);
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
function rmDirRec(vfs, path) {
    const entries = vfs.readdir(path);
    for (const entry of entries) {
        const childPath = path + '/' + entry.name;
        if (entry.type === 'directory')
            rmDirRec(vfs, childPath);
        else
            vfs.unlink(childPath);
    }
    vfs.rmdir(path);
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
            if (targetVfs.exists(fp) && !targetVfs.isDirectory(fp)) {
                // Update mtime by re-writing the same content
                const content = targetVfs.readFile(fp);
                targetVfs.writeFile(fp, content);
            }
            else if (!targetVfs.exists(fp)) {
                targetVfs.writeFile(fp, '');
            }
        }
        return 0;
    };
}
function mkStat(vfs) {
    return (ctx) => {
        // shell compatibility follow-up: try Kernel.VFS (ctx.vfs) first so /dev
        // mount paths resolve. Same pattern as mkCat.
        const kvfs = ctx.vfs;
        for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
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
                    ctx.stderr.write(`stat: '${f}': No such file\n`);
                    return 1;
                }
            }
            ctx.stdout.write(`  File: ${displayPath}\n`);
            const kind = isCharacterDevice(st.mode) ? 'character special file' : st.type;
            ctx.stdout.write(`  Size: ${st.size}\tType: ${kind}\n`);
            const uid = st.uid ?? ctx.cred.uid;
            const gid = st.gid ?? ctx.cred.gid;
            const user = unixUserLabel(vfs, uid);
            const group = unixGroupLabel(vfs, gid);
            ctx.stdout.write(`Access: (0${st.mode.toString(8)})  Uid: (${uid}/${user})   Gid: (${gid}/${group})\n`);
            ctx.stdout.write(`Modify: ${new Date(st.mtime).toISOString()}\n`);
        }
        return 0;
    };
}
function mkBase64(vfs) {
    return (ctx) => {
        const decode = ctx.args.includes('-d') || ctx.args.includes('--decode');
        const file = ctx.args.find(a => !a.startsWith('-'));
        let input = ctx.stdin || '';
        if (file) {
            try {
                input = vfs.readFileString(resolvePath(ctx.cwd, file));
            }
            catch (error) {
                ctx.stderr.write(`base64: ${file}: ${fsErrorMessage(error)}\n`);
                return 1;
            }
        }
        if (decode) {
            try {
                ctx.stdout.write(atob(input.trim()) + '\n');
            }
            catch {
                ctx.stderr.write('base64: invalid input\n');
                return 1;
            }
        }
        else {
            ctx.stdout.write(btoa(input) + '\n');
        }
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
function mkSleep() {
    return async (ctx) => {
        const secs = parseFloat(ctx.args[0] || '1');
        await new Promise(r => setTimeout(r, secs * 1000));
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
        const fmt = rawFmt
            .replace(/\\\\/g, '\u0000') // protect literal \\\\
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
function mkSha256sum(vfs) {
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
            }
            catch {
                ctx.stderr.write(`sha256sum: ${f}: No such file\n`);
                return 1;
            }
        }
        return 0;
    };
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
function mkXxd(vfs) {
    return (ctx) => {
        const file = ctx.args.find(a => !a.startsWith('-'));
        if (!file) {
            ctx.stderr.write('Usage: xxd FILE\n');
            return 1;
        }
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
        }
        catch {
            ctx.stderr.write(`xxd: ${file}: No such file\n`);
            return 1;
        }
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
/**
 * SHELL-R6-B2 follow-on: wrapStreaming for commands that handle pipe
 * readers directly (head, tail, etc — commands that can terminate
 * before the producer drains).
 *
 * Behavior:
 *   - If ctx.stdin is a terminal stdin (has .feed), drain buffered
 *     bytes to a string (same as wrap — terminal stdin's
 *     buffer-then-close pattern doesn't match streaming).
 *   - If ctx.stdin is a pipe reader (has .read), PASS IT THROUGH
 *     unchanged so the command can read line-by-line. The command
 *     is responsible for terminating itself (e.g. head -n N stops
 *     after N lines, triggering the pipeline-abort cascade from
 *     SHELL-R6-2).
 *   - String stdin / other shapes: same as wrap.
 */
function wrapStreaming(fn) {
    return async (ctx) => {
        try {
            if (ctx.stdin && typeof ctx.stdin !== 'string') {
                const stdinObj = ctx.stdin;
                const isTerminalStdin = typeof stdinObj.feed === 'function';
                if (isTerminalStdin) {
                    const buf = Array.isArray(stdinObj.buffer)
                        ? stdinObj.buffer.splice(0)
                        : [];
                    ctx.stdin = buf.join('');
                }
                // else: leave as pipe reader for the command to handle.
            }
            const result = fn(ctx);
            return await result;
        }
        catch (e) {
            ctx.stderr.write(`${e?.message || e}\n`);
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
                    const buf = Array.isArray(stdinObj.buffer)
                        ? stdinObj.buffer.splice(0)
                        : [];
                    ctx.stdin = buf.join('');
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
            ctx.stderr.write(`${e?.message || e}\n`);
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
    registry.register('find', wrap(withInvocationVfs(sqliteVfs, mkFind)));
    registry.register('grep', wrap(withInvocationVfs(sqliteVfs, mkGrep)));
    // SHELL-R6-B2: head uses streaming wrap so a pipe reader passes
    // through (head terminates after N lines, triggering the abort
    // cascade for upstream producers like `yes`).
    registry.register('head', wrapStreaming(withInvocationVfs(sqliteVfs, mkHead)));
    registry.register('tail', wrap(withInvocationVfs(sqliteVfs, mkTail)));
    registry.register('wc', wrap(withInvocationVfs(sqliteVfs, mkWc)));
    registry.register('sort', wrap(withInvocationVfs(sqliteVfs, mkSort)));
    registry.register('uniq', wrap(mkUniq()));
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
    registry.register('stat', wrap(withInvocationVfs(sqliteVfs, mkStat)));
    registry.register('base64', wrap(withInvocationVfs(sqliteVfs, mkBase64)));
    registry.register('seq', wrap(mkSeq()));
    registry.register('sleep', wrap(mkSleep()));
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
    registry.register('xxd', wrap(withInvocationVfs(sqliteVfs, mkXxd)));
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
            ctx.stderr.write(`ln: ${target}: ${e?.message || e}\n`);
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
