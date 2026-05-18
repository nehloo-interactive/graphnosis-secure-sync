# Changelog

All notable changes to this package are documented here.

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
