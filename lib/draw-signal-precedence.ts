import type { VaultDrawEventType } from "./vault-history.ts";

/**
 * Events where the user stated an opinion about the pick, rather than the model
 * inferring one from behaviour.
 */
export const EXPLICIT_OPINIONS = new Set<string>([
  "opened_on_steam",
  "liked",
  "disliked",
  "pinned",
  "slept",
  "marked_completed"
]);

export function isRerollReason(eventType: string) {
  return eventType.startsWith("reroll_");
}

/**
 * Whether the events on one draw already state an opinion, which makes the bare
 * reroll on that same draw redundant as evidence.
 *
 * Only a reroll reason used to count. So "Not really" followed by "Draw again" —
 * two clicks describing one rejection — was learned as disliked 0/2 plus
 * drew_again 0/1, turning a single no into three units of negative evidence; and
 * "Yes" then "Draw again" recorded 2/2 positive and 0/1 negative about the same
 * pick at the same moment, letting a weak inference contradict an explicit
 * answer. Record every event for analytics, and learn from the strongest
 * available reading of what happened.
 */
export function statesAnOpinion(eventTypes: readonly string[]): boolean {
  return eventTypes.some((eventType) => isRerollReason(eventType) || EXPLICIT_OPINIONS.has(eventType));
}

export type { VaultDrawEventType };
