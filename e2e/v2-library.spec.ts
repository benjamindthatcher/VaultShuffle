import { expect, test, type Page } from "@playwright/test";

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
const session = {logged_in:true,account_type:"manual",identity_verified:false,user_id:"11111111-1111-4111-8111-111111111111",steam_id:"76561198000000000",display_name:"V2 Library tester",steam_display_name:"",avatar_url:"",has_steam_key:false};

async function fixture(page: Page, initial: "active"|"completed"|"blacklisted" = "active", writes: Record<string,unknown>[] = []) {
  const games = Array.from({length:130},(_,index)=>({gameId:index+1,title:`Paged Game ${String(index).padStart(3,"0")}`,appId:String(index+620),playtimeMinutes:null,access:"owned",completed:false,blacklisted:false,lastPlayedAt:null,product:{...product,completedAt:null as string|null}}));
  games[0].completed=initial==="completed"; games[0].blacklisted=initial==="blacklisted";
  games[0].product.completedAt=initial==="completed"?"2026-09-01T10:00:00.123456Z":null;
  let revision=1;
  const counts=()=>({active:games.filter(game=>!game.completed&&!game.blacklisted).length,blacklisted:games.filter(game=>game.blacklisted).length,completed:games.filter(game=>game.completed).length});
  const requests:URL[]=[];
  let restart = true;
  await page.addInitScript(()=>{localStorage.setItem("vault-cookie-consent","disabled");localStorage.setItem("vault-analytics-notice-seen","1");});
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path==="/api/app-data") return route.fulfill({json:{session,dataAuthority:"v2",bootstrap:{accountPublicId:session.user_id,libraryRevision:"1",stateRevision:String(revision),ownedTotal:130,familyTotal:0,pins:[],currentPick:null},pinGames:[]}});
    if(path==="/api/v2/library") {
      requests.push(url);
      const query=url.searchParams.get("search")?.toLowerCase()??"";
      const section=url.searchParams.get("section")??"active";
      const filtered=games.filter(game=>game.title.toLowerCase().includes(query)&&(section==="completed"?game.completed:section==="blacklisted"?game.blacklisted:!game.completed&&!game.blacklisted));
      const cursor=url.searchParams.get("cursor");
      if(cursor && restart) {restart=false;return route.fulfill({status:409,json:{error:"cursor_restart_required",retryable:false}});}
      const offset=Number(cursor??0),limit=Number(url.searchParams.get("limit"));
      return route.fulfill({json:{items:filtered.slice(offset,offset+limit),nextCursor:offset+limit<filtered.length?String(offset+limit):null,total:filtered.length,sectionCounts:counts(),filterGenres:["Adventure"],hasDuration:true,revision:{library:"1",state:String(revision),catalog:"1",features:"1"}}});
    }
    if(path.startsWith("/api/v2/library/")) {
      const game=games.find(game=>game.gameId===Number(path.split("/").at(-1)));
      if(route.request().method()==="PATCH" && game) {
        const body=route.request().postDataJSON(); writes.push(body);
        const restore=body.restore_decision;
        if(restore && restore.expected_version!==String(revision).padStart(32,"0")) return route.fulfill({status:409,json:{error:"state_changed",retryable:false}});
        if(body.action || restore) {
          game.completed=restore?restore.status==="Completed":body.action==="complete";
          game.blacklisted=restore?restore.status==="Blacklisted":body.action==="blacklist";
          game.product.completedAt=restore?restore.completed_at:game.completed?"2026-09-30T12:00:00.000000Z":null;
          revision++;
        }
      }
      return route.fulfill({json:{...game,notes:"Private detail note",description:"On-demand Steam description",mutationVersion:String(revision).padStart(32,"0")}});
    }
    if(path==="/api/v2/steam/owned-games") return route.fulfill({json:{progress:{status:"idle",imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==="/api/session") return route.fulfill({json:session});
    if(path.startsWith("/api/completions")) throw Error("V2 Library must not write legacy completion history");
    if(path.startsWith("/api/games/")) throw Error("V2 Library must not use a legacy game route");
    return route.fulfill({json:{}});
  });
  await page.goto("/library",{waitUntil:"domcontentloaded"});
  await expect(page.getByRole("tab",{name:`Active ${counts().active}`,exact:true})).toBeVisible();
  return requests;
}

for(const width of [1280,390]) {
  test(`V2 Library uses whole counts, bounded pages and on-demand details (${width}px)`,async({page})=>{
    await page.setViewportSize({width,height:844});
    const requests=await fixture(page);
    const cards=page.locator("article[data-game-id]");
    await expect(cards).toHaveCount(60);
    await expect(cards.first()).toContainText("Playtime unavailable");
    await expect(cards.first()).toContainText("— progress");
    await cards.first().getByRole("button",{name:/Details for/}).click();
    await expect(page.getByText("On-demand Steam description",{exact:true})).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Not available");
    await page.keyboard.press("Escape");
    const search=page.getByRole("textbox",{name:"Search games"});
    await search.fill("Paged Game 120");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Paged Game 120");
    await expect(page.getByRole("tab",{name:"Active 130",exact:true})).toBeVisible();
    expect(requests.every(url=>Number(url.searchParams.get("limit"))<=60)).toBe(true);
    expect(requests.at(-1)?.searchParams.get("exclude_pins")).toBe("1");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test("V2 cursor restarts replace the old page chain without duplicate cards",async({page})=>{
  const requests=await fixture(page);
  const cards=page.locator("article[data-game-id]");
  await expect(cards).toHaveCount(60);
  // A restart replaces the scroll container and its sentinel. Resolve the
  // current sentinel each time rather than holding the detached first label.
  await expect.poll(async()=>{
    await page.getByRole("status").filter({hasText:/^Showing/}).evaluateAll(nodes=>nodes.forEach(node=>node.scrollIntoView({block:"end"})));
    return cards.count();
  }).toBeGreaterThan(60);
  expect(requests.filter(url=>!url.searchParams.has("cursor")).length).toBeGreaterThan(1);
  const ids=await cards.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-game-id")));
  expect(new Set(ids).size).toBe(ids.length);
});

for(const width of [1280,390]) {
  test(`V2 Library Complete and Undo restore the active pool (${width}px)`,async({page})=>{
    await page.setViewportSize({width,height:844});
    const writes:Record<string,unknown>[]=[];
    await fixture(page,"active",writes);
    await page.locator('article[data-game-id="1"]').getByRole("button",{name:"Complete",exact:true}).click();
    await page.getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>writes.length).toBe(2);
    expect(writes[0].action).toBe("complete");
    expect(writes[1]).toEqual({restore_decision:{status:"Not Started",completed_at:null,expected_version:"00000000000000000000000000000002"}});
    await expect(page.getByRole("tab",{name:"Active 130",exact:true})).toBeVisible();
    await expect(page.locator('article[data-game-id="1"]')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test("V2 Library Undo Reactivate keeps the original completion instant",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await fixture(page,"completed",writes);
  await page.getByRole("tab",{name:"Completed 1",exact:true}).click();
  await page.locator('article[data-game-id="1"]').getByRole("button",{name:"Reactivate",exact:true}).click();
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[1]).toEqual({restore_decision:{status:"Completed",completed_at:"2026-09-01T10:00:00.123456Z",expected_version:"00000000000000000000000000000002"}});
  await expect(page.getByRole("tab",{name:"Completed 1",exact:true})).toBeVisible();
  await expect(page.locator('article[data-game-id="1"]')).toBeVisible();
});

test("V2 Library Undo Complete returns a game to permanent Blacklist",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  await fixture(page,"blacklisted",writes);
  await page.getByRole("tab",{name:"Blacklisted 1",exact:true}).click();
  await page.locator('article[data-game-id="1"]').getByRole("button",{name:"Complete",exact:true}).click();
  await page.getByRole("button",{name:"Undo",exact:true}).click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[1]).toEqual({restore_decision:{status:"Blacklisted",completed_at:null,expected_version:"00000000000000000000000000000002"}});
  await expect(page.getByRole("tab",{name:"Blacklisted 1",exact:true})).toBeVisible();
  await expect(page.locator('article[data-game-id="1"]')).toBeVisible();
});


test("V2 Library edits preserve loaded depth with fresh bounded pages",async({page})=>{
  const writes:Record<string,unknown>[]=[];
  const requests=await fixture(page,"active",writes);
  const cards=page.locator('article[data-game-id]');
  await expect.poll(async()=>{
    await page.getByRole('status').filter({hasText:/^Showing/}).evaluateAll(nodes=>nodes.forEach(node=>node.scrollIntoView({block:'end'})));
    return cards.count();
  }).toBeGreaterThan(60);
  const count=await cards.count();
  const tail=cards.nth(90);
  await tail.getByRole('button',{name:'Complete',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Active 129',exact:true})).toBeVisible();
  await expect.poll(()=>cards.count()).toBeGreaterThanOrEqual(count);
  // The old second-page area survives the mutation instead of returning to 60.
  await expect(page.locator('article[data-game-id="120"]')).toBeVisible();
  expect(requests.every(url=>Number(url.searchParams.get('limit'))<=60)).toBe(true);
  expect(writes).toHaveLength(1);
});
