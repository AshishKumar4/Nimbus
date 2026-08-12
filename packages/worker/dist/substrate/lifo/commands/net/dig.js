const TYPE_MAP = {
    1: 'A',
    2: 'NS',
    5: 'CNAME',
    6: 'SOA',
    15: 'MX',
    16: 'TXT',
    28: 'AAAA',
};
const QUERY_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'];
const command = async (ctx) => {
    let queryType = 'A';
    let domain;
    let short = false;
    for (let i = 0; i < ctx.args.length; i++) {
        const arg = ctx.args[i];
        // dig's `+flag` dialect and its `-t TYPE` form both used to be skipped
        // wholesale, so `dig +short x` printed the full answer section.
        if (arg === '+short') {
            short = true;
            continue;
        }
        if (arg === '+noall' || arg === '+answer')
            continue;
        if (arg === '-t') {
            const value = ctx.args[++i];
            if (value === undefined) {
                ctx.stderr.write("dig: option '-t' requires an argument\n");
                return 1;
            }
            if (!QUERY_TYPES.includes(value.toUpperCase())) {
                ctx.stderr.write(`dig: unsupported query type '${value}'\n`);
                return 1;
            }
            queryType = value.toUpperCase();
            continue;
        }
        if (arg.startsWith('-') || arg.startsWith('+')) {
            ctx.stderr.write(`dig: unrecognized option '${arg}'\n`);
            ctx.stderr.write('Usage: dig [-t type] [+short] [type] domain\n');
            return 1;
        }
        const upper = arg.toUpperCase();
        if (QUERY_TYPES.includes(upper)) {
            queryType = upper;
        }
        else {
            domain = arg;
        }
    }
    if (!domain) {
        ctx.stderr.write('dig: missing domain\n');
        ctx.stderr.write('Usage: dig [type] domain\n');
        return 1;
    }
    const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${queryType}`;
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/dns-json' },
            signal: ctx.signal,
        });
        if (!response.ok) {
            ctx.stderr.write(`dig: DNS query failed (HTTP ${response.status})\n`);
            return 1;
        }
        const data = await response.json();
        if (short) {
            // `+short` prints just the answer data, one per line, and nothing else.
            for (const ans of data.Answer ?? [])
                ctx.stdout.write(`${ans.data}\n`);
            return 0;
        }
        ctx.stdout.write(`; <<>> Lifo dig <<>> ${queryType} ${domain}\n`);
        ctx.stdout.write(`;; Got answer:\n`);
        ctx.stdout.write(`;; ->>HEADER<<- status: ${data.Status === 0 ? 'NOERROR' : 'NXDOMAIN'}\n`);
        ctx.stdout.write(`\n`);
        if (data.Question && data.Question.length > 0) {
            ctx.stdout.write(`;; QUESTION SECTION:\n`);
            for (const q of data.Question) {
                ctx.stdout.write(`;${q.name}.\t\tIN\t${TYPE_MAP[q.type] ?? q.type}\n`);
            }
            ctx.stdout.write(`\n`);
        }
        if (data.Answer && data.Answer.length > 0) {
            ctx.stdout.write(`;; ANSWER SECTION:\n`);
            for (const ans of data.Answer) {
                const typeName = TYPE_MAP[ans.type] ?? String(ans.type);
                ctx.stdout.write(`${ans.name}.\t${ans.TTL}\tIN\t${typeName}\t${ans.data}\n`);
            }
            ctx.stdout.write(`\n`);
        }
        else {
            ctx.stdout.write(`;; No answers found.\n\n`);
        }
        ctx.stdout.write(`;; SERVER: dns.google\n`);
        return 0;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            ctx.stderr.write(`dig: connection to DNS server failed\n`);
            ctx.stderr.write(`Note: This may be a CORS restriction or network issue.\n`);
        }
        else {
            ctx.stderr.write(`dig: ${msg}\n`);
        }
        return 1;
    }
};
export default command;
