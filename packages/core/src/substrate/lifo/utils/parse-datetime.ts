/**
 * gnulib's parse_datetime, the date grammar GNU's touch -d and find's
 * -newerXt share, in the session's zone (UTC).
 */

/** Whether y-m-d (1-based month) is a real calendar day. */
export function realDay(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const UNITS: Record<string, [kind: 'month' | 'ms', size: number]> = {
  year: ['month', 12], month: ['month', 1], fortnight: ['ms', 14 * 86_400_000], week: ['ms', 7 * 86_400_000],
  day: ['ms', 86_400_000], hour: ['ms', 3_600_000], minute: ['ms', 60_000], min: ['ms', 60_000],
  second: ['ms', 1000], sec: ['ms', 1000],
};
const monthNumber = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.findIndex((m) => w === m || (w.length >= 3 && m.startsWith(w.slice(0, 3)) && `${m}${['uary', 'ruary', 'ch', 'il', '', 'e', 'y', 'ust', 'tember', 'ober', 'ember', 'ember'][MONTHS.indexOf(m)]}`.startsWith(w)));
  return i < 0 ? null : i + 1;
};
const weekdayNumber = (word: string) => {
  const w = word.toLowerCase().replace(/[.,]$/, '');
  const i = WEEKDAYS.findIndex((d) => w.startsWith(d) && `${d}${['day', 'day', 'sday', 'nesday', 'rsday', 'day', 'urday'][WEEKDAYS.indexOf(d)]}`.startsWith(w));
  return i < 0 ? null : i;
};
const relativeUnit = (word: string) => {
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
export function parseDateTime(text: string, now: number): number | null {
  const value = text.trim();
  const epoch = /^@(-?\d+)(?:\.(\d+))?$/.exec(value);
  // GNU keeps the fraction at nanoseconds; the VFS keeps milliseconds.
  if (epoch) return Number(epoch[1]) * 1000 + (epoch[2] ? Math.floor(Number(`0.${epoch[2]}`) * 1000) : 0);
  const base = new Date(now);
  let date: { y: number; mo: number; d: number } | null = null;
  let time: { h: number; mi: number; s: number; ms: number } | null = null;
  let zoneMinutes: number | null = null;
  let weekday: { day: number; ordinal: number } | null = null;
  let months = 0;
  let ms = 0;
  const tokens = value.toLowerCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  const ordinalWord = (w: string) => (w === 'last' ? -1 : w === 'this' ? 0 : w === 'next' ? 1 : null);
  const setDate = (y: number, mo: number, d: number) => {
    if (date || !realDay(y, mo, d)) return false;
    date = { y, mo, d };
    return true;
  };
  const setTime = (h: number, mi: number, s: number, frac: string | undefined, meridian: string | undefined) => {
    if (time) return false;
    if (meridian) {
      if (h < 1 || h > 12) return false;
      h = (h % 12) + (meridian === 'pm' ? 12 : 0);
    }
    if (h > 23 || mi > 59 || s > 60) return false;
    time = { h, mi, s, ms: frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0 };
    return true;
  };
  const setZone = (word: string) => {
    if (zoneMinutes !== null) return false;
    if (word === 'z' || word === 'utc' || word === 'gmt' || word === 'ut') { zoneMinutes = 0; return true; }
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(word);
    if (!m) return false;
    zoneMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    return true;
  };
  const relative = (count: number, unit: [kind: 'month' | 'ms', size: number]) => {
    if (unit[0] === 'month') months += count * unit[1];
    else ms += count * unit[1];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    let m: RegExpExecArray | null;
    if (t === 'now' || t === 'today') continue;
    if (t === 'yesterday') { ms -= 86_400_000; continue; }
    if (t === 'tomorrow') { ms += 86_400_000; continue; }
    if (t === 'ago') return null;
    // An ISO date and time joined by T, with an optional zone on the end.
    if ((m = /^(\d{4})-(\d{2})-(\d{2})t(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(z|[+-]\d{2}:?\d{2})?$/.exec(t))) {
      if (!setDate(+m[1], +m[2], +m[3]) || !setTime(+m[4], +m[5], +(m[6] ?? 0), m[7], undefined)) return null;
      if (m[8] && !setZone(m[8])) return null;
      continue;
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { if (!setDate(+m[1], +m[2], +m[3])) return null; continue; }
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) { if (!setDate(+m[1], +m[2], +m[3])) return null; continue; }
    if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t))) {
      const y = m[3] === undefined ? base.getUTCFullYear() : m[3].length === 2 ? (+m[3] >= 69 ? 1900 : 2000) + +m[3] : +m[3];
      if (!setDate(y, +m[1], +m[2])) return null;
      continue;
    }
    // A time, with its meridian as the next word or joined to it, and a zone after it.
    if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(am|pm)?(z|[+-]\d{2}:?\d{2})?$/.exec(t))) {
      let meridian = m[5];
      if (!meridian && (next === 'am' || next === 'pm')) { meridian = next; i++; }
      if (!setTime(+m[1], +m[2], +(m[3] ?? 0), m[4], meridian)) return null;
      if (m[6] && !setZone(m[6])) return null;
      continue;
    }
    if (setZone(t)) continue;
    // A month name, with a day and maybe a year around it.
    const month = monthNumber(t);
    if (month !== null) {
      const before = tokens[i - 1];
      let day: number | null = null;
      if (next && /^\d{1,2}$/.test(next)) { day = +next; i++; }
      else if (before && /^\d{1,2}$/.test(before) && date === null && !time) day = +before;
      if (day === null) return null;
      let year = base.getUTCFullYear();
      if (tokens[i + 1] && /^\d{4}$/.test(tokens[i + 1])) { year = +tokens[i + 1]; i++; }
      if (!setDate(year, month, day)) return null;
      continue;
    }
    // A day of the month before its month name ("1 Jan 2020") is read with the month.
    if (/^\d{1,2}$/.test(t) && next && monthNumber(next) !== null) continue;
    // A year after date(1)'s "Wed Jan  1 10:00:00 UTC 2020".
    if (/^\d{4}$/.test(t) && date !== null && time !== null) {
      const d: { y: number; mo: number; d: number } = date;
      if (!realDay(+t, d.mo, d.d)) return null;
      date = { ...d, y: +t };
      continue;
    }
    const ordinal = ordinalWord(t);
    if (ordinal !== null && next) {
      const day = weekdayNumber(next);
      if (day !== null) { if (weekday) return null; weekday = { day, ordinal }; i++; continue; }
      const unit = relativeUnit(next);
      if (unit) { relative(ordinal, unit); i++; continue; }
      return null;
    }
    const day = weekdayNumber(t);
    if (day !== null) {
      // A day beside a date ("Wed, 01 Jan 2020") only names it; alone it moves to that day.
      if (!weekday) weekday = { day, ordinal: 0 };
      continue;
    }
    // [+-]N unit[s] [ago], or a unit alone ([ago]) meaning one.
    const nextUnit = next ? relativeUnit(next) : null;
    if ((m = /^([+-]?\d+)$/.exec(t)) && nextUnit) {
      let count = +m[1];
      i++;
      if (tokens[i + 1] === 'ago') { count = -count; i++; }
      relative(count, nextUnit);
      continue;
    }
    const unit = relativeUnit(t);
    if (unit) {
      let count = 1;
      if (next === 'ago') { count = -1; i++; }
      relative(count, unit);
      continue;
    }
    return null;
  }
  // Compose: the named date (or today), the named time (or now's, or midnight
  // when a date or a day was named), in the named zone; then the weekday; then
  // the relative items, months by the calendar.
  const d: { y: number; mo: number; d: number } = date ?? { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate() };
  const t: { h: number; mi: number; s: number; ms: number } = time
    ?? (date || weekday ? { h: 0, mi: 0, s: 0, ms: 0 } : { h: base.getUTCHours(), mi: base.getUTCMinutes(), s: base.getUTCSeconds(), ms: base.getUTCMilliseconds() });
  let dayOfMonth = d.d;
  if (weekday && !date) {
    const w: { day: number; ordinal: number } = weekday;
    const today = new Date(Date.UTC(d.y, d.mo - 1, d.d)).getUTCDay();
    // parse_datetime: forward to that day, then whole weeks by the ordinal (today counts as "this").
    dayOfMonth += ((w.day - today + 7) % 7) + 7 * (w.ordinal - (w.ordinal > 0 && today !== w.day ? 1 : 0));
  }
  const at = Date.UTC(d.y, d.mo - 1 + months, dayOfMonth, t.h, t.mi, t.s, t.ms) - (zoneMinutes ?? 0) * 60_000;
  return at + ms;
}
