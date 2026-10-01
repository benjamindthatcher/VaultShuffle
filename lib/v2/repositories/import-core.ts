import {createHmac} from 'node:crypto';
import type {DatabaseClient,VerifiedServerPrincipal,TenantTransaction} from '../db/client.ts';
import {DatabaseUnavailableError,RequestLimitError} from '../db/errors.ts';
import {InvalidPageQueryError} from './page-errors.ts';
import {IDLE_STEAM_IMPORT,type SteamImportProgress} from '../../steam-import-progress.ts';

export class ImportRequestError extends InvalidPageQueryError {
  readonly code:string;readonly status:number;
  constructor(code:string,message:string,status=503){super(message);this.code=code;this.status=status;}
}
type Row={job_id:string;status:string;observed_count:number|null;result_code:string|null;started_at:string|null;completed_at:string|null;retry_seconds:number;play_history_missing:boolean};
export type OwnedImportStatus={jobId:string|null;progress:SteamImportProgress;retry_after_seconds:number;private_library:boolean};
export class ImportRepository {
  private readonly database:DatabaseClient;
  constructor(database:DatabaseClient){this.database=database;}
  async status(principal:VerifiedServerPrincipal):Promise<OwnedImportStatus> {
    return this.run(principal,async tx=>{
      const rows=await tx<Row[]>`select job_id,status,observed_count,result_code,play_history_missing,
        to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') started_at,
        to_char(completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') completed_at,
        greatest(2,least(30,ceil(extract(epoch from retry_at-clock_timestamp()))))::integer retry_seconds from app.latest_owned_import()`;
      if(!rows[0])return {jobId:null,progress:{...IDLE_STEAM_IMPORT},retry_after_seconds:2,private_library:false};
      return importStatus(rows[0]);
    });
  }
  async request(principal:VerifiedServerPrincipal,requestKey:string,secret:string):Promise<OwnedImportStatus> {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))throw new InvalidPageQueryError();
    if(!secret)throw new DatabaseUnavailableError();
    const digest=createHmac('sha256',secret).update(`steam_owned_import\u001fuser:${principal.accountPublicId}`).digest();
    await this.run(principal,async tx=>{
      const rows=await tx<{job_id:string|null;status:string;retry_after_seconds:number}[]>`select job_id,status,retry_after_seconds from app.begin_owned_import(${requestKey}::uuid,${digest})`;
      if(!rows[0])throw new DatabaseUnavailableError();
      if(rows[0].status==='rate_limited')throw new RequestLimitError(Math.max(1,rows[0].retry_after_seconds));
      if(!rows[0].job_id)throw new ImportRequestError('steam_unavailable','Steam library syncing is temporarily unavailable. Please try again shortly.');
    });
    return this.status(principal);
  }
  private async run<T>(principal:VerifiedServerPrincipal,operation:(tx:TenantTransaction)=>Promise<T>):Promise<T>{
    try{return await this.database.withPrincipal(principal,operation);}
    catch(error){if(error instanceof InvalidPageQueryError||error instanceof RequestLimitError)throw error;throw new DatabaseUnavailableError();}
  }
}
export function importStatus(row:Row):OwnedImportStatus {
  const complete=row.status==='succeeded'&&row.result_code==='complete';
  const running=['queued','enqueued','leased','fetching','publishing','retryable'].includes(row.status);
  const status=complete?'complete':running?'fetching':'failed';
  const error=complete||running?null:row.result_code==='private'?'Steam did not share your games list. Make Game details Public, then retry.'
    :'Steam could not complete this library check. Your existing games are safe; retry to check again.';
  return {jobId:row.job_id,retry_after_seconds:row.retry_seconds??2,private_library:row.result_code==='private',
    progress:{status,imported:complete?row.observed_count??0:0,total:complete?row.observed_count??0:0,percent:complete?100:0,
      playHistoryMissing:row.play_history_missing,lastError:error,startedAt:row.started_at,completedAt:row.completed_at}};
}
