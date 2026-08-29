"use client";

import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { formatGameDuration } from "@/lib/game-duration";
import type { PurgeAction, PurgeCandidate } from "@/lib/purge";
import styles from "./PurgeTouchQueue.module.css";

export type TouchDecision = "keep" | "sleep" | "complete";

/**
 * The review queue for a device held in the hands.
 *
 * The strip-and-panel layout puts 792px between a game's artwork and the buttons
 * that decide it - one whole phone screen - so every decision is scroll, look,
 * scroll back, tap. It shows: on mobile a decision takes 2.4s against desktop's
 * 1.07s, and people stop after 47 of them where desktop users run to 160.
 *
 * Here the decision sits on the card, under the art it is about. The detail that
 * panel carried is not lost, it is demoted: at one second a decision nobody was
 * reading a synopsis, and the one line that does the deciding - never played, or
 * how long since you did - is on the card.
 *
 * A decided card keeps its place and says what it now is, rather than vanishing
 * and pulling the next game up under a finger that is already moving. That is
 * the same mistake the completion sweep was making, where 7.7% of decisions
 * arrived less than half a second apart.
 */
export function PurgeTouchQueue({
  candidates,
  decided,
  busy,
  onDecide
}: {
  candidates: PurgeCandidate[];
  decided: Record<string, TouchDecision>;
  busy: boolean;
  onDecide: (action: PurgeAction, candidate: PurgeCandidate) => void;
}) {
  return (
    <ul className={styles.grid}>
      {candidates.map((candidate) => {
        const outcome = decided[candidate.game.id];
        const played = candidate.game.hoursPlayed
          ? `${candidate.game.hoursPlayed}h played`
          : "Never played";
        // The one line that decides it. Everything else the panel showed was
        // going unread at a second a card.
        const since = candidate.game.lastPlayedLabel || formatGameDuration(candidate.game.duration) || null;

        return (
          <li key={candidate.game.id} className={outcome ? `${styles.card} ${styles.cardDecided}` : styles.card}>
            <div className={styles.art}>
              <Artwork src={candidate.game.bannerUrl} sizes="(max-width: 520px) 92vw, 44vw" />
              {outcome ? (
                <span className={styles.stamp} data-outcome={outcome}>
                  <VaultIcon name={outcome === "keep" ? "keep-active" : outcome === "sleep" ? "sleep" : "completed"} size={16} />
                  {outcome === "keep" ? "Kept" : outcome === "sleep" ? "Asleep" : "Completed"}
                </span>
              ) : null}
            </div>

            <div className={styles.copy}>
              <strong className={styles.title}>{candidate.game.title}</strong>
              <span className={styles.fact}>{played}{since ? ` · ${since}` : ""}</span>
            </div>

            {/* The outcome takes the same room the buttons did. Removing the row
                shortened the card by 74px and lifted every card below it - the
                decision holds its place, but the ones underneath still moved. */}
            {outcome ? (
              <div className={styles.decidedRow} data-outcome={outcome}>
                <VaultIcon name={outcome === "keep" ? "keep-active" : outcome === "sleep" ? "sleep" : "completed"} size={17} />
                {outcome === "keep" ? "Kept active" : outcome === "sleep" ? "Put to sleep" : "Marked completed"}
              </div>
            ) : (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.keep}
                  disabled={busy}
                  onClick={() => onDecide("keep", candidate)}
                >
                  <VaultIcon name="keep-active" size={17} />Keep
                </button>
                <button
                  type="button"
                  className={styles.sleep}
                  disabled={busy}
                  onClick={() => onDecide("sleep", candidate)}
                >
                  <VaultIcon name="sleep" size={17} />Sleep
                </button>
                {/* The rare third. A full-width button for it would eat a 375px
                    card for something that is not why anyone opened Purge. */}
                <button
                  type="button"
                  className={styles.complete}
                  disabled={busy}
                  aria-label={`Mark ${candidate.game.title} completed`}
                  title="Already finished it"
                  onClick={() => onDecide("complete", candidate)}
                >
                  <VaultIcon name="completed" size={17} />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
