# Security Policy

Nimbus is a free and open-source hobby alpha. It is not a managed security
product and does not offer a bug bounty or response-time SLA.

## Scope

Security-sensitive areas include:

- Token minting and verification.
- Tenant/session isolation.
- Durable Object routing.
- Programmatic sandbox access through `@nimbus-sh/sdk`.
- Remote SDK API routes under `/api/nimbus/v1`.
- File, process, runtime-install, and preview-port access control.

## Reporting

Please do not publish exploit details before there is time to understand and
fix the issue.

Preferred path:

1. Use GitHub private vulnerability reporting for this repository if it is
   enabled.
2. If private reporting is not available, open a public issue with minimal
   details only, saying that you need a security contact for Nimbus.

Do not include working exploit code, secrets, tokens, private user data, or
live session URLs in a public issue.

## Hosted Demo

The public hosted demo is for evaluation. Do not run destructive testing,
credential harvesting, persistence attempts, denial-of-service tests, spam,
cryptomining, or traffic amplification against it.

Self-host Nimbus in your own Cloudflare account for security research that
needs active testing.

## Supported Versions

This project currently supports the latest `main` branch and the latest npm
packages under the `@nimbus-sh` scope. Older alpha releases may be replaced
without backports.
