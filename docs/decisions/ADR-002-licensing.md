# ADR-002: Keep Apache-2.0 for the 0.x line; leave the 1.0 license open

- **Status:** Accepted
- **Date:** 2026-07-19
- **Scope:** licensing of the three public `@processengine/*` packages and the repo

## Context

`0.1.0` was published under **Apache-2.0**, and package manifests, lockfiles, and
registry metadata already carry it. An explicit patent grant is useful for an
enterprise-oriented framework. The `1.0` license, however, has not been decided.

## Decision

- The `0.x` line stays **Apache-2.0**. It is not changed as part of this
  foundation milestone.
- The already-granted Apache-2.0 license for `0.1.0` is **irrevocable**; it cannot
  be retroactively withdrawn from what was published.
- The **`1.0` license is deliberately left open**: it may end up MIT, Apache-2.0,
  or a dual-licensed arrangement chosen by the rights holder. Production-readiness
  tasks must require consistency with *the chosen project license*, not a
  perpetual Apache-2.0 mandate.
- Until the `1.0` license is decided, external code contributions that could block
  relicensing are **not accepted**. A DCO sign-off alone does not grant unilateral
  relicensing rights; a CLA or explicit rights-holder consent would be required if
  that flexibility becomes necessary (see `CONTRIBUTING.md`).

## Consequences

- External consumers of `0.1.x` can rely on Apache-2.0 today.
- The project retains freedom to choose the `1.0` license, provided it does not
  accept relicensing-blocking contributions in the meantime.
