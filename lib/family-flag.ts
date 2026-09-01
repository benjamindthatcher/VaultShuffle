/**
 * Steam Families is off unless the environment turns it on.
 *
 * Not a permanent config knob - a stay-local switch while the feature is still
 * experimental. main deploys straight to production on push, so an unfinished
 * feature needs something stronger than "nobody has linked to it yet": the
 * variable is set in .env.local and nowhere in Vercel, so every route and every
 * surface behind this flag is inert in production even after the branch lands.
 *
 * NEXT_PUBLIC_ so the same answer is available on the server, where it guards
 * the API, and in the browser, where it decides whether the dashboard card
 * exists at all. It is inlined at build time, so flipping it means a rebuild -
 * which is the right cost for a switch that is meant to be deliberate.
 *
 * To work on it locally:  NEXT_PUBLIC_FAMILY_SHARING=1  in .env.local
 */
export const FAMILY_SHARING_ENABLED = process.env.NEXT_PUBLIC_FAMILY_SHARING === "1";

export class FamilyDisabledError extends Error {
  readonly code = "family_disabled";

  constructor() {
    super("Steam Families is not available yet.");
    this.name = "FamilyDisabledError";
  }
}

/** Called first in every family route, so a stray request 404s rather than running. */
export function assertFamilySharingEnabled() {
  if (!FAMILY_SHARING_ENABLED) throw new FamilyDisabledError();
}
