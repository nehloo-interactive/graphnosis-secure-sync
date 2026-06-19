# Changelog

All notable changes to this package are documented here.

## [0.2.2] — 2026-06-19

### Added

- **`readEventsSince(dir, key, { sinceTs, sinceSeq?, ...readOpts })`** — tail-read
  helper for incremental op-log reconcile. Returns events with `ts > sinceTs`, or
  at `sinceTs` with `seq > sinceSeq` when `sinceSeq` is set. Shares integrity
  verification and future-ts clamping with `readAllEvents`; only the returned
  array is filtered (callers still decrypt all chunks on disk today).

## [0.2.1] — 2026-06-09

### Changed

- **`shareableGraphs` / `federatedQuery` accept an optional `allowGraphIds`
  explicit allow-list.** Engrams the caller has authorised out-of-band (e.g. an
  app-side per-engram consent gate that approved an explicitly-named sensitive
  engram) bypass the shareability filter so a consented sensitive recall
  actually returns data — still clamped by the per-tier budget cap (sensitive =
  500 tokens / 5 nodes). Without an allow-list behavior is unchanged: sensitive
  stays non-shareable, so proactive recall never leaks it. This fixes the case
  where a sensitive engram returned zero data to the AI even when explicitly
  named and consented. The `sensitive`-tier backstop from 0.2.0 (`shouldShare`
  hard-stops sensitive) remains the default; the allow-list is an explicit,
  per-call override.

## [0.2.0] — 2026-06-09

Security release. Authenticated, tamper-evident op-log; a recovery-wrap fix; and
hardening of at-rest file permissions and the federation tier guard.

### Security

- **Op-log v2: per-device Ed25519 signatures + monotonic sequence (format
  change).** Op-log chunks were AEAD-encrypted with the shared cortex key but
  carried no per-device authentication or sequence number, so a party with
  write access to the synced directory could drop, truncate, reorder, or replay
  whole chunks undetected, and a party holding the data key could forge events
  for any device. v2 signs every chunk with the originating device's Ed25519 key
  (verified against a TOFU-pinned public key) and stamps each event with a
  strictly-monotonic per-device `seq`. The reader now detects gaps (drops),
  rewinds (replays), and reorders, **clamps future timestamps** so a poisoned
  `ts` can't win last-writer-wins, and **surfaces integrity problems loudly**
  instead of silently skipping them. Legacy v1 files are still read
  (grandfathered). Verification is opt-in via `readAllEvents`'s new
  `getDevicePubKey` / `onIntegrityIssue` options. New `OpLogEvent.seq`,
  `OpLogIntegrityIssue`, `OPLOG_V2_MAGIC`, `encodeSignedChunk`, and Ed25519
  helpers (`generateSigningKeyPair`, `sign`, `verify`) in `crypto`.
- **`makeRecoveryWrap` derived its key and stored salt from two independent
  Argon2id passes** — the wrapping key came from salt A while the blob stored
  salt B, so `unwrapRecovery` could never recover the key and every recovery
  wrap was permanently undecryptable. Now derives once and reuses. **Any
  recovery phrase generated before this release is non-functional; users must
  regenerate it.**
- **Sensitive-tier federation backstop.** `shouldShare` / `shareableGraphs` now
  treat a `sensitive`-tier engram as never-shareable regardless of its
  `shareWithAi` flag, an independent guard against a policy that decouples the
  two axes (e.g. an env-supplied policy) and flips `shareWithAi:true` on a
  sensitive engram.
- **Restrictive at-rest permissions.** The op-log directory and files are now
  created `0o700` / `0o600` so other local users can't read or copy them.

### Notes

- Op-log v2 is a backward-incompatible file format (older readers can't parse v2
  files). v1 files remain readable by this version. Hence the minor bump.

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
