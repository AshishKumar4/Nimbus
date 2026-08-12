import type { DNSRecord, DNSRecordType } from './types.js';
/**
 * DNS resolver for static hosts and explicitly cached records.
 */
export declare class DNSResolver {
    private cache;
    private hosts;
    constructor();
    /**
     * Add static host entry
     */
    addHost(hostname: string, ip: string): void;
    /**
     * Remove host entry
     */
    removeHost(hostname: string): void;
    /**
     * Get host IP
     */
    getHost(hostname: string): string | undefined;
    /**
     * Add DNS record to cache
     */
    addRecord(record: DNSRecord): void;
    /**
     * Resolve hostname to IP address
     */
    resolve(hostname: string, type?: DNSRecordType): Promise<string>;
    /**
     * Lookup DNS record in cache
     */
    lookup(name: string, type?: DNSRecordType): DNSRecord | null;
    /**
     * Reverse lookup (IP to hostname)
     */
    reverseLookup(ip: string): string | null;
    /**
     * Clear DNS cache
     */
    clearCache(): void;
    /**
     * Get all cached records
     */
    getCachedRecords(): DNSRecord[];
    /**
     * Load /etc/hosts file
     */
    loadHostsFile(content: string): void;
}
//# sourceMappingURL=DNSResolver.d.ts.map