# The unit suite's runner: what tests/unit needs on the workstation, and
# nothing that belongs to a commit. Each shard receives its commit's tree at
# run time and installs that commit's dependencies (image/ci/shard.mjs).
#
# Staged into apps/ci-runner/.image-context/ by scripts/deploy.mjs, with:
#   deps/            main's bun.lock and package manifests, installed once
#                    here so every shard's `bun install` is a cache hit;
#   lean-toolchain   lean/lean-toolchain, for tests/unit/lean-proofs.mjs.
FROM ubuntu:26.04

# The workstation's versions: Ubuntu 26.04, node 22, bun 1.4.0 (the version
# .github/workflows pins).
ARG NODE_VERSION=22.22.3
ARG BUN_VERSION=1.4.0

ENV DEBIAN_FRONTEND=noninteractive
# Host tools the suite spawns: git (real-git differentials), python3 and ruby
# (REPL differentials), redis-server and openssl (TLS workerd tests),
# gnu-coreutils (gnurealpath: GNU realpath next to the default uutils one),
# util-linux (flock, setpriv), procps (ps for leak checks), bubblewrap
# (realm-host-pid1 starts itself as PID 1 of a namespace), and the
# en_US.UTF-8 locale the GNU fixture recorder runs its tools under.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils tini procps psmisc util-linux locales bubblewrap \
      git openssl python3 ruby redis-server gnu-coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && locale-gen en_US.UTF-8

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt \
 && for bin in node npm npx corepack; do ln -s "/opt/node-v${NODE_VERSION}-linux-x64/bin/${bin}" "/usr/local/bin/${bin}"; done \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && unzip -q /tmp/bun.zip -d /tmp \
 && install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
 && ln -s bun /usr/local/bin/bunx \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64

# Tests run as uid 1000, as on the workstation: a test asserting EACCES
# would pass vacuously as root.
RUN (userdel -r ubuntu 2>/dev/null || true) && useradd -m -u 1000 -s /bin/bash ci
USER ci
WORKDIR /home/ci
# The workstation's git defaults that tests reach: a committer identity, and
# `main` for a new repository's branch.
RUN git config --global user.name 'Nimbus CI' && git config --global user.email ci@nimbus-ci.invalid \
 && git config --global init.defaultBranch main
COPY --chown=ci:ci lean-toolchain /home/ci/lean-toolchain
RUN curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --no-modify-path --default-toolchain "$(cat /home/ci/lean-toolchain)"
COPY --chown=ci:ci deps/ /home/ci/deps/
# Once more on failure: a registry download can fail on its own (a sharp
# tarball did, once).
RUN cd /home/ci/deps && (bun install --frozen-lockfile --ignore-scripts || bun install --frozen-lockfile --ignore-scripts) \
 && cd /home/ci && rm -rf /home/ci/deps

USER root
COPY ci/ /opt/ci/
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
