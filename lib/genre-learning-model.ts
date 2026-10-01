import {shouldLearnDrawEvent,isSeparatePlayingNextCommitment} from "./draw-signal-precedence.ts";
import {ANY_MOOD_CONTEXT,BASELINE_GENRE} from "./genre-preferences.ts";
import type {VaultDrawEventType} from "./vault-history.ts";
import type {VaultMoodId} from "./demo-data.ts";
export type Signal={positive:number;total:number;moodOnly?:boolean};
export type LearningDraw={id:string;user_id:string;steam_appid:number|string;mood:VaultMoodId|null};
export type LearningEvent={draw_id:string;event_type:string;created_at:string};
export type LearningDecision={userId:string;steamAppId:number;action:string;reviewedAt:string|null};
export type LearningPin={userId:string;steamAppId:number;pinnedAt:string};
type Tally={positive:number;total:number};
const RECENCY_HALF_LIFE_DAYS=60;


export const EVENT_SIGNALS: Partial<Record<VaultDrawEventType, Signal>> = {
  // Launching it is the strongest thing anyone can say about a pick: they took
  // the recommendation. It used to be worth the same as a thumbs-up.
  opened_on_steam: { positive: 3, total: 3 },
  play_now_intent: { positive: 2.5, total: 2.5 },
  liked: { positive: 2, total: 2 },
  // Committing to play something next, which was worth half of a launch.
  pinned: { positive: 2, total: 2 },

  // Both deliberate rejections carry more than they did: these are the two
  // moments someone tells us a pick was wrong, and they were quieter than a
  // thumbs-up was loud.
  disliked: { positive: 0, total: 3 },
  // Snoozing was the most common thing anyone did with a pick - 177 of 423
  // recorded reactions - and it scored nothing at all, so the largest single
  // body of evidence the product had taught the model nothing. It is a
  // deliberate no about this game tonight, which is weaker than "Not really"
  // and stronger than clicking draw again.
  //
  // The button that produced it has since been retired in favour of the reroll,
  // so this earns from the history rather than from anything new.
  hidden_for_session: { positive: 0, total: 1.5 },
  // Sleeping a game is the most deliberate rejection the product offers: it is a
  // decision about the game itself, not about tonight.
  slept: { positive: 0, total: 4 },
  reroll_not_interested: { positive: 0, total: 2 },
  reroll_wrong_mood: { positive: 0, total: 1, moodOnly: true },

  // The bare reroll is the weakest signal there is: it is also just how the
  // product is used. It counts for something, but barely, and only when the draw
  // carries no more explicit opinion — see statesAnOpinion.
  // Doubled from 0.5: it is now the only way to reject a pick at all, since the
  // snooze button that carried 42% of every recorded reaction has been retired.
  drew_again: { positive: 0, total: 1 }
};


export const LIBRARY_SIGNALS: Record<string, { positive: number; total: number }> = {
  // Matched to the draw-side weight: sleeping is the clearest rejection there is,
  // reached deliberately through a review rather than in passing. This is the
  // signal the learner was missing entirely, so it keeps its full weight.
  sleep: { positive: 0, total: 4 },
  blacklist: { positive: 0, total: 4 },
  pin: { positive: 2, total: 2 },
  // Finishing something is real evidence and weaker than choosing it tonight.
  // At 2/2 it was the strongest positive the model had, and once completions
  // were read from the ownership row there were 11,494 of them against 414 draw
  // reactions - so the model was mostly learning what people had already played
  // rather than what makes a good pick, which for a discovery tool argues in a
  // circle. Counted once, not twice.
  complete: { positive: 1, total: 1 }
};


export function withOverrides<T extends Record<string, Signal>>(base: T, prefix: string, overrides: Map<string, Signal>): T {
  const merged = { ...base } as Record<string, Signal>;
  for (const name of Object.keys(base)) {
    const override = overrides.get(`${prefix}:${name}`);
    // moodOnly is a property of what the signal means, not of its strength, so
    // it is never something the tuning table gets to change.
    if (override) merged[name] = { ...base[name], ...override };
  }
  return merged as T;
}


export function foldGenreLearning(input:{draws:readonly LearningDraw[];events:readonly LearningEvent[];
  libraryDecisions:readonly LearningDecision[];playingNextCommitments:readonly LearningPin[];
  genresByAppId:ReadonlyMap<number,string[]>;eventSignals:Record<string,Signal>;decisionSignals:Record<string,Signal>}) {
  const {draws,events,libraryDecisions,playingNextCommitments,genresByAppId,eventSignals,decisionSignals}=input;
  const drawsById=new Map(draws.map(draw=>[draw.id,draw]));
  const summary={scoredEvents:0,users:0,rows:0};
  // user -> "context::genre" -> tally
  const tallies = new Map<string, Map<string, Tally>>();
  // steam_appid -> tally, across everyone. What people do with one specific
  // game, which is the thing no amount of tag resolution can reach: the VR
  // edition and the beta demo share every tag with something worth playing.
  const gameTallies = new Map<number, Tally>();
  const eventsByDraw = new Map<string, LearningEvent[]>();
  for (const event of events) {
    const bucket = eventsByDraw.get(event.draw_id);
    if (bucket) bucket.push(event); else eventsByDraw.set(event.draw_id, [event]);
  }
  const drawCommitmentTimes = new Map<string, string[]>();
  for (const event of events) {
    if (!["pinned", "opened_on_steam", "play_now_intent"].includes(event.event_type)) continue;
    const draw = drawsById.get(event.draw_id);
    if (!draw) continue;
    const key = `${draw.user_id}::${draw.steam_appid}`;
    const times = drawCommitmentTimes.get(key) ?? [];
    times.push(event.created_at);
    drawCommitmentTimes.set(key, times);
  }

  for (const [drawId, drawEvents] of eventsByDraw) {
    const draw = drawsById.get(drawId);
    if (!draw) continue;
    const genres = genresByAppId.get(Number(draw.steam_appid));
    if (!genres?.length) continue;

    // A stated opinion supersedes the bare reroll on the same draw. Both are
    // written for one action, and counting them together let a single rejection
    // be recorded twice while a rejection with no reason counted once.
    const eventTypes = drawEvents.map((event) => event.event_type);
    const learnedTypes = new Set<string>();

    for (const event of drawEvents) {
      const eventType = event.event_type as VaultDrawEventType;
      if (!shouldLearnDrawEvent(eventType, eventTypes) || learnedTypes.has(eventType)) continue;
      const signal = eventSignals[eventType];
      if (!signal) continue;
      learnedTypes.add(eventType);

      const decay = recencyWeight(event.created_at);
      if (decay <= 0) continue;
      summary.scoredEvents += 1;

      const userTallies = tallies.get(draw.user_id) ?? new Map<string, Tally>();
      tallies.set(draw.user_id, userTallies);

      const positive = signal.positive * decay;
      const total = signal.total * decay;

      // Every signal also updates the user's own baseline, which is what each
      // genre is later measured against.
      for (const genre of [...genres, BASELINE_GENRE]) {
        if (!signal.moodOnly) addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, positive, total);
        if (draw.mood) addTally(userTallies, `${draw.mood}::${genre}`, positive, total);
      }

      // Mood-scoped signals say something about the evening rather than the
      // game, so they are not evidence about the game itself.
      if (!signal.moodOnly) addGameTally(gameTallies, Number(draw.steam_appid), positive, total);
    }
  }

  // Library Blacklist and Complete are durable outcomes, separate from the
  // immediate choice on a Vault draw.
  for (const decision of libraryDecisions) {
    const signal = decisionSignals[decision.action];
    if (!signal) continue;
    const genres = genresByAppId.get(decision.steamAppId);
    if (!genres?.length) continue;

    const decay = decision.reviewedAt === null ? 1 : recencyWeight(decision.reviewedAt);
    if (decay <= 0) continue;

    const userTallies = tallies.get(decision.userId) ?? new Map<string, Tally>();
    tallies.set(decision.userId, userTallies);

    // No mood context: a Library outcome is about the game, not about the evening
    // the player happened to be having.
    // A decision is the strongest thing said about a game: someone was looking
    // at exactly this one and chose its fate. It is the bulk of the per-game
    // evidence, and the reason unplayable editions and dead demos are visible
    // at all.
    addGameTally(gameTallies, decision.steamAppId, signal.positive * decay, signal.total * decay);

    for (const genre of [...genres, BASELINE_GENRE]) {
      addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, signal.positive * decay, signal.total * decay);
    }
  }

  // Playing Next can be chosen from Library and Play Next without a Vault draw.
  // Its current state is one positive commitment, except when a draw event
  // already recorded the same click. Removing or replacing a slot removes this
  // state signal on the next rebuild; it does not cast a negative vote.
  for (const commitment of playingNextCommitments) {
    const key = `${commitment.userId}::${commitment.steamAppId}`;
    if (!isSeparatePlayingNextCommitment(commitment.pinnedAt, drawCommitmentTimes.get(key) ?? [])) continue;
    const genres = genresByAppId.get(commitment.steamAppId);
    if (!genres?.length) continue;
    const decay = recencyWeight(commitment.pinnedAt);
    if (decay <= 0) continue;
    const signal = decisionSignals.pin;
    const userTallies = tallies.get(commitment.userId) ?? new Map<string, Tally>();
    tallies.set(commitment.userId, userTallies);
    addGameTally(gameTallies, commitment.steamAppId, signal.positive * decay, signal.total * decay);
    for (const genre of [...genres, BASELINE_GENRE]) {
      addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, signal.positive * decay, signal.total * decay);
    }
  }

  summary.users = tallies.size;
  const rows = [...tallies.entries()].flatMap(([userId, userTallies]) =>
    [...userTallies.entries()].map(([key, tally]) => {
      const separator = key.indexOf("::");
      return {
        user_id: userId,
        context_mood: key.slice(0, separator),
        genre: key.slice(separator + 2),
        positive: Number(tally.positive.toFixed(4)),
        total: Number(tally.total.toFixed(4)),
        updated_at: new Date().toISOString()
      };
    })
  );
  summary.rows = rows.length;

  return {rows,gameTallies,summary};
}

function addTally(userTallies: Map<string, Tally>, key: string, positive: number, total: number) {
  const tally = userTallies.get(key) ?? { positive: 0, total: 0 };
  tally.positive += positive;
  tally.total += total;
  userTallies.set(key, tally);
}


/**
 * Exponential decay rather than the flat window it replaces: a 179-day-old signal
 * counting for exactly as much as yesterday's, and then nothing at all the next
 * day, is not a description of how taste changes.
 */
function recencyWeight(createdAt: string) {
  const age = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(age)) return 0;
  const ageDays = Math.max(0, age / 86_400_000);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function addGameTally(tallies: Map<number, Tally>, steamAppId: number, positive: number, total: number) {
  if (!Number.isFinite(steamAppId) || steamAppId <= 0 || total <= 0) return;
  const held = tallies.get(steamAppId);
  if (held) {
    held.positive += positive;
    held.total += total;
    return;
  }
  tallies.set(steamAppId, { positive, total });
}
