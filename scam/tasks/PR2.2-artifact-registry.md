# Task Contract: PR2.2 — Versioned artifact registry guidance

## Outcome
The pattern that pins in-flight processes to their `{id,version,digest}` across
rolling deploys (proven by test-shop) is promoted to a documented, reusable
contract for third-party hosts.

## Scope
- In: `docs/spi/ARTIFACT_REGISTRY.md`; a reference `ArtifactRegistry` guidance
  section; optional helper in host-adapter examples.
- Out: changing the `ArtifactRegistry` SPI signature.

## Affected module
`conductor/src/spi.ts` (`ArtifactRegistry`), docs.

## Acceptance — frozen
- [ ] Documented contract: immutability of `{id,version,digest}`, activation vs
      publication, and how new processes pick the active version while running
      processes stay pinned.
- [ ] A worked example (from the rolling v1→v2 resilience scenario) is referenced.

## Required tests
Docs; reuse existing rolling-update resilience evidence.

## Dependencies
PR2.1. **Priority** P1 · **Size** M · **Blocks stable** no.

## Docs
`docs/spi/ARTIFACT_REGISTRY.md`.
