import type { Command } from '../types.js';
import { waitForAbortOrTimeout } from '../signal.js';

const command: Command = async (ctx) => {
  let count = 4;
  let host: string | undefined;

  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') {
      const value = args[++i];
      const parsed = parseInt(value ?? '', 10);
      // A bad count used to fall back to 4 without a word.
      if (isNaN(parsed) || parsed < 1) {
        ctx.stderr.write(`ping: bad number of packets to transmit: ${value ?? ''}\n`);
        return 1;
      }
      count = parsed;
    } else if (arg.startsWith('-') && arg !== '-') {
      ctx.stderr.write(
        arg.startsWith('--')
          ? `ping: unrecognized option '${arg}'\n`
          : `ping: invalid option -- '${arg[1]}'\n`,
      );
      ctx.stderr.write('Usage: ping [-c count] host\n');
      return 1;
    } else {
      host = arg;
    }
  }

  if (!host) {
    ctx.stderr.write('ping: missing host\n');
    ctx.stderr.write('Usage: ping [-c count] host\n');
    return 1;
  }

  // Build URL for HEAD request
  let url = host;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  ctx.stdout.write(`PING ${host}: ${count} requests\n`);

  const times: number[] = [];
  let failures = 0;

  for (let i = 0; i < count; i++) {
    if (ctx.signal.aborted) break;

    const start = performance.now();
    try {
      await fetch(url, { method: 'HEAD', signal: ctx.signal });
      const elapsed = performance.now() - start;
      times.push(elapsed);
      ctx.stdout.write(`Response from ${host}: time=${elapsed.toFixed(1)}ms\n`);
    } catch {
      const elapsed = performance.now() - start;
      if (ctx.signal.aborted) break;
      failures++;
      ctx.stdout.write(`Request to ${host}: timeout (${elapsed.toFixed(1)}ms)\n`);
    }

    if (i < count - 1 && !ctx.signal.aborted) {
      await waitForAbortOrTimeout(ctx.signal, 1_000);
    }
  }

  // Statistics
  const total = times.length + failures;
  const loss = total > 0 ? ((failures / total) * 100).toFixed(0) : '0';

  ctx.stdout.write(`\n--- ${host} ping statistics ---\n`);
  ctx.stdout.write(`${total} packets transmitted, ${times.length} received, ${loss}% packet loss\n`);

  if (times.length > 0) {
    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    ctx.stdout.write(`rtt min/avg/max = ${min.toFixed(1)}/${avg.toFixed(1)}/${max.toFixed(1)} ms\n`);
  }

  return failures === total ? 1 : 0;
};

export default command;
