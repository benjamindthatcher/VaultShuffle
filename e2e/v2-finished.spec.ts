import { expect,test,type Page } from '@playwright/test';
const session={logged_in:true,account_type:'manual',identity_verified:false,user_id:'11111111-1111-4111-8111-111111111111',steam_id:'76561198000000000',display_name:'Review tester',steam_display_name:'',avatar_url:'',has_steam_key:false};
const product={manualProgress:null,completedAt:null,previousActiveStatus:null,reviewRequestedAt:null,completionDismissedAt:null,completionDismissedMinutes:null,dateAdded:null,recencySource:null,recencyEvidenceAt:null,observedMinutes:null,canonicalGenres:['Adventure'],tags:{Adventure:9},categories:[],imageUrl:'/assets/vault/vault-stage-open.png',headerUrl:'/assets/vault/vault-stage-open.png',releaseDate:null,playerMode:null,platforms:{windows:null,mac:null,linux:null},deckCompatibility:null,duration:{mainStoryMinutes:300,mainExtrasMinutes:null,completionistMinutes:null,source:'hltb',sourceUpdatedAt:null,confidence:null,endless:false},durationKind:'finite',durationStatus:'ready',tagsStatus:'ready',reviews:{positive:null,negative:null,total:null},price:{currency:'USD',initial:1000,final:1000,isFree:false},familyOwnerSteamId:null,familyOwnerName:null};
async function fixture(page:Page,failFirst=false,count=130) {
  const games=Array.from({length:count},(_,i)=>({gameId:i+1,title:`Review Game ${String(i+1).padStart(3,'0')}`,appId:String(i+620),playtimeMinutes:360,access:'owned',completed:false,blacklisted:i===0,lastPlayedAt:null,product}));
  const answered=new Set<number>(),writes:Record<string,unknown>[]=[];
  let revision=1;
  await page.addInitScript(()=>{localStorage.setItem('vault-cookie-consent','disabled');localStorage.setItem('vault-analytics-notice-seen','1');});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path==='/api/app-data')return route.fulfill({json:{session,dataAuthority:'v2',bootstrap:{accountPublicId:session.user_id,libraryRevision:'1',stateRevision:String(revision),ownedTotal:2000,familyTotal:0,pins:[],currentPick:null},pinGames:[]}});
    if(path==='/api/v2/completion-review') {
      if(route.request().method()==='POST') {
        const body=route.request().postDataJSON();writes.push(body);
        if(failFirst){failFirst=false;return route.fulfill({status:503,json:{error:'database_unavailable'}});}
        for(const id of body.game_ids)answered.add(id);
        revision++;
        return route.fulfill({json:{updated:body.game_ids.length}});
      }
      const cursor=url.searchParams.get('cursor'),[version,offset]=cursor?.split(':')??[String(revision),'0'];
      if(Number(version)!==revision)return route.fulfill({status:409,json:{error:'cursor_restart_required'}});
      const eligible=games.filter(game=>!answered.has(game.gameId)),limit=Number(url.searchParams.get('limit')),start=Number(offset);
      expect(limit).toBeLessThanOrEqual(60);
      return route.fulfill({json:{items:eligible.slice(start,start+limit),nextCursor:start+limit<eligible.length?`${revision}:${start+limit}`:null,total:eligible.length,completionValueCents:eligible.length*1000,sectionCounts:{active:129,completed:0,blacklisted:1},filterGenres:[],hasDuration:true,revision:{library:'1',state:String(revision),catalog:'1',features:'1'}}});
    }
    if(path==='/api/v2/steam/owned-games')return route.fulfill({json:{progress:{status:'idle',imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==='/api/session')return route.fulfill({json:session});
    if(path.startsWith('/api/games')||path.startsWith('/api/completions'))throw Error('V2 review must not write legacy data');
    return route.fulfill({json:{}});
  });
  await page.goto('/finished',{waitUntil:'domcontentloaded'});
  await expect(page.getByText(`${count} games left to review`,{exact:true})).toBeVisible();
  return {writes,answered};
}
for(const width of [1280,390])test(`V2 completion review uses whole totals, atomic batches and stable answered rows (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const {writes}=await fixture(page);
  const rows=page.locator('main li').filter({has:page.getByRole('checkbox',{name:/Select Review Game/})});
  await expect(rows).toHaveCount(60);
  await page.getByRole('checkbox',{name:'Select all 60',exact:true}).check();
  await page.getByRole('button',{name:'Mark 60 finished',exact:true}).focus();
  await page.getByRole('button',{name:'Mark 60 finished',exact:true}).hover();
  await page.screenshot({path:`/private/tmp/vaultshuffle-v2-finished-${width}.png`});
  await page.getByRole('button',{name:'Mark 60 finished',exact:true}).click();
  await expect(page.getByText('60 claimed',{exact:true})).toBeVisible();
  await expect(rows).toHaveCount(60);
  expect(writes).toHaveLength(1);
  expect(writes[0].action).toBe('claimed');expect(writes[0].game_ids).toHaveLength(60);
  expect(Object.keys(writes[0]).sort()).toEqual(['action','game_ids','request_key','surface']);
  await expect(page.getByText('70 games left to review',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Load more games',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'Select Review Game 061',exact:true})).toBeVisible();
  // Original answered rows remain available after cursor restart.
  await expect(page.getByText('Review Game 001',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Select Review Game 061',exact:true}).check();
  await page.getByRole('button',{name:'Not yet',exact:true}).first().click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[1].action).toBe('dismissed');expect(writes[1].game_ids).toEqual([61]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('V2 completion review reports failure and keeps the whole selection available',async({page})=>{
  const {writes,answered}=await fixture(page,true);
  await page.getByRole('checkbox',{name:'Select all 60',exact:true}).check();
  await page.getByRole('button',{name:'Mark 60 finished',exact:true}).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('Could not save that. Please try again.');
  expect(answered.size).toBe(0);expect(writes).toHaveLength(1);
  await expect(page.getByRole('checkbox',{name:'Select all 60',exact:true})).toBeEnabled();
  await expect(page.getByText('130 games left to review',{exact:true})).toBeVisible();
  await expect(page.getByText('60 claimed',{exact:true})).toHaveCount(0);
});


test('V2 completion review caps a larger loaded selection at one 500-game batch',async({page})=>{
  const {writes}=await fixture(page,false,550);
  const boxes=page.getByRole('checkbox',{name:/^Select Review Game/});
  for(let count=60;count<550;count+=60) {
    await page.getByRole('button',{name:'Load more games',exact:true}).click();
    await expect(boxes).toHaveCount(Math.min(550,count+60));
  }
  await page.getByRole('checkbox',{name:'Select first 500',exact:true}).check();
  await expect(page.getByRole('checkbox',{name:'Select Review Game 501',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Mark 500 finished',exact:true}).click();
  await expect(page.getByText('500 claimed',{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);expect(writes[0].game_ids).toHaveLength(500);
  await expect(page.getByText('50 games left to review',{exact:true})).toBeVisible();
});
