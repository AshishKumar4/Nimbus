export declare function isPreviewHostSafeSid(sid: string): boolean;
export declare function buildPreviewHost(sid: string, port: number, suffix: string): string;
export declare function parsePreviewHost(host: string, suffix: string | undefined | null): {
    port: number;
    sid: string;
} | null;
//# sourceMappingURL=preview-host.d.ts.map