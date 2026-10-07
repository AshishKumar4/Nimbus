/**
 * wrangler-config.ts — a project's wrangler.json or wrangler.jsonc, as
 * `nimbus wrangler dev`, its unsupported-binding warning and the repo's
 * deploy-isolation gate read it.
 */
import { parse, printParseErrorCode } from 'jsonc-parser';
/**
 * A wrangler.json or wrangler.jsonc as wrangler reads one: jsonc-parser,
 * trailing commas allowed, refused at its first error.
 */
export function parseWranglerJsonc(text) {
    const errors = [];
    const config = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        throw new SyntaxError(`${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new SyntaxError('the config is not a JSON object');
    }
    return config;
}
