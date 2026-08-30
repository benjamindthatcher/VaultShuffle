import { getSupabaseAdmin } from "@/lib/supabase";

function ingestHost() {
  const configured = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  if (!configured) return "https://eu.i.posthog.com";
  const host = configured.replace(/\/$/, "");
  return host.includes(".i.posthog.com") ? host : host.replace(".posthog.com", ".i.posthog.com");
}

/**
 * The database has just proved both account IDs belong to the same SteamID.
 * This is the narrow case PostHog documents for `$merge_dangerously`: both IDs
 * may already be identified, so ordinary aliasing is deliberately refused.
 */
export async function mergePostHogAccountProfiles(input: {
  targetAccountId: string;
  sourceAccountId: string;
  steamId: string;
}) {
  if (input.targetAccountId === input.sourceAccountId) return true;
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  if (!apiKey) return false;

  const response = await fetch(`${ingestHost()}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      event: "$merge_dangerously",
      distinct_id: input.targetAccountId,
      properties: {
        alias: input.sourceAccountId,
        verified_steam_id: input.steamId,
        merge_source: "manual_profile_security",
        $lib: "vaultshuffle-server",
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });

  return response.ok;
}

export async function deliverPostHogAccountProfileMerge(input: {
  targetAccountId: string;
  sourceAccountId: string;
  steamId: string;
}) {
  const delivered = await mergePostHogAccountProfiles(input);
  if (!delivered) return false;

  const { error } = await getSupabaseAdmin()
    .from("account_merges")
    .update({ analytics_delivered_at: new Date().toISOString() })
    .eq("source_account_id", input.sourceAccountId)
    .eq("target_account_id", input.targetAccountId)
    .is("analytics_delivered_at", null);

  if (error) throw new Error(`Could not record the PostHog profile merge: ${error.message}`);
  return true;
}

/**
 * Retries collision-profile analytics merges after the response is sent. The
 * database account merge is authoritative; this ledger makes a transient
 * PostHog outage recoverable on the next authenticated product-page load.
 */
export async function retryPendingPostHogAccountProfileMerges(targetAccountId: string) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim()) return;

  const { data, error } = await getSupabaseAdmin()
    .from("account_merges")
    .select("source_account_id, target_account_id, verified_steam_id")
    .eq("target_account_id", targetAccountId)
    .eq("merge_mode", "merged_existing")
    .is("analytics_delivered_at", null)
    .order("created_at", { ascending: true })
    .limit(5);

  if (error) throw new Error(`Could not load pending PostHog profile merges: ${error.message}`);

  for (const merge of data ?? []) {
    const delivered = await deliverPostHogAccountProfileMerge({
      targetAccountId: merge.target_account_id,
      sourceAccountId: merge.source_account_id,
      steamId: merge.verified_steam_id,
    });
    if (!delivered) break;
  }
}
