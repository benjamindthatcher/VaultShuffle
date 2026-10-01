import type { GlobalFilters } from "../global-filters.ts";

export function globalFilterParams(filters: GlobalFilters) {
  const params=new URLSearchParams({device:filters.device,deck_rating:filters.deckRating??"verified-playable",players:filters.players,release_age:filters.releaseAge,
    game_type:filters.gameType,access:filters.access,hide_poorly_reviewed:filters.hidePoorlyReviewed?"1":"0"});
  for (const id of filters.excluded) params.append("excluded",id);
  return params.toString();
}
