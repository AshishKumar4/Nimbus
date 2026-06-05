/**
 * cli/commands/token — `nimbus token mint` + `nimbus token verify`.
 *
 * Both verbs require `JWT_SECRET` in env. Mint writes the JWT to stdout
 * (so `nimbus token mint --tenant acme > /tmp/jwt` works in scripts);
 * verify parses a token from argv and prints the claims as JSON.
 */
/**
 * Programmatic interface for token mint. Used by `bin.ts` and exported
 * from `@nimbus-sh/cli` so embedder scripts can call it directly.
 *
 * @example
 * ```ts
 * import { mintToken } from '@nimbus-sh/cli';
 * const code = await mintToken(['--tenant', 'acme', '--sub', 'alice']);
 * ```
 *
 * @param args Raw CLI args (after the `token mint` prefix).
 * @returns Process exit code (0 success, non-zero per
 *          `CLI_EXIT_CODES` semantics).
 */
export declare function mintToken(args: string[]): Promise<number>;
/** `nimbus token verify <token>` — verify + print claims as JSON. */
export declare function verifyTokenCmd(args: string[]): Promise<number>;
//# sourceMappingURL=token.d.ts.map