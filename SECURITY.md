# Security Policy

## Status

ProcessEngine is a `0.1.x` developer preview. It is not yet hardened for
production: transport is PLAINTEXT and storage credentials are unrotated in the
reference contour (see `docs/production-readiness/PLAN.md`). Do not run it against
sensitive data without the security work tracked in that plan.

## Supported versions

While on `0.x`, only the latest published `0.1.x` line receives security fixes.

| Version | Supported |
| --- | --- |
| `0.1.x` | ✅ |
| `< 0.1` | ❌ |

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in public issues:

- Use GitHub's **private vulnerability reporting** for
  `processengine/framework` (Security → Report a vulnerability), or
- open a minimal public issue asking for a private channel **without** disclosing
  details.

Include affected package and version, a reproduction, and the impact. We aim to
acknowledge within 5 business days. Please allow a reasonable disclosure window
before making details public.

## Scope

In scope: the three published packages (`@processengine/conductor`,
`@processengine/transport-kafka`, `@processengine/storage-postgres`) and the
release/publish pipeline. The `test-shop` reference contour is a developer
example, not a production deployment target.
