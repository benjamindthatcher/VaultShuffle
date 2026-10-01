import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import { playedWishlistSeeds, type WishlistLibraryContext, type WishlistTasteSeed } from "../../wishlist.ts";
import { editionKey, playNextTagProfile } from "../../play-next.ts";
import { splitGenres, steamTagGenreLabels, topLevelGenresFor } from "../../genres.ts";

export type SavedWishlistGame = Readonly<{ appId: number; source: "local" | "steam"; addedAt: string }>;
export type WishlistPage = Readonly<{ items: readonly SavedWishlistGame[]; appIds: readonly number[]; total: number }>;

export class InvalidWishlistQueryError extends InvalidPageQueryError {
  constructor() { super("Invalid Wishlist request."); this.name = "InvalidWishlistQueryError"; }
}

/** Saved AppIDs need no catalogue or Library entry; metadata is loaded separately. */
export class WishlistRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }

  /** Complete exclusions, with only the existing 120 representative taste seeds. */
  async libraryContext(principal: VerifiedServerPrincipal): Promise<WishlistLibraryContext> {
    return this.run(principal, async tx => {
      const rows = await tx<{app_id:string;title:string;access:"owned"|"family";minutes:number|null;completed:boolean;blacklisted:boolean;genres:Array<string|{label:string}>;tags:Array<{tag:string;weight:number}>}[]>`
        with accessible as (
          select game_id,playtime_minutes,'owned'::text access from app.library_games where account_id=${principal.accountId}
          union all select distinct game_id,null::integer,'family'::text from app.family_game_access f where account_id=${principal.accountId}
            and not exists(select 1 from app.library_games l where l.account_id=f.account_id and l.game_id=f.game_id)
        ) select g.steam_app_id::text app_id,g.title,a.access,a.playtime_minutes minutes,
          s.completed_at is not null completed,coalesce(s.blacklisted,false) blacklisted,
          coalesce(m.genres,'[]') genres,coalesce(m.weighted_tags,'[]') tags
        from accessible a join catalog.games g on g.id=a.game_id
        left join app.game_state s on s.account_id=${principal.accountId} and s.game_id=a.game_id
        left join catalog.game_metadata m on m.game_id=a.game_id
        where g.steam_app_id is not null order by g.id`;
      const seeds: WishlistTasteSeed[] = rows.filter(row=>row.access==='owned'&&!row.blacklisted&&(row.completed||(row.minutes??0)>=180)).map(row=>{
        const canonical=splitGenres(row.genres.map(genre=>typeof genre==='string'?genre:genre.label).join(' / '));
        const tags=Object.fromEntries(row.tags.map(tag=>[tag.tag,tag.weight]));
        const genres=splitGenres([...topLevelGenresFor([...canonical,...steamTagGenreLabels(tags,8)].join(' / '),row.title),...canonical,...steamTagGenreLabels(tags,8)].join(' / ')).slice(0,8);
        return {steamAppId:Number(row.app_id),title:row.title,accessSource:row.access,status:row.completed?'Completed':'In Progress',hoursPlayed:(row.minutes??0)/60,genres,tagProfile:playNextTagProfile(tags)};
      });
      return {appIds:[...new Set(rows.map(row=>Number(row.app_id)))],editionKeys:[...new Set(rows.map(row=>editionKey(row.title)))],seeds:playedWishlistSeeds(seeds)};
    });
  }

  async list(principal: VerifiedServerPrincipal, offset = 0, limit = 24): Promise<WishlistPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw new InvalidWishlistQueryError();
    return this.run(principal, async tx => {
      const rows = await tx<{ items: SavedWishlistGame[]; app_ids: number[]; total: string | number }[]>`
        select
          coalesce((select jsonb_agg(jsonb_build_object('appId',p.steam_app_id,'source',p.source,'addedAt',p.added_at)
            order by p.added_at desc,p.steam_app_id)
            from (select steam_app_id,source,added_at from app.wishlist_games
              where account_id=${principal.accountId} order by added_at desc,steam_app_id
              offset ${offset} limit ${limit}) p),'[]'::jsonb) items,
          coalesce(jsonb_agg(steam_app_id order by steam_app_id),'[]'::jsonb) app_ids,
          count(*) total
        from app.wishlist_games where account_id=${principal.accountId}
      `;
      const row = rows[0];
      return Object.freeze({ items: Object.freeze(row.items), appIds: Object.freeze(row.app_ids), total: Number(row.total) });
    });
  }

  /** One atomic additive import. Duplicates retain their original source/time. */
  async save(principal: VerifiedServerPrincipal, appIds: readonly number[], source: "local" | "steam"): Promise<number> {
    if (!Array.isArray(appIds) || appIds.length > 10_000 || (source !== "local" && source !== "steam")
      || appIds.some(id => !validAppId(id))) throw new InvalidWishlistQueryError();
    if (!appIds.length) return 0;
    const ids = [...new Set(appIds)].map(String);
    return this.run(principal, async tx => {
      const rows = await tx<{ steam_app_id: string }[]>`
        insert into app.wishlist_games(account_id,steam_app_id,source)
        select ${principal.accountId},id,${source} from unnest(${tx.array(ids)}::bigint[]) id
        on conflict (account_id,steam_app_id) do nothing returning steam_app_id
      `;
      return rows.length;
    });
  }

  async remove(principal: VerifiedServerPrincipal, appId: number): Promise<void> {
    if (!validAppId(appId)) throw new InvalidWishlistQueryError();
    await this.run(principal, async tx => {
      await tx`delete from app.wishlist_games where account_id=${principal.accountId} and steam_app_id=${String(appId)}`;
    });
  }

  private async run<T>(principal: VerifiedServerPrincipal, operation: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    try { return await this.database.withPrincipal(principal, operation); }
    catch (error) { throw new DatabaseUnavailableError(error); }
  }
}

function validAppId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 4_294_967_295;
}
