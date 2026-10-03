import type { Command } from '../types.js';
import { inputChunks, isBrokenPipe, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';

// GNU cat (coreutils 9.7) on bytes: -A -b -e -E -n -s -t -T -u -v. Without
// options the bytes pass through untouched, chunk by chunk.

const command: Command = async (ctx) => {
  let number = false, numberNonblank = false, squeeze = false, ends = false, tabs = false, visible = false;
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`cat: ${message}\nTry 'cat --help' for more information.\n`);
    return 1;
  };
  const LONG: Record<string, string> = {
    'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's',
    'show-tabs': 'T', 'show-nonprinting': 'v',
  };
  const apply = (flag: string): boolean => {
    switch (flag) {
      case 'A': visible = ends = tabs = true; return true;
      case 'b': numberNonblank = number = true; return true;
      case 'e': visible = ends = true; return true;
      case 'E': ends = true; return true;
      case 'n': number = true; return true;
      case 's': squeeze = true; return true;
      case 't': visible = tabs = true; return true;
      case 'T': tabs = true; return true;
      case 'u': return true;
      case 'v': visible = true; return true;
      default: return false;
    }
  };
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '--') { files.push(...ctx.args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const flag = LONG[arg.slice(2)];
      if (flag === undefined || !apply(flag)) return usage(`unrecognized option '${arg}'`);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    for (const flag of arg.slice(1)) if (!apply(flag)) return usage(`invalid option -- '${flag}'`);
  }
  const plain = !number && !squeeze && !ends && !tabs && !visible;

  // Line state carries across chunks and files, as GNU's does.
  let line = 0;
  let atLineStart = true;
  let blankRun = 0;
  let heldCr = false;
  const render = (chunk: Uint8Array): Uint8Array => {
    const out: number[] = [];
    const push = (text: string) => { for (let k = 0; k < text.length; k++) out.push(text.charCodeAt(k)); };
    if (heldCr) {
      heldCr = false;
      if (chunk.length > 0 && chunk[0] === 0x0a) push('^M'); else out.push(0x0d);
    }
    for (let k = 0; k < chunk.length; k++) {
      const b = chunk[k];
      if (atLineStart) {
        if (b === 0x0a) {
          blankRun++;
          if (squeeze && blankRun > 1) continue;
        } else blankRun = 0;
        if (number && !(numberNonblank && b === 0x0a)) push(`${String(++line).padStart(6)}\t`);
        atLineStart = false;
      }
      if (b === 0x0a) {
        if (ends) out.push(0x24);
        out.push(0x0a);
        atLineStart = true;
        continue;
      }
      if (b === 0x09) {
        if (tabs) push('^I'); else out.push(b);
        continue;
      }
      // With -E a carriage return ending a line shows as ^M (GNU).
      if (b === 0x0d && ends && !visible) {
        // A carriage return ending a line shows as ^M; one at a chunk's end waits for the next byte.
        if (k + 1 === chunk.length) { heldCr = true; continue; }
        if (chunk[k + 1] === 0x0a) { push('^M'); continue; }
      }
      if (!visible) { out.push(b); continue; }
      let c = b;
      if (c >= 0x80) { push('M-'); c -= 0x80; }
      if (c < 0x20) push(`^${String.fromCharCode(c + 0x40)}`);
      else if (c === 0x7f) push('^?');
      else out.push(c);
    }
    return Uint8Array.from(out);
  };

  // Into a pipe, the reader ends the copy by closing it (SIGPIPE), so an
  // endless device streams; into anything else nothing could end it.
  const slice = ctx.isFdPipe?.(1) === true;
  let status = 0;
  for (const file of files.length > 0 ? files : ['-']) {
    try {
      for await (const chunk of inputChunks(ctx, file, { slice })) await writeBytes(ctx.stdout, plain ? chunk : render(chunk));
    } catch (error) {
      if (isBrokenPipe(error)) throw error;
      await ctx.stderr.write(`cat: ${file}: ${strerror(error)}\n`);
      status = 1;
    }
  }
  if (heldCr) await writeBytes(ctx.stdout, Uint8Array.of(0x0d));
  return status;
};

export default command;
