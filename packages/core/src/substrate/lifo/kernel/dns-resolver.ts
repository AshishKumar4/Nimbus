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
export class DNSResolver {
  private cache = new Map<string, DNSRecord[]>();
  private hosts = new Map<string, string>(); // hostname -> IP mapping

  /**
   * Add static host entry
   */
  addHost(hostname: string, ip: string): void {
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
  removeHost(hostname: string): void {
    this.hosts.delete(hostname);
    this.cache.delete(hostname);
  }

  /**
   * Get host IP
   */
  getHost(hostname: string): string | undefined {
    return this.hosts.get(hostname);
  }

  /**
   * Add DNS record to cache
   */
  addRecord(record: DNSRecord): void {
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
  async resolve(hostname: string, type: DNSRecordType = 'A'): Promise<string> {
    // Check cache first
    const cached = this.lookup(hostname, type);
    if (cached) {
      return cached.value;
    }

    throw new Error(`Unable to resolve: ${hostname}`);
  }

  /**
   * Lookup DNS record in cache
   */
  lookup(name: string, type: DNSRecordType = 'A'): DNSRecord | null {
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
    this.cache.set(
      name,
      records.filter((r) => r.ttl === -1 || r.ttl > now)
    );

    return null;
  }

  /**
   * Reverse lookup (IP to hostname)
   */
  reverseLookup(ip: string): string | null {
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
  clearCache(): void {
    // Keep static hosts
    const staticHosts = new Map<string, DNSRecord[]>();
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
  getCachedRecords(): DNSRecord[] {
    const all: DNSRecord[] = [];
    for (const records of this.cache.values()) {
      all.push(...records);
    }
    return all;
  }

  /** The static records as /etc/hosts lines, in the order lookups find them, which loadHostsFile reads back. */
  hostsFile(): string {
    return this.getCachedRecords().filter((record) => record.ttl === -1).map((record) => `${record.value}\t${record.name}\n`).join('');
  }

  /**
   * Load /etc/hosts file
   */
  loadHostsFile(content: string): void {
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
