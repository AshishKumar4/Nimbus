// Another account on the box, and what it can find: the privacy probes'
// (process-env-private, image-privacy) one way to ask it.

/** `run`: a shell command run in the probe's terminal, and its output, ANSI stripped. */

/** Add alice (uid 1001), a second account, through `run`; answers whether she exists. */
export async function addAlice(run) {
  await run(`sudo sh -c 'echo "alice:x:1001:1001:alice:/home/alice:/bin/sh" >> /etc/passwd && echo "alice:x:1001:" >> /etc/group'`, 10_000);
  const who = await run('sudo -u alice id -u', 10_000);
  return { exists: who.text.includes('1001'), text: who.text };
}

/**
 * What alice finds when she searches every file below `dirs` for any of
 * `needles`: the paths that hold one. `answered` when grep searched all she
 * may read: it found nothing (status 1), or its only errors were directories
 * she may not read (status 2, each "Permission denied"), which is no place
 * she finds them. Any other error is no answer.
 */
export async function aliceSearch(run, needles, dirs) {
  const search = await run(`sudo -u alice grep -rl ${needles.map((needle) => `-e ${needle}`).join(' ')} ${dirs.join(' ')}; echo "SEARCHED $?"`, 120_000);
  const lines = search.text.split('\n').map((line) => line.trim());
  const found = lines.filter((line) => dirs.some((dir) => line.startsWith(`${dir}/`)));
  const errors = lines.filter((line) => line.startsWith('grep: '));
  const status = /SEARCHED (\d+)/.exec(search.text)?.[1];
  const answered = status === '1' || (status === '2' && errors.length > 0 && errors.every((line) => line.endsWith(': Permission denied')));
  return { found, answered, text: search.text };
}
