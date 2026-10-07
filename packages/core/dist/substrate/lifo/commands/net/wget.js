import { resolve } from '../../utils/path.js';
import { hopInit, sendHop, walkRedirects } from './kernel-fetch.js';
function parseWgetArgs(args) {
    const options = { quiet: false };
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
function createWgetImpl(kernel) {
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
            }
            catch {
                outputFile = 'index.html';
            }
        }
        if (!options.quiet) {
            await ctx.stderr.write(`--  ${url}\n`);
            await ctx.stderr.write(`Connecting... `);
        }
        try {
            // Every hop is classified first: bound to a kernel, a loopback one,
            // including one a redirect lands on, is served by its port table or its
            // host's loopback router, never by fetch.
            const walk = await walkRedirects({ url: new URL(url), method: 'GET', headers: new Headers() }, { follow: true, send: (hop) => sendHop(kernel, hop.url, hopInit(hop, ctx.signal)) });
            if (walk.kind === 'refused') {
                if (!options.quiet)
                    await ctx.stderr.write('failed.\n');
                await ctx.stderr.write(`wget: unable to connect to ${walk.url}\n`);
                return 1;
            }
            if (walk.kind === 'aborted') {
                await ctx.stderr.write('wget: request aborted\n');
                return 1;
            }
            if (walk.kind === 'timeout') {
                await ctx.stderr.write('wget: request timed out\n');
                return 1;
            }
            if (walk.kind === 'too-many-redirects') {
                await ctx.stderr.write('wget: too many redirects\n');
                return 1;
            }
            const response = { status: walk.response.status, statusText: walk.response.statusText, body: await walk.response.text() };
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
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!options.quiet) {
                await ctx.stderr.write(`failed.\n`);
            }
            if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
                await ctx.stderr.write(`wget: unable to connect to ${url}\n`);
                await ctx.stderr.write(`Note: This may be a CORS restriction. The target server must allow cross-origin requests.\n`);
            }
            else {
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
export function createWgetCommand(kernel) {
    return createWgetImpl(kernel);
}
// Default command (no kernel -- always uses fetch)
const command = createWgetImpl();
export default command;
