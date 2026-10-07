export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
export interface DNSRecord {
    type: DNSRecordType;
    name: string;
    value: string;
    ttl: number;
}
/**
 * DNS resolver for static hosts and explicitly cached records. It knows no
 * name until one is added: the kernel loads its /etc/hosts.
 */
export declare class DNSResolver {
    private cache;
    private hosts;
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
    /** The static records as /etc/hosts lines, in the order lookups find them, which loadHostsFile reads back. */
    hostsFile(): string;
    /**
     * Load /etc/hosts file
     */
    loadHostsFile(content: string): void;
}
//# sourceMappingURL=dns-resolver.d.ts.map