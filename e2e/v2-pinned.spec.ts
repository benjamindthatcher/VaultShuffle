import {expect,test,type Page} from '@playwright/test';
import { checkPreviewClose } from "./preview-close";

test("Playing Next preview close remains reachable while scrolling", async ({ page }, testInfo) => {
  const { shelf } = await fixture(page);
  await checkPreviewClose(page, shelf.getByRole("button", { name: /^Pinned Adventure/ }), `pinned-close-${testInfo.project.name}`);
});
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
const session={logged_in:true,account_type:'manual',identity_verified:false,user_id:'11111111-1111-4111-8111-111111111111',steam_id:'76561198000000000',display_name:'Pin tester',steam_display_name:'',avatar_url:'',has_steam_key:true};
async function fixture(page:Page,failure=false) {
  const posts:unknown[]=[],legacy:string[]=[];let refreshed=false,release:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const card=()=>({gameId:1,title:'Pinned Adventure',appId:'100001',access:'owned',playtimeMinutes:refreshed?120:60,
    completed:false,blacklisted:false,lastPlayedAt:null,manualProgress:12,product:{...product,manualProgress:12}});
  await page.addInitScript(()=>{localStorage.setItem('vault-cookie-consent','disabled');localStorage.setItem('vault-analytics-notice-seen','1');});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/app-data')return route.fulfill({json:{session,dataAuthority:'v2',bootstrap:{accountPublicId:session.user_id,
      libraryRevision:'1',stateRevision:'1',ownedTotal:200,familyTotal:0,pins:[{slot:1,gameId:1,title:'Pinned Adventure',pinnedAt:'2026-09-29T12:00:00Z',personalMinutesBaseline:60}],snoozedIds:[],currentPick:null},pinGames:[card()],collectionMetadata:[]}});
    if(path==='/api/v2/library')return route.fulfill({json:{items:[card()],total:200,nextCursor:null,
      sectionCounts:{active:200,completed:0,blacklisted:0},filterGenres:[],hasDuration:true,
      revision:{library:refreshed?'2':'1',state:'1',catalog:'1',features:'1'}}});
    if(path==='/api/v2/family')return route.fulfill({json:{members:[]}});
    if(path==='/api/v2/steam/owned-games')return route.fulfill({json:{progress:{status:'idle',imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==='/api/v2/steam/pinned-playtime') {
      posts.push(request.postDataJSON());await waiting;
      if(failure)return route.fulfill({status:422,json:{error:'Steam did not share readable playtime. Your saved playtime has not changed.',code:'library_unavailable'}});
      refreshed=true;
      return route.fulfill({json:{games:[card()],refreshed:1,skipped:0,refreshedAt:'2026-09-30T12:00:00Z',retryAfterSeconds:60}});
    }
    if(path.startsWith('/api/steam/')||path.startsWith('/api/games/')){legacy.push(path);return route.fulfill({status:503,json:{error:'Unexpected legacy request'}});}
    return route.fulfill({json:{}});
  });
  await page.goto('/library',{waitUntil:'domcontentloaded'});
  const shelf=page.getByRole('region',{name:'Playing Next',exact:true});
  await expect(shelf.getByRole('button',{name:'Refresh Playing Next game playtime',exact:true})).toBeVisible();
  return {posts,legacy,release,shelf};
}
for(const width of [1280,390])test(`V2 pins refresh once with bounded response and unchanged commitments (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});const state=await fixture(page);
  const refresh=state.shelf.getByRole('button',{name:'Refresh Playing Next game playtime',exact:true});
  await refresh.focus();await expect(refresh).toBeFocused();await refresh.hover();await refresh.click();
  await expect(state.shelf.getByRole('button',{name:'Refreshing Playing Next game playtime',exact:true})).toBeDisabled();
  await expect.poll(()=>state.posts.length).toBe(1);state.release();
  await expect(state.shelf.getByRole('status')).toContainText('Playtime updated for 1 Playing Next game');
  await expect(state.shelf.getByRole('button',{name:/Refresh Playing Next game playtime in/})).toBeDisabled();
  await expect(state.shelf).toContainText('1 of 3');
  await expect(state.shelf).toContainText('Pinned Adventure');
  await expect(state.shelf).toContainText('1.0h played since choosing');
  expect(state.posts).toEqual([{}]);expect(state.legacy).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/private/tmp/vaultshuffle-v2-pinned-${width}.png`,fullPage:true});
});
test('V2 private pin refresh keeps current progress and cooldown guidance',async({page})=>{
  const state=await fixture(page,true);
  await state.shelf.getByRole('button',{name:'Refresh Playing Next game playtime',exact:true}).click();
  state.release();await expect(state.shelf.getByRole('status')).toContainText('Your saved playtime has not changed.');
  await expect(state.shelf).toContainText('Pinned Adventure');
  await expect(state.shelf.getByRole('button',{name:/Refresh Playing Next game playtime in/})).toBeDisabled();
  expect(state.posts).toEqual([{}]);expect(state.legacy).toEqual([]);
});
