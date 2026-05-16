# graphnosis-secure-sync

Local-first encrypted storage and sync primitives. A small TypeScript
library with four loosely-coupled modules:

- **`crypto`** — passphrase → Argon2id key derivation, XChaCha20-Poly1305
  authenticated encryption, BIP-39 recovery-phrase wrapping. The only
  runtime dependency is `libsodium-wrappers-sumo`.
- **`oplog`** — encrypted append-only event log per device, with a
  multi-device merge reducer (last-writer-wins). Built on `crypto`.
- **`federation`** — query runner aggregator across multiple graphs, with
  per-graph and global token/node budget enforcement and sensitivity-tier
  filtering.
- **`policy`** — sensitivity tier definitions (public / personal /
  sensitive), per-tier node redaction, budget estimation.

## Origin

These primitives were extracted from
[Graphnosis App](https://github.com/nehloo-interactive/graphnosis-app)
— a personal second-memory desktop app — and serve as the encrypted
multi-device storage layer beneath the
[Graphnosis SDK](https://github.com/nehloo/Graphnosis) (Apache-2.0)
knowledge-graph engine.

They were factored out because the security + sync layer is general:
any local-first encrypted multi-device app could use the same shape.

## Status

Private, pre-1.0. Used in production by Graphnosis App. APIs may shift
across `0.x` releases. Versioning is semver-stable from `0.1.0` onward;
breaking changes bump the minor.

## Install

While this package is private, consumers can depend on it via a git tag:

```json
{
  "dependencies": {
    "@nehloo-interactive/graphnosis-secure-sync": "github:nehloo-interactive/graphnosis-secure-sync#v0.1.0"
  }
}
```

It will be published to npm once the API surface stabilizes.

## Modules

```ts
import { crypto, oplog, federation, policy } from '@nehloo-interactive/graphnosis-secure-sync';
import type { DeviceId, GraphId, OpLogEvent, SubgraphBudget } from '@nehloo-interactive/graphnosis-secure-sync';
```

Each module is also importable on its own:

```ts
import { encrypt, decrypt } from '@nehloo-interactive/graphnosis-secure-sync/crypto';
import { writeEvent, readEvents } from '@nehloo-interactive/graphnosis-secure-sync/oplog';
```

## License

[Functional Source License, Version 1.1, Apache 2.0 Future
License](LICENSE) — `FSL-1.1-Apache-2.0`. Read, audit, fork, modify,
self-host the code freely; commercial competing-service use is restricted
during the 2-year exclusivity window after each release, after which the
release auto-converts to Apache 2.0.

---

Made by Nehloo Interactive LLC.
