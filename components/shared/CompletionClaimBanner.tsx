"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { completionCandidateValue, findCompletionCandidates } from "@/lib/completion-check";
import { formatMoney } from "@/lib/backlog-stats";
import styles from "./CompletionClaimBanner.module.css";
import type { DashboardPayload } from "@/lib/v2/repositories/dashboard-core";

/**
 * The pull toward the completion sweep.
 *
 * A queue nobody visits may as well not exist — that is precisely how a real
 * library accumulated 33 unclaimed completions. This puts the number where the
 * player already is, and disappears the moment the queue is empty, so it works
 * like an inbox rather than another permanent destination.
 */
export function useCompletionClaimNotice(dashboard?: DashboardPayload | null) {
  const { games, isLive, dataAuthority } = useAppData();
  const v2 = dataAuthority === "v2";
  const candidates = useMemo(() => (isLive && !v2 ? findCompletionCandidates(games) : []), [games, isLive, v2]);
  const count = v2 ? dashboard?.completionSummary?.count ?? 0 : candidates.length;
  if (!isLive || !count) return null;

  const value = v2 ? dashboard?.completionSummary?.valueCents ?? 0 : completionCandidateValue(candidates);

  return (
    <Link data-vault-card="interactive" className={styles.banner} href="/finished">
      <span className={styles.icon}><VaultIcon name="completed" size={20} /></span>
      <span className={styles.copy}>
        <strong>{count} {count === 1 ? "game looks" : "games look"} finished</strong>
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
