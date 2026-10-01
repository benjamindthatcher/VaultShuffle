import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createDatabaseClient, type DatabaseClient, type VerifiedServerPrincipal } from "../db/client.ts";
import { parseDatabaseConfig } from "../db/config.ts";
import { BootstrapRepository } from "./bootstrap-core.ts";
import { LibraryRepository, type LibraryCard, type LibraryQuery } from "./library-core.ts";
import { DashboardRepository } from "./dashboard-core.ts";
import { CollectionsRepository } from "./collections-core.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "./page-errors.ts";
import { UnsupportedCollectionRuleError } from "./smart-predicates.ts";
import { WishlistRepository, InvalidWishlistQueryError } from "./wishlist-core.ts";
import { verifyRuntimeDatabase } from "../db/runtime-check.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { SessionRepository } from "./session-core.ts";
import { bootstrapResponse } from "../http/bootstrap.ts";
import { authenticatedRead } from "../http/read-response.ts";
import { libraryQuery } from "../http/library-query.ts";
import { collectionPageQuery, wishlistPageQuery } from "../http/page-query.ts";
import { AuthRepository } from "./auth-core.ts";
import { MutationsRepository, GameNotFoundError, StaleMutationError } from "./mutations-core.ts";
import { StoreRepository } from "./store-core.ts";
import { DEFAULT_GLOBAL_FILTERS } from "../../global-filters.ts";
import { libraryGame } from "../library-view-model.ts";
import { findCompletionCandidates } from "../../completion-check.ts";
import { matchesGlobalFilters } from "../../global-filters.ts";
import { EXCLUSION_CATEGORIES } from "../../exclusion-categories.ts";
import { CollectionMutationsRepository, CollectionNotFoundError, CollectionConflictError } from "./collection-mutations-core.ts";
import { VaultRepository } from "./vault-core.ts";
import { buildVaultPool, buildVaultDeck } from "../../vault.ts";
import type { VaultSetup, VaultDrawRequest } from "../vault.ts";
import { buildGenrePreferenceIndex } from "../../genre-preferences.ts";
import {FamilyRepository,FamilyRequestError,type FamilySnapshot} from "./family-core.ts";
import {addV2FamilyMember} from "../family-lookup.ts";
import {ImportRepository} from "./import-core.ts";
import {RequestLimitError} from "../db/errors.ts";
import {verifyWorkerDatabase} from "../db/worker-check.ts";
import {createOwnedWorkerInvoker,runOwnedWorkerBatch} from "../import/owned-worker-core.ts";
import {PinnedRepository,PinnedRefreshError} from './pinned-core.ts';
import {refreshV2PinnedPlaytime} from '../pinned-playtime.ts';
import {GuestRepository} from './guest-core.ts';

const PG_BIN = join(process.cwd(), "node_modules/.cache/vaultshuffle-pg17-20260910/bin");
const MIGRATION_ROOT = join(process.cwd(), "database/v2/supabase/migrations");
const MIGRATIONS = readdirSync(MIGRATION_ROOT).filter(name => name.endsWith(".sql")).sort()
  .map(name => join(MIGRATION_ROOT, name));

type Fixture = Readonly<{
  root: string;
  socket: string;
  port: number;
  database: DatabaseClient;
  bootstrap: BootstrapRepository;
  library: LibraryRepository;
  dashboard: DashboardRepository;
  collections: CollectionsRepository;
}>;

const ACCOUNT_A: VerifiedServerPrincipal = Object.freeze({
  accountId: 1,
  accountPublicId: "11111111-1111-4111-8111-111111111111",
  accountKind: "manual",
  sessionId: "1001",
  sessionKind: "manual",
  identityVerified: false,
});
const ACCOUNT_B: VerifiedServerPrincipal = Object.freeze({
  accountId: 2,
  accountPublicId: "22222222-2222-4222-8222-222222222222",
  accountKind: "manual",
  sessionId: "1002",
  sessionKind: "manual",
  identityVerified: false,
});
const EMPTY_ACCOUNT: VerifiedServerPrincipal = Object.freeze({
  accountId: 3,
  accountPublicId: "33333333-3333-4333-8333-333333333333",
  accountKind: "manual",
  sessionId: "1003",
  sessionKind: "manual",
  identityVerified: false,
});

function command(binary: string, args: readonly string[]): void {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 120_000,
    env: { LC_ALL: "C", PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`local PostgreSQL command failed: ${binary}; ${(result.stderr ?? "").trim()}`);
  }
}

function psql(fixture: Pick<Fixture, "socket" | "port">, sql: string, tuples = false): string {
  const args = [
    "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", fixture.socket,
    "-p", String(fixture.port), "-U", "postgres", "-d", "vault_m4_read",
  ];
  if (tuples) args.push("-A", "-t");
  args.push("-c", sql);
  const result = spawnSync(join(PG_BIN, "psql"), args, {
    encoding: "utf8",
    timeout: 120_000,
    env: { LC_ALL: "C", PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`local PostgreSQL fixture SQL failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

function seed(fixture: Pick<Fixture, "socket" | "port">): void {
  psql(fixture, `
    create role vault_read_runtime login;
    grant vault_app to vault_read_runtime with inherit true, set false;

    insert into app.accounts (id, public_id, account_kind, display_name, library_revision, state_revision)
      overriding system value values
      (1, '11111111-1111-4111-8111-111111111111', 'manual', 'Read A', 123, 456),
      (2, '22222222-2222-4222-8222-222222222222', 'manual', 'Read B', 7, 8),
      (3, '33333333-3333-4333-8333-333333333333', 'manual', 'Read Empty', 0, 0);

    insert into catalog.games (id, steam_app_id, title, normalized_sort_title, lifecycle_status)
      overriding system value
      select game_id, 100000 + game_id,
        'Game ' || lpad(((game_id - 1) / 3)::text, 4, '0'),
        'game ' || lpad(((game_id - 1) / 3)::text, 4, '0'),
        case when game_id = 1105 then 'retired' else 'active' end
      from generate_series(1, 1205) game_id;

    insert into catalog.game_metadata
      (game_id, short_description, capsule_image_url, genres, weighted_tags)
      select game_id,
        case when game_id in (5, 1150) then 'Retained synthetic description ' || game_id else null end,
        case when game_id in (5, 1150) then 'https://example.invalid/' || game_id || '.jpg' else null end,
        case game_id % 4
          when 0 then '["Action","RPG"]'::jsonb
          when 1 then '[{"label":"Strategy"}]'::jsonb
          when 2 then '["Puzzle"]'::jsonb
          else '[]'::jsonb
        end,
        case
          when game_id = 5 then '[{"tag":"Strategy","weight":9},{"tag":"Tactical","weight":4}]'::jsonb
          when game_id % 4 = 3 then '[{"tag":"Adventure","weight":7}]'::jsonb
          else '[]'::jsonb
        end
      from generate_series(1, 1205) game_id;

    insert into app.library_games (account_id, game_id, playtime_minutes)
      select 1, game_id, case when game_id = 1 then null when game_id = 2 then 0 else game_id * 2 end
      from generate_series(1, 1005) game_id;
    insert into app.library_games (account_id, game_id, playtime_minutes)
      values (2, 1150, 77);

    insert into app.family_members (id, account_id, steam_id, candidate_count)
      overriding system value values (11, 1, 76561198000000011, 116), (12, 1, 76561198000000012, 106);
    insert into app.family_game_access (account_id, member_id, game_id, provenance)
      select 1, 11, game_id, 'verified' from generate_series(990, 1105) game_id;
    insert into app.family_game_access (account_id, member_id, game_id, provenance)
      select 1, 12, game_id, 'inferred' from generate_series(1000, 1105) game_id;

    insert into app.game_state (account_id, game_id, completed_at, blacklisted, manual_progress, notes, revision)
      values
        (1, 5, null, false, 12.50, 'A retained private note', 4),
        (1, 10, '2026-09-01 10:00:00+00', false, 100, 'Completed note', 2),
        (1, 11, null, true, null, 'Blacklisted note', 3),
        (2, 1150, null, false, 44.25, 'B private note', 9);
    insert into app.game_activity
      (account_id, game_id, last_observed_minutes, last_played_at, evidence_source)
      values (1, 5, 10, '2026-08-09 10:11:12+00', 'user'),
             (2, 1150, 77, '2026-08-10 11:12:13+00', 'user');

    insert into app.pins (account_id, scope, slot, game_id)
      values (1, 'library', 1, 1), (1, 'library', 2, 2), (1, 'library', 3, 3),
             (1, 'family', 1, 1006), (1, 'family', 2, 1007), (1, 'family', 3, 1008);
    insert into app.vault_state (account_id, current_game_id, revision)
      values (1, 5, 19);

    update catalog.games set first_seen_at='2026-01-01 00:00:00+00'::timestamptz + id * interval '1 minute';
    insert into catalog.game_features(game_id,feature_revision,main_duration_minutes,extras_duration_minutes,completion_duration_minutes,duration_kind)
      select game_id,1,case when game_id%13=0 then null else 600 end,null,case when game_id%13=0 then null else 900 end,case when game_id%17=0 then 'endless' else 'finite' end from generate_series(1,1205) game_id;
    insert into app.game_activity(account_id,game_id,last_observed_minutes,last_played_at,observed_at,evidence_source,recency_evidence_kind)
      values (1,6,12,'2026-09-10 00:00:00+00','2026-09-10 00:00:00+00','user','steam_exact'),(1,7,14,'2025-01-01 00:00:00+00','2025-01-01 00:00:00+00','user','observed_playtime_change');
    insert into app.playtime_daily(account_id,activity_day,observed_minutes,coverage) values
      (1,'2026-09-10',1000,'complete'),(1,'2026-09-11',1060,'complete'),(1,'2026-09-12',1120,'complete'),(1,'2026-09-13',1180,'complete'),(1,'2026-09-14',1240,'complete');

    insert into app.collections(id,public_id,account_id,collection_kind,name,description,rules,revision) overriding system value values
      (1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'custom','Everything','Position order',null,9),
      (2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'smart','Untouched','Automatic',jsonb_build_object('version',1,'preset','untouched'),3),
      (3,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,'custom','Other tenant',null,null,1),
      (4,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'smart','Quick wins','Automatic',jsonb_build_object('version',1,'preset','quick-wins'),2),
      (5,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',1,'smart','Endless','Automatic',jsonb_build_object('version',1,'preset','endless-rotation'),1);
    select setval('app.collections_id_seq',5,true);
    insert into app.collection_games(account_id,collection_id,game_id,position,note)
      select 1,1,game_id,game_id*2,case when game_id=5 then 'membership note' else null end from generate_series(1,1001) game_id;
    insert into app.collection_games(account_id,collection_id,game_id,position) values(2,3,1150,0);
  `);
}

function createFixture(): Fixture {
  const root = mkdtempSync("/tmp/vaultshuffle-m4-read-");
  const data = join(root, "data");
  const socket = join(root, "socket");
  const port = 58_000 + (process.pid % 1_000);
  mkdirSync(socket);
  const partial = { root, socket, port };
  let started = false;
  try {
    command(join(PG_BIN, "initdb"), ["-D", data, "-A", "trust", "-U", "postgres", "-c", "shared_memory_type=mmap", "-c", "dynamic_shared_memory_type=mmap"]);
    command(join(PG_BIN, "pg_ctl"), ["-D", data, "-l", join(root, "postgres.log"), "-o", `-F -c listen_addresses='' -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap -k ${socket} -p ${port}`, "-w", "start"]);
    started = true;
    command(join(PG_BIN, "createdb"), ["-h", socket, "-p", String(port), "-U", "postgres", "vault_m4_read"]);
    for (const migration of MIGRATIONS) {
      command(join(PG_BIN, "psql"), [
        "-X", "-q", "-w", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", String(port),
        "-U", "postgres", "-d", "vault_m4_read", "-f", migration,
      ]);
    }
    seed(partial);
    const database = createDatabaseClient(parseDatabaseConfig({
      connectionString: `postgres://vault_read_runtime@localhost:${port}/vault_m4_read`,
      socketPath: socket,
      maxConnections: 1,
    }));
    return Object.freeze({
      ...partial,
      database,
      bootstrap: new BootstrapRepository(database),
      library: new LibraryRepository(database),
      dashboard: new DashboardRepository(database),
      collections: new CollectionsRepository(database),
    });
  } catch (error) {
    if (started) command(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.database.close();
  command(join(PG_BIN, "pg_ctl"), ["-D", join(fixture.root, "data"), "-m", "immediate", "-w", "stop"]);
  rmSync(fixture.root, { recursive: true, force: true });
}

async function collect(repository: LibraryRepository, principal: VerifiedServerPrincipal, query: LibraryQuery = {}) {
  const items: LibraryCard[] = [];
  let cursor: string | undefined;
  let expectedTotal: number | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await repository.list(principal, { ...query, limit: query.limit ?? 37, ...(cursor ? { cursor } : {}) });
    expectedTotal ??= page.total;
    assert.equal(page.total, expectedTotal, "filtered total must remain stable on every cursor page");
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor) assert.equal(seenCursors.has(cursor), false, "a page cursor must advance");
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  assert.equal(new Set(items.map((item) => item.gameId)).size, items.length, "keyset pages must not duplicate a game");
  assert.equal(items.length, expectedTotal ?? 0, "reported count must equal the complete filtered rowset");
  return Object.freeze({ items: Object.freeze(items), total: expectedTotal ?? 0 });
}

test("M4 bootstrap and library repositories pass a 1,000+ row PostgreSQL 17 acceptance fixture", async (t) => {
  const fixture = createFixture();
  t.after(async () => disposeFixture(fixture));

  await t.test("runtime connection refuses wrong projects and operator or worker privileges", async () => {
    await verifyRuntimeDatabase(fixture.database, "vbjtbwelnhbbdfrqczyf");
    await assert.rejects(() => verifyRuntimeDatabase(fixture.database, "pfvblcopcmairdfeqdep"), DatabaseUnavailableError);
    psql(fixture, "grant vault_worker to vault_read_runtime with inherit false, set true");
    try {
      await assert.rejects(() => verifyRuntimeDatabase(fixture.database, "vbjtbwelnhbbdfrqczyf"), DatabaseUnavailableError);
    } finally { psql(fixture, "revoke vault_worker from vault_read_runtime"); }
    psql(fixture, "alter role vault_read_runtime bypassrls");
    try {
      await assert.rejects(() => verifyRuntimeDatabase(fixture.database, "vbjtbwelnhbbdfrqczyf"), DatabaseUnavailableError);
    } finally { psql(fixture, "alter role vault_read_runtime nobypassrls"); }
  });

  await t.test("bootstrap HTTP handler resolves the cookie against PostgreSQL before tenant reads", async () => {
    const token = "manual.bootstrap-fixture";
    const secret = "local-bootstrap-secret";
    const digest = createHmac("sha256", secret).update(token).digest("hex");
    psql(fixture, `insert into app.sessions(id,account_id,token_digest,session_kind,expires_at)
      overriding system value values (1001,1,decode('${digest}','hex'),'manual',now()+interval '1 day')`);
    const services = async () => ({ sessions: new SessionRepository(fixture.database), bootstrap: fixture.bootstrap });
    const response = await bootstrapResponse(token, secret, services);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), await fixture.bootstrap.read(ACCOUNT_A));
    const pageServices = async () => ({ ...(await services()), library: fixture.library });
    const readPage = (params: URLSearchParams) => authenticatedRead(token, secret, pageServices,
      (runtime, principal) => runtime.library.list(principal, libraryQuery(params)));
    const pageResponse = await readPage(new URLSearchParams("limit=17&sort=title"));
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.items.length, 17);
    assert.equal(typeof page.nextCursor, "string");
    const changedQuery = await readPage(new URLSearchParams({ cursor: page.nextCursor, limit: "17", sort: "hours" }));
    assert.equal(changedQuery.status, 409);
    assert.deepEqual(await changedQuery.json(), { error: "cursor_restart_required", retryable: false });
    const callerAccount = await readPage(new URLSearchParams("account_id=2"));
    assert.equal(callerAccount.status, 400);
    const missingGame = await authenticatedRead(token, secret, pageServices,
      (runtime, principal) => runtime.library.detail(principal, 999999));
    assert.equal(missingGame.status, 404);
    const dashboard = await authenticatedRead(token, secret, services, (_runtime, principal) => fixture.dashboard.read(principal));
    assert.equal(dashboard.status, 200);
    const summary = await dashboard.json();
    assert.ok(summary.mostPlayed.length <= 5 && summary.recentCompletions.length <= 8 && summary.completionSuggestions.length <= 50);
    const collections = await authenticatedRead(token, secret, services, (_runtime, principal) => fixture.collections.list(principal));
    assert.equal(collections.status, 200);
    const metadata = await collections.json();
    const custom = metadata.find((row: { kind: string }) => row.kind === "custom");
    assert.ok(custom);
    const members = await authenticatedRead(token, secret, services, (_runtime, principal) =>
      fixture.collections.members(principal, custom.publicId, collectionPageQuery(new URLSearchParams("limit=19"))));
    assert.equal(members.status, 200);
    const memberPage = await members.json();
    assert.equal(memberPage.items.length, 19);
    assert.ok(memberPage.total > 1000 && memberPage.nextCursor);
    const wishlist = new WishlistRepository(fixture.database);
    await wishlist.save(ACCOUNT_A, [4_294_967_294], "steam");
    const saved = await authenticatedRead(token, secret, services, (_runtime, principal) => {
      const query = wishlistPageQuery(new URLSearchParams("offset=0&limit=24"));
      return wishlist.list(principal, query.offset, query.limit);
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).items[0].appId, 4_294_967_294);
    await wishlist.remove(ACCOUNT_A, 4_294_967_294);
    const wrongSecret = await bootstrapResponse(token, "wrong-secret", services);
    assert.equal(wrongSecret.status, 401);
    psql(fixture, "update app.sessions set revoked_at=statement_timestamp() where id=1001");
    const revoked = await bootstrapResponse(token, secret, services);
    assert.equal(revoked.status, 401);
  });

  await t.test("Wishlist saves absent catalogue AppIDs atomically, preserves duplicates and isolates tenants", async () => {
    const wishlist = new WishlistRepository(fixture.database);
    assert.equal(await wishlist.save(ACCOUNT_A, [4_294_967_295], "local"), 1);
    psql(fixture, "update app.wishlist_games set added_at='2026-09-01 12:34:56.123456+00' where account_id=1");
    const addedAt = (await wishlist.list(ACCOUNT_A)).items[0].addedAt;
    assert.equal(await wishlist.save(ACCOUNT_A, [4_294_967_295,4_294_967_295,900000], "steam"), 1);
    const concurrent = await Promise.all([wishlist.save(ACCOUNT_A,[900001],"local"),wishlist.save(ACCOUNT_A,[900001],"local")]);
    assert.equal(concurrent.reduce((a,b) => a+b,0), 1);
    const page = await wishlist.list(ACCOUNT_A,0,2);
    assert.equal(page.total,3);
    assert.equal(page.items.length,2);
    assert.deepEqual(page.appIds,[900000,900001,4_294_967_295]);
    const original = (await wishlist.list(ACCOUNT_A,2,2)).items[0];
    assert.deepEqual(original,{appId:4_294_967_295,source:"local",addedAt});
    assert.ok(addedAt.includes("123456"), "exact imported provenance is not renewed by duplicates");
    assert.equal((await wishlist.list(ACCOUNT_B)).total,0);
    await wishlist.save(ACCOUNT_B,[900000],"local");
    await wishlist.remove(ACCOUNT_A,900000);
    assert.equal((await wishlist.list(ACCOUNT_B)).total,1);
    assert.equal((await wishlist.list(ACCOUNT_A)).total,2);
    await assert.rejects(() => wishlist.save(ACCOUNT_A,[900002,0],"steam"),InvalidWishlistQueryError);
    assert.equal((await wishlist.list(ACCOUNT_A)).total,2);
    await assert.rejects(() => wishlist.list(ACCOUNT_A,0,25),InvalidWishlistQueryError);
    await assert.rejects(() => fixture.database.withPrincipal(ACCOUNT_A,tx => tx`
      insert into app.wishlist_games(account_id,steam_app_id) values(1,900003),(2,900004)
    `));
    assert.equal((await wishlist.list(ACCOUNT_A)).total,2,"a late RLS failure cannot partially import");
    assert.equal(Number((await fixture.database.sql`select count(*) n from app.wishlist_games`)[0].n),0);
    const ids = Array.from({length:10000},(_,i) => 1_000_000+i);
    assert.equal(await wishlist.save(ACCOUNT_A,ids,"steam"),10000);
    assert.equal((await wishlist.list(ACCOUNT_A,9990)).items.length,12);
    psql(fixture,"delete from app.wishlist_games");
  });

  await t.test("legacy current-owned totals with unknown coverage never become claimed daily playtime gains", async () => {
    psql(fixture,`insert into app.playtime_daily(account_id,activity_day,observed_minutes,coverage) values
      (2,'2026-09-10',1000,'unknown'),(2,'2026-09-11',5000,'unknown'),(2,'2026-09-12',100,'complete')`);
    const dashboard = await fixture.dashboard.read(ACCOUNT_B);
    assert.equal(dashboard.trend.daysTracked,3);
    assert.deepEqual(dashboard.trend.dailyGains,[]);
    assert.equal(dashboard.trend.minutesLast7Days,0);
    assert.equal(dashboard.trend.minutesLast30Days,0);
    assert.equal(psql(fixture,"select string_agg(observed_minutes::text,',' order by activity_day) from app.playtime_daily where account_id=2",true),"1000,5000,100");
  });

  await t.test("bootstrap stays bounded and returns only library pins plus revision/current-pick metadata", async () => {
    const payload = await fixture.bootstrap.read(ACCOUNT_A);
    assert.deepEqual({
      accountPublicId: payload.accountPublicId,
      libraryRevision: payload.libraryRevision,
      stateRevision: payload.stateRevision,
      ownedTotal: payload.ownedTotal,
      familyTotal: payload.familyTotal,
      pins: payload.pins.map(({slot,gameId,title})=>({slot,gameId,title})),
      currentPick: payload.currentPick,
    }, {
      accountPublicId: ACCOUNT_A.accountPublicId,
      libraryRevision: "123",
      stateRevision: "456",
      ownedTotal: 1005,
      familyTotal: 99,
      pins: [
        { slot: 1, gameId: 1, title: "Game 0000" },
        { slot: 2, gameId: 2, title: "Game 0000" },
        { slot: 3, gameId: 3, title: "Game 0000" },
      ],
      currentPick: { gameId: 5, title: "Game 0001", drawId: null },
    });
    assert.ok(JSON.stringify(payload).length < 1100, "bootstrap payload must stay independent of library row count");

    const empty = await fixture.bootstrap.read(EMPTY_ACCOUNT);
    assert.equal(empty.ownedTotal, 0);
    assert.equal(empty.familyTotal, 0);
    assert.deepEqual(empty.pins, []);
    assert.equal(empty.currentPick, null);
  });

  await t.test("keyset paging is deterministic across title ties with no omissions or duplicate lenders", async () => {
    const result = await collect(fixture.library, ACCOUNT_A, { sort: "title", direction: "asc" });
    assert.equal(result.total, 1102);
    assert.equal(result.items.some((item) => item.gameId === 10), false);
    assert.equal(result.items.some((item) => item.gameId === 11), false);
    assert.equal(result.items.some((item) => item.gameId === 1105), false);
    for (let index = 1; index < result.items.length; index += 1) {
      const previous = result.items[index - 1];
      const current = result.items[index];
      assert.ok(previous.title < current.title || (previous.title === current.title && previous.gameId < current.gameId));
    }

    assert.deepEqual(result.items.slice(-2).map((item) => item.gameId), [1103, 1104]);
  });

  await t.test("owned overlap wins and nullable personal minutes never become family or zero minutes", async () => {
    const unknown = await fixture.library.detail(ACCOUNT_A, 1);
    const zero = await fixture.library.detail(ACCOUNT_A, 2);
    const overlap = await fixture.library.detail(ACCOUNT_A, 1000);
    const family = await fixture.library.detail(ACCOUNT_A, 1006);
    assert.equal(unknown?.playtimeMinutes, null);
    assert.equal(zero?.playtimeMinutes, 0);
    assert.deepEqual({ access: overlap?.access, minutes: overlap?.playtimeMinutes }, { access: "owned", minutes: 2000 });
    assert.deepEqual({ access: family?.access, minutes: family?.playtimeMinutes }, { access: "family", minutes: null });
    const familyOnly = await collect(fixture.library, ACCOUNT_A, { access: "family" });
    assert.equal(familyOnly.total, 99);
    assert.ok(familyOnly.items.every((item) => item.playtimeMinutes === null));
  });

  await t.test("completed, blacklist, access, search, genre and progress counts match their complete rowsets", async () => {
    const cases: readonly LibraryQuery[] = [
      { includeCompleted: true },
      { includeBlacklisted: true },
      { includeCompleted: true, includeBlacklisted: true },
      { access: "owned" },
      { access: "family" },
      { search: "Game 0004" },
      { genres: ["action"] },
      { genres: ["STRATEGY", "adventure"] },
      { progress: "not-started" },
      { progress: "in-progress" },
    ];
    for (const query of cases) await collect(fixture.library, ACCOUNT_A, query);

    assert.equal((await collect(fixture.library, ACCOUNT_A, { includeCompleted: true })).total, 1103);
    assert.equal((await collect(fixture.library, ACCOUNT_A, { includeBlacklisted: true })).total, 1103);
    assert.equal((await collect(fixture.library, ACCOUNT_A, { includeCompleted: true, includeBlacklisted: true })).total, 1104);
    assert.equal((await collect(fixture.library, ACCOUNT_A, { access: "owned" })).total, 1003);
    assert.equal((await collect(fixture.library, ACCOUNT_A, { search: "Game 0004" })).total, 3);
    assert.deepEqual((await collect(fixture.library, ACCOUNT_A, { progress: "not-started" })).items.map((item) => item.gameId), [2]);
    assert.equal((await collect(fixture.library, ACCOUNT_A, { progress: "in-progress" })).total, 1001);
    assert.deepEqual((await collect(fixture.library, ACCOUNT_A, { section: "completed" })).items.map((item) => item.gameId), [10]);
    assert.deepEqual((await collect(fixture.library, ACCOUNT_A, { section: "blacklisted" })).items.map((item) => item.gameId), [11]);
  });

  await t.test("product pages retain metadata and unknown facts without loading private detail text", async () => {
    psql(fixture, `insert into app.library_legacy_measurements(account_id,steam_app_id,legacy_date_added_raw,discrepancy_kind)
      values(1,100005,'2020-01-02','date_added_text_only'),(2,101150,'2021-03-04','date_added_text_only')`);
    const page = await fixture.library.list(ACCOUNT_A, { search: "Game 0001", section: "all", limit: 2 });
    const card = page.items.find(item => item.gameId === 5);
    assert.ok(card?.product);
    assert.equal(card.product.dateAdded, '2020-01-02');
    assert.deepEqual(card.product.tags, { Strategy: 9, Tactical: 4 });
    assert.equal(card.notes, undefined);
    assert.equal(card.description, undefined);
    assert.equal(card.product.manualProgress, 12.5);
    assert.deepEqual(page.sectionCounts, { active: 1102, completed: 1, blacklisted: 1 });
    assert.ok(page.filterGenres.length <= 18);
    const detail = await fixture.library.detail(ACCOUNT_A, 5);
    assert.equal(detail?.notes, 'A retained private note');
    assert.equal(detail?.product?.dateAdded, '2020-01-02');
    const unknown = libraryGame((await fixture.library.detail(ACCOUNT_A, 1))!);
    assert.equal(unknown.playtimeKnown, false);
    assert.equal(unknown.progressKnown, false);
    assert.equal(unknown.dateAdded, null);
    assert.equal(unknown.addedLabel, '');
    assert.equal(unknown.platforms?.windows, false);
    const family = libraryGame((await fixture.library.detail(ACCOUNT_A, 1006))!);
    assert.equal(family.playtimeKnown, false);
    assert.equal(family.familyOwnerSteamId, '76561198000000011');
    assert.equal((await fixture.database.sql`select steam_app_id from app.library_legacy_measurements`).length, 0);
    await assert.rejects(() => fixture.database.withPrincipal(ACCOUNT_A, tx => tx`select legacy_hours_played from app.library_legacy_measurements`));
    assert.deepEqual(Array.from(await fixture.database.withPrincipal(ACCOUNT_A, tx => tx`select steam_app_id::text from app.library_legacy_measurements`)), [{steam_app_id:'100005'}]);
    psql(fixture, 'delete from app.library_legacy_measurements');
  });

  await t.test("standing filters and Library pins affect the complete server rowset before paging", async () => {
    const all = await collect(fixture.library, ACCOUNT_A, { section: 'all', limit: 100 });
    for (const changes of [
      { device: 'mac' }, { device: 'linux' }, { device: 'deck' }, { device: 'deck', deckRating: 'verified' }, { players: 'single' },
      { releaseAge: 'recent' }, { releaseAge: 'classic' }, { gameType: 'finite' }, { gameType: 'endless' },
      { hidePoorlyReviewed: true }, { excluded: ['strategy'] }, { excluded: ['strategy','puzzle'] },
    ] as const) {
      const filters = {...DEFAULT_GLOBAL_FILTERS, ...changes, excluded: 'excluded' in changes && changes.excluded ? [...changes.excluded] : []};
      const expected = all.items.filter(card => matchesGlobalFilters(libraryGame(card), filters)).map(card => card.gameId).sort((a,b) => a-b);
      const actual = await collect(fixture.library, ACCOUNT_A, { section: 'all', globalFilters: filters, limit: 100 });
      assert.deepEqual(actual.items.map(card => card.gameId).sort((a,b) => a-b), expected);
      assert.equal(actual.total, expected.length);
    }
    const pinsExcluded = await fixture.library.list(ACCOUNT_A, { section:'active', excludePins: true, limit: 1 });
    assert.equal(pinsExcluded.total, 1099);
    assert.equal(pinsExcluded.sectionCounts.active, 1099);
    const searched = await fixture.library.list(ACCOUNT_A, { section:'active', excludePins: true, search:'Game 0004', limit: 1 });
    assert.equal(searched.total, 3);
    assert.equal(searched.sectionCounts.active, 1099);
    const cursor = (await fixture.library.list(ACCOUNT_A, { section:'all', limit: 2 })).nextCursor!;
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { section:'all', limit: 2, cursor, globalFilters:{...DEFAULT_GLOBAL_FILTERS,device:'mac'} }), PageCursorRestartRequiredError);
  });

  await t.test("versioned cursors bind tenant, filters, sorts and all applicable revisions", async () => {
    const first = await fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours" });
    assert.ok(first.nextCursor);
    assert.deepEqual(Object.keys(first.revision), ["library", "state", "catalog", "features"]);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "title", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", search: "game", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_B, { limit: 2, sort: "hours", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    psql(fixture, "update app.accounts set state_revision=state_revision+1 where id=1");
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    const libraryCursor = await fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours" });
    psql(fixture, "update app.accounts set library_revision=library_revision+1 where id=1");
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", cursor: libraryCursor.nextCursor! }), PageCursorRestartRequiredError);
    const catalogCursor = await fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours" });
    psql(fixture, "update catalog.games set updated_at=updated_at+interval '1 second' where id=1");
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", cursor: catalogCursor.nextCursor! }), PageCursorRestartRequiredError);
    const featureCursor = await fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours" });
    psql(fixture, "update catalog.game_features set feature_revision=feature_revision+1 where game_id=1");
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", cursor: featureCursor.nextCursor! }), PageCursorRestartRequiredError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { cursor: Buffer.from('{}').toString('base64url') }), InvalidPageQueryError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { cursor: "x".repeat(2049) }), InvalidPageQueryError);
  });

  await t.test("all Library sorts cross ties and nulls without duplicate or missing games", async () => {
    for (const sort of ["recent", "title", "hours", "progress", "added", "duration", "status"] as const) {
      for (const direction of ["asc", "desc"] as const) await collect(fixture.library, ACCOUNT_A, { sort, direction, limit: 41 });
    }
  });

  await t.test("dashboard aggregates the whole eligible library and bounds its display rows", async () => {
    const dashboard = await fixture.dashboard.read(ACCOUNT_A);
    assert.deepEqual({ owned: dashboard.aggregates.ownedGames, family: dashboard.aggregates.familyGames, completed: dashboard.aggregates.completedGames }, { owned: 1005, family: 99, completed: 1 });
    assert.equal(dashboard.aggregates.totalMinutes, Array.from({length:1005},(_,index)=>index+1).slice(2).reduce((sum,id)=>sum+id*2,0));
    assert.equal(dashboard.aggregates.knownPlaytimeGames,1004);
    assert.equal(dashboard.mostPlayed.length, 5);
    assert.ok(dashboard.recentCompletions.length <= 8);
    assert.ok(dashboard.completionSuggestions.length <= 50);
    assert.deepEqual(dashboard.trend.dailyGains.map((gain) => gain.minutes), [60,60,60,60]);
    assert.equal(dashboard.aggregates.libraryValueCents, null);
    const empty = await fixture.dashboard.read(EMPTY_ACCOUNT);
    assert.equal(empty.aggregates.ownedGames, 0);
    assert.deepEqual(empty.mostPlayed, []);
  });

  await t.test("Dashboard exclusion options match complete-pool filtering across normalized and weighted tags", async () => {
    psql(fixture,`update catalog.game_metadata set genres='["Action_RPG"]',categories='["Co-op"]',
      weighted_tags='[{"tag":"Roguelike","weight":55},{"tag":"Strategy","weight":100},{"tag":"Horror","weight":54},{"tag":"Sports","weight":0}]'
      where game_id=5;`);
    const dashboard=await fixture.dashboard.read(ACCOUNT_A);
    const baseline=await fixture.library.list(ACCOUNT_A,{section:'all',limit:1});
    for(const category of EXCLUSION_CATEGORIES) {
      const filtered=await fixture.library.list(ACCOUNT_A,{section:'all',limit:1,globalFilters:{...DEFAULT_GLOBAL_FILTERS,excluded:[category.id]}});
      assert.equal(dashboard.availableExclusions.includes(category.id),filtered.total<baseline.total,category.id);
    }
    // Restore the shared fixture before the following read cases.
    psql(fixture,`update catalog.game_metadata set genres='[{"label":"Strategy"}]',categories='[]',weighted_tags='[{"tag":"Strategy","weight":9},{"tag":"Tactical","weight":4}]' where game_id=5;`);
  });

  await t.test("Dashboard filters cover the complete pool and return only bounded tenant cards", async () => {
    const dashboard=await fixture.dashboard.read(ACCOUNT_A,{...DEFAULT_GLOBAL_FILTERS,access:'family'});
    assert.equal(dashboard.aggregates.familyGames,99);
    assert.equal(dashboard.aggregates.ownedGames,0);
    assert.equal(dashboard.aggregates.totalMinutes,0);
    assert.equal(dashboard.aggregates.libraryValueCents,null);
    assert.deepEqual(dashboard.cards,[]);
    const all=await fixture.dashboard.read(ACCOUNT_A);
    assert.ok(all.cards.length<=17);
    assert.ok(all.cards.every(card=>card.access==='owned'&&card.product&&!('notes' in card)&&!('description' in card)));
    assert.ok(all.cards.every(card=>card.gameId<=1005));
    assert.ok(all.availableExclusions.length<=EXCLUSION_CATEGORIES.length);
    const selected=await fixture.dashboard.read(ACCOUNT_A,{...DEFAULT_GLOBAL_FILTERS,excluded:['puzzle']});
    const page=await fixture.library.list(ACCOUNT_A,{section:'all',globalFilters:{...DEFAULT_GLOBAL_FILTERS,excluded:['puzzle']}});
    assert.equal(selected.aggregates.ownedGames+selected.aggregates.familyGames,page.total);
    assert.deepEqual(selected.availableExclusions,all.availableExclusions);
  });

  await t.test("Dashboard store values include the whole owned library and exclude unknown and family prices", async () => {
    psql(fixture,`insert into catalog.offers(game_id,provider,is_free,first_observed_at,last_observed_at)
      select id,'legacy_catalog_games',id=7,now(),now() from catalog.games where id in (2,5,7,10,100,1006);
      insert into catalog.offer_prices(offer_id,observed_at,currency,price_initial_cents,price_final_cents,is_free,retention_until)
      select id,now(),'USD',case game_id when 2 then 1500 when 5 then null when 7 then 0 when 10 then 4000 when 100 then 1000 else 9999999 end,
        case game_id when 2 then 750 when 5 then 2000 when 7 then 0 when 10 then 2000 when 100 then 500 else 9999999 end,
        game_id=7,now()+interval '30 days' from catalog.offers;
    `);
    const dashboard=await fixture.dashboard.read(ACCOUNT_A);
    assert.equal(dashboard.currency,'USD');assert.equal(dashboard.aggregates.pricedGames,4);
    assert.equal(dashboard.aggregates.libraryValueCents,8500);
    assert.equal(dashboard.aggregates.completedValueCents,4000);
    assert.equal(dashboard.aggregates.unplayedValueCents,1500);
    assert.deepEqual(dashboard.bestValueGames.map(item=>item.game.gameId),[100]);
    assert.equal(dashboard.bestValueGames[0].cents,1000);
    assert.equal(dashboard.bestValueGames[0].centsPerHour,300);
    assert.equal((await fixture.dashboard.read(ACCOUNT_B)).aggregates.libraryValueCents,null);
    psql(fixture,"delete from catalog.offers where provider='legacy_catalog_games'");
  });

  await t.test("collections keep metadata separate and traverse 1,000+ custom members in position order", async () => {
    // The product displays the 750-minute HLTB average rounded to 13 hours.
    const expectedQuick = Array.from({ length: 240 }, (_, index) => index + 150)
      .filter((id) => id % 13 !== 0 && id % 17 !== 0);
    assert.equal(expectedQuick.length, 209);
    const summaries = await fixture.collections.list(ACCOUNT_A);
    assert.deepEqual(new Map(summaries.map((entry) => [entry.name, entry.count])), new Map([["Untouched", 1], ["Everything", 1001], ["Quick wins", expectedQuick.length], ["Endless", 64]]));
    const items: number[]=[];let cursor:string|undefined;do{const page=await fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:73,...(cursor?{cursor}:{})});assert.ok(page);items.push(...page.items.map(item=>item.gameId));cursor=page.nextCursor??undefined;}while(cursor);
    assert.equal(items.length,1001);assert.equal(new Set(items).size,1001);assert.deepEqual(items.slice(0,3),[1,2,3]);
    const notePage=await fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:5});assert.equal(notePage?.items.at(-1)?.note,"membership note");
    assert.equal(await fixture.collections.members(ACCOUNT_A,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"),null);
    assert.equal(await fixture.collections.members(ACCOUNT_B,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),null);
    const smart=await fixture.collections.members(ACCOUNT_A,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");assert.equal(smart?.total,1);assert.deepEqual(smart?.items.map(item=>item.gameId),[2]);
    const quick=await fixture.collections.members(ACCOUNT_A,"dddddddd-dddd-4ddd-8ddd-dddddddddddd",{limit:100});
    assert.equal(quick?.total, expectedQuick.length);
    const quickAll:number[]=[];let quickCursor:string|undefined;do{const page=await fixture.collections.members(ACCOUNT_A,"dddddddd-dddd-4ddd-8ddd-dddddddddddd",{limit:67,...(quickCursor?{cursor:quickCursor}:{})});assert.ok(page);quickAll.push(...page.items.map(item=>item.gameId));quickCursor=page.nextCursor??undefined;}while(quickCursor);assert.deepEqual([...quickAll].sort((a,b)=>a-b),expectedQuick);
    const endless=await fixture.collections.members(ACCOUNT_A,"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",{limit:100});assert.deepEqual([...endless!.items.map(item=>item.gameId)].sort((a,b)=>a-b),Array.from({length:64},(_,index)=>(index+1)*17));
    const cursorPage=await fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:2});assert.ok(cursorPage?.nextCursor);psql(fixture,"update app.collections set revision=revision+1 where id=1");await assert.rejects(()=>fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:2,cursor:cursorPage!.nextCursor!}),PageCursorRestartRequiredError);
    psql(fixture,"insert into app.collections(id,public_id,account_id,collection_kind,name,rules) overriding system value values(6,'ffffffff-ffff-4fff-8fff-ffffffffffff',1,'smart','Unknown',jsonb_build_object('version',99,'preset','untouched'))");
    await assert.rejects(()=>fixture.collections.members(ACCOUNT_A,"ffffffff-ffff-4fff-8fff-ffffffffffff"),UnsupportedCollectionRuleError);
    psql(fixture,"delete from app.collections where id=6");
  });

  await t.test("Collection pages hydrate only bounded owner cards and apply whole filters",async()=>{
    const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const page=await fixture.collections.members(ACCOUNT_A,id,{limit:60});
    assert.equal(page?.items.length,60);assert.ok(page?.items.every(item=>item.card?.product&&!('notes' in item.card)&&!('description' in item.card)));
    const filtered=await fixture.collections.members(ACCOUNT_A,id,{limit:60,globalFilters:{...DEFAULT_GLOBAL_FILTERS,excluded:['puzzle']}});
    assert.ok(filtered!.total<page!.total);
    const metadata=await fixture.collections.list(ACCOUNT_A,{...DEFAULT_GLOBAL_FILTERS,excluded:['puzzle']});
    assert.equal(metadata.find(c=>c.publicId===id)?.count,filtered?.total);
    assert.ok(metadata.every(c=>c.preview.length<=4));
    await assert.rejects(()=>fixture.collections.members(ACCOUNT_A,id,{cursor:page!.nextCursor!,globalFilters:{...DEFAULT_GLOBAL_FILTERS,access:'family'}}),PageCursorRestartRequiredError);
    const original=page!.catalogRevision;
    psql(fixture,"update catalog.game_metadata set updated_at=now() where game_id=5");
    assert.notEqual((await fixture.collections.members(ACCOUNT_A,id))!.catalogRevision,original);
    await assert.rejects(()=>fixture.collections.members(ACCOUNT_A,id,{cursor:page!.nextCursor!}),PageCursorRestartRequiredError);
    const candidates=await fixture.library.list(ACCOUNT_A,{section:'all',excludeCollection:id,limit:100});
    assert.ok(candidates.items.every(item=>item.gameId>1001));assert.equal(candidates.total,103);
    await assert.rejects(()=>fixture.library.list(ACCOUNT_B,{excludeCollection:id}),InvalidPageQueryError);
    const detail=await fixture.library.detail(ACCOUNT_A,5);
    assert.ok(detail?.product?.collectionIds?.includes(id));
    psql(fixture,"insert into app.collections(account_id,collection_kind,name,rules) values(1,'smart','Retired priority',jsonb_build_object('preset','must-play'))");
    assert.equal((await fixture.collections.list(ACCOUNT_A)).find(c=>c.name==='Retired priority')?.count,0);
    psql(fixture,"delete from app.collections where name='Retired priority'");
  });

  await t.test("Atomic collection picker batches preserve duplicates and reject partial/cross-owner writes",async()=>{
    const m=new CollectionMutationsRepository(fixture.database),id=await m.create(ACCOUNT_A,{name:'Picker fixture'});
    await m.addGame(ACCOUNT_A,id,5,'Preserve me');
    await Promise.all([m.addGames(ACCOUNT_A,id,[5,6,7,7]),m.addGames(ACCOUNT_A,id,[8,9,10])]);
    let page=await fixture.collections.members(ACCOUNT_A,id,{limit:100});
    assert.equal(page?.total,6);assert.equal(new Set(page!.items.map(item=>item.position)).size,6);
    assert.equal(page!.items.find(item=>item.gameId===5)?.note,'Preserve me');
    await assert.rejects(()=>m.addGames(ACCOUNT_A,id,[11,1150]),CollectionNotFoundError);
    assert.equal((await fixture.collections.members(ACCOUNT_A,id))?.total,6);
    await assert.rejects(()=>m.addGames(ACCOUNT_B,id,[1150]),CollectionNotFoundError);
    await m.remove(ACCOUNT_A,id);
  });

  await t.test("detail retains authored state and reads label and weighted-tag arrays", async () => {
    const detail = await fixture.library.detail(ACCOUNT_A, 5);
    assert.ok(detail);
    assert.equal(detail.notes, "A retained private note");
    assert.equal(detail.manualProgress, 12.5);
    assert.equal(detail.lastPlayedAt, "2026-08-09T10:11:12.000Z");
    assert.equal(detail.description, "Retained synthetic description 5");
    assert.equal(detail.imageUrl, "https://example.invalid/5.jpg");
    assert.deepEqual(detail.genres, [
      { tag: "Strategy", weight: 9 },
      { tag: "Tactical", weight: 4 },
    ]);
  });

  await t.test("vault_app runtime reads remain inside the established principal's RLS tenant", async () => {
    assert.equal(await fixture.library.detail(ACCOUNT_A, 1150), null);
    assert.equal(await fixture.library.detail(ACCOUNT_A, 1205), null);
    assert.equal(await fixture.library.detail(ACCOUNT_A, 1105), null);
    const ownB = await fixture.library.detail(ACCOUNT_B, 1150);
    assert.equal(ownB?.notes, "B private note");
    assert.equal(ownB?.manualProgress, 44.25);

    const crossTenant = await fixture.database.withPrincipal(ACCOUNT_A, (tx) =>
      tx<{ id: number }[]>`select id from app.accounts where id = ${ACCOUNT_B.accountId}`
    );
    assert.equal(crossTenant.length, 0);
    const changedOther = await fixture.database.withPrincipal(ACCOUNT_A, tx =>
      tx`update app.game_state set blacklisted=true where account_id=${ACCOUNT_B.accountId} returning game_id`);
    const deletedOther = await fixture.database.withPrincipal(ACCOUNT_A, tx =>
      tx`delete from app.game_state where account_id=${ACCOUNT_B.accountId} returning game_id`);
    assert.equal(changedOther.length,0);
    assert.equal(deletedOther.length,0);
    assert.equal((await fixture.library.detail(ACCOUNT_B,1150))?.notes,"B private note");
    const noContext = await fixture.database.sql<{ id: number }[]>`select id from app.accounts order by id`;
    assert.equal(noContext.length, 0);
    assert.equal((await collect(fixture.library, EMPTY_ACCOUNT)).total, 0);
  });

  await t.test("query inputs remain bounded allowlists and parameter values cannot change SQL shape", async () => {
    await assert.rejects(
      () => fixture.library.list(ACCOUNT_A, { progress: "started" as LibraryQuery["progress"] }),
      InvalidPageQueryError,
    );
    await assert.rejects(
      () => fixture.library.list(ACCOUNT_A, { genres: Array.from({ length: 19 }, (_, index) => `g${index}`) }),
      InvalidPageQueryError,
    );
    assert.equal((await fixture.library.list(ACCOUNT_A, { search: "%' OR true --" })).total, 0);
    assert.equal((await fixture.library.list(ACCOUNT_A, { genres: ["x') OR true --"] })).total, 0);
    assert.equal(psql(fixture, "select count(*) from app.accounts", true), "3");
  });

  await t.test("current auth resumes manual workspaces concurrently without claiming verified identities", async () => {
    psql(fixture, "select setval('app.accounts_id_seq',3,true)");
    const auth = new AuthRepository(fixture.database);
    const secret = "local-auth-fixture-secret";
    const steamId = "76561198000000123";
    const input = { steamId, profileUrl: `https://steamcommunity.com/profiles/${steamId}/`, displayName: "My Vault", steamDisplayName: "Steam Name", avatarUrl: null };
    const manual = await Promise.all(Array.from({ length: 6 }, () => auth.startManual(input, secret)));
    assert.equal(new Set(manual.map(row => row.user.id)).size, 1);
    assert.equal(manual.filter(row => !row.resumed).length, 1);
    assert.ok(manual.every(row => row.token.startsWith("manual.") && row.user.account_type === "manual" && row.user.steam_id === steamId));
    const resumed = await auth.startManual({ ...input, displayName: "Different device" }, secret);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.user.display_name, "My Vault");
    const verified = await auth.startVerified(steamId, secret, { steam_id: steamId, display_name: "Verified Steam", avatar_url: null });
    assert.notEqual(verified.user.id, resumed.user.id);
    assert.equal(verified.user.account_type, "steam");
    assert.ok(!verified.token.startsWith("manual."));
    assert.equal((await auth.lookupManual(steamId))?.displayName, "My Vault");
    const sessions = new SessionRepository(fixture.database);
    const manualSession = await sessions.resolveCookie(resumed.token, secret);
    const steamSession = await sessions.resolveCookie(verified.token, secret);
    assert.ok(manualSession && steamSession);
    assert.equal(manualSession.principal.identityVerified, false);
    assert.equal(steamSession.principal.identityVerified, true);
    await auth.revoke(manualSession.principal, verified.token, secret);
    assert.ok(await sessions.resolveCookie(verified.token, secret), "a manual session cannot revoke a verified session");
    await auth.updateProfile(manualSession.principal, { steam_id: steamId, display_name: "Updated Steam", avatar_url: null });
    const updated = await auth.readUser(manualSession.principal);
    assert.equal(updated.user.display_name, "My Vault");
    assert.equal(updated.user.steam_display_name, "Updated Steam");
    await auth.revoke(manualSession.principal, resumed.token, secret);
    assert.equal(await sessions.resolveCookie(resumed.token, secret), null);
    assert.equal(psql(fixture, "select has_function_privilege('vault_worker','app.start_session(bigint,text,bytea,timestamptz,text,text,text,text)','EXECUTE')", true), "f");
    await assert.rejects(() => auth.startVerified("1", secret), DatabaseUnavailableError);
    psql(fixture, "delete from app.accounts where id>3");
  });

  await t.test("authored edits invalidate cursors and roll back their revision effects", async () => {
    const page = await fixture.library.list(ACCOUNT_A, { limit: 5 });
    assert.ok(page.nextCursor);
    const original = await fixture.bootstrap.read(ACCOUNT_A);
    await fixture.database.withPrincipal(ACCOUNT_A, tx => tx`update app.game_state set notes='Changed note' where account_id=1 and game_id=5`);
    assert.notEqual((await fixture.bootstrap.read(ACCOUNT_A)).stateRevision, original.stateRevision);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 5, cursor: page.nextCursor! }), PageCursorRestartRequiredError);
    const beforeFailure = await fixture.bootstrap.read(ACCOUNT_A);
    await assert.rejects(() => fixture.database.withPrincipal(ACCOUNT_A, async tx => {
      await tx`update app.game_state set notes='Rolled back note' where account_id=1 and game_id=5`;
      throw Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal((await fixture.bootstrap.read(ACCOUNT_A)).stateRevision, beforeFailure.stateRevision);
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.notes, 'Changed note');
    const collectionBefore = (await fixture.collections.members(ACCOUNT_A,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',{limit:1}))!.collection;
    await fixture.database.withPrincipal(ACCOUNT_A, tx => tx`update app.collection_games set note='Changed membership' where account_id=1 and collection_id=1 and game_id=5`);
    const collectionAfter = (await fixture.collections.members(ACCOUNT_A,collectionBefore.publicId,{limit:1}))!.collection;
    assert.notEqual(collectionAfter.revision, collectionBefore.revision);
  });

  await t.test("permanent Blacklist preserves authored facts, clears commitments and only reactivates manually", async () => {
    const mutations = new MutationsRepository(fixture.database);
    await mutations.unpin(ACCOUNT_A,1);
    await mutations.pin(ACCOUNT_A,5);
    const page = await fixture.library.list(ACCOUNT_A,{limit:5});
    await mutations.decide(ACCOUNT_A,5,"blacklist");
    const blacklisted = await fixture.library.detail(ACCOUNT_A,5);
    assert.equal(blacklisted?.blacklisted,true);
    assert.equal(blacklisted?.notes,"Changed note");
    assert.equal(blacklisted?.manualProgress,12.5);
    assert.ok(!(await fixture.bootstrap.read(ACCOUNT_A)).pins.some(pin=>pin.gameId===5));
    assert.equal((await fixture.bootstrap.read(ACCOUNT_A)).currentPick,null);
    await assert.rejects(()=>fixture.library.list(ACCOUNT_A,{limit:5,cursor:page.nextCursor!}),PageCursorRestartRequiredError);
    // An unrelated refresh and repeat decision do not restore the game or create history.
    await mutations.decide(ACCOUNT_A,5,"blacklist");
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.blacklisted,true);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=5",true),"0");
    assert.equal(psql(fixture,"select count(*) from information_schema.columns where table_schema='app' and table_name='game_state' and column_name in ('slept_at','sleep_expires_at','blacklisted_at')",true),"0");
    await mutations.decide(ACCOUNT_A,5,"reactivate");
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.blacklisted,false);
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.notes,"Changed note");
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.manualProgress,12.5);
    await mutations.notes(ACCOUNT_A,5,"  Updated authored note  ");
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.notes,"Updated authored note");
    await mutations.notes(ACCOUNT_A,5,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.manualProgress,12.5);
    await assert.rejects(()=>mutations.decide(ACCOUNT_A,1150,"blacklist"),GameNotFoundError);
    await assert.rejects(()=>mutations.notes(ACCOUNT_A,1150,"Not mine"),GameNotFoundError);
    assert.equal((await fixture.library.detail(ACCOUNT_B,1150))?.notes,"B private note");
  });

  await t.test("completion replay and concurrent pins preserve event and slot invariants", async () => {
    const mutations = new MutationsRepository(fixture.database);
    const key = "feedfeed-feed-4eed-8eed-feedfeedfeed";
    const results = await Promise.all(Array.from({length:6},()=>mutations.decide(ACCOUNT_A,8,"complete",key)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=8",true),"1");
    assert.equal(psql(fixture,"select origin_surface='library' and legacy_estimate_minutes=780 and abs(legacy_hours_played-16::numeric/60)<0.000000000001 and legacy_price_cents is null from app.completion_events where account_id=1 and game_id=8",true),'t');
    await mutations.decide(ACCOUNT_A,8,"reactivate");
    assert.equal(await mutations.decide(ACCOUNT_A,8,"complete",key),false);
    assert.equal((await fixture.library.detail(ACCOUNT_A,8))?.completed,false);
    await assert.rejects(()=>mutations.decide(ACCOUNT_A,9,"complete",key),StaleMutationError);
    for(const id of [2,3,5]) await mutations.unpin(ACCOUNT_A,id);
    const pins = await Promise.allSettled([4,6,7,9,12,13].map(id=>mutations.pin(ACCOUNT_A,id)));
    assert.equal(pins.filter(result=>result.status==='fulfilled').length,3);
    const libraryPins = (await fixture.bootstrap.read(ACCOUNT_A)).pins;
    assert.equal(libraryPins.length,3);
    assert.equal(new Set(libraryPins.map(pin=>pin.slot)).size,3);
    await mutations.pin(ACCOUNT_A,1006,libraryPins[0].gameId);
    assert.equal(psql(fixture,"select personal_minutes_baseline is null from app.pins where account_id=1 and scope='library' and game_id=1006",true),"t");
    assert.equal(psql(fixture,"select count(*) from app.pins where account_id=1 and scope='family'",true),"3");
  });

  await t.test("Undo restores microsecond completion instants and existing claims, with stale-write refusal", async () => {
    const mutations=new MutationsRepository(fixture.database);
    psql(fixture,`insert into app.game_state(account_id,game_id,completed_at,manual_progress,notes,revision)
      values(1,30,'2026-09-01T10:00:00.123456Z',26.75,'Original note',1);
      insert into app.completion_events(account_id,game_id,occurred_at,source)
      values(1,30,'2026-09-01T10:00:02.123456Z','user');`);
    const previous=(await fixture.library.detail(ACCOUNT_A,30))!;
    assert.equal(previous.product?.completedAt,'2026-09-01T10:00:00.123456Z');
    const receipt=await mutations.decideWithVersion(ACCOUNT_A,30,'reactivate');
    await mutations.restoreDecision(ACCOUNT_A,30,{status:'Completed',completedAt:previous.product!.completedAt,expectedVersion:receipt.mutationVersion});
    const restored=(await fixture.library.detail(ACCOUNT_A,30))!;
    assert.equal(restored.product?.completedAt,previous.product?.completedAt);
    assert.equal(restored.manualProgress,26.75);assert.equal(restored.notes,'Original note');
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=30 and undone_at is null",true),'1');
    const before=await mutations.decideWithVersion(ACCOUNT_A,30,'reactivate');
    await mutations.notes(ACCOUNT_A,30,'Changed on another device');
    await assert.rejects(()=>mutations.restoreDecision(ACCOUNT_A,30,{status:'Completed',completedAt:previous.product!.completedAt,expectedVersion:before.mutationVersion}),StaleMutationError);
    assert.equal((await fixture.library.detail(ACCOUNT_A,30))?.completed,false);
    assert.equal((await fixture.library.detail(ACCOUNT_A,30))?.notes,'Changed on another device');
    await assert.rejects(()=>mutations.restoreDecision(ACCOUNT_B,30,{status:'Completed',completedAt:previous.product!.completedAt,expectedVersion:before.mutationVersion}),GameNotFoundError);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=30",true),'1');
    psql(fixture,"insert into app.game_state(account_id,game_id,completed_at) values(1,34,'2026-09-01T10:00:00.987654Z')");
    const withoutHistory=await mutations.decideWithVersion(ACCOUNT_A,34,'reactivate');
    await mutations.restoreDecision(ACCOUNT_A,34,{status:'Completed',completedAt:'2026-09-01T10:00:00.987654Z',expectedVersion:withoutHistory.mutationVersion});
    assert.equal((await fixture.library.detail(ACCOUNT_A,34))?.product?.completedAt,'2026-09-01T10:00:00.987654Z');
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=34",true),'0');
  });

  await t.test("Undo Complete preserves prior Blacklist and authored progress without new history", async () => {
    const mutations=new MutationsRepository(fixture.database);
    const before=(await fixture.library.detail(ACCOUNT_A,11))!;
    const receipt=await mutations.decideWithVersion(ACCOUNT_A,11,'complete','11111111-2222-4333-8444-555555555555');
    const results=await Promise.allSettled(Array.from({length:4},()=>mutations.restoreDecision(ACCOUNT_A,11,
      {status:'Blacklisted',completedAt:null,expectedVersion:receipt.mutationVersion})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason instanceof StaleMutationError));
    const after=(await fixture.library.detail(ACCOUNT_A,11))!;
    assert.equal(after.blacklisted,true);assert.equal(after.completed,false);assert.equal(after.notes,before.notes);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=11",true),'1');
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=11 and undone_at is null",true),'0');
    await mutations.progress(ACCOUNT_A,31,45.5);
    const active=await mutations.decideWithVersion(ACCOUNT_A,31,'complete');
    await mutations.restoreDecision(ACCOUNT_A,31,{status:'In Progress',completedAt:null,expectedVersion:active.mutationVersion});
    assert.equal((await fixture.library.detail(ACCOUNT_A,31))?.manualProgress,45.5);
    assert.equal((await fixture.library.detail(ACCOUNT_A,31))?.completed,false);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id=31",true),'1');
  });

  await t.test("Dismissal records real personal minutes and preserves unknown/family facts", async () => {
    const mutations=new MutationsRepository(fixture.database);
    await mutations.notes(ACCOUNT_A,32,'Retain this note');
    await mutations.dismissCompletion(ACCOUNT_A,32,true);
    const card=(await fixture.library.detail(ACCOUNT_A,32))!;
    assert.equal(card.product?.completionDismissedMinutes,64);
    assert.equal(libraryGame(card).completionSuggestionDismissedPlaytime,64/60);
    await mutations.dismissCompletion(ACCOUNT_A,32,false);
    assert.equal((await fixture.library.detail(ACCOUNT_A,32))?.product?.completionDismissedAt,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,32))?.notes,'Retain this note');
    await assert.rejects(()=>mutations.dismissCompletion(ACCOUNT_A,1,true),InvalidPageQueryError);
    await assert.rejects(()=>mutations.dismissCompletion(ACCOUNT_A,1006,true),InvalidPageQueryError);
    await assert.rejects(()=>mutations.dismissCompletion(ACCOUNT_A,1150,true),GameNotFoundError);
    await assert.rejects(()=>mutations.progress(ACCOUNT_A,1150,20),GameNotFoundError);
    await assert.rejects(()=>mutations.progress(ACCOUNT_A,32,101),InvalidPageQueryError);
    await mutations.progress(ACCOUNT_A,32,12.5);await mutations.progress(ACCOUNT_A,32,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,32))?.manualProgress,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,32))?.notes,'Retain this note');
    assert.equal((await fixture.library.detail(ACCOUNT_A,1))?.playtimeMinutes,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1006))?.playtimeMinutes,null);
    await mutations.progress(ACCOUNT_A,33,50);await mutations.progress(ACCOUNT_A,33,null);
    assert.equal(psql(fixture,"select count(*) from app.game_state where account_id=1 and game_id=33",true),'0');
  });

  await t.test("Completion review covers all owned candidates with current HLTB rules and bounded pages",async()=>{
    psql(fixture,`insert into app.game_state(account_id,game_id,blacklisted,completion_dismissed_at,completion_dismissed_playtime) values
      (1,400,true,null,null),(1,401,false,now(),700),(1,402,false,now(),624),(1,403,false,now(),627),
      (1,499,false,now(),800),(1,500,false,now(),800);`);
    const all=await collect(fixture.library,ACCOUNT_A,{section:"all"});
    const expected=findCompletionCandidates(all.items.map(libraryGame));
    const seen:LibraryCard[]=[];
    let cursor:string|undefined;
    do {
      const page=await fixture.library.completionReview(ACCOUNT_A,{limit:37,cursor});
      assert.equal(page.total,expected.length);assert.ok(page.items.length<=37);
      assert.equal(page.completionValueCents,expected.reduce((sum,{game})=>sum+(game.isFree?0:Number(game.priceInitial??0)),0));
      seen.push(...page.items);cursor=page.nextCursor??undefined;
    }while(cursor);
    assert.ok(seen.length>60);
    assert.deepEqual([...seen.map(game=>String(game.gameId))].sort(),expected.map(({game})=>game.id).sort());
    const actual=findCompletionCandidates(seen.map(libraryGame));
    assert.deepEqual(actual.map(({game})=>game.id),seen.map(game=>String(game.gameId)));
    assert.ok(seen.some(game=>game.gameId===400&&game.blacklisted));
    assert.ok(seen.some(game=>game.gameId===402));assert.ok(seen.some(game=>game.gameId===500));
    assert.ok(seen.every(game=>![401,403,499].includes(game.gameId)));
    assert.ok(seen.every(game=>game.access==='owned'&&game.playtimeMinutes!==null&&!game.completed));
    const first=await fixture.library.completionReview(ACCOUNT_A,{limit:2});
    assert.ok(first.nextCursor);
    await assert.rejects(()=>fixture.library.list(ACCOUNT_A,{cursor:first.nextCursor!,sort:'title',direction:'desc',access:'owned',section:'all'}),PageCursorRestartRequiredError);
    await new MutationsRepository(fixture.database).dismissCompletion(ACCOUNT_A,first.items[0].gameId,true);
    await assert.rejects(()=>fixture.library.completionReview(ACCOUNT_A,{limit:2,cursor:first.nextCursor!}),PageCursorRestartRequiredError);
    assert.equal((await fixture.library.completionReview(ACCOUNT_B)).total,0);
  });

  await t.test("Completion review bulk saves are atomic, replay-safe and keep trusted existing ledger measurements",async()=>{
    const mutations=new MutationsRepository(fixture.database);
    const key='55555555-2222-4333-8444-555555555555';
    await assert.rejects(()=>mutations.completionBatch(ACCOUNT_A,[35,1150],'claimed',key),GameNotFoundError);
    assert.equal((await fixture.library.detail(ACCOUNT_A,35))?.completed,false);
    await assert.rejects(()=>mutations.completionBatch(ACCOUNT_A,[35,1],'dismissed',key),GameNotFoundError);
    assert.equal((await fixture.library.detail(ACCOUNT_A,35))?.product?.completionDismissedAt,null);
    const result=await mutations.completionBatch(ACCOUNT_A,[35,36,35],'claimed',key);
    assert.equal(result.updated,2);
    const replay=await Promise.all(Array.from({length:3},()=>mutations.completionBatch(ACCOUNT_A,[35,36],'claimed',key)));
    assert.ok(replay.every(value=>value.updated===0));
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id in(35,36)",true),'2');
    assert.equal(psql(fixture,"select origin_surface||':'||legacy_hours_played::text from app.completion_events where account_id=1 and game_id=36",true),'sweep_bulk:1.200000000000');
    await mutations.completionBatch(ACCOUNT_A,[37,38],'dismissed',key);
    assert.equal((await fixture.library.detail(ACCOUNT_A,37))?.product?.completionDismissedMinutes,74);
    assert.equal(psql(fixture,"select count(*) from app.completion_events where account_id=1 and game_id in(37,38)",true),'0');
    await assert.rejects(()=>mutations.completionBatch(ACCOUNT_A,Array.from({length:501},()=>35),'claimed',key),InvalidPageQueryError);
    const large=Array.from({length:500},(_,index)=>index+40);
    const largeKey='66666666-2222-4333-8444-555555555555';
    const uncompleted=Number(psql(fixture,"select count(*) from app.library_games lg left join app.game_state gs using(account_id,game_id) where lg.account_id=1 and lg.game_id between 40 and 539 and gs.completed_at is null",true));
    assert.equal((await mutations.completionBatch(ACCOUNT_A,large,'claimed',largeKey)).updated,uncompleted);
    assert.equal((await mutations.completionBatch(ACCOUNT_A,large,'claimed',largeKey)).updated,0);
    assert.equal(psql(fixture,"select count(*) from app.game_state where account_id=1 and game_id between 40 and 539 and completed_at is not null",true),'500');
  });

  await t.test("request limits preserve imported counters, serialize races, and refund atomically", async () => {
    const digest = Buffer.alloc(32,71);
    psql(fixture,"insert into ops.abuse_cooldowns(bucket,key_digest,window_started_at,request_count,source_updated_at,observed_at,algorithm_version,status) values ('test_limit',decode(repeat('47',32),'hex'),clock_timestamp(),2,clock_timestamp(),clock_timestamp(),'legacy-unknown','active')");
    type Counter = { allowed:boolean; remaining:number; retry_after_seconds:number };
    const consume = ()=>fixture.database.withPrincipal(ACCOUNT_A,tx=>tx<Counter[]>`select * from app.consume_request_limit('test_limit',${digest},3,60)`);
    const results = await Promise.all(Array.from({length:6},consume));
    assert.equal(results.filter(rows=>rows[0].allowed).length,1);
    assert.ok(results.filter(rows=>!rows[0].allowed).every(rows=>rows[0].retry_after_seconds>0));
    assert.equal(psql(fixture,"select request_count from ops.abuse_cooldowns where bucket='test_limit'",true),"4");
    await fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`select app.refund_request_limit('test_limit',${digest})`);
    assert.equal(psql(fixture,"select request_count from ops.abuse_cooldowns where bucket='test_limit'",true),"3");
    psql(fixture,"update ops.abuse_cooldowns set window_started_at=clock_timestamp()-interval '2 minutes' where bucket='test_limit'");
    assert.deepEqual((await consume())[0],{allowed:true,remaining:2,retry_after_seconds:0});
    await fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`select app.refund_request_limit('test_limit',${digest})`);
    assert.equal(psql(fixture,"select count(*) from ops.abuse_cooldowns where bucket='test_limit'",true),"0");
    assert.equal(psql(fixture,"select has_function_privilege('vault_worker','app.consume_request_limit(text,bytea,integer,integer)','EXECUTE')",true),"f");
  });

  await t.test("regional Steam cache leases serialize refreshes and reject superseded writers", async () => {
    const store = new StoreRepository(fixture.database);
    const tokens=Array.from({length:6},(_,i)=>`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`);
    const claims=await Promise.all(tokens.map(token=>store.claim(100005,'GB',token)));
    assert.equal(claims.filter(entry=>entry.claimed).length,1);
    const owner=tokens[claims.findIndex(entry=>entry.claimed)],other=tokens.find(token=>token!==owner)!;
    const now=new Date().toISOString(),expiry=new Date(Date.now()+60_000).toISOString();
    const game={appId:100005,title:'Steam cache fixture',image:'https://example.invalid/game.jpg',genres:['Strategy']};
    await store.finish(100005,'GB',other,game,now,expiry);
    assert.equal((await store.read(100005,'GB')).game,null);
    await store.finish(100005,'GB',owner,game,now,expiry);
    assert.equal((await store.read(100005,'GB')).game?.title,game.title);
    assert.equal((await store.claim(100005,'GB',other)).claimed,false);
    assert.equal((await store.claim(100005,'US',other)).claimed,true);
    psql(fixture,"update catalog.wishlist_store_cache set expires_at='epoch',lease_until='epoch' where steam_app_id=100005 and country='GB'");
    assert.equal((await store.claim(100005,'GB',other)).claimed,true);
    await store.fail(100005,'GB',owner,new Date(Date.now()+120_000).toISOString());
    assert.ok(Date.parse((await store.read(100005,'GB')).lease_until)>Date.now());
    await store.fail(100005,'GB',other,new Date(Date.now()+120_000).toISOString());
    assert.equal((await store.claim(100005,'GB',owner)).claimed,false);
    const catalogue=await store.catalogue([100005]);
    assert.deepEqual(catalogue[0].genres,['Strategy']);
    assert.deepEqual(catalogue[0].tags,{Strategy:9,Tactical:4});
    assert.equal(catalogue[0].main_story_minutes,600);
    assert.equal(psql(fixture,"select has_table_privilege('vault_worker','catalog.wishlist_store_cache','SELECT')",true),"f");
  });

  await t.test("collection writes preserve notes and order, isolate tenants, and change kind atomically", async () => {
    psql(fixture,"select setval('app.collections_id_seq',6,true)");
    const mutations=new CollectionMutationsRepository(fixture.database);
    const id=await mutations.create(ACCOUNT_A,{name:' My collection ',kind:'custom',description:'A description'});
    await Promise.all([4,5,6,7,8,9].map(gameId=>mutations.addGame(ACCOUNT_A,id,gameId,`Note ${gameId}`)));
    let page=await fixture.collections.members(ACCOUNT_A,id,{limit:100});
    assert.equal(page?.total,6);assert.equal(new Set(page!.items.map(item=>item.position)).size,6);
    assert.ok(page!.items.every(item=>item.note===`Note ${item.gameId}`));
    const initial = page!.items.find(item=>item.gameId===5)!;
    await mutations.addGame(ACCOUNT_A,id,5,'Changed note');
    page=await fixture.collections.members(ACCOUNT_A,id,{limit:100});
    assert.equal(page?.total,6);assert.equal(page!.items.find(item=>item.gameId===5)?.position,initial.position);
    await assert.rejects(()=>mutations.addGame(ACCOUNT_A,id,4,'Collision',initial.position),CollectionConflictError);
    await assert.rejects(()=>mutations.addGame(ACCOUNT_B,id,1150),CollectionNotFoundError);
    await assert.rejects(()=>mutations.addGame(ACCOUNT_A,id,1150),CollectionNotFoundError);
    await assert.rejects(()=>mutations.update(ACCOUNT_B,id,{name:'Not mine'}),CollectionNotFoundError);
    await assert.rejects(()=>mutations.update(ACCOUNT_A,id,{kind:'smart',rules:{version:99,preset:'untouched'}}),UnsupportedCollectionRuleError);
    assert.equal((await fixture.collections.members(ACCOUNT_A,id))?.total,6,'failed kind change retains all memberships');
    await mutations.removeGame(ACCOUNT_A,id,4);
    assert.equal((await fixture.collections.members(ACCOUNT_A,id))?.total,5);
    await mutations.update(ACCOUNT_A,id,{kind:'smart',rules:{preset:'untouched'},name:'Automatic'});
    const smart=await fixture.collections.members(ACCOUNT_A,id);
    assert.equal(smart?.collection.kind,'smart');assert.equal(smart?.collection.name,'Automatic');
    assert.equal(psql(fixture,`select count(*) from app.collection_games cg join app.collections c on c.id=cg.collection_id where c.public_id='${id}'`,true),'0');
    await assert.rejects(()=>mutations.addGame(ACCOUNT_A,id,5),InvalidPageQueryError);
    await mutations.update(ACCOUNT_A,id,{kind:'custom'});
    assert.equal((await fixture.collections.members(ACCOUNT_A,id))?.total,0);
    await mutations.remove(ACCOUNT_A,id);
    assert.equal(await fixture.collections.members(ACCOUNT_A,id),null);
  });

  await t.test("Vault scores the whole tenant pool before 64 previews; uniform draws reach its tail", async () => {
    const vault = new VaultRepository(fixture.database);
    const setup: VaultSetup = {session:null,mood:null,goal:null,collectionId:null,genres:[],globalFilters:DEFAULT_GLOBAL_FILTERS,deferredIds:[]};
    const full = (await collect(fixture.library,ACCOUNT_A,{section:'all',sort:'title',limit:100})).items.map(libraryGame);
    const expected = buildVaultPool({games:full,session:null,mood:null,goal:null,selectedCollectionId:null,selectedGenres:[],snoozedIds:new Set()});
    const preview = await vault.preview(ACCOUNT_A,setup);
    assert.ok(preview.poolTotal>64);assert.equal(preview.poolTotal,expected.length);
    assert.equal(preview.quickTotal,expected.length);
    assert.deepEqual(preview.deck.map(row=>row.game.id),buildVaultDeck(expected).map(row=>row.game.id));
    assert.ok(preview.deck.every(row=>!row.game.notes && !row.game.description));
    const last=expected.at(-1)!.game;
    assert.ok(!preview.deck.some(row=>row.game.id===last.id));
    const request: VaultDrawRequest={...setup,requestKey:'99999999-9999-4999-8999-999999999901',quick:true,arm:'test',previousId:null,cycleIds:[],excludeIds:[]};
    const drawn=await vault.draw(ACCOUNT_A,request,()=>0.99999999);
    assert.equal(drawn?.game.id,last.id);assert.equal(drawn?.arm,'control');assert.equal(drawn?.explanation,null);
    assert.equal(drawn?.draw.eligiblePoolCount,expected.length);
    assert.equal(psql(fixture,'select current_game_id from app.vault_state where account_id=1',true),last.id);
    assert.equal((await vault.draw(ACCOUNT_A,request,()=>0))?.game.id,last.id);
    assert.equal(psql(fixture,`select count(*) from app.vault_draws where public_id='${request.requestKey}'`,true),'1');
    await assert.rejects(()=>vault.draw(ACCOUNT_A,{...request,quick:false,session:'short',mood:'chill',goal:'surprise'}),InvalidPageQueryError);
    const excluded=await vault.draw(ACCOUNT_A,{...request,requestKey:'99999999-9999-4999-8999-999999999902',excludeIds:[last.id]},()=>0.99999999);
    assert.notEqual(excluded?.game.id,last.id);
    const cycle=await vault.draw(ACCOUNT_A,{...request,requestKey:'99999999-9999-4999-8999-999999999903',cycleIds:expected.map(row=>row.game.id)},()=>0);
    assert.equal(cycle?.cycleReset,true);assert.equal(cycle?.draw.rerollIndex,0);
    assert.ok((await vault.preview(ACCOUNT_B,setup)).deck.every(row=>Number(row.game.id)>=1100));
    await assert.rejects(()=>vault.preview(ACCOUNT_A,{...setup,collectionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),InvalidPageQueryError);
    const collectionSetup={...setup,collectionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
    const collection=await vault.preview(ACCOUNT_A,collectionSetup);
    assert.ok(collection.poolTotal>64);
    assert.equal(collection.collectionCounts[collectionSetup.collectionId],collection.poolTotal);
    const collected=await vault.draw(ACCOUNT_A,{...request,...collectionSetup,quick:false,requestKey:'99999999-9999-4999-8999-999999999904'},()=>0.99999999);
    assert.ok(collected);assert.ok(!collection.deck.some(row=>row.game.id===collected.game.id));
    assert.equal(collected.collectionName,'Everything');assert.equal(collected.explanation,null);
    const guidedSetup={...setup,session:'short' as const,mood:'chill' as const,goal:'surprise' as const};
    const guided=await vault.preview(ACCOUNT_A,guidedSetup);
    const clientPool=buildVaultPool({games:full,session:'short',mood:'chill',goal:'surprise',selectedCollectionId:null,selectedGenres:[],snoozedIds:new Set()});
    assert.deepEqual(guided.deck.map(row=>[row.game.id,row.score]),buildVaultDeck(clientPool).map(row=>[row.game.id,row.score]));
    const deferred=guided.deck[0].game.id;
    assert.equal((await vault.preview(ACCOUNT_A,{...guidedSetup,deferredIds:[deferred]})).deck.some(row=>row.game.id===deferred),false);
    const filters={...DEFAULT_GLOBAL_FILTERS,access:'family' as const};
    const family=await vault.preview(ACCOUNT_A,{...setup,globalFilters:filters});
    assert.ok(family.poolTotal>0 && family.deck.every(row=>row.game.accessSource==='family'&&row.game.playtimeKnown===false));
    // Current Something New intentionally allows unknown history without
    // claiming the borrower never played. Finish needs known personal progress.
    assert.equal((await vault.preview(ACCOUNT_A,{...guidedSetup,goal:'finish',globalFilters:filters})).poolTotal,0);
  });

  await t.test("Vault history, reactions, current pick and preserved snoozes isolate tenants", async () => {
    const vault=new VaultRepository(fixture.database),history=await vault.history(ACCOUNT_A);
    assert.ok(history.draws.length>=4 && history.draws.length<=50);
    const draw=history.draws[0],key='99999999-9999-4999-8999-999999999911';
    assert.equal(await vault.event(ACCOUNT_B,draw.id,'liked',key),null);
    const event=await vault.event(ACCOUNT_A,draw.id,'liked',key);assert.ok(event);
    assert.equal((await vault.event(ACCOUNT_A,draw.id,'liked',key))?.event.id,event.event.id);
    assert.equal((await vault.history(ACCOUNT_A)).draws[0].events[0].eventType,'liked');
    assert.equal((await vault.history(ACCOUNT_B)).draws.length,0);
    psql(fixture,`insert into app.vault_draws(public_id,account_id,game_id,steam_app_id,drawn_at,eligible_pool_count,reroll_index)
      values('99999999-9999-4999-8999-999999999912',1,2,100002,'2026-09-30T12:00:00.123456Z',1,0);
      insert into app.vault_draw_events(public_id,account_id,draw_id,event_type,occurred_at)
        select '99999999-9999-4999-8999-999999999913',1,id,'slept','2026-09-30T12:01:00.234567Z'
        from app.vault_draws where public_id='99999999-9999-4999-8999-999999999912';`);
    const retained=(await vault.history(ACCOUNT_A)).draws.find(row=>row.id==='99999999-9999-4999-8999-999999999912')!;
    assert.equal(retained.drawnAt,'2026-09-30T12:00:00.123456Z');
    assert.equal(retained.events[0].createdAt,'2026-09-30T12:01:00.234567Z');
    psql(fixture,"insert into app.snoozes(account_id,game_id) values (1,4),(2,1150)");
    psql(fixture,"insert into app.snoozes(account_id,game_id,snoozed_at,until_at) values(1,2,now()-interval '2 days',now()-interval '1 day')");
    const boot=await fixture.bootstrap.read(ACCOUNT_A);
    assert.deepEqual(boot.snoozedIds,[4]);
    const setup:VaultSetup={session:null,mood:null,goal:null,collectionId:null,genres:[],globalFilters:DEFAULT_GLOBAL_FILTERS,deferredIds:[]};
    const before=await vault.preview(ACCOUNT_A,setup);
    await vault.clearSnoozes(ACCOUNT_A);
    assert.equal((await vault.preview(ACCOUNT_A,setup)).quickTotal,before.quickTotal+1);
    assert.equal(psql(fixture,'select count(*) from app.snoozes where account_id=2',true),'1');
    const current=psql(fixture,'select current_game_id from app.vault_state where account_id=1',true);
    await vault.clearHistory(ACCOUNT_B);assert.equal((await vault.history(ACCOUNT_A)).draws.length,history.draws.length+1);
    await vault.clearHistory(ACCOUNT_A);assert.equal((await vault.history(ACCOUNT_A)).draws.length,0);
    assert.equal(psql(fixture,'select current_game_id from app.vault_state where account_id=1',true),current);
    assert.equal(psql(fixture,'select current_draw_ref is null from app.vault_state where account_id=1',true),'t');
    assert.equal(psql(fixture,`select count(*) from app.vault_draw_events where public_id='${key}'`,true),'0');
  });

  await t.test("Vault preserves warm-start learning and concurrent draws cannot bypass decisions", async () => {
    psql(fixture,`insert into reco.warm_start_snapshots(id,snapshot_key,snapshot_version,status,frozen_at)
      overriding system value values(999,'vault-test',1,'frozen',now());
      insert into reco.user_genre_preferences(snapshot_id,account_id,source_user_id,genre,mood,positive,total)
        values(999,1,'11111111-1111-4111-8111-111111111111','Adventure','any',15,20),
          (999,2,'22222222-2222-4222-8222-222222222222','Strategy','any',0,100);
      insert into reco.genre_preference_globals(snapshot_id,genre,mood,positive,total) values(999,'Adventure','any',50,100);
      insert into reco.game_preference_globals(snapshot_id,steam_app_id,positive,total,total_hours) values(999,100005,20,30,900),(999,101150,0,100,10);`);
    const database=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_read_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:2}));
    try {
      const vault=new VaultRepository(database),mutations=new MutationsRepository(database);
      const setup:VaultSetup={session:'evening',mood:'chill',goal:'surprise',collectionId:null,genres:[],globalFilters:DEFAULT_GLOBAL_FILTERS,deferredIds:[]};
      const full=(await collect(fixture.library,ACCOUNT_A,{section:'all',sort:'title',limit:100})).items.map(libraryGame);
      const expected=buildVaultPool({games:full,session:setup.session,mood:setup.mood,goal:setup.goal,selectedCollectionId:null,selectedGenres:[],snoozedIds:new Set(),
        genrePreferences:buildGenrePreferenceIndex([{genre:'Adventure',contextMood:'any',positive:15,total:20}]),
        genrePreferenceGlobals:buildGenrePreferenceIndex([{genre:'Adventure',contextMood:'any',positive:50,total:100}]),gameVerdicts:{'100005':[20,30,900]}});
      const preview=await vault.preview(ACCOUNT_A,setup);
      assert.equal(preview.preferenceRowCount,1);
      assert.deepEqual(preview.deck.map(row=>[row.game.id,row.preferencePoints,row.appealPoints]),buildVaultDeck(expected).map(row=>[row.game.id,row.preferencePoints,row.appealPoints]));
      assert.ok(JSON.stringify(preview).length<300000,'64 previews must stay bounded');
      const request:VaultDrawRequest={...setup,requestKey:'99999999-9999-4999-8999-999999999921',quick:false,arm:'test',previousId:null,cycleIds:[],excludeIds:[]};
      const duplicate=await Promise.all([vault.draw(ACCOUNT_A,request,()=>0),vault.draw(ACCOUNT_A,request,()=>0.999999)]);
      assert.equal(duplicate[0]?.game.id,duplicate[1]?.game.id);assert.equal(duplicate[0]?.arm,'test');
      assert.deepEqual(duplicate[0]?.activeSnoozedIds,[]);
      assert.equal(psql(fixture,`select count(*) from app.vault_draws where public_id='${request.requestKey}'`,true),'1');
      const target=expected.at(-1)!.game;
      const one={...request,requestKey:'99999999-9999-4999-8999-999999999922',quick:true,excludeIds:full.filter(game=>game.id!==target.id).map(game=>game.id)};
      await Promise.all([vault.draw(ACCOUNT_A,one),mutations.decide(ACCOUNT_A,Number(target.id),'blacklist')]);
      assert.notEqual(psql(fixture,'select current_game_id from app.vault_state where account_id=1',true),target.id);
      assert.equal(psql(fixture,`select blacklisted from app.game_state where account_id=1 and game_id=${target.id}`,true),'t');
      const owned=full.find(game=>game.status!=='Completed'&&game.status!=='Blacklisted'&&game.accessSource==='owned')!;
      await mutations.decideWithVersion(ACCOUNT_A,Number(owned.id),'complete','99999999-9999-4999-8999-999999999923','vault');
      assert.equal(psql(fixture,`select origin_surface from app.completion_events where account_id=1 and game_id=${owned.id} and undone_at is null order by id desc limit 1`,true),'vault');
    } finally { await database.close(); }
  });
});

test('V2 Family current-app access is atomic, owner-protected and preserves authored data',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  const family=new FamilyRepository(fixture.database);
  psql(fixture,`delete from app.family_members;
    insert into app.steam_profiles(account_id,steam_id) values(1,76561198000000001),(2,76561198000000002);
    select setval('app.family_members_id_seq',12,true);select setval('catalog.games_id_seq',1205,true);
    update ops.provider_controls set mode='live' where provider='steam';
    update catalog.game_metadata set categories='["Family Sharing"]' where game_id in (5,1101,1102);
    update catalog.game_metadata set categories='["Single-player"]' where game_id=1103;
    update catalog.game_metadata set categories='[]' where game_id=1104;
    insert into catalog.offers(game_id,provider,region_code,is_free,first_observed_at,last_observed_at)
      values(1102,'legacy_catalog_games','US',true,now(),now());`);
  const games=[5,1101,1102,1103,1104].map(id=>({appId:String(100000+id),title:`Family ${id}`}));
  const snapshot=async(steamId:string,candidates=games,principal=ACCOUNT_A):Promise<FamilySnapshot>=>({steamId,displayName:'Lender',avatarUrl:null,games:candidates,
    lookup:await family.reserveLookup(principal,'public_owned_lookup'),observedAt:new Date().toISOString()});
  let first:string,second:string;

  await t.test('whole validated shelf admits only evidenced shareable games; no personal time is invented',async()=>{
    const added=await family.add(ACCOUNT_A,await snapshot('76561198000000101'));
    first=added.memberId;
    assert.deepEqual(added.counts,{seen:5,importable:1,alreadyOwned:1,excluded:2,pending:1});
    const roster=await family.list(ACCOUNT_A);assert.equal(roster.length,1);assert.equal(roster[0].id,first);
    assert.equal(roster[0].librarySeen,5);assert.equal(roster[0].gamesImported,1);
    const card=await fixture.library.detail(ACCOUNT_A,1101);assert.ok(card);assert.equal(card.access,'family');assert.equal(card.playtimeMinutes,null);
    assert.equal(psql(fixture,'select count(*) from app.game_activity where account_id=1 and game_id=1101',true),'0');
    assert.equal(psql(fixture,'select count(*) from app.library_games where account_id=1 and game_id=1101',true),'0');
    assert.equal((await family.list(ACCOUNT_B)).length,0);
    await assert.rejects(family.remove(ACCOUNT_B,first),e=>e instanceof FamilyRequestError&&e.code==='not_found');
    await assert.rejects(family.add(ACCOUNT_A,await snapshot('76561198000000101')),e=>e instanceof FamilyRequestError&&e.code==='already_added');
    await assert.rejects(family.add(ACCOUNT_A,await snapshot('76561198000000001')),e=>e instanceof FamilyRequestError&&e.code==='is_self');
  });

  await t.test('partial, private and malformed provider responses never publish a lender or clear access',async()=>{
    const prior=psql(fixture,'select count(*) from app.family_game_access where account_id=1',true);
    for(const body of [{response:{}},{response:{game_count:2,games:[{appid:101101,playtime_forever:9}]}},{response:{game_count:1,games:[{appid:0}]}}]) {
      await assert.rejects(addV2FamilyMember(family,ACCOUNT_A,'76561198000000102',{
        apiKey:'synthetic-test-key',fetch:async()=>Response.json(body),nowEpochSeconds:()=>Math.floor(Date.now()/1000),
        profile:async()=>({display_name:'Lender',avatar_url:null})}),FamilyRequestError);
    }
    assert.equal((await family.list(ACCOUNT_A)).length,1);assert.equal(psql(fixture,'select count(*) from app.family_game_access where account_id=1',true),prior);
    const invalid=await snapshot('76561198000000103');
    await assert.rejects(family.add(ACCOUNT_A,{...invalid,games:[...games,games[0]]}),FamilyRequestError);
    const borrowed=await snapshot('76561198000000104',games,ACCOUNT_B);
    await assert.rejects(family.add(ACCOUNT_A,borrowed),e=>e instanceof FamilyRequestError&&e.code==='library_unavailable');
    const late=await snapshot('76561198000000105');
    psql(fixture,`update ops.provider_call_charges set expires_at=charged_at+interval '1 microsecond' where attempt_id='${late.lookup.attemptId}'`);
    await assert.rejects(family.add(ACCOUNT_A,late),FamilyRequestError);
  });

  await t.test('rechecking uses whole stored shelves and retains existing access on unknown facts',async()=>{
    psql(fixture,"update catalog.game_metadata set categories='[\"Family Sharing\"]' where game_id=1104");
    const counts=await family.recheck(ACCOUNT_A);assert.equal(counts.importable,2);assert.equal(counts.pending,0);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1104))?.access,'family');
    const added=await family.add(ACCOUNT_A,await snapshot('76561198000000106',[games[1]]));second=added.memberId;
    psql(fixture,"update catalog.game_metadata set categories='[]' where game_id=1101");
    assert.equal((await family.recheck(ACCOUNT_A)).pending,2);
    assert.equal(psql(fixture,'select count(*) from app.family_game_access where account_id=1 and game_id=1101',true),'2');
  });

  await t.test('removal keeps other lenders, owned games and exact personal decisions; lost commitments clear',async()=>{
    psql(fixture,`insert into app.game_state(account_id,game_id,completed_at,blacklisted,notes) values
      (1,1104,'2026-09-01T12:00:00.123456Z',true,'Keep this personal note');
      delete from app.pins where account_id=1 and scope='family';
      insert into app.pins(account_id,scope,slot,game_id) values(1,'family',1,1104),(1,'family',2,1101);
      update app.vault_state set current_game_id=1104 where account_id=1;`);
    const before=psql(fixture,'select row_to_json(s)::text from app.game_state s where account_id=1 and game_id=1104',true);
    const removal=await family.remove(ACCOUNT_A,first);
    assert.deepEqual(removal,{removed:1,retained:2,displayName:'Lender'});
    assert.equal(psql(fixture,'select row_to_json(s)::text from app.game_state s where account_id=1 and game_id=1104',true),before);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1101))?.access,'family');assert.equal(await fixture.library.detail(ACCOUNT_A,1104),null);
    assert.equal(psql(fixture,'select count(*) from app.pins where account_id=1 and game_id=1104',true),'0');
    assert.equal(psql(fixture,'select count(*) from app.pins where account_id=1 and game_id=1101',true),'1');
    assert.equal(psql(fixture,'select current_game_id is null from app.vault_state where account_id=1',true),'t');
    await family.add(ACCOUNT_A,await snapshot('76561198000000107',[games[4]]));
    const restored=await fixture.library.detail(ACCOUNT_A,1104);assert.ok(restored?.blacklisted&&restored.completed);assert.equal(restored.notes,'Keep this personal note');
    assert.equal(restored.product?.completedAt,'2026-09-01T12:00:00.123456Z');
    assert.equal(psql(fixture,'select count(*) from app.completion_events where account_id=1 and game_id=1104',true),'0');
    assert.ok((await family.list(ACCOUNT_A)).some(member=>member.id===second));
  });

  await t.test('two connections cannot exceed five lenders or overwrite existing shared catalogue titles',async()=>{
    for(const id of ['76561198000000108','76561198000000109'])await family.add(ACCOUNT_A,await snapshot(id,[]));
    assert.equal((await family.list(ACCOUNT_A)).length,4);
    const db=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_read_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:2}));
    try {
      const concurrent=new FamilyRepository(db),s1=await snapshot('76561198000000110',[{appId:'4000000000',title:'New pending game'}]),s2=await snapshot('76561198000000111',[{appId:'4000000001',title:'Other pending game'}]);
      const outcomes=await Promise.allSettled([concurrent.add(ACCOUNT_A,s1),concurrent.add(ACCOUNT_A,s2)]);
      assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
      assert.equal(outcomes.filter(outcome=>outcome.status==='rejected'&&outcome.reason instanceof FamilyRequestError&&outcome.reason.code==='limit_reached').length,1);
      assert.equal((await family.list(ACCOUNT_A)).length,5);
      assert.equal(psql(fixture,"select count(*) from catalog.games where steam_app_id in (4000000000,4000000001)",true),'1');
      assert.notEqual(psql(fixture,'select title from catalog.games where id=1101',true),games[1].title);
    } finally {await db.close();}
  });

  await t.test('runtime cannot directly write shared catalogue/access or execute internal definer helpers',async()=>{
    await assert.rejects(fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`insert into app.family_game_access(account_id,member_id,game_id) values(2,1,1101)`));
    await assert.rejects(fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`select app._refresh_family_access()`));
    await assert.rejects(fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`update catalog.games set title='Tampered' where id=1101`));
    await assert.rejects(fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`update app.family_members set account_id=2 where account_id=1`));
  });
  await t.test('complete 10k shelf is retained without client/library expansion; overflow is refused',async()=>{
    psql(fixture,"insert into app.steam_profiles(account_id,steam_id) values(3,76561198000000003)");
    const shelf=Array.from({length:10000},(_,index)=>({appid:3000000000+index,name:`Pending ${index}`,playtime_forever:500}));
    const added=await addV2FamilyMember(family,EMPTY_ACCOUNT,'76561198000000201',{
      apiKey:'synthetic-key',fetch:async()=>Response.json({response:{game_count:shelf.length,games:shelf}}),nowEpochSeconds:()=>Math.floor(Date.now()/1000),
      profile:async()=>({display_name:'Large shelf',avatar_url:null})});
    assert.deepEqual(added.counts,{seen:10000,pending:10000,importable:0,alreadyOwned:0,excluded:0});
    assert.equal(added.truncated,0);assert.ok(JSON.stringify(added).length<2000);
    assert.equal(psql(fixture,'select jsonb_array_length(candidate_app_ids) from app.family_members where account_id=3',true),'10000');
    assert.equal(psql(fixture,'select count(*) from app.family_game_access where account_id=3',true),'0');
    assert.equal(psql(fixture,'select count(*) from app.game_activity where account_id=3',true),'0');
    const tooLarge=await snapshot('76561198000000202',Array.from({length:10001},(_,i)=>({appId:String(3100000000+i),title:'Pending'})),EMPTY_ACCOUNT);
    await assert.rejects(family.add(EMPTY_ACCOUNT,tooLarge),InvalidPageQueryError);
    assert.equal((await family.list(EMPTY_ACCOUNT)).length,1);
  });
});

test('V2 Steam import runtime uses the real separate-role live adapter with synthetic Steam responses',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_import_runtime login;grant vault_worker to vault_import_runtime with inherit true,set false;
    insert into app.steam_profiles(account_id,steam_id) values(1,76561198000000001),(2,76561198000000002),(3,76561198000000003);
    update ops.provider_controls set mode='live' where provider='steam';`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_import_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());
  const imports=new ImportRepository(fixture.database),invoke=createOwnedWorkerInvoker(worker),secret='synthetic-import-secret';
  let fetches=0,publishes=0,loseReply=true;
  const fetch:typeof globalThis.fetch=async input=>{
    fetches++;
    const url=new URL(String(input));assert.equal(url.hostname,'api.steampowered.com');assert.equal(url.searchParams.get('skip_unvetted_apps'),'0');
    const apps=url.searchParams.get('steamid')==='76561198000000001'?[{appid:100005,playtime_forever:100,name:'Owned five'},{appid:101006,playtime_forever:0,name:'Promoted family'},{appid:101201,name:'Unknown personal time'}]
      :[{appid:101150,playtime_forever:77,name:'Other tenant game'}];
    return Response.json({response:{game_count:apps.length,games:apps}});
  };
  await t.test('worker identity guard rejects ordinary and operator roles and wrong project',async()=>{
    await verifyWorkerDatabase(worker,'vbjtbwelnhbbdfrqczyf');
    await assert.rejects(verifyWorkerDatabase(fixture.database,'vbjtbwelnhbbdfrqczyf'),DatabaseUnavailableError);
    await assert.rejects(verifyWorkerDatabase(worker,'pfvblcopcmairdfeqdep'),DatabaseUnavailableError);
    const operator=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://postgres@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket}));
    try{await assert.rejects(verifyWorkerDatabase(operator,'vbjtbwelnhbbdfrqczyf'),DatabaseUnavailableError);}finally{await operator.close();}
  });
  await t.test('worker SQL deadlines cancel a blocked claim and leave the queue usable',async()=>{
    const operator=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://postgres@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
    try {
      await operator.sql.begin(async tx=>{
        await tx`select ops._m2_queue_lock(ops._m2_queue_name('interactive'))`;
        const bounded=createOwnedWorkerInvoker(worker,{deadlineAt:Date.now()+100});
        const start=Date.now();
        await assert.rejects(bounded({functionName:'ops.claim_job',args:['interactive',120]}),/timeout/);
        assert.ok(Date.now()-start<2000,'blocked claims cannot consume the serverless runtime');
      });
      const drained=await invoke({functionName:'ops.claim_job',args:['interactive',120]}) as {claimed:boolean;block_code:string}[];
      assert.equal(drained[0].claimed,false);assert.equal(drained[0].block_code,'no_message');
      await assert.rejects(createOwnedWorkerInvoker(worker,{deadlineAt:Date.now()-1})({functionName:'ops.claim_job',args:['interactive',120]}),/deadline/);
    }finally{await operator.close();}
  });
  const key='12345678-1234-4234-8234-123456789001';let job:string;
  await t.test('enqueue coalesces/replays without fetching and status is tenant scoped',async()=>{
    assert.equal((await imports.status(ACCOUNT_A)).progress.status,'idle');
    const queued=await imports.request(ACCOUNT_A,key,secret);job=queued.jobId!;
    assert.equal(queued.progress.status,'fetching');assert.equal(queued.progress.total,0);assert.equal(fetches,0);
    assert.equal((await imports.request(ACCOUNT_A,key,secret)).jobId,job);
    assert.equal((await imports.request(ACCOUNT_A,'12345678-1234-4234-8234-123456789002',secret)).jobId,job);
    assert.equal((await imports.status(ACCOUNT_B)).jobId,null);
    await assert.rejects(imports.request(ACCOUNT_B,key,secret),DatabaseUnavailableError);
    assert.equal(psql(fixture,"select count(*) from ops.jobs where account_id=1 and job_kind='owned_snapshot'",true),'1');
    assert.equal(psql(fixture,"select request_count from ops.abuse_cooldowns where bucket='steam_library_refresh' and account_id=1",true),'1');
  });
  await t.test('one complete full fetch publishes atomically; lost reply replays without another fetch/charge',async()=>{
    let announcePublish:()=>void=()=>{};
    const publishing=new Promise<void>(resolve=>{announcePublish=resolve;});
    let announceClaim:()=>void=()=>{},announceHeld:()=>void=()=>{};
    const claimed=new Promise<void>(resolve=>{announceClaim=resolve;}),held=new Promise<void>(resolve=>{announceHeld=resolve;});
    const running=runOwnedWorkerBatch({sql:async call=>{
      if(call.functionName==='ops.publish_owned_snapshot'){await held;announcePublish();}
      const rows=await invoke(call);
      if(call.functionName==='ops.claim_job')announceClaim();
      if(call.functionName==='ops.publish_owned_snapshot'){publishes++;if(loseReply){loseReply=false;throw Error('Synthetic lost commit reply');}}
      return rows;
    },apiKey:'synthetic-key',fetch,nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:1});
    await claimed;
    await fixture.database.withPrincipal(ACCOUNT_A,async tx=>{
      await tx`select id from app.accounts where id=1 for update`;announceHeld();
      await publishing;
      let blocked=false;
      for(let attempt=0;attempt<20&&!blocked;attempt++) {
        await new Promise(resolve=>setTimeout(resolve,10));
        blocked=psql(fixture,"select exists(select 1 from pg_stat_activity where usename='vault_import_runtime' and state='active' and wait_event_type='Lock')",true)==='t';
      }
      assert.ok(blocked,'publication waits on the parent before touching authored commitments');
      await tx`delete from app.pins where account_id=1 and scope='family' and game_id=1008`;
      await tx`update app.game_state set notes='Concurrent authored note',revision=revision+1 where account_id=1 and game_id=5`;
      // Do not await publication while holding the parent. Commit this authored
      // edit first, then let the blocked worker read the resulting facts.
    });
    const result=await running;
    assert.deepEqual(result,{claimed:1,published:1,retryScheduled:0,stale:0,failed:0});assert.equal(fetches,1);assert.equal(publishes,2);
    const status=await imports.status(ACCOUNT_A);assert.equal(status.jobId,job);assert.equal(status.progress.status,'complete');assert.equal(status.progress.imported,3);assert.equal(status.progress.percent,100);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1006))?.access,'owned');assert.equal((await fixture.library.detail(ACCOUNT_A,1006))?.playtimeMinutes,0);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1201))?.playtimeMinutes,null);assert.equal((await fixture.library.detail(ACCOUNT_A,1007))?.access,'family');
    assert.equal((await fixture.library.detail(ACCOUNT_A,5))?.notes,'Concurrent authored note');
    assert.equal(psql(fixture,'select count(*) from app.library_games where account_id=1',true),'3');
    const daily=JSON.parse(psql(fixture,`select row_to_json(d) from app.playtime_daily d where account_id=1
      and activity_day=(select (body_observed_at at time zone 'UTC')::date from ops.jobs where id='${job}')`,true));
    assert.equal(daily.coverage,'partial','one unknown owned observation keeps daily coverage partial');
    assert.equal(daily.observed_minutes,100);assert.equal(daily.games_with_playtime,1);
    assert.equal(psql(fixture,`select count(*) from app.playtime_daily d join ops.jobs j on j.id='${job}'
      where d.account_id=1 and d.recorded_at=j.body_observed_at`,true),'1','lost-response replay does not recapture');

    assert.equal(psql(fixture,"select count(*) from ops.provider_call_charges where account_id=1 and endpoint='owned_snapshot'",true),'1');
    await assert.rejects(imports.request(ACCOUNT_A,'12345678-1234-4234-8234-123456789003',secret),RequestLimitError);
    assert.equal((await imports.request(ACCOUNT_A,key,secret)).progress.status,'complete');
    assert.equal((await imports.status(ACCOUNT_B)).progress.status,'idle');
  });
  await t.test('private and invalid full responses preserve ownership and finish with truthful failure',async()=>{
    const second='12345678-1234-4234-8234-123456789004';
    await imports.request(ACCOUNT_B,second,secret);
    const before=psql(fixture,'select row_to_json(l)::text from app.library_games l where account_id=2',true);
    const result=await runOwnedWorkerBatch({sql:invoke,apiKey:'synthetic-key',fetch:async()=>Response.json({response:{}}),nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:1});
    assert.equal(result.published,1);const status=await imports.status(ACCOUNT_B);assert.equal(status.progress.status,'failed');assert.match(status.progress.lastError!,/Game details Public/);
    assert.equal(psql(fixture,'select row_to_json(l)::text from app.library_games l where account_id=2',true),before);
    assert.equal(psql(fixture,'select count(*) from app.playtime_daily where account_id=2',true),'0','unavailable body creates no daily observation');
    await imports.request(EMPTY_ACCOUNT,'12345678-1234-4234-8234-123456789005',secret);
    await runOwnedWorkerBatch({sql:invoke,apiKey:'synthetic-key',fetch:async()=>Response.json({response:{game_count:2,games:[{appid:100001}]}}),nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:1});
    assert.equal((await imports.status(EMPTY_ACCOUNT)).progress.status,'failed');assert.equal(psql(fixture,'select count(*) from app.library_games where account_id=3',true),'0');
  });
  await t.test('missing credentials and drained queue never fetch; worker cannot directly write catalogue or authored state',async()=>{
    await assert.rejects(runOwnedWorkerBatch({sql:invoke,apiKey:'',fetch,nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:1}));
    const result=await runOwnedWorkerBatch({sql:invoke,apiKey:'synthetic-key',fetch,nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:3});
    assert.equal(result.claimed,0);assert.equal(fetches,1);
    await assert.rejects(worker.sql`update catalog.games set title='Wrong' where id=5`);
    await assert.rejects(worker.sql`delete from app.game_state`);
    await assert.rejects(worker.sql`select app.begin_owned_import(${key}::uuid,${Buffer.alloc(32)})`);
  });
});

test('V2 pinned refresh uses bounded owned-only observations without a full sweep',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`insert into app.steam_profiles(account_id,steam_id) values(1,76561198000000001),(2,76561198000000001);
    update ops.provider_controls set mode='live' where provider='steam';
    insert into app.pins(account_id,scope,slot,game_id) values(2,'library',1,1150);`);
  const pinned=new PinnedRepository(fixture.database),secret='pinned-synthetic-secret';
  const reset=()=>psql(fixture,"delete from ops.abuse_cooldowns where bucket in ('pinned_playtime_account','pinned_playtime_steam')");
  const options=(fetch:typeof globalThis.fetch)=>({apiKey:'synthetic-key',secret,fetch});
  let fetches=0;
  const fetch:typeof globalThis.fetch=async input=>{
    fetches++;const url=new URL(String(input));assert.equal(url.hostname,'api.steampowered.com');
    const scope=JSON.parse(url.searchParams.get('input_json')!);
    assert.equal(scope.include_appinfo,false);assert.deepEqual(scope.appids_filter.length,1);
    assert.equal(url.searchParams.has('steamid'),false);
    const appid=scope.appids_filter[0];
    assert.ok([100001,100002,100003].includes(appid),'only owned Library pins can be requested');
    return Response.json({response:{game_count:1,games:[{appid,playtime_forever:appid===100002?0:120}]}});
  };
  await t.test('three filtered charges update personal minutes; zero stays known and all unrelated facts remain',async()=>{
    const before=psql(fixture,"select count(*) from app.library_games where account_id=1",true);
    const result=await refreshV2PinnedPlaytime(pinned,ACCOUNT_A,options(fetch));
    assert.equal(fetches,3);assert.equal(result.refreshed,3);assert.equal(result.skipped,0);assert.equal(result.games.length,3);
    assert.equal(result.games.find(game=>game.gameId===2)?.playtimeMinutes,0);
    assert.equal(result.games.find(game=>game.gameId===1)?.playtimeMinutes,120);
    assert.equal(psql(fixture,"select count(*) from app.library_games where account_id=1",true),before);
    assert.equal(psql(fixture,"select notes from app.game_state where account_id=1 and game_id=5",true),'A retained private note');
    assert.equal(psql(fixture,"select count(*) from app.library_observation_fences where account_id=1 and observation_scope='pinned_owned'",true),'3');
    assert.equal(psql(fixture,"select count(*) from ops.provider_call_charges where account_id=1 and endpoint='pinned' and status='applied'",true),'3');
    assert.equal(psql(fixture,"select count(*) from ops.jobs",true),'0');
  });
  await t.test('server cooldown blocks repeats and shares the same Steam allowance across manual workspaces',async()=>{
    await assert.rejects(refreshV2PinnedPlaytime(pinned,ACCOUNT_A,options(fetch)),RequestLimitError);
    await assert.rejects(refreshV2PinnedPlaytime(pinned,ACCOUNT_B,options(fetch)),RequestLimitError);
    assert.equal(fetches,3);
    assert.equal(psql(fixture,"select account_id is null from ops.abuse_cooldowns where bucket='pinned_playtime_steam'",true),'t');
  });
  await t.test('hidden/private and malformed/partial bodies cannot erase time or publish a subset as a full snapshot',async()=>{
    for(const response of [()=>Response.json({response:{}}),()=>Response.json({response:{games:[{appid:100001}]}}),
      ()=>Response.json({response:{games:[{appid:100001,playtime_forever:'0'}]}}),()=>Response.json({response:{games:[]}},{status:206}),
      ()=>new Response('x'.repeat(32769))]) {
      reset();await assert.rejects(refreshV2PinnedPlaytime(pinned,ACCOUNT_A,options(async()=>response())),PinnedRefreshError);
      assert.equal(psql(fixture,"select playtime_minutes from app.library_games where account_id=1 and game_id=1",true),'120');
      assert.equal(psql(fixture,"select count(*) from app.library_games where account_id=1",true),'1005');
    }
  });
  await t.test('decreases retain the strongest saved evidence; unknown and Family minutes stay unknown',async()=>{
    reset();const result=await refreshV2PinnedPlaytime(pinned,ACCOUNT_A,options(async input=>{
      const appid=JSON.parse(new URL(String(input)).searchParams.get('input_json')!).appids_filter[0];
      return Response.json({response:{games:[{appid,playtime_forever:0,rtime_last_played:Math.floor(Date.now()/1000)+3600}]}});
    }));
    assert.equal(result.games.find(game=>game.gameId===1)?.playtimeMinutes,120);
    assert.equal(result.games.find(game=>game.gameId===1)?.lastPlayedAt,null);
    assert.equal(psql(fixture,"select count(*) from app.library_observation_anomalies where reason='provider_decrease'",true),'2');
    assert.equal((await fixture.library.detail(ACCOUNT_A,1006))?.playtimeMinutes,null);
    assert.equal((await fixture.library.detail(ACCOUNT_A,1))?.playtimeMinutes,120);
  });
  await t.test('two-connection unpin and authored edits serialize before publication; receipts cannot cross tenants or replay',async()=>{
    reset();const reserved=await pinned.reserve(ACCOUNT_A,secret);
    const observation={attempt:reserved.attempts[0],minutes:240,lastPlayedAt:null};
    assert.deepEqual(await pinned.publish(ACCOUNT_B,[observation]),[]);
    const author=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_read_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
    let publishing:Promise<LibraryCard[]>;
    try {
      await author.withPrincipal(ACCOUNT_A,async tx=>{
        await tx`select id from app.accounts where id=1 for update`;
        publishing=pinned.publish(ACCOUNT_A,[observation]);
        let blocked=false;
        for(let index=0;index<20&&!blocked;index++) {
          await new Promise(resolve=>setTimeout(resolve,10));
          blocked=psql(fixture,"select exists(select 1 from pg_stat_activity where usename='vault_read_runtime' and state='active' and wait_event_type='Lock')",true)==='t';
        }
        assert.ok(blocked,'pinned publication waits for authored parent before acquiring the sync fence');
        await tx`delete from app.pins where account_id=1 and scope='library' and game_id=1`;
        await tx`select app.set_game_notes(1,'Edited during Steam fetch')`;
      });
      assert.deepEqual(await publishing!,[]);
    }finally{await author.close();}
    assert.equal(psql(fixture,"select playtime_minutes from app.library_games where account_id=1 and game_id=1",true),'120');
    assert.equal(psql(fixture,"select notes from app.game_state where account_id=1 and game_id=1",true),'Edited during Steam fetch');
    const valid={attempt:reserved.attempts[1],minutes:30,lastPlayedAt:null};
    assert.equal((await pinned.publish(ACCOUNT_A,[valid])).length,1);
    assert.deepEqual(await pinned.publish(ACCOUNT_A,[valid]),[]);
    await assert.rejects(fixture.database.withPrincipal(ACCOUNT_A,tx=>tx`select app._m2_record_pinned_owned_observation(${valid.attempt.attemptId}::uuid,${valid.attempt.attemptToken}::uuid,'{}'::jsonb)`));
  });
  await t.test('a newer full-authority fence refuses older pin results; no pins perform no network work',async()=>{
    reset();const reserved=await pinned.reserve(ACCOUNT_A,secret);
    psql(fixture,"update app.library_sync_state set last_full_fetch_started_at=clock_timestamp() where account_id=1");
    assert.deepEqual(await pinned.publish(ACCOUNT_A,reserved.attempts.map(attempt=>({attempt,minutes:999,lastPlayedAt:null}))),[]);
    assert.equal(psql(fixture,"select count(*) from app.library_observation_anomalies where reason='pinned_superseded'",true),'2');
    let calls=0;const empty=await refreshV2PinnedPlaytime(pinned,EMPTY_ACCOUNT,options(async()=>{calls++;return Response.json({});}));
    assert.equal(empty.refreshed,0);assert.equal(empty.retryAfterSeconds,0);assert.equal(calls,0);
    await assert.rejects(refreshV2PinnedPlaytime(pinned,ACCOUNT_A,{...options(fetch),apiKey:''}),PinnedRefreshError);
  });
});

test('V2 capabilities use whole owned evidence independently of cached cards or global filters',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  // Put all useful evidence at the tail, outside three pins and a 60-card page.
  psql(fixture,`update app.library_games set playtime_minutes=null where account_id=1;
    update app.library_games set playtime_minutes=120 where account_id=1 and game_id=1005;
    delete from app.game_activity where account_id=1;
    insert into app.game_activity(account_id,game_id,last_observed_minutes,last_played_at,observed_at,evidence_source,recency_evidence_kind)
      values (1,1003,120,'2026-09-01 00:00:00+00','2026-09-01 00:00:00+00','steam_api','steam_exact'),
      (1,1004,120,'2026-09-02 00:00:00+00','2026-09-02 00:00:00+00','steam_api','observed_playtime_change'),
      (1,1005,120,null,'2026-09-03 00:00:00+00','steam_api','steam_recent_window');`);
  const all=await fixture.bootstrap.read(ACCOUNT_A);
  assert.deepEqual(all.capabilities,{canUsePersonalLibrary:true,canUseProgress:true,canUseRecency:true,canUseHistory:true});
  assert.deepEqual((await fixture.bootstrap.read(EMPTY_ACCOUNT)).capabilities,{canUsePersonalLibrary:false,canUseProgress:false,canUseRecency:false,canUseHistory:false});
  const other=await fixture.bootstrap.read(ACCOUNT_B);
  assert.equal(other.capabilities?.canUseRecency,false,'one unsupported-source date is unknown even for a one-game owner');
  psql(fixture,"insert into app.account_capabilities(account_id,playtime_visibility) values(1,'hidden')");
  assert.equal((await fixture.bootstrap.read(ACCOUNT_A)).capabilities?.canUseProgress,false);
  psql(fixture,"delete from app.library_games where account_id=1;delete from app.playtime_daily where account_id=1");
  assert.ok((await fixture.bootstrap.read(ACCOUNT_A)).familyTotal>0);
  assert.deepEqual((await fixture.bootstrap.read(ACCOUNT_A)).capabilities,{canUsePersonalLibrary:false,canUseProgress:false,canUseRecency:false,canUseHistory:false});
  assert.ok(JSON.stringify(all).length<2500,'only four capabilities are returned, never the whole Library');
});

test('V2 public guest catalogue uses shared facts and bounded current selection without private state',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`update catalog.game_metadata set short_description='Public Steam description',
    header_image_url='https://example.invalid/public.jpg',genres='["Adventure"]',weighted_tags='[{"tag":"Adventure","weight":9}]';
    update catalog.game_features set review_total=500,review_positive=450;
    update catalog.games set steam_app_id=4294967295 where id=1205;
    update catalog.game_features set popularity_rank=1 where game_id=1205;
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,source,precedence_rank,decision_status,reason,created_at,updated_at)
      values(4,100004,'quarantine','catalog_game_quarantine','100004','fixture',1,'excluded','Synthetic quarantine',now(),now());`);
  const guests=new GuestRepository(fixture.database);
  const games=await guests.list();
  assert.ok(games.length>=200&&games.length<=1000);
  assert.ok(games.some(game=>game.steam_appid==='4294967295'),'uint32 AppIDs do not overflow signed integer hydration');
  assert.equal(games.some(game=>game.steam_appid==='100004'),false);
  assert.equal(games.some(game=>game.steam_appid==='101105'),false,'retired shared games stay out');
  assert.equal(new Set(games.map(game=>game.id)).size,games.length);
  for(const game of games){assert.equal(game.user_id,'');assert.equal(game.notes,'');assert.equal(game.hours_played,0);assert.equal(game.status,'Not Started');assert.equal(game.last_played_at,null);}
  const body=JSON.stringify(games);
  assert.equal(body.includes('A retained private note'),false);assert.equal(body.includes(ACCOUNT_A.accountPublicId),false);
  assert.deepEqual(games,await guests.list(),'public pool is deterministic and independent of caller account');
  // An ordinary runtime still cannot SELECT the private review ledger.
  await assert.rejects(fixture.database.sql`select * from catalog.review_decisions`);
  psql(fixture,"update catalog.game_metadata set genres='[\"Unknown\"]';update catalog.game_features set main_duration_minutes=null,duration_kind='unknown'");
  assert.deepEqual(await guests.list(),[],'no half-enriched public games sneak through the gates');
});

test('V2 full claim and parent-first pinned publication cannot form an account-FK/sync deadlock',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_claim_runtime login;grant vault_worker to vault_claim_runtime with inherit true,set false;
    insert into app.steam_profiles(account_id,steam_id) values(1,76561198000000001);
    update ops.provider_controls set mode='live' where provider='steam';
    create function public.fixture_pause_charge() returns trigger language plpgsql as $$
      begin if new.endpoint='owned_snapshot' then perform pg_advisory_xact_lock(793112);end if;return new;end $$;
    create trigger fixture_pause_charge before insert on ops.provider_call_charges
      for each row execute function public.fixture_pause_charge();`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_claim_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  const operator=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://postgres@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());t.after(()=>operator.close());
  const pinned=new PinnedRepository(fixture.database),reserved=await pinned.reserve(ACCOUNT_A,'synthetic-lock-secret');
  await new ImportRepository(fixture.database).request(ACCOUNT_A,'12345678-1234-4234-8234-123456789091','synthetic-lock-secret');
  let claiming:Promise<unknown>,publishing:Promise<LibraryCard[]>;
  await operator.sql.begin(async tx=>{
    await tx`select pg_advisory_xact_lock(793112)`;
    claiming=createOwnedWorkerInvoker(worker,{deadlineAt:Date.now()+5000})({functionName:'ops.claim_job',args:['interactive',120]});
    let claimBlocked=false;
    for(let index=0;index<40&&!claimBlocked;index++) {
      await new Promise(resolve=>setTimeout(resolve,10));
      claimBlocked=psql(fixture,"select exists(select 1 from pg_stat_activity where usename='vault_claim_runtime' and wait_event='advisory')",true)==='t';
    }
    assert.ok(claimBlocked,'claim holds sync before the actual charge/FK insertion');
    publishing=pinned.publish(ACCOUNT_A,[{attempt:reserved.attempts[0],minutes:999,lastPlayedAt:null}]);
    let pinBlocked=false;
    for(let index=0;index<40&&!pinBlocked;index++) {
      await new Promise(resolve=>setTimeout(resolve,10));
      pinBlocked=psql(fixture,"select exists(select 1 from pg_stat_activity where usename='vault_read_runtime' and wait_event_type='Lock')",true)==='t';
    }
    assert.ok(pinBlocked,'pinned publication owns parent and waits on the claim sync fence');
  });
  const claims=await claiming! as {claimed:boolean}[];
  assert.equal(claims[0].claimed,true,'account-FK key share can pass the non-key publication lock');
  assert.deepEqual(await publishing!,[],'the newly started full fetch correctly supersedes the older pin observation');
  assert.equal(psql(fixture,'select playtime_minutes is null from app.library_games where account_id=1 and game_id=1',true),'t');
});

test('V2 catalogue outbox drains with leases, stale fences and preserved authored/HLTB facts',async t=>{
  const {CatalogueWorkerRepository,fetchCatalogueMetadata}=await import('../import/catalogue-worker-core.ts');
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_catalogue_runtime login;grant vault_worker to vault_catalogue_runtime with inherit true,set false;
    delete from ops.enrichment_outbox;
    insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind) values('steam_store',5,0,'owned_identity');
    update catalog.games set title='Curated Name',title_source='curated' where id=5;
    update catalog.game_features set duration_source='hltb',duration_source_game_id=99,duration_manual_override=true where game_id=5;`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_catalogue_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());
  const repository=new CatalogueWorkerRepository(worker,Date.now()+60000);
  const transport=(data:Record<string,unknown>)=>(async()=>Response.json({'100005':{success:true,data:{steam_appid:100005,name:'New Steam Title',type:'game',is_free:false,
    genres:[{description:'Adventure'}],categories:[{description:'Family Sharing'}],platforms:{windows:true},price_overview:{currency:'USD',initial:1000,final:750,discount_percent:25},...data}}})) as typeof fetch;
  const result=await fetchCatalogueMetadata('100005',transport({}),AbortSignal.timeout(5000));
  assert.equal(result.status,'complete');
  if(result.status!=='complete')throw Error('fixture');
  result.details.reviewTotal=100;result.details.reviewPositive=80;result.details.deckCategory=3;
  await t.test('disabled provider cannot claim; worker/app have only their intended access',async()=>{
    assert.equal(await repository.claim(),null);
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.claim_catalogue_metadata()','EXECUTE')",true),'f');
    assert.equal(psql(fixture,"select has_table_privilege('vault_worker','catalog.game_metadata','UPDATE')",true),'f');
    assert.equal(psql(fixture,"select has_function_privilege('vault_worker','ops.finish_catalogue_metadata_v1(bigint,uuid,jsonb)','EXECUTE')",true),'f');
    await assert.rejects(worker.sql`select * from app.game_state`,error=>(error as {code:string}).code==='42501');
  });
  psql(fixture,"update ops.provider_controls set mode='live' where provider='steam_store'");
  await t.test('one live lease; publication/replay preserve private state, HLTB and curated title',async()=>{
    const claim=await repository.claim();assert.ok(claim);assert.equal(claim.steam_app_id,'100005');assert.equal(await repository.claim(),null);
    assert.equal(claim.known_deck,null);
    assert.equal(await repository.finish(claim,result),'published');assert.equal(await repository.finish(claim,result),'replayed');
    assert.equal(psql(fixture,"select title from catalog.games where id=5",true),'Curated Name');
    assert.equal(psql(fixture,"select main_duration_minutes||':'||duration_source||':'||duration_source_game_id||':'||duration_manual_override from catalog.game_features where game_id=5",true),'600:hltb:99:true');
    assert.equal(psql(fixture,"select notes from app.game_state where account_id=1 and game_id=5",true),'A retained private note');
    assert.equal(psql(fixture,"select genres->>0 from catalog.game_metadata where game_id=5",true),'Adventure');
    assert.equal(psql(fixture,"select count(*) from catalog.offer_prices where is_current",true),'1','replay writes no additional offer history');
    assert.equal(psql(fixture,"select review_total||':'||review_positive||':'||review_negative||':'||deck_compatibility_detail||':'||deck_compatibility from catalog.game_features where game_id=5",true),'100:80:20:3:supported');
  });
  const queue=()=>psql(fixture,"delete from ops.enrichment_outbox;insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind) values('steam_store',5,0,'metadata')");
  await t.test('scheduled Deck refreshes replace known ratings, including Unknown, and replay stays fenced',async()=>{
    for(const category of [2,1,0,3]) {
      queue();const claim=await repository.claim();assert.ok(claim);
      const refresh: typeof result={...result,details:{...result.details,deckCategory:category}};
      assert.equal(await repository.finish(claim,refresh),'published');
      const checked=psql(fixture,"select deck_checked_at from catalog.game_features where game_id=5",true);
      assert.equal(await repository.finish(claim,refresh),'replayed');
      assert.equal(psql(fixture,"select deck_checked_at from catalog.game_features where game_id=5",true),checked);
      assert.equal(psql(fixture,"select deck_compatibility_detail||':'||deck_compatibility from catalog.game_features where game_id=5",true),`${category}:${category>=2?'supported':category===1?'unsupported':'unknown'}`);
    }
  });
  await t.test('optional failures preserve reviews/Deck; invalid signal bundles cannot publish',async()=>{
    queue();const claim=await repository.claim();assert.ok(claim);assert.equal(claim.known_deck,3);
    for(const fields of [{reviewTotal:10,reviewPositive:11},{reviewTotal:null,reviewPositive:1},{deckCategory:4}])
      await assert.rejects(repository.finish(claim,{...result,details:{...result.details,...fields}}),error=>(error as {code:string}).code==='22023');
    assert.equal(await repository.finish(claim,{...result,details:{...result.details,reviewTotal:null,reviewPositive:null,deckCategory:null}}),'published');
    assert.equal(psql(fixture,"select review_total||':'||deck_compatibility_detail from catalog.game_features where game_id=5",true),'100:3');
  });
  await t.test('expired attempt cannot publish; an independent newer revision fences stale metadata',async()=>{
    queue();const expired=await repository.claim();assert.ok(expired);
    psql(fixture,"update ops.enrichment_outbox set lease_expires_at=clock_timestamp()-interval '1 second'");
    assert.equal(await repository.finish(expired,result),'stale');
    const fresh=await repository.claim();assert.ok(fresh);assert.notEqual(fresh.lease_token,expired.lease_token);
    assert.equal(await repository.finish(expired,result),'stale');
    psql(fixture,'update catalog.game_features set feature_revision=feature_revision+1 where game_id=5');
    assert.equal(await repository.finish(fresh,result),'stale');
  });
  await t.test('manual allowed decision survives automatic exclusion; unavailable replies preserve catalogue',async()=>{
    queue();psql(fixture,`insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,source,precedence_rank,decision_status,created_at,updated_at)
      values(5,100005,'quarantine','catalog_game_quarantine','100005','manual',100,'allowed',now(),now());`);
    const claim=await repository.claim();assert.ok(claim);
    const excluded=await fetchCatalogueMetadata('100005',transport({type:'demo'}),AbortSignal.timeout(5000));
    assert.equal(await repository.finish(claim,excluded),'published');
    assert.equal(psql(fixture,"select decision_status from catalog.review_decisions where game_id=5",true),'allowed');
    queue();const missing=await repository.claim();assert.ok(missing);
    assert.equal(await repository.finish(missing,{appId:'100005',status:'unavailable'}),'retryable');
    assert.equal(psql(fixture,"select genres->>0 from catalog.game_metadata where game_id=5",true),'Adventure');
  });
  await t.test('429 blocks fresh queues too; bounded failures become terminal',async()=>{
    queue();const claim=await repository.claim();assert.ok(claim);
    assert.equal(await repository.finish(claim,{appId:'100005',status:'retryable',rateLimited:true}),'retryable');
    queue();assert.equal(await repository.claim(),null);
    psql(fixture,"delete from ops.abuse_cooldowns where bucket='catalogue_store_pause';update ops.enrichment_outbox set attempt=4");
    const last=await repository.claim();assert.ok(last);
    assert.equal(await repository.finish(last,{appId:'100005',status:'invalid'}),'failed');assert.equal(await repository.claim(),null);
  });
  await t.test('ordinary runtime cannot forge a worker summary; worker counts use existing bounded retention',async()=>{
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.record_worker_run(text,timestamptz,jsonb,boolean)','EXECUTE')",true),'f');
    await worker.sql`select ops.record_worker_run('catalogue-metadata',clock_timestamp(),'{}'::jsonb,false)`;
    assert.equal(psql(fixture,"select count(*) from ops.legacy_worker_runs where retention_until=started_at+interval '14 days'",true),'1');
  });
});

test('V2 background refresh reuses real owners, quota and existing Family access without fabricated sessions',async t=>{
  const {BackgroundWorkerRepository,runScheduledPins}=await import('../import/background-worker-core.ts');
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_background_runtime login;grant vault_worker to vault_background_runtime with inherit true,set false;
    insert into app.steam_profiles(account_id,steam_id) values(1,76561198000000001),(2,76561198000000002),(3,76561198000000003);`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_background_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());const repository=new BackgroundWorkerRepository(worker,Date.now()+60000);
  await t.test('disabled scheduling costs no job; active owner queue coalesces and rotates',async()=>{
    assert.equal(await repository.scheduleOwned(20),0);
    psql(fixture,"update ops.provider_controls set mode='live' where provider='steam';update app.accounts set lifecycle_status='deleted' where id=3");
    assert.equal(await repository.scheduleOwned(20),2);assert.equal(await repository.scheduleOwned(20),0);
    assert.equal(psql(fixture,"select count(*) from ops.jobs where lane='background' and status='enqueued'",true),'2');
    assert.equal(psql(fixture,"select count(*) from ops.provider_call_charges",true),'0','scheduling cannot spend keyed API quota');
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.schedule_owned_refresh(integer)','EXECUTE')",true),'f');
    psql(fixture,"delete from ops.job_requests;delete from ops.jobs;update app.library_sync_state set in_flight_job_id=null,active_request_key=null");
  });
  await t.test('scheduled pins make only filtered per-pin calls and retain unpinned playtime',async()=>{
    let calls=0;
    const totals=await runScheduledPins(repository,{apiKey:'fixture-key',deadlineAt:Date.now()+30000,fetch:async input=>{
      calls++;const query=new URL(String(input)).searchParams;assert.equal(query.has('steamid'),false);
      const filter=JSON.parse(query.get('input_json')!);assert.equal(filter.appids_filter.length,1);
      assert.equal(filter.include_appinfo,false);assert.equal(filter.steamid,'76561198000000001');
      return Response.json({response:{games:[{appid:filter.appids_filter[0],playtime_forever:120}]}});
    }});
    assert.equal(calls,3);assert.equal(totals.pinsUpdated,3);
    assert.equal(psql(fixture,'select playtime_minutes from app.library_games where account_id=1 and game_id=1',true),'120');
    assert.equal(psql(fixture,'select playtime_minutes from app.library_games where account_id=1 and game_id=4',true),'8');
    assert.equal((await repository.pinTargets(150)).length,0,'charged pins rotate out for the daily window');
    assert.equal(psql(fixture,"select count(*) from ops.jobs",true),'0','pin refresh cannot enqueue a full import');
    assert.equal(psql(fixture,"select count(*) from ops.provider_call_charges where endpoint='pinned'",true),'3');
    assert.equal(String((await worker.sql`select current_setting('app.account_id',true) value`)[0].value??''),'','worker context is transaction-local');
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.publish_scheduled_pin(uuid,uuid,jsonb)','EXECUTE')",true),'f');
  });
  await t.test('scheduled publish rejects replaced ownership and wrong attempt tokens',async()=>{
    const attempt=await repository.reservePin(1,1);assert.ok(attempt);
    assert.equal(await repository.publishPin({...attempt,attemptToken:'11111111-1111-4111-8111-111111111111'},999,null),false);
    psql(fixture,'delete from app.library_games where account_id=1 and game_id=1');
    assert.equal(await repository.publishPin(attempt,999,null),false);
    assert.equal(psql(fixture,'select count(*) from app.library_games where account_id=1 and game_id=1',true),'0');
  });
  await t.test('background backpressure caps the whole pending cohort at twenty',async()=>{
    psql(fixture,`insert into app.accounts(id,public_id,account_kind,display_name) overriding system value
      select id,gen_random_uuid(),'manual','Synthetic scheduler' from generate_series(4,30) id;
      insert into app.steam_profiles(account_id,steam_id) select id,76561198000000000+id from generate_series(4,30) id;`);
    assert.equal(await repository.scheduleOwned(150),20);assert.equal(await repository.scheduleOwned(150),0);
    assert.equal(psql(fixture,"select count(*) from ops.jobs where lane='background' and status='enqueued'",true),'20');
  });
  await t.test('shared metadata admits a Family candidate through the existing reducer and clears stale-only work',async()=>{
    psql(fixture,`update app.family_members set candidate_app_ids='[101006]',candidate_count=1,checked_at='2026-01-01' where id=11;
      update app.family_members set candidate_app_ids='[]',candidate_count=0,checked_at=clock_timestamp() where id=12;
      delete from app.family_game_access where account_id=1;
      update catalog.game_metadata set categories='["Family Sharing"]',fetched_at=clock_timestamp() where game_id=1006;`);
    assert.equal(await repository.refreshFamily(),1);assert.equal(await repository.refreshFamily(),0);
    assert.equal(psql(fixture,'select count(*) from app.family_game_access where account_id=1 and game_id=1006',true),'1');
    assert.equal(psql(fixture,'select count(*) from app.library_games where account_id=1 and game_id=1006',true),'0','Family admission never invents personal ownership/playtime');
    assert.equal(psql(fixture,"select notes from app.game_state where account_id=1 and game_id=5",true),'A retained private note');
  });
});

test('V2 tag publication preserves source precedence, human lengths and durable replay fences',async t=>{
  const {TagWorkerRepository,fetchCatalogueTags,runEndlessSweep}=await import('../import/tag-worker-core.ts');
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,"create role vault_tags_runtime login;grant vault_worker to vault_tags_runtime with inherit true,set false;update ops.provider_controls set mode='live' where provider in('steam_store','steamspy')");
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_tags_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());const repository=new TagWorkerRepository(worker,Date.now()+60000);
  const queue=(provider:string)=>psql(fixture,`delete from ops.enrichment_outbox;insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind) values('${provider}',5,0,'tags')`);
  const page=(appid:string,tags:unknown[])=>`<div class="apphub_AppName">Fixture</div><script>InitAppTagModal(${appid}, ${JSON.stringify(tags)}, []);</script>`;
  await t.test('real parser and explicit source attribution publish/replay without clearing HLTB minutes',async()=>{
    queue('steam_store');const claim=await repository.claim('steam_store');assert.ok(claim);
    const result=await fetchCatalogueTags(claim,'steam_store',async()=>new Response(page(claim.steam_app_id,[{name:'MMORPG',count:100}])),AbortSignal.timeout(5000));
    assert.equal(result.status,'complete');if(result.status==='complete')assert.equal(result.promoteEndless,true);
    assert.equal(await repository.finish(claim,result),'published');assert.equal(await repository.finish(claim,result),'replayed');
    assert.equal(psql(fixture,"select tags_source||':'||duration_kind||':'||main_duration_minutes from catalog.game_features where game_id=5",true),'steam-store:endless:600');
    assert.equal(psql(fixture,"select weighted_tags->0->>'tag' from catalog.game_metadata where game_id=5",true),'MMORPG');
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.claim_catalogue_tags(text)','EXECUTE')",true),'f');
    assert.equal(psql(fixture,"select has_function_privilege('vault_worker','ops._claim_catalogue_work(text,text)','EXECUTE')",true),'f');
  });
  await t.test('SteamSpy cannot take back Store tags, including a good Spy response',async()=>{
    queue('steamspy');const claim=await repository.claim('steamspy');assert.ok(claim);
    const result=await fetchCatalogueTags(claim,'steamspy',async()=>Response.json({appid:Number(claim.steam_app_id),tags:{Action:100}}),AbortSignal.timeout(5000));
    assert.equal(await repository.finish(claim,result),'published');
    assert.equal(psql(fixture,"select weighted_tags->0->>'tag' from catalog.game_metadata where game_id=5",true),'MMORPG');
    assert.equal(await repository.queue('steamspy',200),200,'other eligible games are queued');
    assert.equal(psql(fixture,"select count(*) from ops.enrichment_outbox where game_id=5 and status='pending'",true),'0','Store-owned games stay off the Spy refresh clock');
  });
  await t.test('no-tags or unavailable Store response retains existing weighted tags and records its own check',async()=>{
    queue('steam_store');const claim=await repository.claim('steam_store');assert.ok(claim);
    const result=await fetchCatalogueTags(claim,'steam_store',async()=>new Response('<div class="apphub_AppName">Fixture</div>'),AbortSignal.timeout(5000));
    assert.equal(await repository.finish(claim,result),'published');
    assert.equal(psql(fixture,"select weighted_tags->0->>'tag' from catalog.game_metadata where game_id=5",true),'MMORPG');
    assert.equal(psql(fixture,"select store_tags_state from catalog.game_features where game_id=5",true),'no_tags');
  });
  await t.test('human duration override blocks an otherwise decisive promotion; private state is untouched',async()=>{
    queue('steam_store');psql(fixture,"update catalog.game_features set duration_kind='finite',duration_source='hltb',duration_manual_override=true where game_id=5");
    const claim=await repository.claim('steam_store');assert.ok(claim);
    const result=await fetchCatalogueTags(claim,'steam_store',async()=>new Response(page(claim.steam_app_id,[{name:'MMORPG',count:100}])),AbortSignal.timeout(5000));
    if(result.status==='complete')assert.equal(result.promoteEndless,false);
    assert.equal(await repository.finish(claim,result),'published');
    assert.equal(psql(fixture,"select duration_kind||':'||duration_source from catalog.game_features where game_id=5",true),'finite:hltb');
    assert.equal(psql(fixture,"select notes from app.game_state where account_id=1 and game_id=5",true),'A retained private note');
  });
  await t.test('bounded endless sweep covers independent HLTB changes and keeps numeric time',async()=>{
    psql(fixture,"update catalog.game_features set duration_manual_override=false,duration_source='hltb',duration_kind='finite',updated_at=clock_timestamp() where game_id=5");
    const sweep=await runEndlessSweep(repository,Date.now()+30000);
    assert.ok(sweep.examined<=10000);assert.ok(sweep.promoted>=1);
    assert.equal(psql(fixture,"select duration_kind||':'||main_duration_minutes from catalog.game_features where game_id=5",true),'endless:600');
    assert.equal((await repository.endlessCandidates(0)).some(row=>row.game_id===5),false,'already endless rows are not re-promoted');
  });
  await t.test('replacement page IDs and changed revisions cannot rewrite catalogue tags',async()=>{
    queue('steam_store');const claim=await repository.claim('steam_store');assert.ok(claim);
    const replacement=await fetchCatalogueTags(claim,'steam_store',async()=>new Response(page('9',[{name:'Action',count:10}])),AbortSignal.timeout(5000));
    if(replacement.status==='complete')assert.equal(replacement.state,'unavailable');
    const good=await fetchCatalogueTags(claim,'steam_store',async()=>new Response(page(claim.steam_app_id,[{name:'RPG',count:10}])),AbortSignal.timeout(5000));
    psql(fixture,'update catalog.game_features set feature_revision=feature_revision+1 where game_id=5');
    assert.equal(await repository.finish(claim,good),'stale');
    assert.equal(psql(fixture,"select weighted_tags->0->>'tag' from catalog.game_metadata where game_id=5",true),'MMORPG');
  });
  await t.test('preserved underscore Store source spelling remains on the Store refresh clock',async()=>{
    psql(fixture,"delete from ops.enrichment_outbox;update catalog.game_features set store_tags_checked_at=clock_timestamp();update catalog.game_features set tags_source='steam_store',store_tags_checked_at='2020-01-01' where game_id=5");
    assert.equal(await repository.queue('steam_store',200),1);
    assert.equal(psql(fixture,"select game_id from ops.enrichment_outbox where provider='steam_store' and kind='tags'",true),'5');
  });

});

test('V2 live learning atomically replaces current aggregates while preserving warm start and tenant privacy',async t=>{
  const {readLearningInputs,rebuildV2Learning}=await import('../import/learning-worker-core.ts');
  const {playtimeTally}=await import('../../genre-preferences.ts');
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_learning_runtime login;grant vault_worker to vault_learning_runtime with inherit true,set false;
    insert into reco.warm_start_snapshots(id,snapshot_key,snapshot_version,status,frozen_at) overriding system value values(41,'imported-evidence',1,'frozen','2026-01-01');
    insert into reco.user_genre_preferences(snapshot_id,account_id,source_user_id,genre,mood,positive,total)
      values(41,2,'22222222-2222-4222-8222-222222222222','preserved-warm-start','any',3,4);
    insert into app.vault_draws(id,public_id,account_id,game_id,steam_app_id,drawn_at,mood,eligible_pool_count,reroll_index) overriding system value
      values(1,'12345678-1234-4234-8234-123456789141',1,5,100005,clock_timestamp(),'chill',1000,0);
    insert into app.vault_draw_events(public_id,account_id,draw_id,event_type,occurred_at) values
      ('12345678-1234-4234-8234-123456789142',1,1,'disliked',clock_timestamp()),
      ('12345678-1234-4234-8234-123456789143',1,1,'drew_again',clock_timestamp());`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_learning_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());
  await t.test('worker projections distinguish real zero, unknown and Family evidence; boolean Blacklist has no date',async()=>{
    const inputs=await readLearningInputs(worker,Date.now()+60000);
    const blocked=inputs.decisions.find(row=>row.steamAppId===100011)!;assert.equal(blocked.action,'blacklist');assert.equal(blocked.reviewedAt,null);
    assert.equal(inputs.playtime.some(row=>Number(row.steam_app_id)===100001),false,'NULL time is never observed zero');
    assert.equal(inputs.playtime.some(row=>Number(row.steam_app_id)===101006),false,'lender-only time is not personal');
    const zero=inputs.playtime.find(row=>Number(row.steam_app_id)===100002)!;assert.equal(Number(zero.unplayed),1);assert.equal(Number(zero.launched),0);
    for(const id of [2,3,1005]) {
      const entry=inputs.playtime.find(row=>Number(row.steam_app_id)===100000+id)!;
      const expected=playtimeTally(id===2?0:id*2/60,0.5,0.25);
      assert.ok(Math.abs(Number(entry.endorsements)*0.5-expected.positive)<1e-10);
      assert.ok(Math.abs(Number(entry.launched)*0.5+Number(entry.unplayed)*0.25-expected.total)<1e-10);
    }
    psql(fixture,"insert into app.account_capabilities(account_id,playtime_visibility) values(2,'hidden')");
    assert.equal((await readLearningInputs(worker,Date.now()+60000)).playtime.some(row=>Number(row.steam_app_id)===101150),false,'explicit hidden time is not population evidence');
    assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.learning_outcomes(bigint,integer)','EXECUTE')",true),'f');
  });
  await t.test('current explicit opinions are learned once, and the existing Vault reads the new aggregate',async()=>{
    const summary=await rebuildV2Learning(worker,Date.now()+60000);assert.equal(summary.stale,false);assert.equal(summary.scoredEvents,1);
    assert.ok(summary.rows>0);assert.ok(summary.gameRows>0);
    assert.equal(psql(fixture,"select count(*) from reco.user_genre_preferences where snapshot_id=41 and genre='preserved-warm-start'",true),'1');
    assert.equal(psql(fixture,"select snapshot_key from reco.warm_start_snapshots where status='frozen' order by frozen_at desc,id desc limit 1",true),'live-learning');
    const preview=await new VaultRepository(fixture.database).preview(ACCOUNT_A,{session:null,mood:null,goal:null,collectionId:null,genres:[],deferredIds:[],globalFilters:DEFAULT_GLOBAL_FILTERS});
    assert.ok(preview.preferenceRowCount>0);
    const own=await fixture.database.withPrincipal(ACCOUNT_A,tx=>tx<{account_id:number}[]>`select account_id from reco.user_genre_preferences`);
    assert.ok(own.length>0);assert.ok(own.every(row=>row.account_id===1));
  });
  await t.test('reactivation removes its standing negative; later rebuild uses one live snapshot',async()=>{
    const before=Number(psql(fixture,"select total from reco.game_preference_globals where snapshot_id=(select id from reco.warm_start_snapshots where snapshot_key='live-learning') and steam_app_id=100011",true));
    psql(fixture,'update app.game_state set blacklisted=false where account_id=1 and game_id=11');
    await rebuildV2Learning(worker,Date.now()+60000);
    const after=Number(psql(fixture,"select total from reco.game_preference_globals where snapshot_id=(select id from reco.warm_start_snapshots where snapshot_key='live-learning') and steam_app_id=100011",true));
    assert.ok(Math.abs(before-after-4)<1e-8);assert.equal(psql(fixture,"select count(*) from reco.warm_start_snapshots where snapshot_key='live-learning'",true),'1');
    assert.equal(psql(fixture,"select count(*) from information_schema.columns where table_schema='app' and table_name='game_state' and column_name ~ '(sleep|blacklist).*(_at|expiry)'",true),'0');
  });
  await t.test('one bulk-authored account remains capped at fifty standing outcomes',async()=>{
    psql(fixture,`insert into app.game_state(account_id,game_id,blacklisted) select 1,id,true from generate_series(101,200) id
      on conflict(account_id,game_id) do update set blacklisted=true;`);
    const summary=await rebuildV2Learning(worker,Date.now()+60000);
    assert.equal(summary.libraryDecisions,50);
  });
  await t.test('failed publication rolls back all deletes; an older run cannot replace newer evidence',async()=>{
    const fingerprint=()=>psql(fixture,"select md5(string_agg(to_jsonb(p)::text,',' order by account_id,genre,mood)) from reco.user_genre_preferences p where snapshot_id=(select id from reco.warm_start_snapshots where snapshot_key='live-learning')",true);
    const before=fingerprint();
    await assert.rejects(worker.sql`select ops.publish_live_learning(clock_timestamp(),
      '[{"user_id":"11111111-1111-4111-8111-111111111111","genre":"bad","context_mood":"any","positive":2,"total":1}]'::jsonb,'[]'::jsonb)`,error=>(error as {code:string}).code==='23514');
    assert.equal(fingerprint(),before);
    const stale=await worker.sql`select ops.publish_live_learning(clock_timestamp()-interval '1 minute','[]'::jsonb,'[]'::jsonb) id`;
    assert.equal(stale[0].id,null);assert.equal(fingerprint(),before);
  });
});


test('V2 full publication captures bounded UTC daily facts without replay or hidden zeros',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_daily_runtime login;grant vault_worker to vault_daily_runtime with inherit true,set false;
    insert into app.steam_profiles(account_id,steam_id) values(3,76561198000000003);
    update ops.provider_controls set mode='live' where provider='steam';`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_daily_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());
  const invoke=createOwnedWorkerInvoker(worker),imports=new ImportRepository(fixture.database);
  let request=0;
  async function publish(games:Record<string,unknown>[]) {
    psql(fixture,"delete from ops.abuse_cooldowns where account_id=3;update ops.provider_token_buckets set tokens=capacity;");
    const queued=await imports.request(EMPTY_ACCOUNT,`11111111-1111-4111-8111-${String(++request).padStart(12,'0')}`,'daily-fixture');
    await runOwnedWorkerBatch({sql:invoke,apiKey:'synthetic-key',fetch:async()=>Response.json({response:{game_count:games.length,games}}),
      nowEpochSeconds:()=>Math.floor(Date.now()/1000),lane:'interactive',maxJobs:1});
    return queued.jobId!;
  }
  const job=await publish([{appid:100005,name:'Known',playtime_forever:10},{appid:100006,name:'True zero',playtime_forever:0}]);
  const day=psql(fixture,`select (body_observed_at at time zone 'UTC')::date from ops.jobs where id='${job}'`,true);
  assert.equal(psql(fixture,"select coverage||':'||observed_minutes||':'||games_with_playtime from app.playtime_daily where account_id=3",true),'complete:10:1');
  const before=psql(fixture,'select row_to_json(d) from app.playtime_daily d where account_id=3',true);
  await publish([{appid:100005,name:'Known'},{appid:100006,name:'True zero'}]);
  assert.equal(psql(fixture,'select row_to_json(d) from app.playtime_daily d where account_id=3',true),before,'hidden body cannot fabricate or replace daily history');
  await publish([{appid:100005,name:'Known',playtime_forever:20},{appid:100006,name:'True zero'}]);
  assert.equal(psql(fixture,'select row_to_json(d) from app.playtime_daily d where account_id=3',true),before,'partial newer sample cannot replace complete coverage');
  await publish([{appid:100005,name:'Known',playtime_forever:25},{appid:100006,name:'True zero',playtime_forever:0}]);
  assert.equal(psql(fixture,"select coverage||':'||observed_minutes||':'||games_with_playtime from app.playtime_daily where account_id=3",true),'complete:25:1');
  assert.equal(psql(fixture,'select activity_day from app.playtime_daily where account_id=3',true),day);
  assert.equal(psql(fixture,'select count(*) from app.playtime_daily where account_id=3',true),'1');
  assert.equal(psql(fixture,"select has_function_privilege('vault_app','ops.publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamptz,bigint)','EXECUTE')",true),'f');
});

test('V2 ordinary reads keep a 10,000-game owned library bounded',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`insert into catalog.games(id,steam_app_id,title,normalized_sort_title,lifecycle_status)
    overriding system value select id,2000000000+id,'Large game '||id,'large game '||id,'active' from generate_series(20000,29999) id;
    insert into catalog.game_metadata(game_id,genres,weighted_tags,categories)
    select id,'["Strategy"]','[{"tag":"Strategy","weight":100},{"tag":"Tactical","weight":55}]','["Single-player"]' from generate_series(20000,29999) id;
    insert into catalog.game_features(game_id,duration_kind,main_duration_minutes,duration_source,player_mode)
    select id,'finite',600,'hltb','single' from generate_series(20000,29999) id;
    insert into app.library_games(account_id,game_id,playtime_minutes) select 3,id,60 from generate_series(20000,29999) id;`);
  const timings:Record<string,number>={};
  async function measured<T>(name:string,operation:()=>Promise<T>) {const start=performance.now();const value=await operation();timings[name]=Math.round(performance.now()-start);return value;}
  const boot=await measured('bootstrap',()=>fixture.bootstrap.read(EMPTY_ACCOUNT));assert.equal(boot.ownedTotal,10000);assert.ok(JSON.stringify(boot).length<15000);
  const first=await measured('library',()=>fixture.library.list(EMPTY_ACCOUNT,{limit:60,section:'all',sort:'title',direction:'asc'}));
  assert.equal(first.total,10000);assert.equal(first.items.length,60);assert.ok(first.nextCursor);assert.ok(JSON.stringify(first).length<160000);
  const second=await fixture.library.list(EMPTY_ACCOUNT,{limit:60,section:'all',sort:'title',direction:'asc',cursor:first.nextCursor!});
  assert.ok(!second.items.some(x=>first.items.some(y=>y.gameId===x.gameId)));
  const dashboard=await measured('dashboard',()=>fixture.dashboard.read(EMPTY_ACCOUNT));assert.equal(dashboard.aggregates.ownedGames,10000);assert.equal(dashboard.aggregates.totalMinutes,600000);
  assert.ok(dashboard.cards.length<=17);assert.ok(JSON.stringify(dashboard).length<60000);
  const vault=await measured('vault',()=>new VaultRepository(fixture.database).preview(EMPTY_ACCOUNT,{session:null,mood:null,goal:null,collectionId:null,genres:[],globalFilters:DEFAULT_GLOBAL_FILTERS,deferredIds:[]}));
  assert.equal(vault.poolTotal,10000);assert.ok(vault.deck.length<=64);assert.ok(JSON.stringify(vault).length<200000);
  t.diagnostic(JSON.stringify({owned:10000,timings}));
});


test('V2 Wishlist discovery retains four lanes, HLTB and private quarantine boundaries',async t=>{
  const {WishlistDiscoveryRepository}=await import('./wishlist-discovery-core.ts');
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`update catalog.games set game_type='game';
    update catalog.game_metadata set genres='["Adventure"]',weighted_tags='[{"tag":"Adventure","weight":9}]',header_image_url='https://example.invalid/public-game.jpg';
    update catalog.game_features set duration_kind='finite',main_duration_minutes=300,review_total=1000,review_positive=900;
    update catalog.games set lifecycle_status='retired' where id=7;
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,source,precedence_rank,decision_status,created_at,updated_at)
      values(6,100006,'quarantine','catalog_game_quarantine','wishlist-fixture','manual',100,'excluded',now(),now());`);
  const rows=await new WishlistDiscoveryRepository(fixture.database).list();
  assert.ok(rows.length>=200);
  assert.equal(rows.some(row=>[100006,100007,101105].includes(row.steam_appid)),false);
  assert.equal(rows[0].main_story_minutes,300);
  assert.deepEqual(rows[0].tags,{Adventure:9});
  assert.equal(Object.keys(rows[0]).some(key=>/account|user|notes|session/.test(key)),false);
  assert.equal(psql(fixture,"select count(*) from catalog.wishlist_discovery_candidates('not-a-lane')",true),'0');
  assert.equal(psql(fixture,"select has_function_privilege('vault_worker','catalog.wishlist_discovery_candidates(text)','EXECUTE')",true),'f');
  assert.equal(psql(fixture,"select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='catalog.wishlist_discovery_candidates(text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')",true),'f');
  await assert.rejects(fixture.database.sql`select * from catalog.review_decisions`);
});

test('V2 public blog catalogue keeps bounded filters, tags and quarantine without tenant access',async t=>{
  const {BlogRepository}=await import('./blog-core.ts');const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`update catalog.game_features set duration_kind='finite',main_duration_minutes=300,completion_duration_minutes=600,
    deck_compatibility_detail=3,review_total=1000,review_positive=900,player_mode='single' where game_id in(5,6);
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,source,precedence_rank,decision_status,created_at,updated_at) values(6,100006,'quarantine','catalog_game_quarantine','blog-fixture','manual',100,'excluded',now(),now());`);
  const blog=new BlogRepository(fixture.database);
  const rows=await blog.rows({deck:'verified',durationKind:'finite',mainStoryHours:[2,10],minReviews:500,playerMode:'single',tag:'Strategy'},40,true);
  assert.equal(rows.length,1);assert.equal(rows[0].steam_appid,100005);assert.equal(rows[0].main_story_minutes,300);
  assert.equal(rows[0].deck_compatibility,3);assert.equal(rows[0].review_positive,900);assert.deepEqual(rows[0].tags,{Strategy:9,Tactical:4});
  assert.equal((await blog.rows({deck:'verified'},1,true)).length,1);
  assert.equal((await blog.rows({mainStoryHours:[6,10]},40,true)).some(x=>x.steam_appid===100005),false);
  const picks=await blog.rows({},10,false,[100005,100006]);assert.deepEqual(picks.map(x=>x.steam_appid),[100005]);assert.equal(picks[0].tags,undefined);
  assert.deepEqual(await blog.rows({},1,false,[]),[]);
  await assert.rejects(blog.rows({},2001,false),InvalidPageQueryError);
  assert.equal(psql(fixture,"select has_function_privilege('vault_worker','catalog.blog_game_candidates(bigint[],integer,integer,text,integer,integer,text,integer,boolean,boolean)','EXECUTE')",true),'f');
  assert.equal(psql(fixture,"select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='catalog.blog_game_candidates(bigint[],integer,integer,text,integer,integer,text,integer,boolean,boolean)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')",true),'f');
  await assert.rejects(fixture.database.sql`select * from catalog.review_decisions`);
});


test('V2 duration review stays private and records evidence without changing duration',async t=>{
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`create role vault_duration_runtime login;
    grant vault_worker to vault_duration_runtime with inherit true,set false;
    update catalog.game_features set main_duration_minutes=null,extras_duration_minutes=null,
      completion_duration_minutes=null,duration_kind='unknown',duration_status='unknown';
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,
      source,precedence_rank,decision_status,created_at,updated_at)
      values(6,100006,'quarantine','catalog_game_quarantine','100006','manual',100,'excluded',now(),now());`);
  const worker=createDatabaseClient(parseDatabaseConfig({connectionString:`postgres://vault_duration_runtime@localhost:${fixture.port}/vault_m4_read`,socketPath:fixture.socket,maxConnections:1}));
  t.after(()=>worker.close());
  const queue=async()=> (await worker.sql<{queue:{total:number;remaining:number;games:{steam_appid:number}[]}}[]>`select catalog.duration_review_queue() queue`)[0].queue;
  const before=await queue();assert.ok(before.games.length>0&&before.games.length<=100);
  await assert.rejects(fixture.database.sql`select catalog.duration_review_queue()`);
  await assert.rejects(worker.sql`select * from catalog.review_decisions`);
  const snapshot=psql(fixture,'select row_to_json(f)::text from catalog.game_features f where game_id=5',true);
  await worker.sql`select catalog.save_duration_review(100005,'https://howlongtobeat.com/game/123','hltb_url','https://howlongtobeat.com/game/123')`;
  assert.equal((await queue()).remaining,before.remaining-1);
  assert.equal(psql(fixture,'select row_to_json(f)::text from catalog.game_features f where game_id=5',true),snapshot);
  await assert.rejects(worker.sql`select catalog.save_duration_review(100005,'duplicate','note',null)`);
  await assert.rejects(worker.sql`select catalog.save_duration_review(100004,'bad','hltb_url','https://evil.invalid/game/123')`);
  await worker.sql`select catalog.undo_duration_review(100005)`;
  assert.equal((await queue()).remaining,before.remaining);
  assert.equal(psql(fixture,"select count(*) from catalog.review_decisions where decision_kind='quarantine'",true),'1');
  await worker.sql`select catalog.save_duration_review(100005,'Owner note','note',null)`;
  assert.equal(psql(fixture,"select response_text from catalog.review_decisions where source_relation='catalog_duration_reviews' and steam_app_id=100005",true),'Owner note');
});


test('V2 reviewed HLTB writeback preserves overrides, quarantine, identity conflicts and freshness',async t=>{
  const {buildHltbWritebackSql}=await import(new URL('../../../scripts/durations/build-hltb-writeback-sql.mjs',import.meta.url).href);
  const fixture=createFixture();t.after(()=>disposeFixture(fixture));
  psql(fixture,`update catalog.game_features set duration_kind='unknown',duration_status='unknown',
    main_duration_minutes=null,extras_duration_minutes=null,completion_duration_minutes=null;
    update catalog.game_features set duration_kind='endless' where game_id=3;
    update catalog.game_features set duration_manual_override=true,main_duration_minutes=42 where game_id=4;
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,
      source,precedence_rank,decision_status,created_at,updated_at)
      values(6,100006,'quarantine','catalog_game_quarantine','100006','manual',100,'excluded',now(),now());`);
  function row(appId:number,overrides:Record<string,unknown>={}) {return {
    steam_appid:appId,provider:'hltb',provider_game_id:appId+10,status:'verified_matched',
    verification_status:'verified_matched',match_status:'matched',verification_method:'profile_steam_exact',
    verification_tier:'steam_appid',identity_tier:'steam_appid',identity_confidence:'high',
    duration_basis:'completion_times',duration_issues:[],hltb_modes:{single_player:true,co_op:false,multiplayer:false},
    main_story_minutes:600,main_extra_minutes:900,completionist_minutes:1200,submission_count:20,
    match_confidence:'high',checked_at:'2026-10-01T00:00:00.000Z',...overrides};}
  function apply(results:Record<string,unknown>[],rejections:Record<string,unknown>[]=[]) {
    psql(fixture,buildHltbWritebackSql({schema_version:1,source:'HLTB candidates verified against detail-page identity evidence',
      state:'complete',updated_at:'2026-10-01T01:00:00.000Z',options:{allow_safe_title:false},
      counts:{unique_detail_pages:results.length+rejections.length,completed_detail_pages:results.length+rejections.length,
        verified_matched:results.filter(r=>r.verification_status==='verified_matched').length,
        verified_no_duration:results.filter(r=>r.verification_status==='verified_no_duration').length,rejections:rejections.length,errors:0},
      results,rejections,errors:[]},{target:'v2',batchSize:2}));
  }
  apply([row(100001),row(100002,{status:'verified_no_duration',verification_status:'verified_no_duration',
    match_status:'no_duration',duration_basis:'no_duration',main_story_minutes:null,main_extra_minutes:null,completionist_minutes:null}),
    row(100003),row(100004),row(100005),row(100006),row(999999)]);
  assert.equal(psql(fixture,'select main_duration_minutes from catalog.game_features where game_id=5',true),'600');
  assert.equal(psql(fixture,'select duration_kind from catalog.game_features where game_id=3',true),'endless');
  assert.equal(psql(fixture,'select main_duration_minutes from catalog.game_features where game_id=4',true),'42');
  assert.equal(psql(fixture,'select count(*) from catalog.duration_estimates where steam_app_id in(100004,100006,999999)',true),'0');
  assert.equal(psql(fixture,"select match_status from catalog.duration_estimates where steam_app_id=100002",true),'no_duration');
  const fingerprint=psql(fixture,'select row_to_json(f)::text from catalog.game_features f where game_id=5',true);
  apply([row(100005)]);assert.equal(psql(fixture,'select row_to_json(f)::text from catalog.game_features f where game_id=5',true),fingerprint);
  apply([row(100005,{checked_at:'2026-09-01T00:00:00Z',main_story_minutes:500})]);
  assert.equal(psql(fixture,'select main_duration_minutes from catalog.game_features where game_id=5',true),'600');
  apply([row(100005,{provider_game_id:12345,checked_at:'2026-10-01T00:30:00Z'})]);
  assert.equal(psql(fixture,"select match_status||':'||provider_game_id from catalog.duration_estimates where steam_app_id=100005",true),'ambiguous:100015');
  assert.equal(psql(fixture,"select duration_kind||':'||duration_status from catalog.game_features where game_id=5",true),'unknown:review_required');
  assert.equal(psql(fixture,'select main_duration_minutes is null from catalog.game_features where game_id=5',true),'t');
  apply([], [{steam_appid:100001,provider_game_id:100011,reason:'steam_appid_mismatch'}]);
  assert.equal(psql(fixture,"select match_status from catalog.duration_estimates where steam_app_id=100001",true),'ambiguous');
  assert.equal(psql(fixture,'select main_duration_minutes is null from catalog.game_features where game_id=1',true),'t');
  assert.equal(psql(fixture,"select count(*) from catalog.duration_estimates where provider<>'hltb'",true),'0');
  // A normal application cannot apply the operator-only writeback/resolver.
  await assert.rejects(fixture.database.sql`select catalog.reconcile_hltb_duration(5)`);
});
