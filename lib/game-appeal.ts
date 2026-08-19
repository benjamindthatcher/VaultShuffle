/**
 * How much a game stands out on its own merits, independent of the player's setup.
 *
 * Session, mood and goal answer "does this fit what you asked for". This answers a
 * different question: of the games that fit, which are actually worth your evening?
 * A backlog is mostly things bought on sale and never opened, so "everyone loves
 * this" and "almost nobody has played this but the few who did adored it" are both
 * genuinely useful reasons to surface something.
 *
 * Steam review counts are the only signal available at scale — popularity_rank and
 * popularity_ccu are empty for every row in the catalogue — and they are heavily
 * skewed: across a real 234-game library the median is 622 reviews and the maximum
 * is 9.8 million. Everything here works in log space for that reason.
 */

export type GameAppealInput = {
  reviewPositive?: number | null;
  reviewNegative?: number | null;
  reviewTotal?: number | null;
};

export type GameAppealKind = "phenomenon" | "acclaimed" | "hidden-gem" | "divisive" | null;

export type GameAppeal = {
  /** 0-1: how widely played and talked about, tempered by whether it was liked. */
  hype: number;
  /** 0-1: adored by the few who played it. */
  hiddenGem: number;
  /** Share of reviews that are positive, or null when there is nothing to go on. */
  positivity: number | null;
  reviewTotal: number;
  points: number;
  kind: GameAppealKind;
};

/** Bounded well under the ±8 taste term: this is about the game, not about you. */
export const MAX_APPEAL_POINTS = 6;

/**
 * Below this a percentage is noise rather than a verdict — three positive reviews
 * is 100% and means nothing.
 */
const MIN_TRUSTED_REVIEWS = 50;

export function gameAppeal(input: GameAppealInput): GameAppeal {
  const reviewTotal = Math.max(0, Number(input.reviewTotal ?? 0));
  const positive = Math.max(0, Number(input.reviewPositive ?? 0));
  const positivity = reviewTotal > 0 ? Math.min(1, positive / reviewTotal) : null;
  const trusted = reviewTotal >= MIN_TRUSTED_REVIEWS && positivity !== null;

  const volume = Math.log10(Math.max(1, reviewTotal));
  // ~300 reviews scores nothing, a million scores full marks. Chosen against the
  // real distribution: the 90th percentile of a typical library sits near 77,000.
  const reach = clamp((volume - 2.5) / 3.5, 0, 1);
  // Being widely played only counts as hype if people also liked it.
  const liked = positivity === null ? 0.5 : clamp((positivity - 0.5) / 0.35, 0, 1);
  const hype = trusted ? reach * liked : 0;

  // Adored (80% is the floor, 100% the ceiling) and genuinely obscure (4,000
  // reviews scores nothing, 40 scores full marks).
  const quality = positivity === null ? 0 : clamp((positivity - 0.8) / 0.2, 0, 1);
  const obscurity = clamp((3.6 - volume) / 2, 0, 1);
  const hiddenGem = trusted ? quality * obscurity : 0;

  let points = 4 * hype + 4 * hiddenGem;
  // A game most people disliked is a poor way to spend an evening, and saying so
  // is more useful than silently ranking it alongside everything else.
  if (trusted && positivity !== null && positivity < 0.55) points -= 3;

  return {
    hype,
    hiddenGem,
    positivity,
    reviewTotal,
    points: clamp(points, -MAX_APPEAL_POINTS, MAX_APPEAL_POINTS),
    kind: appealKind({ hype, hiddenGem, positivity, trusted })
  };
}

function appealKind({
  hype,
  hiddenGem,
  positivity,
  trusted
}: { hype: number; hiddenGem: number; positivity: number | null; trusted: boolean }): GameAppealKind {
  if (!trusted || positivity === null) return null;
  if (positivity < 0.55) return "divisive";
  if (hiddenGem >= 0.3) return "hidden-gem";
  if (hype >= 0.6) return "phenomenon";
  if (hype >= 0.3 && positivity >= 0.9) return "acclaimed";
  return null;
}

export function appealLabel(kind: GameAppealKind) {
  if (kind === "phenomenon") return "Everyone has played this";
  if (kind === "acclaimed") return "Widely loved";
  if (kind === "hidden-gem") return "Hidden gem";
  if (kind === "divisive") return "Divisive";
  return null;
}

/** The sentence that backs the label up with the numbers behind it. */
export function appealDetail(appeal: GameAppeal) {
  const percent = appeal.positivity === null ? null : Math.round(appeal.positivity * 100);
  const reviews = formatReviewCount(appeal.reviewTotal);
  if (appeal.kind === "phenomenon") return `${percent}% positive across ${reviews} reviews — this one is a landmark.`;
  if (appeal.kind === "acclaimed") return `${percent}% positive across ${reviews} reviews.`;
  if (appeal.kind === "hidden-gem") return `${percent}% positive from only ${reviews} reviews — beloved by the few who found it.`;
  if (appeal.kind === "divisive") return `Only ${percent}% positive across ${reviews} reviews, so expect a rough edge or two.`;
  return null;
}

export function formatReviewCount(total: number) {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 10_000) return `${Math.round(total / 1_000)}k`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
