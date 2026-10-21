import { z } from 'zod/v4';
export declare const InterpreterEnvFactsSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    runtime: z.ZodLiteral<"python">;
    home: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    runtime: z.ZodLiteral<"ruby">;
    home: z.ZodString;
    gemHome: z.ZodString;
    gemLibs: z.ZodArray<z.ZodString>;
    gemActivates: z.ZodBoolean;
}, z.core.$strip>], "runtime">;
export type InterpreterEnvFacts = z.infer<typeof InterpreterEnvFactsSchema>;
/** What an interpreter's environment is built from: its command's environment, and its runtime's facts. */
export interface InterpreterEnv {
    base: Record<string, string>;
    facts: InterpreterEnvFacts;
}
/** The environment an interpreter runs with: `base`, and what its runtime adds, from `facts`. */
export declare function interpreterProcessEnv(base: Readonly<Record<string, string>>, facts: InterpreterEnvFacts): Record<string, string>;
//# sourceMappingURL=interpreter-env.d.ts.map