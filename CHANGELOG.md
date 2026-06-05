# Changelog

All notable Nimbus releases are summarized here. Package-level versions are
published independently in the `@nimbus-sh` npm scope.

## 2026-06-05

### Open-source Alpha

- Added root and package-level MIT license files.
- Added third-party notices for runtime and package dependencies.
- Added contribution, security, code-of-conduct, issue-template, and
  pull-request-template docs.
- Updated public README positioning for the free self-hostable alpha and the
  hosted demo limits.
- Switched the public workspace lockfile to `bun.lock` and removed the old
  npm lockfile.
- Removed wall-clock timestamps from generated worker bundles.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.3`
  - `@nimbus-sh/config@0.1.2`
  - `@nimbus-sh/sdk@0.1.3`
  - `@nimbus-sh/react@0.1.2`
  - `@nimbus-sh/cli@0.1.6`
  - `create-nimbus-app@0.1.5`

## 2026-06-04

### Sandbox SDK

- Added the programmatic sandbox SDK in `@nimbus-sh/sdk/sandbox`.
- Added direct Worker/Durable Object binding support with `Nimbus.fromEnv(...)`.
- Added authenticated remote sandbox access with `Nimbus.connect(...)`.
- Added sandbox lifecycle, command execution, code execution, files, runtimes,
  processes, preview ports, capability reporting, and tool-provider helpers.
- Added runtime policy enforcement for allowed, preinstalled, and on-demand
  runtimes.

### Worker Embedder

- Added the public remote SDK API route under `/api/nimbus/v1`.
- Added tenant-scoped session IDs and SDK-safe sandbox IDs.
- Updated the hosted-demo app to use the same SDK-facing Worker entrypoint that
  generated apps use.
- Added live SDK smoke routes for direct-binding and remote-client paths.

### Packages

- Published:
  - `@nimbus-sh/worker@0.1.2`
  - `@nimbus-sh/config@0.1.1`
  - `@nimbus-sh/sdk@0.1.2`
  - `@nimbus-sh/react@0.1.1`
  - `@nimbus-sh/cli@0.1.5`
  - `create-nimbus-app@0.1.4`

## 2026-05-16

### Workspace And Auth

- Restructured Nimbus as a Bun workspace with packages for the Worker runtime,
  SDK, React bindings, CLI, config helper, and hosted-demo app.
- Added HS256 JWT session tokens with tenant and subject isolation.
- Added authenticated and legacy-public Worker handler modes.

### Worker Assets

- Moved large runtime assets out of the Worker bundle and into the Workers
  Assets binding.
- Added asset loading helpers with isolate-local caching and concurrent request
  deduplication.

## 2026-05-11

### Runtime Surface

- Added Python and Ruby runtime support.
- Added Node and Bun REPL surfaces appropriate for the Workers runtime.
- Expanded WASI preview1 support, including file metadata, symlinks, outbound
  TCP, socket shutdown, and polling.
- Added clang support for WASI programs, multi-file compilation, user headers,
  and WASI execution.

### Shell And Compatibility

- Expanded shell behavior across redirects, pipelines, command substitution,
  heredocs, symlinks, process variables, and common Unix utilities.
- Improved package resolution for `package.json` `main`, `exports`, and
  `imports` fields.
- Added behavioral probes for runtimes, package installation, shell behavior,
  WASI, framework execution, and preview routing.

## Earlier

- Established the Durable Object session model.
- Added the SQLite-backed virtual filesystem.
- Added npm install support with R2-backed package caching.
- Added Worker Loader based execution facets.
- Added process logs, preview routing, Vite integration, and session recovery.
