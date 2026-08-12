/**
 * Strict getopt-shaped option parsing, shared by the substrate commands and
 * the `unix-commands` implementations that override them.
 *
 * The contract that matters: an option this command does not implement is an
 * ERROR, never a silently dropped argument. Dropping it produces confidently
 * wrong output — `stat -c '%s'` used to treat the format string as a filename
 * — and a caller cannot tell that apart from the command having worked.
 *
 * Diagnostics match GNU getopt verbatim so the text a caller matches against a
 * real tool keeps matching here:
 *
 *   prog: unrecognized option '--bogus'
 *   prog: invalid option -- 'Q'
 *   prog: option '--format' requires an argument
 *   prog: option requires an argument -- 'c'
 */

export interface ArgSpec {
  [long: string]: {
    type: 'boolean' | 'string';
    /** Short aliases, one character each: `'r'`, or `'rR'` for `rm -r`/`-R`. */
    short?: string;
  };
}

export interface ParseOptions {
  /**
   * Long flag set by the obsolete bare-number form (`tail -5`, `strings -8`).
   * Only the commands GNU gives that form declare it; elsewhere `-5` stays an
   * invalid option, which is what GNU does.
   */
  numericShorthand?: string;
  /**
   * Collect unknown options into `unknown` instead of refusing. For `npm`,
   * which warns (`Unknown cli config "--x"`) and carries on rather than
   * failing — the caller must still surface them, never drop them.
   */
  tolerateUnknown?: boolean;
  /**
   * Accept `--flag=false` for boolean options. npm's config layer takes a
   * value for every key; GNU getopt refuses one on a boolean, so this is
   * opt-in per command rather than the default.
   */
  booleanValues?: boolean;
}

export type ParsedArgs =
  | {
      ok: true;
      flags: Record<string, string | boolean>;
      positional: string[];
      /** Non-empty only under `tolerateUnknown`; the caller must report these. */
      unknown: string[];
    }
  | { ok: false; error: string };

/** GNU prints a `Try ...` pointer under the diagnostic; keep that shape. */
function fail(name: string, message: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `${name}: ${message}\nTry '${name} --help' for more information.\n`,
  };
}

export function parseArgs(
  name: string,
  args: string[],
  spec: ArgSpec,
  options: ParseOptions = {},
): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const unknown: string[] = [];

  const shortMap: Record<string, string> = {};
  for (const [long, def] of Object.entries(spec)) {
    for (const ch of def.short ?? '') shortMap[ch] = long;
    flags[long] = def.type === 'boolean' ? false : '';
  }

  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // A bare `-` is stdin, a positional everywhere GNU accepts it.
    if (stopFlags || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      stopFlags = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      const long = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      const def = spec[long];
      if (!def) {
        if (!options.tolerateUnknown) {
          return fail(name, `unrecognized option '${arg}'`);
        }
        unknown.push(arg);
        continue;
      }

      if (eqIdx !== -1) {
        const value = arg.slice(eqIdx + 1);
        if (def.type === 'boolean') {
          if (!options.booleanValues) {
            return fail(name, `option '--${long}' doesn't allow an argument`);
          }
          flags[long] = value !== 'false';
          continue;
        }
        flags[long] = value;
        continue;
      }

      if (def.type === 'string') {
        const value = args[++i];
        if (value === undefined) {
          return fail(name, `option '--${long}' requires an argument`);
        }
        flags[long] = value;
      } else {
        flags[long] = true;
      }
      continue;
    }

    const cluster = arg.slice(1);

    if (options.numericShorthand && /^\d+$/.test(cluster)) {
      flags[options.numericShorthand] = cluster;
      continue;
    }

    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      const long = shortMap[ch];
      if (!long) {
        if (!options.tolerateUnknown) {
          return fail(name, `invalid option -- '${ch}'`);
        }
        unknown.push(`-${ch}`);
        continue;
      }

      if (spec[long].type === 'string') {
        // GNU takes the rest of the cluster as the value, else the next argv.
        const rest = cluster.slice(j + 1);
        if (rest) {
          flags[long] = rest;
        } else {
          const value = args[++i];
          if (value === undefined) {
            return fail(name, `option requires an argument -- '${ch}'`);
          }
          flags[long] = value;
        }
        break;
      }
      flags[long] = true;
    }
  }

  return { ok: true, flags, positional, unknown };
}
