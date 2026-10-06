export interface ArgSpec {
  [key: string]: {
    type: 'boolean' | 'string';
    short?: string;
  };
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
  /**
   * Options the spec does not declare, in the spelling the caller used —
   * `-z` for a short inside a cluster, `--zap` for a long. Commands that
   * reject unknown options the way GNU does read this; the rest ignore it.
   */
  unknown: string[];
}

export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const unknown: string[] = [];

  // Build short -> long map
  const shortMap: Record<string, string> = {};
  for (const [long, def] of Object.entries(spec)) {
    if (def.short) shortMap[def.short] = long;
    flags[long] = def.type === 'boolean' ? false : '';
  }

  let stopFlags = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (stopFlags || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      stopFlags = true;
      continue;
    }

    // --long or --long=value
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const name = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        if (name in spec) {
          flags[name] = spec[name].type === 'boolean' ? true : value;
        } else {
          unknown.push(`--${name}`);
        }
      } else {
        const name = arg.slice(2);
        if (name in spec) {
          if (spec[name].type === 'string') {
            flags[name] = args[++i] ?? '';
          } else {
            flags[name] = true;
          }
        } else {
          unknown.push(arg);
        }
      }
      continue;
    }

    // Short flags: -abc combined
    const chars = arg.slice(1);
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      const longName = shortMap[ch];
      if (!longName) { unknown.push(`-${ch}`); continue; }
      if (spec[longName].type === 'string') {
        // Rest of chars or next arg is value
        const rest = chars.slice(j + 1);
        flags[longName] = rest || (args[++i] ?? '');
        break;
      } else {
        flags[longName] = true;
      }
    }
  }

  return { flags, positional, unknown };
}

/** How a GNU long option takes its argument. */
export type LongArgument = 'none' | 'required' | 'optional';

/**
 * A command's options as GNU getopt_long reads them: `short` is the
 * optstring (a letter, `:` after one that takes an argument); `long` maps
 * each long name to the key its events carry (a short letter it aliases, or
 * a name of its own) and how it takes an argument.
 */
export interface GetoptSpec {
  readonly short: string;
  readonly long: Readonly<Record<string, readonly [key: string, argument: LongArgument]>>;
}

/** One step of the scan: an option (by key, with its argument), an operand, or GNU's diagnostic for a bad option. */
export type GetoptEvent =
  | { readonly kind: 'option'; readonly key: string; readonly value?: string }
  | { readonly kind: 'operand'; readonly value: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `args` scanned as GNU getopt_long scans them, permuting: options and
 * operands may interleave, `--` ends the options, `-` is an operand. A
 * cluster (`-cz`) is its letters; a letter that takes an argument takes the
 * rest of its word or the next word (`-k2`, `-k 2`). A long option is its
 * name or an unambiguous prefix of one (`--coun`), its argument after `=`
 * or, when required, the next word. The diagnostics are getopt's own text,
 * which the command prefixes with its name; the scan ends at one.
 */
export function* getopt(args: readonly string[], spec: GetoptSpec): Generator<GetoptEvent> {
  const takesArgument = (letter: string) => spec.short[spec.short.indexOf(letter) + 1] === ':';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      for (const rest of args.slice(i + 1)) yield { kind: 'operand', value: rest };
      return;
    }
    if (!arg.startsWith('-') || arg === '-') { yield { kind: 'operand', value: arg }; continue; }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const written = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const candidates = written in spec.long ? [written] : Object.keys(spec.long).filter((name) => name.startsWith(written));
      // Prefixes that name one option through several aliases are not ambiguous.
      const keys = new Set(candidates.map((name) => spec.long[name][0]));
      if (candidates.length === 0) { yield { kind: 'error', message: `unrecognized option '${arg}'` }; return; }
      if (keys.size > 1) {
        yield { kind: 'error', message: `option '--${written}' is ambiguous; possibilities:${candidates.map((name) => ` '--${name}'`).join('')}` };
        return;
      }
      const name = candidates[0];
      const [key, argument] = spec.long[name];
      if (argument === 'none' && inline !== undefined) { yield { kind: 'error', message: `option '--${name}' doesn't allow an argument` }; return; }
      if (argument === 'required' && inline === undefined) {
        if (i + 1 >= args.length) { yield { kind: 'error', message: `option '--${name}' requires an argument` }; return; }
        yield { kind: 'option', key, value: args[++i] };
        continue;
      }
      yield inline === undefined ? { kind: 'option', key } : { kind: 'option', key, value: inline };
      continue;
    }

    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (letter === ':' || !spec.short.includes(letter)) { yield { kind: 'error', message: `invalid option -- '${letter}'` }; return; }
      if (!takesArgument(letter)) { yield { kind: 'option', key: letter }; continue; }
      const rest = arg.slice(j + 1);
      if (rest !== '') { yield { kind: 'option', key: letter, value: rest }; break; }
      if (i + 1 >= args.length) { yield { kind: 'error', message: `option requires an argument -- '${letter}'` }; return; }
      yield { kind: 'option', key: letter, value: args[++i] };
      break;
    }
  }
}
