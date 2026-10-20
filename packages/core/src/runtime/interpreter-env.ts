// runtime/interpreter-env.ts — an interpreter resident's environment: the
// environment its command was launched with (the base), and what its runtime
// adds to it. One construction, for the first launch and every relaunch
// (ask 62): a relaunch asks its host for the base again, and builds the rest
// from the runtime's own facts, which its image keeps. They hold no secret:
// paths, and the gems found installed when it launched.

import { z } from 'zod/v4';

export const InterpreterEnvFactsSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('python'), home: z.string(), cacert: z.string().nullable() }),
  z.object({ runtime: z.literal('ruby'), home: z.string(), gemHome: z.string(), gemLibs: z.array(z.string()), gemActivates: z.boolean() }),
]);
export type InterpreterEnvFacts = z.infer<typeof InterpreterEnvFactsSchema>;

/** What an interpreter's environment is built from: its command's environment, and its runtime's facts. */
export interface InterpreterEnv {
  base: Record<string, string>;
  facts: InterpreterEnvFacts;
}

/** The environment an interpreter runs with: `base`, and what its runtime adds, from `facts`. */
export function interpreterProcessEnv(base: Readonly<Record<string, string>>, facts: InterpreterEnvFacts): Record<string, string> {
  const env = { ...base };
  if (!env.HOME) env.HOME = facts.home;
  switch (facts.runtime) {
    case 'python':
      if (!env.PYTHONUNBUFFERED) env.PYTHONUNBUFFERED = '1';
      // Without this OpenSSL has no trust anchors at all — there is no
      // /etc/ssl on a Nimbus session — and every HTTPS request fails
      // verification with a message about a missing local issuer rather than
      // about a missing bundle.
      if (!env.SSL_CERT_FILE && facts.cacert !== null) env.SSL_CERT_FILE = facts.cacert;
      return env;
    case 'ruby':
      if (!env.LANG) env.LANG = 'C.UTF-8';
      env.GEM_HOME ||= facts.gemHome;
      env.GEM_PATH ||= env.GEM_HOME;
      env.NIMBUS_GEM_LIBS = facts.gemLibs.join(':');
      if (facts.gemActivates) env.NIMBUS_GEM_ACTIVATE = '1';
      // Ruby looks for charset hints via these vars; set sensible defaults
      // so puts of non-ASCII strings doesn't trip on the wasi default of
      // "ASCII-8BIT".
      if (!env.LC_ALL) env.LC_ALL = 'C.UTF-8';
      return env;
  }
}

const BuiltPythonEnv = z.looseObject({ HOME: z.string(), SSL_CERT_FILE: z.string().optional() });
const BuiltRubyEnv = z.looseObject({ HOME: z.string(), GEM_HOME: z.string(), NIMBUS_GEM_LIBS: z.string(), NIMBUS_GEM_ACTIVATE: z.string().optional() });

/**
 * The facts an environment an earlier release stored whole (the base with
 * its runtime's additions in it) was built from, read back from it: null
 * when it does not hold them.
 */
export function interpreterEnvFactsOf(runtime: InterpreterEnvFacts['runtime'], built: Readonly<Record<string, string>>): InterpreterEnvFacts | null {
  if (runtime === 'python') {
    const held = BuiltPythonEnv.safeParse(built);
    return held.success ? { runtime, home: held.data.HOME, cacert: held.data.SSL_CERT_FILE ?? null } : null;
  }
  const held = BuiltRubyEnv.safeParse(built);
  return held.success
    ? { runtime, home: held.data.HOME, gemHome: held.data.GEM_HOME, gemLibs: held.data.NIMBUS_GEM_LIBS === '' ? [] : held.data.NIMBUS_GEM_LIBS.split(':'), gemActivates: held.data.NIMBUS_GEM_ACTIVATE === '1' }
    : null;
}
