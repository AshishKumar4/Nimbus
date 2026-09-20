import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import type { Kernel } from '../../kernel/index.js';
import { dispatchWorkspaceRequest, workspaceRequestPort } from './kernel-fetch.js';

const MAX_REDIRECTS = 20;

type WgetOptions = {
  url?: string;
  outputFile?: string;
  quiet: boolean;
};

function parseWgetArgs(args: string[]): WgetOptions {
  const options: WgetOptions = { quiet: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-O':
        options.outputFile = args[++i] ?? '';
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          options.url = arg;
        }
        break;
    }
  }
  return options;
}

type WgetResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
};

function wgetHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function createWgetImpl(kernel?: Kernel): Command {
  return async (ctx) => {
    const options = parseWgetArgs(ctx.args);

    if (!options.url) {
      await ctx.stderr.write('wget: missing URL\n');
      await ctx.stderr.write('Usage: wget [-O file] [-q] url\n');
      return 1;
    }

    let url = options.url;
    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // Determine output filename
    let outputFile = options.outputFile;
    if (!outputFile) {
      try {
        const urlObj = new URL(url);
        const pathSegments = urlObj.pathname.split('/').filter(Boolean);
        outputFile = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : 'index.html';
      } catch {
        outputFile = 'index.html';
      }
    }

    if (!options.quiet) {
      await ctx.stderr.write(`--  ${url}\n`);
      await ctx.stderr.write(`Connecting... `);
    }

    try {
      let response: WgetResponse;
      if (!kernel) {
        // No kernel bound: fetch's own redirect handling stands — the
        // process-wide default keeps its documented behavior.
        const res = await fetch(url, { signal: ctx.signal });
        response = {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: await res.text(),
        };
      } else {
        // Bound to a kernel: every hop is classified first. A loopback hop —
        // including one a redirect lands on — is served by this kernel's port
        // table or its host's loopback router, never by fetch.
        let current = url;
        let hops = 0;
        for (;;) {
          const requestUrl = new URL(current);
          const port = workspaceRequestPort(kernel, requestUrl);
          if (port !== null) {
            const local = await dispatchWorkspaceRequest(
              kernel,
              port,
              new Request(requestUrl, { method: 'GET', signal: ctx.signal }),
            );
            if (local.kind === 'refused') {
              if (!options.quiet) await ctx.stderr.write('failed.\n');
              await ctx.stderr.write(`wget: unable to connect to ${current}\n`);
              return 1;
            }
            if (local.kind === 'aborted') {
              await ctx.stderr.write('wget: request aborted\n');
              return 1;
            }
            if (local.kind === 'timeout') {
              await ctx.stderr.write('wget: request timed out\n');
              return 1;
            }
            const res = local.response;
            response = {
              status: res.status,
              statusText: res.statusText,
              headers: Object.fromEntries(res.headers.entries()),
              body: await res.text(),
            };
          } else {
            const res = await fetch(requestUrl, { redirect: 'manual', signal: ctx.signal });
            response = {
              status: res.status,
              statusText: res.statusText,
              headers: Object.fromEntries(res.headers.entries()),
              body: await res.text(),
            };
          }

          if (!isRedirectStatus(response.status)) break;
          const location = wgetHeader(response.headers, 'location');
          if (!location) break;
          if (++hops > MAX_REDIRECTS) {
            await ctx.stderr.write(`wget: too many redirects\n`);
            return 1;
          }
          try {
            current = new URL(location, requestUrl).toString();
          } catch {
            break;
          }
        }
      }

      if (!options.quiet) {
        await ctx.stderr.write(`connected.\n`);
        await ctx.stderr.write(`HTTP request sent, awaiting response... ${response.status} ${response.statusText}\n`);
      }

      const path = resolve(ctx.cwd, outputFile);
      (await ctx.vfs.writeFile(path, response.body));

      if (!options.quiet) {
        await ctx.stderr.write(`Saving to: '${outputFile}'\n`);
        await ctx.stderr.write(`${response.body.length} bytes saved.\n`);
      }

      return response.status < 400 ? 0 : 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!options.quiet) {
        await ctx.stderr.write(`failed.\n`);
      }
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
        await ctx.stderr.write(`wget: unable to connect to ${url}\n`);
        await ctx.stderr.write(`Note: This may be a CORS restriction. The target server must allow cross-origin requests.\n`);
      } else {
        await ctx.stderr.write(`wget: ${msg}\n`);
      }
      return 1;
    }
  };
}

/**
 * A `wget` bound to one kernel: its loopback traffic resolves through that
 * kernel's port registry and loopback router, so two workspaces serving the
 * same numeric port answer independently.
 */
export function createWgetCommand(kernel: Kernel): Command {
  return createWgetImpl(kernel);
}

// Default command (no kernel -- always uses fetch)
const command: Command = createWgetImpl();

export default command;
