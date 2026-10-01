import {expect,test,type Page} from '@playwright/test';
const product = {
  manualProgress:null, completedAt:null, previousActiveStatus:null, reviewRequestedAt:null,
  completionDismissedAt:null, completionDismissedMinutes:null, dateAdded:null,
  recencySource:null, recencyEvidenceAt:null, observedMinutes:null,
  canonicalGenres:["Adventure"],tags:{Adventure:9},categories:[],
  imageUrl:"/assets/vault/vault-stage-open.png",headerUrl:"/assets/vault/vault-stage-open.png",
  releaseDate:null,playerMode:null,platforms:{windows:null,mac:null,linux:null},deckCompatibility:null,
  duration:{mainStoryMinutes:300,mainExtrasMinutes:null,completionistMinutes:null,source:"hltb",sourceUpdatedAt:null,confidence:null,endless:false},
  durationKind:"finite",durationStatus:"ready",tagsStatus:"ready",
  reviews:{positive:null,negative:null,total:null},price:{currency:null,initial:null,final:null,isFree:null},
  familyOwnerSteamId:null,familyOwnerName:null,
};
const session={logged_in:true,account_type:'manual',identity_verified:false,user_id:'11111111-1111-4111-8111-111111111111',steam_id:'76561198000000000',display_name:'Import tester',steam_display_name:'',avatar_url:'',has_steam_key:true};
const idle={status:'idle',imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null};
async function fixture(page:Page,privateLibrary=false) {
  const posts:Record<string,unknown>[]=[],legacy:string[]=[];
  let started=false,polls=0,done=false,initialChecks=0;
  const card=(gameId:number)=>({gameId,title:`Saved Game ${gameId}`,appId:String(1000+gameId),access:'owned',playtimeMinutes:60,completed:false,blacklisted:false,lastPlayedAt:null,product});
  await page.addInitScript(()=>{localStorage.setItem('vault-cookie-consent','disabled');localStorage.setItem('vault-analytics-notice-seen','1');});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==='/api/app-data')return route.fulfill({json:{session,dataAuthority:'v2',bootstrap:{accountPublicId:session.user_id,libraryRevision:done?'2':'1',stateRevision:'1',ownedTotal:done&&!privateLibrary?201:200,familyTotal:5,pins:[],snoozedIds:[],currentPick:null},pinGames:[],collectionMetadata:[]}});
    if(path==='/api/v2/library')return route.fulfill({json:{items:[card(1),card(2)],total:done&&!privateLibrary?201:200,nextCursor:null,sectionCounts:{active:done&&!privateLibrary?201:200,completed:0,blacklisted:0},filterGenres:[],hasDuration:false,revision:{library:done?'2':'1',state:'1',catalog:'1',features:'1'}}});
    if(path==='/api/v2/family')return route.fulfill({json:{members:[]}});
    if(path==='/api/v2/steam/owned-games') {
      if(request.method()==='POST') {
        posts.push(request.postDataJSON());started=true;polls=0;
        return route.fulfill({json:{progress:{...idle,status:'fetching',startedAt:'2026-09-30T12:00:00Z'},retry_after_seconds:2,private_library:false}});
      }
      if(!started){initialChecks++;return route.fulfill({json:{progress:idle,private_library:false}});}
      polls++;done=polls>=2;
      const progress=done?privateLibrary?{...idle,status:'failed',lastError:'Steam did not share your games list. Make Game details Public, then retry.'}
        :{...idle,status:'complete',imported:201,total:201,percent:100,completedAt:'2026-09-30T12:00:06Z'}:{...idle,status:'fetching'};
      return route.fulfill({json:{progress,retry_after_seconds:2,private_library:done&&privateLibrary}});
    }
    if(path.startsWith('/api/steam/')||path.startsWith('/api/games/')){legacy.push(path);return route.fulfill({status:503,json:{error:'Unexpected legacy request'}});}
    if(path==='/api/session')return route.fulfill({json:session});
    return route.fulfill({json:{}});
  });
  await page.goto('/library',{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeAttached();
  await expect.poll(()=>initialChecks).toBeGreaterThan(0);
  // The bootstrap has no cached cards/pins; whole totals must prevent a false
  // automatic first import while the Library page is still hydrating.
  expect(posts).toHaveLength(0);
  return {posts,legacy,polls:()=>polls};
}
for(const width of [1280,390])test(`V2 Steam refresh enqueues once then polls saved progress (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});const state=await fixture(page);
  await page.locator('summary').filter({hasText:'Import tester'}).click();
  await page.getByRole('button',{name:'Refresh from Steam',exact:true}).click();
  await expect(page.getByText('Reading your Steam library',{exact:true})).toBeVisible();
  await expect(page.getByText('0 of 0 games saved to VaultShuffle.',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'Active 201',exact:true})).toBeVisible({timeout:15000});
  if(!await page.getByRole('button',{name:'Refresh from Steam',exact:true}).isVisible())await page.locator('summary').filter({hasText:'Import tester'}).click();
  await expect(page.getByRole('button',{name:'Refresh from Steam',exact:true})).toBeEnabled();
  expect(state.posts).toHaveLength(1);expect(Object.keys(state.posts[0])).toEqual(['request_key']);expect(String(state.posts[0].request_key)).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.polls()).toBeGreaterThanOrEqual(2);expect(state.legacy).toEqual([]);
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeAttached();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('V2 Steam private response keeps existing Library and presents privacy retry',async({page})=>{
  const state=await fixture(page,true);
  await page.locator('summary').filter({hasText:'Import tester'}).click();await page.getByRole('button',{name:'Refresh from Steam',exact:true}).click();
  await expect(page.getByText('Steam is not sharing your games yet',{exact:true})).toBeVisible({timeout:15000});
  await expect(page.getByRole('button',{name:"I've made it public — try again"})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeAttached();expect(state.posts).toHaveLength(1);expect(state.legacy).toEqual([]);
});
