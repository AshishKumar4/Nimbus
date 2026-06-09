/**
 * DNS resolver with caching
 * Supports both local records and external resolution
 */
export class DNSResolver {
    cache = new Map();
    hosts = new Map(); // hostname -> IP mapping
    constructor() {
        // Initialize with localhost
        this.addHost('localhost', '127.0.0.1');
        this.addHost('ip6-localhost', '::1');
    }
    /**
     * Add static host entry
     */
    addHost(hostname, ip) {
        this.hosts.set(hostname, ip);
        this.addRecord({
            type: 'A',
            name: hostname,
            value: ip,
            ttl: -1, // Never expires
        });
    }
    /**
     * Remove host entry
     */
    removeHost(hostname) {
        this.hosts.delete(hostname);
        this.cache.delete(hostname);
    }
    /**
     * Get host IP
     */
    getHost(hostname) {
        return this.hosts.get(hostname);
    }
    /**
     * Add DNS record to cache
     */
    addRecord(record) {
        const existing = this.cache.get(record.name) || [];
        existing.push({
            ...record,
            ttl: record.ttl === -1 ? -1 : Date.now() + record.ttl * 1000,
        });
        this.cache.set(record.name, existing);
    }
    /**
     * Resolve hostname to IP address
     */
    async resolve(hostname, type = 'A') {
        // Check cache first
        const cached = this.lookup(hostname, type);
        if (cached) {
            return cached.value;
        }
        // Try external resolution (browser or Node.js)
        if (typeof globalThis.fetch !== 'undefined') {
            return this.resolveExternal(hostname, type);
        }
        throw new Error(`Unable to resolve: ${hostname}`);
    }
    /**
     * Lookup DNS record in cache
     */
    lookup(name, type = 'A') {
        const records = this.cache.get(name);
        if (!records) {
            return null;
        }
        const now = Date.now();
        // Find matching record that hasn't expired
        for (const record of records) {
            if (record.type === type) {
                if (record.ttl === -1 || record.ttl > now) {
                    return record;
                }
            }
        }
        // Clean expired records
        this.cache.set(name, records.filter((r) => r.ttl === -1 || r.ttl > now));
        return null;
    }
    /**
     * Resolve using external DNS (browser DNS-over-HTTPS or real DNS)
     */
    async resolveExternal(hostname, type) {
        try {
            // Use Google DNS-over-HTTPS
            const dohUrl = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`;
            const response = await fetch(dohUrl);
            const data = await response.json();
            if (data.Status === 0 && data.Answer && data.Answer.length > 0) {
                const answer = data.Answer[0];
                const ip = answer.data;
                // Cache result
                this.addRecord({
                    type,
                    name: hostname,
                    value: ip,
                    ttl: 300, // 5 minutes
                });
                return ip;
            }
        }
        catch (error) {
            console.error('DNS resolution failed:', error);
        }
        throw new Error(`DNS resolution failed for ${hostname}`);
    }
    /**
     * Reverse lookup (IP to hostname)
     */
    reverseLookup(ip) {
        for (const [hostname, hostIp] of this.hosts.entries()) {
            if (hostIp === ip) {
                return hostname;
            }
        }
        return null;
    }
    /**
     * Clear DNS cache
     */
    clearCache() {
        // Keep static hosts
        const staticHosts = new Map();
        for (const [name, records] of this.cache.entries()) {
            const static_ = records.filter((r) => r.ttl === -1);
            if (static_.length > 0) {
                staticHosts.set(name, static_);
            }
        }
        this.cache = staticHosts;
    }
    /**
     * Get all cached records
     */
    getCachedRecords() {
        const all = [];
        for (const records of this.cache.values()) {
            all.push(...records);
        }
        return all;
    }
    /**
     * Load /etc/hosts file
     */
    loadHostsFile(content) {
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
                const ip = parts[0];
                const hostnames = parts.slice(1);
                for (const hostname of hostnames) {
                    this.addHost(hostname, ip);
                }
            }
        }
    }
}
