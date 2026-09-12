# M3 remaining-domain transform contract

The three loader-facing pure entry points, frozen:

- `transformRecoConfigBatch` — [`lib/v2/migration/transform/reco-config.ts`](../lib/v2/migration/transform/reco-config.ts)
- `transformSupportOpsBatch` — [`lib/v2/migration/transform/support-ops.ts`](../lib/v2/migration/transform/support-ops.ts)
- `transformLegacyOperationsBatch` — [`lib/v2/migration/transform/legacy-operations.ts`](../lib/v2/migration/transform/legacy-operations.ts)

Each accepts the same-run `runIdentity`, the identity transform's
`AccountMapTargetRecord[]`, and (where required) the catalogue `GameMap`. Each
returns `run_identity`, target-shaped rows in a deterministic order, and an
explicit `blockers` array. No entry point reads a clock, an environment
variable, a file or a database; `source_snapshot_hash` stays 64-character hex
until the loader encodes it as `bytea`, and every `jsonb` value is carried as
exact source text with a UTF-8 byte measure, never re-serialised.

Shared vocabulary, error codes and readers live in
[`remaining-shared.ts`](../lib/v2/migration/transform/remaining-shared.ts).
Errors are `RemainingTransformError` with a stable `remaining_*` code, the
relation, the field and a count — never an email address, a message, a settings
value, a digest or an account UUID.

## Blockers versus errors versus withheld rows

Three distinct outcomes, deliberately not collapsed into one:

* **Error** (`RemainingTransformError`): the input is malformed or a target
  CHECK cannot be satisfied by any representation of the row. The batch stops.
* **Blocker**: a decision this transform refuses to make on its own. The rest
  of the batch still transforms; the loader treats a nonempty `blockers` array
  as a pre-commit gate. Blockers carry counts and prose only.
* **Withheld row**: a typed record the loader must never write, carrying the
  exact source values so nothing is lost. `withheld_counters` (reco) and
  `withheld` (support) are the two streams.

## `transformRecoConfigBatch`

Sources: `user_genre_preferences`, `genre_preference_globals`,
`game_preference_globals`, `algorithm_weights`, `app_settings`.

* **One frozen snapshot.** Every `reco.*` child is keyed by `snapshot_id` in
  the target, and `reco.warm_start_snapshots.id` is `generated always as
  identity`. The transform emits the snapshot record **without** an id and the
  children **without** a `snapshot_id`: the loader inserts the parent, takes
  the returned id, and stamps it. No surrogate key is invented here.
* **Supplied evidence, never a clock.** `snapshot_key`, `snapshot_version`
  (a positive integer, not text), `frozen_at`, and the operator
  `config_version`/`effective_at` come from the caller. Malformed or absent
  evidence fails rather than defaulting.
* **`double precision` is read as text.** The COPY cell is PostgreSQL's
  shortest round-trip rendering of the float, which is the exact value; it is
  parsed as a decimal and never passed through a JavaScript number.
* **The precision boundary is real.** A float8 carries up to 17 significant
  digits; `numeric(30, 12)` does not. Such a row is **withheld** into
  `withheld_counters` with its exact source text plus a `counter_unrepresentable`
  blocker — never rounded, which would change a recorded counter. Root decides
  whether the column widens or the precision loss is acceptable.
* **`positive <= total`** is compared exactly on decimal text and fails closed.
* **A global counter for an uncatalogued app keeps its AppID** with a NULL
  `game_id` (the target FK is `on delete set null`).
* **`app_settings` collapses only verified keys.** `VERIFIED_PREFERENCE_KEYS`
  is explicit. An unrecognised key, or one matching the credential-shaped
  pattern, is returned only in the non-loadable `withheld_settings` stream
  with a blocker. It is never written to expiring
  `migration.legacy_account_preferences_evidence` or the durable, exported
  `app.account_preferences`. The loader must count this stream as a
  pre-commit exception; values are never logged or copied into a blocker.
* **A text setting stays text.** Values are encoded as jsonb *strings*;
  `"123"` and `"true"` are not retyped into a number or a boolean.
* The collapsed document's `updated_at` is the newest contributing source row's
  instant, and its keys are emitted sorted so the text is order-independent.

## `transformSupportOpsBatch`

Sources: `contact_messages`, `feedback_submissions`.

* **Authorship is preserved or the row is withheld.** The target enforces
  `(account_id is null) = (source_account_public_id is null)`. An anonymous
  submission (source `user_id` NULL) loads with both NULL. A submission whose
  author is absent from the same-run account map is **withheld** with
  identifiers only — no message, subject, email or context — plus a
  `support_author_unmapped` blocker. Anonymising it would detach a named
  person's own words from their deletion request.
* **Content is exact.** Subject and message keep their surrounding whitespace
  (bounds are measured on the trimmed text, as the target measures them).
  Email, route, app area and client context are verbatim.
* **`client_context`**: a source NULL becomes the target's `'{}'`; a non-object
  document fails closed rather than being wrapped.
* **`updated_at` for feedback** reuses the row's own `created_at` — the source
  relation has no update clock and the target requires one. A real source
  instant in a differently-named column, never a migration clock.
* **`dedupe_hash`** must be 64 lowercase hex characters or the row fails; it is
  never trimmed or lowercased into a different digest. A genuinely absent hash
  is allowed (the target column is nullable).
* **Retention stays open.** `support.retention_policy_decisions` is emitted as
  one `pending` row with no `decided_at`, and every migrated row references it,
  so one later M6/M7 decision applies to all of them. A
  `support_retention_policy_pending` blocker records that.

## `transformLegacyOperationsBatch`

Sources: `metadata_worker_runs`, `steam_import_jobs`, `api_rate_limits`,
`account_merges`, `manual_profile_security_intents`.

* **Worker runs become bounded, expiring evidence.** `run_class` is derived
  from the source status — `succeeded` → routine, `partial`/`failed` →
  failure, `running` → unknown — and `retention_until` is `started_at` plus 14
  days (routine/unknown) or 30 (failure), computed in exact microseconds from
  the source instant. No clock is read. The source's own
  running-implies-no-finish CHECK is enforced rather than repaired.
* **An import job becomes an operator report, never a resumable job.**
  `migration.legacy_import_freeze_report` has no column for the lease token,
  the lease instant or the in-flight `games` payload, and all three are named
  in `IMPORT_JOBS_RETIRED_SOURCE_COLUMNS` with the surviving fact. A row still
  `importing` at the snapshot raises an `import_in_flight_at_snapshot` blocker
  (D-IMP-1): **which** accounts need a re-run cannot be known before the real
  freeze, so this count is evidence from this snapshot, not the cutover answer.
* **Rate limits need supplied cutover evidence.** `ops.abuse_cooldowns`
  requires an observation instant and an algorithm version that
  `api_rate_limits` does not carry. Without them **no cooldown row is emitted
  at all** and a `cooldown_cutover_evidence_absent` blocker is raised — reading
  a clock would silently extend or expire real cooldowns. With an observation
  instant but no window length, every row is `status = 'unknown'` with a NULL
  expiry (D-ABUSE-3) rather than assumed active or expired. `account_id` is
  always NULL: a digest is not reversible into an account, and guessing would
  attach a stranger's cooldown to a real person. Nothing is reset or activated.
* **Merges produce the durable row, the alias and the audit.** `mode` is
  derived from whether the two mapped accounts are the same row, because
  `ops.account_merges`' CHECK ties `promote`/`merge` to exactly that; the
  source literal must first agree with that pair or the row fails; it is
  preserved beside the derived form in `legacy_merge_mode`. A promotion
  produces no alias (nothing was renamed). `ops.account_aliases.expires_at`
  stays NULL rather than deciding when a person's old link stops working.
  `source_tombstone_present` comes from the identity transform's
  `merge_evidence`, not from a second reading of the source.
* **An intent audit carries no credential.** `token_hash` and
  `openid_response_nonce` are validated for shape and then deliberately not
  carried; `migration.legacy_auth_intent_audit` has no column for either, and
  both are named in `INTENTS_RETIRED_SOURCE_COLUMNS`. The source `outcome` is
  kept verbatim: an intent that has merely run out of time is **not**
  relabelled `expired`, which would need a freeze instant this transform
  refuses to invent.

## Physical gate

[`remaining-constraints.integration.ts`](../lib/v2/migration/transform/remaining-constraints.integration.ts)
replays M1+M2+M3 on a disposable local PostgreSQL 17 cluster and proves the
emitted records satisfy the real constraints, including: the
snapshot-identity/FK relationship, `numeric(30, 12)` keeping every claimed
digit, microsecond instants surviving `timestamptz`, the support identity
pairing and policy FK, the 14/30-day retention CHECK, `octet_length = 32` on
the cooldown digest, the merge mode CHECK, and the paired intent target
columns. It also proves the privacy claims physically: a credential-shaped
setting reaches neither target relation and appears only in the non-loadable
exception stream, the freeze report physically cannot carry a lease,
the intent audit physically cannot carry a token, and an account delete removes
every personal row while account-free evidence (anonymous feedback, reco
globals, worker runs, pseudonymous cooldowns) survives.

## Schema dependencies

All in immutable M3: `reco.*`, `support.*`, `ops.abuse_cooldowns`,
`ops.legacy_worker_runs`, `ops.account_merges`/`ops.account_aliases` (M1,
extended by M3) and the named `migration.legacy_*` audit relations. **No new
target relation or column is proposed by this batch.** The one physical
question it raises — whether `numeric(30, 12)` is wide enough for float8
counters — is deliberately left as a blocker and a withheld stream rather than
a schema change, because widening a column is root's decision and the data is
not lost meanwhile.
