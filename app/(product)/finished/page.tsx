"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { findCompletionCandidates } from "@/lib/completion-check";
import { estimatedTimeToBeatMinutes } from "@/lib/game-duration";
import { formatMoney } from "@/lib/backlog-stats";
import { trackCompletionClaim, trackCompletionDismissed } from "@/lib/completion-tracking";
import { PageHeading } from "@/components/shared/PageHeading";
import styles from "./finished.module.css";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

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
  const { games, isLive, updateGame, refresh } = useAppData();
  const [claimed, setClaimed] = useState<Record<string, "finished" | "not-yet">>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(() => findCompletionCandidates(games), [games]);

  // Fired once per visit, from the queue as it was found rather than as it is
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

  /**
   * The row goes as soon as it is clicked, and the save follows it.
   *
   * This used to wait for the round trip before anything moved, and a single
   * shared saving flag blocked every other row while it did - so someone
   * working through thirty
   * games clicked the next one, got nothing, and clicked again. Eight people
   * rage-clicked this button in twelve hours.
   *
   * A failure puts the row back and says why, so nothing is quietly lost.
   */
  async function claim(gameId: string, finished: boolean) {
    if (bulkRunning || claimed[gameId]) return;
    setClaimed((value) => ({ ...value, [gameId]: finished ? "finished" : "not-yet" }));
    setError("");
    try {
      await saveOne(gameId, finished);
    } catch (caught) {
      setClaimed((value) => {
        const reverted = { ...value };
        delete reverted[gameId];
        return reverted;
      });
      setError(caught instanceof Error ? caught.message : "Could not save that. Please try again.");
    }
  }

  /**
   * The whole selection in one request.
   *
   * This was a loop of individual saves, and a claim costs two writes - the game
   * itself and its ledger row - against a budget of a hundred and twenty a
   * minute. So a sweep of eighty games sent a hundred and sixty writes and the
   * person using the button built for long sweeps was told, halfway through
   * their own sweep, that they were making changes too quickly. Waking games hit
   * this first and was fixed the same way.
   *
   * Analytics still fire per game: they go to PostHog, not to us, and they are
   * how the threshold that put these games here gets checked.
   */
  async function claimSelected(finished: boolean) {
    const chosen = pending.filter((candidate) => selected[candidate.game.id]);
    if (!chosen.length || bulkRunning) return;
    setBulkRunning(true);
    setError("");

    const mark = finished ? "finished" as const : "not-yet" as const;
    const done: Record<string, "finished" | "not-yet"> = {};
    for (const candidate of chosen) done[candidate.game.id] = mark;

    try {
      if (!isLive) {
        // Guest state is local, so there is nothing to batch and nothing to
        // spend: the existing per-game path already only touches memory.
        for (const candidate of chosen) await saveOne(candidate.game.id, finished, true);
      } else {
        const response = await fetch("/api/games/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: finished ? "claimed" : "dismissed",
            games: chosen.map(({ game }) => {
              const estimateMinutes = estimatedTimeToBeatMinutes(game.duration) ?? null;
              return {
                id: game.id,
                hours_played: Number(game.hoursPlayed ?? 0),
                estimate_minutes: estimateMinutes,
                price_cents: game.isFree ? 0 : Math.round(Number(game.priceInitial ?? 0)) || 0
              };
            })
          })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error ?? "Some games could not be saved. The rest were kept.");
        }
        for (const { game } of chosen) {
          // isLive false on purpose: this reports to PostHog only. The ledger
          // rows were already written by the batch, and letting the tracker post
          // them again is the per-game write we just removed.
          if (finished) trackCompletionClaim(game, "sweep_bulk", false);
          else trackCompletionDismissed(game, true);
        }
        await refresh({ quiet: true });
      }
      setClaimed((value) => ({ ...value, ...done }));
    } catch (caught) {
      // Nothing is marked done on a failure. The batch is one request, so either
      // the sweep landed or none of it did - saying otherwise would hide games
      // that are still waiting to be answered.
      setError(caught instanceof Error ? caught.message : "Some games could not be saved. The rest were kept.");
    } finally {
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

  return (
    <div className={styles.page}>
      <PageHeading title={!isLive ? "Completion check preview" : pending.length ? "Did you finish these?" : "Nothing left to claim"}>
        {!isLive ? "This page becomes a real review queue once Steam can provide your playtime." : undefined}
      </PageHeading>

      {!isLive ? (
        <GuestPreviewNotice feature="Completion check" icon="completed">
          The guest catalogue has no personal playtime, so VaultShuffle will not invent games for you to claim as finished.
        </GuestPreviewNotice>
      ) : null}

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
          {selectedIds.length ? null : (
            <span className={styles.selectedNote}>{formatMoney(remainingValue)} still to claim</span>
          )}
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
          {/* Every candidate, not just the undecided ones.
              Filtering to `pending` meant a row vanished the instant it was
              answered and the whole list jumped up a place - so a second tap,
              200ms behind the first, landed on the next game's button instead.
              7.7% of consecutive claims arrive less than half a second apart,
              and seventeen people rage-clicked this button in a day. A decided
              row stays exactly where it was and says what it now is. */}
          {candidates.map((candidate) => {
            const outcome = claimed[candidate.game.id];
            return (
            <li key={candidate.game.id} className={outcome ? `${styles.row} ${styles.rowDecided}` : selected[candidate.game.id] ? styles.rowSelected : styles.row}>
              {/* Everything but the two buttons ticks the box. Aiming at the
                  checkbox itself is a poor way to work down a list, and the rest
                  of the row means the same thing: this one. */}
              <label className={styles.rowHit}>
                <span className={styles.tick}>
                  <input
                    type="checkbox"
                    checked={Boolean(selected[candidate.game.id])}
                    onChange={() => toggle(candidate.game.id)}
                    disabled={bulkRunning || Boolean(outcome)}
                    aria-label={`Select ${candidate.game.title}`}
                  />
                </span>
                <span className={styles.art}><Artwork src={candidate.game.bannerUrl} sizes="104px" /><FamilyGameMark game={candidate.game} overlay /></span>
                <span className={styles.body}>
                  <strong>{candidate.game.title}</strong>
                  <small>{candidate.reason}</small>
                </span>
                <span className={styles.price}>
                  {candidate.game.isFree || !candidate.game.priceInitial ? "" : formatMoney(Number(candidate.game.priceInitial))}
                </span>
              </label>
              <span className={styles.actions}>
                {outcome ? (
                  <span className={styles.outcome} data-outcome={outcome}>
                    <VaultIcon name={outcome === "finished" ? "check" : "snooze-not-now"} size={16} />
                    {outcome === "finished" ? "Finished" : "Not yet"}
                  </span>
                ) : (<>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={bulkRunning}
                  onClick={() => void claim(candidate.game.id, true)}
                >Finished</button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={bulkRunning}
                  onClick={() => void claim(candidate.game.id, false)}
                >Not yet</button>
                </>)}
              </span>
            </li>
            );
          })}
        </ul>
        </>
      ) : (
        <div className={styles.done}>
          <p>{!isLive
            ? "There is nothing personal to check yet. You can still browse the guest Library and try the rest of VaultShuffle."
            : claimedCount ? "That is your backlog looking a lot more honest." : "Nothing to claim right now."}</p>
          <div className={styles.doneActions}>
            <Link className={styles.primaryLink} href="/dashboard">See your dashboard</Link>
            <Link className={styles.secondaryLink} href="/vault">Draw something to play</Link>
          </div>
        </div>
      )}
    </div>
  );
}
