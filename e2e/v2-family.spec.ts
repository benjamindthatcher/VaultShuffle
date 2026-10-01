import {expect,test,type Page} from '@playwright/test';
const session={logged_in:true,account_type:'manual',identity_verified:false,user_id:'11111111-1111-4111-8111-111111111111',steam_id:'76561198000000000',display_name:'Family tester',steam_display_name:'',avatar_url:'',has_steam_key:false};
const member={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',steamId:'76561198000000101',displayName:'Alex',avatarUrl:null,profileUrl:'https://steamcommunity.com/profiles/76561198000000101',librarySeen:120,gamesImported:99,lastSyncedAt:'2026-09-30T12:00:00.123456Z',lastError:null};
async function fixture(page:Page,fail=false) {
  const members=[{...member}],writes:{path:string;body:unknown}[]=[],legacy:string[]=[];
  let familyCount=99;
  await page.addInitScript(()=>localStorage.setItem('vault-cookie-consent','disabled'));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/app-data')return route.fulfill({json:{session,dataAuthority:'v2',bootstrap:{accountPublicId:session.user_id,libraryRevision:'1',stateRevision:'1',ownedTotal:500,familyTotal:familyCount,pins:[],snoozedIds:[],currentPick:null},pinGames:[],collectionMetadata:[]}});
    if(path==='/api/v2/dashboard')return route.fulfill({json:{revision:{library:'1',state:'1'},aggregates:{ownedGames:500,familyGames:familyCount,completedGames:0,completedPercent:0,totalMinutes:0,knownPlaytimeGames:0,unplayedGames:0,pricedGames:0,libraryValueCents:null,completedValueCents:null,unplayedValueCents:null},trend:{daysTracked:0,minutesLast7Days:0,minutesLast30Days:0,dailyGains:[]},currency:'USD',bestValueGames:[],mostPlayed:[],recentCompletions:[],completionSuggestions:[],cards:[],availableExclusions:[]}});
    if(path==='/api/v2/family') {
      if(request.method()==='GET')return route.fulfill({json:{members}});
      writes.push({path,body:request.postDataJSON()});
      if(fail)return route.fulfill({status:400,json:{error:"That profile's Game details are private.",code:'library_private'}});
      const added={...member,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',displayName:'Sam',gamesImported:3,librarySeen:5};members.push(added);familyCount=102;
      return route.fulfill({json:{ok:true,member:added,counts:{seen:5,importable:3,alreadyOwned:1,excluded:0,pending:1},summary:"5 games on Sam's shelf — 3 look shareable, 1 you already own, 1 still being checked."}});
    }
    if(path==='/api/v2/family/sync'){writes.push({path,body:null});return route.fulfill({json:{ok:true,counts:{seen:125,importable:102,alreadyOwned:1,excluded:21,pending:1}}});}
    if(path.startsWith('/api/v2/family/')&&request.method()==='DELETE') {
      writes.push({path,body:null});members.splice(members.findIndex(row=>row.id===path.split('/').at(-1)),1);familyCount=99;
      return route.fulfill({json:{removed:3,retained:0,displayName:'Sam'}});
    }
    if(path.startsWith('/api/family')){legacy.push(path);return route.fulfill({status:503,json:{error:'Legacy Family route called'}});}
    if(path==='/api/v2/steam/owned-games')return route.fulfill({json:{progress:{status:'idle',imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==='/api/session')return route.fulfill({json:session});
    return route.fulfill({json:{}});
  });
  await page.goto('/dashboard',{waitUntil:'domcontentloaded'});
  const panel=page.getByRole('region',{name:'Family library Experimental'});
  await expect(panel.getByRole('link',{name:'Alex'})).toBeVisible();
  return {panel,writes,legacy};
}
for(const width of [1280,390])test(`V2 Family whole count, add, re-check and removal (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const {panel,writes,legacy}=await fixture(page);
  await expect(panel).toContainText('99family games');
  const input=panel.getByLabel('Steam profile URL or 17-digit Steam ID');await input.fill('76561198000000102');
  const add=panel.getByRole('button',{name:'Add person'});await add.focus();await expect(add).toBeFocused();await add.hover();await add.click();
  await expect(panel.getByRole('link',{name:'Sam'})).toBeVisible();await expect(panel).toContainText('102family games');
  expect(writes[0]).toEqual({path:'/api/v2/family',body:{profile:'76561198000000102'}});
  await panel.getByRole('button',{name:'Re-check family library'}).click();await expect(panel.getByRole('status')).toContainText('102 shareable, 1 still waiting');
  await panel.getByRole('button',{name:'Remove Sam',exact:true}).click();await panel.getByRole('button',{name:'Remove',exact:true}).click();
  await expect(panel.getByRole('link',{name:'Sam'})).toHaveCount(0);await expect(panel.getByRole('link',{name:'Alex'})).toBeVisible();
  await expect(panel).toContainText('99family games');expect(writes.map(row=>row.path)).toEqual(['/api/v2/family','/api/v2/family/sync','/api/v2/family/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);expect(legacy).toEqual([]);
  await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`/private/tmp/vaultshuffle-v2-family-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('V2 Family private response preserves roster and unsaved input',async({page})=>{
  const {panel,writes,legacy}=await fixture(page,true);
  const input=panel.getByLabel('Steam profile URL or 17-digit Steam ID');await input.fill('76561198000000102');await panel.getByRole('button',{name:'Add person'}).click();
  await expect(panel.getByRole('status')).toContainText('Game details are private');await expect(input).toHaveValue('76561198000000102');
  await expect(panel.getByRole('link',{name:'Alex'})).toBeVisible();expect(writes).toHaveLength(1);expect(legacy).toEqual([]);
});
