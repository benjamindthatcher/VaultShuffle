import { libraryQuery } from "./library-query.ts";
import { libraryGlobalFilters } from "../repositories/library-global-filters.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

/** Dashboard accepts only the existing standing product filters. */
export function dashboardQuery(params: URLSearchParams) {
  const keys=["device","deck_rating","players","release_age","game_type","access","hide_poorly_reviewed","excluded"];
  for (const key of params.keys()) if (!keys.includes(key)) throw new InvalidPageQueryError();
  return libraryGlobalFilters(libraryQuery(params).globalFilters);
}
