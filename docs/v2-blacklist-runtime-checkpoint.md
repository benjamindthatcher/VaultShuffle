# Blacklist runtime checkpoint

## 12 September 2026 — runtime/UI conversion complete

Runtime and UI now use `Blacklisted` as the permanent inactive game status.
The `Blacklisted` shelf replaces the Library `Slept` shelf; active library,
Vault pool/current-pick selection, pins, smart collections, and optimistic
client state all exclude it. The only return path is the existing manual
`restore_user_game_active` RPC, now presented as **Reactivate**.

The app no longer defines, maps, validates, sends, sorts by, or learns from a
Sleep-only timestamp. `Game.slept_at`, `DemoGame.sleptAt`, PATCH `slept_at`, and
the accidental blacklist timestamp replacement are absent. A Blacklist PATCH
sends only `status: "Blacklisted"` (and the explicitly requested completion
clear where applicable). The genre-preference worker does not manufacture a
dated blacklist signal. Existing Vault snooze action/history variants and
completion behavior remain unchanged. Existing ordinary draw/purge action codes
are now `blacklist`, without creating a new history mechanism.

Reviewed SQL boundary supplied by `m3_preservation_integration`:

- `set_user_game_status(uuid, uuid, text)` will accept `Blacklisted` and reject
  `Slept`; this runtime calls it with `p_status: "Blacklisted"`.
- `restore_user_game_active(uuid, uuid)` remains the Reactivate path and is
  idempotent for Blacklisted or Completed rows.
- V2's minimal state is `app.game_state.blacklisted boolean NOT NULL DEFAULT
  false`; there is no expiry or timestamp. SQL/schema work remains A-owned.

Focused validation:

```text
node --experimental-strip-types --test \
  lib/blacklist-runtime.test.ts lib/vault.test.ts \
  lib/smart-collections.test.ts lib/completion-check.test.ts \
  lib/pinned-playtime-view.test.ts
# 70 passed, 0 failed

npx tsc --noEmit --pretty false
# passed

npm run build
# passed; Next.js 16.3.0 production build compiled, type-checked and generated 54 pages

git diff --check
# passed
```

The new `lib/blacklist-runtime.test.ts` proves active -> Blacklisted -> excluded
past 90 days -> manual Reactivate, and verifies that the request schema accepts
Blacklisted without a date while rejecting the retired `Slept` literal and
blacklist timestamp payload.

Scoped ESLint returned only existing warnings in Library, Vault, and
AppDataProvider about synchronous effect state updates, hook dependencies, and
`window.location.assign`; it reported no errors. No production write, migration
application, commit, or deployment was performed.

## 12 September 2026 — review correction: standing preference signal

Review found that removing `slept_at` also removed the existing blacklist
negative preference and game-verdict contribution. Corrected it without adding
a blacklist timestamp, event, or history record. `fetchPurgeDecisions` now
loads current `user_games.status = 'Blacklisted'` as an undated `standing`
`decision:blacklist` input, with full existing signal weight and no decay.
Completed decisions continue to use their real `completed_at` and normal decay.

Standing rows are deterministically capped per user before dated decisions;
AppID is the stable tie-breaker. A current standing blacklist suppresses its
matching `vault_draw_events.blacklisted` signal for the same user/AppID, so a
single current decision cannot double count. Once reactivated, the standing row
is absent and any historical draw action remains ordinary decaying evidence.

Extracted pure optimistic patch/reactivation behavior into `lib/game-state.ts`
so the runtime test now exercises active -> Blacklisted -> far-future
clock-independent eligibility -> `restoreActiveGame` manual Reactivate ->
active eligibility. It also rejects the original `Slept` plus `slept_at`
payload and the invented `blacklisted_at` payload.

Focused validation:

```text
node --experimental-strip-types --test \
  lib/blacklist-runtime.test.ts lib/genre-preferences.test.ts
# 32 passed, 0 failed

npx tsc --noEmit --pretty false
# passed

git diff --check
# passed
```

Scoped ESLint produced only three pre-existing AppDataProvider warnings
(effect dependencies and internal `window.location.assign`); no lint errors.
A was asked to migrate existing user-tuned `algorithm_weights` keys atomically:
`event:slept` -> `event:blacklisted` and `decision:sleep` ->
`decision:blacklist`, preserving `positive`, `total`, and `note`. Runtime uses
only the new keys; this SQL compatibility migration remains A-owned.

## 12 September 2026 — final runtime acceptance

Replaced the misleading unused far-future parameter with a real `node:test`
`mock.timers` Date override. The Blacklisted eligibility assertion now runs at
2030-04-01 against the actual process clock and remains excluded. The same test
uses the extracted production `applyGamePatch` and `restoreActiveGame` helpers,
so its manual Reactivate assertion follows the client behavior rather than
constructing a status object. Validation now explicitly rejects both
`{ status: 'Slept', slept_at: ... }` and `{ status: 'Blacklisted', slept_at:
... }`, alongside the invented `blacklisted_at` field.

Added `e2e/blacklist-guest.spec.ts`: the local guest UI flow opens Library,
blacklists a visible active card, verifies it on the Blacklisted shelf, uses the
visible Reactivate menu action, and verifies it is back on Active. It touches no
real account or source data.

```text
node --experimental-strip-types --test lib/blacklist-runtime.test.ts
# 2 passed, 0 failed

npx tsc --noEmit --pretty false
# passed

npx eslint lib/blacklist-runtime.test.ts e2e/blacklist-guest.spec.ts
# passed

git diff --check
# passed
```

Playwright was attempted with
`npx playwright test e2e/blacklist-guest.spec.ts --project=chromium`. The
sandbox first refused its local `127.0.0.1:8799` listener (`EPERM`). The required
local-only escalation was then automatically rejected because the account usage
limit was reached. No workaround was attempted. The test is ready for the next
available local Playwright run; this is the only remaining runtime acceptance
step.

## 13 September 2026 — guest browser acceptance passed

The deferred local Playwright acceptance was run successfully with the approved
local-only listener permission:

```text
npx playwright test e2e/blacklist-guest.spec.ts --project=chromium
# 1 passed (15.6s)
```

It builds and starts the local Next test server only, then verifies the guest
Library flow Active -> Blacklist -> Blacklisted shelf -> visible Reactivate
menu action -> Active. No real account, source, target, or remote service was
used. The prior listener-only sandbox refusal is resolved; no runtime acceptance
work remains in this checkpoint.
