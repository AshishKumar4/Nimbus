/**
 * The look Nimbus's browser terminals share: the shell's and its process
 * tabs' (public/s/index.html, through the worker's terminal-policy asset)
 * and the docs' sandbox (apps/docs NimbusSandbox.astro). Font size and
 * background are each terminal's own.
 */
export declare const TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, monospace";
export declare const TERMINAL_CURSOR: {
    cursorBlink: boolean;
    cursorStyle: 'bar';
};
/** xterm's theme, but its background. */
export declare const TERMINAL_THEME: {
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
};
//# sourceMappingURL=terminal-policy.d.ts.map