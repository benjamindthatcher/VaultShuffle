import type { DatabaseClient, TenantTransaction, VerifiedServerPrincipal } from "../db/client.ts";
import { DatabaseUnavailableError } from "../db/errors.ts";
import { InvalidPageQueryError } from "./page-errors.ts";
import type { GameMutationReceipt, RestoreDecision } from "../game-mutation.ts";

export type GameDecision = "complete" | "blacklist" | "reactivate";
export class GameNotFoundError extends InvalidPageQueryError {
  readonly code = "not_found";
  readonly status = 404;
}
export class StaleMutationError extends InvalidPageQueryError {
  readonly code = "state_changed";
  readonly status = 409;
}

export class MutationsRepository {
  private readonly database: DatabaseClient;
  constructor(database: DatabaseClient) { this.database = database; }

  async decide(principal: VerifiedServerPrincipal, gameId: number, action: GameDecision, requestKey?: string) {
    return (await this.decideWithVersion(principal, gameId, action, requestKey)).changed;
  }

  async decideWithVersion(principal: VerifiedServerPrincipal, gameId: number, action: GameDecision, requestKey?: string, surface: "library" | "vault" = "library") {
    validGame(gameId);
    if (!["complete","blacklist","reactivate"].includes(action)
      || (requestKey !== undefined && !UUID.test(requestKey)) || !["library","vault"].includes(surface)) throw new InvalidPageQueryError();
    return this.run(principal, async tx => {
      const rows = await tx<{ changed: boolean }[]>`select app.apply_game_decision(${gameId},${action},${requestKey ?? null}::uuid) changed`;
      if (action === "complete" && rows[0].changed && surface === "vault") await tx`
        update app.completion_events set origin_surface='vault' where account_id=${principal.accountId} and game_id=${gameId}
          and id=(select id from app.completion_events where account_id=${principal.accountId} and game_id=${gameId} and undone_at is null order by occurred_at desc,id desc limit 1)`;
      return { changed: rows[0].changed, ...await gameVersion(tx, principal.accountId, gameId) };
    });
  }

  /** Restore the prior decision through existing state/history, never a new claim. */
  async restoreDecision(principal: VerifiedServerPrincipal, gameId: number, previous: RestoreDecision): Promise<GameMutationReceipt> {
    validGame(gameId);
    if (!["Completed", "Blacklisted", "In Progress", "Not Started"].includes(previous.status)
      || !/^(empty|[0-9a-f]{32})$/.test(previous.expectedVersion)
      || (previous.status === "Completed" ? !validInstant(previous.completedAt) : previous.completedAt !== null)) throw new InvalidPageQueryError();
    return this.run(principal, async tx => {
      await accessibleGame(tx, principal.accountId, gameId);
      const current = await gameVersion(tx, principal.accountId, gameId);
      if (current.mutationVersion !== previous.expectedVersion) throw new StaleMutationError();
      const completed = previous.status === "Completed", blacklisted = previous.status === "Blacklisted";
      if (completed || blacklisted) {
        await tx`insert into app.game_state(account_id,game_id,completed_at,blacklisted,revision)
          values(${principal.accountId},${gameId},${previous.completedAt}::text::timestamptz,${blacklisted},1)
          on conflict(account_id,game_id) do update set completed_at=excluded.completed_at,blacklisted=excluded.blacklisted,
            revision=app.game_state.revision+1,updated_at=statement_timestamp()`;
        await tx`delete from app.pins where account_id=${principal.accountId} and scope='library' and game_id=${gameId}`;
        await tx`update app.vault_state set current_game_id=null,revision=revision+1,updated_at=statement_timestamp()
          where account_id=${principal.accountId} and current_game_id=${gameId}`;
      } else {
        // Normal Reactivate already retains notes/manual progress/dismissal.
        await tx`select app.apply_game_decision(${gameId},'reactivate',null::uuid)`;
      }
      if (completed) {
        // Source claims can follow the original status timestamp by seconds.
        // Re-enable that latest existing claim; absent history stays absent.
        await tx`update app.completion_events set undone_at=null where account_id=${principal.accountId} and game_id=${gameId}
          and id=(select id from app.completion_events where account_id=${principal.accountId} and game_id=${gameId}
            and occurred_at>=${previous.completedAt}::text::timestamptz order by occurred_at desc,id desc limit 1)`;
      } else {
        await tx`update app.completion_events set undone_at=greatest(statement_timestamp(),occurred_at)
          where account_id=${principal.accountId} and game_id=${gameId} and undone_at is null`;
      }
      return gameVersion(tx, principal.accountId, gameId);
    });
  }

  async dismissCompletion(principal: VerifiedServerPrincipal, gameId: number, dismissed: boolean) {
    validGame(gameId);
    if (typeof dismissed !== "boolean") throw new InvalidPageQueryError();
    await this.run(principal, async tx => {
      await accessibleGame(tx, principal.accountId, gameId);
      if (dismissed) {
        const owned = await tx<{playtime_minutes:number|null}[]>`select playtime_minutes from app.library_games
          where account_id=${principal.accountId} and game_id=${gameId}`;
        if (owned[0]?.playtime_minutes == null) throw new InvalidPageQueryError("Personal playtime is unavailable.");
        await tx`insert into app.game_state(account_id,game_id,completion_dismissed_at,completion_dismissed_playtime,revision)
          values(${principal.accountId},${gameId},statement_timestamp(),${owned[0].playtime_minutes},1)
          on conflict(account_id,game_id) do update set completion_dismissed_at=excluded.completion_dismissed_at,
            completion_dismissed_playtime=excluded.completion_dismissed_playtime,revision=app.game_state.revision+1,updated_at=statement_timestamp()`;
      } else {
        await tx`delete from app.game_state where account_id=${principal.accountId} and game_id=${gameId}
          and completed_at is null and not blacklisted and previous_active_status is null
          and manual_progress is null and notes is null and review_requested_at is null`;
        await tx`update app.game_state set completion_dismissed_at=null,completion_dismissed_playtime=null,
          revision=revision+1,updated_at=statement_timestamp() where account_id=${principal.accountId} and game_id=${gameId}
          and (completion_dismissed_at is not null or completion_dismissed_playtime is not null)`;
      }
    });
  }

  async progress(principal: VerifiedServerPrincipal, gameId: number, progress: number | null) {
    validGame(gameId);
    if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 100)) throw new InvalidPageQueryError();
    await this.run(principal, async tx => {
      await accessibleGame(tx, principal.accountId, gameId);
      if (progress !== null) {
        await tx`insert into app.game_state(account_id,game_id,manual_progress,revision) values(${principal.accountId},${gameId},${progress},1)
          on conflict(account_id,game_id) do update set manual_progress=excluded.manual_progress,
            revision=app.game_state.revision+1,updated_at=statement_timestamp() where app.game_state.manual_progress is distinct from excluded.manual_progress`;
      } else {
        await tx`delete from app.game_state where account_id=${principal.accountId} and game_id=${gameId}
          and completed_at is null and not blacklisted and previous_active_status is null
          and notes is null and review_requested_at is null and completion_dismissed_at is null`;
        await tx`update app.game_state set manual_progress=null,revision=revision+1,updated_at=statement_timestamp()
          where account_id=${principal.accountId} and game_id=${gameId} and manual_progress is not null`;
      }
    });
  }

  async notes(principal: VerifiedServerPrincipal, gameId: number, notes: string | null) {
    validGame(gameId);
    if (notes !== null && (typeof notes !== "string" || notes.length>10_000)) throw new InvalidPageQueryError();
    await this.run(principal, tx => tx`select app.set_game_notes(${gameId},${notes})`);
  }

  /** One tenant transaction for a bounded review selection; no client measurements. */
  async completionBatch(principal: VerifiedServerPrincipal, gameIds: readonly number[], action: "claimed"|"dismissed", requestKey:string, surface:"sweep"|"sweep_bulk"="sweep_bulk") {
    if (!Array.isArray(gameIds) || !gameIds.length || gameIds.length>500 || !UUID.test(requestKey)
      || !["claimed","dismissed"].includes(action) || !["sweep","sweep_bulk"].includes(surface)) throw new InvalidPageQueryError();
    gameIds.forEach(validGame);
    const ids=[...new Set(gameIds)];
    return this.run(principal,async tx=>{
      const account=await tx`select id from app.accounts where id=${principal.accountId} and lifecycle_status='active' for update`;
      if (!account.length) throw new GameNotFoundError();
      const owned=await tx`select lg.game_id from app.library_games lg join catalog.games g on g.id=lg.game_id
        where lg.account_id=${principal.accountId} and lg.game_id=any(${tx.array(ids)}::integer[])
          and lg.playtime_minutes is not null and g.lifecycle_status='active'`;
      if (owned.length!==ids.length) throw new GameNotFoundError();
      if (action==='claimed') {
        const decisions=await tx<{changed:boolean}[]>`select app.apply_game_decision(id,'complete',md5(${requestKey}||':'||id::text)::uuid) changed
          from unnest(${tx.array(ids)}::integer[]) id order by id`;
        // The existing decision function snapshots trusted measurements once.
        // Only identify which current review surface created these new claims.
        await tx`update app.completion_events set origin_surface=${surface}
          where account_id=${principal.accountId} and game_id=any(${tx.array(ids)}::integer[])
            and dedupe_key=md5(${requestKey}||':'||game_id::text)::uuid::text and origin_surface='library'`;
        return {updated:decisions.filter(row=>row.changed).length};
      }
      await tx`insert into app.game_state(account_id,game_id,completion_dismissed_at,completion_dismissed_playtime,revision)
        select lg.account_id,lg.game_id,statement_timestamp(),lg.playtime_minutes,1 from app.library_games lg
        where lg.account_id=${principal.accountId} and lg.game_id=any(${tx.array(ids)}::integer[])
        on conflict(account_id,game_id) do update set completion_dismissed_at=excluded.completion_dismissed_at,
          completion_dismissed_playtime=excluded.completion_dismissed_playtime,revision=app.game_state.revision+1,updated_at=statement_timestamp()`;
      return {updated:ids.length};
    });
  }

  /** Serialize the three Library slots; replacements preserve personal baselines. */
  async pin(principal: VerifiedServerPrincipal, gameId: number, replaceGameId?: number) {
    validGame(gameId); if (replaceGameId!==undefined) validGame(replaceGameId);
    await this.run(principal, async tx => {
      await tx`select id from app.accounts where id=${principal.accountId} for update`;
      const games = await tx<{ playtime_minutes: number | null }[]>`
        with accessible as (
          select game_id,playtime_minutes from app.library_games where account_id=${principal.accountId} and game_id=${gameId}
          union all select distinct game_id,null::integer from app.family_game_access
            where account_id=${principal.accountId} and game_id=${gameId}
              and not exists(select 1 from app.library_games where account_id=${principal.accountId} and game_id=${gameId})
        ) select a.playtime_minutes from accessible a join catalog.games g on g.id=a.game_id
        left join app.game_state gs on gs.account_id=${principal.accountId} and gs.game_id=a.game_id
        where g.lifecycle_status='active'
          and gs.completed_at is null and not coalesce(gs.blacklisted,false)
      `;
      if (!games[0]) throw new GameNotFoundError();
      const pins = await tx<{ slot: number; game_id: number }[]>`select slot,game_id from app.pins where account_id=${principal.accountId} and scope='library' order by slot`;
      if (pins.some(pin => pin.game_id===gameId)) return;
      let slot = [1,2,3].find(value => !pins.some(pin => pin.slot===value));
      if (replaceGameId!==undefined) {
        const replaced = pins.find(pin => pin.game_id===replaceGameId);
        if (!replaced) throw new StaleMutationError();
        slot = replaced.slot;
        await tx`delete from app.pins where account_id=${principal.accountId} and scope='library' and game_id=${replaceGameId}`;
      }
      if (!slot) throw new StaleMutationError();
      await tx`insert into app.pins(account_id,scope,slot,game_id,personal_minutes_baseline)
        values(${principal.accountId},'library',${slot},${gameId},${games[0].playtime_minutes})`;
    });
  }

  async unpin(principal: VerifiedServerPrincipal, gameId: number) {
    validGame(gameId);
    await this.run(principal, async tx => {
      await tx`select id from app.accounts where id=${principal.accountId} for update`;
      await tx`delete from app.pins where account_id=${principal.accountId} and scope='library' and game_id=${gameId}`;
    });
  }

  private async run<T>(principal: VerifiedServerPrincipal, operation: (tx: TenantTransaction) => Promise<T>) {
    try { return await this.database.withPrincipal(principal,operation); }
    catch (error) {
      if (error instanceof InvalidPageQueryError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (message === "GAME_NOT_FOUND") throw new GameNotFoundError();
      if (message === "REQUEST_KEY_REUSED") throw new StaleMutationError();
      throw new DatabaseUnavailableError(error);
    }
  }
}
function validGame(value: number) { if (!Number.isInteger(value) || value<1 || value>2_147_483_647) throw new InvalidPageQueryError(); }
function validInstant(value: string|null) { return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19); }
async function gameVersion(tx:TenantTransaction, accountId:number, gameId:number):Promise<GameMutationReceipt> {
  const rows=await tx<GameMutationReceipt[]>`select md5(revision::text||':'||extract(epoch from updated_at)::text) "mutationVersion"
    from app.game_state where account_id=${accountId} and game_id=${gameId}`;
  return rows[0]??{mutationVersion:'empty'};
}
async function accessibleGame(tx:TenantTransaction, accountId:number, gameId:number) {
  const accounts=await tx`select id from app.accounts where id=${accountId} and lifecycle_status='active' for update`;
  if (!accounts[0]) throw new GameNotFoundError();
  const games=await tx`select g.id from catalog.games g where g.id=${gameId} and g.lifecycle_status='active'
    and (exists(select 1 from app.library_games where account_id=${accountId} and game_id=g.id)
      or exists(select 1 from app.family_game_access where account_id=${accountId} and game_id=g.id))`;
  if (!games[0]) throw new GameNotFoundError();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
