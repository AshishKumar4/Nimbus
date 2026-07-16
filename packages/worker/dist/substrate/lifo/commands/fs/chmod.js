import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
/** Parse an octal (755, 0644) or symbolic (+x, u+x, go-w, a=rx) mode spec. */
export function parseModeSpec(spec) {
    if (/^[0-7]{1,4}$/.test(spec)) {
        return { kind: 'absolute', mode: parseInt(spec, 8) };
    }
    const clauses = [];
    for (const clause of spec.split(',')) {
        const match = clause.match(/^([ugoa]*)([+\-=])([rwx]*)$/);
        if (!match)
            return null;
        clauses.push({ who: match[1], op: match[2], perms: match[3] });
    }
    return clauses.length > 0 ? { kind: 'symbolic', clauses } : null;
}
const PERM_BITS = { r: 4, w: 2, x: 1 };
const WHO_SHIFTS = { u: 6, g: 3, o: 0 };
/** Apply a parsed mode spec to the current permission bits. */
export function applyModeSpec(spec, currentMode) {
    if (spec.kind === 'absolute')
        return spec.mode & 0o7777;
    let mode = currentMode & 0o7777;
    for (const { who, op, perms } of spec.clauses) {
        const targets = who === '' || who.includes('a') ? 'ugo' : who;
        let bits = 0;
        for (const p of perms)
            bits |= PERM_BITS[p] ?? 0;
        let mask = 0;
        let selected = 0;
        for (const w of targets) {
            mask |= 7 << WHO_SHIFTS[w];
            selected |= bits << WHO_SHIFTS[w];
        }
        if (op === '+')
            mode |= selected;
        else if (op === '-')
            mode &= ~selected;
        else
            mode = (mode & ~mask) | selected;
    }
    return mode;
}
const command = async (ctx) => {
    let recursive = false;
    let modeStr = '';
    const files = [];
    for (const arg of ctx.args) {
        if (!modeStr && (arg === '-R' || arg === '-r' || arg === '--recursive')) {
            recursive = true;
        }
        else if (!modeStr) {
            modeStr = arg;
        }
        else {
            files.push(arg);
        }
    }
    if (!modeStr || files.length === 0) {
        ctx.stderr.write('chmod: missing operand\n');
        return 1;
    }
    const spec = parseModeSpec(modeStr);
    if (!spec) {
        ctx.stderr.write(`chmod: invalid mode: '${modeStr}'\n`);
        return 1;
    }
    let exitCode = 0;
    function applyChmod(filePath) {
        const st = ctx.vfs.stat(filePath);
        ctx.vfs.chmod(filePath, applyModeSpec(spec, st.mode));
        if (recursive && st.type === 'directory') {
            for (const entry of ctx.vfs.readdir(filePath)) {
                applyChmod(filePath === '/' ? '/' + entry.name : filePath + '/' + entry.name);
            }
        }
    }
    for (const file of files) {
        try {
            applyChmod(resolve(ctx.cwd, file));
        }
        catch (e) {
            const message = e instanceof VFSError || e instanceof Error ? e.message : String(e);
            ctx.stderr.write(`chmod: cannot access '${file}': ${message}\n`);
            exitCode = 1;
        }
    }
    return exitCode;
};
export default command;
