"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { Artwork } from "@/components/shared/Artwork";
import { ScrollControls } from "@/components/shared/ScrollControls";
import {
  buildPurgeCandidates,
  type PurgeAction,
  type PurgeCandidate,
  type PurgeCategory,
  type PurgeReview
} from "@/lib/purge";
import type { DemoGame } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./purge.module.css";

const CATEGORIES: Array<{ id: PurgeCategory; label: string; copy: string }> = [
  { id: "untouched", label: "Untouched", copy: "Games you have never played." },
  { id: "barely-started", label: "Barely Started", copy: "Games with very little playtime or progress." },
  { id: "dormant", label: "Dormant", copy: "Games you played before, but not recently." }
];

const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map(({ id, label }) => [id, label])
) as Record<PurgeCategory, string>;

type Undo = {
  candidate: PurgeCandidate;
  review: PurgeReview;
  previousStatus: DemoGame["status"];
};

export default function PurgePage() {
  const { games, vaultState, isLive, updateGame, restoreGame, recordVaultAction } = useAppData();
  const [reviews, setReviews] = useState<PurgeReview[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<PurgeCategory[]>([]);
  const queueRef = useRef<HTMLDivElement>(null);
  const [selectedOffset, setSelectedOffset] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [saving, setSaving] = useState(false);
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
    if (!selectedCategories.length) return candidates;
    return candidates.filter((candidate) => selectedCategories.includes(candidate.category));
  }, [candidates, selectedCategories]);
  const activeIndex = Math.min(selectedOffset, Math.max(0, filteredCandidates.length - 1));
  const current = filteredCandidates[activeIndex] ?? null;
  const queue = filteredCandidates.slice(0, 5);
  const pinsFull = vaultState.pinnedIds.length >= 3 && current ? !vaultState.pinnedIds.includes(current.game.id) : false;

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
    if (!isLive) {
      setReviews([]);
      return;
    }
    void fetch("/api/purge/reviews")
      .then((response) => response.ok ? response.json() : { reviews: [] })
      .then((payload) => setReviews(payload.reviews ?? []));
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
    if (!response.ok) throw new Error("Could not save this Purge decision.");
    return (await response.json()).review as PurgeReview;
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

  async function act(action: PurgeAction, candidate = current) {
    if (!candidate || saving) return;
    if (action === "pin" && pinsFull) return;
    setSaving(true);
    setError("");
    const previousStatus = candidate.game.status;
    let review: PurgeReview | null = null;
    try {
      review = await saveReview(candidate, action);
      if (action === "pin" && !vaultState.pinnedIds.includes(candidate.game.id)) await recordVaultAction("pinned", candidate.game.id);
      if (action === "sleep") await updateGame(candidate.game.id, { status: "Slept", sleptAt: new Date().toISOString() });
      if (action === "complete") await updateGame(candidate.game.id, { status: "Completed", completedAt: new Date().toISOString(), sleptAt: null });
      posthog.capture('purge_decision', { action, category: candidate.category });
      finishDecision(candidate, action, previousStatus, review);
    } catch (caught) {
      if (review) {
        try {
          await deleteReview(review.id);
        } catch {
          // Preserve the original action error; the next load reconciles saved reviews.
        }
      }
      setError(caught instanceof Error ? caught.message : "Could not save this Purge decision.");
    } finally {
      setSaving(false);
    }
  }

  async function undoLast() {
    if (!undo || saving) return;
    setSaving(true);
    setError("");
    try {
      if (undo.review.action === "pin") {
        await recordVaultAction("unpinned", undo.candidate.game.id);
      }
      if (undo.review.action === "sleep") await updateGame(undo.candidate.game.id, { status: undo.previousStatus, sleptAt: null });
      if (undo.review.action === "complete") await restoreGame(undo.candidate.game.id);
      await deleteReview(undo.review.id);
      setReviews((value) => value.filter((review) => review.id !== undo.review.id));
      setSelectedOffset(0);
      setUndo(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not undo that decision.");
    } finally {
      setSaving(false);
    }
  }

  function toggleCategory(category: PurgeCategory) {
    setSelectedCategories((value) => value.includes(category) ? value.filter((item) => item !== category) : [...value, category]);
    setSelectedOffset(0);
    setError("");
  }

  return <PurgePageFrame>
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
        <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Review queue</p><h2>{filteredCandidates.length} games to consider</h2></div><ScrollControls targetRef={queueRef} axis="horizontal" label="Browse review queue" /></div>
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

      {current ? <section className={styles.reviewPanel} aria-busy={saving}>
        <div className={styles.reviewArtwork}><Artwork src={current.game.bannerUrl} sizes="(max-width: 880px) 100vw, 38vw" priority /></div>
        <div className={styles.reviewCopy}><p className={styles.eyebrow}>Now reviewing</p><h2>{current.game.title}</h2><div className={styles.facts}><span>{current.game.hoursPlayed ? `${current.game.hoursPlayed}h played` : "Never Played"}</span>{formatGameDuration(current.game.duration) ? <span>{formatGameDuration(current.game.duration)}</span> : null}<span>{current.game.lastPlayedLabel}</span><span>{CATEGORY_LABELS[current.category]}</span></div><p>{current.reason}</p><div className={styles.tags}>{current.game.genres.slice(0, 4).map((genre) => <span key={genre}>{genre}</span>)}</div></div>
        <div className={styles.decisions}><p className={styles.eyebrow}>Decision</p>
          <button type="button" disabled={saving} onClick={() => void act("keep")}><PurgeDecisionIcon name="keep-active" /><span><strong>Keep Active</strong><small>Leave active and review again in 180 days.</small></span></button>
          <button type="button" disabled={saving || pinsFull} onClick={() => void act("pin")} title={pinsFull ? "Unpin a game before adding another." : undefined}><PurgeDecisionIcon name="pin" /><span><strong>Pin</strong><small>{pinsFull ? "All 3 pin slots are currently full." : "Keep it at the front of your Library."}</small></span></button>
          <button type="button" disabled={saving} onClick={() => void act("sleep")}><PurgeDecisionIcon name="sleep" /><span><strong>Sleep</strong><small>Remove it from active views and Vault draws.</small></span></button>
          <button type="button" disabled={saving} onClick={() => void act("complete")}><PurgeDecisionIcon name="mark-completed" /><span><strong>Mark as Completed</strong><small>Move it to Completed and remove it from Vault draws.</small></span></button>
        </div>
      </section> : null}
    <footer className={styles.reviewFooter}><button type="button" disabled={!undo || saving} onClick={() => void undoLast()}>Undo last decision</button><span>Every decision saves and advances automatically.</span></footer>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}

  </PurgePageFrame>;
}

function PurgePageFrame({ children }: { children: ReactNode }) {
  return <section className={styles.page}><div className={styles.hero} aria-hidden="true" /><div className={styles.content}>{children}</div></section>;
}

function PurgeCategoryIcon({ category }: { category: PurgeCategory }) {
  return <picture className={styles.categoryIcon} aria-hidden="true"><source srcSet={`/assets/vaultshuffle/purge/${category}-48.webp`} type="image/webp" /><img src={`/assets/vaultshuffle/purge/${category}-48.png`} alt="" width={48} height={48} /></picture>;
}

type PurgeDecisionIconName = "keep-active" | "pin" | "sleep" | "mark-completed";

function PurgeDecisionIcon({ name }: { name: PurgeDecisionIconName }) {
  const root = `/assets/vaultshuffle/purge/decisions`;
  return <picture className={styles.decisionIcon} aria-hidden="true"><source srcSet={`${root}/webp/${name}-64.webp 1x, ${root}/webp/${name}-128.webp 2x`} type="image/webp" /><img src={`${root}/png/${name}-64.png`} srcSet={`${root}/png/${name}-64.png 1x, ${root}/png/${name}-128.png 2x`} alt="" width={40} height={40} draggable={false} /></picture>;
}

function PurgeStat({ icon, label, count }: { icon: "ready-to-review" | "actioned" | "no-review-needed"; label: string; count: number }) {
  return <span>
    <picture className={styles.purgeStatIcon} aria-hidden="true"><source srcSet={`/assets/vaultshuffle/purge/stats/${icon}.webp`} type="image/webp" /><img src={`/assets/vaultshuffle/purge/stats/${icon}.png`} alt="" width={56} height={56} /></picture>
    <em>{label}</em>
    <strong>{count}</strong>
  </span>;
}
