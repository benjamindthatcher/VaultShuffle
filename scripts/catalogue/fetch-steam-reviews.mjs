import fs from 'node:fs/promises';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const dir=path.resolve(process.argv[2]??'');if(!process.argv[2])throw Error('Pass a private run directory');
const games=JSON.parse(await fs.readFile(path.join(dir,'catalogue-before.json'),'utf8')).games;
const file=path.join(dir,'steam-reviews.ndjson');let previous=[];try{previous=(await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
const done=new Set(previous.filter(r=>r.status==='ready').map(r=>r.app_id));
const pending=games.filter(g=>!done.has(g.app_id));
let cursor=0,completed=done.size,nextAt=0,halted=false,failures=0;
async function pace(){const at=Math.max(Date.now(),nextAt);nextAt=at+200;await delay(Math.max(0,at-Date.now()));}
console.log(JSON.stringify({phase:'reviews',total:games.length,pending:pending.length,interval_ms:200,concurrency:4}));
await Promise.all(Array.from({length:4},async()=>{while(!halted&&cursor<pending.length){const g=pending[cursor++];let record;
 for(let attempt=0;attempt<3;attempt++){await pace();try{
 const url=`https://store.steampowered.com/appreviews/${g.app_id}?json=1&language=all&purchase_type=all&num_per_page=0&filter=all&review_type=all&filter_offtopic_activity=0`;
 const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
 if(response.status===429||response.status===403){halted=true;throw Error('review_rate_limited_'+response.status)};
 if(!response.ok)throw Error('review_http_'+response.status);
 const p=await response.json(),s=p.query_summary;
 if(p.success!==1||![s?.total_reviews,s?.total_positive,s?.total_negative].every(v=>Number.isSafeInteger(v)&&v>=0)||s.total_positive+s.total_negative!==s.total_reviews)throw Error('invalid_review_totals');
 record={app_id:g.app_id,status:'ready',checked_at:new Date().toISOString(),total:s.total_reviews,positive:s.total_positive,negative:s.total_negative};break;
 }catch(e){if(halted)throw e;if(attempt===2){record={app_id:g.app_id,status:'retryable',checked_at:new Date().toISOString(),error:e.message};failures++;}else await delay(1500*(attempt+1));}}
 await fs.appendFile(file,JSON.stringify(record)+'\n',{mode:0o600});completed++;
 if(completed%500===0||completed===games.length)console.log(JSON.stringify({phase:'reviews',completed,total:games.length,failures}));
}}));
