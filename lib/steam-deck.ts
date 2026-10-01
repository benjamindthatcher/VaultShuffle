/** Valve's published Deck categories. Missing data is not an Unknown verdict. */
export function steamDeckRating(category: number | null | undefined) {
  switch (category) {
    case 3: return { id: "verified", label: "Verified", description: "Valve rates this game as fully compatible with Steam Deck, without extra setup." } as const;
    case 2: return { id: "playable", label: "Playable", description: "Valve rates this game as playable on Steam Deck. Some manual setup may be needed, such as controller configuration or using the on-screen keyboard." } as const;
    case 1: return { id: "unsupported", label: "Unsupported", description: "Valve currently rates this game as unsupported on Steam Deck." } as const;
    case 0: return { id: "unknown", label: "Unknown", description: "Valve has not completed a Steam Deck compatibility review for this game." } as const;
    default: return { id: "missing", label: "Not checked", description: "VaultShuffle has not fetched a Steam Deck rating for this game yet." } as const;
  }
}

export function shouldRefreshDeckRating(category: number | null, checkedAt: string | null | undefined, now = Date.now()) {
  const checked = checkedAt ? Date.parse(checkedAt) : NaN;
  return category === null || !Number.isFinite(checked) || now - checked >= 30 * 24 * 60 * 60 * 1000;
}
