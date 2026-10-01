import { expect, test, type Page } from "@playwright/test";
import { checkPreviewClose } from "./preview-close";

test("Wishlist preview close remains reachable while scrolling", async ({ page }, testInfo) => {
  const { release } = await fixture(page);
  release();
  await checkPreviewClose(page, page.getByRole("button", { name: "Details for Borrowed adventure", exact: true }), `wishlist-close-${testInfo.project.name}`);
});
import { encodeCatalogue } from "../lib/catalogue-wire";

const session={logged_in:true,account_type:"manual",identity_verified:false,user_id:"11111111-1111-4111-8111-111111111111",steam_id:"76561198000000000",display_name:"Wishlist tester",steam_display_name:"",avatar_url:"",has_steam_key:false};
const catalogue=["Owned adventure","Borrowed adventure","Played inspiration Deluxe Edition","Amber Valley","Clockwork Harbor","Crimson Railway","Desert Bloom","Echo Island","Forest Keeper","Garden Maze","Hidden Mountain","Ivory Tower"]
  .map((title,index)=>({appId:1000+index,title,image:"/assets/vault/vault-stage-open.png",genres:["Adventure"],tags:{Adventure:100},minutes:240,positive:950,reviews:1000}));
async function fixture(page:Page,fail=false) {
  let release:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const requests:string[]=[];
  await page.emulateMedia({reducedMotion:"no-preference"});
  await page.addInitScript(()=>localStorage.setItem("vault-cookie-consent","disabled"));
  await page.route("**/wishlist-catalogue*",route=>route.fulfill({json:encodeCatalogue(catalogue)}));
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;requests.push(path);
    if(path==="/api/app-data")return route.fulfill({json:{session,dataAuthority:"v2",bootstrap:{accountPublicId:session.user_id,libraryRevision:"1",stateRevision:"1",ownedTotal:2000,familyTotal:20,pins:[],currentPick:null},pinGames:[]}});
    if(path==="/api/v2/wishlist/library-context"){
      await waiting;
      if(fail)return route.fulfill({status:503,json:{error:"database_unavailable"}});
      return route.fulfill({json:{appIds:[1000,1001,9999],editionKeys:["owned adventure","borrowed adventure","played inspiration"],seeds:[{steamAppId:9999,title:"Played inspiration",status:"Completed",hoursPlayed:12,accessSource:"owned",genres:["Adventure"],tagProfile:{Adventure:100}}]}});
    }
    if(path==="/api/wishlist")return route.fulfill({json:{games:[catalogue[1]],appIds:[1001],total:1}});
    if(path==="/api/wishlist/search")return route.fulfill({json:{games:catalogue.slice(0,3)}});
    if(path==="/api/wishlist/details")return route.fulfill({json:{games:[]}});
    if(path==="/api/v2/steam/owned-games")return route.fulfill({json:{progress:{status:"idle",imported:0,total:0,percent:0,playHistoryMissing:false,lastError:null,startedAt:null,completedAt:null}}});
    if(path==="/api/session")return route.fulfill({json:session});
    return route.fulfill({json:{}});
  });
  await page.goto("/wishlist",{waitUntil:"domcontentloaded"});
  return {release,requests,recover:()=>{fail=false;}};
}
for(const width of [1280,390])test(`V2 Wishlist checks complete ownership and restores taste on a cold visit (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:844});
  const {release,requests}=await fixture(page);
  const recommendations=page.getByRole("region",{name:"Worth a spot on your wishlist"});
  const loader=recommendations.getByRole("status",{name:"Loading recommendations"});
  await expect(loader).toBeVisible();
  await expect(recommendations.locator("article")).toHaveCount(0);
  await expect.poll(()=>loader.locator("video").evaluate(video=>video instanceof HTMLVideoElement&&!video.paused&&video.currentTime>0)).toBe(true);
  release();
  await expect(recommendations.locator("article")).toHaveCount(9);
  for(const id of [1000,1001,1002])await expect(recommendations.locator(`[data-appid="${id}"]`)).toHaveCount(0);
  await expect(recommendations).toContainText("Played inspiration");
  const saved=page.getByRole("region",{name:"Your wishlist 1"});
  await expect(saved).toContainText("Already in your library");
  await page.getByRole("searchbox").fill("adventure");await page.getByRole("button",{name:"Search",exact:true}).click();
  const results=page.getByRole("region",{name:"Results for “adventure”"});
  await expect(results.locator("article")).toHaveCount(3);
  for(const id of [1000,1002])await expect(results.locator(`[data-appid="${id}"]`)).toContainText("Already in your library");
  const style=page.getByRole("button",{name:"For you",exact:true});
  await style.scrollIntoViewIfNeeded();await style.hover();await style.focus();await expect(style).toBeFocused();
  await expect(style).toHaveAttribute("aria-pressed","true");
  await page.screenshot({path:`/private/tmp/vaultshuffle-fixed-wishlist-${width}.png`,fullPage:true});
  expect(requests.includes("/api/v2/library")).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test("V2 Wishlist ownership failure offers retry instead of recommending owned games",async({page})=>{
  const {release,recover}=await fixture(page,true);release();
  const recommendations=page.getByRole("region",{name:"Worth a spot on your wishlist"});
  await expect(recommendations.getByRole("alert")).toContainText("Your library could not be checked");
  await expect(recommendations.locator("article")).toHaveCount(0);
  recover();await recommendations.getByRole("button",{name:"Try again",exact:true}).click();
  await expect(recommendations.locator("article")).toHaveCount(9);
  await expect(recommendations.locator('[data-appid="1000"]')).toHaveCount(0);
});

test("VaultShuffle loader respects reduced motion and keeps the static brand visible",async({page})=>{
  const {release}=await fixture(page);
  await page.emulateMedia({reducedMotion:"reduce"});
  const loader=page.getByRole("status",{name:"Loading recommendations"});
  await expect(loader).toBeVisible();
  await expect(loader.locator("video")).toBeHidden();
  await expect(loader.locator('span[aria-hidden="true"]')).toBeVisible();
  release();
  await expect(page.getByRole("region",{name:"Worth a spot on your wishlist"}).locator("article")).toHaveCount(9);
  await expect(loader).toHaveCount(0);
});
