import type { TenantTransaction } from "../db/client.ts";
import type { GameDurationEstimate } from "../../types.ts";

/** The current product's facts, hydrated only for the requested page/detail. */
export type LibraryProduct = Readonly<{
  collectionIds?: readonly string[];
  manualProgress: number | null;
  completedAt: string | null;
  previousActiveStatus: "Not Started" | "Sampled" | "In Progress" | null;
  reviewRequestedAt: string | null;
  completionDismissedAt: string | null;
  completionDismissedMinutes: number | null;
  dateAdded: string | null;
  recencySource: string | null;
  recencyEvidenceAt: string | null;
  observedMinutes: number | null;
  canonicalGenres: readonly string[];
  tags: Readonly<Record<string, number>>;
  categories: readonly string[];
  imageUrl: string | null;
  headerUrl: string | null;
  releaseDate: string | null;
  playerMode: "single" | "coop" | "multi" | null;
  platforms: Readonly<{ windows: boolean | null; mac: boolean | null; linux: boolean | null }>;
  deckCompatibility: number | null;
  duration: GameDurationEstimate;
  durationKind: "finite" | "endless" | "not-applicable" | "unknown";
  durationStatus: string | null;
  tagsStatus: string | null;
  reviews: Readonly<{ positive: number | null; negative: number | null; total: number | null }>;
  price: Readonly<{ currency: string | null; initial: number | null; final: number | null; isFree: boolean | null }>;
  familyOwnerSteamId: string | null;
  familyOwnerName: string | null;
}>;

type Row = {
  collection_ids:string[]; game_id: number; manual_progress: string | number | null; completed_at: Date | string | null;
  previous_active_status: LibraryProduct["previousActiveStatus"]; review_requested_at: Date | string | null;
  completion_dismissed_at: Date | string | null; completion_dismissed_playtime: number | null;
  date_added: string | null; recency_evidence_kind: string | null; observed_at: Date | string | null;
  last_observed_minutes: number | null; genres: unknown; weighted_tags: unknown; categories: unknown;
  capsule_image_url: string | null; header_image_url: string | null; release_date: Date | string | null;
  player_mode: LibraryProduct["playerMode"]; windows_compatibility: string | null;
  mac_compatibility: string | null; linux_compatibility: string | null; deck_compatibility_detail: number | null;
  main_duration_minutes: number | null; extras_duration_minutes: number | null; completion_duration_minutes: number | null;
  duration_source: string | null; duration_source_updated_at: Date | string | null;
  duration_confidence_label: string | null; duration_kind: LibraryProduct["durationKind"] | null;
  duration_status: string | null; tags_status: string | null;
  review_positive: string | number | null; review_negative: string | number | null; review_total: string | number | null;
  currency: string | null; price_initial_cents: number | null; price_final_cents: number | null; is_free: boolean | null;
  family_owner_steam_id: string | number | null; family_owner_name: string | null;
};

export async function libraryProducts(tx: TenantTransaction, accountId: number, gameIds: readonly number[], includeMemberships = false) {
  if (!gameIds.length) return new Map<number, LibraryProduct>();
  // IDs originate from the tenant-accessible page, never a caller's account selector.
  // Large descriptions and private notes stay in the on-demand detail response.
  const rows = await tx<Row[]>`
    select g.id game_id,${includeMemberships ? tx`array(select c.public_id::text from app.collection_games cg join app.collections c on c.account_id=cg.account_id and c.id=cg.collection_id
      where cg.account_id=${accountId} and cg.game_id=g.id order by c.id limit 100)` : tx`array[]::text[]`} collection_ids,gs.manual_progress,
      to_char(gs.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') completed_at,gs.previous_active_status,gs.review_requested_at,
      gs.completion_dismissed_at,gs.completion_dismissed_playtime,lm.legacy_date_added_raw date_added,
      ga.recency_evidence_kind,ga.observed_at,ga.last_observed_minutes,
      gm.genres,gm.weighted_tags,gm.categories,gm.capsule_image_url,gm.header_image_url,gm.release_date,
      gf.player_mode,gf.windows_compatibility,gf.mac_compatibility,gf.linux_compatibility,gf.deck_compatibility_detail,
      gf.main_duration_minutes,gf.extras_duration_minutes,gf.completion_duration_minutes,gf.duration_source,
      gf.duration_source_updated_at,gf.duration_confidence_label,gf.duration_kind,gf.duration_status,gf.tags_status,
      gf.review_positive,gf.review_negative,gf.review_total,price.currency,price.price_initial_cents,
      price.price_final_cents,price.is_free,family.steam_id family_owner_steam_id,family.display_name family_owner_name
    from catalog.games g left join app.game_state gs on gs.account_id=${accountId} and gs.game_id=g.id
    left join app.game_activity ga on ga.account_id=${accountId} and ga.game_id=g.id
    left join app.library_legacy_measurements lm on lm.account_id=${accountId} and lm.steam_app_id=g.steam_app_id
    left join catalog.game_metadata gm on gm.game_id=g.id left join catalog.game_features gf on gf.game_id=g.id
    left join lateral (
      select p.currency,p.price_initial_cents,p.price_final_cents,coalesce(p.is_free,o.is_free) is_free
      from catalog.offers o left join catalog.offer_prices p on p.offer_id=o.id and p.is_current and p.currency='USD'
      where o.game_id=g.id and o.region_code='US'
      order by p.observed_at desc nulls last,o.last_observed_at desc,o.id desc limit 1
    ) price on true
    left join lateral (
      select m.steam_id,m.display_name from app.family_game_access f
      join app.family_members m on m.account_id=f.account_id and m.id=f.member_id
      where f.account_id=${accountId} and f.game_id=g.id
        and not exists(select 1 from app.library_games lg where lg.account_id=${accountId} and lg.game_id=g.id)
      order by (f.provenance='verified') desc,m.id limit 1
    ) family on true
    where g.id=any(${tx.array([...gameIds])}::integer[])
  `;
  return new Map(rows.map(row => [row.game_id, product(row)]));
}

function product(row: Row): LibraryProduct {
  const confidence = row.duration_confidence_label;
  return Object.freeze<LibraryProduct>({
    collectionIds: row.collection_ids, manualProgress: number(row.manual_progress), completedAt: instant(row.completed_at),
    previousActiveStatus: row.previous_active_status, reviewRequestedAt: instant(row.review_requested_at),
    completionDismissedAt: instant(row.completion_dismissed_at), completionDismissedMinutes: row.completion_dismissed_playtime,
    dateAdded: row.date_added, recencySource: row.recency_evidence_kind,
    recencyEvidenceAt: instant(row.observed_at), observedMinutes: row.last_observed_minutes,
    canonicalGenres: labels(row.genres), tags: weights(row.weighted_tags), categories: labels(row.categories),
    imageUrl: row.capsule_image_url, headerUrl: row.header_image_url,
    releaseDate: instant(row.release_date)?.slice(0, 10) ?? null, playerMode: row.player_mode,
    platforms: { windows: supported(row.windows_compatibility), mac: supported(row.mac_compatibility), linux: supported(row.linux_compatibility) },
    deckCompatibility: row.deck_compatibility_detail,
    duration: { mainStoryMinutes: row.main_duration_minutes, mainExtrasMinutes: row.extras_duration_minutes,
      completionistMinutes: row.completion_duration_minutes, source: row.duration_source,
      sourceUpdatedAt: instant(row.duration_source_updated_at),
      confidence: confidence === 'low' || confidence === 'medium' || confidence === 'high' ? confidence : null,
      endless: row.duration_kind === 'endless' },
    durationKind: row.duration_kind ?? 'unknown', durationStatus: row.duration_status, tagsStatus: row.tags_status,
    reviews: { positive: number(row.review_positive), negative: number(row.review_negative), total: number(row.review_total) },
    price: { currency: row.currency, initial: row.price_initial_cents, final: row.price_final_cents, isFree: row.is_free },
    familyOwnerSteamId: row.family_owner_steam_id === null ? null : String(row.family_owner_steam_id),
    familyOwnerName: row.family_owner_name,
  });
}

function instant(value: Date | string | null) { return value instanceof Date ? value.toISOString() : value; }
function number(value: string | number | null) { return value === null ? null : Number(value); }
function supported(value: string | null) { return value === 'supported' ? true : value === 'unsupported' ? false : null; }
function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => typeof item === 'string' ? [item] : item && typeof item === 'object' && typeof item.label === 'string' ? [item.label] : []);
}
function weights(value: unknown): Record<string, number> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap(item => item && typeof item === 'object' && typeof item.tag === 'string'
    && typeof item.weight === 'number' && Number.isFinite(item.weight) && item.weight >= 0 ? [[item.tag, item.weight]] : []));
}
