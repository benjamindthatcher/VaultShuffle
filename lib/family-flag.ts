/**
 * The off switch for Steam Families.
 *
 * This started life the other way round - off unless explicitly enabled - which
 * was right while the schema change was still unapplied and the code had never
 * touched a real database. Both of those are now done: the columns, the table
 * and the two functions are live, verified against production, and the rule that
 * matters (a family sync can never overwrite a game you own) has been exercised
 * against real rows.
 *
 * At that point "off by default" stopped protecting anything and started costing
 * something. Every environment variable here lives in Vercel, so an opt-in flag
 * meant the feature could not be used at all without a dashboard edit and a
 * redeploy - which is friction spent on a feature that is already safe to run.
 *
 * So it ships on, and the variable becomes the kill switch it was always really
 * for: set NEXT_PUBLIC_FAMILY_SHARING=0 in Vercel and redeploy to take every
 * surface and every route out of the product in one move, without a revert.
 *
 * Worth knowing about what is NOT behind this flag: user_games.access_source is
 * read by the Steam import on every refresh, for everybody, regardless of this
 * value. Turning the feature off hides the family UI; it does not put the
 * database back. That is deliberate - the column defaults to 'owned' and the
 * import filters on it, so an account that never touches this feature behaves
 * exactly as it did before.
 */
export const FAMILY_SHARING_ENABLED = process.env.NEXT_PUBLIC_FAMILY_SHARING !== "0";

export class FamilyDisabledError extends Error {
  readonly code = "family_disabled";

  constructor() {
    super("Steam Families is not available.");
    this.name = "FamilyDisabledError";
  }
}

/** Called first in every family route, so a killed feature 404s rather than running. */
export function assertFamilySharingEnabled() {
  if (!FAMILY_SHARING_ENABLED) throw new FamilyDisabledError();
}
