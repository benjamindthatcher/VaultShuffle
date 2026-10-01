import { expect, test, type Page } from "@playwright/test";

const product={manualProgress:null,completedAt:null,previousActiveStatus:null,reviewRequestedAt:null,completionDismissedAt:null,completionDismissedMinutes:null,dateAdded:null,recencySource:null,recencyEvidenceAt:null,observedMinutes:null,canonicalGenres:["Adventure"],tags:{Adventure:9},categories:[],imageUrl:"/assets/vault/vault-stage-open.png",headerUrl:"/assets/vault/vault-stage-open.png",releaseDate:null,playerMode:null,platforms:{windows:null,mac:null,linux:null},deckCompatibility:null,duration:{mainStoryMinutes:300,mainExtrasMinutes:null,completionistMinutes:null,source:"hltb",sourceUpdatedAt:null,confidence:null,endless:false},durationKind:"finite",durationStatus:"ready",tagsStatus:"ready",reviews:{positive:null,negative:null,total:null},price:{currency:null,initial:null,final:null,isFree:null},familyOwnerSteamId:null,familyOwnerName:null};
const session={logged_in:true,account_type:"manual",identity_verified:false,user_id:"11111111-1111-4111-8111-111111111111",steam_id:"76561198000000000",display_name:"V2 Dashboard tester",steam_display_name:"",avatar_url:"",has_steam_key:false};
function card(id:number) {
  return {gameId:id,title:`Finished Game ${String(id).padStart(3,"0")}`,appId:String(id+620),playtimeMinutes:null,access:"owned",completed:true,blacklisted:false,lastPlayedAt:null,product:{...product,completedAt:"2026-09-29T19:00:00Z"}};
}
async function fixture(page:Page,fail=false,notices=false) {
  const requests:URL[]=[];
  const today=new Date().toISOString().slice(0,10);
  const visit=new Date();visit.setUTCDate(visit.getUTCDate()-3);
  if(notices) await page.addInitScript(iso=>localStorage.setItem("vaultshuffle:last-visit",iso),visit.toISOString());
  const history=Array.from({length:125},(_,index)=>card(index+1));
  await page.addInitScript(()=>localStorage.setItem("vault-cookie-consent","disabled"));
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path==="/api/app-data")return route.fulfill({json:{session,dataAuthority:"v2",bootstrap:{accountPublicId:session.user_id,libraryRevision:"1",stateRevision:"1",ownedTotal:1234,familyTotal:6,pins:[],currentPick:null},pinGames:[]}});
    if(path==="/api/v2/dashboard") {
      requests.push(url);
      if(fail){return route.fulfill({status:503,json:{error:"database_unavailable"}});}
      const filtered=url.searchParams.get("device")==="mac";
      return route.fulfill({json:{revision:{library:"1",state:"1"},aggregates:{ownedGames:filtered?42:1234,familyGames:filtered?1:6,completedGames:filtered?2:50,completedPercent:filtered?5:4,totalMinutes:6000,knownPlaytimeGames:filtered?20:1000,unplayedGames:filtered?8:300,pricedGames:0,libraryValueCents:null,completedValueCents:null,unplayedValueCents:null},completionSummary:{count:notices?64:0,valueCents:notices?64000:0},completionActivity:notices?[{day:today,count:12,games:[{gameId:1001,title:"Recap one"},{gameId:1002,title:"Recap two"}]}]:[],trend:{streakDays:notices?2:0,daysTracked:notices?3:0,minutesLast7Days:notices?180:0,minutesLast30Days:notices?180:0,dailyGains:notices?[{day:today,minutes:180}]:[]},currency:"USD",bestValueGames:[],mostPlayed:[],recentCompletions:history.slice(0,4).map(c=>({gameId:c.gameId,title:c.title,appId:c.appId,playtimeMinutes:null,completedAt:c.product.completedAt,imageUrl:c.product.imageUrl})),completionSuggestions:[],cards:history.slice(0,4),availableExclusions:["puzzle"]}});
    }
    if(path==="/api/v2/library") {
      requests.push(url);
      const offset=Number(url.searchParams.get("cursor")??0),limit=Number(url.searchParams.get("limit"));
      return route.fulfill({json:{items:history.slice(offset,offset+limit),nextCursor:offset+limit<history.length?String(offset+limit):null,total:125,sectionCounts:{active:0,completed:125,blacklisted:0},filterGenres:["Adventure"],hasDuration:true,revision:{library:"1",state:"1",catalog:"1",features:"1"}}});
    }
    if(path.startsWith("/api/v2/library/")) {
      requests.push(url);
      return route.fulfill({json:{...card(Number(path.split("/").at(-1))),notes:"Private detail note",description:"On-demand Dashboard description"}});
    }
    if(path==="/api/v2/steam/owned-games")return route.fulfill({json:{progress:{status:"idle",imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==="/api/session")return route.fulfill({json:session});
    if(path.startsWith("/api/games/"))throw Error("V2 Dashboard must not use a legacy game route");
    return route.fulfill({json:{}});
  });
  await page.goto("/dashboard",{waitUntil:"domcontentloaded"});
  return {requests,recover:()=>{fail=false;}};
}
for(const width of [1280,390])test(`V2 Dashboard uses whole totals and paged history (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const {requests}=await fixture(page);
  const stats=page.getByRole("group",{name:"Library statistics"});
  await expect(stats).toContainText("50 / 1234");
  await expect(page.getByRole("group",{name:"Library value unavailable",exact:true})).toBeVisible();
  await expect(page.getByText("1240",{exact:true})).toBeVisible();
  expect(requests.some(url=>url.pathname==="/api/v2/library")).toBe(false);
  await expect(page.getByRole("status",{name:"Loading",exact:true})).toHaveCount(0);
  await page.screenshot({path:`/private/tmp/vaultshuffle-dashboard-${width}.png`,fullPage:true});
  const mac=page.getByRole("button",{name:"Mac",exact:true});
  await mac.scrollIntoViewIfNeeded();
  await mac.hover();
  await mac.focus();await expect(mac).toBeFocused();
  const position=()=>mac.evaluate(button=>{const r=button.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height};});
  const before=await position();await mac.hover();const after=await position();
  expect(Math.abs(after.y-before.y)).toBeLessThan(1);expect(after.width).toBe(before.width);expect(after.height).toBe(before.height);
  await mac.click();await expect(mac).toHaveAttribute("aria-pressed","true");
  await expect(stats).toContainText("2 / 42");
  await expect(page.getByText("43",{exact:true})).toBeVisible();
  expect(requests.filter(url=>url.pathname==="/api/v2/dashboard").at(-1)?.searchParams.get("device")).toBe("mac");
  await page.getByRole("button",{name:"Completion history",exact:true}).click();
  const panel=page.locator("#completion-history-panel");
  await expect(panel).toContainText("125 finished");
  await expect(panel.getByRole("button",{name:/Open Finished Game/})).toHaveCount(60);
  await panel.getByRole("button",{name:"Load more completions"}).click();
  await expect(panel.getByRole("button",{name:/Open Finished Game/})).toHaveCount(120);
  await panel.getByRole("button",{name:"Load more completions"}).click();
  await expect(panel.getByRole("button",{name:/Open Finished Game/})).toHaveCount(125);
  await panel.getByRole("button",{name:/Open Finished Game 125/}).click();
  await expect(page.getByRole("dialog")).toContainText("On-demand Dashboard description");
  await expect(page.getByRole("dialog")).toContainText("Not available");
  expect(requests.filter(url=>url.pathname==="/api/v2/library").every(url=>Number(url.searchParams.get("limit"))===60)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test("V2 Dashboard failure offers retry without presenting cached partial totals",async({page})=>{
  const {recover}=await fixture(page,true);
  await expect(page.getByRole("alert").filter({hasText:"Your dashboard could not be loaded"})).toBeVisible();
  await expect(page.getByRole("group",{name:"Library statistics"})).toHaveCount(0);
  recover();
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByRole("group",{name:"Library statistics"})).toContainText("50 / 1234");
});

for(const width of [1280,390])test(`V2 notices survive an empty pin cache and bounded highlights (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  await fixture(page,false,true);
  const prompt=page.getByRole("link",{name:/64 games look finished/});
  await expect(prompt).toBeVisible();await expect(prompt).toContainText("$640 worth of games");
  const recap=page.getByRole("region",{name:"Since your last visit"});
  await expect(recap).toContainText("3h played · 12 games finished");
  await expect(recap).toContainText("2-day streak");
  await expect(recap).toContainText("Recap one, Recap two +10");
  await prompt.hover();await prompt.focus();await expect(prompt).toBeFocused();
  await page.screenshot({path:`/private/tmp/vaultshuffle-fixed-notices-${width}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
