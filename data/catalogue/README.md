# Steam catalogue seed

`steam-top-1000-owners-2026-07-15.json` is the reviewed initial VaultShuffle starter set.

- Source: SteamSpy `request=all&page=0`
- Metric: estimated owners
- Capture date: 2026-07-15
- Rows: 1,000 unique Steam AppIDs
- Raw response SHA-256: `ce8a2085e2c7354d4ba50fe6abd6b675f7917d86e0e1015937b78320a76a6409`

SteamSpy was used only to obtain a broad set of established games. VaultShuffle does not store or expose the source ranking: the 1,000 entries are an unranked starter catalogue.

```bash
npm run catalogue:fetch-top
npm run catalogue:build-seed -- data/catalogue/steam-top-1000-owners-YYYY-MM-DD.json
```

Generated seed SQL is an operational artifact and should be removed after review and application. User-library imports register missing AppIDs for nightly enrichment; imports no longer start background catalogue workers. The protected nightly `/api/cron/catalogue-metadata` job drains the queue in bounded batches; `/api/catalogue/process` is retired. See [nightly worker policy](../../docs/nightly-workers.md). Duration enrichment and reviewed writeback are local-only.
