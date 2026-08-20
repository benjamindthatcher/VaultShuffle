import { createHash } from "node:crypto";

export const UINT32_MAX = 4_294_967_295;
export const IGDB_METRICS = Object.freeze({
  steam_total_reviews: {
    label: "Steam Total Reviews",
    weight: 0.5,
    matches: (name) => /total\s+reviews/i.test(name)
  },
  steam_24h_peak_players: {
    label: "Steam 24hr Peak Players",
    weight: 0.3,
    matches: (name) => /24\s*(?:h|hr|hour).*peak.*players?/i.test(name)
  },
  steam_global_top_sellers: {
    label: "Steam Global Top Sellers",
    weight: 0.2,
    matches: (name) => /global.*top.*sellers?/i.test(name)
  }
});

export function parseSteamSpyPage(raw, page, expectedCount = 1_000) {
  const parsed = JSON.parse(raw);
  const orderedKeys = [...raw.matchAll(/"(\d+)"\s*:\s*\{/g)].map((match) => match[1]);
  if (orderedKeys.length !== expectedCount) {
    throw new Error(`SteamSpy page ${page} returned ${orderedKeys.length} entries; expected ${expectedCount}.`);
  }
  if (new Set(orderedKeys).size !== orderedKeys.length) {
    throw new Error(`SteamSpy page ${page} contains duplicate AppIDs.`);
  }

  return orderedKeys.flatMap((key, index) => {
    const item = parsed[key];
    const steamAppId = validSteamAppId(key);
    if (!item || !steamAppId || Number(item.appid) !== steamAppId) {
      throw new Error(`SteamSpy page ${page} contains a malformed row for AppID ${key}.`);
    }
    const name = cleanName(item.name);
    // SteamSpy occasionally includes otherwise-valid rows with an empty title.
    // They cannot be inserted into catalog_games, so preserve the raw source
    // rank but skip them and let the caller scan another page to fill its cohort.
    if (!name) return [];
    const [ownersLow, ownersHigh] = ownerBounds(item.owners);
    return [{
      steam_appid: steamAppId,
      name,
      rank: page * expectedCount + index + 1,
      owners_low: ownersLow,
      owners_high: ownersHigh
    }];
  });
}

export function resolveIgdbMetricTypes(rows, steamSourceId) {
  const available = rows.filter((row) => Number(row.external_popularity_source) === steamSourceId);
  return Object.fromEntries(Object.entries(IGDB_METRICS).map(([metric, config]) => {
    const matches = available.filter((row) => Number.isInteger(Number(row.id)) && config.matches(cleanName(row.name)));
    if (matches.length !== 1) {
      const names = available.map((row) => `${row.id}:${cleanName(row.name)}`).filter(Boolean).join(", ");
      throw new Error(`Expected one IGDB popularity type for ${config.label}; found ${matches.length}. Available Steam types: ${names}`);
    }
    return [metric, { id: Number(matches[0].id), name: cleanName(matches[0].name) }];
  }));
}

export function buildIgdbCohort(rankings, mappings, limit = 10_000) {
  const candidates = new Map();
  const mappingNameConflicts = [];
  const gameSignals = new Map();

  for (const [metric, rows] of Object.entries(rankings)) {
    for (const row of rows) {
      const gameId = positiveInteger(row.game_id);
      if (!gameId) continue;
      const signals = gameSignals.get(gameId) ?? {};
      const current = signals[metric];
      const rank = positiveInteger(row.rank);
      if (!rank) continue;
      if (!current || rank < current.rank) signals[metric] = { rank, value: finiteNumber(row.value) };
      gameSignals.set(gameId, signals);
    }
  }

  for (const mapping of mappings) {
    const gameId = positiveInteger(mapping.game_id);
    const steamAppId = validSteamAppId(mapping.steam_appid);
    if (!gameId || !steamAppId) continue;
    const signals = gameSignals.get(gameId);
    if (!signals) continue;
    const name = cleanName(mapping.name);
    const existing = candidates.get(steamAppId) ?? {
      steam_appid: steamAppId,
      name: "",
      igdb_game_ids: [],
      signals: {}
    };

    if (name && existing.name && existing.name !== name) {
      mappingNameConflicts.push({ steam_appid: steamAppId, kept: existing.name, alternate: name, igdb_game_id: gameId });
    }
    if (!existing.name && name) existing.name = name;
    if (!existing.igdb_game_ids.includes(gameId)) existing.igdb_game_ids.push(gameId);
    for (const [metric, signal] of Object.entries(signals)) {
      const current = existing.signals[metric];
      if (!current || signal.rank < current.rank) existing.signals[metric] = signal;
    }
    candidates.set(steamAppId, existing);
  }

  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.name)
    .map((candidate) => ({
      ...candidate,
      score: reciprocalRankScore(candidate.signals),
      best_source_rank: Math.min(...Object.values(candidate.signals).map((signal) => signal.rank))
    }))
    .sort((left, right) => right.score - left.score
      || left.best_source_rank - right.best_source_rank
      || left.steam_appid - right.steam_appid)
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    games: ranked,
    diagnostics: {
      mapped_candidate_appids: candidates.size,
      candidates_with_names: [...candidates.values()].filter((candidate) => candidate.name).length,
      mapping_name_conflicts: mappingNameConflicts
    }
  };
}

export function mergePopularCohorts(steamSpyGames, igdbGames) {
  const merged = new Map();
  for (const game of steamSpyGames) {
    const steamAppId = validSteamAppId(game.steam_appid);
    const name = cleanName(game.name);
    if (!steamAppId || !name) throw new Error("SteamSpy cohort contains an invalid AppID or name.");
    if (merged.has(steamAppId)) throw new Error(`SteamSpy cohort repeats AppID ${steamAppId}.`);
    merged.set(steamAppId, {
      steam_appid: steamAppId,
      name,
      sources: {
        steamspy: {
          rank: positiveInteger(game.rank),
          metric: "estimated_owners",
          owners_low: nullableNonNegativeInteger(game.owners_low),
          owners_high: nullableNonNegativeInteger(game.owners_high)
        }
      }
    });
  }

  let overlap = 0;
  const nameConflicts = [];
  for (const game of igdbGames) {
    const steamAppId = validSteamAppId(game.steam_appid);
    const name = cleanName(game.name);
    if (!steamAppId || !name) throw new Error("IGDB cohort contains an invalid AppID or name.");
    const existing = merged.get(steamAppId);
    if (existing) {
      overlap += 1;
      if (existing.name !== name) nameConflicts.push({ steam_appid: steamAppId, kept: existing.name, alternate: name });
      existing.sources.igdb = igdbSource(game);
    } else {
      merged.set(steamAppId, {
        steam_appid: steamAppId,
        name,
        sources: { igdb: igdbSource(game) }
      });
    }
  }

  return {
    games: [...merged.values()].sort((left, right) => left.steam_appid - right.steam_appid),
    diagnostics: { overlap, name_conflicts: nameConflicts }
  };
}

export function assertUniqueCohort(games, expectedCount, label) {
  if (!Array.isArray(games) || games.length !== expectedCount) {
    throw new Error(`${label} cohort has ${games?.length ?? 0} rows; expected ${expectedCount}.`);
  }
  const ids = games.map((game) => validSteamAppId(game.steam_appid));
  if (ids.some((id) => !id)) throw new Error(`${label} cohort contains an invalid Steam AppID.`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} cohort contains duplicate Steam AppIDs.`);
  if (games.some((game) => !cleanName(game.name))) throw new Error(`${label} cohort contains an empty name.`);
}

export function cleanName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function normalizeName(value) {
  return cleanName(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function validSteamAppId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= UINT32_MAX ? parsed : null;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reciprocalRankScore(signals) {
  return Object.entries(IGDB_METRICS).reduce((score, [metric, config]) => {
    const rank = positiveInteger(signals[metric]?.rank);
    return score + (rank ? config.weight / (60 + rank) : 0);
  }, 0);
}

function igdbSource(game) {
  return {
    rank: positiveInteger(game.rank),
    metric: "weighted_reciprocal_rank",
    score: finiteNumber(game.score),
    igdb_game_ids: [...new Set((game.igdb_game_ids ?? []).map(positiveInteger).filter(Boolean))],
    signals: game.signals ?? {}
  };
}

function ownerBounds(value) {
  const matches = String(value ?? "").match(/[\d,]+/g) ?? [];
  if (matches.length !== 2) return [null, null];
  return matches.map((part) => Number(part.replaceAll(",", "")));
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableNonNegativeInteger(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
