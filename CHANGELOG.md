# Changelog

All notable changes to this package are documented here.

## [0.1.3] — 2026-05-28

### Fixed

- **`federation.federatedQuery()`: deterministic tie-breaker on the
  candidate sort.** When two or more candidates tied on score (very
  common when consumers use a constant `ANCHOR_SCORE` for
  literal-entity matches — every anchored node collapses to the same
  numeric score), the final ordering was determined by V8's stable
  sort over the input order. The input order was the per-graph
  `Promise.all` completion order — which depends on disk I/O, ONNX
  call timing, and other non-deterministic signals.

  User-visible symptom: the same query against the same cortex
  returned a different "top result" on consecutive runs at narrow
  budgets (e.g. `maxNodes: 1` or `maxNodes: 3`). The Graphnosis App
  saw this as a flickering "top node" chip in Memory Studio when
  switching the slider position.

  Fixed by adding `(graphId, nodeId)` lexicographic as the secondary
  sort key:

  ```ts
  filtered.sort((a, b) =>
    (b.score - a.score) ||
    a.graphId.localeCompare(b.graphId) ||
    a.nodeId.localeCompare(b.nodeId),
  );
  ```

  The exact tie-breaker doesn't carry semantic meaning — what matters
  is that it's documented and consistent so the same query at
  different budgets always shows the same node at #1. Verified by the
  Graphnosis App's `recall.test.ts` H8 block (slider-equivalent
  stability): the assertion was promoted from "top-1 contains
  keyword" to "top-1 is the SAME node at every budget" and passes
  5/5 consecutive runs.

### Note for consumers

Anyone whose application relied on the previous (undefined) ordering
will see a stable change in which tied candidate surfaces first. In
practice this is exactly the intended behaviour — ordering should be
predictable.

## [0.1.2] — 2026-05-18

### Fixed

- **`crypto`: replace `createRequire('libsodium-wrappers-sumo')` with a
  static default import.** The previous pattern hid the dependency from
  bundlers performing static analysis; Bun's `--compile` stripped it
  from the output binary and the runtime then crashed at first encrypt
  with `Cannot find package 'libsodium-wrappers-sumo'`. The new import
  shape is bundler-friendly and runtime-identical (libsodium-wrappers-sumo
  exports `module.exports = sodium`, which ESM interop hoists to the
  default slot).

  Consumers running plain Node are unaffected. Bundler-using consumers
  must also override the libsodium package's broken ESM export map —
  see the in-file comment in `src/crypto/index.ts` for the
  `pnpm.packageExtensions` recipe.

## [0.1.1] — 2026-05-15

### Fixed

- Committed the `dist/` build output so git-tag installs work out of the
  box. v0.1.0 was unusable when installed via `https://github.com/.../.git#v0.1.0`
  because the package's `exports` field pointed at `./dist/...` which was
  gitignored. v0.1.0 tag remains for history but should not be used. If we
  ever ship this via npm, switch to a `prepare`-script flow instead of
  committing `dist/`.

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
