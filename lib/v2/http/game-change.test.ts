import assert from "node:assert/strict";
import test from "node:test";
import { gameChange } from "./game-change.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

test("game edits are strict bounded owner-free commands", () => {
  assert.deepEqual(gameChange({dismiss_completion:true}),{dismiss_completion:true});
  assert.deepEqual(gameChange({progress:12.5}),{progress:12.5});
  assert.deepEqual(gameChange({restore_decision:{status:"Completed",completed_at:"2026-09-01T10:00:00.123456Z",expected_version:"empty"}}),
    {restore_decision:{status:"Completed",completed_at:"2026-09-01T10:00:00.123456Z",expected_version:"empty"}});
  for (const body of [
    {notes:"x",account_id:1}, {progress:101}, {progress:Infinity}, {dismiss_completion:1},
    {action:"complete",notes:"another independent command"},
    {restore_decision:{status:"Completed",completed_at:null,expected_version:"empty"}},
    {restore_decision:{status:"Blacklisted",completed_at:"2026-09-01T00:00:00Z",expected_version:"empty"}},
    {restore_decision:{status:"Completed",completed_at:"2026-02-31T00:00:00Z",expected_version:"empty"}},
    {restore_decision:{status:"Completed",completed_at:"infinity",expected_version:"empty"}},
    {restore_decision:{status:"Not Started",completed_at:null,expected_version:"forged"}},
  ]) assert.throws(()=>gameChange(body),InvalidPageQueryError);
});
