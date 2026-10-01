import type {DatabaseClient} from '../db/client.ts';
import {DatabaseUnavailableError} from '../db/errors.ts';
import {selectGuestPool} from '../../guest-pool.ts';
import {fullyEnriched,guestGameFromCatalogue,hasRealGenres,hasTags,type GuestCatalogueRow} from '../../guest-catalogue-model.ts';
import {labels,tags} from './store-core.ts';

/** Public catalogue only; no tenant GUC, account relations, or private state. */
export class GuestRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}
  async list() {
    try {
      return await this.database.sql.begin('isolation level repeatable read read only',async tx=>{
        const rows=await tx<{game_id:number;steam_appid:string;genres:unknown;tags:unknown;popularity_rank:string|null;review_total:string}[]>`
          select * from catalog.guest_catalogue_candidates()`;
        const candidates=rows.map(row=>({game_id:row.game_id,steam_appid:Number(row.steam_appid),genres:labels(row.genres),
          tags:tags(row.tags),popularity_rank:row.popularity_rank===null?null:Number(row.popularity_rank),review_total:Number(row.review_total)}))
          .filter(row=>hasRealGenres(row.genres)&&hasTags(row.tags));
        const selected=selectGuestPool(candidates),ids=selected.map(row=>row.game_id);
        if(!ids.length)return [];
        // Only the selected bounded pool is hydrated; repeatable read keeps the
        // private quarantine gate and metadata coherent across the two phases.
        const full=await tx<(Omit<GuestCatalogueRow,'genres'|'tags'|'categories'> & {game_id:number;genres:unknown;tags:unknown;categories:unknown})[]>`
          select g.id game_id,g.steam_app_id::double precision steam_appid,g.title name,m.genres,m.weighted_tags tags,m.categories,
            m.short_description,m.capsule_image_url capsule_url,m.header_image_url header_url,
            coalesce(f.review_positive,0)::double precision review_positive,f.review_total::double precision review_total,
            f.main_duration_minutes main_story_minutes,f.extras_duration_minutes main_extras_minutes,
            f.completion_duration_minutes completionist_minutes,f.duration_source,
            to_char(f.duration_source_updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') duration_source_updated_at,
            f.duration_confidence_label duration_confidence,f.duration_kind,f.popularity_rank::double precision popularity_rank,
            price.currency price_currency,price.price_initial_cents price_initial,price.price_final_cents price_final,price.is_free,
            case f.windows_compatibility when 'supported' then true when 'unsupported' then false else null end platform_windows,
            case f.mac_compatibility when 'supported' then true when 'unsupported' then false else null end platform_mac,
            case f.linux_compatibility when 'supported' then true when 'unsupported' then false else null end platform_linux,
            f.deck_compatibility_detail deck_compatibility,
            m.release_date::text release_date,f.player_mode
          from catalog.games g join catalog.game_metadata m on m.game_id=g.id join catalog.game_features f on f.game_id=g.id
          left join lateral(select p.currency,p.price_initial_cents,p.price_final_cents,coalesce(p.is_free,o.is_free) is_free
            from catalog.offers o left join catalog.offer_prices p on p.offer_id=o.id and p.is_current and p.currency='USD'
            where o.game_id=g.id and o.region_code='US' order by p.observed_at desc nulls last,o.last_observed_at desc,o.id desc limit 1) price on true
          where g.id=any(${tx.array(ids)}::integer[])`;
        const byId=new Map(full.map(row=>[row.game_id,{...row,genres:labels(row.genres),tags:tags(row.tags),categories:labels(row.categories)}]));
        return selected.flatMap(selected=>{const row=byId.get(selected.game_id);return row&&fullyEnriched(row)?[guestGameFromCatalogue(row)]:[];});
      });
    }catch (error){throw new DatabaseUnavailableError(error);}
  }
}
