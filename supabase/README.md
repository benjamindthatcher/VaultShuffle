# Duration enrichment

The `igdb-duration-worker` function is the only component that contacts Twitch or IGDB. The frontend reads stored estimates from Supabase.

## Link and deploy

This checkout is not currently linked. Confirm the target, then run:

```bash
npx supabase link --project-ref pfvblcopcmairdfeqdep
npx supabase db push
npx supabase functions deploy igdb-duration-worker
```

Configure `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` in **Supabase Edge Functions > Secrets**. Do not add either value to Vercel or a client environment variable.

If configuring them from a private local terminal, use placeholders and paste the values only when running the command:

```bash
npx supabase secrets set --project-ref pfvblcopcmairdfeqdep IGDB_CLIENT_ID="<paste locally>" IGDB_CLIENT_SECRET="<paste locally>"
```

## Schedule

Create a Supabase Cron job every 10 minutes that POSTs `{ "batchSize": 4 }` to `/functions/v1/igdb-duration-worker`. Store the project service-role credential in Supabase Vault and send it as the bearer token. Never place the IGDB credentials in Cron SQL.

## Administration

All commands require server-side Supabase environment variables:

```bash
npm run duration:admin -- queue --steam-app-id 1086940
npm run duration:admin -- backfill --limit 250
npm run duration:admin -- counts
npm run duration:admin -- retry
npm run duration:admin -- ambiguous
npm run duration:admin -- coverage
npm run duration:admin -- process --limit 4
```

The migration only creates jobs for newly confirmed catalogue games. Run the bounded backfill explicitly after deployment.
