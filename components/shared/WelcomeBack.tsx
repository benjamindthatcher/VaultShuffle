"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { buildVisitRecap, recapSentence } from "@/lib/since-last-visit";
import styles from "./WelcomeBack.module.css";
import type { DashboardPayload } from "@/lib/v2/repositories/dashboard-core";

const LAST_VISIT_KEY = "vaultshuffle:last-visit";

/**
 * What happened while they were away.
 *
 * The last visit is read from this device rather than the server: it is the
 * honest thing to measure ("since you were last here" really does mean here),
 * it needs no extra column, and being wrong on a second device costs nothing
 * worse than a recap that is slightly generous.
 *
 * It shows nothing at all rather than reporting a quiet week. A strip that says
 * "0h played" every time is worse than no strip.
 */
export function useWelcomeBackNotice(dashboard?: DashboardPayload | null) {
  const { games, playtime, isLive, dataAuthority } = useAppData();
  const v2 = dataAuthority === "v2";
  const [lastVisit, setLastVisit] = useState<string | null | undefined>(undefined);
  const visitRead = useRef(false);

  useEffect(() => {
    // Strict Mode replays effects; never read our own arrival stamp as the prior visit.
    if (visitRead.current) return;
    visitRead.current = true;
    try {
      setLastVisit(window.localStorage.getItem(LAST_VISIT_KEY));
      // Stamped on arrival, so the next visit measures from now.
      window.localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    } catch {
      setLastVisit(null);
    }
  }, []);

  const recap = useMemo(() => {
    if (!isLive || lastVisit === undefined) return null;
    if (v2) return dashboard ? buildVisitRecap({games:[],playtime:{...dashboard.trend,dailyGains:[...dashboard.trend.dailyGains]},completionActivity:dashboard.completionActivity,lastVisitISO:lastVisit}) : null;
    return buildVisitRecap({ games, playtime, lastVisitISO: lastVisit });
  }, [games, isLive, lastVisit, playtime, v2, dashboard]);

  const streak = isLive ? v2 ? dashboard?.trend.streakDays ?? 0 : playtime.streakDays : 0;
  if (!recap && streak < 2) return null;

  return (
    <section className={styles.strip} aria-label="Since your last visit">
      {recap ? (
        <span className={styles.item}>
          <VaultIcon name="clock" size={16} />
          <span>
            <strong>{recap.windowed ? "This week" : "Since you were last here"}</strong>
            {recapSentence(recap)}
          </span>
        </span>
      ) : null}

      {streak >= 2 ? (
        <span className={`${styles.item} ${styles.streak}`}>
          <VaultIcon name="finish" size={16} />
          <span><strong>{streak}-day streak</strong>Keep it going tonight</span>
        </span>
      ) : null}

      {recap?.finishedCount ? (
        <span className={styles.finished}>
          {recap.gamesFinished.slice(0, 2).map((game) => game.title).join(", ")}
          {recap.finishedCount > 2 ? ` +${recap.finishedCount - 2}` : ""}
        </span>
      ) : null}
    </section>
  );
}

export function WelcomeBack() {
  return useWelcomeBackNotice();
}
