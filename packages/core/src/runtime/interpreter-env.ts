// runtime/interpreter-env.ts — an interpreter resident's environment: the
// environment its command was launched with (the base), and what its runtime
// adds to it. One construction, for the first launch and every relaunch
// (ask 62): a relaunch asks its host for the base again, and builds the rest
// from the runtime's own facts, which its image keeps. They hold no secret:
// paths, and the gems found installed when it launched.

import { z } from 'zod/v4';
import { CA_CERTIFICATES_FILE } from '../vfs/proc-vfs.js';

export const InterpreterEnvFactsSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('python'), home: z.string() }),
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
      // Its OpenSSL's default paths are its build machine's: the session's trust store, unless the program names its own.
      if (!env.SSL_CERT_FILE) env.SSL_CERT_FILE = CA_CERTIFICATES_FILE;
      return env;
    case 'ruby':
      if (!env.LANG) env.LANG = 'C.UTF-8';
      // As CPython's: ruby.wasm's OpenSSL looks in /usr/local/ssl, which no session has.
      if (!env.SSL_CERT_FILE) env.SSL_CERT_FILE = CA_CERTIFICATES_FILE;
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
