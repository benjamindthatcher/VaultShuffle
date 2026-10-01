import type { TenantTransaction } from "../db/client.ts";
import { DEFAULT_GLOBAL_FILTERS, type GlobalFilters } from "../../global-filters.ts";
import { EXCLUSION_CATEGORIES, EXCLUSION_TAG_SHARE } from "../../exclusion-categories.ts";
import { InvalidPageQueryError } from "./page-errors.ts";

export function libraryGlobalFilters(value?: GlobalFilters): GlobalFilters {
  const f = value ?? DEFAULT_GLOBAL_FILTERS;
  if (!f || !["all", "mac", "linux", "deck"].includes(f.device)
    || !["any", "single", "coop", "multi"].includes(f.players)
    || !["any", "recent", "modern", "established", "classic"].includes(f.releaseAge)
    || !["all", "finite", "endless"].includes(f.gameType)
    || !["all", "owned", "family"].includes(f.access)
    || typeof f.hidePoorlyReviewed !== "boolean" || !Array.isArray(f.excluded)
    || f.excluded.length > EXCLUSION_CATEGORIES.length
    || f.excluded.some(id => !EXCLUSION_CATEGORIES.some(c => c.id === id))) throw new InvalidPageQueryError();
  return { ...f, excluded: [...new Set(f.excluded)].sort() };
}

/** Same standing filters as the current product, applied before counts/paging. */
export function libraryGlobalPredicate(tx: TenantTransaction, f: GlobalFilters) {
  const selected = EXCLUSION_CATEGORIES.filter(c => f.excluded.includes(c.id));
  const tags = tx.array([...new Set(selected.flatMap(c => c.tags.map(normalise)))]);
  const categories = tx.array([...new Set(selected.flatMap(c => (c.categories ?? []).map(normalise)))]);
  const now = new Date().toISOString();
  // Empty exclusions need no per-game JSON scans. Build only the selected
  // exclusion predicates; all other standing filters keep their usual checks.
  const exclusions = selected.length ? tx`
    and not exists (
      select 1 from jsonb_array_elements(coalesce(gm.genres,'[]')) e(value)
      where replace(lower(btrim(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' else e.value->>'label' end)),'_',' ')=any(${tags}::text[])
    )
    and not exists (
      select 1 from jsonb_array_elements(coalesce(gm.categories,'[]')) e(value)
      where replace(lower(btrim(case jsonb_typeof(e.value) when 'string' then e.value#>>'{}' else e.value->>'label' end)),'_',' ')=any(${categories}::text[])
    )
    and not exists (
      select 1 from jsonb_array_elements(coalesce(gm.weighted_tags,'[]')) e(value)
      where replace(lower(btrim(e.value->>'tag')),'_',' ')=any(${tags}::text[])
        and (e.value->>'weight')::numeric>0
        and (e.value->>'weight')::numeric>=${EXCLUSION_TAG_SHARE}*(
          select max((other.value->>'weight')::numeric) from jsonb_array_elements(coalesce(gm.weighted_tags,'[]')) other(value)
        )
    )
  ` : tx``;
  // Match the client definition of a year, including future releases.
  return tx`
    (${f.device}='all' or (${f.device}='mac' and gf.mac_compatibility='supported')
      or (${f.device}='linux' and gf.linux_compatibility='supported')
      or (${f.device}='deck' and gf.deck_compatibility_detail>=2))
    and (${f.players}='any' or gf.player_mode=${f.players})
    and (${f.releaseAge}='any' or (gm.release_date is not null and case ${f.releaseAge}
      when 'recent' then extract(epoch from (${now}::timestamptz-(gm.release_date::timestamp at time zone 'UTC')))/31557600 < 2
      when 'modern' then extract(epoch from (${now}::timestamptz-(gm.release_date::timestamp at time zone 'UTC')))/31557600 < 5
      when 'established' then extract(epoch from (${now}::timestamptz-(gm.release_date::timestamp at time zone 'UTC')))/31557600 >= 5
      when 'classic' then extract(epoch from (${now}::timestamptz-(gm.release_date::timestamp at time zone 'UTC')))/31557600 >= 15 end))
    and (${f.gameType}='all' or (${f.gameType}='endless' and gf.duration_kind='endless')
      or (${f.gameType}='finite' and coalesce(gf.duration_kind,'unknown')<>'endless'))
    and (${f.access}='all' or a.access=${f.access})
    and (not ${f.hidePoorlyReviewed} or coalesce(gf.review_total,0)<50
      or coalesce(gf.review_positive,0)::numeric/nullif(gf.review_total,0)>=0.6)
    ${exclusions}
  `;
}
function normalise(value: string) { return value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " "); }
