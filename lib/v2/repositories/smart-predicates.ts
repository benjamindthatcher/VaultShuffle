import type { TenantTransaction } from "../db/client.ts";
import { libraryGlobalPredicate } from "./library-global-filters.ts";
import { DEFAULT_GLOBAL_FILTERS, type GlobalFilters } from "../../global-filters.ts";
import { InvalidPageQueryError } from "./page-errors.ts";

export const SMART_PRESETS = ["nearly-finished", "quick-wins", "recently-played", "fallen-off", "long-haul", "endless-rotation", "untouched", "backlog", "in-progress", "must-play", "unplayed", "short"] as const;
export type SmartPreset = (typeof SMART_PRESETS)[number];
export type SmartRule = Readonly<{ version: 1; preset: SmartPreset }>;

export class UnsupportedCollectionRuleError extends InvalidPageQueryError {
  readonly code = "unsupported_collection_rule";
  readonly status = 422;
  constructor() { super("This smart collection uses an unsupported rule."); this.name = "UnsupportedCollectionRuleError"; }
}

/** Legacy `{preset}` documents are the version-1 preset AST on read. */
export function parseSmartRule(value: unknown): SmartRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnsupportedCollectionRuleError();
  const object = value as { version?: unknown; preset?: unknown };
  if (object.version !== undefined && object.version !== 1) throw new UnsupportedCollectionRuleError();
  if (typeof object.preset !== "string" || !SMART_PRESETS.includes(object.preset as SmartPreset)) throw new UnsupportedCollectionRuleError();
  return Object.freeze({ version: 1, preset: object.preset as SmartPreset });
}

/** Columns expected: completed, blacklisted, minutes, duration_minutes, duration_kind, progress, last_played_at, recency_evidence_kind, observed_at. */
export function smartPredicate(tx: TenantTransaction, preset: SmartPreset) {
  const active = tx`not completed and not blacklisted`;
  switch (preset) {
    case "nearly-finished": return tx`${active} and duration_kind <> 'endless' and progress >= 75 and progress < 100`;
    case "quick-wins": return tx`${active} and duration_kind <> 'endless' and duration_minutes is not null and duration_minutes > minutes and duration_minutes - minutes <= 480`;
    case "recently-played": return tx`${active} and minutes > 0 and ((recency_evidence_kind in ('steam_exact','observed_playtime_change') and last_played_at >= now()-interval '30 days') or (recency_evidence_kind='steam_recent_window' and observed_at >= now()-interval '16 days'))`;
    case "fallen-off": return tx`${active} and minutes > 0 and ((recency_evidence_kind in ('steam_exact','observed_playtime_change') and last_played_at <= now()-interval '180 days') or (recency_evidence_kind='steam_recent_window' and observed_at <= now()-interval '180 days'))`;
    case "long-haul": return tx`${active} and duration_kind <> 'endless' and progress < 65 and duration_minutes >= 2400`;
    case "endless-rotation": return tx`${active} and duration_kind = 'endless'`;
    case "untouched": return tx`${active} and minutes = 0`;
    case "backlog": return tx`not completed and not blacklisted and minutes = 0`;
    case "in-progress": return tx`not completed and not blacklisted and minutes > 0`;
    case "unplayed": return tx`minutes = 0`;
    case "short": return tx`${active} and duration_kind <> 'endless' and duration_minutes <= 600`;
    // The inspected live source retired priority; its current mapper defaults
    // every game to Medium. Preserve the old rule as the same empty result.
    case "must-play": return tx`false`;
  }
}

export function smartEligibleCte(tx: TenantTransaction, accountId: number, filters: GlobalFilters = DEFAULT_GLOBAL_FILTERS) {
  return tx`
    select facts.*,
      case when completed then 100 when duration_kind='endless' then 99 when manual_progress is not null then round(manual_progress)::integer
        when duration_minutes>0 and minutes is not null then least(100,round(minutes*100.0/duration_minutes))::integer else 0 end as progress
    from (
      select a.game_id,g.title,g.steam_app_id,a.playtime_minutes as minutes,a.access,
        coalesce(gm.header_image_url,gm.capsule_image_url) image_url,
        concat(g.updated_at::text,':',gm.updated_at::text,':',gf.updated_at::text,':',gf.feature_revision::text) catalog_stamp,
        coalesce(gs.completed_at is not null,false) as completed,coalesce(gs.blacklisted,false) as blacklisted,gs.manual_progress,
        ga.last_played_at,ga.observed_at,ga.recency_evidence_kind,coalesce(gf.duration_kind,'unknown') as duration_kind,
        case when coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0)>0
          then greatest(60,round((coalesce(nullif(gf.main_duration_minutes,0),0)+coalesce(nullif(gf.extras_duration_minutes,0),0)+coalesce(nullif(gf.completion_duration_minutes,0),0))::numeric/nullif((case when gf.main_duration_minutes>0 then 1 else 0 end)+(case when gf.extras_duration_minutes>0 then 1 else 0 end)+(case when gf.completion_duration_minutes>0 then 1 else 0 end),0)/60)*60)::integer end as duration_minutes
      from (
        select game_id,playtime_minutes,'owned'::text access from app.library_games where account_id=${accountId}
        union all select f.game_id,null::integer,'family'::text from app.family_game_access f where f.account_id=${accountId}
          and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id) group by f.game_id
      ) a join catalog.games g on g.id=a.game_id
      left join app.game_state gs on gs.account_id=${accountId} and gs.game_id=a.game_id
      left join app.game_activity ga on ga.account_id=${accountId} and ga.game_id=a.game_id
      left join catalog.game_features gf on gf.game_id=a.game_id
      left join catalog.game_metadata gm on gm.game_id=a.game_id
      where g.lifecycle_status='active' and ${libraryGlobalPredicate(tx,filters)}
    ) facts`;
}
