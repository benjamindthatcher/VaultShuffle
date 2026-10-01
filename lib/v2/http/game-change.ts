import { z } from "zod";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

const instant = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19));
const version = z.string().regex(/^(empty|[0-9a-f]{32})$/);
const schema = z.union([
  z.object({ action: z.enum(["complete", "blacklist", "reactivate"]), request_key: z.string().uuid().optional(), surface:z.enum(["library","vault"]).optional() }).strict(),
  z.object({ notes: z.string().max(10000).nullable() }).strict(),
  z.object({ progress: z.number().finite().min(0).max(100).nullable() }).strict(),
  z.object({ dismiss_completion: z.boolean() }).strict(),
  z.object({ restore_decision: z.object({ status: z.enum(["Completed", "Blacklisted", "In Progress", "Not Started"]), completed_at: instant.nullable(), expected_version: version }).strict()
    .refine(value => value.status === "Completed" ? value.completed_at !== null : value.completed_at === null) }).strict(),
]);

export function gameChange(body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success) throw new InvalidPageQueryError();
  return result.data;
}
