# Contributing to graphnosis-secure-sync

Thanks for considering a contribution. This document covers what the
library is, how to contribute code, and the license implications
specific to this package.

## What this library is

`@nehloo-interactive/graphnosis-secure-sync` provides the local-first
**encrypted storage + sync primitives** extracted from the Graphnosis
App. Four small modules:

- `crypto`   — passphrase-derived key derivation (Argon2id),
              authenticated symmetric encryption (XChaCha20-Poly1305),
              file integrity check (HMAC).
- `oplog`    — append-only encrypted operation log with HMAC chain.
- `federation` — multi-graph query merging with per-graph subgraph
              budgets and sensitivity-tier redaction.
- `policy`   — graph sensitivity tiers (`public` / `personal` /
              `sensitive`) and the redaction rules the federated
              query layer enforces.

**Out of scope:**

- General-purpose cryptography (use libsodium directly).
- A database / KV store (we encrypt blobs the consumer provides;
  storage layout is the consumer's job).
- Network transport. The library is offline-by-default; if a future
  caller wants peer-to-peer sync, the wire protocol belongs in a
  *separate* package that depends on this one.

If your idea is bigger than "fix this bug" or "extend this primitive",
open an issue first so we can align on scope before you spend time.

## License — read this before contributing

This library is licensed **FSL-1.1-Apache-2.0** (Functional Source
License, Version 1.1, with Apache 2.0 as the Future License). See
[LICENSE](./LICENSE) for the full text. Two practical points for
contributors:

1. **Today (for the first two years after each release date)**, use of
   the library is free for personal use, internal use within an
   organisation, non-commercial use, and professional services around
   it. What's NOT allowed is *Competing Use* — bundling this library
   into a hosted service that competes with Graphnosis. This is
   roughly the same model BUSL adopters (Sentry, MariaDB Tools, etc.)
   use.

2. **Two years after each release**, that release auto-converts to
   plain Apache 2.0 — fully open source with no Competing Use
   restriction.

By contributing, you agree your contributions:
- May be relicensed by the project under the Apache 2.0 future
  license when the change-date triggers,
- Will not include code copied from incompatible-license projects
  (GPL / AGPL / proprietary). If you're porting a pattern from
  elsewhere, link the source so we can confirm the license is
  compatible.

A formal Contributor License Agreement is on the roadmap; for now,
opening a PR is sufficient acknowledgement of the above.

## Before you open a PR

1. **Open an issue first** for anything larger than a typo or a
   one-file bugfix. A PR that conflicts with project direction is
   wasted work for everyone.
2. **One concern per PR.** Smaller PRs review faster and merge sooner.
   Cosmetic refactors mixed with behaviour changes are particularly
   hard to review.
3. **Match the existing style.**
   - TypeScript strict mode, no `any` without a one-line justification
     in a comment.
   - Prefer pure functions where reasonable; minimise module-level
     state.
   - For anything in `crypto/` specifically: NO clever optimisations.
     Use libsodium primitives as-is, in their documented form. The
     library trades some performance for "this looks exactly like the
     reference implementation".
4. **Add tests** for bug fixes and new features. The `crypto/` and
   `oplog/` modules in particular shouldn't lose coverage.
5. **Update the CHANGELOG** in your PR. Add an `### Added` / `Fixed`
   / `Changed` entry under an `## [Unreleased]` section (we'll
   rename it on tag).
6. **Document any public API surface** with TSDoc.

## Local development

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/graphnosis-secure-sync.git
cd graphnosis-secure-sync

# 2. Install dependencies (pnpm only — npm/yarn will produce a
#    different node_modules layout that the build assumes)
pnpm install

# 3. Build the library
pnpm build

# 4. Type-check (catches anything pnpm build wouldn't)
pnpm typecheck

# 5. Make your changes on a branch
git checkout -b fix/your-thing

# 6. Commit with a clear message. Conventional commit style preferred:
#      feat: …       new feature
#      fix: …        bug fix
#      refactor: …   no behavior change
#      docs: …       readme / changelog / comments
#      chore: …      build / deps / version bumps
#      ci: …         workflow changes

# 7. Push and open a PR against `main`
```

The library compiles its TypeScript to `dist/`. That output IS
committed to git (because the package is installed via git tag, not
npm — consumers point `package.json` at
`git+https://github.com/nehloo-interactive/graphnosis-secure-sync.git#vX.Y.Z`).
When you change source under `src/`, run `pnpm build` BEFORE committing
so the `dist/` diff matches your source diff. Reviewers will reject
PRs where `dist/` is out of sync with `src/`.

## Releases (maintainers only)

The release flow is automated by `.github/workflows/release.yml`. To
cut a new version:

1. Land your changes on `main`.
2. Update `CHANGELOG.md`:
   - Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
   - Add bullets under `### Added` / `Fixed` / `Changed`.
3. Bump `package.json` version to `X.Y.Z`.
4. Commit: `chore: X.Y.Z`.
5. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. The workflow extracts the CHANGELOG section, fails loudly if it's
   missing or empty, and publishes a GitHub Release.

**No npm publish** today. This package is consumed by the Graphnosis
App via git tag. If/when it goes to npm, the workflow gets an
`npm publish` step (see the SDK repo's `publish.yml` as a template).

## Security issues

Please **do not** open a public issue for security vulnerabilities in
the crypto or oplog layers. Email `security@graphnosis.com` with:

- A description of the issue,
- A minimal reproducer (or steps),
- Your assessment of severity and disclosure timing.

We aim to acknowledge within 48 hours and have a fix in flight within
two weeks for high-severity issues.

## What we will NOT accept

- **New cryptographic primitives** not already in libsodium. If you
  need something exotic, propose it as a separate package layered on
  top of this one.
- **Performance "optimisations"** in `crypto/` that deviate from the
  libsodium reference patterns. We'd rather be slow and correct.
- **Vendored binary blobs** or large model files in this repository.
- **New runtime dependencies** without justification in the issue.
  Every new package is one more thing the consuming App has to
  audit and pin.
- **Breaking changes to the on-disk encrypted format** without a
  migration path and prior issue discussion.

## Recognition

Substantial contributions are credited in the CHANGELOG entry for
the release they ship in. We'll happily add sustained contributors
to a `CONTRIBUTORS.md` file when one exists.

Thanks for helping make graphnosis-secure-sync better.
