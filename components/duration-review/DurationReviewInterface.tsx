"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DurationReviewQueueState } from "@/lib/duration-review";
import styles from "./DurationReviewInterface.module.css";

type DurationReviewInterfaceProps = {
  initialState: DurationReviewQueueState;
};

function humanise(value: string) {
  return value.replaceAll("_", " ");
}

export function DurationReviewInterface({ initialState }: DurationReviewInterfaceProps) {
  const [queue, setQueue] = useState(initialState);
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reviewedPercent = queue.total ? Math.round((queue.reviewed / queue.total) * 100) : 100;

  useEffect(() => {
    inputRef.current?.focus();
  }, [queue.game?.steamAppId]);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!queue.game || isSaving) return;
    if (!response.trim()) {
      setError("Add an HLTB link or describe what is going on with this game.");
      inputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      const result = await fetch("/api/durationqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steamAppId: queue.game.steamAppId, response }),
      });
      const body = await result.json() as DurationReviewQueueState & { error?: string };
      if (!result.ok) throw new Error(body.error || "That response was not saved.");
      setQueue(body);
      setResponse("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That response was not saved.");
    } finally {
      setIsSaving(false);
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
          <span>reviewed · {queue.remaining.toLocaleString()} left</span>
        </div>
      </header>

      <div className={styles.progressTrack} aria-label={`${reviewedPercent}% reviewed`}>
        <span style={{ width: `${reviewedPercent}%` }} />
      </div>

      {queue.game ? (
        <div className={styles.game}>
          <div className={styles.artwork}>
            <Artwork
              src={queue.game.artworkUrl}
              alt=""
              sizes="(max-width: 700px) calc(100vw - 64px), 640px"
              priority
            />
          </div>

          <div className={styles.gameCopy}>
            <p className={styles.counter}>Game {Math.min(queue.reviewed + 1, queue.total).toLocaleString()} of {queue.total.toLocaleString()}</p>
            <h1 id="duration-review-title">{queue.game.name}</h1>
            <p className={styles.context}>
              AppID {queue.game.steamAppId}
              <span aria-hidden="true">·</span>
              {humanise(queue.game.durationStatus)}
              {queue.game.durationKind !== "unknown" ? <><span aria-hidden="true">·</span>{humanise(queue.game.durationKind)}</> : null}
            </p>
          </div>

          <form className={styles.form} onSubmit={submitReview}>
            <label htmlFor="duration-response">Paste the correct HLTB link, or tell me why this game has no useful duration.</label>
            <textarea
              ref={inputRef}
              id="duration-response"
              value={response}
              onChange={(event) => {
                setResponse(event.target.value);
                if (error) setError("");
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="https://howlongtobeat.com/game/… or ‘endless multiplayer game’"
              rows={3}
              maxLength={2000}
              disabled={isSaving}
              aria-describedby={error ? "duration-review-error" : "duration-review-hint"}
            />
            <div className={styles.formFooter}>
              <span id={error ? "duration-review-error" : "duration-review-hint"} className={error ? styles.error : styles.hint} role={error ? "alert" : undefined}>
                {error || "⌘ Enter also saves and moves on."}
              </span>
              <button type="submit" disabled={isSaving || !response.trim()}>
                {isSaving ? "Saving…" : "Save & next"}
                <VaultIcon name="chevron-right" size={17} />
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className={styles.complete}>
          <VaultIcon name="check" size={38} />
          <h1 id="duration-review-title">Queue cleared.</h1>
          <p>Every game without a duration has a link or an explanation waiting for the next pass.</p>
        </div>
      )}
    </section>
  );
}
