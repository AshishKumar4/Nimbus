// git's diff formats (diff.c, xdiff/xemit.c, quote.c) over jsdiff's Myers diff: hunks may sit where xdiff's would not; the framing is git's.
// Text is carried as binary strings, one char per byte, so content and path bytes reach the output unchanged.
import { diffArrays } from 'diff';
const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_CONTEXT = 3;
const EMPTY = new Uint8Array(0);
export function absentSpec(path) {
    return { path, valid: false, oid: ZERO_OID, mode: 0, data: EMPTY };
}
const S_IFMT = 0o170000;
/** diff_resolve_rename_copy's status letter. */
export function pairStatus(pair) {
    if (!pair.one.valid)
        return 'A';
    if (!pair.two.valid)
        return 'D';
    // A regular file and a symlink are different kinds of object: a type change.
    if ((pair.one.mode & S_IFMT) !== (pair.two.mode & S_IFMT))
        return 'T';
    return pair.renameScore === undefined ? 'M' : 'R';
}
// ── Binary strings ──────────────────────────────────────────────────────
const utf8 = new TextEncoder();
export function binaryFromBytes(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return out;
}
export function bytesFromBinary(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
        out[i] = text.charCodeAt(i);
    return out;
}
/** A path's UTF-8 bytes as a binary string. */
export function binaryPath(path) {
    return binaryFromBytes(utf8.encode(path));
}
// ── Path quoting (quote.c) ──────────────────────────────────────────────
const C_ESCAPES = {
    0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x22: '"', 0x5c: '\\',
};
/** quote_c_style's body, or null when no byte needs quoting. */
function cQuoted(bin) {
    let quoted = null;
    for (let i = 0; i < bin.length; i++) {
        const c = bin.charCodeAt(i);
        if (c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c) {
            if (quoted !== null)
                quoted += bin[i];
            continue;
        }
        if (quoted === null)
            quoted = bin.slice(0, i);
        const letter = C_ESCAPES[c];
        quoted += letter ? `\\${letter}` : `\\${c.toString(8).padStart(3, '0')}`;
    }
    return quoted;
}
/** A path as git prints it on a '\n'-ended line: C-quoted if any byte needs it. */
export function quotePath(path) {
    const bin = binaryPath(path);
    const body = cQuoted(bin);
    return body === null ? bin : `"${body}"`;
}
/** One entry of a path list: quoted and '\n'-ended, or raw and NUL-ended under -z. */
export function pathLine(path, z) {
    return z ? binaryPath(path) + '\0' : quotePath(path) + '\n';
}
function quoteTwo(prefix, path) {
    const bin = binaryPath(path);
    const body = cQuoted(bin);
    return body === null ? prefix + bin : `"${prefix}${body}"`;
}
// ── Line diff ───────────────────────────────────────────────────────────
function splitLines(bin) {
    const lines = [];
    let start = 0;
    while (start < bin.length) {
        const nl = bin.indexOf('\n', start);
        const end = nl < 0 ? bin.length : nl + 1;
        lines.push(bin.slice(start, end));
        start = end;
    }
    return lines;
}
// jsdiff's cost is quadratic in edits (~0.5 s at 2000); past that a pair is one replacement hunk.
const MAX_EDIT_LENGTH = 2000;
function lineChanges(a, b) {
    const shorter = Math.min(a.length, b.length);
    let head = 0;
    while (head < shorter && a[head] === b[head])
        head++;
    let tail = 0;
    while (tail < shorter - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
        tail++;
    const oldLines = a.slice(head, a.length - tail);
    const newLines = b.slice(head, b.length - tail);
    if (oldLines.length === 0 && newLines.length === 0)
        return [];
    const whole = [{ i1: head, n1: oldLines.length, i2: head, n2: newLines.length }];
    if (oldLines.length === 0 || newLines.length === 0)
        return whole;
    const parts = diffArrays(oldLines, newLines, { maxEditLength: MAX_EDIT_LENGTH });
    if (!parts)
        return whole;
    const changes = [];
    let i = head;
    let j = head;
    let open = null;
    for (const part of parts) {
        const count = part.count ?? part.value.length;
        if (!part.added && !part.removed) {
            open = null;
            i += count;
            j += count;
            continue;
        }
        if (!open)
            changes.push(open = { i1: i, n1: 0, i2: j, n2: 0 });
        if (part.removed) {
            open.n1 += count;
            i += count;
        }
        else {
            open.n2 += count;
            j += count;
        }
    }
    return changes;
}
function diffText(one, two) {
    const a = splitLines(binaryFromBytes(one));
    const b = splitLines(binaryFromBytes(two));
    return { a, b, changes: lineChanges(a, b) };
}
// ── Hunks (xdiff/xemit.c) ───────────────────────────────────────────────
/** def_ff: a line opening with a letter, '_' or '$', cut to 80 bytes, trailing space trimmed. */
function funcName(line) {
    const c = line.charCodeAt(0);
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x24))
        return null;
    let len = Math.min(line.length, 80);
    // git's isspace (sane_ctype) is only \t \n \r and space.
    while (len > 0 && /[\t\n\r ]/.test(line[len - 1]))
        len--;
    return line.slice(0, len);
}
/** xdl_format_hunk_hdr: counts of 1 are omitted, an empty side names the line before it. */
function hunkHeader(s1, c1, s2, c2, func) {
    let header = `@@ -${c1 ? s1 : s1 - 1}${c1 === 1 ? '' : `,${c1}`} +${c2 ? s2 : s2 - 1}${c2 === 1 ? '' : `,${c2}`} @@`;
    if (func) {
        header += ' ';
        // The header is built in a 128-byte buffer that ends in '\n'.
        header += func.slice(0, 128 - header.length - 1);
    }
    return header + '\n';
}
function record(prefix, line) {
    return line.endsWith('\n') ? prefix + line : `${prefix}${line}\n\\ No newline at end of file\n`;
}
function formatHunks({ a, b, changes }, context) {
    let out = '';
    let func = '';
    let funcSearchedTo = -1;
    for (let first = 0; first < changes.length;) {
        let last = first;
        while (last + 1 < changes.length
            && changes[last + 1].i1 - (changes[last].i1 + changes[last].n1) <= 2 * context)
            last++;
        const start = changes[first];
        const end = changes[last];
        const s1 = Math.max(start.i1 - context, 0);
        const s2 = Math.max(start.i2 - context, 0);
        const trailing = Math.min(context, a.length - (end.i1 + end.n1), b.length - (end.i2 + end.n2));
        const e1 = end.i1 + end.n1 + trailing;
        const e2 = end.i2 + end.n2 + trailing;
        // get_func_line: nearest earlier old line that names a function; it carries across hunks.
        for (let l = s1 - 1; l > funcSearchedTo; l--) {
            const name = funcName(a[l]);
            if (name !== null) {
                func = name;
                break;
            }
        }
        funcSearchedTo = s1 - 1;
        out += hunkHeader(s1 + 1, e1 - s1, s2 + 1, e2 - s2, func);
        for (let j = s2; j < start.i2; j++)
            out += record(' ', b[j]);
        let j = start.i2;
        for (let k = first; k <= last; k++) {
            const change = changes[k];
            for (; j < change.i2; j++)
                out += record(' ', b[j]);
            for (let i = change.i1; i < change.i1 + change.n1; i++)
                out += record('-', a[i]);
            for (j = change.i2; j < change.i2 + change.n2; j++)
                out += record('+', b[j]);
        }
        for (; j < e2; j++)
            out += record(' ', b[j]);
        first = last + 1;
    }
    return out;
}
// ── Patch (diff.c builtin_diff) ─────────────────────────────────────────
/** buffer_is_binary: a NUL in the first 8000 bytes. */
export function isBinary(data) {
    return data.subarray(0, 8000).includes(0);
}
function sameBytes(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function octal6(mode) {
    return mode.toString(8).padStart(6, '0');
}
// A label holding a space gets a trailing tab, so patch(1) can find where the name ends.
function labelLine(marker, label) {
    return `${marker} ${label}${label.includes(' ') ? '\t' : ''}\n`;
}
/** One file's `diff --git` section, exactly as `git diff` prints it without color. */
export function formatPatch(pair, context = DEFAULT_CONTEXT) {
    const { one, two } = pair;
    // run_diff: a change of kind is shown as the old one's deletion and the new one's creation.
    if (pairStatus(pair) === 'T') {
        return formatPatch({ one, two: absentSpec(two.path) }, context)
            + formatPatch({ one: absentSpec(one.path), two }, context);
    }
    // "Never use a non-valid filename anywhere if at all possible."
    const nameA = one.valid ? one.path : two.path;
    const nameB = two.valid ? two.path : nameA;
    const aOne = quoteTwo('a/', nameA.startsWith('/') ? nameA.slice(1) : nameA);
    const bTwo = quoteTwo('b/', nameB.startsWith('/') ? nameB.slice(1) : nameB);
    const lbl0 = one.valid ? aOne : '/dev/null';
    const lbl1 = two.valid ? bTwo : '/dev/null';
    const index = one.oid === two.oid
        ? ''
        : `index ${one.oid.slice(0, 7)}..${two.oid.slice(0, 7)}${one.mode === two.mode ? ` ${octal6(one.mode)}` : ''}\n`;
    let header = `diff --git ${aOne} ${bTwo}\n`;
    let mustShowHeader = true;
    if (!one.valid)
        header += `new file mode ${octal6(two.mode)}\n${index}`;
    else if (!two.valid)
        header += `deleted file mode ${octal6(one.mode)}\n${index}`;
    else {
        if (one.mode !== two.mode)
            header += `old mode ${octal6(one.mode)}\nnew mode ${octal6(two.mode)}\n`;
        else
            mustShowHeader = pair.renameScore !== undefined;
        if (pair.renameScore !== undefined) {
            header += `similarity index ${similarityIndex(pair.renameScore)}%\n`
                + `rename from ${quotePath(one.path)}\nrename to ${quotePath(two.path)}\n`;
        }
        header += index;
    }
    if (isBinary(one.data) || isBinary(two.data)) {
        if (one.valid && two.valid && sameBytes(one.data, two.data))
            return mustShowHeader ? header : '';
        return `${header}Binary files ${lbl0} and ${lbl1} differ\n`;
    }
    const hunks = formatHunks(diffText(one.data, two.data), context);
    if (!hunks)
        return mustShowHeader ? header : '';
    return header + labelLine('---', lbl0) + labelLine('+++', lbl1) + hunks;
}
// ── Name lists ──────────────────────────────────────────────────────────
export function formatNameOnly(pair, z) {
    return pathLine(pair.two.path, z);
}
export function formatNameStatus(pair, z) {
    const status = pairStatus(pair);
    if (status === 'R') {
        const score = String(similarityIndex(pair.renameScore ?? 0)).padStart(3, '0');
        return z
            ? `R${score}\0${binaryPath(pair.one.path)}\0${binaryPath(pair.two.path)}\0`
            : `R${score}\t${quotePath(pair.one.path)}\t${quotePath(pair.two.path)}\n`;
    }
    const name = pair.one.mode ? pair.one.path : pair.two.path;
    return z ? `${status}\0${binaryPath(name)}\0` : `${status}\t${quotePath(name)}\n`;
}
/** pprint_rename: `a => b`, with a shared directory prefix and suffix hoisted around braces. */
function renameName(from, to) {
    const a = binaryPath(from);
    const b = binaryPath(to);
    const qa = cQuoted(a);
    const qb = cQuoted(b);
    if (qa !== null || qb !== null) {
        return `${qa === null ? a : `"${qa}"`} => ${qb === null ? b : `"${qb}"`}`;
    }
    let prefix = 0;
    for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) {
        if (a[i] === '/')
            prefix = i + 1;
    }
    // Both scans stop at a '/' or 0; with a prefix the suffix scan may reach its slash.
    let suffix = 0;
    const floor = prefix - (prefix ? 1 : 0);
    const at = (s, k) => (k < s.length ? s[k] : '\0');
    for (let i = a.length, j = b.length; i >= floor && j >= floor && at(a, i) === at(b, j); i--, j--) {
        if (at(a, i) === '/')
            suffix = a.length - i;
    }
    const aMid = Math.max(a.length - prefix - suffix, 0);
    const bMid = Math.max(b.length - prefix - suffix, 0);
    const middle = `${a.slice(prefix, prefix + aMid)} => ${b.slice(prefix, prefix + bMid)}`;
    return prefix + suffix ? `${a.slice(0, prefix)}{${middle}}${a.slice(a.length - suffix)}` : middle;
}
export function statFile(pair) {
    const { one, two } = pair;
    const name = one.path === two.path ? quotePath(two.path) : renameName(one.path, two.path);
    if (isBinary(one.data) || isBinary(two.data)) {
        const differ = !(one.valid && two.valid && one.oid === two.oid);
        return { name, binary: true, added: differ ? two.data.length : 0, deleted: differ ? one.data.length : 0 };
    }
    let added = 0;
    let deleted = 0;
    for (const change of diffText(one.data, two.data).changes) {
        added += change.n2;
        deleted += change.n1;
    }
    return { name, binary: false, added, deleted };
}
function decimalWidth(n) {
    return String(n).length;
}
function scaleLinear(it, width, maxChange) {
    if (!it)
        return 0;
    // At least one mark for any change: scale to one column less, then add one.
    return 1 + Math.floor(it * (width - 1) / maxChange);
}
/** The --stat block for `columns` terminal columns (git's term_columns: $COLUMNS, else 80). */
export function formatStat(files, columns) {
    if (files.length === 0)
        return '';
    let maxLen = 0;
    let maxChange = 0;
    let numberWidth = 0;
    let binWidth = 0;
    for (const file of files) {
        maxLen = Math.max(maxLen, file.name.length);
        if (file.binary) {
            // "Bin XXX -> YYY bytes"
            binWidth = Math.max(binWidth, 14 + decimalWidth(file.added) + decimalWidth(file.deleted));
            numberWidth = 3;
            continue;
        }
        maxChange = Math.max(maxChange, file.added + file.deleted);
    }
    numberWidth = Math.max(decimalWidth(maxChange), numberWidth);
    // Guarantee 3/8*16 == 6 columns for the graph and 5/8*16 == 10 for the name.
    const width = Math.max(columns, 16 + 6 + numberWidth);
    let graphWidth = maxChange + 4 > binWidth ? maxChange : binWidth - 4;
    let nameWidth = maxLen;
    if (nameWidth + numberWidth + 6 + graphWidth > width) {
        const graphShare = Math.floor(width * 3 / 8) - numberWidth - 6;
        if (graphWidth > graphShare)
            graphWidth = Math.max(graphShare, 6);
        if (nameWidth > width - numberWidth - 6 - graphWidth)
            nameWidth = width - numberWidth - 6 - graphWidth;
        else
            graphWidth = width - numberWidth - 6 - nameWidth;
    }
    let out = '';
    let insertions = 0;
    let deletions = 0;
    for (const file of files) {
        let name = file.name;
        let prefix = '';
        let len = nameWidth;
        if (nameWidth < name.length) {
            prefix = '...';
            len = Math.max(len - 3, 0);
            name = name.slice(name.length - len);
            const slash = name.indexOf('/');
            if (slash >= 0)
                name = name.slice(slash);
        }
        const lead = ` ${prefix}${name}${' '.repeat(Math.max(len - name.length, 0))} | `;
        if (file.binary) {
            out += lead + 'Bin'.padStart(numberWidth)
                + (file.added || file.deleted ? ` ${file.deleted} -> ${file.added} bytes\n` : '\n');
            continue;
        }
        insertions += file.added;
        deletions += file.deleted;
        const total = file.added + file.deleted;
        let add = file.added;
        let del = file.deleted;
        if (graphWidth <= maxChange) {
            let marks = scaleLinear(total, graphWidth, maxChange);
            if (marks < 2 && add && del)
                marks = 2;
            if (add < del) {
                add = scaleLinear(add, graphWidth, maxChange);
                del = marks - add;
            }
            else {
                del = scaleLinear(del, graphWidth, maxChange);
                add = marks - del;
            }
        }
        out += `${lead}${String(total).padStart(numberWidth)}${total ? ' ' : ''}${'+'.repeat(add)}${'-'.repeat(del)}\n`;
    }
    let summary = files.length === 1 ? ` ${files.length} file changed` : ` ${files.length} files changed`;
    if (insertions || deletions === 0)
        summary += `, ${insertions} insertion${insertions === 1 ? '' : 's'}(+)`;
    if (deletions || insertions === 0)
        summary += `, ${deletions} deletion${deletions === 1 ? '' : 's'}(-)`;
    return `${out}${summary}\n`;
}
// ── Renames (diffcore-rename.c, diffcore-delta.c) ───────────────────────
export const MAX_SCORE = 60000;
export const DEFAULT_RENAME_SCORE = 30000;
const DEFAULT_RENAME_LIMIT = 1000;
const NUM_CANDIDATE_PER_DST = 4;
const HASHBASE = 107927;
export function similarityIndex(score) {
    return Math.floor(score * 100 / MAX_SCORE);
}
/** parse_rename_score (`5`, `50%` and `.5` are all 50%), or null when anything follows the number. */
export function parseRenameScore(text) {
    let num = 0;
    let scale = 1;
    let dot = false;
    let i = 0;
    for (; i < text.length; i++) {
        const ch = text[i];
        if (!dot && ch === '.') {
            scale = 1;
            dot = true;
        }
        else if (ch === '%') {
            scale = dot ? scale * 100 : 100;
            i++;
            break;
        }
        else if (ch >= '0' && ch <= '9') {
            if (scale < 100000) {
                scale *= 10;
                num = num * 10 + Number(ch);
            }
        }
        else {
            break;
        }
    }
    if (i < text.length)
        return null;
    return num >= scale ? MAX_SCORE : Math.floor(MAX_SCORE * num / scale);
}
const isRegular = (mode) => (mode & S_IFMT) === 0o100000;
const basenameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
/** hash_chars: bytes per span (a line, or 64 bytes) keyed by the span's hash; CR before LF is skipped in text. */
function spanCounts(data) {
    const text = !isBinary(data);
    const counts = new Map();
    let n = 0;
    let accum1 = 0;
    let accum2 = 0;
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (text && c === 0x0d && i + 1 < data.length && data[i + 1] === 0x0a)
            continue;
        const old1 = accum1;
        accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
        accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
        if (++n < 64 && c !== 0x0a)
            continue;
        const hash = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
        counts.set(hash, (counts.get(hash) ?? 0) + n);
        n = accum1 = accum2 = 0;
    }
    if (n > 0) {
        const hash = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
        counts.set(hash, (counts.get(hash) ?? 0) + n);
    }
    return counts;
}
/** estimate_similarity: how much of the larger side the source's spans account for, out of MAX_SCORE. */
function estimateSimilarity(src, dst, minimumScore) {
    const maxSize = Math.max(src.size, dst.size);
    const delta = maxSize - Math.min(src.size, dst.size);
    // Edits that change the size this much are not considered.
    if (maxSize * (MAX_SCORE - minimumScore) < delta * MAX_SCORE)
        return 0;
    if (!dst.size)
        return 0;
    let copied = 0;
    for (const [hash, count] of src.spans) {
        const other = dst.spans.get(hash);
        if (other !== undefined)
            copied += Math.min(count, other);
    }
    return Math.floor(copied * MAX_SCORE / maxSize);
}
/** score_compare: the unused slots last, then by score, then by a shared basename. */
function scoreCompare(a, b) {
    if (a.dst < 0)
        return b.dst >= 0 ? 1 : 0;
    if (b.dst < 0)
        return -1;
    if (a.score === b.score)
        return b.nameScore - a.nameScore;
    return b.score - a.score;
}
function recordIfBetter(slots, candidate) {
    let worst = 0;
    for (let i = 1; i < slots.length; i++)
        if (scoreCompare(slots[i], slots[worst]) > 0)
            worst = i;
    if (scoreCompare(slots[worst], candidate) > 0)
        slots[worst] = candidate;
}
/**
 * git diff's default rename detection over a path-ordered queue: exact
 * renames, then unique basenames at a higher bar, then the similarity
 * matrix, skipped (as git skips it) past `renameLimit` squared pairs. A
 * rename takes its destination's place in the queue. `neededRenameLimit`
 * is non-zero when the matrix was skipped.
 */
export async function detectRenames(queue, read, { minimumScore = DEFAULT_RENAME_SCORE, renameLimit = DEFAULT_RENAME_LIMIT } = {}) {
    const srcs = [];
    const dsts = [];
    const srcOf = new Map();
    const dstOf = new Map();
    for (const pair of queue) {
        if (!pair.one && pair.two) {
            const dst = { side: pair.two };
            dsts.push(dst);
            dstOf.set(pair, dst);
        }
        else if (pair.one && !pair.two) {
            const src = { side: pair.one, used: false };
            srcs.push(src);
            srcOf.set(pair, src);
        }
    }
    const contents = new Map();
    const content = async (side) => {
        let known = contents.get(side);
        if (!known) {
            const data = await read(side);
            contents.set(side, known = { size: data.length, spans: spanCounts(data) });
        }
        return known;
    };
    const similarity = async (src, dst, minimum) => (isRegular(src.mode) && isRegular(dst.mode)
        ? estimateSimilarity(await content(src), await content(dst), minimum)
        : 0);
    const record = (dst, src, score) => {
        src.used = true;
        dst.rename = { one: src.side, two: dst.side, renameScore: score };
    };
    let neededRenameLimit = 0;
    match: {
        if (!dsts.length || !srcs.length)
            break match;
        // Exact: the first unused source with the same blob, one with the same basename first.
        const byOid = new Map();
        for (const src of srcs) {
            const list = byOid.get(src.side.oid);
            if (list)
                list.push(src);
            else
                byOid.set(src.side.oid, [src]);
        }
        let renames = 0;
        for (const dst of dsts) {
            let best = null;
            let bestScore = -1;
            let tries = 100;
            for (const src of byOid.get(dst.side.oid) ?? []) {
                // Only regular files may change mode across a rename.
                if ((!isRegular(src.side.mode) || !isRegular(dst.side.mode)) && src.side.mode !== dst.side.mode)
                    continue;
                if (src.used)
                    continue;
                const score = 1 + (basenameOf(src.side.path) === basenameOf(dst.side.path) ? 1 : 0);
                if (score > bestScore) {
                    best = src;
                    bestScore = score;
                    if (score === 2)
                        break;
                }
                if (!--tries)
                    break;
            }
            if (best) {
                record(dst, best, MAX_SCORE);
                renames++;
            }
        }
        if (minimumScore === MAX_SCORE)
            break match;
        // A basename unique among both sides pairs up if it clears the higher bar.
        let pool = srcs.filter((src) => !src.used);
        const minBasenameScore = minimumScore + Math.trunc(0.5 * (MAX_SCORE - minimumScore));
        const srcBases = new Map();
        pool.forEach((src, i) => {
            const base = basenameOf(src.side.path);
            srcBases.set(base, srcBases.has(base) ? -1 : i);
        });
        const dstBases = new Map();
        for (const dst of dsts) {
            if (dst.rename)
                continue;
            const base = basenameOf(dst.side.path);
            dstBases.set(base, dstBases.has(base) ? null : dst);
        }
        for (const [i, src] of pool.entries()) {
            const base = basenameOf(src.side.path);
            const dst = dstBases.get(base);
            if (!dst || srcBases.get(base) !== i || dst.rename)
                continue;
            const score = await similarity(src.side, dst.side, minBasenameScore);
            if (score < minBasenameScore)
                continue;
            record(dst, src, score);
            renames++;
        }
        pool = pool.filter((src) => !src.used);
        const remaining = dsts.length - renames;
        if (!remaining || !pool.length)
            break match;
        if (renameLimit > 0 && remaining * pool.length > renameLimit * renameLimit) {
            neededRenameLimit = Math.max(pool.length, remaining);
            break match;
        }
        for (const src of pool)
            if (isRegular(src.side.mode))
                await content(src.side);
        for (const dst of dsts)
            if (!dst.rename && isRegular(dst.side.mode))
                await content(dst.side);
        const matrix = [];
        for (const [d, dst] of dsts.entries()) {
            if (dst.rename)
                continue;
            const slots = Array.from({ length: NUM_CANDIDATE_PER_DST }, () => ({ dst: -1, src: -1, score: 0, nameScore: 0 }));
            for (const [s, src] of pool.entries()) {
                const score = isRegular(src.side.mode) && isRegular(dst.side.mode)
                    ? estimateSimilarity(contents.get(src.side), contents.get(dst.side), minimumScore)
                    : 0;
                recordIfBetter(slots, { dst: d, src: s, score, nameScore: basenameOf(src.side.path) === basenameOf(dst.side.path) ? 1 : 0 });
            }
            matrix.push(...slots);
        }
        matrix.sort(scoreCompare);
        for (const candidate of matrix) {
            if (candidate.dst < 0 || candidate.score < minimumScore)
                break;
            const dst = dsts[candidate.dst];
            const src = pool[candidate.src];
            if (dst.rename || src.used)
                continue;
            record(dst, src, candidate.score);
        }
    }
    const out = [];
    for (const pair of queue) {
        const dst = dstOf.get(pair);
        if (dst)
            out.push(dst.rename ?? pair);
        else if (!srcOf.get(pair)?.used)
            out.push(pair);
    }
    return { queue: out, neededRenameLimit };
}
