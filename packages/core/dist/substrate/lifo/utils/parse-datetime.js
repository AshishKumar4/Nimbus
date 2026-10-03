/**
 * gnulib's parse_datetime, the date grammar GNU's touch -d and find's
 * -newerXt share, in the session's zone (UTC).
 *
 * Its arithmetic is gnulib's, in exact integers: every number is a time_t,
 * a calendar field is a struct tm int, and a step that overflows either
 * refuses the date, as gnulib's checked arithmetic does.
 */
const TIME_T_MIN = -(2n ** 63n);
const TIME_T_MAX = 2n ** 63n - 1n;
const INT_MIN = -(2n ** 31n);
const INT_MAX = 2n ** 31n - 1n;
const BILLION = 1000000000n;
const DAY_SECONDS = 86400n;
/** A time_t, or null where gnulib's checked arithmetic overflows. */
function timeT(value) {
    return value >= TIME_T_MIN && value <= TIME_T_MAX ? value : null;
}
/** A struct tm field, or null where it would not fit an int. */
function tmInt(value) {
    return value >= INT_MIN && value <= INT_MAX ? value : null;
}
/** Days from 1970-01-01 to the proleptic Gregorian y-m-d (m 1-12): Hinnant's days_from_civil. */
function daysFromCivil(year, month, day) {
    const y = month <= 2n ? year - 1n : year;
    const era = (y >= 0n ? y : y - 399n) / 400n;
    const yearOfEra = y - era * 400n;
    const dayOfYear = (153n * ((month + 9n) % 12n) + 2n) / 5n + day - 1n;
    return era * 146097n + yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear - 719468n;
}
/** The proleptic Gregorian year a day counted from the epoch falls in: Hinnant's civil_from_days. */
function yearOfDay(days) {
    const z = days + 719468n;
    const era = (z >= 0n ? z : z - 146096n) / 146097n;
    const dayOfEra = z - era * 146097n;
    const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
    const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
    // The era's year starts in March; January and February belong to the next.
    return yearOfEra + era * 400n + ((5n * dayOfYear + 2n) / 153n >= 10n ? 1n : 0n);
}
/**
 * timegm(3) of struct tm fields, normalised as mktime normalises them (a
 * month of 13 is next January, a 32nd day the next month's first): the
 * seconds since the epoch, or null when the result, or its year as a struct
 * tm holds it, does not fit.
 */
function timegm(tm) {
    const yearShift = tm.mon >= 0n ? tm.mon / 12n : -((11n - tm.mon) / 12n);
    const days = daysFromCivil(tm.year + 1900n + yearShift, tm.mon - yearShift * 12n + 1n, 1n) + tm.mday - 1n;
    if (tmInt(yearOfDay(days) - 1900n) === null)
        return null;
    return timeT(days * DAY_SECONDS + tm.hour * 3600n + tm.min * 60n + tm.sec);
}
/** The weekday (0 Sunday) of a day counted from the epoch. */
function weekdayOf(seconds) {
    const days = (seconds >= 0n ? seconds : seconds - DAY_SECONDS + 1n) / DAY_SECONDS;
    return Number((((days + 4n) % 7n) + 7n) % 7n);
}
/**
 * `@<seconds>[.<fraction>]` as gnulib's lexer reads it: a sign, which may be
 * followed by blanks, a time_t, and a fraction after `.` or `,` kept to the
 * nanosecond and truncated toward minus infinity. In milliseconds, floored.
 */
function epochMilliseconds(text) {
    const m = /^@\s*([+-]?)\s*(\d+)(?:[.,](\d+))?$/.exec(text);
    if (m === null)
        return null;
    const negative = m[1] === '-';
    let seconds = timeT(negative ? -BigInt(m[2]) : BigInt(m[2]));
    if (seconds === null)
        return null;
    let ns = 0n;
    if (m[3] !== undefined) {
        ns = BigInt(m[3].slice(0, 9).padEnd(9, '0'));
        if (negative && /[1-9]/.test(m[3].slice(9)))
            ns++;
        if (negative && ns > 0n) {
            seconds = timeT(seconds - 1n);
            if (seconds === null)
                return null;
            ns = BILLION - ns;
        }
    }
    return Number(seconds * 1000n + ns / 1000000n);
}
/** Whether y-m-d (1-based month) is a real day of the proleptic Gregorian calendar, any year. */
export function realDay(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1)
        return false;
    const year = BigInt(y);
    const month = BigInt(mo);
    const next = month === 12n ? daysFromCivil(year + 1n, 1n, 1n) : daysFromCivil(year, month + 1n, 1n);
    return BigInt(d) <= next - daysFromCivil(year, month, 1n);
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** The relative fields added last, in seconds, in gnulib's order. */
const RELATIVE_SECONDS = [['hour', 3600n], ['minutes', 60n], ['seconds', 1n]];
const UNITS = {
    year: ['year', 1n], month: ['month', 1n], fortnight: ['day', 14n], week: ['day', 7n], day: ['day', 1n],
    hour: ['hour', 1n], minute: ['minutes', 1n], min: ['minutes', 1n], second: ['seconds', 1n], sec: ['seconds', 1n],
};
const monthNumber = (word) => {
    const w = word.toLowerCase().replace(/\.$/, '');
    const i = MONTHS.findIndex((m) => w === m || (w.length >= 3 && m.startsWith(w.slice(0, 3)) && `${m}${['uary', 'ruary', 'ch', 'il', '', 'e', 'y', 'ust', 'tember', 'ober', 'ember', 'ember'][MONTHS.indexOf(m)]}`.startsWith(w)));
    return i < 0 ? null : i + 1;
};
const weekdayNumber = (word) => {
    const w = word.toLowerCase().replace(/[.,]$/, '');
    const i = WEEKDAYS.findIndex((d) => w.startsWith(d) && `${d}${['day', 'day', 'sday', 'nesday', 'rsday', 'day', 'urday'][WEEKDAYS.indexOf(d)]}`.startsWith(w));
    return i < 0 ? null : i;
};
const relativeUnit = (word) => {
    const w = word.toLowerCase().replace(/s$/, '');
    return Object.hasOwn(UNITS, w) ? UNITS[w] : null;
};
/**
 * A date as gnulib's parse_datetime reads it (`touch -d`, `find -newermt`),
 * as milliseconds since the epoch, or null where GNU refuses it. Order-free
 * items, as GNU reads them, in the session's zone (UTC) unless one is given:
 * - `@<seconds>[.<fraction>]`, alone;
 * - a date: `YYYY-MM-DD`, `YYYYMMDD`, `M/D[/YYYY]`, `Mon D[,] [YYYY]`,
 *   `D Mon [YYYY]`; with no year, this year;
 * - a time: `HH:MM[:SS[.frac]]` with `am`/`pm`, or joined to an ISO date by
 *   `T`; a zone `Z`, `UTC`, `GMT`, `±HH[:]MM`;
 * - a day of the week (`wed`, `Wednesday,`), alone or with `last`/`this`/`next`;
 * - relative items: `[+-]N unit[s] [ago]`, `unit ago`, `last`/`next unit`,
 *   `now`, `today`, `yesterday`, `tomorrow`.
 * A date or a day sets the time to midnight unless a time is given; relative
 * items move from what the rest names (now, if nothing). An impossible
 * calendar date or time is refused, as GNU refuses it.
 */
export function parseDateTime(text, now) {
    const value = text.trim();
    // GNU keeps the fraction at nanoseconds; the VFS keeps milliseconds.
    if (value.startsWith('@'))
        return epochMilliseconds(value);
    const base = new Date(now);
    let date = null;
    let time = null;
    let zoneMinutes = null;
    let weekday = null;
    const rel = { year: 0n, month: 0n, day: 0n, hour: 0n, minutes: 0n, seconds: 0n };
    let relsSeen = false;
    const tokens = value.toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const ordinalWord = (w) => (w === 'last' ? -1 : w === 'this' ? 0 : w === 'next' ? 1 : null);
    const setDate = (y, mo, d) => {
        if (date || !realDay(y, mo, d))
            return false;
        date = { y, mo, d };
        return true;
    };
    const setTime = (h, mi, s, frac, meridian) => {
        if (time)
            return false;
        if (meridian) {
            if (h < 1 || h > 12)
                return false;
            h = (h % 12) + (meridian === 'pm' ? 12 : 0);
        }
        // A leap second is refused: mktime moves it to the next minute, which gnulib takes as an invalid time.
        if (h > 23 || mi > 59 || s > 59)
            return false;
        time = { h, mi, s, ms: frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0 };
        return true;
    };
    const setZone = (word) => {
        if (zoneMinutes !== null)
            return false;
        if (word === 'z' || word === 'utc' || word === 'gmt' || word === 'ut') {
            zoneMinutes = 0;
            return true;
        }
        const m = /^([+-])(\d{2}):?(\d{2})$/.exec(word);
        if (!m)
            return false;
        const minutes = Number(m[2]) * 60 + Number(m[3]);
        // POSIX's TZ range, as gnulib's time_zone_hhmm allows it.
        if (minutes > 24 * 60)
            return false;
        zoneMinutes = (m[1] === '-' ? -1 : 1) * minutes;
        return true;
    };
    /** gnulib's apply_relative_time: `count` of `unit` added to its field, every step a checked time_t. */
    const relative = (count, unit) => {
        relsSeen = true;
        const sum = timeT(rel[unit[0]] + count * unit[1]);
        if (timeT(count * unit[1]) === null || sum === null)
            return false;
        rel[unit[0]] = sum;
        return true;
    };
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const next = tokens[i + 1];
        let m;
        if (t === 'now' || t === 'today') {
            relsSeen = true;
            continue;
        }
        if (t === 'yesterday' || t === 'tomorrow') {
            if (!relative(t === 'yesterday' ? -1n : 1n, UNITS.day))
                return null;
            continue;
        }
        if (t === 'ago')
            return null;
        // An ISO date and time joined by T, with an optional zone on the end.
        if ((m = /^(\d{4})-(\d{2})-(\d{2})t(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(z|[+-]\d{2}:?\d{2})?$/.exec(t))) {
            if (!setDate(+m[1], +m[2], +m[3]) || !setTime(+m[4], +m[5], +(m[6] ?? 0), m[7], undefined))
                return null;
            if (m[8] && !setZone(m[8]))
                return null;
            continue;
        }
        if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
            if (!setDate(+m[1], +m[2], +m[3]))
                return null;
            continue;
        }
        if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) {
            if (!setDate(+m[1], +m[2], +m[3]))
                return null;
            continue;
        }
        if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t))) {
            const y = m[3] === undefined ? base.getUTCFullYear() : m[3].length === 2 ? (+m[3] >= 69 ? 1900 : 2000) + +m[3] : +m[3];
            if (!setDate(y, +m[1], +m[2]))
                return null;
            continue;
        }
        // A time, with its meridian as the next word or joined to it, and a zone after it.
        if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(am|pm)?(z|[+-]\d{2}:?\d{2})?$/.exec(t))) {
            let meridian = m[5];
            if (!meridian && (next === 'am' || next === 'pm')) {
                meridian = next;
                i++;
            }
            if (!setTime(+m[1], +m[2], +(m[3] ?? 0), m[4], meridian))
                return null;
            if (m[6] && !setZone(m[6]))
                return null;
            continue;
        }
        if (setZone(t))
            continue;
        // A month name, with a day and maybe a year around it.
        const month = monthNumber(t);
        if (month !== null) {
            const before = tokens[i - 1];
            let day = null;
            if (next && /^\d{1,2}$/.test(next)) {
                day = +next;
                i++;
            }
            else if (before && /^\d{1,2}$/.test(before) && date === null && !time)
                day = +before;
            if (day === null)
                return null;
            let year = base.getUTCFullYear();
            if (tokens[i + 1] && /^\d{4}$/.test(tokens[i + 1])) {
                year = +tokens[i + 1];
                i++;
            }
            if (!setDate(year, month, day))
                return null;
            continue;
        }
        // A day of the month before its month name ("1 Jan 2020") is read with the month.
        if (/^\d{1,2}$/.test(t) && next && monthNumber(next) !== null)
            continue;
        // A year after date(1)'s "Wed Jan  1 10:00:00 UTC 2020".
        if (/^\d{4}$/.test(t) && date !== null && time !== null) {
            const d = date;
            if (!realDay(+t, d.mo, d.d))
                return null;
            date = { ...d, y: +t };
            continue;
        }
        const ordinal = ordinalWord(t);
        if (ordinal !== null && next) {
            const day = weekdayNumber(next);
            if (day !== null) {
                if (weekday)
                    return null;
                weekday = { day, ordinal };
                i++;
                continue;
            }
            const unit = relativeUnit(next);
            if (unit) {
                if (!relative(BigInt(ordinal), unit))
                    return null;
                i++;
                continue;
            }
            return null;
        }
        const day = weekdayNumber(t);
        if (day !== null) {
            // A day beside a date ("Wed, 01 Jan 2020") only names it; alone it moves to that day.
            if (!weekday)
                weekday = { day, ordinal: 0 };
            continue;
        }
        // [+-]N unit[s] [ago], or a unit alone ([ago]) meaning one.
        const nextUnit = next ? relativeUnit(next) : null;
        if ((m = /^([+-]?\d+)$/.exec(t)) && nextUnit) {
            // The lexer's number is a time_t; `ago` negates what it names.
            let count = timeT(BigInt(m[1]));
            if (count === null)
                return null;
            i++;
            if (tokens[i + 1] === 'ago') {
                count = -count;
                i++;
            }
            if (!relative(count, nextUnit))
                return null;
            continue;
        }
        const unit = relativeUnit(t);
        if (unit) {
            let count = 1n;
            if (next === 'ago') {
                count = -1n;
                i++;
            }
            if (!relative(count, unit))
                return null;
            continue;
        }
        return null;
    }
    // Compose as parse_datetime does: the named date (or today) at the named
    // time (now's when only relative items were named, else midnight); then the
    // weekday; then the relative years, months and days, by the calendar; then
    // the zone; then the relative hours, minutes and seconds.
    const d = date ?? { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() };
    const t = time
        ?? (relsSeen && !date && !weekday
            ? { h: base.getUTCHours(), mi: base.getUTCMinutes(), s: base.getUTCSeconds(), ms: base.getUTCMilliseconds() }
            : { h: 0, mi: 0, s: 0, ms: 0 });
    const tm = { year: BigInt(d.y) - 1900n, mon: BigInt(d.mo) - 1n, mday: BigInt(d.d), hour: BigInt(t.h), min: BigInt(t.mi), sec: BigInt(t.s) };
    let start = timegm(tm);
    if (start === null)
        return null;
    if (weekday && !date) {
        const w = weekday;
        const today = weekdayOf(start);
        // Forward to that day, then whole weeks by the ordinal (today counts as "this").
        const mday = tmInt(tm.mday + BigInt(((w.day - today + 7) % 7) + 7 * (w.ordinal - (w.ordinal > 0 && today !== w.day ? 1 : 0))));
        if (mday === null)
            return null;
        tm.mday = mday;
        start = timegm(tm);
        if (start === null)
            return null;
    }
    if (rel.year !== 0n || rel.month !== 0n || rel.day !== 0n) {
        const year = tmInt(tm.year + rel.year);
        const mon = tmInt(tm.mon + rel.month);
        const mday = tmInt(tm.mday + rel.day);
        if (year === null || mon === null || mday === null)
            return null;
        start = timegm({ ...tm, year, mon, mday });
        if (start === null)
            return null;
    }
    if (zoneMinutes !== null) {
        start = timeT(start - BigInt(zoneMinutes) * 60n);
        if (start === null)
            return null;
    }
    let at = start;
    for (const [field, size] of RELATIVE_SECONDS) {
        const delta = timeT(rel[field] * size);
        const next = delta === null ? null : timeT(at + delta);
        if (next === null)
            return null;
        at = next;
    }
    return Number(at * 1000n + BigInt(t.ms));
}
