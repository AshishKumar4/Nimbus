/**
 * The look Nimbus's browser terminals share: the shell's and its process
 * tabs' (public/s/index.html, through the worker's terminal-policy asset)
 * and the docs' sandbox (apps/docs NimbusSandbox.astro). Font size and
 * background are each terminal's own.
 */
export declare const TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, monospace";
export declare const TERMINAL_CURSOR: {
    readonly cursorBlink: true;
    readonly cursorStyle: "bar";
};
/** xterm's theme, but its background. */
export declare const TERMINAL_THEME: {
    readonly foreground: "#c9d1d9";
    readonly cursor: "#58a6ff";
    readonly selectionBackground: "#264f78";
    readonly black: "#484f58";
    readonly red: "#ff7b72";
    readonly green: "#3fb950";
    readonly yellow: "#d29922";
    readonly blue: "#58a6ff";
    readonly magenta: "#bc8cff";
    readonly cyan: "#39d353";
    readonly white: "#c9d1d9";
    readonly brightBlack: "#6e7681";
    readonly brightRed: "#ffa198";
    readonly brightGreen: "#56d364";
    readonly brightYellow: "#e3b341";
    readonly brightBlue: "#79c0ff";
    readonly brightMagenta: "#d2a8ff";
    readonly brightCyan: "#56d364";
    readonly brightWhite: "#f0f6fc";
};
//# sourceMappingURL=terminal-policy.d.ts.map