# Duration enrichment: local only

Duration lookup, matching and review run locally. Vercel serves stored estimates but does not contact IGDB/HLTB or drain duration queues. Existing estimates, evidence, overrides, queues and local scripts are preserved.

The old `/api/cron/durations` and `/api/durations/process` routes are removed. `npm run duration:admin -- process` refuses to invoke the legacy Supabase Edge Function. Its source remains for reference; do not deploy or schedule it. The production Supabase cron audit on 2026-08-31 found no active duration job, only API rate-limit cleanup.

## Local workflow

1. Supply credentials in a private local environment, never in committed files or command output. Database reads/writeback use `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; IGDB tools additionally need `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`.
2. Run the existing checkpointed tools: `npm run duration:hltb -- --help` for HLTB, or `scripts/catalogue/fetch-igdb-durations-local.mjs` for local IGDB reports.
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

These read-only commands still work with local server-side Supabase configuration:

```bash
npm run duration:admin -- counts
npm run duration:admin -- ambiguous
npm run duration:admin -- coverage
```

The explicit `queue`, `backfill` and `retry` commands still mutate queue state when intentionally invoked, but launch no hosted processing. A queued job is not an automatically running worker.

Steam enrichment remains on [the nightly Vercel schedules](../docs/nightly-workers.md). No Supabase schema changes or duration-data deletion are required for this transition.
