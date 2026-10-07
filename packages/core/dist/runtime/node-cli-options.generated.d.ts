/** The options that take a value (`--name=value`, or the next argument). */
export declare const NODE_VALUE_OPTIONS: ReadonlySet<string>;
/** Every option Node's own table knows, by its canonical name. */
export declare const NODE_KNOWN_OPTIONS: ReadonlySet<string>;
/** V8's flags, without their dashes (V8 takes `-` and `_` alike in them). */
export declare const NODE_V8_FLAGS: ReadonlySet<string>;
/** The boolean options: the only ones `--no-<name>` negates. */
export declare const NODE_BOOLEAN_OPTIONS: ReadonlySet<string>;
/** The options NODE_OPTIONS may carry, aliases included. */
export declare const NODE_ENV_OPTIONS: ReadonlySet<string>;
/** Each alias and what it stands for. */
export declare const NODE_OPTION_ALIASES: ReadonlyMap<string, readonly string[]>;
//# sourceMappingURL=node-cli-options.generated.d.ts.map