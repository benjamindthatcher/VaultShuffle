import type { VaultDrawEventType } from "./vault-history.ts";

/**
 * Events where the user stated an opinion about the pick, rather than the model
 * inferring one from behaviour.
 */
export const EXPLICIT_OPINIONS = new Set<string>([
  "opened_on_steam",
  "play_now_intent",
  "liked",
  "disliked",
  "pinned",
  "slept",
  // Snoozing states a view about the pick, so the reroll that follows it is the
  // same rejection said twice rather than a second piece of evidence.
  "hidden_for_session",
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

/** One immediate commitment per draw; a later outcome is still independent. */
export function shouldLearnDrawEvent(eventType: string, eventTypes: readonly string[]) {
  if (eventType === "drew_again" && statesAnOpinion(eventTypes)) return false;
  const commitments = ["opened_on_steam", "play_now_intent", "pinned", "liked"];
  const chosen = commitments.find((candidate) => eventTypes.includes(candidate));
  if (commitments.includes(eventType) && eventType !== chosen) return false;
  return true;
}

/** A Playing Next row created by the same Vault click is not another vote. */
export function isSeparatePlayingNextCommitment(pinnedAt: string, drawCommitmentTimes: readonly string[]) {
  const pinnedMs = new Date(pinnedAt).getTime();
  if (!Number.isFinite(pinnedMs)) return false;
  return !drawCommitmentTimes.some((time) => {
    const eventMs = new Date(time).getTime();
    return Number.isFinite(eventMs) && Math.abs(pinnedMs - eventMs) <= 5 * 60_000;
  });
}

export type { VaultDrawEventType };
