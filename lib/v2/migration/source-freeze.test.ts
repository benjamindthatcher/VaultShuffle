import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {prepareSourceFreeze} from './source-freeze.ts';
const tables=Array.from({length:44},(_,i)=>({name:`fixture_${String(i).padStart(2,'0')}`,kind:'r'}));
const inventory={source_project_ref:'pfvblcopcmairdfeqdep',database:'postgres',public_tables:[...tables,{name:'fixture_view_a',kind:'v'},{name:'fixture_view_b',kind:'v'}],scheduled_jobs:[{id:1,active:true},{id:2,active:false}]};
test('Source freeze refuses wrong identity, drift and unsafe identifiers',()=>{
  for(const changed of [{source_project_ref:'vbjtbwelnhbbdfrqczyf'},{public_tables:inventory.public_tables.slice(1)},
    {public_tables:[{name:'bad;sql',kind:'r'},...inventory.public_tables.slice(1)]},{scheduled_jobs:[{id:NaN,active:true}]}])
    assert.throws(()=>prepareSourceFreeze({...inventory,...changed}));
});
test('Source fence blocks every write and truncate, keeps reads and restores only previously active cron jobs',()=>{
  const pg=join(process.cwd(),'node_modules/.cache/vaultshuffle-pg17-20260910/bin');
  const root=mkdtempSync('/private/tmp/vaultshuffle-freeze-');const socket=join(root,'socket');mkdirSync(socket);let started=false;
  const run=(name:string,args:string[],input?:string)=>spawnSync(join(pg,name),args,{input,encoding:'utf8',env:{PATH:process.env.PATH??'',LC_ALL:'C',NODE_ENV:'test'}});
  const check=(name:string,args:string[],input?:string)=>{const result=run(name,args,input);assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  const args=['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',socket,'-p','54989','-U','postgres','-d','postgres','-f','-'];
  try {
    check('initdb',['-D',join(root,'data'),'-A','trust','-U','postgres','--no-locale']);
    check('pg_ctl',['-D',join(root,'data'),'-l',join(root,'pg.log'),'-o',`-k ${socket} -p 54989 -h ''`,'-w','start']);started=true;
    check('psql',args,tables.map(table=>`create table public.${table.name}(id integer);insert into public.${table.name} values(1);`).join('\n')+
      'create schema cron;create table cron.job(jobid bigint primary key,active boolean);insert into cron.job values(1,true),(2,false);create role service_role;grant select,insert,update,delete,truncate on all tables in schema public to service_role;');
    const packet=prepareSourceFreeze(inventory);check('psql',args,packet.enableSql);
    assert.equal(check('psql',args,"select count(*) from pg_trigger where tgname='vault_cutover_write_fence';select count(*) from public.fixture_00;select count(*) from cron.job where active;"),'44\n1\n0');
    for(const sql of ['insert into public.fixture_00 values(2)','update public.fixture_00 set id=3','delete from public.fixture_00','truncate public.fixture_00']) {
      const result=run('psql',args,`set role service_role;${sql};`);assert.notEqual(result.status,0);assert.match(result.stderr,/SOURCE_WRITE_FROZEN/);
    }
    check('psql',args,packet.disableSql);
    assert.equal(check('psql',args,'select count(*) from cron.job where active;select active from cron.job where jobid=2;'),'1\nf');
    check('psql',args,'set role service_role;insert into public.fixture_00 values(2);');
  } finally {
    if(started)check('pg_ctl',['-D',join(root,'data'),'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true});
  }
});
