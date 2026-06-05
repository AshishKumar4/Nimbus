/**
 * @nimbus-sh/react/types — Public types for the React component.
 */
/** Error class for terminal-side failures. */
export class NimbusTerminalError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'NimbusTerminalError';
        this.code = code;
    }
}
