/**
 * git-remote-http and git-remote-https: the remote helper real git
 * (git.wasm) starts for an http(s) remote, speaking gitremote-helpers(7) on
 * its stdin and stdout a line at a time.
 *
 * The network and the pack are the GitPackStream engine's (git/engine.ts):
 * `list` is the remote's refs; `fetch` has the engine write the pack the
 * wanted objects need, with its .idx and .rev, and .git/shallow for a
 * shallow fetch, into the repository; `push` has it send the ref updates
 * and a pack of what the remote lacks. The helper writes no ref and moves no
 * object itself: git updates the refs after (remote-tracking refs, tags,
 * FETCH_HEAD), and decides before what may be pushed (a non-fast-forward,
 * --force-with-lease against what `list for-push` said). What git leaves to
 * a push helper, the helper refuses as send-pack does for git-remote-curl: a
 * ref whose remote value this repository lacks ("fetch first").
 *
 * Capabilities: fetch, push, option, check-connectivity, object-format.
 * Not stateless-connect or connect: with those git would run the protocol
 * itself, and git.wasm cannot demultiplex a sideband (start_async forks).
 */
const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A C-style quoted value (quote_c_style) as the string it quotes; any other as it is. */
export function unquoteC(value) {
    if (!value.startsWith('"'))
        return value;
    const bytes = [];
    const enc = new TextEncoder();
    for (let i = 1; i < value.length; i++) {
        const c = value[i];
        if (c === '"')
            return i === value.length - 1 ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
        if (c !== '\\') {
            bytes.push(...enc.encode(c));
            continue;
        }
        const next = value[++i];
        const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
        if (next !== undefined && next in simple) {
            bytes.push(simple[next]);
            continue;
        }
        const octal = value.slice(i, i + 3);
        if (!/^[0-3][0-7]{2}$/.test(octal))
            return null;
        bytes.push(parseInt(octal, 8));
        i += 2;
    }
    return null;
}
/**
 * Set option `name` to `value`: 'ok', 'unsupported', or 'error <why>', the
 * answer git reads.
 */
function setOption(options, name, raw) {
    const value = unquoteC(raw);
    if (value === null)
        return 'error invalid quoting';
    const bool = (set) => {
        if (value === 'true')
            set(true);
        else if (value === 'false')
            set(false);
        else
            return 'error invalid value';
        return 'ok';
    };
    switch (name) {
        case 'verbosity': {
            const n = Number(value);
            if (!Number.isInteger(n))
                return 'error invalid value';
            options.verbosity = n;
            return 'ok';
        }
        case 'progress': return bool((on) => { options.progress = on; });
        case 'depth': {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0)
                return 'error invalid value';
            options.depth = n;
            return 'ok';
        }
        case 'deepen-since': {
            const n = Number(value);
            if (!Number.isFinite(n))
                return 'error invalid value';
            options.deepenSince = n;
            return 'ok';
        }
        case 'deepen-not':
            options.deepenNot.push(value);
            return 'ok';
        case 'deepen-relative': return bool((on) => { options.deepenRelative = on; });
        case 'followtags': return bool((on) => { options.followTags = on; });
        case 'dry-run': return bool((on) => { options.dryRun = on; });
        case 'force': return bool((on) => { options.force = on; });
        case 'check-connectivity': return bool((on) => { options.checkConnectivity = on; });
        case 'cas': {
            const at = value.indexOf(':');
            if (at <= 0)
                return 'error invalid value';
            options.cas.set(value.slice(0, at), value.slice(at + 1));
            return 'ok';
        }
        case 'cloning': return bool(() => { });
        case 'update-shallow': return bool((on) => { options.updateShallow = on; });
        case 'atomic': return bool((on) => { options.atomic = on; });
        case 'push-option':
            options.pushOptions.push(value);
            return 'ok';
        case 'filter':
            options.filter = value;
            return 'ok';
        case 'object-format': return bool((on) => { options.objectFormat = on; });
        // A signed push needs gpg on this side; only "no" is honoured.
        case 'pushcert': return value === 'false' ? 'ok' : 'unsupported';
        default: return 'unsupported';
    }
}
/**
 * The value of local ref `name` (full, as git names a push source), through
 * a symbolic ref, a loose file or packed-refs; null when there is none.
 */
async function localRef(io, gitDir, name) {
    const dec = new TextDecoder();
    for (let hops = 0; hops < 5; hops++) {
        const loose = await io.readFile(`${gitDir}/${name}`);
        if (loose !== null) {
            const text = dec.decode(loose).trim();
            if (text.startsWith('ref: ')) {
                name = text.slice(5);
                continue;
            }
            return HEX_OID.test(text) ? text : null;
        }
        const packed = await io.readFile(`${gitDir}/packed-refs`);
        if (packed === null)
            return null;
        for (const line of dec.decode(packed).split('\n')) {
            const space = line.indexOf(' ');
            if (space > 0 && line.slice(space + 1) === name && HEX_OID.test(line.slice(0, space)))
                return line.slice(0, space);
        }
        return null;
    }
    return null;
}
/** The directory git named in GIT_DIR, absolute (git gives it relative to the cwd it started the helper in). */
function gitDirOf(io) {
    const dir = io.env.GIT_DIR;
    if (!dir)
        return null;
    if (dir.startsWith('/'))
        return dir.replace(/\/+$/, '');
    const parts = `${io.cwd}/${dir}`.split('/');
    const out = [];
    for (const part of parts) {
        if (part === '' || part === '.')
            continue;
        if (part === '..')
            out.pop();
        else
            out.push(part);
    }
    return `/${out.join('/')}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** One `push` line: its force mark, source (empty for a deletion) and destination; null when malformed. */
function parsePush(spec) {
    const force = spec.startsWith('+');
    const body = force ? spec.slice(1) : spec;
    const colon = body.lastIndexOf(':');
    if (colon < 0)
        return null;
    const dst = body.slice(colon + 1);
    if (!dst)
        return null;
    return { force, src: body.slice(0, colon), dst };
}
/**
 * Run the helper to the end of git's commands: 0 at the blank line that
 * ends them, 128 on an error git cannot continue past (git reports the
 * helper's exit).
 */
export async function runRemoteHelper(io, engine, local) {
    const url = io.args[1];
    if (io.args.length < 2 || !url) {
        await io.stderr('usage: git-remote-https <remote> <url>\n');
        return 129;
    }
    const auth = {
        username: io.env.GIT_USERNAME || '',
        password: io.env.GIT_PASSWORD || io.env.GIT_TOKEN || '',
    };
    const options = {
        verbosity: 1, progress: false, deepenNot: [], deepenRelative: false, followTags: false, dryRun: false, force: false,
        checkConnectivity: false, cas: new Map(), updateShallow: false, atomic: false, pushOptions: [], objectFormat: false,
    };
    /** What the last `list for-push` said each ref is: the value a push expects to replace. */
    let pushRefs = null;
    /** The id that names no object, in the remote's hash. */
    let zero = '0'.repeat(40);
    const fail = async (what, error) => {
        await io.stderr(`fatal: ${what}: ${errorMessage(error)}\n`);
        return 128;
    };
    for (;;) {
        const line = await io.readLine();
        // git ends the conversation with a blank line, or by closing our stdin.
        if (line === null || line === '')
            return 0;
        if (line === 'capabilities') {
            await io.stdout('fetch\npush\noption\ncheck-connectivity\nobject-format\n\n');
            continue;
        }
        if (line.startsWith('option ')) {
            const rest = line.slice('option '.length);
            const space = rest.indexOf(' ');
            const name = space < 0 ? rest : rest.slice(0, space);
            await io.stdout(`${setOption(options, name, space < 0 ? 'true' : rest.slice(space + 1))}\n`);
            continue;
        }
        if (line === 'list' || line.startsWith('list ')) {
            const forPush = line.slice(4).split(' ').includes('for-push');
            let listed;
            try {
                listed = await engine.listRefs({ url, auth, forPush });
            }
            catch (error) {
                return fail(`could not read the refs of ${url}`, error);
            }
            let out = options.objectFormat ? `:object-format ${listed.objectFormat}\n` : '';
            for (const ref of listed.refs) {
                if (ref.symref)
                    out += `@${ref.symref} ${ref.name}\n`;
                else if (ref.oid)
                    out += `${ref.oid} ${ref.name}\n`;
                else
                    out += `? ${ref.name}\n`;
            }
            await io.stdout(`${out}\n`);
            zero = '0'.repeat(listed.objectFormat === 'sha256' ? 64 : 40);
            if (forPush)
                pushRefs = new Map(listed.refs.filter((r) => r.oid).map((r) => [r.name, r.oid]));
            continue;
        }
        if (line.startsWith('fetch ')) {
            // A batch: fetch lines up to a blank line, answered once.
            const wants = new Set();
            for (let next = line; next !== null && next !== ''; next = await io.readLine()) {
                const [verb, oid] = next.split(' ');
                if (verb !== 'fetch' || !oid || !HEX_OID.test(oid))
                    return fail('protocol error', new Error(`unexpected '${next}' in a fetch batch`));
                wants.add(oid);
            }
            const gitDir = gitDirOf(io);
            if (gitDir === null)
                return fail('fetch', new Error('no repository (GIT_DIR is not set)'));
            let fetched;
            try {
                fetched = await engine.fetchPack({
                    url, auth, gitDir, wants: [...wants],
                    ...(options.depth !== undefined ? { depth: options.depth } : {}),
                    ...(options.deepenSince !== undefined ? { deepenSince: options.deepenSince } : {}),
                    ...(options.deepenNot.length > 0 ? { deepenNot: options.deepenNot } : {}),
                    ...(options.deepenRelative ? { deepenRelative: true } : {}),
                    ...(options.filter !== undefined ? { filter: options.filter } : {}),
                    includeTag: options.followTags,
                    updateShallow: options.updateShallow,
                });
            }
            catch (error) {
                return fail(`could not fetch from ${url}`, error);
            }
            if (options.verbosity > 0 && options.progress && fetched.packName) {
                await io.stderr(`Received ${fetched.objects} objects, ${fetched.bytes} bytes.\n`);
            }
            await io.stdout(options.checkConnectivity && fetched.selfContained ? 'connectivity-ok\n\n' : '\n');
            continue;
        }
        if (line.startsWith('push ')) {
            // A batch: push lines up to a blank line, answered with a status per ref.
            const specs = [];
            for (let next = line; next !== null && next !== ''; next = await io.readLine()) {
                if (!next.startsWith('push '))
                    return fail('protocol error', new Error(`unexpected '${next}' in a push batch`));
                const spec = parsePush(next.slice('push '.length));
                if (!spec)
                    return fail('protocol error', new Error(`malformed '${next}'`));
                specs.push(spec);
            }
            const gitDir = gitDirOf(io);
            if (gitDir === null)
                return fail('push', new Error('no repository (GIT_DIR is not set)'));
            const commands = [];
            const statuses = new Map();
            const planned = [];
            for (const spec of specs) {
                let next = zero;
                if (spec.src !== '') {
                    const resolved = HEX_OID.test(spec.src) ? spec.src : await localRef(io, gitDir, spec.src);
                    if (resolved === null) {
                        statuses.set(spec.dst, `error ${spec.dst} src refspec ${spec.src} does not match any`);
                        continue;
                    }
                    next = resolved;
                }
                const expected = options.cas.get(spec.dst);
                const old = expected !== undefined ? (expected === '' ? zero : expected) : (pushRefs?.get(spec.dst) ?? zero);
                planned.push({ ref: spec.dst, old, new: next, force: spec.force || options.force });
            }
            // send-pack's check, which git leaves to a push helper: a ref whose
            // remote value is not here cannot be known to be fast-forwarded.
            const unforced = planned.filter((c) => !c.force && c.old !== zero && c.new !== zero);
            let present;
            try {
                present = unforced.length > 0 ? await local.has(gitDir, unforced.map((c) => c.old)) : new Set();
            }
            catch (error) {
                return fail('push', error);
            }
            for (const { force, ...command } of planned) {
                if (!force && command.old !== zero && command.new !== zero && !present.has(command.old))
                    statuses.set(command.ref, `error ${command.ref} fetch first`);
                else
                    commands.push(command);
            }
            if (commands.length > 0 && !options.dryRun) {
                const include = commands.filter((c) => c.new !== zero).map((c) => c.new);
                const exclude = [...new Set(pushRefs?.values() ?? [])];
                let pushed;
                try {
                    pushed = await engine.pushPack({
                        url, auth, commands,
                        pack: include.length > 0 ? local.packObjects({ gitDir, include, exclude }) : null,
                        atomic: options.atomic,
                        pushOptions: options.pushOptions,
                    });
                }
                catch (error) {
                    return fail(`could not push to ${url}`, error);
                }
                for (const ref of pushed.refs) {
                    statuses.set(ref.ref, ref.ok ? `ok ${ref.ref}` : `error ${ref.ref}${ref.reason ? ` ${ref.reason}` : ''}`);
                }
            }
            else {
                for (const command of commands)
                    statuses.set(command.ref, `ok ${command.ref}`);
            }
            // Every ref git asked about gets an answer, in the order it asked.
            let out = '';
            for (const spec of specs)
                out += `${statuses.get(spec.dst) ?? `error ${spec.dst} not reported by the remote`}\n`;
            await io.stdout(`${out}\n`);
            continue;
        }
        return fail('protocol error', new Error(`unknown command '${line}' from git`));
    }
}
