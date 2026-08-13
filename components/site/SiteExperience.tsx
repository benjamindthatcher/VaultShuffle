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
  enableProductAnalytics,
} from "@/lib/posthog-client";
import styles from "./SiteExperience.module.css";

type AnalyticsChoice = "accepted" | "disabled" | null;
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
  const isAppPage = ["/vault", "/library", "/purge", "/collections", "/wishlist"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    const saved = localStorage.getItem(CONSENT_STORAGE_KEY);
    const choice = saved === "accepted"
      ? "accepted"
      : saved === "disabled" || saved === "essential" || saved === "cookieless"
        ? "disabled"
        : null;
    if (saved === "essential" || saved === "cookieless") {
      localStorage.setItem(CONSENT_STORAGE_KEY, "disabled");
    }
    setAnalyticsChoice(choice);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || analyticsChoice === null) return;
    document.cookie = `${CONSENT_COOKIE}=${analyticsChoice}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;

    if (analyticsChoice === "accepted") {
      void enableProductAnalytics().then(() => {
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
    {loaded && !hideFooter && analyticsChoice === null ? <aside className={styles.cookieBanner} aria-label="Analytics preferences"><div><strong>Help improve VaultShuffle</strong><p>Essential storage keeps the site working. You can also allow PostHog analytics and session replay to help us understand and improve the experience.</p></div><div><button type="button" onClick={() => chooseAnalytics("disabled")}>Essential only</button><button className={styles.primaryConsent} type="button" onClick={() => chooseAnalytics("accepted")}>Allow analytics</button></div></aside> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close analytics settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="analytics-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close analytics settings"><VaultIcon name="close" size={19} /></button><p className={styles.eyebrow}>Privacy controls</p><h2 id="analytics-title">Analytics Settings</h2><p>Choose whether VaultShuffle uses only the storage needed to operate, or also uses PostHog analytics and session replay to improve the product.</p><div className={styles.consentChoice}><span><strong>Essential and service performance</strong><small>Session, preferences, Vercel Web Analytics and Speed Insights</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>PostHog analytics</strong><small>Product usage analytics and session replay</small></span><b>{analyticsChoice === "accepted" ? "On" : "Off"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Essential only</button><button className={styles.primaryConsent} type="button" onClick={() => chooseAnalytics("accepted")}>Allow analytics</button></div></section></div> : null}
    <Analytics />
    <SpeedInsights />
  </>;
}
