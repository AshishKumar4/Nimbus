/**
 * The rest of the line it is in is discarded (bash's
 * jump_to_top_level(DISCARD)): a shell goes on with the next line it reads,
 * its own or a `source`d file's or a trap's, with $? 1; a child shell
 * (subshell, substitution, pipeline element, job) ends with 1. Neither `||`,
 * `if` nor a loop goes on.
 */
export declare class DiscardSignal {
    readonly exitCode = 1;
}
//# sourceMappingURL=discard.d.ts.map