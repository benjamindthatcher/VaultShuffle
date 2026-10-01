import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const directory=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Usage: node scripts/catalogue/fetch-steam-refresh.mjs <private-run-directory>');
const snapshot=JSON.parse(await fs.readFile(path.join(directory,'catalogue-before.json'),'utf8'));
const file=path.join(directory,'steam-store.ndjson');
let previous=[];try{previous=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
const complete=new Set(previous.filter(x=>x.status!=='retryable').map(x=>x.app_id));
const pending=snapshot.games.filter(g=>!complete.has(String(g.app_id)));
async function json(url){for(let attempt=0;attempt<3;attempt++){try{const r=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});if(r.status===429)throw Error('steam_rate_limited');if(!r.ok)throw Error('steam_http_'+r.status);return await r.json();}catch(e){if(e.message==='steam_rate_limited'||attempt===2)throw e;await delay(2000*(attempt+1));}}}
const taxonomy=await json('https://api.steampowered.com/IStoreService/GetTagList/v1/?input_json='+encodeURIComponent(JSON.stringify({language:'english'})));
if(!Array.isArray(taxonomy.response?.tags))throw Error('invalid_tags');
await fs.writeFile(path.join(directory,'tag-taxonomy.json'),JSON.stringify(taxonomy),{mode:0o600});
console.log(JSON.stringify({phase:'store',pending:pending.length,cached:complete.size}));
for(let offset=0;offset<pending.length;offset+=100){
 const batch=pending.slice(offset,offset+100);
 const input={ids:batch.map(g=>({appid:Number(g.app_id)})),context:{language:'english',country_code:'US'},data_request:{include_assets:true,include_basic_info:true,include_release:true,include_platforms:true,include_reviews:true,include_tag_count:100,include_extra_details:true,include_all_purchase_options:true}};
 const data=await json('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json='+encodeURIComponent(JSON.stringify(input)));
 if(!Array.isArray(data.response?.store_items))throw Error('invalid_store_response');
 const items=new Map(data.response.store_items.map(i=>[String(i.appid??i.id),i]));
 const checked_at=new Date().toISOString();
 const records=batch.map(g=>{const item=items.get(String(g.app_id));if(item?.success!==1||item.item_type!==0||String(item.id)!==String(g.app_id)||String(item.appid)!==String(g.app_id))return {app_id:String(g.app_id),checked_at,status:'unavailable',item:null};
 const {extra_details,...keep}=item;return {app_id:String(g.app_id),checked_at,status:'ready',item:{...keep,genreids:extra_details?.links_and_info?.genreids??null}};});
 await fs.appendFile(file,records.map(JSON.stringify).join('\n')+'\n',{mode:0o600});
 if(offset%1000===0||offset+batch.length===pending.length)console.log(JSON.stringify({phase:'store',completed:complete.size+offset+batch.length,total:snapshot.games.length}));
 await delay(650);
}
