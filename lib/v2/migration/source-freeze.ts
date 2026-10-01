/** Generates a temporary operator fence; never connects to or changes a database. */
export function prepareSourceFreeze(inventory: {
  source_project_ref: string; database: string;
  public_tables: readonly {name:string;kind:string}[];
  scheduled_jobs: readonly {id:number;active:boolean}[];
}) {
  if(inventory.source_project_ref!=='pfvblcopcmairdfeqdep'||inventory.database!=='postgres')throw Error('Wrong source freeze inventory');
  const names=inventory.public_tables.filter(table=>table.kind==='r'||table.kind==='p').map(table=>table.name).sort();
  if(names.length!==44||new Set(names).size!==44||names.some(name=>!/^[a-z][a-z0-9_]*$/.test(name)))throw Error('Source table inventory drift');
  if(inventory.public_tables.length!==46||inventory.public_tables.some(table=>!['r','p','v'].includes(table.kind)))throw Error('Source relation inventory drift');
  if(inventory.scheduled_jobs.some(job=>!Number.isSafeInteger(job.id)||job.id<1||typeof job.active!=='boolean')||
    new Set(inventory.scheduled_jobs.map(job=>job.id)).size!==inventory.scheduled_jobs.length)throw Error('Source cron inventory drift');
  const jobs=inventory.scheduled_jobs.filter(job=>job.active).map(job=>job.id).sort((a,b)=>a-b);
  const guard=`do $guard$ begin
    if current_database()<>'postgres' or to_regclass('ops.project_marker') is not null then raise exception 'WRONG_SOURCE_FREEZE_TARGET'; end if;
    if (select array_agg(c.relname::text order by c.relname collate "C") from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in('r','p')) is distinct from array[${names.map(name=>`'${name}'`).join(',')}]::text[] then raise exception 'SOURCE_TABLE_DRIFT'; end if;
  end $guard$;`;
  const header=`\\set ON_ERROR_STOP on\nbegin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\nset role postgres;\n${guard}\n`;
  const enableSql=header+`create schema vault_cutover authorization postgres;
revoke all on schema vault_cutover from public;
create function vault_cutover.block_source_write() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception using errcode='55000',message='SOURCE_WRITE_FROZEN'; end $$;
revoke all on function vault_cutover.block_source_write() from public;
`+names.map(name=>`create trigger vault_cutover_write_fence before insert or update or delete or truncate on public."${name}" for each statement execute function vault_cutover.block_source_write();`).join('\n')+
    (jobs.length?`\nupdate cron.job set active=false where jobid in(${jobs.join(',')});`:'')+'\ncommit;\n';
  const disableSql=header+names.map(name=>`drop trigger vault_cutover_write_fence on public."${name}";`).join('\n')+
    '\ndrop function vault_cutover.block_source_write();\ndrop schema vault_cutover;'+
    (jobs.length?`\nupdate cron.job set active=true where jobid in(${jobs.join(',')});`:'')+'\ncommit;\n';
  return Object.freeze({enableSql,disableSql,tables:names.length,pausedCronJobIds:Object.freeze(jobs)});
}
