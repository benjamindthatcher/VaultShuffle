import type {DatabaseClient} from '../db/client.ts';
import {DatabaseUnavailableError} from '../db/errors.ts';
import {InvalidPageQueryError} from './page-errors.ts';
import {tags} from './store-core.ts';
export type BlogGameFilter={deck?:'verified'|'playable-or-better';durationKind?:'finite'|'endless';mainStoryHours?:readonly[number,number];minReviews?:number;minPositive?:number;tag?:string;playerMode?:'single'|'coop'|'multi';limit?:number};
export type BlogCatalogueRow={steam_appid:number;name:string;header_url:string|null;main_story_minutes:number|null;completionist_minutes:number|null;
  deck_compatibility:number|null;review_total:number|null;review_positive:number|null;player_mode:string|null;release_date:string|null;tags?:Record<string,number>|null};
/** Bounded public facts for the existing article filters and fixed picks. */
export class BlogRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient) {this.database=database;}
  async rows(filter:BlogGameFilter,limit:number,sortReviews:boolean,appIds:readonly number[]|null=null):Promise<BlogCatalogueRow[]> {
    if(!Number.isInteger(limit)||limit<1||limit>2000||appIds&&(!Array.isArray(appIds)||appIds.length>1000||appIds.some(id=>!Number.isSafeInteger(id)||id<1||id>4294967295)))throw new InvalidPageQueryError();
    try {
      const rows=await this.database.sql<(Omit<BlogCatalogueRow,'steam_appid'|'release_date'|'review_total'|'review_positive'|'tags'>&{steam_appid:string;release_date:Date|string|null;review_total:string|null;review_positive:string|null;tags:unknown})[]>`
        select * from catalog.blog_game_candidates(${appIds===null?null:this.database.sql.array(appIds.map(String))}::bigint[],${filter.minReviews??null},
          ${filter.deck==='verified'?3:filter.deck==='playable-or-better'?2:null},${filter.durationKind??null},
          ${filter.mainStoryHours?Math.round(filter.mainStoryHours[0]*60):null},${filter.mainStoryHours?Math.round(filter.mainStoryHours[1]*60):null},
          ${filter.playerMode??null},${limit},${sortReviews},${Boolean(filter.tag)})`;
      return rows.map(row=>({...row,steam_appid:Number(row.steam_appid),release_date:row.release_date instanceof Date?row.release_date.toISOString().slice(0,10):row.release_date,
        review_total:row.review_total===null?null:Number(row.review_total),review_positive:row.review_positive===null?null:Number(row.review_positive),tags:filter.tag?tags(row.tags):undefined}));
    }catch(error){if(error instanceof InvalidPageQueryError)throw error;throw new DatabaseUnavailableError(error);}
  }
}
