"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { FeedbackProvider, useFeedback } from "@/components/feedback/FeedbackProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { SiteFooter } from "@/components/site/SiteFooter";
import {
  captureProductEvent,
  disableProductAnalytics,
  enableCookielessProductAnalytics,
} from "@/lib/posthog-client";
import styles from "./SiteExperience.module.css";

type AnalyticsChoice = "cookieless" | "disabled" | null;
const CONSENT_STORAGE_KEY = "vault-cookie-consent";
const CONSENT_COOKIE = "vault_analytics_consent";

export function SiteExperience({ children }: { children: ReactNode }) {
  return <FeedbackProvider><SiteFrame>{children}</SiteFrame></FeedbackProvider>;
}

function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { openFeedback } = useFeedback();
  const [analyticsChoice, setAnalyticsChoice] = useState<AnalyticsChoice>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hideFooter = pathname.startsWith("/login") || pathname.startsWith("/auth");
  const isAppPage = ["/vault", "/library", "/purge", "/collections"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    const saved = localStorage.getItem(CONSENT_STORAGE_KEY);
    const choice = saved === "disabled" || saved === "essential" ? "disabled" : "cookieless";
    if (saved !== choice) localStorage.setItem(CONSENT_STORAGE_KEY, choice);
    setAnalyticsChoice(choice);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || analyticsChoice === null) return;
    document.cookie = `${CONSENT_COOKIE}=${analyticsChoice}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;

    if (analyticsChoice === "cookieless") {
      void enableCookielessProductAnalytics().then(() => {
        captureProductEvent("$pageview", { $current_url: window.location.href });
      });
    } else {
      disableProductAnalytics();
    }
  }, [analyticsChoice, loaded, pathname]);

  const chooseAnalytics = (value: Exclude<AnalyticsChoice, null>) => {
    localStorage.setItem(CONSENT_STORAGE_KEY, value);
    setAnalyticsChoice(value);
    setSettingsOpen(false);
  };

  return <>
    {children}
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close analytics settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="analytics-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close analytics settings"><VaultIcon name="close" size={19} /></button><p className={styles.eyebrow}>Privacy controls</p><h2 id="analytics-title">Analytics Settings</h2><p>VaultShuffle uses privacy-friendly analytics to understand aggregate product usage. You can turn this off at any time.</p><div className={styles.consentChoice}><span><strong>Essential and service performance</strong><small>Session, preferences, Vercel Web Analytics and Speed Insights</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>Cookieless PostHog analytics</strong><small>No persistent tracking storage, account identification, GeoIP, heatmaps or session replay</small></span><b>{analyticsChoice === "cookieless" ? "On" : "Off"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Turn analytics off</button><button className={styles.primaryConsent} type="button" onClick={() => chooseAnalytics("cookieless")}>Use privacy-friendly analytics</button></div></section></div> : null}
    <Analytics />
    <SpeedInsights />
  </>;
}
