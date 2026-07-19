# Contributing

Thanks for your interest in ProcessEngine.

## Project status

ProcessEngine is an early `0.1.x` developer preview under active foundational
work. The public API is being curated toward `0.2.0` (see
`processengine/docs/SEMVER_POLICY.md`), and the roadmap lives in
`docs/production-readiness/PLAN.md`.

## External contributions and relicensing

The `1.0` license has **not** been decided yet (see
`docs/decisions/ADR-002-licensing.md`). To keep that decision open, we are **not
yet accepting external code contributions** that would constrain future
relicensing. A Developer Certificate of Origin (DCO) sign-off alone does not grant
the right to relicense your contribution; if broader flexibility is needed once
contributors appear, a suitable CLA or explicit rights-holder consent will be
required first.

Until then, the most useful contributions are:

- issues: reproducible bugs, and design questions about the canon or SPI;
- documentation feedback.

If you want to propose code, please open an issue first to discuss.

## Development

Requirements: Node.js `>=22` and npm; Docker Desktop with Kubernetes for the
reference contour.

```bash
# framework only
cd processengine && npm install && npm run check && npm run api:check && npm run check:packages

# whole contour, deterministic gate against your worktree
npm run check:local
# … or against the published release
npm run check:registry
```

- The canon (`processengine/docs/PROCESSENGINE_CANON.md`) is normative. Changes to
  the DSL, state model, or the fixed architectural principles are out of scope for
  ordinary contributions.
- Public API changes must update the committed API reports
  (`npm run api:report`); CI fails on unreviewed surface drift.
- Operation contract schemas must stay within the documented profile
  (`processengine/docs/OPERATION_SCHEMA_PROFILE.md`).

## Commit and PR hygiene

Keep commits logically scoped with a clear message. Do not commit generated
artifacts, caches, credentials, or Kubernetes Secret values.
