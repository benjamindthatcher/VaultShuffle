"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { completionCandidateValue, findCompletionCandidates } from "@/lib/completion-check";
import { formatMoney } from "@/lib/backlog-stats";
import styles from "./CompletionClaimBanner.module.css";

/**
 * The pull toward the completion sweep.
 *
 * A queue nobody visits may as well not exist — that is precisely how a real
 * library accumulated 33 unclaimed completions. This puts the number where the
 * player already is, and disappears the moment the queue is empty, so it works
 * like an inbox rather than another permanent destination.
 */
export function useCompletionClaimNotice() {
  const { games, isLive } = useAppData();
  const candidates = useMemo(() => (isLive ? findCompletionCandidates(games) : []), [games, isLive]);
  if (!candidates.length) return null;

  const value = completionCandidateValue(candidates);

  return (
    <Link className={styles.banner} href="/finished">
      <span className={styles.icon}><VaultIcon name="completed" size={20} /></span>
      <span className={styles.copy}>
        <strong>{candidates.length} {candidates.length === 1 ? "game looks" : "games look"} finished</strong>
        <small>
          Your playtime says you reached the credits{value ? ` on ${formatMoney(value)} worth of games` : ""}. Claim them to
          move your completed value.
        </small>
      </span>
      <span className={styles.cta}>Check them<VaultIcon name="chevron-right" size={16} /></span>
    </Link>
  );
}

export function CompletionClaimBanner() {
  return useCompletionClaimNotice();
}
