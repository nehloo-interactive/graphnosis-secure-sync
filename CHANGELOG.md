# Changelog

All notable changes to this package are documented here.

## [0.4.0] — 2026-08-03

Federated recall stops being all-or-nothing, stops paying twice for the same
memory, and stops hiding what it did not read.

**This release breaks compilation for every consumer of `federatedQuery`, on
purpose.** The old return type let a caller reach `prompt` and send it to a
model without ever discovering that an engram had failed — a partial answer and
a complete one were the same shape, so "your engram holds no such memory" and
"we could not read your engram" arrived indistinguishable. The result is now a
discriminated union on `complete`, and `prompt` exists only on the complete
branch. Every one of the sites it breaks is a place that could have shipped a
silent false negative to a user; the compiler now stops there instead. Note that
the app replaces this module's `renderPrompt` with its own rich render, so its
disclosure of a gap has to come from `failures`, not from the rendered banner.

**Migration cost, measured.** Typechecking `apps/desktop-sidecar` against this
draft — app worktree unchanged, SDK held constant, only this package swapped for
0.3.x — produces **33 errors across 7 files**: `mcp-server.ts` (15), `ipc.ts`
(5), `brain-engine.ts` (5), `host/recall-methods.ts` (4), `agent-tools.ts` (2),
`skill-trainer.ts` (1), `goal-tracker.ts` (1). 24 are `prompt` on an unnarrowed
result; 9 are a count read off an unnarrowed audit row. All 33 are the consumer
not having adopted the new API — none indicates a defect in this module, and all
33 clear with call-site narrowing alone, with no loosening of these types. An
earlier draft of this entry claimed "six sites in `host/recall-methods.ts` (lines
45, 83, 103, 130, 419 and 577)"; that was never measured and every part of it was
wrong, including the file count. Numbers here now come from a run.

**What the compiler will NOT catch — audit these by hand.** `audit.length` and
any count derived from it typecheck identically before and after, so a consumer
that only counts rows migrates silently:
- A **failed** engram is still a row in `audit`. Anything of the form
  `audit.length - contributing.length` will report it as "searched, no matches"
  — the exact false negative this release exists to remove. The row carries no
  counts, so the `contributing` filter beside it fails to compile and forces you
  to the site; the subtraction on the next line is yours to fix.
- `audit` no longer contains withheld engrams at all (see below), so its length
  keeps its 0.3.x meaning: engrams asked.

### Changed

- **`federatedQuery` returns a discriminated union.** `{ complete: true, prompt,
  … }` or `{ complete: false, failures, partialPrompt, … }`. Consumers must
  narrow on `complete`; the incomplete branch names its rendering
  `partialPrompt` so that reading a context assembled from unread engrams is an
  explicit act at the call site rather than a field nobody inspects. Partial
  evidence is never discarded — `byGraph`, `audit` and the counts are on both
  branches.
- **`audit` is `QueriedGraphAudit[]` — a union of `AnsweredGraphAudit |
  FailedGraphAudit` — and withheld engrams move to their own `withheld` array.**
  `AttachedGraphAudit` is gone. Reading `nodesIncluded` off an audit row now
  requires narrowing on `status`, which is what makes the "a row with zero nodes
  means the engram had no matches" misreading fail to compile: a failed row
  carries no counts at all, because a zero on it means "unknown".

  Withheld rows are in a separate array rather than merged into `audit`, which
  reverses an earlier draft of this release. Refusing to put counts ON a
  withheld row does not close the channel if the row still lands in the array a
  caller COUNTS. Merged, `sub.audit.length` silently grew by the number of
  withheld engrams, and the desktop app's "(N other engram(s) searched, no
  matches.)" footer — text that reaches the model — went from 1 to 3 on a scope
  holding one `sensitive` and one `shareWithAi: false` engram, telling the model
  how many engrams the user is holding back. Measured against both builds, not
  inferred. It was also the one hazard the union could not flag, since
  `audit.length` typechecks the same either way, and it survived a careful
  migration: adopting the compiler's demands at the site above leaves the
  subtraction on the next line still wrong. Separating the arrays closes it
  structurally, and serves the original goal better — telling a deliberately
  withheld engram from one that was never in scope is now a direct read of
  `sub.withheld`, with no join against the requested ids.
- **`shouldShare` is defined in terms of the new `withholdReason`.** One
  implementation of the rule, so an audit can never claim a different reason
  than the filter actually used. Behaviour is unchanged.

### Fixed

- **One failing engram no longer costs the user every other engram's answer.**
  The per-graph queries ran under `Promise.all`, so a single rejection threw
  away every result that had arrived. They now settle independently, and each
  failure becomes both a `status: 'failed'` audit row and a `GraphFailure`
  carrying the engram's tier and whether it errored or timed out. A failed
  engram is disclosed to the model in the rendered context, so it cannot assert
  an absence it never verified.
- **An engram that hangs can no longer stall a recall forever.** Tolerating
  failure did nothing for a promise that never settles — a stalled mount or a
  lock held open left the whole recall waiting with no error, no result and no
  end. Every runner call now races a per-graph timeout. The clock necessarily
  starts at dispatch, because the runner contract gives federation no way to
  observe when a queued call actually begins, so the default allowance grows
  with the number of engrams in scope (15s, plus 5s per additional engram)
  rather than punishing an engram for the queue ahead of it. This is
  timeout-and-ignore, not cancellation: real cancellation needs an `AbortSignal`
  through `FederatedQueryRunner` and is deliberately left for a later decision.
- **The same memory in two engrams no longer buys itself twice.** With no dedup
  of any kind, a note synced between two devices spent the token budget twice
  and displaced distinct evidence. Content is now collapsed before budgeting.
  Nothing is ever dropped on a hash match alone: the fingerprint is a bucket
  key and the normalized content is compared inside the bucket, so two different
  memories that collide under 32-bit DJB2 both survive — the failure mode that
  silently deleted evidence in the SDK's own federation path. Which copy
  survives is deterministic (lowest sensitivity tier first, then the existing
  score / graphId / nodeId order), so a duplicate never charges the scarce
  `sensitive` cap for content a public engram already provides.
- **Withheld engrams are reported instead of vanishing.**
  `shareableGraphs` filters before the audit is built, so a `sensitive` engram
  excluded by tier and a `shareWithAi: false` engram excluded by flag were
  absent from the result entirely — the record that PROVES the privacy guarantee
  fired was the one record dropped, and no consumer could tell a deliberately
  withheld engram from one that was never in scope without joining the audit
  against the ids it had requested. Every requested engram is now accounted for
  exactly once, across `audit` (asked) and `withheld` (kept out), each in request
  order; a withheld row states which rule withheld it (`sensitive-tier` vs
  `sharing-disabled`). It carries the graphId, tier, status and reason and
  nothing else — no counts of any kind, structurally, and it is not in the array
  callers aggregate, because a record that proves an engram was not read must not
  become a channel for inferring what is in it, by count any more than by field.
  Withheld engrams are never named in the model-facing context, since disclosing
  the withholding would disclose the engram — and that is now structural too,
  since `renderPrompt` is only ever handed `audit`.

### Added

- `FederatedQueryOptions` (`{ timeoutMs }`) as an optional final argument to
  `federatedQuery`, and `resolveTimeoutMs(graphCount)` for the default.
- `federationFailures(sub)`, `contentFingerprint(text)`, and the
  `withholdReason` / `WithheldReason` pair in the policy module.

### Tests

- 41 added (74 total). 32 exercise federation's arithmetic against injected
  runners; 9 run against a real seven-engram `.gai` cortex through the
  conformance fixture's `FederatedQueryRunner`, including a genuine 32-bit DJB2
  collision, a 454-content duplicate pair across two engrams at different tiers,
  a corrupt engram and a never-settling one. Two of the 41 pin the count channel
  specifically: that a withheld engram does not move `audit.length`, and that a
  failed engram cannot be summed into "searched, no matches". The fixture is not vendored — those
  tests skip when it is absent, and `MOCK_CORTEX_RUNNER` points them at a
  non-default checkout.
- Every fix was verified differentially against the pre-fix module compiled from
  the previous commit, so each test is known to fail against the code it
  replaces. The compile-time half of the union guarantee is checked with a `tsc`
  probe rather than a runtime assertion.

## [0.3.2] — 2026-07-27

### Security

- **Encrypted streams must now prove they are complete.** Each chunk was already
  individually authenticated, so tampering was caught; what was not established is
  that the stream being read is the whole stream. A reader now requires the
  end-of-stream marker and rejects anything that follows it, so a partial payload
  can no longer be returned as though it were the entire one.

### Fixed

- **Op-log writes are durable across shutdown.** The resume point is now recorded
  from the entries actually written rather than from the in-memory counter, which
  could run ahead while a write was still in flight and cause the next launch to
  skip entries that never reached disk. A new `drain()` awaits the buffer and
  should be called on shutdown.
- **A failed op-log write no longer discards its batch.** Entries are returned to
  the buffer and retried instead of being dropped when a write fails.
- **Empty payloads encode explicitly.** An empty payload now writes one
  end-marked chunk rather than none, so it is distinguishable from a stream
  truncated to nothing. Reading an empty body stays backward compatible.

### Tests

- 10 added (33 total): end-marker enforcement across every chunk boundary,
  data-after-end, empty round-trip, bit-flip and foreign-blob controls, resume-point
  bounds, gap-free shutdown, and batch survival across a failed write.

### Note

- `package.json` was not bumped for 0.3.1; it moves to 0.3.2 here and matches the
  tag again.

## [0.3.1] — 2026-07-26

### Security

- **Strengthened op-log chunk verification.** The events inside a signed chunk
  are now bound to the header that signs them — a chunk whose contents disagree
  with what its signature actually covers is rejected whole rather than
  partially trusted.

### Tests

- Added coverage for chunk/header agreement and for event ordering within a
  chunk, plus a regression guard asserting that chunks pruned by compaction —
  which legitimately leave sequence gaps — remain valid. Suite green (23).

## [0.3.0] — 2026-06-23

### Changed

- **Deterministic LWW merge.** Last-writer-wins is now resolved by a strict
  total order over `(timestamp, deviceId, seq)` instead of timestamp alone, so
  concurrent operations with equal timestamps converge identically regardless
  of arrival order. Delete operations leave tombstones, so deletes commute with
  concurrent edits. The reduction is permutation-invariant — the same set of
  operations always yields the same state (Theorem 2 determinism).

### Tests

- Added 4 permutation/determinism cases asserting order-independent
  convergence and tombstone behaviour (full suite green).

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
