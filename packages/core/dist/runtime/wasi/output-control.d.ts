/** A private control frame on a runtime's output, not stored program text. */
export interface OutputControlFrame {
    key: string;
    prefix: string;
    suffix?: string;
}
export declare const OUTPUT_CONTROL_MAX_BYTES = 4096;
/** Filter only declared frames; all other bytes retain their exact encoding. */
export declare function outputControlReader(frames: readonly OutputControlFrame[]): {
    values: Record<string, string>;
    feed(bytes: Uint8Array): Uint8Array;
    finish(): Uint8Array;
};
//# sourceMappingURL=output-control.d.ts.map