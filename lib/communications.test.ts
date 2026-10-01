import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { DuplicateSubmissionError, SubmissionStorageError } from "./v2/repositories/support-core.ts";
import type { VerifiedServerPrincipal } from "./v2/db/client.ts";

const require = createRequire(import.meta.url);
const principal: VerifiedServerPrincipal = {
  accountId: 7, accountPublicId: "77777777-7777-4777-8777-777777777777",
  accountKind: "manual", sessionId: "17", sessionKind: "manual", identityVerified: false,
};
const feedback = { feedback_type: "bug", message: "A synthetic bug report.", contact_allowed: false, form_started_at: 1 };
const contact = { enquiry_type: "technical", email: "fixture@example.invalid", subject: "Synthetic report", message: "A synthetic contact message.", form_started_at: 1 };

function communications(storageFailure?: Error) {
  const calls: { kind: string; principal: unknown; input: Record<string, unknown> }[] = [];
  const support = Object.fromEntries(["contact", "feedback"].map(kind => [kind, async (principal: unknown, input: Record<string, unknown>) => {
    if (storageFailure) throw storageFailure;
    calls.push({ kind, principal, input });
  }]));
  const compiled = ts.transpileModule(readFileSync(new URL("./communications.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const imports: Record<string, unknown> = {
    "node:crypto": require("node:crypto"), "@/lib/rate-limit": {},
    "@/lib/supabase": { getSupabaseAdmin: () => { throw Error("V2 submission reached the retired database"); } },
    "@/lib/database-authority": { isV2Authority: () => true },
    "@/lib/v2/runtime": { getV2Runtime: async () => ({ support }) },
    "@/lib/v2/repositories/support-core": { DuplicateSubmissionError, SubmissionStorageError },
  };
  const loaded = { exports: {} as {
    saveFeedback: (id: string | null, fingerprint: string, input: typeof feedback, principal?: VerifiedServerPrincipal | null) => Promise<void>;
    saveContactMessage: (id: string | null, fingerprint: string, input: typeof contact, principal?: VerifiedServerPrincipal | null) => Promise<void>;
  } };
  new Function("require", "module", "exports", "fetch", compiled)((name: string) => {
    assert.ok(name in imports, `Unexpected communications import: ${name}`);
    return imports[name];
  }, loaded, loaded.exports, async () => new Response(null, { status: 200 }));
  return { ...loaded.exports, calls };
}

test("contact and feedback use V2 storage with verified attribution and guest support", async () => {
  const service = communications();
  await service.saveContactMessage(principal.accountPublicId, "synthetic-fingerprint", contact, principal);
  await service.saveFeedback(null, "synthetic-fingerprint", feedback);
  assert.equal(service.calls.length, 2);
  assert.equal(service.calls[0].principal, principal);
  assert.equal(service.calls[0].input.enquiry_type, 3);
  assert.equal(service.calls[1].principal, null);
  assert.equal(service.calls[1].input.feedback_type, 1);
  assert.equal(service.calls[1].input.contact_email, null);
  for (const call of service.calls) assert.match(String(call.input.dedupe_hash), /^[0-9a-f]{64}$/);
});

test("V2 duplicate and storage failures retain their response classification without legacy fallback", async () => {
  const duplicate = new DuplicateSubmissionError("Already sent");
  await assert.rejects(() => communications(duplicate).saveFeedback(null, "synthetic", feedback), error => error === duplicate);
  await assert.rejects(() => communications(duplicate).saveContactMessage(null, "synthetic", contact), error => error === duplicate);
  for (const kind of ["feedback", "contact"] as const) {
    const service = communications(new Error("Synthetic database failure"));
    await assert.rejects(() => kind === "feedback"
      ? service.saveFeedback(null, "synthetic", feedback)
      : service.saveContactMessage(null, "synthetic", contact), SubmissionStorageError);
  }
});
