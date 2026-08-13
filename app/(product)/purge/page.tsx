"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { Artwork } from "@/components/shared/Artwork";
import { ScrollControls } from "@/components/shared/ScrollControls";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import {
  buildPurgeCandidates,
  type PurgeAction,
  type PurgeCandidate,
  type PurgeCategory,
  type PurgeReview
} from "@/lib/purge";
import type { DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import { captureProductEvent } from "@/lib/posthog-client";
import styles from "./purge.module.css";

const CATEGORIES: Array<{ id: PurgeCategory; label: string; copy: string }> = [
  { id: "untouched", label: "Likely Completed", copy: "Inactive games at 85% progress or more." },
  { id: "barely-started", label: "Abandoned", copy: "Inactive played games at 50% progress or less." },
  { id: "dormant", label: "The Rest", copy: "Unplayed or long-inactive games still worth reviewing." }
];

const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map(({ id, label }) => [id, label])
) as Record<PurgeCategory, string>;

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
  const { games, vaultState, isLive, refresh, updateGame, restoreGame, recordVaultAction } = useAppData();
  const [reviews, setReviews] = useState<PurgeReview[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<PurgeCategory[]>(["untouched"]);
  const queueRef = useRef<HTMLDivElement>(null);
  const [selectedOffset, setSelectedOffset] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
  const savingRef = useRef(false);
  const pendingGameIdsRef = useRef(new Set<string>());
  const decisionQueueRef = useRef(Promise.resolve());
  const [saving, setSaving] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
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
  const filteredCandidates = useMemo(() => {
    if (selectedCategories.length === CATEGORIES.length) return candidates;
    return candidates.filter((candidate) => selectedCategories.includes(candidate.category));
  }, [candidates, selectedCategories]);
  const activeIndex = Math.min(selectedOffset, Math.max(0, filteredCandidates.length - 1));
  const current = filteredCandidates[activeIndex] ?? null;
  const queue = filteredCandidates.slice(0, 5);
  const effectivePinnedIds = new Set([...vaultState.pinnedIds, ...optimisticPinnedIds]);
  const pinsFull = effectivePinnedIds.size >= 3 && current ? !effectivePinnedIds.has(current.game.id) : false;

  const categoryCounts = useMemo(() => Object.fromEntries(CATEGORIES.map(({ id }) => [id, candidates.filter((item) => item.category === id).length])) as Record<PurgeCategory, number>, [candidates]);
  const purgeStats = useMemo(() => {
    const readyIds = new Set(candidates.map(({ game }) => game.id));
    const actionedIds = new Set(reviews.map(({ gameId }) => gameId));
    const reviewableGames = games.filter((game) => game.ownership === "Owned" && game.status !== "Completed" && game.status !== "Slept");
    const noReviewNeeded = reviewableGames.filter((game) => !readyIds.has(game.id) && !actionedIds.has(game.id)).length;

    return {
      ready: candidates.length,
      actioned: actionedIds.size,
      noReviewNeeded
    };
  }, [candidates, games, reviews]);

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
      return { id: crypto.randomUUID(), gameId: candidate.game.id, action, category: candidate.category, reviewedAt: new Date().toISOString() } satisfies PurgeReview;
    }
    const response = await fetch("/api/purge/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game_id: candidate.game.id, action, category: candidate.category })
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

  function finishDecision(candidate: PurgeCandidate, action: PurgeAction, previousStatus: DemoGame["status"], review: PurgeReview) {
    setReviews((value) => [review, ...value]);
    setUndo({ candidate, review, previousStatus });
    setSelectedOffset(0);
  }

  function queueLiveDecision(candidate: PurgeCandidate, action: PurgeAction) {
    if (pendingGameIdsRef.current.has(candidate.game.id)) return;

    const previousStatus = candidate.game.status;
    const optimisticReview: PurgeReview = {
      id: `pending-${crypto.randomUUID()}`,
      gameId: candidate.game.id,
      action,
      category: candidate.category,
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
        captureProductEvent("purge_decision", { action: review.action, category: candidate.category });
      } catch (caught) {
        setReviews((value) => value.filter((item) => item.id !== optimisticReview.id));
        if (action === "pin") {
          setOptimisticPinnedIds((value) => value.filter((id) => id !== candidate.game.id));
        }
        setError(`${candidate.game.title}: ${caught instanceof Error ? caught.message : "Could not save this Purge decision."}`);
      } finally {
        pendingGameIdsRef.current.delete(candidate.game.id);
        setQueuedCount((value) => Math.max(0, value - 1));
        if (pendingGameIdsRef.current.size === 0) {
          await refresh();
          setOptimisticPinnedIds([]);
        }
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
      } else if (committedAction === "complete") {
        await updateGame(candidate.game.id, { status: "Completed", completedAt: new Date().toISOString(), sleptAt: null });
      }
      captureProductEvent("purge_decision", { action: committedAction, category: candidate.category });
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
        await refresh();
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

  function toggleCategory(category: PurgeCategory) {
    setSelectedCategories((value) => {
      if (!value.includes(category)) return [...value, category];
      if (value.length === 1) return value;
      return value.filter((item) => item !== category);
    });
    setSelectedOffset(0);
    setError("");
  }

  return <PurgePageFrame>
    <h1 className="visually-hidden">Purge</h1>
    <section className={styles.setupGrid} aria-label="Purge setup">
      <div className={styles.setupPanel}>
        <div className={styles.categoryGrid}>
          {CATEGORIES.map((category) => {
            const selected = selectedCategories.includes(category.id);
            return <button key={category.id} type="button" className={selected ? styles.categorySelected : styles.category} aria-pressed={selected} onClick={() => toggleCategory(category.id)}>
              <PurgeCategoryIcon category={category.id} /><span><strong>{category.label}</strong><small>{category.copy}</small></span><b>{categoryCounts[category.id]}</b>
            </button>;
          })}
        </div>
      </div>
      <aside className={styles.snapshot} aria-label="Purge stats">
        <div className={styles.snapshotMetrics}>
          <PurgeStat icon="ready-to-review" label="Ready to Review" count={purgeStats.ready} />
          <PurgeStat icon="actioned" label="Actioned" count={purgeStats.actioned} />
          <PurgeStat icon="no-review-needed" label="No Review Needed" count={purgeStats.noReviewNeeded} />
        </div>
      </aside>
    </section>
      <section className={styles.queuePanel}>
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Review queue</p><h2>{filteredCandidates.length} games to consider</h2></div>{queue.length ? <ScrollControls targetRef={queueRef} axis="horizontal" label="Browse review queue" /> : null}</div>
        {queue.length ? <div className={styles.queue} ref={queueRef}>
          {queue.map((candidate, offset) => {
            const selected = current?.game.id === candidate.game.id;
            return <button key={candidate.game.id} type="button" className={selected ? styles.queueCardSelected : styles.queueCard} onClick={() => setSelectedOffset(offset)}>
              <span className={styles.queueArtwork}><Artwork src={candidate.game.bannerUrl} sizes="(max-width: 760px) 72vw, 18vw" /></span>
              <span className={styles.queueCopy}><small>{CATEGORY_LABELS[candidate.category]}</small><strong>{candidate.game.title}</strong><em>{candidate.game.hoursPlayed ? `${candidate.game.hoursPlayed}h played` : "Never Played"}</em></span>
            </button>;
          })}
        </div> : <div className={styles.empty}><h3>No games currently match this Purge setup.</h3><p>Adjust the categories or revisit after your Library has had more time to settle.</p></div>}
      </section>

      {current ? <section key={current.game.id} className={styles.reviewPanel} aria-busy={saving}>
        <div className={styles.reviewArtwork}><Artwork src={current.game.bannerUrl} sizes="(max-width: 880px) 100vw, 38vw" priority fit="contain" /></div>
        <div className={styles.reviewCopy}><p className={styles.eyebrow}>Now reviewing</p><h2>{current.game.title}</h2><div className={styles.facts}><span>{current.game.hoursPlayed ? `${current.game.hoursPlayed}h played` : "Never Played"}</span>{formatGameDuration(current.game.duration) ? <span>{formatGameDuration(current.game.duration)}</span> : null}<span>{current.game.lastPlayedLabel}</span><span>{CATEGORY_LABELS[current.category]}</span></div><p>{current.reason}</p><div className={styles.tags}>{current.game.genres.slice(0, 4).map((genre) => <span key={genre}>{genre}</span>)}</div></div>
        <div className={styles.decisions}><p className={styles.eyebrow}>Decision</p>
          <button type="button" disabled={saving || !reviewsReady} onClick={() => void act("keep")}><PurgeDecisionIcon name="keep-active" /><span><strong>Keep Active</strong><small>Leave active and review again in 180 days.</small></span></button>
          <button type="button" disabled={saving || !reviewsReady} onClick={() => void act("sleep")}><PurgeDecisionIcon name="sleep" /><span><strong>Sleep</strong><small>Remove it from active views and Vault draws.</small></span></button>
          <button type="button" disabled={saving || !reviewsReady} onClick={() => void act("complete")}><PurgeDecisionIcon name="mark-completed" /><span><strong>Mark as Completed</strong><small>Move it to Completed and remove it from Vault draws.</small></span></button>
          <button type="button" disabled={saving || !reviewsReady || pinsFull} onClick={() => void act("pin")} title={pinsFull ? "Unpin a game before adding another." : undefined}><PurgeDecisionIcon name="pin" /><span><strong>Pin</strong><small>{pinsFull ? "All 3 pin slots are currently full." : "Keep it at the front of your Library."}</small></span></button>
        </div>
      </section> : null}
    <footer className={styles.reviewFooter}><button type="button" disabled={!undo || saving || queuedCount > 0} onClick={() => void undoLast()}>Undo last decision</button><span>{queuedCount > 0 ? `${queuedCount} decision${queuedCount === 1 ? "" : "s"} saving in the background…` : "Every decision saves and advances automatically."}</span></footer>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}

  </PurgePageFrame>;
}

function PurgePageFrame({ children }: { children: ReactNode }) {
  return <section className={styles.page}><div className={styles.hero} aria-hidden="true" /><div className={styles.content}>{children}</div></section>;
}

function PurgeCategoryIcon({ category }: { category: PurgeCategory }) {
  const categoryIcons: Record<PurgeCategory, VaultIconName> = {
    untouched: "likely-completed",
    "barely-started": "abandoned",
    dormant: "the-rest",
  };

  return <VaultIcon className={styles.categoryIcon} name={categoryIcons[category]} size={48} />;
}

type PurgeDecisionIconName = "keep-active" | "pin" | "sleep" | "mark-completed";

function PurgeDecisionIcon({ name }: { name: PurgeDecisionIconName }) {
  return <span className={styles.decisionIcon} aria-hidden="true"><VaultIcon name={name} size={34} /></span>;
}

function PurgeStat({ icon, label, count }: { icon: "ready-to-review" | "actioned" | "no-review-needed"; label: string; count: number }) {
  return <span>
    <span className={styles.purgeStatIcon} aria-hidden="true"><VaultIcon name={icon} size={38} /></span>
    <em>{label}</em>
    <strong>{count}</strong>
  </span>;
}
