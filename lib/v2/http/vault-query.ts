import { z } from "zod";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";
import { libraryGlobalFilters } from "../repositories/library-global-filters.ts";
import type { GlobalFilters } from "../../global-filters.ts";
import type { VaultSetup, VaultDrawRequest } from "../vault.ts";
import { DEFAULT_GLOBAL_FILTERS } from "../../global-filters.ts";

const gameId = z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => Number(value) <= 2147483647);
const ids = z.array(gameId).max(10000).transform(values => [...new Set(values)]);
const setup = z.object({
  session: z.enum(["short", "evening", "weekend"]).nullable(),
  mood: z.enum(["brain-off", "chill", "intense"]).nullable(),
  goal: z.enum(["new", "finish", "surprise"]).nullable(),
  collectionId: z.string().uuid().nullable(),
  genres: z.array(z.string().trim().min(1).max(80)).max(3).transform(values => [...new Set(values)]),
  globalFilters: z.unknown(), deferredIds: ids,
}).strict();
const draw = setup.extend({ requestKey: z.string().uuid(), quick: z.boolean(), arm: z.enum(["test", "control"]),
  previousId: gameId.nullable(), cycleIds: ids, excludeIds: ids }).strict();

export function vaultSetup(body: unknown): VaultSetup {
  const result = setup.safeParse(body);
  if (!result.success) throw new InvalidPageQueryError();
  return validate(result.data) as VaultSetup;
}
export function vaultDrawRequest(body: unknown): VaultDrawRequest {
  const result = draw.safeParse(body);
  if (!result.success) throw new InvalidPageQueryError();
  const value = validate(result.data) as VaultDrawRequest;
  if (!value.quick && !value.collectionId && (!value.session || !value.mood || !value.goal)) throw new InvalidPageQueryError("Complete the draw setup first.");
  return value;
}
function validate<T extends { collectionId: string | null; session: unknown; mood: unknown; goal: unknown; genres: string[]; globalFilters: unknown }>(value: T) {
  if (value.collectionId && (value.session || value.mood || value.goal || value.genres.length)) throw new InvalidPageQueryError();
  // The parser refuses unknown owner/selection/score fields. Global filters use
  // the same canonical validation and SQL predicate as the Library.
  if (!value.globalFilters || typeof value.globalFilters !== "object" || Array.isArray(value.globalFilters)
    || Object.keys(value.globalFilters).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_GLOBAL_FILTERS,key))) throw new InvalidPageQueryError();
  return { ...value, globalFilters: libraryGlobalFilters(value.globalFilters as GlobalFilters) };
}
