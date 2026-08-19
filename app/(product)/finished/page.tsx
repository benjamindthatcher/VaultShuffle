"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestFeatureGate } from "@/components/guest/GuestFeatureGate";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { findCompletionCandidates } from "@/lib/completion-check";
import { formatMoney } from "@/lib/backlog-stats";
import styles from "./finished.module.css";

/**
 * Claiming what you already finished.
 *
 * Deliberately not part of Purge. "Did I finish this" is a fact the player knows
 * instantly and enjoys answering; "should this stay in my draw pool" is a
 * judgement that takes thought. Running both through one queue made the quick,
 * rewarding question inherit the slow one's pacing, and left real completions
 * unclaimed for months.
 */
export default function FinishedPage() {
  const { games, isLive, updateGame } = useAppData();
  const [claimed, setClaimed] = useState<Record<string, "finished" | "not-yet">>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");

  const candidates = useMemo(() => findCompletionCandidates(games), [games]);
  const pending = candidates.filter((candidate) => !claimed[candidate.game.id]);

  const claimedCount = Object.values(claimed).filter((value) => value === "finished").length;
  const claimedValue = candidates
    .filter((candidate) => claimed[candidate.game.id] === "finished")
    .reduce((total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0);
  const remainingValue = pending
    .reduce((total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0);

  async function claim(gameId: string, finished: boolean) {
    if (saving) return;
    setSaving(gameId);
    setError("");
    const game = games.find((entry) => entry.id === gameId);
    try {
      if (finished) {
        await updateGame(gameId, { status: "Completed", completedAt: new Date().toISOString(), sleptAt: null });
      } else {
        // Records the playtime at dismissal so it only asks again after another
        // real session, rather than every time the page is opened.
        await updateGame(gameId, {
          completionSuggestionDismissedAt: new Date().toISOString(),
          completionSuggestionDismissedPlaytime: Number(game?.hoursPlayed ?? 0)
        });
      }
      setClaimed((value) => ({ ...value, [gameId]: finished ? "finished" : "not-yet" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  if (!isLive) {
    return (
      <GuestFeatureGate
        feature="Completion check"
        icon="completed"
        title="Claim the games you already finished"
        description="Connect Steam and VaultShuffle can spot the games your playtime says you finished but never marked, so your library reflects what you have actually done."
        benefits={[
          "Find finished games hiding in your backlog",
          "Watch your completed value climb as you claim them",
          "Stop them turning up in Vault draws"
        ]}
      />
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Completion check</p>
        <h1>{pending.length ? "Did you finish these?" : "Nothing left to claim"}</h1>
        <p className={styles.sub}>
          {pending.length
            ? `Your Steam playtime says you reached the credits on these. Claiming them keeps them out of Vault draws and moves your completed value — ${formatMoney(remainingValue)} still waiting.`
            : "Every game your playtime flagged has been dealt with. New ones appear here as you play."}
        </p>
      </header>

      {claimedCount ? (
        <p className={styles.claimBar} role="status">
          <VaultIcon name="completed" size={18} />
          <strong>{claimedCount} claimed</strong>
          {claimedValue ? <span>{formatMoney(claimedValue)} added to your completed value</span> : null}
        </p>
      ) : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {pending.length ? (
        <ul className={styles.list}>
          {pending.map((candidate) => (
            <li key={candidate.game.id} className={styles.row}>
              <span className={styles.art}><Artwork src={candidate.game.bannerUrl} sizes="104px" /></span>
              <span className={styles.body}>
                <strong>{candidate.game.title}</strong>
                <small>{candidate.reason}</small>
              </span>
              <span className={styles.price}>
                {candidate.game.isFree || !candidate.game.priceInitial ? "" : formatMoney(Number(candidate.game.priceInitial))}
              </span>
              <span className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={saving === candidate.game.id}
                  onClick={() => void claim(candidate.game.id, true)}
                >Finished</button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={saving === candidate.game.id}
                  onClick={() => void claim(candidate.game.id, false)}
                >Not yet</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.done}>
          <p>{claimedCount ? "That is your backlog looking a lot more honest." : "Nothing to claim right now."}</p>
          <div className={styles.doneActions}>
            <Link className={styles.primaryLink} href="/stats">See your stats</Link>
            <Link className={styles.secondaryLink} href="/vault">Draw something to play</Link>
          </div>
        </div>
      )}
    </div>
  );
}
