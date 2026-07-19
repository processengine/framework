# Versioning and deprecation policy

The three framework packages — `@processengine/conductor`,
`@processengine/transport-kafka`, `@processengine/storage-postgres` — follow
[Semantic Versioning](https://semver.org). While the line is `0.x` it is a
developer preview: minor versions may contain curated breaking changes, always
documented in the changelog and the API reports.

## Public surface

The public surface of each package is exactly its curated entrypoint(s):

- `@processengine/conductor` — the root export and the `@processengine/conductor/testing`
  subpath;
- `@processengine/transport-kafka` and `@processengine/storage-postgres` — their
  root exports.

Anything reachable only through deep source paths (e.g. an internal `dist/kernel.js`)
is **not** public and may change in any release. The committed API reports under
`processengine/api-reports/` are the source of truth; CI fails if the surface
changes without an updated, reviewed report.

## What counts as breaking

- Removing or renaming a public export.
- Changing a public type in a way that rejects previously valid callers.
- A flow/compiler change that makes a previously compiling flow fail, or that
  changes its normalized digest.

Such changes require a minor bump while on `0.x`, and a major bump from `1.0`.

## The curated surface change is a `0.2.0`

Curating the previously `export *` root of `@processengine/conductor` removes
incidental exports (internal kernel/JSON/schema helpers) that were never intended
as contract. Because removing already-published root exports is potentially
breaking, this is prepared as part of the next minor, **`0.2.0`** — not a patch.
No version bump or publish is performed as part of this preparation.

## Deprecation

A public export slated for removal is first marked `@deprecated` in its TSDoc with
the replacement and the earliest version in which it may be removed. Deprecations
are listed in the changelog. A deprecated export is not removed before the next
minor (0.x) or major (>=1.0) boundary.
