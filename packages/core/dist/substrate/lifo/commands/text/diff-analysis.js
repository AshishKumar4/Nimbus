/**
 * How GNU diffutils 3.12 compares two texts, ported so diff's edit script is
 * GNU's own: find_identical_ends (io.c) trims the common prefix and suffix
 * down to a horizon of context lines; find_and_hash_each_line gives each
 * remaining line an equivalence class; discard_confusing_lines, compareseq
 * and its diag (gnulib's diffseq.h: Myers' O(ND) search, bidirectional, in
 * linear space), shift_boundaries and build_script (analyze.c) turn the
 * classes into changes. Memory is linear in the input: per line a start, a
 * class and a flag, and two diagonal vectors of the lines' count; no table
 * of the two files' product.
 */
import { decodeLossless } from '../../utils/bytes-io.js';
const NL = 0x0a;
export function diffText(bytes) {
    const missingNewline = bytes.length > 0 && bytes[bytes.length - 1] !== NL;
    const buffer = missingNewline ? new Uint8Array(bytes.length + 1) : bytes;
    if (missingNewline) {
        buffer.set(bytes);
        buffer[bytes.length] = NL;
    }
    let lineCount = 0;
    for (let i = 0; i < buffer.length; i++)
        if (buffer[i] === NL)
            lineCount++;
    const lineStart = new Int32Array(lineCount + 1);
    for (let i = 0, line = 1; i < buffer.length; i++)
        if (buffer[i] === NL)
            lineStart[line++] = i + 1;
    return { buffer, missingNewline, lineStart, lineCount };
}
/** The line containing byte `offset`, which is a line's start (or the end). */
function lineAt(text, offset) {
    let lo = 0;
    let hi = text.lineCount;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (text.lineStart[mid] < offset)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
function floorLog2(n) {
    return 31 - Math.clz32(n);
}
/**
 * io.c's find_identical_ends: where the comparison starts (a line beginning,
 * `horizon` lines into the common prefix) and where it ends in each file (a
 * line beginning `horizon` lines, and one more when the suffix does not
 * start a line in both, into the common suffix). A missing final newline is
 * never part of the prefix, and leaves no common suffix unless both lack it.
 */
function identicalEnds(a, b, horizon) {
    const buffer0 = a.buffer;
    const buffer1 = b.buffer;
    const n0 = buffer0.length;
    const n1 = buffer1.length;
    let p = 0;
    const shorter = Math.min(n0, n1);
    while (p < shorter && buffer0[p] === buffer1[p])
        p++;
    if ((n0 - Number(a.missingNewline) < p) !== (n1 - Number(b.missingNewline) < p))
        p--;
    let hor = horizon;
    while (p !== 0 && (buffer0[p - 1] !== NL || hor-- !== 0))
        p--;
    const prefixEnd = p;
    let p0 = n0;
    let p1 = n1;
    if (a.missingNewline === b.missingNewline) {
        let beg0 = prefixEnd + (n0 < n1 ? 0 : n0 - n1);
        while (p0 !== beg0) {
            if (buffer0[--p0] !== buffer1[--p1]) {
                ++p0;
                ++p1;
                beg0 = p0;
                break;
            }
        }
        const atLineStart = (p0 === 0 || buffer0[p0 - 1] === NL) && (p1 === 0 || buffer1[p1 - 1] === NL);
        let i = horizon + (atLineStart ? 0 : 1);
        while (i-- !== 0 && p0 !== n0)
            while (buffer0[p0++] !== NL) { /* to the line's end */ }
        p1 += p0 - beg0;
    }
    return { prefixEnd, suffix0: p0, suffix1: p1 };
}
const SPACE = /[\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/;
const SPACES = new RegExp(`${SPACE.source}+`, 'g');
const TRAILING_SPACES = new RegExp(`${SPACE.source}+$`);
/**
 * A line's class key: two lines are one class when their keys are equal,
 * as lines_differ decides under -i, -b and -w. A final line without a
 * newline equals only the other file's like line, unless -b or -w.
 */
function lineKey(text, line, options) {
    const start = text.lineStart[line];
    const end = text.lineStart[line + 1] - 1;
    // Lossless, so lines of different bytes never share a key.
    let key = decodeLossless(text.buffer.subarray(start, end));
    if (options.whiteSpace === 'all')
        key = key.replace(SPACES, '');
    else if (options.whiteSpace === 'change')
        key = key.replace(TRAILING_SPACES, '').replace(SPACES, ' ');
    if (options.ignoreCase)
        key = key.toLowerCase();
    const incomplete = text.missingNewline && line === text.lineCount - 1 && options.whiteSpace === 'none';
    return incomplete ? `\u0000${key}` : `\u0001${key}`;
}
const ALL_SPACE = new RegExp(`^${SPACE.source}*$`);
/** Whether line `line` is blank to -B, as analyze_hunk judges it: empty, or under -b or -w white space only. */
export function blankLine(text, line, whiteSpace) {
    const start = text.lineStart[line];
    const end = text.lineStart[line + 1] - 1;
    if (start === end)
        return true;
    return whiteSpace !== 'none' && ALL_SPACE.test(decodeLossless(text.buffer.subarray(start, end)));
}
const OFFSET_MAX = 0x7fffffff;
const SNAKE_LIMIT = 20;
/** diffseq.h's diag: the midpoint of a shortest edit script of [xoff, xlim) × [yoff, ylim). */
function diag(xoff, xlim, yoff, ylim, findMinimal, part, s) {
    const { xv, yv, fd, bd, offset: o } = s;
    const dmin = xoff - ylim;
    const dmax = xlim - yoff;
    const fmid = xoff - yoff;
    const bmid = xlim - ylim;
    let fmin = fmid;
    let fmax = fmid;
    let bmin = bmid;
    let bmax = bmid;
    const odd = ((fmid - bmid) & 1) !== 0;
    fd[fmid + o] = xoff;
    bd[bmid + o] = xlim;
    for (let c = 1;; ++c) {
        if (fmin > dmin)
            fd[--fmin - 1 + o] = -1;
        else
            ++fmin;
        if (fmax < dmax)
            fd[++fmax + 1 + o] = -1;
        else
            --fmax;
        for (let d = fmax; d >= fmin; d -= 2) {
            const tlo = fd[d - 1 + o];
            const thi = fd[d + 1 + o];
            const x0 = tlo < thi ? thi : tlo + 1;
            let x = x0;
            let y = x0 - d;
            while (x < xlim && y < ylim && xv[x] === yv[y]) {
                x++;
                y++;
            }
            fd[d + o] = x;
            if (odd && bmin <= d && d <= bmax && bd[d + o] <= x) {
                part.xmid = x;
                part.ymid = y;
                part.loMinimal = part.hiMinimal = true;
                return;
            }
        }
        if (bmin > dmin)
            bd[--bmin - 1 + o] = OFFSET_MAX;
        else
            ++bmin;
        if (bmax < dmax)
            bd[++bmax + 1 + o] = OFFSET_MAX;
        else
            --bmax;
        for (let d = bmax; d >= bmin; d -= 2) {
            const tlo = bd[d - 1 + o];
            const thi = bd[d + 1 + o];
            const x0 = tlo < thi ? tlo : thi - 1;
            let x = x0;
            let y = x0 - d;
            while (xoff < x && yoff < y && xv[x - 1] === yv[y - 1]) {
                x--;
                y--;
            }
            bd[d + o] = x;
            if (!odd && fmin <= d && d <= fmax && x <= fd[d + o]) {
                part.xmid = x;
                part.ymid = y;
                part.loMinimal = part.hiMinimal = true;
                return;
            }
        }
        if (findMinimal)
            continue;
        // Gone well beyond the call of duty: report halfway between the best results so far.
        if (c >= s.tooExpensive) {
            let fxybest = -1;
            let fxbest = 0;
            for (let d = fmax; d >= fmin; d -= 2) {
                let x = Math.min(fd[d + o], xlim);
                let y = x - d;
                if (ylim < y) {
                    x = ylim + d;
                    y = ylim;
                }
                if (fxybest < x + y) {
                    fxybest = x + y;
                    fxbest = x;
                }
            }
            let bxybest = OFFSET_MAX;
            let bxbest = 0;
            for (let d = bmax; d >= bmin; d -= 2) {
                let x = Math.max(xoff, bd[d + o]);
                let y = x - d;
                if (y < yoff) {
                    x = yoff + d;
                    y = yoff;
                }
                if (x + y < bxybest) {
                    bxybest = x + y;
                    bxbest = x;
                }
            }
            if ((xlim + ylim) - bxybest < fxybest - (xoff + yoff)) {
                part.xmid = fxbest;
                part.ymid = fxybest - fxbest;
                part.loMinimal = true;
                part.hiMinimal = false;
            }
            else {
                part.xmid = bxbest;
                part.ymid = bxybest - bxbest;
                part.loMinimal = false;
                part.hiMinimal = true;
            }
            return;
        }
    }
}
/** diffseq.h's compareseq: note each deletion and insertion of a shortest edit script of the two ranges. */
function compareseq(xoff, xlim, yoff, ylim, findMinimal, s) {
    const { xv, yv } = s;
    const part = { xmid: 0, ymid: 0, loMinimal: false, hiMinimal: false };
    for (;;) {
        while (xoff < xlim && yoff < ylim && xv[xoff] === yv[yoff]) {
            xoff++;
            yoff++;
        }
        while (xoff < xlim && yoff < ylim && xv[xlim - 1] === yv[ylim - 1]) {
            xlim--;
            ylim--;
        }
        if (xoff === xlim) {
            while (yoff < ylim)
                s.noteInsert(yoff++);
            return;
        }
        if (yoff === ylim) {
            while (xoff < xlim)
                s.noteDelete(xoff++);
            return;
        }
        diag(xoff, xlim, yoff, ylim, findMinimal, part, s);
        const { xmid, ymid, loMinimal, hiMinimal } = part;
        // The smaller subproblem recurses; the other is this loop's next turn.
        if ((xlim + ylim) - (xmid + ymid) < (xmid + ymid) - (xoff + yoff)) {
            compareseq(xmid, xlim, ymid, ylim, hiMinimal, s);
            xlim = xmid;
            ylim = ymid;
            findMinimal = loMinimal;
        }
        else {
            compareseq(xoff, xmid, yoff, ymid, loMinimal, s);
            xoff = xmid;
            yoff = ymid;
            findMinimal = hiMinimal;
        }
    }
}
/**
 * analyze.c's discard_confusing_lines: a line no line of the other file
 * matches is a change outright; one that matches very many is set aside when
 * it sits in a run of such lines. Returns the kept lines' classes and their
 * real indexes, the discarded ones marked changed.
 */
function discardConfusingLines(equivs, classCount, changed, minimal) {
    const counts = [new Int32Array(classCount), new Int32Array(classCount)];
    for (let f = 0; f < 2; f++)
        for (const e of equivs[f])
            counts[f][e]++;
    const discarded = [new Uint8Array(equivs[0].length), new Uint8Array(equivs[1].length)];
    for (let f = 0; f < 2; f++) {
        const end = equivs[f].length;
        const discards = discarded[f];
        const other = counts[1 - f];
        const many = 5 << (end < 64 ? 0 : (floorLog2(end) >> 1) - 3);
        for (let i = 0; i < end; i++) {
            const nmatch = other[equivs[f][i]];
            if (nmatch === 0)
                discards[i] = 1;
            else if (nmatch > many)
                discards[i] = 2;
        }
    }
    for (let f = 0; f < 2; f++) {
        const end = equivs[f].length;
        const discards = discarded[f];
        for (let i = 0; i < end; i++) {
            if (discards[i] === 2) {
                discards[i] = 0;
                continue;
            }
            if (discards[i] === 0)
                continue;
            let provisional = 0;
            let j = i;
            for (; j < end; j++) {
                if (discards[j] === 0)
                    break;
                if (discards[j] === 2)
                    ++provisional;
            }
            while (j > i && discards[j - 1] === 2) {
                discards[--j] = 0;
                --provisional;
            }
            const length = j - i;
            if (length >> 2 < provisional) {
                while (j > i)
                    if (discards[--j] === 2)
                        discards[j] = 0;
            }
            else {
                const minimum = length < 4 ? 2 : (1 << ((floorLog2(length) >> 1) - 1)) + 1;
                let consec = 0;
                for (j = 0; j < length; j++) {
                    if (discards[i + j] !== 2)
                        consec = 0;
                    else if (minimum === ++consec)
                        j -= consec;
                    else if (minimum < consec)
                        discards[i + j] = 0;
                }
                consec = 0;
                for (j = 0; j < length; j++) {
                    if (j >= 8 && discards[i + j] === 1)
                        break;
                    if (discards[i + j] === 2) {
                        consec = 0;
                        discards[i + j] = 0;
                    }
                    else if (discards[i + j] === 0)
                        consec = 0;
                    else
                        consec++;
                    if (consec === 3)
                        break;
                }
                i += length - 1;
                consec = 0;
                for (j = 0; j < length; j++) {
                    if (j >= 8 && discards[i - j] === 1)
                        break;
                    if (discards[i - j] === 2) {
                        consec = 0;
                        discards[i - j] = 0;
                    }
                    else if (discards[i - j] === 0)
                        consec = 0;
                    else
                        consec++;
                    if (consec === 3)
                        break;
                }
            }
        }
    }
    const undiscarded = [new Int32Array(equivs[0].length), new Int32Array(equivs[1].length)];
    const realIndexes = [new Int32Array(equivs[0].length), new Int32Array(equivs[1].length)];
    const kept = [0, 0];
    for (let f = 0; f < 2; f++) {
        let j = 0;
        for (let i = 0; i < equivs[f].length; i++) {
            if (minimal || discarded[f][i] === 0) {
                undiscarded[f][j] = equivs[f][i];
                realIndexes[f][j++] = i;
            }
            else {
                changed[f][i + 1] = 1;
            }
        }
        kept[f] = j;
    }
    return { undiscarded, realIndexes, kept };
}
/**
 * analyze.c's shift_boundaries: slide each run of changes over the
 * identical lines around it, to merge with its neighbours and, failing
 * that, to sit as late as it can, or against a change in the other file.
 * `changed[f][i + 1]` is line i's flag, with a clear flag at each end.
 */
function shiftBoundaries(equivs, changed) {
    for (let f = 0; f < 2; f++) {
        const c = changed[f];
        const other = changed[1 - f];
        const eq = equivs[f];
        const iEnd = eq.length;
        let i = 0;
        let j = 0;
        for (;;) {
            while (i < iEnd && !c[i + 1]) {
                while (other[1 + j++]) { /* past the other file's changes */ }
                i++;
            }
            if (i === iEnd)
                break;
            let start = i;
            while (c[1 + ++i]) { /* to the run's end */ }
            while (other[1 + j])
                j++;
            let runlength;
            let corresponding;
            do {
                runlength = i - start;
                while (start && eq[start - 1] === eq[i - 1]) {
                    c[1 + --start] = 1;
                    c[1 + --i] = 0;
                    while (c[1 + start - 1])
                        start--;
                    while (other[1 + --j]) { /* back over the other file's changes */ }
                }
                corresponding = other[1 + j - 1] ? i : iEnd;
                while (i !== iEnd && eq[start] === eq[i]) {
                    c[1 + start++] = 0;
                    c[1 + i++] = 1;
                    while (c[1 + i])
                        i++;
                    while (other[1 + ++j])
                        corresponding = i;
                }
            } while (runlength !== i - start);
            while (corresponding < i) {
                c[1 + --start] = 1;
                c[1 + --i] = 0;
                while (other[1 + --j]) { /* back over the other file's changes */ }
            }
        }
    }
}
/** GNU diff's edit script of `a` into `b`, its changes in order, by absolute line index. */
export function compareTexts(a, b, options) {
    const { prefixEnd, suffix0, suffix1 } = identicalEnds(a, b, options.horizon);
    const prefixLines = lineAt(a, prefixEnd);
    const middle = [lineAt(a, suffix0) - prefixLines, lineAt(b, suffix1) - prefixLines];
    if (middle[0] === 0 && middle[1] === 0)
        return [];
    const classes = new Map();
    const equivs = [new Int32Array(middle[0]), new Int32Array(middle[1])];
    const texts = [a, b];
    for (let f = 0; f < 2; f++) {
        for (let i = 0; i < middle[f]; i++) {
            const key = lineKey(texts[f], prefixLines + i, options);
            let id = classes.get(key);
            if (id === undefined) {
                id = classes.size + 1;
                classes.set(key, id);
            }
            equivs[f][i] = id;
        }
    }
    const changed = [new Uint8Array(middle[0] + 2), new Uint8Array(middle[1] + 2)];
    const { undiscarded, realIndexes, kept } = discardConfusingLines(equivs, classes.size + 1, changed, options.minimal);
    const diags = kept[0] + kept[1] + 3;
    const tooExpensive = Math.max(4096, 1 << ((floorLog2(diags) >> 1) + 1));
    const search = {
        xv: undiscarded[0],
        yv: undiscarded[1],
        fd: new Int32Array(diags),
        bd: new Int32Array(diags),
        offset: kept[1] + 1,
        tooExpensive,
        noteDelete: (x) => { changed[0][realIndexes[0][x] + 1] = 1; },
        noteInsert: (y) => { changed[1][realIndexes[1][y] + 1] = 1; },
    };
    compareseq(0, kept[0], 0, kept[1], options.minimal, search);
    shiftBoundaries(equivs, changed);
    // build_script, forward: runs of changed lines, in order.
    const script = [];
    const [c0, c1] = changed;
    for (let i0 = 0, i1 = 0; i0 < middle[0] || i1 < middle[1]; i0++, i1++) {
        if (c0[i0 + 1] || c1[i1 + 1]) {
            const line0 = i0;
            const line1 = i1;
            while (c0[i0 + 1])
                i0++;
            while (c1[i1 + 1])
                i1++;
            script.push({ line0: prefixLines + line0, line1: prefixLines + line1, deleted: i0 - line0, inserted: i1 - line1 });
        }
    }
    return script;
}
