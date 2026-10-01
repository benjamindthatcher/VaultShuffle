import type { DatabaseClient } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { WISHLIST_CATALOGUE_LANES, selectWishlistCatalogue, type WishlistCatalogueLane, type WishlistDiscoveryRow } from "../../wishlist-catalogue.ts";
import { labels, tags } from "./store-core.ts";

/** Existing four discovery lanes, with shared public facts and bounded hydration. */
export class WishlistDiscoveryRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database=database; }

  async list(): Promise<WishlistDiscoveryRow[]> {
    try {
      return await this.database.sql.begin("isolation level repeatable read read only", async tx => {
        const lanes = {} as Record<WishlistCatalogueLane, {game_id:number}[]>;
        for (const lane of WISHLIST_CATALOGUE_LANES) {
          lanes[lane] = await tx<{game_id:number}[]>`select game_id from catalog.wishlist_discovery_candidates(${lane})`;
        }
        const ids = [...new Set(WISHLIST_CATALOGUE_LANES.flatMap(lane => lanes[lane].map(row => row.game_id)))];
        const byId = new Map<number, WishlistDiscoveryRow>();
        for (let offset = 0; offset < ids.length; offset += 500) {
          const rows = await tx<(Omit<WishlistDiscoveryRow,"steam_appid"|"genres"|"tags"|"review_total"|"review_positive"|"popularity_rank"> & {
            game_id:number;steam_appid:string;genres:unknown;tags:unknown;review_total:string|null;review_positive:string|null;popularity_rank:string|null;
          })[]>`
            select g.id game_id,g.steam_app_id steam_appid,g.title name,coalesce(m.header_image_url,m.capsule_image_url) header_url,
              m.genres,m.weighted_tags tags,f.main_duration_minutes main_story_minutes,f.duration_kind,
              f.review_positive::bigint,f.review_total::bigint,f.popularity_rank,
              price.currency price_currency,price.price_final_cents price_final
            from catalog.games g join catalog.game_metadata m on m.game_id=g.id join catalog.game_features f on f.game_id=g.id
            left join lateral(select p.currency,p.price_final_cents from catalog.offers o
              join catalog.offer_prices p on p.offer_id=o.id and p.is_current and p.currency='USD'
              where o.game_id=g.id and o.region_code='US' order by p.observed_at desc,o.last_observed_at desc,o.id desc limit 1) price on true
            where g.id=any(${tx.array(ids.slice(offset,offset+500))}::integer[])`;
          for (const row of rows) byId.set(row.game_id, {
            steam_appid:Number(row.steam_appid),name:row.name,header_url:row.header_url,genres:labels(row.genres),tags:tags(row.tags),
            main_story_minutes:row.main_story_minutes,duration_kind:row.duration_kind,
            review_total:row.review_total===null?null:Number(row.review_total),review_positive:row.review_positive===null?null:Number(row.review_positive),
            popularity_rank:row.popularity_rank===null?null:Number(row.popularity_rank),price_currency:row.price_currency,price_final:row.price_final,
          });
        }
        const hydrated = Object.fromEntries(WISHLIST_CATALOGUE_LANES.map(lane => [lane,
          lanes[lane].flatMap(row => { const game=byId.get(row.game_id);return game?[game]:[]; }),
        ])) as Record<WishlistCatalogueLane, WishlistDiscoveryRow[]>;
        return selectWishlistCatalogue(hydrated, new Set());
      });
    } catch (error) { throw new DatabaseUnavailableError(error); }
  }
}
