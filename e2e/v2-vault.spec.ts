import {expect,test,type Page} from '@playwright/test';
import {libraryGame} from '../lib/v2/library-view-model';
import {buildVaultPool,buildVaultDeck,buildVaultMatchExplanation} from '../lib/vault';
import type {LibraryCard} from '../lib/v2/repositories/library-core';
import type {VaultDrawRequest,VaultSetup} from '../lib/v2/vault';

const session={logged_in:true,account_type:'manual',identity_verified:false,user_id:'11111111-1111-4111-8111-111111111111',steam_id:'76561198000000000',display_name:'Vault tester',steam_display_name:'',avatar_url:'',has_steam_key:false};
const collectionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function card(id:number):LibraryCard {
  return {gameId:id,title:`Vault Game ${String(id).padStart(3,'0')}`,appId:String(id+620),playtimeMinutes:60,access:'owned',completed:false,blacklisted:false,lastPlayedAt:null,
    product:{manualProgress:null,completedAt:null,previousActiveStatus:null,reviewRequestedAt:null,completionDismissedAt:null,completionDismissedMinutes:null,dateAdded:null,recencySource:null,recencyEvidenceAt:null,observedMinutes:null,
      canonicalGenres:['Adventure'],tags:{Adventure:9},categories:[],imageUrl:'/assets/vault/vault-stage-open.png',headerUrl:'/assets/vault/vault-stage-open.png',releaseDate:null,playerMode:null,
      platforms:{windows:null,mac:null,linux:null},deckCompatibility:null,duration:{mainStoryMinutes:300,source:'hltb',confidence:'high',endless:false},durationKind:'finite',durationStatus:'ready',tagsStatus:'ready',
      reviews:{positive:null,negative:null,total:null},price:{currency:'USD',initial:1000,final:1000,isFree:false},familyOwnerSteamId:null,familyOwnerName:null}};
}
async function fixture(page:Page,failPreview=false,failDraw=false,noCollections=false,winnerInDeck=false) {
  const cards=Array.from({length:200},(_,i)=>card(i+1));
  let currentId:number|null=null,currentDrawId:string|null=null,revision=1,snoozes=[199];
  const draws:Record<string,unknown>[]=[],writes:Record<string,unknown>[]=[],events:Record<string,unknown>[]=[],requests:VaultDrawRequest[]=[];
  let previews=0;
  const metadata={publicId:collectionId,kind:'custom',name:'My whole collection',description:null,rules:null,revision:'1',count:200,updatedAt:'2026-09-30T00:00:00Z',preview:[]};
  const pool=(setup:VaultSetup) => buildVaultPool({games:cards.map(value=>({...libraryGame(value),collectionIds:[collectionId]})),session:setup.session,mood:setup.mood,goal:setup.goal,
    selectedCollectionId:setup.collectionId,selectedGenres:setup.genres,snoozedIds:new Set(snoozes.map(String))});
  await page.addInitScript(()=>{localStorage.setItem('vault-cookie-consent','disabled');localStorage.setItem('vault-analytics-notice-seen','1');});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/app-data')return route.fulfill({json:{session,dataAuthority:'v2',bootstrap:{accountPublicId:session.user_id,libraryRevision:'1',stateRevision:String(revision),ownedTotal:200,familyTotal:0,pins:[],snoozedIds:snoozes,currentPick:currentId?{gameId:currentId,title:cards[currentId-1].title,drawId:currentDrawId}:null},pinGames:currentId?[cards[currentId-1]]:[],collectionMetadata:noCollections?[]:[metadata]}});
    if(path==='/api/v2/vault') {
      if(request.method()==='PATCH') {
        previews++;
        if(failPreview)return route.fulfill({status:503,json:{error:'database_unavailable'}});
        const setup:VaultSetup=request.postDataJSON(),full=pool(setup),deck=buildVaultDeck(full,setup.deferredIds);
        return route.fulfill({json:{deck,poolTotal:full.length,quickTotal:cards.filter(row=>!row.completed&&!row.blacklisted&&!snoozes.includes(row.gameId)).length,
          stages:[{id:'library',label:'In Library',count:200},{id:'available',label:'Available',count:full.length}],collectionCounts:{all:199,[collectionId]:199},preferenceRowCount:0}});
      }
      const body:VaultDrawRequest=request.postDataJSON();requests.push(body);
      if(failDraw){failDraw=false;return route.fulfill({status:503,json:{error:'database_unavailable'}});}
      const setup=body.quick?{...body,session:null,mood:null,goal:null,collectionId:null,genres:[]}:body;
      const full=pool(setup).filter(entry=>!body.excludeIds.includes(entry.game.id));
      // Deliberately return a server-chosen game outside all initial preview
      // cards. The browser must display it without inventing its own selection.
      const winner=full.find(entry=>entry.game.id===String((winnerInDeck ? 0 : 150)+requests.length))??full.at(-1)!;
      currentId=Number(winner.game.id);currentDrawId=body.requestKey;
      const draw={id:currentDrawId,steamAppId:winner.game.steamAppId,drawnAt:'2026-09-30T12:00:00Z',session:setup.session,mood:setup.mood,goal:setup.goal,collectionId:setup.collectionId,
        selectedGenres:setup.genres,eligiblePoolCount:full.length,rerollIndex:body.cycleIds.length,events:[]};
      draws.unshift(draw);
      const explanation=body.quick||body.collectionId?null:buildVaultMatchExplanation({entry:winner,pool:full,session:body.session,mood:body.mood,goal:body.goal,selectedGenres:body.genres,includePersonalTaste:false});
      return route.fulfill({json:{game:{...winner.game,description:`Synopsis for ${winner.game.title}. Explore a mysterious world and choose your next adventure.`},draw,explanation,reasons:body.quick?[]:winner.reasons,collectionName:body.collectionId?'My whole collection':null,arm:'control',cycleReset:false,deckSize:64}});
    }
    if(path==='/api/v2/vault/history') {
      if(request.method()==='DELETE'){draws.length=0;currentDrawId=null;return route.fulfill({json:{cleared:true}});}
      return route.fulfill({json:{draws,games:cards.filter(value=>draws.some(draw=>draw.steamAppId===Number(value.appId)))}});
    }
    if(path==='/api/v2/vault/history/events') {
      const body=request.postDataJSON();events.push(body);
      return route.fulfill({json:{event:{id:body.request_key,drawId:body.draw_id,eventType:body.event_type,createdAt:'2026-09-30T12:01:00Z'}}});
    }
    if(path==='/api/v2/vault/snoozes'){snoozes=[];return route.fulfill({json:{cleared:true}});}
    if(path.startsWith('/api/v2/library/')) {
      const id=Number(path.split('/').at(-1)),value=cards[id-1];
      if(request.method()==='PATCH') {
        const body=request.postDataJSON();writes.push(body);
        if(body.action==='blacklist'){Object.assign(value,{blacklisted:true});if(currentId===id)currentId=null;}
        if(body.action==='complete'){Object.assign(value,{completed:true});if(currentId===id)currentId=null;}
        if(body.restore_decision)Object.assign(value,{blacklisted:body.restore_decision.status==='Blacklisted',completed:body.restore_decision.status==='Completed'});
        revision++;
        return route.fulfill({json:{...value,mutationVersion:'1234567890abcdef1234567890abcdef'}});
      }
      return route.fulfill({json:{...value,description:`Private details for ${value.title}`,notes:'Retained note'}});
    }
    if(path.startsWith('/api/vault/')||path.startsWith('/api/games/'))throw Error(`V2 must not call ${path}`);
    if(path==='/api/v2/steam/owned-games')return route.fulfill({json:{progress:{status:'idle',imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==='/api/session')return route.fulfill({json:session});
    return route.fulfill({json:{}});
  });
  await page.goto('/vault',{waitUntil:'domcontentloaded'});
  return {requests,writes,events,draws,allowPreview:()=>{failPreview=false;},get previews(){return previews;}};
}
function pick(page:Page){return page.locator('[class*="resultCard"]').getByRole('heading',{level:2}).first();}

for(const width of [1280,390])test(`V2 Vault draws from whole pool, rerolls, blacklists and undoes (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const state=await fixture(page);
  await expect(page.getByText('64 of 199 matches',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Roll the dice',exact:true}).click();
  await expect(pick(page)).toHaveText('Vault Game 151');
  await expect(page.locator('[class*="resultCopy"]')).toContainText('Synopsis for Vault Game 151.');
  expect(state.requests[0].quick).toBe(true);expect(state.requests[0].cycleIds).toEqual([]);
  await page.getByRole('button',{name:/^Reroll/}).click();
  await expect(pick(page)).toHaveText('Vault Game 152');
  await expect(page.locator('[class*="resultCopy"]')).toContainText('Synopsis for Vault Game 152.');
  expect(state.requests[1].cycleIds).toEqual(['151']);expect(state.requests[1].previousId).toBe('151');
  await page.getByRole('button',{name:/^Blacklist/}).click();
  await expect(pick(page)).toHaveText('Vault Game 153');
  expect(state.writes[0].action).toBe('blacklist');expect(state.requests[2].excludeIds).toContain('152');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect.poll(()=>state.writes.length).toBe(2);
  expect(state.writes[1].restore_decision).toEqual({status:'In Progress',completed_at:null,expected_version:'1234567890abcdef1234567890abcdef'});
  await page.getByRole('button',{name:/^Draw History/}).click();
  await expect(page.locator('#vault-history-panel')).toBeVisible();
  await expect(page.locator('#vault-history-panel').getByText('Vault Game 151',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Clear draw history',exact:true}).click();
  await expect(page.locator('#vault-history-panel').getByText('Vault Game 151',{exact:true})).toHaveCount(0);
  await expect(pick(page)).toHaveText('Vault Game 153');
  await page.getByRole('button',{name:/^Draw History/}).click();
  const primary=page.getByRole('button',{name:'Roll the dice',exact:true});
  await primary.focus();await primary.hover();
  await page.screenshot({path:`/private/tmp/vaultshuffle-v2-vault-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(state.previews).toBeLessThan(16);
});

test('V2 Vault preserves guided setup and whole Collection Draw without extra filters',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'Short Session',exact:true}).click();
  await page.getByRole('button',{name:'Chill',exact:true}).click();
  await page.getByRole('button',{name:'Surprise Me',exact:true}).click();
  await expect(page.getByRole('button',{name:'Draw from Vault',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Draw from Vault',exact:true}).click();
  await expect(pick(page)).toHaveText('Vault Game 151');
  await expect(page.locator('[class*="resultCopy"]')).toContainText('Synopsis for Vault Game 151.');
  expect(state.requests[0]).toMatchObject({quick:false,session:'short',mood:'chill',goal:'surprise'});
  await page.getByRole('tab',{name:'Collection Draw',exact:true}).click();
  await page.getByRole('button',{name:'Choose which collection to draw from.',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/My whole collection/}).click();
  await expect(page.getByRole('button',{name:'Draw from My whole collection',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Draw from My whole collection',exact:true}).click();
  await expect(pick(page)).toHaveText('Vault Game 152');
  await expect(page.locator('[class*="resultCopy"]')).toContainText('Synopsis for Vault Game 152.');
  expect(state.requests[1]).toMatchObject({quick:false,collectionId,session:null,mood:null,goal:null,genres:[]});
});

test('V2 Vault errors can be retried and do not claim an empty library or reveal unsaved picks',async({page})=>{
  const state=await fixture(page,true,true);
  await expect(page.getByText('Your Vault could not be loaded. Please retry.',{exact:false})).toBeVisible();
  state.allowPreview();
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByRole('button',{name:'Roll the dice',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Roll the dice',exact:true}).click();
  await expect(page.getByText('Your draw could not be saved. Please try again.',{exact:false})).toBeVisible();
  await expect(pick(page)).toHaveCount(0);
  await page.getByRole('button',{name:'Roll the dice',exact:true}).click();
  await expect(pick(page)).toHaveText('Vault Game 152');
  expect(state.requests).toHaveLength(2);
});

test('V2 Vault detail hydration and Complete Undo preserve the earlier decision',async({page})=>{
  const state=await fixture(page);
  await page.getByRole('button',{name:'View details for Vault Game 001',exact:true}).click();
  await expect(page.getByText('Private details for Vault Game 001',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Complete',exact:true}).click();
  await expect.poll(()=>state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({action:'complete',surface:'vault'});
  await page.getByRole('dialog').getByRole('button',{name:'Close game details',exact:true}).click();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect.poll(()=>state.writes.length).toBe(2);
  expect(state.writes[1].restore_decision).toEqual({status:'In Progress',completed_at:null,expected_version:'1234567890abcdef1234567890abcdef'});
});

test('V2 Vault empty collections remain usable and Clear snoozes uses one bounded request',async({page})=>{
  await fixture(page,false,false,true);
  await expect(page.getByRole('button',{name:'Roll the dice',exact:true})).toBeEnabled();
  await page.getByRole('tab',{name:'Collection Draw',exact:true}).click();
  await expect(page.getByRole('link',{name:'Create a collection',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Vault Draw',exact:true}).click();
  await page.getByRole('button',{name:/^Vault Lens/}).click();
  const cleared=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/v2/vault/snoozes'&&request.method()==='DELETE');
  await page.getByRole('button',{name:/Clear snoozes/i}).click();
  expect((await cleared).postDataJSON()).toEqual({});
  await expect(page.getByText('64 of 200 matches',{exact:true})).toBeVisible();
});


for (const width of [1280, 390]) test(`V2 Vault waits for an explicit draw after returning (${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await fixture(page);
  const quickDraw = page.getByRole('button', { name: 'Roll the dice', exact: true });
  await expect(quickDraw).toBeEnabled();
  await expect(pick(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(0);

  await quickDraw.click();
  await expect(pick(page)).toHaveText('Vault Game 151');
  await page.reload();
  await expect(quickDraw).toBeEnabled();
  await expect(page.getByText('64 of 199 matches', { exact: true })).toBeVisible();
  await expect(pick(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(1);

  await page.getByRole('button', { name: 'Short Session', exact: true }).click();
  await page.getByRole('button', { name: 'Chill', exact: true }).click();
  await page.getByRole('button', { name: 'Surprise Me', exact: true }).click();
  const guidedDraw = page.getByRole('button', { name: 'Draw from Vault', exact: true });
  await expect(guidedDraw).toBeEnabled();
  await guidedDraw.focus();
  await guidedDraw.hover();
  await expect(pick(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  await page.screenshot({ path: `/private/tmp/vault-waits-for-draw-${width}.png`, fullPage: true });

  await guidedDraw.click();
  await expect(pick(page)).toHaveText('Vault Game 152');
  expect(state.requests).toHaveLength(2);
  await page.getByRole('button', { name: /^Draw History/ }).click();
  await expect(page.locator('#vault-history-panel').getByText('Vault Game 151', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'FAQ', exact: true }).click();
  await page.waitForURL('**/faq');
  await page.goBack();
  await page.waitForURL('**/vault');
  await expect(quickDraw).toBeEnabled();
  await expect(pick(page)).toHaveCount(0);
  expect(state.requests).toHaveLength(2);
  expect(errors).toEqual([]);
});


for (const width of [1280, 390]) test(`V2 Vault retains the drawn synopsis after deck refresh (${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const state = await fixture(page, false, false, false, true);
  await page.getByRole('button', { name: 'Roll the dice', exact: true }).click();
  await expect(pick(page)).toHaveText('Vault Game 001');
  const description = page.locator('[class*="resultCopy"]');
  await expect(description).toContainText('Synopsis for Vault Game 001.');
  const previews = state.previews;
  await page.getByRole('button', { name: 'Short Session', exact: true }).click();
  await expect.poll(() => state.previews).toBeGreaterThan(previews);
  await expect(page.getByText('64 of 199 matches', { exact: true })).toBeVisible();
  await expect(description).toContainText('Synopsis for Vault Game 001.');
  expect(state.requests).toHaveLength(1);
  await page.locator('[class*="resultCard"]').screenshot({ path: `/private/tmp/vault-description-${width}.png` });
});
