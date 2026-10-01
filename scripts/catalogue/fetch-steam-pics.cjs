// Anonymous, current public Steam PICS records. The optional library stays outside the app.
const fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(process.argv[2]||'');
if(!process.argv[2]||!process.env.STEAM_USER_MODULE)throw Error('Usage: STEAM_USER_MODULE=<module-path> node scripts/catalogue/fetch-steam-pics.cjs <private-run-directory>');
const SteamUser=require(process.env.STEAM_USER_MODULE);
const snapshot=JSON.parse(fs.readFileSync(path.join(dir,'catalogue-before.json')));
const file=path.join(dir,'steam-pics.ndjson');
const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const done=new Set(previous.filter(x=>x.status==='ready'||x.status==='unknown').map(x=>x.app_id));
const pending=snapshot.games.map(g=>String(g.app_id)).filter(id=>!done.has(id));
const client=new SteamUser({enablePicsCache:false,dataDirectory:null,autoRelogin:false});
const timeout=setTimeout(()=>{console.error('Steam login timeout');process.exit(1)},45000);
client.on('error',error=>{console.error('Steam connection:',error.message);process.exit(1)});
client.on('loggedOn',async()=>{
 clearTimeout(timeout); console.log(JSON.stringify({phase:'pics',pending:pending.length,cached:done.size}));
 try{for(let offset=0;offset<pending.length;offset+=100){
  const batch=pending.slice(offset,offset+100);
  const apps=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PICS timeout')),45000);client.getProductInfo(batch.map(Number),[],false,(error,apps)=>{clearTimeout(timer);error?reject(error):resolve(apps)});});
  const checked_at=new Date().toISOString();
  for(const app_id of batch){const a=apps[app_id];fs.appendFileSync(file,JSON.stringify({app_id,checked_at,status:a?.appinfo?'ready':'unknown',changenumber:a?.changenumber,common:a?.appinfo?.common??null,extended:a?.appinfo?.extended??null})+'\n',{mode:0o600});}
  if(offset%1000===0||offset+batch.length===pending.length)console.log(JSON.stringify({phase:'pics',completed:done.size+offset+batch.length,total:snapshot.games.length}));
  await new Promise(r=>setTimeout(r,250));
 }
 }catch(error){console.error(error.message);process.exitCode=1;}finally{client.logOff();}
});
client.logOn({anonymous:true});
