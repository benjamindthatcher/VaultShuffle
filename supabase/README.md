# Duration enrichment and historical SQL

Production uses [the V2 database](../database/v2/README.md). V1 has been deleted. This directory's already-applied legacy migrations remain immutable historical SQL; they are not a production setup or rollback target.

Duration lookup, matching and review run locally using **HowLongToBeat only**. Vercel serves stored estimates and does not contact duration providers or drain duration queues. Keep validated HLTB identities, human overrides, review notes and undo. There is no IGDB fallback or hosted duration worker.

## Current HLTB workflow

1. Supply `VAULT_DATABASE_AUTHORITY=v2`, private operator `V2_DURATION_DATABASE_URL` and verified `V2_DATABASE_CA_PEM`. Ordinary app/worker roles cannot apply writeback. Keep values out of committed files and command output.
2. Prepare catalogue input with `npm run duration:admin -- input > steam-catalogue.json`. Build matcher input with `node scripts/durations/build-hltb-input.mjs --source steam-catalogue.json --output hltb-input.json`.
3. Use `npm run duration:hltb -- --help`, pass the prepared `--input`, and resume existing reports rather than repeating completed lookups.
4. Validate candidates with `scripts/durations/validate-hltb-candidates.py`, including matched candidates when applicable.
5. Generate reviewed SQL explicitly for V2, inspect the output, apply it through verified operator transport, then inspect coverage.

```bash
python3 scripts/durations/validate-hltb-candidates.py candidates.json --include-matched --output validated.json
node scripts/durations/build-hltb-writeback-sql.mjs validated.json --target v2 --output-directory reviewed-v2-writeback --batch-size 100
npm run duration:admin -- coverage
```

The output directory must be new or empty. Report generation does not write to production. Each bounded writeback transaction guards the V2 project, preserves human/nonfinite decisions and quarantine, checks observation freshness and calls the HLTB-only resolver. Conflicting page identities remain unknown pending review; do not manufacture durations from ambiguous evidence.

Read-only V2 admin commands are `counts`, `ambiguous`, `coverage` and `input`. Legacy `queue`, `backfill`, `retry` and `process` commands refuse V2 mutations. The password-protected `/durationqueue` is the existing private evidence review UI, not a duration-processing worker.

Steam enrichment remains on [the nightly Vercel schedules](../docs/nightly-workers.md). Do not use historical mixed-provider diagnostics as the current resolver specification.
