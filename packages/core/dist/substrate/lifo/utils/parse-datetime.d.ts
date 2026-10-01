/**
 * gnulib's parse_datetime, the date grammar GNU's touch -d and find's
 * -newerXt share, in the session's zone (UTC).
 */
/** Whether y-m-d (1-based month) is a real calendar day. */
export declare function realDay(y: number, mo: number, d: number): boolean;
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
export declare function parseDateTime(text: string, now: number): number | null;
//# sourceMappingURL=parse-datetime.d.ts.map