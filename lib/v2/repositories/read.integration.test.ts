import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createDatabaseClient, type DatabaseClient, type VerifiedServerPrincipal } from "../db/client.ts";
import { parseDatabaseConfig } from "../db/config.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { BootstrapRepository } from "./bootstrap-core.ts";
import { LibraryRepository, type LibraryCard, type LibraryQuery } from "./library-core.ts";
import { DashboardRepository } from "./dashboard-core.ts";
import { CollectionsRepository } from "./collections-core.ts";
import { InvalidPageQueryError, PageCursorRestartRequiredError } from "./page-errors.ts";

const PG_BIN = join(process.cwd(), "node_modules/.cache/vaultshuffle-pg17-20260910/bin");
const MIGRATIONS = [
  "20260906093036_m1_private_foundation.sql",
  "20260907163356_m2_jobs_quota_publish.sql",
  "20260910232654_m3_preservation_schema.sql",
  "20260911234500_m3_legacy_preservation_followup.sql",
  "20260912193000_blacklist_semantics.sql",
  "20260913191021_m4_manual_session_touch.sql",
].map((name) => join(process.cwd(), "database/v2/supabase/migrations", name));

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
      (3,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,'custom','Other tenant',null,null,1);
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

  await t.test("bootstrap stays bounded and returns only library pins plus revision/current-pick metadata", async () => {
    const payload = await fixture.bootstrap.read(ACCOUNT_A);
    assert.deepEqual({
      accountPublicId: payload.accountPublicId,
      libraryRevision: payload.libraryRevision,
      stateRevision: payload.stateRevision,
      ownedTotal: payload.ownedTotal,
      familyTotal: payload.familyTotal,
      pins: payload.pins,
      currentPick: payload.currentPick,
    }, {
      accountPublicId: ACCOUNT_A.accountPublicId,
      libraryRevision: "123",
      stateRevision: "456",
      ownedTotal: 1005,
      familyTotal: 100,
      pins: [
        { slot: 1, gameId: 1, title: "Game 0000" },
        { slot: 2, gameId: 2, title: "Game 0000" },
        { slot: 3, gameId: 3, title: "Game 0000" },
      ],
      currentPick: { gameId: 5, title: "Game 0001" },
    });
    assert.ok(JSON.stringify(payload).length < 700, "bootstrap payload must stay independent of library row count");

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

  await t.test("versioned cursors bind tenant, filters, sorts and all applicable revisions", async () => {
    const first = await fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours" });
    assert.ok(first.nextCursor);
    assert.deepEqual(Object.keys(first.revision), ["library", "state", "catalog", "features"]);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "title", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", search: "game", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    await assert.rejects(() => fixture.library.list(ACCOUNT_B, { limit: 2, sort: "hours", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
    psql(fixture, "update app.accounts set state_revision=state_revision+1 where id=1");
    await assert.rejects(() => fixture.library.list(ACCOUNT_A, { limit: 2, sort: "hours", cursor: first.nextCursor! }), PageCursorRestartRequiredError);
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
    assert.equal(dashboard.mostPlayed.length, 5);
    assert.ok(dashboard.recentCompletions.length <= 8);
    assert.ok(dashboard.completionSuggestions.length <= 50);
    assert.deepEqual(dashboard.trend.dailyGains.map((gain) => gain.minutes), [60,60,60,60]);
    assert.equal(dashboard.aggregates.libraryValueCents, null);
    const empty = await fixture.dashboard.read(EMPTY_ACCOUNT);
    assert.equal(empty.aggregates.ownedGames, 0);
    assert.deepEqual(empty.mostPlayed, []);
  });

  await t.test("collections keep metadata separate and traverse 1,000+ custom members in position order", async () => {
    const summaries = await fixture.collections.list(ACCOUNT_A);
    assert.deepEqual(summaries.map((entry) => [entry.name, entry.count]), [["Untouched", 1], ["Everything", 1001]]);
    const items: number[]=[];let cursor:string|undefined;do{const page=await fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:73,...(cursor?{cursor}:{})});assert.ok(page);items.push(...page.items.map(item=>item.gameId));cursor=page.nextCursor??undefined;}while(cursor);
    assert.equal(items.length,1001);assert.equal(new Set(items).size,1001);assert.deepEqual(items.slice(0,3),[1,2,3]);
    const notePage=await fixture.collections.members(ACCOUNT_A,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{limit:5});assert.equal(notePage?.items.at(-1)?.note,"membership note");
    assert.equal(await fixture.collections.members(ACCOUNT_A,"cccccccc-cccc-4ccc-8ccc-cccccccccccc"),null);
    assert.equal(await fixture.collections.members(ACCOUNT_B,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),null);
    const smart=await fixture.collections.members(ACCOUNT_A,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");assert.equal(smart?.total,1);assert.deepEqual(smart?.items.map(item=>item.gameId),[2]);
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
    const noContext = await fixture.database.sql<{ id: number }[]>`select id from app.accounts order by id`;
    assert.equal(noContext.length, 0);
    assert.equal((await collect(fixture.library, EMPTY_ACCOUNT)).total, 0);
  });

  await t.test("query inputs remain bounded allowlists and parameter values cannot change SQL shape", async () => {
    await assert.rejects(
      () => fixture.library.list(ACCOUNT_A, { progress: "started" as LibraryQuery["progress"] }),
      DatabaseUnavailableError,
    );
    await assert.rejects(
      () => fixture.library.list(ACCOUNT_A, { genres: Array.from({ length: 19 }, (_, index) => `g${index}`) }),
      DatabaseUnavailableError,
    );
    assert.equal((await fixture.library.list(ACCOUNT_A, { search: "%' OR true --" })).total, 0);
    assert.equal((await fixture.library.list(ACCOUNT_A, { genres: ["x') OR true --"] })).total, 0);
    assert.equal(psql(fixture, "select count(*) from app.accounts", true), "3");
  });
});
