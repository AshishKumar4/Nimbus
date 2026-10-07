/**
 * Command-line options: one scanner (`scanOptions`, getopt_long's grammar)
 * and two policies over it. `getopt` is GNU's: an option it cannot take ends
 * the scan with getopt's own diagnostic. `parseArgs` is the compatibility
 * collector the flag-table commands use: exact long names, unknown options
 * set aside for the command to judge, a missing value read as ''.
 */

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

/**
 * One step of a scan: an option (by key, with its argument) or an operand;
 * or an option the spec cannot take: one it does not have (`option` is `-x`
 * or `--name`, `written` the whole word), an ambiguous prefix, one that needs
 * an argument and is the last word, or a long one given an argument it does
 * not take. The scan goes on after each; a policy decides what it means.
 */
export type ScanEvent =
  | { readonly kind: 'option'; readonly key: string; readonly value?: string }
  | { readonly kind: 'operand'; readonly value: string }
  | { readonly kind: 'unknown'; readonly option: string; readonly written: string }
  | { readonly kind: 'ambiguous'; readonly written: string; readonly candidates: readonly string[] }
  | { readonly kind: 'missing'; readonly key: string; readonly option: string }
  | { readonly kind: 'unwanted'; readonly key: string; readonly option: string; readonly value: string };

/**
 * `args` scanned as GNU getopt_long scans them, permuting: options and
 * operands may interleave, `--` ends the options, `-` is an operand. A
 * cluster (`-cz`) is its letters; a letter that takes an argument takes the
 * rest of its word or the next word (`-k2`, `-k 2`). A long option is its
 * name, or with `abbreviations` an unambiguous prefix of one (`--coun`); its
 * argument follows `=` or, when required, is the next word.
 */
export function* scanOptions(
  args: readonly string[],
  spec: GetoptSpec,
  { abbreviations = true }: { abbreviations?: boolean } = {},
): Generator<ScanEvent> {
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
      const candidates = written in spec.long ? [written]
        : abbreviations ? Object.keys(spec.long).filter((name) => name.startsWith(written)) : [];
      // Prefixes that name one option through several aliases are not ambiguous.
      const keys = new Set(candidates.map((name) => spec.long[name][0]));
      if (candidates.length === 0) { yield { kind: 'unknown', option: `--${written}`, written: arg }; continue; }
      if (keys.size > 1) { yield { kind: 'ambiguous', written, candidates }; continue; }
      const name = candidates[0];
      const [key, argument] = spec.long[name];
      if (argument === 'none' && inline !== undefined) {
        yield { kind: 'unwanted', key, option: `--${name}`, value: inline };
      } else if (argument === 'required' && inline === undefined) {
        yield i + 1 < args.length ? { kind: 'option', key, value: args[++i] } : { kind: 'missing', key, option: `--${name}` };
      } else {
        yield inline === undefined ? { kind: 'option', key } : { kind: 'option', key, value: inline };
      }
      continue;
    }

    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (letter === ':' || !spec.short.includes(letter)) { yield { kind: 'unknown', option: `-${letter}`, written: arg }; continue; }
      if (!takesArgument(letter)) { yield { kind: 'option', key: letter }; continue; }
      const rest = arg.slice(j + 1);
      if (rest !== '') yield { kind: 'option', key: letter, value: rest };
      else yield i + 1 < args.length ? { kind: 'option', key: letter, value: args[++i] } : { kind: 'missing', key: letter, option: `-${letter}` };
      break;
    }
  }
}

/** An option or an operand, or the diagnostic GNU getopt prints for a bad option. */
export type GetoptEvent =
  | { readonly kind: 'option'; readonly key: string; readonly value?: string }
  | { readonly kind: 'operand'; readonly value: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `args` as GNU getopt_long reads them (scanOptions with abbreviations): the
 * scan ends at the first option it cannot take, with getopt's own
 * diagnostic, which the command prefixes with its name.
 */
export function* getopt(args: readonly string[], spec: GetoptSpec): Generator<GetoptEvent> {
  for (const event of scanOptions(args, spec)) {
    switch (event.kind) {
      case 'option':
      case 'operand':
        yield event;
        continue;
      case 'unknown':
        yield { kind: 'error', message: event.option.startsWith('--') ? `unrecognized option '${event.written}'` : `invalid option -- '${event.option.slice(1)}'` };
        return;
      case 'ambiguous':
        yield { kind: 'error', message: `option '--${event.written}' is ambiguous; possibilities:${event.candidates.map((name) => ` '--${name}'`).join('')}` };
        return;
      case 'missing':
        yield { kind: 'error', message: event.option.startsWith('--') ? `option '${event.option}' requires an argument` : `option requires an argument -- '${event.key}'` };
        return;
      case 'unwanted':
        yield { kind: 'error', message: `option '${event.option}' doesn't allow an argument` };
        return;
    }
  }
}

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

/**
 * A flag table's options, collected: scanOptions over the table without
 * abbreviations, every flag present (false, or '' for a string); an
 * undeclared option is set aside in `unknown`, a string option with nothing
 * after it is '', and a boolean given `--name=value` is true.
 */
export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const unknown: string[] = [];
  const nameOf: Record<string, string> = {};
  const getoptSpec: { short: string; long: Record<string, readonly [string, LongArgument]> } = { short: '', long: {} };
  for (const [long, def] of Object.entries(spec)) {
    flags[long] = def.type === 'boolean' ? false : '';
    const key = def.short ?? long;
    nameOf[key] = long;
    if (def.short) getoptSpec.short += def.type === 'string' ? `${def.short}:` : def.short;
    getoptSpec.long[long] = [key, def.type === 'string' ? 'required' : 'none'];
  }

  for (const event of scanOptions(args, getoptSpec, { abbreviations: false })) {
    if (event.kind === 'operand') positional.push(event.value);
    else if (event.kind === 'unknown') unknown.push(event.option);
    else if (event.kind === 'option') {
      const name = nameOf[event.key];
      flags[name] = spec[name].type === 'boolean' ? true : event.value ?? '';
    } else if (event.kind === 'missing') flags[nameOf[event.key]] = '';
    else if (event.kind === 'unwanted') flags[nameOf[event.key]] = true;
  }

  return { flags, positional, unknown };
}
