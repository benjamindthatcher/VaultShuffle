import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient, VerifiedServerPrincipal } from "../db/client.ts";
import { LibraryRepository } from "./library-core.ts";
import { InvalidPageQueryError } from "./page-errors.ts";

const principal: VerifiedServerPrincipal = { accountId: 1, accountPublicId: "11111111-1111-4111-8111-111111111111", accountKind: "manual", sessionId: "1", sessionKind: "manual", identityVerified: false };
function client(rows: unknown[]): DatabaseClient {
  const sql = Object.assign(async () => rows, { array: (values: readonly string[]) => values }) as unknown as DatabaseClient["sql"];
  return { sql, withPrincipal: async (_p, operation) => operation(sql as never), close: async () => {} };
}
test("library page preserves null minutes, owned access and bounded keyset cursor", async () => {
  const revisions={library_revision:"1",state_revision:"2",catalog_revision:"c",feature_revision:"f"};
  const repository = new LibraryRepository(client([{ game_id: 1,title:"Alpha",steam_app_id:1,playtime_minutes:null,access:"owned",completed:false,blacklisted:false,last_played_at:null,sort_value:null,total:"2",...revisions },{ game_id: 2,title:"Beta",steam_app_id:2,playtime_minutes:0,access:"family",completed:false,blacklisted:false,last_played_at:null,sort_value:null,total:"2",...revisions }]));
  const page=await repository.list(principal,{limit:1});
  assert.equal(page.items[0]?.playtimeMinutes,null); assert.equal(page.items[0]?.access,"owned"); assert.ok(page.nextCursor);
});
test("library rejects oversized and malformed inputs as typed future-400 failures", async () => {
  const repository=new LibraryRepository(client([]));
  await assert.rejects(()=>repository.list(principal,{limit:101}),InvalidPageQueryError);
  await assert.rejects(()=>repository.list(principal,{cursor:"bad"}),InvalidPageQueryError);
});
