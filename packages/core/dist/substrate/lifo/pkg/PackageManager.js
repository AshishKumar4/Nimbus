const PKG_DIR = '/usr/share/pkg';
const MODULES_DIR = '/usr/share/pkg/node_modules';
const METADATA_FILE = '/usr/share/pkg/packages.json';
export class PackageManager {
    vfs;
    constructor(vfs) {
        this.vfs = vfs;
    }
    readMetadata() {
        try {
            const content = this.vfs.readFileString(METADATA_FILE);
            return JSON.parse(content);
        }
        catch {
            return { packages: {} };
        }
    }
    writeMetadata(meta) {
        this.vfs.writeFile(METADATA_FILE, JSON.stringify(meta, null, 2) + '\n');
    }
    ensureDirs() {
        try {
            this.vfs.mkdir(PKG_DIR, { recursive: true });
        }
        catch { /* exists */ }
        try {
            this.vfs.mkdir(MODULES_DIR, { recursive: true });
        }
        catch { /* exists */ }
    }
    async install(url, name) {
        this.ensureDirs();
        // Fetch the package
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        const source = await response.text();
        // Determine package name from URL if not provided
        if (!name) {
            const urlPath = new URL(url).pathname;
            const filename = urlPath.split('/').pop() || 'package';
            name = filename.replace(/\.js$/, '');
        }
        // Write package file
        const pkgDir = `${MODULES_DIR}/${name}`;
        try {
            this.vfs.mkdir(pkgDir, { recursive: true });
        }
        catch { /* exists */ }
        this.vfs.writeFile(`${pkgDir}/index.js`, source);
        // Update metadata
        const meta = this.readMetadata();
        const info = {
            name,
            url,
            installedAt: Date.now(),
            size: source.length,
        };
        meta.packages[name] = info;
        this.writeMetadata(meta);
        return info;
    }
    remove(name) {
        const meta = this.readMetadata();
        if (!meta.packages[name])
            return false;
        // Remove files
        const pkgDir = `${MODULES_DIR}/${name}`;
        try {
            this.vfs.rmdirRecursive(pkgDir);
        }
        catch {
            // Try just unlinking the index.js
            try {
                this.vfs.unlink(`${pkgDir}/index.js`);
            }
            catch { /* ignore */ }
            try {
                this.vfs.rmdir(pkgDir);
            }
            catch { /* ignore */ }
        }
        // Update metadata
        delete meta.packages[name];
        this.writeMetadata(meta);
        return true;
    }
    list() {
        const meta = this.readMetadata();
        return Object.values(meta.packages);
    }
    info(name) {
        const meta = this.readMetadata();
        return meta.packages[name] || null;
    }
}
