/**
 * The rest of the line it is in is discarded (bash's
 * jump_to_top_level(DISCARD)): a shell goes on with the next line it reads,
 * its own or a `source`d file's or a trap's, with $? 1; a child shell
 * (subshell, substitution, pipeline element, job) ends with 1. Neither `||`,
 * `if` nor a loop goes on. `diagnostic`, where there is one, is the shell's
 * to write on its stderr where it discards (bash writes it before it jumps).
 */
export class DiscardSignal {
  readonly exitCode = 1;
  constructor(readonly diagnostic?: string) {}
}
