import { resolve } from '../../utils/path.js';
const command = async (ctx) => {
    let outputFile;
    let quiet = false;
    let url;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '-O':
            case '--output-document':
                outputFile = args[++i] ?? '';
                break;
            case '-q':
            case '--quiet':
                quiet = true;
                break;
            default:
                if (arg.startsWith('--output-document=')) {
                    outputFile = arg.slice('--output-document='.length);
                }
                else if (arg.startsWith('-') && arg !== '-') {
                    // Dropping these meant `wget -O out.txt url` worked but
                    // `wget --output-document=out.txt url` silently wrote to the
                    // filename guessed from the URL instead.
                    ctx.stderr.write(`wget: unrecognized option '${arg}'\n`);
                    ctx.stderr.write('Usage: wget [-O file] [-q] url\n');
                    return 1;
                }
                else {
                    url = arg;
                }
                break;
        }
    }
    if (!url) {
        ctx.stderr.write('wget: missing URL\n');
        ctx.stderr.write('Usage: wget [-O file] [-q] url\n');
        return 1;
    }
    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    // Determine output filename
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
    if (!quiet) {
        ctx.stderr.write(`--  ${url}\n`);
        ctx.stderr.write(`Connecting... `);
    }
    try {
        const response = await fetch(url, { signal: ctx.signal });
        if (!quiet) {
            ctx.stderr.write(`connected.\n`);
            ctx.stderr.write(`HTTP request sent, awaiting response... ${response.status} ${response.statusText}\n`);
        }
        const body = await response.text();
        const path = resolve(ctx.cwd, outputFile);
        ctx.vfs.writeFile(path, body);
        if (!quiet) {
            ctx.stderr.write(`Saving to: '${outputFile}'\n`);
            ctx.stderr.write(`${body.length} bytes saved.\n`);
        }
        return response.ok ? 0 : 1;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!quiet) {
            ctx.stderr.write(`failed.\n`);
        }
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
            ctx.stderr.write(`wget: unable to connect to ${url}\n`);
            ctx.stderr.write(`Note: This may be a CORS restriction. The target server must allow cross-origin requests.\n`);
        }
        else {
            ctx.stderr.write(`wget: ${msg}\n`);
        }
        return 1;
    }
};
export default command;
