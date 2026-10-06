interface DoUnavailableError {
    error: string;
    code: 'E_NIMBUS_DO_OVERLOADED' | 'E_NIMBUS_DO_CODE_UPDATED';
    retryAfter: string;
}
/**
 * Describe platform unavailability at a public DO boundary. This classifies
 * only; it never repeats a call whose mutation or upgrade may have run.
 */
export declare function doUnavailableError(error: unknown): DoUnavailableError | null;
export {};
//# sourceMappingURL=do-errors.d.ts.map