#!/usr/bin/env bun
// The trust store every session reads, /etc/ssl/certs/ca-certificates.crt,
// is the pinned bundle this build serves, and trusts nothing on a path to
// the eMudhra intermediates whose keys were found compromised on 2026-10-20
// (https://emudhra.we-have-a-problem.com/). Before, a session's CPython
// verified TLS against a copy staged with its runtime (Mozilla's roots of
// 2026-07-16, emSign ECC Root CA - G3 among them), which accepted a
// certificate those intermediates issued, and an installed session would
// have kept it. The pin moves with scripts/update-ca-certificates.mjs, by
// hand: this test is what says a bundle is the one meant.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { interpreterProcessEnv } from '../../packages/core/src/runtime/interpreter-env.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const PINNED_SHA256 = '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe'; // curl.se cacert-2026-10-20.pem
const FILE = '/etc/ssl/certs/ca-certificates.crt';

const pemBlocks = (text) => text.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];
const fingerprint = (cert) => cert.fingerprint256.replaceAll(':', '');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions });
try {
  const served = await ws.fs.readFile(FILE);
  assert.equal(createHash('sha256').update(served).digest('hex'), PINNED_SHA256, 'the served bundle is the pinned one');
  const roots = pemBlocks(new TextDecoder().decode(served)).map((pem) => new X509Certificate(pem));
  assert.ok(roots.length > 100, `a bundle of roots: ${roots.length}`);

  // Nothing on a path to the compromised intermediates: not their roots, and none that issued a certificate on the way.
  const compromised = pemBlocks(readFileSync(new URL('./fixtures/emudhra-compromised-2026-10-20.pem', import.meta.url), 'utf8'))
    .map((pem) => new X509Certificate(pem));
  assert.equal(compromised.length, 21);
  const trusted = new Set(roots.map(fingerprint));
  for (const cert of compromised) {
    assert.ok(!trusted.has(fingerprint(cert)), `not trusted: ${cert.subject.split('\n').join(', ')}`);
    for (const root of roots) {
      assert.ok(!(cert.checkIssued(root) && cert.verify(root.publicKey)),
        `${root.subject.split('\n').join(', ')} issued ${cert.subject.split('\n').join(', ')}`);
    }
  }

  // Where a session finds it, and that it is the deployment's, not the session's to change.
  const listed = await ws.exec(`ls -l ${FILE}; ls /etc/ssl/certs; grep ' /etc/ssl/certs ' /proc/mounts`);
  assert.match(listed.stdout, /^-rw-r--r-- 1 root root \d+ .* \/etc\/ssl\/certs\/ca-certificates\.crt$/m, listed.stdout);
  assert.match(listed.stdout, /^ca-certificates\.crt$/m);
  assert.match(listed.stdout, /^ca-certificates \/etc\/ssl\/certs ca-certificates ro/m, listed.stdout);
  const write = await ws.exec(`echo forged >> ${FILE}; rm -f ${FILE}; touch /etc/ssl/certs/extra.pem`);
  assert.equal(write.stderr.match(/Read-only file system/g)?.length, 3, write.stderr);
  assert.equal(createHash('sha256').update(await ws.fs.readFile(FILE)).digest('hex'), PINNED_SHA256, 'unchanged by them');
} finally {
  await ws.close();
}

// CPython and Ruby carry their own OpenSSL, whose default paths no session has: their environment names the store.
for (const facts of [{ runtime: 'python', home: '/home/user' }, { runtime: 'ruby', home: '/home/user', gemHome: '/g', gemLibs: [], gemActivates: false }]) {
  assert.equal(interpreterProcessEnv({}, facts).SSL_CERT_FILE, FILE, `${facts.runtime} reads the session's trust store`);
  assert.equal(interpreterProcessEnv({ SSL_CERT_FILE: '/mine.pem' }, facts).SSL_CERT_FILE, '/mine.pem', `${facts.runtime}: a program's own wins`);
}
console.log('ca-certificates: the served trust store is the pinned bundle and trusts no path to the compromised eMudhra intermediates');
