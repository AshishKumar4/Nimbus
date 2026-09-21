const PKG_DIR = '/usr/share/pkg';
const MODULES_DIR = '/usr/share/pkg/node_modules';
const METADATA_FILE = '/usr/share/pkg/packages.json';
export class PackageManager {
    vfs;
    constructor(vfs) {
        this.vfs = vfs;
    }
    async readMetadata() {
        try {
            const content = (await this.vfs.readFileString(METADATA_FILE));
            return JSON.parse(content);
        }
        catch {
            return { packages: {} };
        }
    }
    async writeMetadata(meta) {
        (await this.vfs.writeFile(METADATA_FILE, JSON.stringify(meta, null, 2) + '\n'));
    }
    async ensureDirs() {
        try {
            (await this.vfs.mkdir(PKG_DIR, { recursive: true }));
        }
        catch { /* exists */ }
        try {
            (await this.vfs.mkdir(MODULES_DIR, { recursive: true }));
        }
        catch { /* exists */ }
    }
    async install(url, name) {
        (await this.ensureDirs());
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
            (await this.vfs.mkdir(pkgDir, { recursive: true }));
        }
        catch { /* exists */ }
        (await this.vfs.writeFile(`${pkgDir}/index.js`, source));
        // Update metadata
        const meta = (await this.readMetadata());
        const info = {
            name,
            url,
            installedAt: Date.now(),
            size: source.length,
        };
        meta.packages[name] = info;
        (await this.writeMetadata(meta));
        return info;
    }
    async remove(name) {
        const meta = (await this.readMetadata());
        if (!meta.packages[name])
            return false;
        // Remove files
        const pkgDir = `${MODULES_DIR}/${name}`;
        try {
            (await this.vfs.rmdirRecursive(pkgDir));
        }
        catch {
            // Try just unlinking the index.js
            try {
                (await this.vfs.unlink(`${pkgDir}/index.js`));
            }
            catch { /* ignore */ }
            try {
                (await this.vfs.rmdir(pkgDir));
            }
            catch { /* ignore */ }
        }
        // Update metadata
        delete meta.packages[name];
        (await this.writeMetadata(meta));
        return true;
    }
    async list() {
        const meta = (await this.readMetadata());
        return Object.values(meta.packages);
    }
    async info(name) {
        const meta = (await this.readMetadata());
        return meta.packages[name] || null;
    }
}
