import {readStorePageTags} from "./steam-tag-model.ts";
export {readStorePageTags,type StoreTagState,type StorePageVerdict} from "./steam-tag-model.ts";
import { getSupabaseAdmin } from "@/lib/supabase";
import { steamRetryAfter } from "@/lib/steam-api-error";
import { waitForSteamStoreRateLimit } from "@/lib/steam";
import { promoteIfEndless } from "@/lib/endless-sync";

/**
 * Tags from the Steam store page, for the games SteamSpy cannot tag.
 *
 * SteamSpy lags new releases and knows nothing about delisted or superseded
 * editions, which is why 1,642 games somebody owns carried no tags at all:
 * F.E.A.R., Grand Theft Auto: San Andreas and Metro: Last Light alongside a long
 * tail of 2024-2026 releases. Everything that reads tags - the exclusion
 * categories, moods, the endless verdict - is blind on a game with none, so those
 * games are close to undrawable however well they would have fitted.
 *
 * Sampled against Steam on 2026-09-16: 78% had a full tag set on their store page
 * that moment, 12% sat behind an age gate and 10% were delisted and unreachable
 * from either source. This exists to collect that 78%, and to keep collecting it,
 * because SteamSpy will lag every future release the same way.
 *
 * The counts are read from the InitAppTagModal call that feeds the store's own tag
 * dialog rather than from the visible tag anchors. The anchors carry the names but
 * lose the vote counts, and the counts are what every share-based rule in
 * lib/game-classification.ts is computed from - a tag set without them would be
 * read as twenty equally-weighted tags and quietly skew each one.
 */

const STORE_PAGE_TIMEOUT_MS = 20_000;
/**
 * The gate answers with a date-of-birth form instead of the product page. This is
 * the cookie the gate itself sets once a person passes it. Adults-only titles want
 * a signed-in account as well and stay gated whatever we send, which is the 12%.
 */
const AGE_GATE_COOKIE = "birthtime=283996801; mature_content=1; lastagecheckage=1-January-1980; Steam_Language=english";
class StoreTagRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("Steam store rate limit reached."); }
}

async function fetchStorePage(steamAppId: number) {
  // Shares one pacer with the catalogue metadata worker, because both are knocking
  // on the same door and the interval belongs to the host, not the worker.
  await waitForSteamStoreRateLimit();
  const response = await fetch(`https://store.steampowered.com/app/${steamAppId}/?cc=us&l=english`, {
    headers: {
      "User-Agent": "VaultShuffle metadata worker/1.0",
      Accept: "text/html,application/xhtml+xml",
      Cookie: AGE_GATE_COOKIE
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(STORE_PAGE_TIMEOUT_MS)
  });

  if (response.status === 429) {
    throw new StoreTagRateLimitError(steamRetryAfter(response.headers.get("Retry-After")));
  }
  if (!response.ok) throw new Error(`Steam store returned HTTP ${response.status}.`);
  return response.text();
}

export async function processStoreTagQueue(limit = 150, deadlineAt = Date.now() + 110_000) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("select_store_tag_candidates", {
    p_limit: clamp(limit, 1, 500)
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ steam_appid: number; users_that_imported: number | null }>;

  let tagged = 0;
  let noTags = 0;
  let ageGated = 0;
  let unavailable = 0;
  let failed = 0;
  let deferred = 0;
  let endlessPromotions = 0;
  let rateLimited = false;
  let consecutiveFailures = 0;

  for (const [index, row] of rows.entries()) {
    // One request timeout in hand. There is no lease to release: a game whose state
    // was not written is simply still a candidate tomorrow, which is what makes this
    // safe to stop anywhere.
    if (Date.now() + STORE_PAGE_TIMEOUT_MS >= deadlineAt) {
      deferred = rows.length - index;
      break;
    }

    try {
      const verdict = readStorePageTags(row.steam_appid, await fetchStorePage(row.steam_appid));
      const checkedAt = new Date().toISOString();
      const values: Record<string, unknown> = {
        store_tags_checked_at: checkedAt,
        store_tags_state: verdict.state,
        updated_at: checkedAt
      };

      if (verdict.state === "ok") {
        // No guard against the row having gained tags since it was selected. Only
        // SteamSpy could have, it runs earlier in this same request rather than
        // beside it, and store tags are the better answer anyway - after this write
        // tagWriteDecision protects them from being taken back.
        Object.assign(values, {
          tags: verdict.tags,
          tags_source: "steam-store",
          tags_status: "ready",
          tags_fetched_at: checkedAt,
          tags_failure_count: 0,
          tags_last_error: null,
          tags_next_attempt_at: null,
          tags_processing_started_at: null
        });
      }

      const { error: writeError } = await supabase
        .from("catalog_games")
        .update(values)
        .eq("steam_appid", row.steam_appid);
      if (writeError) throw writeError;

      consecutiveFailures = 0;
      if (verdict.state === "ok") tagged += 1;
      else if (verdict.state === "age_gated") ageGated += 1;
      else if (verdict.state === "unavailable") unavailable += 1;
      else noTags += 1;

      // Tags are the one input the endless verdict really turns on, and these games
      // have never had any, so this is the first time it can be asked at all. Never
      // allowed to fail the tag write: the tags are the job.
      if (verdict.state === "ok") {
        try {
          const promotion = await promoteIfEndless(supabase, row.steam_appid, verdict.tags);
          if (promotion.promoted) endlessPromotions += 1;
        } catch (promotionError) {
          console.error(JSON.stringify({
            level: "warning",
            message: "Could not re-check the endless verdict after storing store-page tags.",
            steamAppId: row.steam_appid,
            error: promotionError instanceof Error ? promotionError.message : String(promotionError)
          }));
        }
      }
    } catch (caught) {
      if (caught instanceof StoreTagRateLimitError) {
        deferred = rows.length - index;
        rateLimited = true;
        break;
      }
      failed += 1;
      consecutiveFailures += 1;
      // Recorded as a visit so a game that errors every night cannot hold the head
      // of a queue ordered by owners, where the most-owned games are exactly the
      // ones that would be starved behind it.
      const checkedAt = new Date().toISOString();
      const { error: failureError } = await supabase
        .from("catalog_games")
        .update({ store_tags_checked_at: checkedAt, store_tags_state: "error", updated_at: checkedAt })
        .eq("steam_appid", row.steam_appid);
      if (failureError) throw failureError;

      // Three in a row is Steam saying something about us rather than about a game.
      if (consecutiveFailures >= 3) {
        deferred = rows.length - (index + 1);
        break;
      }
    }
  }

  return {
    candidates: rows.length,
    tagged,
    noTags,
    ageGated,
    unavailable,
    endlessPromotions,
    failed,
    deferred,
    rateLimited
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.floor(Number(value) || min), max));
}
