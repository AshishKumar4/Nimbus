/**
 * gnulib's modechange: a chmod(1) mode, octal or symbolic, compiled once and
 * then applied to any file's mode. chmod applies it to the file's own mode;
 * find's -perm applies it to 0 to get the bits it compares against.
 *
 * The grammar is gnulib's: an octal number, or comma-separated clauses of
 * `[ugoa]*([-+=]([rwxXst]*|[ugo]))+` and `[-+=][0-7]+`.
 */
const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;
const S_IRWXU = 0o700;
const S_IRWXG = 0o070;
const S_IRWXO = 0o007;
const S_IRWXUGO = 0o777;
const READ_BITS = 0o444;
const WRITE_BITS = 0o222;
const EXEC_BITS = 0o111;
/** Every bit chmod can change, and the largest octal mode gnulib accepts. */
const CHMOD_MODE_BITS = 0o7777;
function isOctalDigit(ch) {
    return ch !== undefined && ch >= '0' && ch <= '7';
}
function isOperator(ch) {
    return ch === '=' || ch === '+' || ch === '-';
}
/** The changes `spec` describes, or null where gnulib's mode_compile refuses it. */
export function compileMode(spec) {
    if (isOctalDigit(spec[0])) {
        let mode = 0;
        let i = 0;
        for (; isOctalDigit(spec[i]); i++) {
            mode = mode * 8 + Number(spec[i]);
            if (mode > CHMOD_MODE_BITS)
                return null;
        }
        if (i < spec.length)
            return null;
        // Up to four digits leave a directory's set-id bits alone unless they set them.
        const mentioned = i < 5 ? (mode & (S_ISUID | S_ISGID)) | S_ISVTX | S_IRWXUGO : CHMOD_MODE_BITS;
        return [{ op: '=', flag: 'ordinary', affected: CHMOD_MODE_BITS, value: mode, mentioned }];
    }
    const changes = [];
    let p = 0;
    for (;;) {
        let affected = 0;
        for (; !isOperator(spec[p]); p++) {
            switch (spec[p]) {
                case 'u':
                    affected |= S_ISUID | S_IRWXU;
                    break;
                case 'g':
                    affected |= S_ISGID | S_IRWXG;
                    break;
                case 'o':
                    affected |= S_ISVTX | S_IRWXO;
                    break;
                case 'a':
                    affected |= CHMOD_MODE_BITS;
                    break;
                default: return null;
            }
        }
        do {
            const op = spec[p++];
            if (!isOperator(op))
                return null;
            let value = 0;
            let mentioned = 0;
            let flag = 'copy-existing';
            const ch = spec[p];
            if (isOctalDigit(ch)) {
                for (; isOctalDigit(spec[p]); p++) {
                    value = value * 8 + Number(spec[p]);
                    if (value > CHMOD_MODE_BITS)
                        return null;
                }
                if (affected !== 0 || (p < spec.length && spec[p] !== ','))
                    return null;
                affected = mentioned = CHMOD_MODE_BITS;
                flag = 'ordinary';
            }
            else if (ch === 'u' || ch === 'g' || ch === 'o') {
                value = ch === 'u' ? S_IRWXU : ch === 'g' ? S_IRWXG : S_IRWXO;
                p++;
            }
            else {
                flag = 'ordinary';
                for (let more = true; more;) {
                    switch (spec[p]) {
                        case 'r':
                            value |= READ_BITS;
                            p++;
                            break;
                        case 'w':
                            value |= WRITE_BITS;
                            p++;
                            break;
                        case 'x':
                            value |= EXEC_BITS;
                            p++;
                            break;
                        case 'X':
                            flag = 'x-if-any-x';
                            p++;
                            break;
                        case 's':
                            value |= S_ISUID | S_ISGID;
                            p++;
                            break;
                        case 't':
                            value |= S_ISVTX;
                            p++;
                            break;
                        default: more = false;
                    }
                }
            }
            changes.push({
                op,
                flag,
                affected,
                value,
                mentioned: mentioned !== 0 ? mentioned : affected !== 0 ? affected & value : value,
            });
        } while (isOperator(spec[p]));
        if (spec[p] !== ',')
            break;
        p++;
    }
    return p === spec.length ? changes : null;
}
/** gnulib's mode_adjust: `oldMode`'s permission bits after `changes`. */
export function adjustMode(oldMode, isDir, umask, changes) {
    let mode = oldMode & CHMOD_MODE_BITS;
    for (const change of changes) {
        const omit = (isDir ? S_ISUID | S_ISGID : 0) & ~change.mentioned;
        let value = change.value;
        if (change.flag === 'copy-existing') {
            value &= mode;
            value |= (value & READ_BITS ? READ_BITS : 0)
                | (value & WRITE_BITS ? WRITE_BITS : 0)
                | (value & EXEC_BITS ? EXEC_BITS : 0);
        }
        else if (change.flag === 'x-if-any-x' && ((mode & EXEC_BITS) !== 0 || isDir)) {
            value |= EXEC_BITS;
        }
        value &= (change.affected !== 0 ? change.affected : ~umask) & ~omit;
        if (change.op === '=') {
            const preserved = (change.affected !== 0 ? ~change.affected : 0) | omit;
            mode = (mode & preserved) | value;
        }
        else if (change.op === '+') {
            mode |= value;
        }
        else {
            mode &= ~value;
        }
    }
    return mode & CHMOD_MODE_BITS;
}
