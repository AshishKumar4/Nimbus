/**
 * find's command line, parsed as findutils 4.10 parses it (parser.c, tree.c):
 * leading options, start points, then an expression built in two passes. The
 * first turns arguments into a list of predicates, inserting the implicit
 * -a and running each predicate's own parser (which may stat a reference
 * file or look up a user, and may fail the command); the second builds the
 * tree by precedence, with GNU's messages for every malformed shape.
 *
 * GNU predicates this find does not implement are refused by name rather
 * than skipped: skipping one answers a different question.
 */
import { isVfsError, VFS_STRERROR } from '../../../../../vfs/vfs-error.js';
import { findUnixGroup, findUnixUser } from '../../../../../shell/unix-accounts.js';
import { globMatch } from '../../../utils/glob.js';
import { resolve } from '../../../utils/path.js';
import { adjustMode, compileMode } from '../../../utils/mode-change.js';
import { parseDateTime } from '../../../utils/parse-datetime.js';
import { compileFormat } from './format.js';
import { FindUsageError, quote } from './errors.js';
const DAY_SECONDS = 86400;
/** findutils' looks_like_expression: what ends the start points (`leading`) or must begin each expression argument. */
function looksLikeExpression(arg, leading) {
    switch (arg[0]) {
        case '-': return arg.length > 1;
        case ')':
        case ',': return arg.length === 1 && !leading;
        case '!':
        case '(': return arg.length === 1;
        default: return false;
    }
}
const PRECEDENCE = { comma: 1, or: 2, and: 3, not: 4 };
/** How a predicate's parser failed: GNU then names the argument it stopped at, or says one is missing. */
const MALFORMED = Symbol('malformed');
/** GNU predicates refused by name, with why. */
const NOT_IMPLEMENTED = {
    fstype: 'file system types are not reported',
    ls: 'block counts are not reported',
    fls: 'block counts are not reported',
    fprint: 'output files are not supported',
    fprint0: 'output files are not supported',
    fprintf: 'output files are not supported',
    'files0-from': 'start points from a file are not supported',
    ok: 'there is no prompt to confirm on',
    okdir: 'there is no prompt to confirm on',
    regex: 'regular expressions are not supported',
    iregex: 'regular expressions are not supported',
    regextype: 'regular expressions are not supported',
};
class Parser {
    args;
    startPoints;
    environment;
    items = [{ type: 'open', name: '(', artificial: true }];
    symlinks = 'P';
    maxDepth = Infinity;
    minDepth = 0;
    depthFirst = false;
    explicitDepth = false;
    sameDevice = false;
    ignoreVanished = false;
    warnings;
    firstNonOption = null;
    /** Midnight-relative days begin here (findutils' cur_day_start): a day before now, or today's midnight after -daystart. */
    dayStart;
    fullDays = false;
    pos;
    constructor(args, start, startPoints, environment) {
        this.args = args;
        this.startPoints = startPoints;
        this.environment = environment;
        this.pos = start;
        this.warnings = environment.warnings;
        this.dayStart = environment.now - DAY_SECONDS * 1000;
    }
    next() {
        return this.args[this.pos++];
    }
    get position() {
        return this.pos;
    }
    set position(value) {
        this.pos = value;
    }
    get last() {
        return this.items[this.items.length - 1];
    }
    /** Before a primary, a `!` or a `(`, the implicit -a GNU inserts after a primary or `)`. */
    joinWithAnd() {
        const last = this.last;
        if (last.type === 'primary' || last.type === 'close')
            this.items.push({ type: 'binary', name: '-a', op: 'and' });
    }
    addPrimary(name, primary, action = false) {
        this.joinWithAnd();
        this.items.push({ type: 'primary', name, primary, action });
    }
    addNot(name) {
        this.joinWithAnd();
        this.items.push({ type: 'not', name });
    }
    addOpen(name) {
        this.joinWithAnd();
        this.items.push({ type: 'open', name, artificial: false });
    }
    addClose(name) {
        this.items.push({ type: 'close', name, artificial: false });
    }
    addBinary(name, op) {
        this.items.push({ type: 'binary', name, op });
    }
    /** An option evaluates as true where it stands, as GNU's no-op predicate does. */
    addOption(name) {
        this.addPrimary(name, { kind: 'true' });
    }
    warn(message) {
        if (this.warnings)
            this.environment.warn(message);
    }
    /** GNU's warning for a global option after a test, and its record of the first non-option. */
    noteClass(name, argClass) {
        if (argClass === 'option') {
            if (this.firstNonOption !== null) {
                this.warn(`warning: you have specified the global option ${name} after the argument ${this.firstNonOption}, but global options are not positional, i.e., ${name} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.`);
            }
        }
        else if (argClass === 'other' && this.firstNonOption === null) {
            this.firstNonOption = name;
        }
    }
    daystart() {
        if (this.fullDays)
            return;
        // Midnight in the session's zone (UTC) of the day after dayStart, which is today.
        const tomorrow = this.dayStart + DAY_SECONDS * 1000;
        this.dayStart = tomorrow - (tomorrow % (DAY_SECONDS * 1000));
        this.fullDays = true;
    }
    /** findutils' parse_time (-atime, -ctime, -mtime) and do_parse_xmin (-amin, -cmin, -mmin). */
    relativeTime(argument, unitSeconds, days) {
        let origin = days ? this.dayStart : this.dayStart + DAY_SECONDS * 1000;
        // `-n` days counts to the end of today.
        if (days && argument.startsWith('-'))
            origin += (DAY_SECONDS - 1) * 1000;
        return relativeTimestamp(argument, origin, unitSeconds, days ? 'days' : 'minutes');
    }
    /**
     * stat as the walk will (links per -P/-H/-L, the command line counting as
     * depth 0), failing the command as GNU does. A trailing slash names the
     * directory a link leads to, and nothing else, as path resolution does.
     */
    async statReference(path) {
        const absolute = resolve(this.environment.cwd, path);
        const vfs = this.environment.vfs;
        const directoryOnly = path.length > 1 && path.endsWith('/');
        try {
            let stat = null;
            if (directoryOnly) {
                stat = await vfs.stat(absolute);
                if (stat !== null && stat.type !== 'directory')
                    throw new FindUsageError(`${quote(path)}: ${VFS_STRERROR.ENOTDIR}`);
            }
            else if (this.symlinks !== 'P') {
                // A dangling link is examined itself (findutils' fallback_stat).
                stat = await vfs.stat(absolute).catch((error) => {
                    if (isVfsError(error, 'ENOTDIR'))
                        return null;
                    throw error;
                });
            }
            if (!directoryOnly)
                stat ??= await vfs.stat(absolute, { follow: false });
            if (stat !== null)
                return stat;
            throw new FindUsageError(`${quote(path)}: ${VFS_STRERROR.ENOENT}`);
        }
        catch (error) {
            if (isVfsError(error))
                throw new FindUsageError(`${quote(path)}: ${VFS_STRERROR[error.code]}`);
            throw error;
        }
    }
    plan(expression) {
        return {
            kind: 'walk',
            startPoints: this.startPoints,
            expression,
            symlinks: this.symlinks,
            maxDepth: this.maxDepth,
            minDepth: this.minDepth,
            depthFirst: this.depthFirst,
            sameDevice: this.sameDevice,
            ignoreVanished: this.ignoreVanished,
        };
    }
}
/** time_t's range: a reference outside it is what GNU's conversion makes INT64_MIN of. */
const TIME_T_MIN = -(2 ** 63);
const TIME_T_LIMIT = 2 ** 63;
/**
 * findutils' get_relative_timestamp: the comparison is inverted, as a larger
 * age is an earlier time. A reference past time_t's range is GNU's overflow
 * error when it lies in the future, and the earliest time when in the past.
 */
function relativeTimestamp(argument, origin, unitSeconds, unit) {
    const sign = argument[0];
    const cmp = sign === '+' ? 'lt' : sign === '-' ? 'gt' : 'eq';
    const text = sign === '+' || sign === '-' ? argument.slice(1) : argument;
    // strtod's decimal form, which takes a sign of its own (`+-1` is accepted); out of range is refused as strtod refuses it.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))
        return null;
    const offset = Number(text) * unitSeconds;
    if (!Number.isFinite(offset))
        return null;
    const seconds = Math.trunc(offset);
    const referenceSeconds = Math.floor(origin / 1000) - seconds;
    if (referenceSeconds >= TIME_T_MIN && referenceSeconds < TIME_T_LIMIT)
        return { cmp, reference: origin - offset * 1000 };
    if (seconds < 0)
        throw new FindUsageError(`arithmetic overflow while converting ${text} ${unit} to a number of seconds`);
    return { cmp, reference: TIME_T_MIN * 1000 };
}
/** findutils' get_num: an optional +/- and a decimal integer. */
function parseNumber(argument) {
    const sign = argument[0];
    const cmp = sign === '+' ? 'gt' : sign === '-' ? 'lt' : 'eq';
    const digits = sign === '+' || sign === '-' ? argument.slice(1) : argument;
    if (!/^\s*\d+$/.test(digits))
        return null;
    const value = BigInt(digits.trim());
    return value > 0xffffffffffffffffn ? null : { cmp, value: Number(value) };
}
const SIZE_UNITS = { b: 512, c: 1, w: 2, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };
const TYPE_LETTERS = { b: 'b', c: 'c', d: 'd', p: 'p', f: 'f', l: 'l', s: 's', D: 'D' };
function typeSet(letters, predicate) {
    if (letters === '')
        throw new FindUsageError(`Arguments to ${predicate} should contain at least one letter`);
    const types = {};
    for (let i = 0; i < letters.length; i++) {
        const letter = TYPE_LETTERS[letters[i]];
        if (letter === undefined)
            throw new FindUsageError(`Unknown argument to ${predicate}: ${letters[i]}`);
        if (letter === 'D')
            throw new FindUsageError(`${predicate} D is not supported because Solaris doors are not supported on the platform find was compiled on.`);
        if (types[letter])
            throw new FindUsageError(`Duplicate file type '${letter}' in the argument list to ${predicate}.`);
        types[letter] = true;
        if (i + 1 < letters.length) {
            if (letters[i + 1] !== ',')
                throw new FindUsageError(`Must separate multiple arguments to ${predicate} using: ','`);
            i++;
            if (i + 1 === letters.length)
                throw new FindUsageError(`Last file type in list argument to ${predicate} is missing, i.e., list is ending on: ','`);
        }
    }
    return types;
}
const R_OK = 4, W_OK = 2, X_OK = 1;
/** An account lookup where an unreadable /etc/passwd or /etc/group means no such account, as getpwnam reports it. */
async function accountOrNull(lookup) {
    try {
        return await lookup;
    }
    catch (error) {
        if (isVfsError(error))
            return null;
        throw error;
    }
}
function option(apply) {
    return { argClass: 'option', parse: async (parser, name) => { apply(parser); parser.addOption(name); } };
}
function positional(apply) {
    return { argClass: 'positional', parse: async (parser, name) => { apply(parser); parser.addOption(name); } };
}
function test(parse) {
    return { argClass: 'other', parse };
}
function noArgument(primary, action = false) {
    return test(async (parser, name) => { parser.addPrimary(name, primary, action); });
}
/** -depth, and -delete, which implies it. */
function visitDepthFirst(parser) {
    parser.depthFirst = true;
}
function depthLimit(set) {
    return {
        argClass: 'option',
        parse: async (parser, name) => {
            const value = parser.next();
            if (value === undefined)
                return MALFORMED;
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
                throw new FindUsageError(`Expected a positive decimal integer argument to ${name}, but got ${quote(value)}`);
            }
            set(parser, Number(value));
            parser.addOption(name);
        },
    };
}
function pattern(kind, fold, alternative) {
    return test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        if (alternative !== null && value.includes('/') && value !== '/') {
            parser.warn(`warning: '${name}' matches against basenames only, but the given pattern contains a directory separator ('/'), thus the expression will evaluate to false all the time.  Did you mean '${alternative}'?`);
        }
        if (kind === 'path' && value.endsWith('/')) {
            const candidates = parser.startPoints.length > 0 ? parser.startPoints : ['.'];
            const feasible = candidates.some((start) => fold ? globMatch(value.toLowerCase(), start.toLowerCase()) : globMatch(value, start));
            if (!feasible)
                parser.environment.warn(`warning: ${name} ${value} will not match anything because it ends with /.`);
        }
        parser.addPrimary(name, { kind, pattern: fold ? value.toLowerCase() : value, fold });
    });
}
function relativeTime(field, unitSeconds, days) {
    return test(async (parser, name) => {
        const start = parser.position;
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const time = parser.relativeTime(value, unitSeconds, days);
        if (time === null) {
            parser.position = start;
            return MALFORMED;
        }
        parser.addPrimary(name, { kind: 'time', field, cmp: time.cmp, reference: time.reference, window: days ? DAY_SECONDS : unitSeconds });
    });
}
function newer(field) {
    return test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const stat = await parser.statReference(value);
        parser.addPrimary(name, { kind: 'newer', field, reference: stat.mtimeMs });
    });
}
function numeric(field) {
    return test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const number = parseNumber(value);
        if (number === null)
            throw new FindUsageError(`non-numeric argument to ${name}: ${quote(value)}`);
        parser.addPrimary(name, { kind: 'number', field, cmp: number.cmp, value: number.value });
    });
}
function access(mode) {
    return noArgument({ kind: 'access', mode });
}
function exec(inDirectory) {
    return test(async (parser, name) => {
        const start = parser.position;
        if (parser.args[start] === undefined)
            return MALFORMED;
        if (inDirectory)
            checkPathSafety(name, parser.environment.env.PATH);
        let end = start;
        let batch = false;
        let braces = 0;
        let braceArg = '';
        let sawBraces = false;
        for (; end < parser.args.length && parser.args[end] !== ';'; end++) {
            // `+` ends the command only right after a {} argument.
            if (parser.args[end] === '+' && sawBraces) {
                batch = true;
                break;
            }
            sawBraces = parser.args[end].includes('{}');
            if (sawBraces) {
                braces++;
                braceArg = parser.args[end];
                if (end === start && inDirectory) {
                    throw new FindUsageError('You may not use {} within the utility name for -execdir and -okdir, because this is a potential security problem.');
                }
            }
        }
        if (end === start || end >= parser.args.length) {
            parser.position = end;
            return MALFORMED;
        }
        if (batch) {
            if (braces > 1)
                throw new FindUsageError(`Only one instance of {} is supported with ${name} ... +`);
            if (braceArg !== '{}')
                throw new FindUsageError(`In '${name} ... {} +' the '{}' must appear by itself, but you specified ${quote(braceArg)}`);
        }
        // A batch's command is its arguments before the {} that ends it.
        const argv = parser.args.slice(start, batch ? end - 1 : end);
        parser.position = end + 1;
        parser.addPrimary(name, { kind: 'exec', argv, batch, inDirectory }, true);
    });
}
/** findutils' check_path_safety: -execdir runs a command found on PATH from the file's own directory. */
function checkPathSafety(action, path) {
    if (path === undefined)
        return;
    for (const entry of path.split(':')) {
        if (entry === '' || entry === '.') {
            throw new FindUsageError(`The current directory is included in the PATH environment variable, which is insecure in combination with the ${action} action of find.  Please remove the current directory from your $PATH (that is, remove ".", doubled colons, or leading or trailing colons)`);
        }
        if (!entry.startsWith('/')) {
            throw new FindUsageError(`The relative path ${quote(entry)} is included in the PATH environment variable, which is insecure in combination with the ${action} action of find.  Please remove that entry from $PATH`);
        }
    }
}
const HELP = `Usage: find [-H] [-L] [-P] [-Olevel] [starting-point...] [expression]

Default path is the current directory; default expression is -print.
Expression may consist of: operators, options, tests, and actions.

Operators (decreasing precedence; -and is implicit where no others are given):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2   EXPR1 , EXPR2

Positional options (always true):
      -daystart -follow -nowarn -warn

Normal options (always true, specified before other expressions):
      -depth -ignore_readdir_race -maxdepth LEVELS -mindepth LEVELS
      -mount -noignore_readdir_race -noleaf -xdev

Tests (N can be +N or -N or N):
      -amin N -anewer FILE -atime N -cmin N -cnewer FILE -ctime N
      -empty -executable -false -gid N -group NAME -ilname PATTERN
      -iname PATTERN -inum N -ipath PATTERN -iwholename PATTERN
      -links N -lname PATTERN -mmin N -mtime N -name PATTERN -newer FILE
      -newerXY REFERENCE -nogroup -nouser -path PATTERN
      -perm [-/]MODE -readable -samefile FILE -size N[bcwkMG] -true
      -type [bcdpfls] -uid N -used N -user NAME -wholename PATTERN
      -writable -xtype [bcdpfls]

Actions:
      -delete -exec COMMAND ; -exec COMMAND {} + -execdir COMMAND ;
      -execdir COMMAND {} + -print -print0 -printf FORMAT -prune -quit

Not supported here: -context -files0-from -fls -fprint -fprint0 -fprintf
      -fstype -iregex -ls -ok -okdir -regex -regextype, and -D
`;
const TABLE = {
    '!': { argClass: 'other', parse: async (parser, name) => { parser.addNot(name); } },
    not: { argClass: 'other', parse: async (parser, name) => { parser.addNot(name); } },
    '(': { argClass: 'other', parse: async (parser, name) => { parser.addOpen(name); } },
    ')': { argClass: 'other', parse: async (parser, name) => { parser.addClose(name); } },
    ',': { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'comma'); } },
    a: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'and'); } },
    and: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'and'); } },
    o: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'or'); } },
    or: { argClass: 'other', parse: async (parser, name) => { parser.addBinary(name, 'or'); } },
    d: option((parser) => {
        parser.warn('warning: the -d option is deprecated; please use -depth instead, because the latter is a POSIX-compliant feature.');
        visitDepthFirst(parser);
        parser.explicitDepth = true;
    }),
    depth: option((parser) => { visitDepthFirst(parser); parser.explicitDepth = true; }),
    maxdepth: depthLimit((parser, depth) => { parser.maxDepth = depth; }),
    mindepth: depthLimit((parser, depth) => { parser.minDepth = depth; }),
    mount: option((parser) => { parser.sameDevice = true; }),
    xdev: option((parser) => { parser.sameDevice = true; }),
    noleaf: option(() => undefined),
    ignore_readdir_race: option((parser) => { parser.ignoreVanished = true; }),
    noignore_readdir_race: option((parser) => { parser.ignoreVanished = false; }),
    daystart: positional((parser) => parser.daystart()),
    follow: positional((parser) => { parser.symlinks = 'L'; }),
    warn: positional((parser) => { parser.warnings = true; }),
    nowarn: positional((parser) => { parser.warnings = false; }),
    true: noArgument({ kind: 'true' }),
    false: noArgument({ kind: 'false' }),
    empty: noArgument({ kind: 'empty' }),
    nouser: noArgument({ kind: 'nouser' }),
    nogroup: noArgument({ kind: 'nogroup' }),
    readable: access(R_OK),
    writable: access(W_OK),
    executable: access(X_OK),
    name: pattern('name', false, '-wholename'),
    iname: pattern('name', true, '-iwholename'),
    path: pattern('path', false, null),
    wholename: pattern('path', false, null),
    ipath: pattern('path', true, null),
    iwholename: pattern('path', true, null),
    lname: pattern('lname', false, null),
    ilname: pattern('lname', true, null),
    type: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        parser.addPrimary(name, { kind: 'type', types: typeSet(value, '-type'), target: false });
    }),
    xtype: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        parser.addPrimary(name, { kind: 'type', types: typeSet(value, '-xtype'), target: true });
    }),
    size: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        if (value === '')
            throw new FindUsageError('invalid null argument to -size');
        const suffix = value[value.length - 1];
        const unit = SIZE_UNITS[suffix];
        if (unit === undefined && !(suffix >= '0' && suffix <= '9'))
            throw new FindUsageError(`invalid -size type \`${suffix}'`);
        const digits = unit === undefined ? value : value.slice(0, -1);
        const number = parseNumber(digits);
        if (number === null)
            throw new FindUsageError(`Invalid argument \`${digits}${unit === undefined ? '' : suffix}' to -size`);
        parser.addPrimary(name, { kind: 'size', cmp: number.cmp, count: number.value, unit: unit ?? 512 });
    }),
    atime: relativeTime('atime', DAY_SECONDS, true),
    ctime: relativeTime('ctime', DAY_SECONDS, true),
    mtime: relativeTime('mtime', DAY_SECONDS, true),
    amin: relativeTime('atime', 60, false),
    cmin: relativeTime('ctime', 60, false),
    mmin: relativeTime('mtime', 60, false),
    used: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const time = relativeTimestamp(value, 0, DAY_SECONDS, 'days');
        if (time === null)
            throw new FindUsageError(`Invalid argument ${value} to -used`);
        parser.addPrimary(name, { kind: 'used', cmp: time.cmp, reference: time.reference });
    }),
    newer: newer('mtime'),
    anewer: newer('atime'),
    cnewer: newer('ctime'),
    perm: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const match = value[0] === '-' ? 'all' : value[0] === '/' ? 'any' : 'exact';
        const changes = compileMode(match === 'exact' ? value : value.slice(1));
        // +MODE was once -perm /MODE; GNU now refuses the numeric form rather than guess.
        if (changes === null || (value[0] === '+' && value[1] >= '0' && value[1] < '8')) {
            throw new FindUsageError(`invalid mode ${quote(value)}`);
        }
        const file = adjustMode(0, false, 0, changes);
        const directory = adjustMode(0, true, 0, changes);
        if (match === 'any' && file === 0 && directory === 0) {
            parser.environment.warn(`warning: you have specified a mode pattern ${value} (which is equivalent to /000). The meaning of -perm /000 has now been changed to be consistent with -perm -000; that is, while it used to match no files, it now matches all files.`);
            parser.addPrimary(name, { kind: 'perm', match: 'all', file, directory });
            return;
        }
        parser.addPrimary(name, { kind: 'perm', match, file, directory });
    }),
    uid: numeric('uid'),
    gid: numeric('gid'),
    links: numeric('nlink'),
    inum: numeric('ino'),
    user: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const user = await accountOrNull(findUnixUser(parser.environment.vfs, value));
        // getpwnam first, as GNU asks; only a name nobody has may be a uid.
        const uid = user?.name === value ? user.uid : /^\d+$/.test(value) ? Number(value) : undefined;
        if (uid === undefined)
            throw new FindUsageError(`invalid user name or UID argument to -user: ${quote(value)}`);
        parser.addPrimary(name, { kind: 'number', field: 'uid', cmp: 'eq', value: uid });
    }),
    group: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const group = await accountOrNull(findUnixGroup(parser.environment.vfs, value));
        const gid = group?.name === value ? group.gid : /^\d+$/.test(value) ? Number(value) : undefined;
        if (gid === undefined)
            throw new FindUsageError(`invalid group name or GID argument to -group: ${quote(value)}`);
        parser.addPrimary(name, { kind: 'number', field: 'gid', cmp: 'eq', value: gid });
    }),
    samefile: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        const stat = await parser.statReference(value);
        parser.addPrimary(name, { kind: 'samefile', dev: stat.dev, ino: stat.ino });
    }),
    context: test(async (parser) => {
        if (parser.args[parser.position] === undefined)
            return MALFORMED;
        throw new FindUsageError('invalid predicate -context: SELinux is not enabled.');
    }),
    print: noArgument({ kind: 'print', terminator: '\n' }, true),
    print0: noArgument({ kind: 'print', terminator: '\0' }, true),
    printf: test(async (parser, name) => {
        const value = parser.next();
        if (value === undefined)
            return MALFORMED;
        parser.addPrimary(name, { kind: 'printf', format: compileFormat(value, (message) => parser.environment.warn(message)) }, true);
    }),
    prune: noArgument({ kind: 'prune' }),
    quit: noArgument({ kind: 'quit' }),
    delete: test(async (parser, name) => {
        visitDepthFirst(parser);
        parser.addPrimary(name, { kind: 'delete' }, true);
    }),
    exec: exec(false),
    execdir: exec(true),
};
/** -newerXY: X and Y from a, c, m (B, the birth time, is not recorded); Y may be t, a date as touch -d reads one. */
async function parseNewerXY(parser, name) {
    const x = name[6];
    const y = name[7];
    if (x === 'B' || y === 'B') {
        parser.environment.warn('This system does not provide a way to find the birth time of a file.');
        return false;
    }
    const fields = { a: 'atime', c: 'ctime', m: 'mtime' };
    const field = fields[x];
    if (field === undefined || (fields[y] === undefined && y !== 't'))
        return false;
    const reference = parser.next();
    if (reference === undefined)
        throw new FindUsageError(`The ${quote(name)} test needs an argument`);
    if (y === 't') {
        const at = parseDateTime(reference, parser.environment.now);
        if (at === null)
            throw new FindUsageError(`I cannot figure out how to interpret ${quote(reference)} as a date or time`);
        parser.addPrimary(name, { kind: 'newer', field, reference: at });
        return true;
    }
    const stat = await parser.statReference(reference);
    const time = y === 'a' ? stat.atimeMs : y === 'c' ? stat.ctimeMs : stat.mtimeMs;
    parser.addPrimary(name, { kind: 'newer', field, reference: time });
    return true;
}
function precedence(item) {
    return item.type === 'binary' ? PRECEDENCE[item.op] : item.type === 'not' ? PRECEDENCE.not : 0;
}
/** findutils' get_expr / scan_rest over the predicate list. */
class TreeBuilder {
    items;
    index = 0;
    constructor(items) {
        this.items = items;
    }
    get remaining() {
        return this.items[this.index];
    }
    expression(prevPrecedence, prev) {
        const item = this.items[this.index];
        if (item === undefined)
            throw new FindUsageError('invalid expression');
        let result;
        switch (item.type) {
            case 'binary':
                throw new FindUsageError(`invalid expression; you have used a binary operator '${item.name}' with nothing before it.`);
            case 'close':
                if (prev === null)
                    throw new FindUsageError(`invalid expression: expected expression before closing parentheses '${item.name}'.`);
                if ((prev.type === 'not' || prev.type === 'binary') && !item.artificial) {
                    throw new FindUsageError(`expected an expression between '${prev.name}' and ')'`);
                }
                if (item.artificial)
                    throw new FindUsageError(`expected an expression after '${prev.name}'`);
                throw new FindUsageError("invalid expression; you have too many ')'");
            case 'primary':
                this.index++;
                result = { kind: 'primary', primary: item.primary };
                break;
            case 'not':
                this.index++;
                result = { kind: 'not', operand: this.expression(PRECEDENCE.not, item) };
                break;
            case 'open': {
                const following = this.items[this.index + 1];
                if (following === undefined || (following.type === 'close' && following.artificial)) {
                    throw new FindUsageError(`invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '${item.name}'`);
                }
                this.index++;
                if (following.type === 'close') {
                    if (item.artificial)
                        throw new FindUsageError(`invalid expression: expected expression before closing parentheses '${following.name}'.`);
                    throw new FindUsageError('invalid expression; empty parentheses are not allowed.');
                }
                result = this.expression(0, item);
                const close = this.items[this.index];
                if (close === undefined || close.type !== 'close') {
                    throw new FindUsageError("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
                }
                this.index++;
                break;
            }
        }
        const next = this.items[this.index];
        if (next !== undefined && precedence(next) > prevPrecedence)
            return this.continueWith(result, prevPrecedence);
        return result;
    }
    /** findutils' scan_rest: fold every following operator that binds tighter than the caller's. */
    continueWith(head, prevPrecedence) {
        let tree = head;
        for (let item = this.items[this.index]; item !== undefined && precedence(item) > prevPrecedence; item = this.items[this.index]) {
            if (item.type !== 'binary')
                throw new FindUsageError('invalid expression');
            this.index++;
            tree = { kind: item.op, left: tree, right: this.expression(PRECEDENCE[item.op], item) };
        }
        return tree;
    }
}
/** Whether any predicate in the list is an action, which turns off the default -print. */
function hasAction(items) {
    return items.some((item) => item.type === 'primary' && item.action);
}
/**
 * findutils' process_optimisation_option. The level decides which tests
 * promoteCheapTests moves. From level 2 GNU also reorders by estimated cost,
 * which decides which files it reports it cannot read; this find does not,
 * so it refuses those levels rather than answer as level 1 would.
 */
function optimisationLevel(level) {
    if (level === '')
        throw new FindUsageError('The -O option must be immediately followed by a decimal integer');
    if (!(level[0] >= '0' && level[0] <= '9'))
        throw new FindUsageError('Please specify a decimal number immediately after -O');
    if (!/^\d+$/.test(level))
        throw new FindUsageError(`Invalid optimisation level ${level}`);
    const value = BigInt(level);
    if (value > 0xffffffffffffffffn)
        throw new FindUsageError(`Invalid optimisation level ${level}: Numerical result out of range`);
    if (value > 65535n) {
        throw new FindUsageError(`Optimisation level ${value} is too high.  If you want to find files very quickly, consider using GNU locate.`);
    }
    if (value > 1n)
        throw new FindUsageError(`optimisation level ${value} is not supported here; use -O0 or -O1`);
    return Number(value);
}
/** Whether evaluating the expression can do anything but answer (findutils' side_effects). */
function hasSideEffects(expression) {
    switch (expression.kind) {
        case 'and':
        case 'or':
        case 'comma': return hasSideEffects(expression.left) || hasSideEffects(expression.right);
        case 'not': return hasSideEffects(expression.operand);
        case 'primary': {
            const kind = expression.primary.kind;
            return kind === 'print' || kind === 'printf' || kind === 'exec' || kind === 'delete' || kind === 'prune' || kind === 'quit';
        }
    }
}
/** Tests that read nothing, and so cannot fail (findutils' predicate_is_cost_free). */
function costFree(expression, level) {
    if (expression.kind !== 'primary')
        return false;
    const kind = expression.primary.kind;
    return kind === 'name' || kind === 'path' || (level > 0 && (kind === 'true' || kind === 'false'));
}
/**
 * findutils' opt_expr, as far as it shows: in each run of -a (or of -o),
 * between the parts that do something, the tests that read nothing are
 * moved ahead of the rest. `-empty -name x` never reads a directory whose
 * name is not x, so it never reports one it cannot read.
 */
function promoteCheapTests(expression, level) {
    switch (expression.kind) {
        case 'primary': return expression;
        case 'not': return { kind: 'not', operand: promoteCheapTests(expression.operand, level) };
        // A comma's operands are never reordered.
        case 'comma': return { kind: 'comma', left: promoteCheapTests(expression.left, level), right: promoteCheapTests(expression.right, level) };
        case 'and':
        case 'or': {
            const op = expression.kind;
            const run = [];
            let at = expression;
            while (at.kind === op) {
                run.unshift(at.right);
                at = at.left;
            }
            run.unshift(at);
            const ordered = [];
            let cheap = [];
            let rest = [];
            for (const part of run.map((item) => promoteCheapTests(item, level))) {
                if (hasSideEffects(part)) {
                    ordered.push(...cheap, ...rest, part);
                    cheap = [];
                    rest = [];
                }
                else if (costFree(part, level)) {
                    cheap.push(part);
                }
                else {
                    rest.push(part);
                }
            }
            ordered.push(...cheap, ...rest);
            return ordered.reduce((left, right) => ({ kind: op, left, right }));
        }
    }
}
/** Parse find's arguments into what to walk and what to evaluate at each file. */
export async function parseFindCommand(args, environment) {
    let symlinks = 'P';
    let level = 1;
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-H' || arg === '-L' || arg === '-P')
            symlinks = arg === '-H' ? 'H' : arg === '-L' ? 'L' : 'P';
        else if (arg === '--') {
            i++;
            break;
        }
        else if (arg === '-D') {
            if (i + 1 >= args.length)
                throw new FindUsageError('Missing argument after the -D option.', ["Try 'find --help' for more information."]);
            throw new FindUsageError('the -D debug option is not supported here');
        }
        else if (arg.startsWith('-O'))
            level = optimisationLevel(arg.slice(2));
        else
            break;
    }
    const startIndex = i;
    while (i < args.length && !looksLikeExpression(args[i], true))
        i++;
    const parser = new Parser(args, i, args.slice(startIndex, i), environment);
    parser.symlinks = symlinks;
    while (parser.position < args.length) {
        const arg = args[parser.position];
        if (!looksLikeExpression(arg, false)) {
            const exists = await environment.vfs.exists(resolve(environment.cwd, arg)).catch((error) => {
                if (isVfsError(error))
                    return false;
                throw error;
            });
            const last = parser.items[parser.items.length - 1];
            throw new FindUsageError(`paths must precede expression: \`${arg}'`, exists ? [`find: possible unquoted pattern after predicate \`${last.name}'?`] : []);
        }
        if (arg.length === 8 && arg.startsWith('-newer')) {
            parser.noteClass(arg, 'other');
            parser.position++;
            if (!(await parseNewerXY(parser, arg)))
                throw new FindUsageError(`invalid predicate \`${arg}'`);
            continue;
        }
        const key = arg.startsWith('-') ? arg.slice(1) : arg;
        if (key === 'help' || key === '-help')
            return { kind: 'info', text: HELP };
        if (key === 'version' || key === '-version')
            return { kind: 'info', text: `find (nimbus findutils) ${environment.version}\n` };
        if (Object.hasOwn(NOT_IMPLEMENTED, key))
            throw new FindUsageError(`invalid predicate \`${arg}': ${NOT_IMPLEMENTED[key]}`);
        if (!Object.hasOwn(TABLE, key))
            throw new FindUsageError(`unknown predicate \`${arg}'`);
        const entry = TABLE[key];
        parser.noteClass(arg, entry.argClass);
        parser.position++;
        if ((await entry.parse(parser, arg)) === MALFORMED) {
            const at = args[parser.position];
            throw new FindUsageError(at === undefined ? `missing argument to \`${arg}'` : `invalid argument \`${at}' to \`${arg}'`);
        }
    }
    const userItems = parser.items.slice(1);
    let items;
    if (userItems.length === 0) {
        items = [{ type: 'primary', name: '-print', primary: { kind: 'print', terminator: '\n' }, action: true }];
    }
    else if (hasAction(userItems)) {
        items = userItems;
    }
    else {
        // `( expression ) -print`, joined by the -a GNU inserts after any `)`.
        items = [
            ...parser.items,
            { type: 'close', name: ')', artificial: true },
            { type: 'binary', name: '-a', op: 'and' },
            { type: 'primary', name: '-print', primary: { kind: 'print', terminator: '\n' }, action: true },
        ];
    }
    const prunes = items.some((item) => item.type === 'primary' && item.primary.kind === 'prune');
    const deletes = items.some((item) => item.type === 'primary' && item.primary.kind === 'delete');
    if (prunes && deletes && !parser.explicitDepth) {
        throw new FindUsageError('The -delete action automatically turns on -depth, but -prune does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly use the -depth option.');
    }
    const builder = new TreeBuilder(items);
    const expression = builder.expression(0, null);
    const leftover = builder.remaining;
    if (leftover !== undefined) {
        if (leftover.type === 'close')
            throw new FindUsageError("you have too many ')'");
        throw new FindUsageError(`unexpected extra predicate '${leftover.name}'`);
    }
    return parser.plan(promoteCheapTests(expression, level));
}
