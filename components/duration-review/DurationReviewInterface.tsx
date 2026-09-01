"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DurationReviewGame, DurationReviewQueueState } from "@/lib/duration-review";
import styles from "./DurationReviewInterface.module.css";

type Submission = { game: DurationReviewGame; response: string };

function humanise(value: string) {
  return value.replaceAll("_", " ");
}

export function DurationReviewInterface({ initialState }: { initialState: DurationReviewQueueState }) {
  const [queue, setQueue] = useState(initialState);
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [pendingSaves, setPendingSaves] = useState(0);
  const [failedSaves, setFailedSaves] = useState<Submission[]>([]);
  const [savedHistory, setSavedHistory] = useState<Submission[]>([]);
  const [isRefilling, setIsRefilling] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submittedIdsRef = useRef(new Set<number>());
  const refillRequestedRef = useRef(false);
  const reviewedPercent = queue.total ? Math.round((queue.reviewed / queue.total) * 100) : 100;

  useEffect(() => {
    inputRef.current?.focus();
  }, [queue.game?.steamAppId]);

  const persistReview = useCallback(async (submission: Submission) => {
    setPendingSaves((count) => count + 1);
    try {
      const result = await fetch("/api/durationqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steamAppId: submission.game.steamAppId, response: submission.response }),
      });
      const body = await result.json() as { error?: string };
      if (!result.ok) throw new Error(body.error || "That response was not saved.");
      setFailedSaves((items) => items.filter((item) => item.game.steamAppId !== submission.game.steamAppId));
      setSavedHistory((items) => [...items, submission]);
    } catch (cause) {
      setFailedSaves((items) => items.some((item) => item.game.steamAppId === submission.game.steamAppId) ? items : [...items, submission]);
      setError(cause instanceof Error ? cause.message : "A background save failed.");
    } finally {
      setPendingSaves((count) => Math.max(0, count - 1));
    }
  }, []);

  const refillQueue = useCallback(async () => {
    if (isRefilling) return;
    setIsRefilling(true);
    try {
      const result = await fetch("/api/durationqueue", { cache: "no-store" });
      const body = await result.json() as DurationReviewQueueState & { error?: string };
      if (!result.ok) throw new Error(body.error || "Could not refill the queue.");
      const freshGames = body.games.filter((game) => !submittedIdsRef.current.has(game.steamAppId));
      setQueue((current) => {
        const knownIds = new Set(current.games.map((game) => game.steamAppId));
        const games = [...current.games, ...freshGames.filter((game) => !knownIds.has(game.steamAppId))];
        return { ...current, game: games[0] ?? null, games };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refill the queue.");
    } finally {
      setIsRefilling(false);
    }
  }, [isRefilling]);

  useEffect(() => {
    if (queue.games.length > 20) {
      refillRequestedRef.current = false;
      return;
    }
    if (!refillRequestedRef.current && queue.remaining > queue.games.length) {
      refillRequestedRef.current = true;
      void refillQueue();
    }
  }, [queue.games.length, queue.remaining, refillQueue]);

  function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const game = queue.game;
    const trimmedResponse = response.trim();
    if (!game) return;
    if (!trimmedResponse) {
      setError("Add an HLTB link or describe what is going on with this game.");
      inputRef.current?.focus();
      return;
    }

    submittedIdsRef.current.add(game.steamAppId);
    const games = queue.games.slice(1);
    setQueue((current) => ({
      ...current,
      game: games[0] ?? null,
      games,
      reviewed: current.reviewed + 1,
      remaining: Math.max(0, current.remaining - 1),
    }));
    setResponse("");
    setError("");
    void persistReview({ game, response: trimmedResponse });
  }

  async function undoLastSave() {
    const submission = savedHistory.at(-1);
    if (!submission || isUndoing) return;
    setIsUndoing(true);
    setError("");
    try {
      const result = await fetch("/api/durationqueue", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steamAppId: submission.game.steamAppId }),
      });
      const body = await result.json() as { error?: string };
      if (!result.ok) throw new Error(body.error || "That review could not be undone.");
      submittedIdsRef.current.delete(submission.game.steamAppId);
      setSavedHistory((items) => items.slice(0, -1));
      setQueue((current) => {
        const games = [submission.game, ...current.games.filter((game) => game.steamAppId !== submission.game.steamAppId)];
        return { ...current, game: submission.game, games, reviewed: Math.max(0, current.reviewed - 1), remaining: current.remaining + 1 };
      });
      setResponse(submission.response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That review could not be undone.");
    } finally {
      setIsUndoing(false);
    }
  }

  return (
    <section className={styles.shell} aria-labelledby="duration-review-title">
      <header className={styles.header}>
        <div className={styles.brand}>
          <Image src="/assets/brand/vaultshuffle-icon.png" alt="" width={42} height={42} priority />
          <span>Vault<strong>Shuffle</strong></span>
        </div>
        <div className={styles.progressCopy} aria-live="polite">
          <strong>{queue.reviewed.toLocaleString()}</strong>
          <span>reviewed · {queue.remaining.toLocaleString()} left{pendingSaves ? ` · ${pendingSaves} saving` : ""}</span>
        </div>
      </header>

      <div className={styles.progressTrack} aria-label={`${reviewedPercent}% reviewed`}>
        <span style={{ width: `${reviewedPercent}%` }} />
      </div>

      {queue.game ? (
        <div className={styles.game}>
          <div className={styles.artwork}>
            <Artwork src={queue.game.artworkUrl} alt="" sizes="(max-width: 700px) calc(100vw - 64px), 640px" priority />
          </div>

          <div className={styles.gameCopy}>
            <p className={styles.counter}>Game {Math.min(queue.reviewed + 1, queue.total).toLocaleString()} of {queue.total.toLocaleString()}</p>
            <h1 id="duration-review-title">{queue.game.name}</h1>
            <p className={styles.context}>
              AppID {queue.game.steamAppId}<span aria-hidden="true">·</span>{humanise(queue.game.durationStatus)}
              {queue.game.durationKind !== "unknown" ? <><span aria-hidden="true">·</span>{humanise(queue.game.durationKind)}</> : null}
            </p>
          </div>

          <form className={styles.form} onSubmit={submitReview}>
            <label htmlFor="duration-response">Paste the correct HLTB link, or tell me why this game has no useful duration.</label>
            <textarea
              ref={inputRef}
              id="duration-response"
              value={response}
              onChange={(event) => { setResponse(event.target.value); if (error) setError(""); }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
              }}
              placeholder="https://howlongtobeat.com/game/… or ‘endless multiplayer game’"
              rows={3}
              maxLength={2000}
              aria-describedby={error ? "duration-review-error" : "duration-review-hint"}
            />
            <div className={styles.formFooter}>
              <span id={error ? "duration-review-error" : "duration-review-hint"} className={error ? styles.error : styles.hint} role={error ? "alert" : undefined}>
                {failedSaves.length ? (
                  <button type="button" className={styles.textButton} onClick={() => failedSaves.forEach((submission) => void persistReview(submission))}>
                    Retry {failedSaves.length} failed {failedSaves.length === 1 ? "save" : "saves"}
                  </button>
                ) : error || "⌘ Enter also saves and moves on."}
              </span>
              <div className={styles.actions}>
                <button type="button" className={styles.secondaryButton} onClick={undoLastSave} disabled={!savedHistory.length || isUndoing}>
                  {isUndoing ? "Undoing…" : "Undo"}
                </button>
                <button type="submit" disabled={!response.trim()}>
                  Save & next<VaultIcon name="chevron-right" size={17} />
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : (
        <div className={styles.complete}>
          <VaultIcon name={isRefilling ? "refresh-prices" : "check"} size={38} />
          <h1 id="duration-review-title">{isRefilling ? "Loading more games…" : "Queue cleared."}</h1>
          <p>{isRefilling ? "The next batch is on its way." : "Every game without a duration has a link or an explanation waiting for the next pass."}</p>
        </div>
      )}
    </section>
  );
}
