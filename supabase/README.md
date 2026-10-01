# Duration enrichment: local only

Duration lookup, matching and review run locally using **HowLongToBeat only**. Vercel serves stored estimates but does not contact duration providers or drain duration queues. Keep human overrides and useful HLTB evidence. IGDB is retired; there is no fallback to its values in the local HLTB writeback acceptance check.

The old `/api/cron/durations` and `/api/durations/process` routes are removed. `npm run duration:admin -- process` refuses to invoke the legacy Supabase Edge Function, which no longer exists: the deployed `igdb-duration-worker` function was deleted by hand on 2026-09-16 and its source, the shared IGDB provider and the `igdb:lookup` helper were removed from the repository the same day. The production Supabase cron audit on 2026-08-31 found no active duration job, only API rate-limit cleanup.

This repository now contains no Supabase Edge Functions at all. Duration work is the local HowLongToBeat pipeline below; there is no automated duration worker on any schedule.

## V2 workflow

After the V2 release, use the new catalogue and schema explicitly. Supply `VAULT_DATABASE_AUTHORITY=v2`, a private operator `V2_DURATION_DATABASE_URL` and verified `V2_DATABASE_CA_PEM`; ordinary app/worker roles cannot apply writeback. Run `npm run duration:admin -- input > steam-catalogue.json` to prepare local input, then the matcher and detail-page validator below. Generate reviewed SQL with **`--target v2`**, apply it through verified operator transport, and run `duration:admin -- coverage`. Each bounded transaction guards the V2 project, retains human/nonfinite decisions and quarantine, checks observation freshness, and calls the existing HLTB-only resolver. Conflicting page identities remain unknown pending review. The password-protected `/durationqueue` retains its existing link/note and undo behavior, without directly changing durations.

V2 inspection commands are `counts`, `ambiguous`, `coverage` and `input`. The legacy `queue`, `backfill`, `retry` and `process` commands refuse to create unused V2 jobs. There is no hosted duration provider or automatic processing queue.

```bash
node scripts/durations/build-hltb-writeback-sql.mjs validated.json --target v2 --output-directory reviewed-v2-writeback --batch-size 100
```

## Legacy local workflow (before cutover only)

1. Supply credentials in a private local environment, never in committed files or command output. Database reads/writeback use `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. No IGDB credentials are required.
2. Run `npm run duration:hltb -- --help`. For a local Steam catalogue, prepare input with `node scripts/durations/build-hltb-input.mjs --source steam-catalogue.json --output hltb-input.json`, then pass `--input hltb-input.json` to the HLTB command. The source is an array or an object with a `games` array of Steam AppIDs and names. Use the HLTB report's `--resume` checkpoint to avoid repeating completed lookups.
3. Validate candidate evidence with `scripts/durations/validate-hltb-candidates.py`. Use `--include-matched` when validating matched candidates too; exact identity checks and review rules remain in force.
4. Generate staged SQL using `scripts/durations/build-hltb-writeback-sql.mjs`, inspect it, then explicitly apply approved transactions to the intended database. Report generation itself does not apply writeback.
5. Run the generated final verification and inspect coverage. Do not replace established estimates with ambiguous or missing matches.

After producing a candidate report:

```bash
python3 scripts/durations/validate-hltb-candidates.py candidates.json --include-matched --output validated.json
node scripts/durations/build-hltb-writeback-sql.mjs validated.json --output-directory reviewed-writeback --batch-size 100
```

The output directory must be new or empty. Review before applying; neither command above writes to production.

## Queue inspection

Before cutover, these read-only commands use local server-side legacy Supabase configuration:

```bash
npm run duration:admin -- counts
npm run duration:admin -- ambiguous
npm run duration:admin -- coverage
```

The explicit `queue`, `backfill` and `retry` commands still mutate queue state when intentionally invoked, but launch no hosted processing. A queued job is not an automatically running worker.

Steam enrichment remains on [the nightly Vercel schedules](../docs/nightly-workers.md). The old IGDB fetchers, popularity merger and unrestricted direct-to-catalogue duration importer have been removed; use the validated HLTB writeback above.

The additive V2 HLTB-only resolver/data correction is applied to the inactive target; final transfer and authority switch are still pending. It discards obsolete provider data explicitly. Already-applied SQL migrations and historical reports remain historical evidence, not instructions to restore IGDB. The legacy `dry-run-rebuild-duration-classifications.sql` is an old mixed-provider diagnostic and must not be used as the new resolver specification.
