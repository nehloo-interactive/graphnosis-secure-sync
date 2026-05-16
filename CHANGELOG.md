# Changelog

All notable changes to this package are documented here.

## [0.1.0] — 2026-05-15

### Added

- Initial extraction from `@graphnosis-app/core` (Graphnosis App
  monorepo). Surfaces the four modules previously buried in the App as
  workspace dep: `crypto`, `oplog`, `federation`, `policy`, plus the
  shared types they depend on (`DeviceId`, `GraphId`, `NodeId`,
  `OpKind`, `OpLogEvent`, `SubgraphBudget`).
- No source-level changes — this is a lift-and-shift to establish a
  versioning boundary and let the security + sync layer evolve
  independently of App churn.

### Context

The App `packages/graphnosis-app-core/` retains the App-specific glue
(`settings`, `sources`, `embeddings`) and consumes this package as a
git dep pinned to `v0.1.0`.
