/** How Node reads one of its options (node_options.h OptionType): `value` takes one; `v8` is passed to V8. */
export type NodeOptionKind = 'noop' | 'v8' | 'boolean' | 'value';
/** Node's options by canonical name: what each takes, and whether NODE_OPTIONS may carry it. */
export declare const NODE_OPTIONS_TABLE: ReadonlyMap<string, {
    readonly kind: NodeOptionKind;
    readonly env: boolean;
}>;
/** V8's flags, without their dashes (V8 takes `-` and `_` alike in them). */
export declare const NODE_V8_FLAGS: ReadonlySet<string>;
/** Each alias and what it stands for. */
export declare const NODE_OPTION_ALIASES: ReadonlyMap<string, readonly string[]>;
//# sourceMappingURL=node-cli-options.generated.d.ts.map