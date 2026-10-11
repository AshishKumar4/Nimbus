export type ProcessExitNotice = {
    pid: number;
    code: number;
    kind: 'dump' | 'facet' | 'killed';
} | {
    pid: number;
    code: number;
    kind: 'shell';
    durationMs: number;
};
export interface ProcessExitNoticeSource {
    retainsLogs(pid: number): boolean;
    get(pid: number): {
        command: string;
    } | undefined;
}
//# sourceMappingURL=process-exit-notices.d.ts.map