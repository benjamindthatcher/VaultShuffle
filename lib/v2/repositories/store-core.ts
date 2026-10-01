import type { DatabaseClient } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import type { StoreCacheEntry, WishlistStoreCache } from "../../wishlist-store-cache.ts";
import type { WishlistGame } from "../../wishlist.ts";
import { isSteamStoreCountry } from "../../steam-store-regions.ts";

export type WishlistCatalogueRow = {
  steam_appid: number; name: string; header_url: string | null; genres: string[];
  tags: Record<string,number>; main_story_minutes: number | null; duration_kind: string | null;
  review_positive: number | null; review_total: number | null;
};

/** Same shared, on-demand cache contract as the existing Steam loader. */
export class StoreRepository implements WishlistStoreCache {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database=database; }

  async catalogue(appIds: readonly number[]): Promise<WishlistCatalogueRow[]> {
    if (!Array.isArray(appIds)||appIds.length>24) throw new InvalidPageQueryError();
    for(const id of appIds) valid(id,"GB");
    if (!appIds.length) return [];
    try {
      const rows=await this.database.sql<{
        steam_app_id:string; title:string; image:string|null; genres:unknown; tags:unknown;
        main_duration_minutes:number|null; duration_kind:string|null;
        review_positive:string|null; review_total:string|null;
      }[]>`
        select g.steam_app_id,g.title,coalesce(m.header_image_url,m.capsule_image_url) image,
          m.genres,m.weighted_tags tags,f.main_duration_minutes,f.duration_kind,f.review_positive,f.review_total
        from catalog.games g left join catalog.game_metadata m on m.game_id=g.id
        left join catalog.game_features f on f.game_id=g.id
        where g.steam_app_id=any(${this.database.sql.array(appIds.map(String))}::bigint[])
          and g.lifecycle_status='active'
      `;
      return rows.map(row=>({steam_appid:Number(row.steam_app_id),name:row.title,header_url:row.image,
        genres:labels(row.genres),tags:tags(row.tags),main_story_minutes:row.main_duration_minutes,
        duration_kind:row.duration_kind,review_positive:nullableNumber(row.review_positive),review_total:nullableNumber(row.review_total)}));
    } catch { throw new DatabaseUnavailableError(); }
  }
  async claim(appId:number,country:string,token:string):Promise<StoreCacheEntry> {
    valid(appId,country); validToken(token);
    return this.run(async()=> {
      const rows=await this.database.sql<{entry:StoreCacheEntry}[]>`select catalog.claim_wishlist_store_refresh(${String(appId)},${country},${token}::uuid) entry`;
      return rows[0].entry;
    });
  }
  async read(appId:number,country:string):Promise<StoreCacheEntry> {
    valid(appId,country);
    return this.run(async()=> {
      const rows=await this.database.sql<{entry:StoreCacheEntry}[]>`select jsonb_build_object('game',game,'checked_at',checked_at,'expires_at',expires_at,'retry_after',retry_after,'lease_until',lease_until) entry
        from catalog.wishlist_store_cache where steam_app_id=${String(appId)} and country=${country}`;
      if (!rows[0]) throw new DatabaseUnavailableError();
      return rows[0].entry;
    });
  }
  async finish(appId:number,country:string,token:string,game:WishlistGame,checkedAt:string,expiresAt:string) {
    valid(appId,country); validToken(token);
    if (game.appId!==appId || !validDate(checkedAt) || !validDate(expiresAt) || Date.parse(expiresAt)<=Date.parse(checkedAt)) throw new InvalidPageQueryError();
    await this.run(()=>this.database.sql`update catalog.wishlist_store_cache
      set game=${this.database.sql.json(game)},checked_at=${checkedAt},expires_at=${expiresAt},retry_after='epoch',lease_token=null,lease_until='epoch'
      where steam_app_id=${String(appId)} and country=${country} and lease_token=${token}::uuid`);
  }
  async fail(appId:number,country:string,token:string,retryAfter:string) {
    valid(appId,country); validToken(token);
    if (!validDate(retryAfter)) throw new InvalidPageQueryError();
    await this.run(()=>this.database.sql`update catalog.wishlist_store_cache set retry_after=${retryAfter},lease_token=null,lease_until='epoch'
      where steam_app_id=${String(appId)} and country=${country} and lease_token=${token}::uuid`);
  }
  private async run<T>(operation:()=>Promise<T>):Promise<T> {
    try { return await operation(); } catch { throw new DatabaseUnavailableError(); }
  }
}
function valid(id:number,country:string) {
  if (!Number.isSafeInteger(id)||id<1||id>4294967295||!isSteamStoreCountry(country)) throw new InvalidPageQueryError();
}
function validToken(token:string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) throw new InvalidPageQueryError(); }
function validDate(value:string) { return typeof value==='string' && Number.isFinite(Date.parse(value)); }
function nullableNumber(value:string|null) { return value===null?null:Number(value); }
export function labels(value:unknown):string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item=>typeof item==='string'?[item]:item&&typeof item==='object'&&typeof item.label==='string'?[item.label]:[]);
}
export function tags(value:unknown):Record<string,number> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap(item=>item&&typeof item==='object'&&typeof item.tag==='string'&&typeof item.weight==='number'&&Number.isFinite(item.weight)&&item.weight>=0?[[item.tag,item.weight]]:[]));
}
