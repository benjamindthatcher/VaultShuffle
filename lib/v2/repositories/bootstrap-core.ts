import type { DatabaseClient, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";

export type BootstrapPayload = Readonly<{ accountPublicId: string; libraryRevision: string; stateRevision: string; ownedTotal: number; familyTotal: number; pins: readonly { slot: number; gameId: number; title: string }[]; currentPick: { gameId: number; title: string } | null }>;
export class BootstrapRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }
  async read(principal: VerifiedServerPrincipal): Promise<BootstrapPayload> {
    try { return await this.database.withPrincipal(principal, async tx => {
      const rows = await tx<{ public_id: string; library_revision: string; state_revision: string; owned_total: string; family_total: string; pins: unknown; current_game_id: number | null; current_title: string | null }[]>`
        select a.public_id, a.library_revision, a.state_revision,
          (select count(*) from app.library_games lg where lg.account_id=${principal.accountId}) owned_total,
          (select count(distinct f.game_id) from app.family_game_access f where f.account_id=${principal.accountId} and not exists(select 1 from app.library_games lg where lg.account_id=f.account_id and lg.game_id=f.game_id)) family_total,
          coalesce((select jsonb_agg(jsonb_build_object('slot',pin.slot,'gameId',pin.game_id,'title',pin.title) order by pin.slot)
            from (select p.slot,p.game_id,g.title from app.pins p join catalog.games g on g.id=p.game_id
              where p.account_id=${principal.accountId} and p.scope='library' order by p.slot limit 3) pin), '[]'::jsonb) pins,
          v.current_game_id, cg.title current_title
        from app.accounts a left join app.vault_state v on v.account_id=a.id left join catalog.games cg on cg.id=v.current_game_id
        where a.id=${principal.accountId}`;
      const row=rows[0]; if(!row) throw new DatabaseUnavailableError();
      const pins=Array.isArray(row.pins)? row.pins.filter((p):p is {slot:number;gameId:number;title:string} => typeof p === "object" && p!==null && Number.isInteger((p as any).slot) && Number.isInteger((p as any).gameId) && typeof (p as any).title === "string").slice(0,3):[];
      return Object.freeze({accountPublicId:row.public_id,libraryRevision:String(row.library_revision),stateRevision:String(row.state_revision),ownedTotal:Number(row.owned_total),familyTotal:Number(row.family_total),pins:Object.freeze(pins),currentPick:row.current_game_id&&row.current_title?{gameId:row.current_game_id,title:row.current_title}:null});
    }); } catch(error) { if(error instanceof DatabaseUnavailableError) throw error; throw new DatabaseUnavailableError(); }
  }
}
