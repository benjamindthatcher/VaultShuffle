import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import { libraryGlobalFilters } from "./library-global-filters.ts";
import { libraryProducts } from "./library-product.ts";
import { readLibraryCards, type LibraryCard } from "./library-core.ts";
import { libraryGame } from "../library-view-model.ts";
import { smartEligibleCte, parseSmartRule, smartPredicate } from "./smart-predicates.ts";
import { buildGenrePreferenceIndex, type GenrePreference } from "../../genre-preferences.ts";
import type { GameVerdicts } from "../../game-verdict.ts";
import { buildVaultPool, buildVaultDeck, getVaultEligibility, drawQuickVaultGame, drawVaultGame,
  vaultFinalists, buildVaultMatchExplanation, RECORDED_FINALIST_LIMIT, MAX_VAULT_DECK_SIZE } from "../../vault.ts";
import type { VaultSetup, VaultDrawRequest, VaultDrawResult, VaultPreview } from "../vault.ts";
import type { VaultDraw, VaultDrawEvent, VaultDrawEventType } from "../../vault-history.ts";

type DrawRow = { id: string; public_id: string; game_id: number | null; steam_app_id: string;
  drawn_at: Date | string; session: VaultDraw["session"]; mood: VaultDraw["mood"]; goal: VaultDraw["goal"];
  source_collection_id: string | null; selected_genres: string[]; eligible_pool_count: number;
  reroll_index: number; finalist_app_ids: number[] | null };
type EventRow = { public_id: string; draw_id: string; event_type: VaultDrawEventType; occurred_at: Date | string };

export class VaultRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }

  async preview(principal: VerifiedServerPrincipal, setup: VaultSetup): Promise<VaultPreview> {
    return this.database.withPrincipal(principal, async tx => {
      const data = await poolData(tx, principal.accountId, setup);
      return { deck: buildVaultDeck(data.pool, setup.deferredIds), poolTotal: data.pool.length,
        quickTotal: data.quick.length, stages: data.stages, collectionCounts: data.collectionCounts,
        preferenceRowCount: data.preferences.length };
    });
  }

  async draw(principal: VerifiedServerPrincipal, request: VaultDrawRequest, rng = Math.random): Promise<VaultDrawResult | null> {
    return this.database.withPrincipal(principal, async tx => {
      // Same account lock as decisions/pins: selection and current-pick write
      // cannot race a completion/Blacklist into an inactive pick.
      const account = await tx`select id from app.accounts where id=${principal.accountId} and lifecycle_status='active' for update`;
      if (!account.length) throw new InvalidPageQueryError();
      const existing = (await tx<DrawRow[]>`select d.*,to_char(d.drawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') drawn_at
        from app.vault_draws d where account_id=${principal.accountId} and public_id=${request.requestKey}`)[0];
      const setup: VaultSetup = request.quick
        ? { ...request, session: null, mood: null, goal: null, collectionId: null, genres: [] }
        : request;
      if (existing && (existing.session !== setup.session || existing.mood !== setup.mood || existing.goal !== setup.goal
        || existing.source_collection_id !== setup.collectionId || JSON.stringify(existing.selected_genres) !== JSON.stringify(setup.genres))) throw new InvalidPageQueryError("The draw request was already used.");
      const data = await poolData(tx, principal.accountId, setup);
      const excluded = new Set(request.excludeIds);
      const pool = data.pool.filter(entry => !excluded.has(entry.game.id));
      const uniform = request.quick || Boolean(setup.collectionId);
      const deck = uniform ? pool : buildVaultDeck(pool, request.deferredIds);
      const cycle = new Set(request.cycleIds);
      let available = deck.filter(entry => !cycle.has(entry.game.id));
      const cycleReset = !available.length;
      if (cycleReset) available = deck;
      const arm = uniform || !data.preferences.length ? "control" : request.arm;
      const game = existing
        ? (existing.game_id ? (await readLibraryCards(tx, principal.accountId, [existing.game_id]))[0] : null)
        : null;
      const winner = existing ? (game ? libraryGame(game) : null)
        : uniform ? drawQuickVaultGame(available, request.previousId, rng)
        : drawVaultGame(available, request.previousId, rng, arm === "test");
      if (!winner) return null;
      let saved = existing;
      if (!saved) {
        const finalists = uniform ? null : vaultFinalists(available, request.previousId)
          .map(entry => entry.game.steamAppId).filter(id => id > 0).slice(0, RECORDED_FINALIST_LIMIT);
        saved = (await tx<DrawRow[]>`
          insert into app.vault_draws (public_id,account_id,game_id,steam_app_id,drawn_at,session,mood,goal,
            source_collection_id,collection_id,selected_genres,eligible_pool_count,reroll_index,finalist_app_ids)
          values (${request.requestKey},${principal.accountId},${Number(winner.id)},${winner.steamAppId},now(),
            ${setup.session},${setup.mood},${setup.goal},${setup.collectionId},${data.collectionInternalId},
            ${tx.json(setup.genres)},${pool.length},${cycleReset ? 0 : cycle.size},${finalists === null ? null : tx.json(finalists)})
          returning *,to_char(drawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') drawn_at`)[0];
        await tx`insert into app.vault_state (account_id,current_game_id,current_draw_ref)
          values (${principal.accountId},${Number(winner.id)},${saved.public_id})
          on conflict (account_id) do update set current_game_id=excluded.current_game_id,
            current_draw_ref=excluded.current_draw_ref,revision=app.vault_state.revision+1,updated_at=now()`;
      }
      const entry = pool.find(value => value.game.id === winner.id);
      return { game: winner, draw: drawView(saved, []), arm, cycleReset, deckSize: Math.min(MAX_VAULT_DECK_SIZE, deck.length),activeSnoozedIds:[...data.snoozedIds],
        explanation: !uniform && entry ? buildVaultMatchExplanation({ entry, pool, session: setup.session,
          mood: setup.mood, goal: setup.goal, selectedGenres: setup.genres, includePersonalTaste: arm === "test" }) : null,
        reasons: request.quick ? [] : entry?.reasons ?? [], collectionName: data.collectionName };
    });
  }

  async history(principal: VerifiedServerPrincipal) {
    return this.database.withPrincipal(principal, async tx => {
      const rows = await tx<DrawRow[]>`select d.*,to_char(d.drawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') drawn_at from app.vault_draws d where account_id=${principal.accountId}
        order by d.drawn_at desc,d.id desc limit 50`;
      const draws: VaultDraw[] = [];
      // One lateral query, at most eight recent reactions per each of 50 draws.
      // Stored learning history is kept; the panel only shows its latest reaction.
      const events = rows.length ? await tx<EventRow[]>`
        select e.public_id,e.event_type,d.public_id draw_id,to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at from app.vault_draws d cross join lateral (
          select id,public_id,event_type,occurred_at from app.vault_draw_events e
          where e.account_id=${principal.accountId} and e.draw_id=d.id order by occurred_at desc,id desc limit 8
        ) e where d.account_id=${principal.accountId} and d.id=any(${tx.array(rows.map(row => row.id))}::bigint[])
          order by d.drawn_at desc,d.id desc,e.occurred_at desc,e.id desc` : [];
      for (const row of rows) draws.push(drawView(row, events.filter(event => event.draw_id === row.public_id).map(eventView)));
      const cards = await readLibraryCards(tx, principal.accountId, [...new Set(rows.flatMap(row => row.game_id ? [row.game_id] : []))]);
      return { draws, games: cards };
    });
  }

  async event(principal: VerifiedServerPrincipal, drawId: string, eventType: VaultDrawEventType, requestKey: string) {
    return this.database.withPrincipal(principal, async tx => {
      const rows = await tx<EventRow[]>`
        insert into app.vault_draw_events (public_id,account_id,draw_id,event_type,occurred_at)
        select ${requestKey},${principal.accountId},d.id,${eventType},now() from app.vault_draws d
          where d.account_id=${principal.accountId} and d.public_id=${drawId}
        on conflict (public_id) do nothing returning public_id,${drawId}::text draw_id,event_type,
          to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at`;
      const row = rows[0] ?? (await tx<EventRow[]>`select e.public_id,d.public_id draw_id,e.event_type,
        to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at
        from app.vault_draw_events e join app.vault_draws d on d.id=e.draw_id and d.account_id=e.account_id
        where e.account_id=${principal.accountId} and e.public_id=${requestKey} and d.public_id=${drawId} and e.event_type=${eventType}`)[0];
      return row ? { event: eventView(row) } : null;
    });
  }

  async clearHistory(principal: VerifiedServerPrincipal) {
    return this.database.withPrincipal(principal, async tx => {
      await tx`select id from app.accounts where id=${principal.accountId} for update`;
      await tx`delete from app.vault_draws where account_id=${principal.accountId}`;
      // The existing owner FK clears only current_draw_ref, preserving the pick.
      return { cleared: true };
    });
  }
  async clearSnoozes(principal: VerifiedServerPrincipal, gameId?: number) {
    return this.database.withPrincipal(principal, async tx => {
      await tx`select id from app.accounts where id=${principal.accountId} for update`;
      await tx`delete from app.snoozes where account_id=${principal.accountId} ${gameId === undefined ? tx`` : tx`and game_id=${gameId}`}`;
      return { cleared: true };
    });
  }
}

async function poolData(tx: TenantTransaction, accountId: number, setup: VaultSetup) {
  const filters = libraryGlobalFilters(setup.globalFilters);
  // Compact authored/access facts first. Product hydration is server-side only:
  // no private notes/descriptions and no page-size cutoff before eligibility.
  const facts = await tx<{ game_id: number; title: string; steam_app_id: string | null; minutes: number | null;
    access: "owned" | "family"; completed: boolean; blacklisted: boolean; last_played_at: Date | string | null }[]>`
    ${smartEligibleCte(tx,accountId,filters)} order by game_id`;
  const products = await libraryProducts(tx, accountId, facts.map(row => row.game_id));
  const games = facts.map(row => libraryGame({ gameId: row.game_id, title: row.title, appId: row.steam_app_id === null ? null : String(row.steam_app_id),
    playtimeMinutes: row.minutes, access: row.access, completed: row.completed, blacklisted: row.blacklisted,
    lastPlayedAt: instant(row.last_played_at), product: products.get(row.game_id) } satisfies LibraryCard));
  const snoozes = await tx<{game_id:number}[]>`select game_id from app.snoozes where account_id=${accountId} and (until_at is null or until_at>now())`;
  const snoozedIds = new Set(snoozes.map(row => String(row.game_id)));
  const collections = await tx<{id:number;public_id:string;name:string;collection_kind:string;rules:unknown}[]>`
    select id,public_id,name,collection_kind,rules from app.collections where account_id=${accountId} order by id limit 100`;
  const selected = setup.collectionId ? collections.find(row => row.public_id === setup.collectionId) : null;
  if (setup.collectionId && !selected) throw new InvalidPageQueryError("The collection is unavailable.");
  const custom = await tx<{public_id:string;total:string}[]>`
    with eligible as (${smartEligibleCte(tx,accountId,filters)})
    select c.public_id,count(*) total from app.collection_games cg join app.collections c on c.id=cg.collection_id and c.account_id=cg.account_id
    join eligible e on e.game_id=cg.game_id
    where cg.account_id=${accountId} and c.collection_kind='custom' and not e.completed and not e.blacklisted
      and not exists(select 1 from app.snoozes s where s.account_id=${accountId} and s.game_id=e.game_id and (s.until_at is null or s.until_at>now()))
    group by c.public_id`;
  const collectionCounts: Record<string,number> = Object.fromEntries(collections.map(c => [c.public_id,0]));
  for (const row of custom) collectionCounts[row.public_id] = Number(row.total);
  let selectedIds = new Set<number>();
  if (selected?.collection_kind === "custom") {
    const members = await tx<{game_id:number}[]>`select game_id from app.collection_games where account_id=${accountId} and collection_id=${selected.id}`;
    selectedIds = new Set(members.map(row => row.game_id));
  }
  for (const collection of collections.filter(row => row.collection_kind === "smart")) {
    let preset;
    try { preset = parseSmartRule(collection.rules).preset; }
    catch (error) { if (collection.public_id === setup.collectionId) throw error; continue; }
    const members = await tx<{game_id:number}[]>`with eligible as (${smartEligibleCte(tx,accountId,filters)})
      select game_id from eligible where ${smartPredicate(tx,preset)}
        and not completed and not blacklisted and not exists(select 1 from app.snoozes s where s.account_id=${accountId} and s.game_id=eligible.game_id and (s.until_at is null or s.until_at>now()))`;
    collectionCounts[collection.public_id] = members.length;
    if (collection.public_id === setup.collectionId) selectedIds = new Set(members.map(row => row.game_id));
  }
  if (selected) for (const game of games) if (selectedIds.has(Number(game.id))) game.collectionIds = [selected.public_id];
  const snapshot = (await tx<{id:string}[]>`select id from reco.warm_start_snapshots where status='frozen' order by frozen_at desc,id desc limit 1`)[0];
  const preferences: GenrePreference[] = [], globals: GenrePreference[] = [];
  const verdicts: GameVerdicts = {};
  if (snapshot) {
    const personalRows = await tx<{genre:string;mood:GenrePreference["contextMood"];positive:string;total:string}[]>`
      select genre,mood,positive,total from reco.user_genre_preferences where snapshot_id=${snapshot.id} and account_id=${accountId}`;
    const globalRows = await tx<{genre:string;mood:GenrePreference["contextMood"];positive:string;total:string}[]>`
      select genre,mood,positive,total from reco.genre_preference_globals where snapshot_id=${snapshot.id}`;
    // Current bootstrap scopes game verdicts to the whole accessible library
    // (before global filters), which also defines its population baseline.
    const verdictRows = await tx<{steam_app_id:string;positive:string;total:string;total_hours:string}[]>`
      select p.steam_app_id,p.positive,p.total,p.total_hours from reco.game_preference_globals p where p.snapshot_id=${snapshot.id}
        and exists(select 1 from catalog.games g where g.steam_app_id=p.steam_app_id and g.lifecycle_status='active'
          and (exists(select 1 from app.library_games lg where lg.account_id=${accountId} and lg.game_id=g.id)
            or exists(select 1 from app.family_game_access f where f.account_id=${accountId} and f.game_id=g.id)))`;
    for (const [rows,target] of [[personalRows,preferences],[globalRows,globals]] as const)
      for (const row of rows) target.push({genre:row.genre,contextMood:row.mood,positive:Number(row.positive),total:Number(row.total)});
    for (const row of verdictRows) verdicts[String(row.steam_app_id)] = [Number(row.positive),Number(row.total),Number(row.total_hours)];
  }
  const inputs = { games, session: setup.session, mood: setup.mood, goal: setup.goal, selectedCollectionId: setup.collectionId,
    selectedCollectionName: selected?.name ?? null, selectedGenres: setup.genres, snoozedIds };
  const pool = buildVaultPool({ ...inputs, genrePreferences: preferences.length ? buildGenrePreferenceIndex(preferences) : null,
    genrePreferenceGlobals: globals.length ? buildGenrePreferenceIndex(globals) : null, gameVerdicts: verdicts });
  const quick = buildVaultPool({ ...inputs, session: null, mood: null, goal: null, selectedCollectionId: null, selectedGenres: [] });
  collectionCounts.all = quick.length;
  return { pool, quick, stages: getVaultEligibility(inputs).stages, preferences, collectionCounts,snoozedIds,
    collectionName: selected?.name ?? null, collectionInternalId: selected?.id ?? null };
}

function instant(value: Date | string | null) { return value instanceof Date ? value.toISOString() : value; }
function eventView(row: EventRow): VaultDrawEvent { return {id:row.public_id,drawId:row.draw_id,eventType:row.event_type,createdAt:instant(row.occurred_at)!}; }
function drawView(row: DrawRow, events: VaultDrawEvent[]): VaultDraw {
  return { id:row.public_id,steamAppId:Number(row.steam_app_id),drawnAt:instant(row.drawn_at)!,session:row.session,mood:row.mood,goal:row.goal,
    collectionId:row.source_collection_id,selectedGenres:row.selected_genres,eligiblePoolCount:row.eligible_pool_count,rerollIndex:row.reroll_index,
    ...(row.finalist_app_ids ? {finalistAppIds:row.finalist_app_ids} : {}),events };
}
