import type { DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
export type PurgeCategory = "untouched" | "barely-started" | "dormant";
export type PurgeAction = "keep" | "pin" | "sleep" | "complete";
export type PurgeReview = { id:string; gameId:string; action:PurgeAction; category:PurgeCategory; reviewedAt:string };
export type PurgeCandidate = { game:DemoGame; category:PurgeCategory; reason:string };
export function buildPurgeCandidates({games,pinnedIds,currentPickId,snoozedIds,reviews=[],now=new Date()}:{games:DemoGame[];pinnedIds:string[];currentPickId:string|null;snoozedIds:string[];reviews?:PurgeReview[];now?:Date}):PurgeCandidate[]{
 const protectedIds=new Set([...pinnedIds,...snoozedIds,...(currentPickId?[currentPickId]:[])]);
 const recentlyKept=new Set(reviews.filter(r=>r.action==="keep"&&now.getTime()-Date.parse(r.reviewedAt)<180*86400000).map(r=>r.gameId));
 const result:PurgeCandidate[]=[];for(const game of games){if(game.ownership!=="Owned"||game.status==="Completed"||game.status==="Slept"||protectedIds.has(game.id)||recentlyKept.has(game.id))continue;const added=age(game.addedLabel,now),idle=age(game.lastPlayedLabel,now),duration=context(game);if(game.hoursPlayed===0&&added>=30)result.push({game,category:"untouched",reason:`Untouched since it was added ${formatAge(added)} ago.${duration}`});else if(game.hoursPlayed>0&&game.hoursPlayed<2&&idle>=90)result.push({game,category:"barely-started",reason:`Only ${game.hoursPlayed}h played and inactive for ${formatAge(idle)}.${duration}`});else if(game.hoursPlayed>=2&&idle>=180)result.push({game,category:"dormant",reason:`${game.hoursPlayed}h played, but untouched for ${formatAge(idle)}.${duration}`})}return result
}
function context(game:DemoGame){const label=formatGameDuration(game.duration);return label?` Typical playthrough: ${label.toLowerCase()}.`:""}
function age(label:string,now:Date){const m=label.match(/(\d+)\s*([hdwmy])\s*ago/i);if(m){const f={h:1/24,d:1,w:7,m:30,y:365};return Number(m[1])*f[m[2].toLowerCase() as keyof typeof f]}const t=Date.parse(label.replace(/^Added\s+/i,""));return Number.isFinite(t)?Math.max(0,(now.getTime()-t)/86400000):0}
function formatAge(days:number){return days>=365?`${Math.floor(days/365)}y`:days>=30?`${Math.floor(days/30)}mo`:`${Math.floor(days)}d`}
