"use client";

import { useEffect, useRef, useState } from "react";
import type { PlayNextLane, PlayNextPick } from "@/lib/play-next";
import { Artwork } from "@/components/shared/Artwork";
import { FamilyGameMark } from "@/components/shared/FamilyMark";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import { useSteamPlayLink } from "@/components/shared/useSteamLaunch";
import { formatGameDuration, formatRemainingDuration } from "@/lib/game-duration";
import styles from "./PlayNextCard.module.css";

export const PLAY_NEXT_LANE_BADGES: Record<PlayNextLane, { label: string; icon: VaultIconName }> = {
  because: { label: "For you", icon: "heart" },
  finish: { label: "Nearly there", icon: "finish" },
  gem: { label: "Hidden gem", icon: "new" },
  quick: { label: "Quick win", icon: "short-session" },
  return: { label: "Pick back up", icon: "restore-active" },
  acclaimed: { label: "Widely loved", icon: "trophy" }
};

type Props = {
  pick: PlayNextPick;
  pinsFull: boolean;
  /** Carries the badge on every card, or leaves it to a row that already names the lane. */
  showLane?: boolean;
  /**
   * The row's heading already gives the reason - "Because you finished Hades" -
   * so four cards beneath it do not each say it again.
   */
  reasonInHeading?: boolean;
  onOpen: () => void;
  onPin: () => void;
  onNotNow: () => void;
  onNotForMe: () => void;
  onLaunch: () => void;
};

export function PlayNextCard({ pick, pinsFull, showLane = true, reasonInHeading = false, onOpen, onPin, onNotNow, onNotForMe, onLaunch }: Props) {
  const { game } = pick;
  const [dismissing, setDismissing] = useState(false);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const play = useSteamPlayLink(game.steamAppId);
  const badge = PLAY_NEXT_LANE_BADGES[pick.lane];

  useEffect(() => {
    if (dismissing) firstChoiceRef.current?.focus();
  }, [dismissing]);

  // Backing out returns focus to the control that opened the choice.
  function keep() {
    setDismissing(false);
    requestAnimationFrame(() => dismissRef.current?.focus());
  }

  // The lanes whose headline is their own name say the useful part - the
  // numbers - in the badge's place, rather than printing "Hidden gem" twice.
  const reason = pick.lane === "gem" || pick.lane === "acclaimed" ? pick.detail : pick.headline;
  const secondLine = pick.tags.length || pick.lane === "gem" || pick.lane === "acclaimed" ? null : pick.detail;

  // A finish pick's headline already says what is left, so its facts line
  // gives the whole length instead of repeating the hours.
  const length = game.duration?.endless
    ? "No fixed ending"
    : pick.lane === "finish"
      ? formatGameDuration(game.duration)
      : game.status === "In Progress" && game.completionPercent > 0
        ? formatRemainingDuration(game.duration, game.completionPercent) ?? formatGameDuration(game.duration)
        : formatGameDuration(game.duration);
  const total = Number(game.reviewTotal ?? 0);
  const positivity = total >= 50 ? Math.round((Number(game.reviewPositive ?? 0) / total) * 100) : null;
  const meta = [length, positivity === null ? null : `${positivity}% positive`].filter(Boolean).join(" · ");

  return (
    <li className={styles.card} data-lane={pick.lane} data-dismissing={dismissing || undefined}>
      <button type="button" className={styles.open} onClick={onOpen} aria-label={`Open ${game.title}`} />

      <span className={styles.art}>
        <Artwork src={game.bannerUrl} sizes="(max-width: 620px) 40vw, (max-width: 760px) 45vw, 240px" />
        <FamilyGameMark game={game} overlay />
        {showLane ? (
          <span className={styles.badge}><VaultIcon name={badge.icon} size={13} />{badge.label}</span>
        ) : null}
      </span>

      <button
        ref={dismissRef}
        type="button"
        className={styles.dismiss}
        aria-label={`Hide ${game.title} from suggestions`}
        title="Hide this suggestion"
        aria-expanded={dismissing}
        onClick={() => setDismissing(true)}
      ><VaultIcon name="close" size={14} /></button>

      <div className={styles.body}>
        <strong className={styles.title}>{game.title}</strong>
        {reasonInHeading ? null : <p className={styles.reason}>{reason}</p>}
        {pick.tags.length ? (
          <ul className={styles.tags} aria-label="What it has in common">
            {pick.tags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        ) : secondLine ? (
          <p className={styles.detail}>{secondLine}</p>
        ) : null}
        {meta ? <p className={styles.meta}>{meta}</p> : null}
      </div>

      <div className={styles.actions}>
        {play.href ? (
          <a
            className={styles.play}
            href={play.href}
            target={play.target}
            rel={play.rel}
            onClick={onLaunch}
          >
            <VaultIcon name={play.launching ? "play-now" : "open-steam"} size={16} />
            {play.launching ? "Play" : "Steam"}
          </a>
        ) : null}
        <button
          type="button"
          className={styles.pin}
          onClick={onPin}
          title={pinsFull ? "Your three pins are full - choose one to replace" : "Pin to Playing next"}
        >
          <VaultIcon name="pin" size={16} />Pin
        </button>
      </div>

      {dismissing ? (
        <div
          className={styles.dismissPanel}
          role="group"
          aria-label={`Hide ${game.title}`}
          onKeyDown={(event) => { if (event.key === "Escape") keep(); }}
        >
          <button ref={firstChoiceRef} type="button" onClick={() => { setDismissing(false); onNotNow(); }}>
            <VaultIcon name="snooze-not-now" size={18} />
            <span><strong>Not now</strong><small>Hide it for two weeks</small></span>
          </button>
          <button type="button" onClick={() => { setDismissing(false); onNotForMe(); }}>
            <VaultIcon name="sleep" size={18} />
            <span><strong>Not for me</strong><small>Set it aside, and see less like it</small></span>
          </button>
          <button type="button" className={styles.cancel} onClick={keep}>Keep it</button>
        </div>
      ) : null}
    </li>
  );
}
