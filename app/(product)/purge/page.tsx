"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import {
  buildPurgeCandidates,
  isReviewSuperseded,
  type PurgeAction,
  type PurgeCandidate,
  type PurgeReview,
  type PurgeReviewAction
} from "@/lib/purge";
import type { DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { SignInLock } from "@/components/guest/SignInLock";
import { PlaceholderSlots } from "@/components/shared/PlaceholderSlots";
import styles from "./purge.module.css";



type Undo = {
  candidate: PurgeCandidate;
  review: PurgeReview;
  previousStatus: DemoGame["status"];
};

class PurgeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PurgeRequestError";
  }
}

export default function PurgePage() {
  const { games, vaultState, isLive, isLoading, refresh, updateGame, restoreGame, recordVaultAction } = useAppData();
  const [reviews, setReviews] = useState<PurgeReview[]>([]);
  const [reviewView, setReviewView] = useState<"needs" | "reviewed" | "settled">("needs");
  const [reviewedTab, setReviewedTab] = useState<"active" | "slept">("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reviewedQuery, setReviewedQuery] = useState("");
  const [flagging, setFlagging] = useState(false);
  const [flaggingId, setFlaggingId] = useState<string | null>(null);
  const [selectedOffset, setSelectedOffset] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
  const savingRef = useRef(false);
  const pendingGameIdsRef = useRef(new Set<string>());
  const decisionQueueRef = useRef(Promise.resolve());
  const [saving, setSaving] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const settleTimerRef = useRef<number | null>(null);
  const [optimisticPinnedIds, setOptimisticPinnedIds] = useState<string[]>([]);
  const [reviewsReady, setReviewsReady] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(
    () => buildPurgeCandidates({
      games,
      pinnedIds: vaultState.pinnedIds,
      currentPickId: vaultState.currentPickId,
      snoozedIds: vaultState.snoozedIds,
      reviews
    }),
    [games, reviews, vaultState.currentPickId, vaultState.pinnedIds, vaultState.snoozedIds]
  );
  const activeIndex = Math.min(selectedOffset, Math.max(0, candidates.length - 1));
  const current = candidates[activeIndex] ?? null;
  const queue = candidates.slice(0, 4);
  const effectivePinnedIds = new Set([...vaultState.pinnedIds, ...optimisticPinnedIds]);
  const pinsFull = effectivePinnedIds.size >= 3 && current ? !effectivePinnedIds.has(current.game.id) : false;

  const gameById = useMemo(() => new Map(games.map((game) => [game.id, game])), [games]);

  // Only the most recent decision per game counts, so a game reviewed twice
  // appears once with its current outcome rather than once per decision.
  const latestReviews = useMemo(() => {
    const latest = new Map<string, PurgeReview>();
    for (const review of [...reviews].sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))) {
      if (!latest.has(review.gameId)) latest.set(review.gameId, review);
    }
    return latest;
  }, [reviews]);

  // A decision the player has since reversed elsewhere is history, not a standing
  // outcome. The tab summary already reported from current status for exactly this
  // reason; the rows did not, so a game woken from the Library kept its "Put to
  // sleep" label and was counted as reviewed while also queueing for review again.
  //
  // Completed games drop out here. Finishing a game is not a Purge outcome and
  // there is nothing on this page that can act on one, so they were being
  // counted into Reviewed and then filtered out of both tabs - a few hundred
  // games in the total that you could never find.
  const standingReviews = useMemo(() => {
    const standing = new Map<string, PurgeReview>();
    for (const [gameId, review] of latestReviews) {
      const game = gameById.get(gameId);
      if (!game || game.status === "Completed") continue;
      if (!isReviewSuperseded(review.action, game.status)) standing.set(gameId, review);
    }
    return standing;
  }, [latestReviews, gameById]);

  const reviewedList = useMemo(
    () => [...standingReviews.entries()]
      .map(([gameId, review]) => ({ review, game: gameById.get(gameId) }))
      .filter((entry): entry is { review: PurgeReview; game: DemoGame } => Boolean(entry.game)),
    [standingReviews, gameById]
  );

  const purgeStats = useMemo(() => {
    const readyIds = new Set(candidates.map(({ game }) => game.id));
    const actionedIds = new Set(standingReviews.keys());
    const reviewableGames = games.filter((game) => game.ownership === "Owned" && game.status !== "Completed" && game.status !== "Slept");
    const noReviewNeeded = reviewableGames.filter((game) => !readyIds.has(game.id) && !actionedIds.has(game.id)).length;

    // Reported from each game's CURRENT state, not the decision that was made.
    // A game slept in Purge and later restored elsewhere is active now, and
    // saying "slept" would drift from the Library the same way "Actioned" did.
    const statusById = new Map(games.map((game) => [game.id, game.status]));
    const reviewedStatuses = [...actionedIds]
      .map((gameId) => statusById.get(gameId))
      .filter((status): status is DemoGame["status"] => Boolean(status));

    return {
      ready: candidates.length,
      reviewed: reviewedStatuses.length,
      kept: reviewedStatuses.filter((status) => status !== "Slept").length,
      slept: reviewedStatuses.filter((status) => status === "Slept").length,
      noReviewNeeded
    };
  }, [candidates, games, standingReviews]);


  const settledList = useMemo(() => {
    const readyIds = new Set(candidates.map(({ game }) => game.id));
    const actionedIds = new Set(standingReviews.keys());
    return games.filter((game) =>
      game.ownership === "Owned" &&
      game.status !== "Completed" &&
      game.status !== "Slept" &&
      !readyIds.has(game.id) &&
      !actionedIds.has(game.id));
  }, [games, candidates, standingReviews]);

  useEffect(() => {
    let cancelled = false;
    if (!isLive) {
      setReviews([]);
      setReviewsReady(true);
      return;
    }
    setReviewsReady(false);
    void fetch("/api/purge/reviews")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load your previous Purge decisions.");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        setReviews(payload.reviews ?? []);
        setReviewsReady(true);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load your Purge queue.");
      });
    return () => {
      cancelled = true;
    };
  }, [isLive]);

  async function saveReview(candidate: PurgeCandidate, action: PurgeAction) {
    if (!isLive) {
      return { id: crypto.randomUUID(), gameId: candidate.game.id, action, reviewedAt: new Date().toISOString() } satisfies PurgeReview;
    }
    const response = await fetch("/api/purge/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: candidate.game.id, action })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new PurgeRequestError(payload?.error ?? "Could not save this Purge decision.", response.status);
    }
    return (await response.json()).review as PurgeReview;
  }

  async function saveReviewWithRetry(candidate: PurgeCandidate, action: PurgeAction) {
    try {
      return await saveReview(candidate, action);
    } catch (caught) {
      if (caught instanceof PurgeRequestError && caught.status < 500) throw caught;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      return saveReview(candidate, action);
    }
  }

  async function deleteReview(reviewId: string) {
    if (!isLive) return;
    const response = await fetch(`/api/purge/reviews?id=${reviewId}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not remove this Purge decision.");
  }

  function finishDecision(candidate: PurgeCandidate, action: PurgeReviewAction, previousStatus: DemoGame["status"], review: PurgeReview) {
    setReviews((value) => [review, ...value]);
    setUndo({ candidate, review, previousStatus });
    setSelectedOffset(0);
  }

  useEffect(() => () => {
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
  }, []);

  /**
   * Re-read once the decisions stop, not after each one.
   *
   * Every decision that lands cancels the pending re-read and starts the timer
   * again, so a run of twenty costs one reload at the end rather than twenty
   * along the way.
   */
  function scheduleSettledRefresh() {
    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (pendingGameIdsRef.current.size > 0) return;
      void refresh({ quiet: true }).then(() => setOptimisticPinnedIds([]));
    }, 1200);
  }

  function queueLiveDecision(candidate: PurgeCandidate, action: PurgeAction) {
    if (pendingGameIdsRef.current.has(candidate.game.id)) return;

    const previousStatus = candidate.game.status;
    const optimisticReview: PurgeReview = {
      id: `pending-${crypto.randomUUID()}`,
      gameId: candidate.game.id,
      action,
      reviewedAt: new Date().toISOString()
    };

    pendingGameIdsRef.current.add(candidate.game.id);
    setQueuedCount((value) => value + 1);
    if (action === "pin") {
      setOptimisticPinnedIds((value) => value.includes(candidate.game.id) ? value : [...value, candidate.game.id]);
    }
    setReviews((value) => [optimisticReview, ...value]);
    setUndo(null);
    setSelectedOffset(0);

    decisionQueueRef.current = decisionQueueRef.current.then(async () => {
      try {
        const review = await saveReviewWithRetry(candidate, action);
        setReviews((value) => [review, ...value.filter((item) => item.id !== optimisticReview.id && item.id !== review.id)]);
        setUndo({ candidate, review, previousStatus });
        trackEvent(ANALYTICS_EVENTS.purgeDecision, { action: review.action });
      } catch (caught) {
        setReviews((value) => value.filter((item) => item.id !== optimisticReview.id));
        if (action === "pin") {
          setOptimisticPinnedIds((value) => value.filter((id) => id !== candidate.game.id));
        }
        setError(`${candidate.game.title}: ${caught instanceof Error ? caught.message : "Could not save this Purge decision."}`);
      } finally {
        pendingGameIdsRef.current.delete(candidate.game.id);
        setQueuedCount((value) => Math.max(0, value - 1));
        // Re-reading rebuilds every derived list over the whole library, which
        // is a real pause on a big one. Working down the queue at speed used to
        // pay that after every single decision; now it waits for a gap and pays
        // it once. Quiet, because the decision is already applied locally and
        // there is nothing to wait for.
        scheduleSettledRefresh();
      }
    });
  }

  async function act(action: PurgeAction, candidate = current) {
    if (!candidate || !reviewsReady) return;
    if (action === "pin" && pinsFull) return;
    setError("");
    if (isLive) {
      queueLiveDecision(candidate, action);
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const previousStatus = candidate.game.status;
    try {
      const review = await saveReview(candidate, action);
      const committedAction = review.action;
      if (committedAction === "pin" && !vaultState.pinnedIds.includes(candidate.game.id)) {
        await recordVaultAction("pinned", candidate.game.id);
      } else if (committedAction === "sleep") {
        await updateGame(candidate.game.id, { status: "Slept", sleptAt: new Date().toISOString() });
      }
      trackEvent(ANALYTICS_EVENTS.purgeDecision, {
        action: committedAction,
      });
      finishDecision(candidate, committedAction, previousStatus, review);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this Purge decision.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function undoLast() {
    if (!undo || savingRef.current || pendingGameIdsRef.current.size > 0) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (isLive) {
        // The server reverses the action and removes its review atomically.
        await deleteReview(undo.review.id);
        await refresh({ quiet: true });
      } else {
        if (undo.review.action === "pin") {
          await recordVaultAction("unpinned", undo.candidate.game.id);
        }
        if (undo.review.action === "sleep") await updateGame(undo.candidate.game.id, { status: undo.previousStatus, sleptAt: null });
        if (undo.review.action === "complete") await restoreGame(undo.candidate.game.id);
      }
      setReviews((value) => value.filter((review) => review.id !== undo.review.id));
      setSelectedOffset(0);
      setUndo(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not undo that decision.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }


  // Every count here derives from two independent async sources: the games list
  // and the saved reviews. Rendering before both landed showed each flagged game
  // as "needs review" — the reviews had not arrived to say otherwise — and the
  // numbers then snapped once they did. Hold the panel until both exist.
  const dataReady = !isLoading && reviewsReady;

  // The two review lists, as they are actually shown. Selection and "select all"
  // both work from this so the buttons can never claim more than is on screen.
  const listedGames = reviewView === "reviewed"
    ? reviewedList.map(({ game }) => game)
    : reviewView === "settled" ? settledList.slice(0, 24) : [];

  // Completed is not a Purge outcome any more, so it is filtered out rather than
  // shown with a badge nothing here can act on.
  const reviewGroups = reviewView === "reviewed"
    ? [
        {
          id: "active",
          label: "Active",
          status: "Active",
          games: listedGames.filter((game) => game.status !== "Slept" && game.status !== "Completed"),
          empty: "Nothing you have reviewed is still active."
        },
        {
          id: "slept",
          label: "Slept",
          status: "Slept",
          games: listedGames.filter((game) => game.status === "Slept"),
          empty: "You have not put anything to sleep yet."
        }
      ]
    : [
        {
          id: "settled",
          label: "Active",
          status: "Active",
          games: listedGames,
          empty: "Every active game has either been flagged or reviewed."
        }
      ];
  // One list at a time, behind the same tabs the Library uses, rather than the
  // two stacked sections this used to be. Reviewed can run to hundreds of games,
  // and stacking meant scrolling past every active one to reach the slept.
  const foundGroup = reviewGroups.find((group) => group.id === reviewedTab) ?? reviewGroups[0];

  // Searched within the tab, not across both. Two hundred reviewed games is a
  // lot to scroll for the one you are second-guessing, and the tabs are the
  // thing that says which list you are looking at.
  const reviewedSearch = reviewedQuery.trim().toLowerCase();
  const activeGroup = foundGroup && reviewedSearch
    ? {
        ...foundGroup,
        games: foundGroup.games.filter((game) =>
          game.title.toLowerCase().includes(reviewedSearch) ||
          game.genres.join(" ").toLowerCase().includes(reviewedSearch))
      }
    : foundGroup;

  // Selection is read from the list actually on screen, so the bulk buttons can
  // never claim more than you can see.
  const selected = new Set(selectedIds.filter((id) => activeGroup?.games.some((game) => game.id === id)));

  function toggleSelected(gameId: string) {
    setSelectedIds((current) => current.includes(gameId)
      ? current.filter((id) => id !== gameId)
      : [...current, gameId]);
  }

  async function flagGames(gameIds: string[]) {
    if (!gameIds.length || !isLive) return false;
    setError("");
    try {
      const response = await fetch("/api/purge/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game_ids: gameIds })
      });
      if (!response.ok) throw new Error("Could not flag those games for review.");
      setSelectedIds((current) => current.filter((id) => !gameIds.includes(id)));
      await refresh({ quiet: true });
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not flag those games for review.");
      return false;
    }
  }

  async function flagSelected() {
    if (!selected.size || flagging) return;
    setFlagging(true);
    // Sending a batch back is a move to the queue, so the queue is where you
    // land. One card is not - see below.
    if (await flagGames([...selected])) setReviewView("needs");
    setFlagging(false);
  }

  /**
   * Wake games back up.
   *
   * Flagging cannot reach a slept game: the queue is built from active games
   * only, so a flag on something asleep was written and then filtered straight
   * back out - the button did nothing, in bulk or one at a time. Waking is the
   * actual undo of a sleep, and once a game is active again it is eligible for
   * the queue on its own.
   */
  async function wakeGames(gameIds: string[]) {
    if (!gameIds.length) return;
    setError("");
    try {
      await Promise.all(gameIds.map((gameId) => restoreGame(gameId)));
      setSelectedIds((current) => current.filter((id) => !gameIds.includes(id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not wake those games.");
    }
  }

  async function wakeOne(gameId: string) {
    if (flaggingId || flagging) return;
    setFlaggingId(gameId);
    await wakeGames([gameId]);
    setFlaggingId(null);
  }

  async function wakeSelected() {
    if (!selected.size || flagging) return;
    setFlagging(true);
    await wakeGames([...selected]);
    setFlagging(false);
  }

  /**
   * Flagging a single card leaves you where you are. The card drops out of this
   * list on its own once the queue has it, which is proof enough that it worked,
   * and you are usually going down a grid picking out two or three - being
   * thrown to the queue after the first one would mean coming back each time.
   */
  async function flagOne(gameId: string) {
    if (flaggingId || flagging) return;
    setFlaggingId(gameId);
    await flagGames([gameId]);
    setFlaggingId(null);
  }

  return <PurgePageFrame>
    <h1 className="visually-hidden">Purge</h1>
    {!isLive ? (
      <GuestPreviewNotice feature="Purge" icon="sleep" catalogueSize={games.length}>
        Try the review flow with catalogue metadata. There is no personal play history here, and preview decisions reset when you leave.
      </GuestPreviewNotice>
    ) : null}
    <section className={styles.setupGrid} aria-label="Purge setup">
      <aside className={styles.snapshot} aria-label="Review status">
        {/* The same control the Library uses for Active / Slept / Completed:
            the label with its count beside it, and nothing else. As three tall
            cards with a line of copy each they took the top of the page to say
            what three words and a number say. */}
        <div className={styles.categoryTabs} role="tablist" aria-label="Purge review status">
          {([
            { id: "needs", label: "Needs Review", count: dataReady ? purgeStats.ready : "—" },
            { id: "reviewed", label: "Reviewed", count: dataReady ? purgeStats.reviewed : "—" },
            { id: "settled", label: "No Review Needed", count: dataReady ? purgeStats.noReviewNeeded : "—" }
          ] as const).map((view) => {
            const active = reviewView === view.id;
            return (
              <button
                key={view.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? styles.statusTabActive : styles.statusTab}
                disabled={!dataReady}
                onClick={() => { setReviewView(view.id); setSelectedIds([]); }}
              >
                <span>{view.label}</span><strong>{view.count}</strong>
              </button>
            );
          })}
        </div>
      </aside>
    </section>
      {reviewView === "needs" ? <>
        <section className={styles.queuePanel}>
          {!dataReady ? <div className={styles.queue}>
            <PlaceholderSlots count={4} label="Loading your review queue." />
          </div> : queue.length ? <div className={styles.queue}>
            {queue.map((candidate, offset) => {
              const selected = current?.game.id === candidate.game.id;
              return <button key={candidate.game.id} type="button" className={selected ? styles.queueCardSelected : styles.queueCard} onClick={() => setSelectedOffset(offset)}>
                <span className={styles.queueArtwork}><Artwork src={candidate.game.bannerUrl} sizes="(max-width: 760px) 72vw, 18vw" /></span>
                <span className={styles.queueCopy}><strong>{candidate.game.title}</strong><em>{candidate.game.hoursPlayed ? `${candidate.game.hoursPlayed}h played` : "Never Played"}</em></span>
              </button>;
            })}
          </div> : <div className={styles.queue}>
            <PlaceholderSlots count={4} label="Your review queue is clear." />
          </div>}
        </section>

        {/* Deliberately not keyed on the game. Keyed, every decision tore the
            whole panel down and built a new one - including the three buttons,
            which were destroyed and recreated under the cursor that had just
            pressed one. A second click landing in that gap hit nothing, which is
            what "it didn't update" feels like. Unkeyed, React swaps the text and
            the artwork in place and the buttons never move. */}
        {current && dataReady ? <section className={styles.reviewPanel} aria-busy={saving}>
          <div className={styles.reviewArtwork}><Artwork src={current.game.bannerUrl} sizes="(max-width: 880px) 100vw, 38vw" priority fit="contain" /></div>
          <div className={styles.reviewCopy}><p className={styles.eyebrow}>Now reviewing</p><h2>{current.game.title}</h2><div className={styles.facts}><span>{current.game.hoursPlayed ? `${current.game.hoursPlayed}h played` : "Never Played"}</span>{formatGameDuration(current.game.duration) ? <span>{formatGameDuration(current.game.duration)}</span> : null}{current.game.lastPlayedLabel ? <span>{current.game.lastPlayedLabel}</span> : null}</div>{/* What the game actually is, above why it is up for review. Deciding
                whether to keep something you have never opened is mostly a
                question of what it is, and the panel never said. */}{current.game.description ? <p className={styles.synopsis}>{current.game.description}</p> : null}<p>{current.reason}</p>{current.signal ? <p className={current.signal.leaning === "cut" ? styles.signalCut : styles.signalKeep}><strong>{current.signal.label}</strong>{current.signal.detail}</p> : null}<div className={styles.tags}>{current.game.genres.slice(0, 4).map((genre) => <span key={genre}>{genre}</span>)}</div></div>
          <div className={styles.decisions}><p className={styles.eyebrow}>Decision</p>
            <button type="button" data-decision="keep" disabled={saving || !reviewsReady} onClick={() => void act("keep")}><PurgeDecisionIcon name="keep-active" /><span><strong>Keep Active</strong><small>{isLive ? "Leave active and review again in 90 days." : "Leave it active in this preview."}</small></span></button>
            <button type="button" data-decision="sleep" disabled={saving || !reviewsReady} onClick={() => void act("sleep")}><PurgeDecisionIcon name="sleep" /><span><strong>Sleep</strong><small>{isLive ? "Remove it from active views and Vault draws." : "Remove it from this visit's active views and draws."}</small></span></button>
            <button type="button" data-decision="pin" disabled={saving || !reviewsReady || pinsFull} onClick={() => void act("pin")} title={pinsFull ? "Unpin a game before adding another." : undefined}><PurgeDecisionIcon name="pin" /><span><strong>Pin</strong><small>{pinsFull ? "All 3 pin slots are currently full." : isLive ? "Keep it at the front of your Library." : "Keep it at the front of the preview Library."}</small></span></button>
          </div>
        </section> : null}
      </> : <section className={styles.queuePanel}>
        {/* Reviewed splits into what is still active and what is asleep, behind
            the same tabs the Library uses. As one list of 200 they were
            indistinguishable apart from a badge, and stacked as two sections you
            scrolled past every active game to reach the slept. Completed is
            deliberately absent: finishing a game is not a Purge decision, and it
            has had its own sweep since it left this page. */}
        {activeGroup ? (
          <div className={styles.reviewGroup}>
            <div className={styles.groupHeader}>
              {reviewGroups.length > 1 ? (
                <div className={styles.statusTabs} role="tablist" aria-label="Reviewed games">
                  {reviewGroups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      role="tab"
                      aria-selected={group.id === activeGroup.id}
                      className={group.id === activeGroup.id ? styles.statusTabActive : styles.statusTab}
                      onClick={() => setReviewedTab(group.id as "active" | "slept")}
                    >
                      <span>{group.label}</span><strong>{group.games.length}</strong>
                    </button>
                  ))}
                </div>
              ) : (
                <span className={styles.groupChip} data-status={activeGroup.status}>{activeGroup.label}<b>{activeGroup.games.length}</b></span>
              )}
              <label className={styles.reviewedSearch}>
                <VaultIcon name="search" size={15} />
                <input
                  type="search"
                  value={reviewedQuery}
                  onChange={(event) => setReviewedQuery(event.target.value)}
                  placeholder={`Search ${foundGroup?.label.toLowerCase() ?? ""}…`}
                  aria-label={`Search ${foundGroup?.label ?? ""} games`}
                />
              </label>
              {activeGroup.games.length ? (
                <label className={styles.bulkCheck}>
                  <input
                    type="checkbox"
                    checked={activeGroup.games.every((game) => selected.has(game.id))}
                    ref={(node) => {
                      if (!node) return;
                      const chosen = activeGroup.games.filter((game) => selected.has(game.id)).length;
                      node.indeterminate = chosen > 0 && chosen < activeGroup.games.length;
                    }}
                    onChange={(event) => setSelectedIds((current) => event.target.checked
                      ? [...new Set([...current, ...activeGroup.games.map((game) => game.id)])]
                      : current.filter((id) => !activeGroup.games.some((game) => game.id === id)))}
                  />
                  <span>Select all {activeGroup.games.length}</span>
                </label>
              ) : null}
            </div>

            {/* Said once, under the control it explains, rather than on every
                card. The buttons stay on screen so the feature is visible. */}
            {!isLive && activeGroup.games.length && activeGroup.id !== "slept" ? (
              <SignInLock feature="purge_flag">Flagging a game back into the review queue keeps it there between visits, so it needs a library to keep it in.</SignInLock>
            ) : null}

            {/* Directly under the select-all that fills it. At the foot of the
                grid it meant ticking "select all 31" at the top and then
                scrolling past all 31 to find the button that acts on them. */}
            {selected.size ? <div className={styles.bulkBar}>
              <span className={styles.bulkCheck}>{selected.size} selected</span>
              {activeGroup?.id === "slept" ? (
                <button
                  type="button"
                  className={styles.bulkWake}
                  disabled={flagging}
                  onClick={() => void wakeSelected()}
                >
                  <VaultIcon name="restore-active" size={15} />
                  {flagging ? "Waking…" : `Wake ${selected.size} back up`}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.bulkAction}
                  disabled={!isLive || flagging}
                  title={isLive ? undefined : "Flagging needs a signed-in library."}
                  onClick={() => void flagSelected()}
                >
                  {!isLive ? <VaultIcon name="lock" size={15} /> : null}
                  {flagging ? "Flagging…" : `Flag ${selected.size} for review`}
                </button>
              )}
            </div> : null}

            <div role="tabpanel" aria-label={`${activeGroup.label} games`}>
              {activeGroup.games.length ? (
                <ul className={styles.outcomeGrid}>
                  {activeGroup.games.map((game) => <li key={game.id} className={styles.outcomeCard} data-selected={selected.has(game.id) || undefined}>
                    {/* The artwork and the title tick the box. Hitting an 18px
                        square exactly is a poor way to work down a grid of
                        thirty, and everything in here that is not the flag
                        button means the same thing: this one. */}
                    <label className={styles.outcomeHit}>
                      <span className={styles.outcomeCheck}>
                        <input type="checkbox" checked={selected.has(game.id)} onChange={() => toggleSelected(game.id)} />
                        <span className="visually-hidden">Select {game.title}</span>
                      </span>
                      <span className={styles.outcomeArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 240px" /></span>
                      <span className={styles.outcomeName}>{game.title}</span>
                    </label>
                    {/* Flagging one game needed a tick and then a trip to the bar
                        at the bottom of the page. The checkbox is still there for
                        doing several at once; this is for the common case of
                        spotting one. */}
                    <span className={styles.outcomeFooter}>
                      <span className={styles.outcomeBadge} data-status={game.status}>{game.status === "Slept" ? "Asleep" : "Active"}</span>
                      {/* A slept game cannot be flagged - the queue is built
                          from active games, so the flag was written and filtered
                          straight back out. Waking it is the undo that was
                          missing, and unlike flagging it works in the preview
                          too. */}
                      {game.status === "Slept" ? (
                        <button
                          type="button"
                          className={styles.outcomeWake}
                          disabled={flagging || Boolean(flaggingId)}
                          aria-label={`Wake ${game.title} up`}
                          onClick={() => void wakeOne(game.id)}
                        >
                          <VaultIcon name="restore-active" size={15} />
                          {flaggingId === game.id ? "Waking…" : "Wake up"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={styles.outcomeFlag}
                          disabled={!isLive || flagging || Boolean(flaggingId)}
                          aria-label={isLive ? `Flag ${game.title} for review` : "Flag for review needs a signed-in library"}
                          title={isLive ? undefined : "Flagging needs a signed-in library."}
                          onClick={() => void flagOne(game.id)}
                        >
                          <VaultIcon name={isLive ? "ready-to-review" : "lock"} size={15} />
                          {flaggingId === game.id ? "Flagging…" : "Flag for review"}
                        </button>
                      )}
                    </span>
                  </li>)}
                </ul>
              ) : <p className={styles.emptyNote}>{reviewedSearch ? `Nothing in ${foundGroup?.label.toLowerCase() ?? "this list"} matches "${reviewedQuery.trim()}".` : activeGroup.empty}</p>}
            </div>
          </div>
        ) : null}

      </section>}
    {/* No running commentary on the writes. That a decision is still in flight
        is our problem, not something to report back at someone working down a
        queue - and it only ever appeared for as long as nobody needed to know. */}
    <footer className={styles.reviewFooter}><button type="button" disabled={!undo || saving || queuedCount > 0} onClick={() => void undoLast()}>Undo last decision</button></footer>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}

  </PurgePageFrame>;
}

function PurgePageFrame({ children }: { children: ReactNode }) {
  return <section className={styles.page}><div className={styles.content}>{children}</div></section>;
}


type PurgeDecisionIconName = "keep-active" | "pin" | "sleep";

function PurgeDecisionIcon({ name }: { name: PurgeDecisionIconName }) {
  return <span className={styles.decisionIcon} aria-hidden="true"><VaultIcon name={name} size={34} /></span>;
}
