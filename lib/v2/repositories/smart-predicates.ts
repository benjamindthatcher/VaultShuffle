import type { TenantTransaction } from "../db/client.ts";
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
    // Priority was never given a v2 runtime destination. Fail instead of
    // silently returning an empty "Must Play" collection.
    case "must-play": throw new UnsupportedCollectionRuleError();
  }
}

export function smartEligibleCte(tx: TenantTransaction, accountId: number) {
  return tx`
    select lg.game_id,g.title,g.steam_app_id,lg.playtime_minutes minutes,
      coalesce(gs.completed_at is not null,false) completed,coalesce(gs.blacklisted,false) blacklisted,
      ga.last_played_at,ga.observed_at,ga.recency_evidence_kind,coalesce(gf.duration_kind,'unknown') duration_kind,
      case when coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0)>0
        then round((coalesce(nullif(gf.main_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.completion_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0)))/3.0)::integer end duration_minutes,
      case when gs.completed_at is not null then 100 when gf.duration_kind='endless' then 99 when gs.manual_progress is not null then round(gs.manual_progress)::integer
        when coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0)>0 then least(100,round(lg.playtime_minutes*100.0/nullif((coalesce(nullif(gf.main_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0),nullif(gf.completion_duration_minutes,0))+coalesce(nullif(gf.completion_duration_minutes,0),nullif(gf.extras_duration_minutes,0),nullif(gf.main_duration_minutes,0)))/3.0,0))::integer else 0 end progress
    from app.library_games lg join catalog.games g on g.id=lg.game_id left join app.game_state gs on gs.account_id=${accountId} and gs.game_id=lg.game_id
    left join app.game_activity ga on ga.account_id=${accountId} and ga.game_id=lg.game_id left join catalog.game_features gf on gf.game_id=lg.game_id
    where lg.account_id=${accountId} and g.lifecycle_status='active'`;
}
