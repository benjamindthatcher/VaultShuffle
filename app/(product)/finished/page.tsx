"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestFeatureGate } from "@/components/guest/GuestFeatureGate";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { findCompletionCandidates } from "@/lib/completion-check";
import { formatMoney } from "@/lib/backlog-stats";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { trackCompletionClaim, trackCompletionDismissed } from "@/lib/completion-tracking";
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
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(() => findCompletionCandidates(games), [games]);

  // Fired once per visit, from the queue as it was found rather than as it is
  // left, so the funnel measures what was offered against what was claimed.
  const viewLogged = useRef(false);
  useEffect(() => {
    if (viewLogged.current || !isLive || !candidates.length) return;
    viewLogged.current = true;
    trackEvent(ANALYTICS_EVENTS.completionSweepViewed, {
      candidates: candidates.length,
      value_cents: candidates.reduce(
        (total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0)
    });
  }, [candidates, isLive]);
  const pending = candidates.filter((candidate) => !claimed[candidate.game.id]);

  const selectedIds = pending.filter((candidate) => selected[candidate.game.id]);
  const allSelected = pending.length > 0 && selectedIds.length === pending.length;
  const selectedValue = selectedIds.reduce(
    (total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0);

  const claimedCount = Object.values(claimed).filter((value) => value === "finished").length;
  const claimedValue = candidates
    .filter((candidate) => claimed[candidate.game.id] === "finished")
    .reduce((total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0);
  const remainingValue = pending
    .reduce((total, candidate) => total + (candidate.game.isFree ? 0 : Number(candidate.game.priceInitial ?? 0)), 0);

  async function saveOne(gameId: string, finished: boolean, bulk = false) {
    const game = games.find((entry) => entry.id === gameId);
    if (finished) {
      await updateGame(gameId, { status: "Completed", completedAt: new Date().toISOString(), sleptAt: null });
      if (game) trackCompletionClaim(game, bulk ? "sweep_bulk" : "sweep", isLive);
    } else {
      if (game) trackCompletionDismissed(game, bulk);
      // Records the playtime at dismissal so it only asks again after another
      // real session, rather than every time the page is opened.
      await updateGame(gameId, {
        completionSuggestionDismissedAt: new Date().toISOString(),
        completionSuggestionDismissedPlaytime: Number(game?.hoursPlayed ?? 0)
      });
    }
  }

  async function claim(gameId: string, finished: boolean) {
    if (saving || bulkRunning) return;
    setSaving(gameId);
    setError("");
    try {
      await saveOne(gameId, finished);
      setClaimed((value) => ({ ...value, [gameId]: finished ? "finished" : "not-yet" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  /**
   * Ticking through thirty-odd games one pair of buttons at a time is a chore, and
   * a chore is exactly what this queue is meant not to be. Saves run one at a time
   * so a mid-run failure leaves everything before it already committed rather than
   * rolling the whole sweep back.
   */
  async function claimSelected(finished: boolean) {
    const ids = pending.map((candidate) => candidate.game.id).filter((id) => selected[id]);
    if (!ids.length || bulkRunning || saving) return;
    setBulkRunning(true);
    setError("");
    const done: Record<string, "finished" | "not-yet"> = {};
    try {
      for (const id of ids) {
        await saveOne(id, finished, true);
        done[id] = finished ? "finished" : "not-yet";
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Some games could not be saved. The rest were kept.");
    } finally {
      setClaimed((value) => ({ ...value, ...done }));
      setSelected({});
      setBulkRunning(false);
    }
  }

  function toggle(gameId: string) {
    setSelected((value) => ({ ...value, [gameId]: !value[gameId] }));
  }

  function toggleAll() {
    if (allSelected) return setSelected({});
    setSelected(Object.fromEntries(pending.map((candidate) => [candidate.game.id, true])));
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
        <>
        <div className={styles.selectBar}>
          <label className={styles.selectAll}>
            <input
              type="checkbox"
              checked={allSelected}
              ref={(node) => { if (node) node.indeterminate = selectedIds.length > 0 && !allSelected; }}
              onChange={toggleAll}
              disabled={bulkRunning}
            />
            <span>{allSelected ? "Clear selection" : `Select all ${pending.length}`}</span>
          </label>
          {selectedIds.length ? (
            <div className={styles.bulkActions}>
              <span className={styles.selectedNote}>
                {selectedIds.length} selected{selectedValue ? ` · ${formatMoney(selectedValue)}` : ""}
              </span>
              <button type="button" className={styles.primary} disabled={bulkRunning} onClick={() => void claimSelected(true)}>
                {bulkRunning ? "Claiming…" : `Mark ${selectedIds.length} finished`}
              </button>
              <button type="button" className={styles.secondary} disabled={bulkRunning} onClick={() => void claimSelected(false)}>
                Not yet
              </button>
            </div>
          ) : null}
        </div>
        <ul className={styles.list}>
          {pending.map((candidate) => (
            <li key={candidate.game.id} className={selected[candidate.game.id] ? styles.rowSelected : styles.row}>
              <label className={styles.tick}>
                <input
                  type="checkbox"
                  checked={Boolean(selected[candidate.game.id])}
                  onChange={() => toggle(candidate.game.id)}
                  disabled={bulkRunning}
                  aria-label={`Select ${candidate.game.title}`}
                />
              </label>
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
        </>
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
