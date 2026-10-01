import type { DatabaseClient, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import type {SteamCapabilities} from '../../steam-capabilities.ts';

export type BootstrapPayload = Readonly<{ capabilities?:SteamCapabilities; accountPublicId: string; libraryRevision: string; stateRevision: string; ownedTotal: number; familyTotal: number; pins: readonly { slot: number; gameId: number; title: string; pinnedAt: string | null; personalMinutesBaseline: number | null }[]; snoozedIds?: readonly number[]; currentPick: { gameId: number; title: string; drawId?: string | null } | null }>;
export class BootstrapRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }
  async read(principal: VerifiedServerPrincipal): Promise<BootstrapPayload> {
    try { return await this.database.withPrincipal(principal, async tx => {
      const rows = await tx<{ public_id: string; library_revision: string; state_revision: string; owned_total: string; family_total: string; pins: unknown; snoozed_ids:number[]; current_draw_ref:string|null; current_game_id: number | null; current_title: string | null;has_playtime:boolean;recency_count:number;history_days:number;playtime_visible:boolean }[]>`
        select a.public_id, a.library_revision, a.state_revision,
          (select count(*) from app.library_games lg join catalog.games g on g.id=lg.game_id and g.lifecycle_status='active' where lg.account_id=${principal.accountId}) owned_total,
          (select count(distinct f.game_id) from app.family_game_access f join catalog.games g on g.id=f.game_id and g.lifecycle_status='active' where f.account_id=${principal.accountId} and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id)) family_total,
          exists(select 1 from app.library_games l join catalog.games g on g.id=l.game_id
            where l.account_id=a.id and g.lifecycle_status='active' and l.playtime_minutes>0) has_playtime,
          (select count(*)::integer from app.library_games l join catalog.games g on g.id=l.game_id
            join app.game_activity ga on ga.account_id=l.account_id and ga.game_id=l.game_id
            where l.account_id=a.id and g.lifecycle_status='active' and
              ((ga.recency_evidence_kind in ('steam_exact','observed_playtime_change') and ga.last_played_at is not null)
                or (ga.recency_evidence_kind='steam_recent_window' and ga.observed_at is not null))) recency_count,
          (select count(*)::integer from (select activity_day from app.playtime_daily where account_id=a.id limit 2) d) history_days,
          coalesce((select playtime_visibility<>'hidden' from app.account_capabilities where account_id=a.id),true) playtime_visible,
          coalesce((select jsonb_agg(jsonb_build_object('slot',pin.slot,'gameId',pin.game_id,'title',pin.title,'pinnedAt',pin.pinned_at,'personalMinutesBaseline',pin.personal_minutes_baseline) order by pin.slot)
            from (select p.slot,p.game_id,g.title,p.pinned_at,p.personal_minutes_baseline from app.pins p join catalog.games g on g.id=p.game_id
              where p.account_id=${principal.accountId} and p.scope='library' order by p.slot limit 3) pin), '[]'::jsonb) pins,
          array(select s.game_id from app.snoozes s where s.account_id=a.id and (s.until_at is null or s.until_at>now()) order by s.game_id) snoozed_ids,
          v.current_game_id,v.current_draw_ref, cg.title current_title
        from app.accounts a left join app.vault_state v on v.account_id=a.id left join catalog.games cg on cg.id=v.current_game_id
        where a.id=${principal.accountId}`;
      const row=rows[0]; if(!row) throw new DatabaseUnavailableError();
      const pins=Array.isArray(row.pins)? row.pins.filter((p):p is {slot:number;gameId:number;title:string;pinnedAt:string|null;personalMinutesBaseline:number|null} => typeof p === "object" && p!==null && Number.isInteger((p as any).slot) && Number.isInteger((p as any).gameId) && typeof (p as any).title === "string").slice(0,3):[];
      const ownedTotal=Number(row.owned_total);
      const capabilities:SteamCapabilities={canUsePersonalLibrary:ownedTotal>0,canUseProgress:ownedTotal>0&&row.playtime_visible&&row.has_playtime,
        canUseRecency:ownedTotal>0&&row.recency_count>=Math.min(3,ownedTotal),canUseHistory:ownedTotal>0&&row.history_days>=2};
      return Object.freeze({capabilities:Object.freeze(capabilities),accountPublicId:row.public_id,libraryRevision:String(row.library_revision),stateRevision:String(row.state_revision),ownedTotal,familyTotal:Number(row.family_total),pins:Object.freeze(pins),snoozedIds:Object.freeze(row.snoozed_ids),currentPick:row.current_game_id&&row.current_title?{gameId:row.current_game_id,title:row.current_title,drawId:row.current_draw_ref}:null});
    }); } catch(error) { if(error instanceof DatabaseUnavailableError) throw error; throw new DatabaseUnavailableError(); }
  }
}
