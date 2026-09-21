function humanSize(bytes) {
    if (bytes < 1024)
        return bytes + 'B';
    if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + 'K';
    if (bytes < 1024 * 1024 * 1024)
        return (bytes / (1024 * 1024)).toFixed(1) + 'M';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}
const command = async (ctx) => {
    let human = false;
    for (const arg of ctx.args) {
        if (arg === '-h')
            human = true;
    }
    // Walk the entire VFS to count files and bytes
    let totalFiles = 0;
    let totalBytes = 0;
    async function walk(dirPath) {
        try {
            const entries = (await ctx.vfs.readdir(dirPath));
            for (const entry of entries) {
                const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
                if (entry.type === 'file') {
                    totalFiles++;
                    const st = (await ctx.vfs.stat(fullPath));
                    totalBytes += st.size;
                }
                else {
                    (await walk(fullPath));
                }
            }
        }
        catch {
            // skip
        }
    }
    (await walk('/'));
    const totalSpace = 256 * 1024 * 1024; // 256MB virtual space
    const used = totalBytes;
    const avail = totalSpace - used;
    if (human) {
        await ctx.stdout.write('Filesystem      Size  Used  Avail  Use%  Mounted on\n');
        await ctx.stdout.write(`vfs             ${humanSize(totalSpace)}  ${humanSize(used)}  ${humanSize(avail)}  ${Math.round((used / totalSpace) * 100)}%    /\n`);
    }
    else {
        await ctx.stdout.write('Filesystem      1K-blocks    Used    Available  Use%  Mounted on\n');
        await ctx.stdout.write(`vfs             ${Math.round(totalSpace / 1024)}    ${Math.round(used / 1024)}    ${Math.round(avail / 1024)}  ${Math.round((used / totalSpace) * 100)}%    /\n`);
    }
    return 0;
};
export default command;
