import assert from "node:assert/strict";
import test from "node:test";
test("trusted gains start yesterday and gaps cannot sustain a streak",async()=>{
  const {playtimeStreak}=await import('./playtime-summary.ts');
  const now=new Date('2026-08-20T12:00:00Z');
  assert.equal(playtimeStreak([{day:'2026-08-19',minutes:60},{day:'2026-08-18',minutes:10}],now),2);
  assert.equal(playtimeStreak([{day:'2026-08-20',minutes:60},{day:'2026-08-18',minutes:10}],now),1);
  assert.equal(playtimeStreak([{day:'2026-08-18',minutes:60}],now),0);
});
