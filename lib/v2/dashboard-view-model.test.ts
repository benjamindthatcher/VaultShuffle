import assert from "node:assert/strict";
import test from "node:test";
import { dashboardStats } from "./dashboard-view-model.ts";
import { formatMoney } from "../backlog-stats.ts";
import type { DashboardPayload } from "./repositories/dashboard-core.ts";

const payload:DashboardPayload={revision:{library:'1',state:'1'},aggregates:{ownedGames:10000,familyGames:500,completedGames:125,completedPercent:1,totalMinutes:600000,knownPlaytimeGames:10000,unplayedGames:1000,pricedGames:0,libraryValueCents:null,completedValueCents:null,unplayedValueCents:null},completionSummary:{count:0,valueCents:0},completionActivity:[],trend:{streakDays:0,daysTracked:0,minutesLast7Days:0,minutesLast30Days:0,dailyGains:[]},currency:'USD',bestValueGames:[],mostPlayed:[],recentCompletions:[],completionSuggestions:[],cards:[],availableExclusions:[]};
test("Dashboard reports whole SQL totals and distinguishes unknown money from zero",()=>{
  const stats=dashboardStats(payload);
  assert.equal(stats.totalGames,10000);assert.equal(stats.totalHours,10000);assert.equal(stats.completedGames,125);
  assert.equal(stats.valueCompletedPercent,null);assert.equal(formatMoney(stats.libraryValueCents),'—');
  assert.equal(formatMoney(0),'$0.00');
  const unknown=dashboardStats({...payload,aggregates:{...payload.aggregates,totalMinutes:0,knownPlaytimeGames:0}});
  assert.equal(unknown.totalHours,null);assert.equal(unknown.hoursCoverage,'across 0 games with playtime');
  assert.equal(dashboardStats({...payload,aggregates:{...payload.aggregates,libraryValueCents:10000,completedValueCents:2500}}).valueCompletedPercent,25);
});
