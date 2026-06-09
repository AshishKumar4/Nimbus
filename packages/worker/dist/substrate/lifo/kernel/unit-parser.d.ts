/**
 * INI-style unit file parser for systemd-like service definitions.
 */
export interface UnitFile {
    Unit: {
        Description?: string;
    };
    Service: {
        ExecStart?: string;
        ExecStop?: string;
        Type?: 'simple' | 'oneshot';
        Restart?: 'no' | 'always' | 'on-failure';
        RestartSec?: number;
        Environment?: Record<string, string>;
        WorkingDirectory?: string;
    };
    Install: {
        WantedBy?: string;
    };
}
export declare function parseUnitFile(content: string): UnitFile;
//# sourceMappingURL=unit-parser.d.ts.map