import { dashboardQuery } from "./dashboard-query.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";
import { collectionPageQuery } from "./page-query.ts";

export function collectionQuery(params:URLSearchParams) {
  if(params.toString().length>4096)throw new InvalidPageQueryError();
  const page=new URLSearchParams(),filters=new URLSearchParams();
  for(const [key,value] of params)(key==='cursor'||key==='limit'?page:filters).append(key,value);
  return {...collectionPageQuery(page),globalFilters:dashboardQuery(filters)};
}
