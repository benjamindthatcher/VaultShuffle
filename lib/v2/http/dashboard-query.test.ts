import assert from "node:assert/strict";
import test from "node:test";
import { dashboardQuery } from "./dashboard-query.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

test("Dashboard accepts bounded standing filters and rejects row/account selectors",()=>{
  for(const value of ["account_id=1","limit=50","device=mac&device=linux","access=private","excluded=unknown","hide_poorly_reviewed=true"])
    assert.throws(()=>dashboardQuery(new URLSearchParams(value)),InvalidPageQueryError);
  const filters=dashboardQuery(new URLSearchParams("device=mac&excluded=puzzle&excluded=strategy&hide_poorly_reviewed=1"));
  assert.equal(filters.device,"mac");assert.equal(filters.hidePoorlyReviewed,true);
  assert.deepEqual(filters.excluded,["puzzle","strategy"]);
});
