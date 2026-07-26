"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import posthog from "posthog-js";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { FeedbackProvider, useFeedback } from "@/components/feedback/FeedbackProvider";
import { SiteFooter } from "@/components/site/SiteFooter";
import styles from "./SiteExperience.module.css";

type Consent = "accepted" | "essential" | null;
const CONSENT_STORAGE_KEY = "vault-cookie-consent";
const CONSENT_COOKIE = "vault_analytics_consent";

export function SiteExperience({ children }: { children: ReactNode }) {
  return <FeedbackProvider><SiteFrame>{children}</SiteFrame></FeedbackProvider>;
}

function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { openFeedback } = useFeedback();
  const [consent, setConsent] = useState<Consent>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hideFooter = pathname.startsWith("/login") || pathname.startsWith("/auth");
  const isAppPage = ["/vault", "/library", "/purge", "/collections", "/wishlist"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    const saved = localStorage.getItem(CONSENT_STORAGE_KEY);
    setConsent(saved === "accepted" ? "accepted" : saved === "essential" ? "essential" : null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || consent === null) return;
    document.cookie = `${CONSENT_COOKIE}=${consent}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;

    if (consent === "accepted") {
      posthog.set_config({ autocapture: true, capture_pageview: true, capture_pageleave: true });
      posthog.opt_in_capturing();
      posthog.startSessionRecording();
      posthog.capture("$pageview", { $current_url: window.location.href });
    } else {
      posthog.stopSessionRecording();
      posthog.opt_out_capturing();
    }
  }, [consent, loaded]);

  const chooseConsent = (value: Exclude<Consent, null>) => {
    localStorage.setItem(CONSENT_STORAGE_KEY, value);
    setConsent(value);
    setSettingsOpen(false);
  };

  return <>
    {children}
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {loaded && !hideFooter && consent === null ? <aside className={styles.cookieBanner} aria-label="Cookie preferences"><div><strong>Your privacy, your choice</strong><p>Required service metrics keep VaultShuffle reliable. PostHog product analytics and session replay are optional.</p></div><div><button type="button" onClick={() => chooseConsent("essential")}>Essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow PostHog</button></div></aside> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close cookie settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="cookie-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close cookie settings">×</button><p className={styles.eyebrow}>Privacy controls</p><h2 id="cookie-title">Cookie Settings</h2><p>Essential storage remembers your session and preferences. Vercel provides required aggregate service performance metrics. PostHog product analytics and session replay are optional and stay off when you choose Essential only.</p><div className={styles.consentChoice}><span><strong>Essential and service performance</strong><small>Session, preferences, Vercel Web Analytics and Speed Insights</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>PostHog product analytics</strong><small>Usage events and session replay used to improve VaultShuffle</small></span><b>{consent === "accepted" ? "On" : "Off"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseConsent("essential")}>Use essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow PostHog analytics</button></div></section></div> : null}
    <Analytics />
    <SpeedInsights />
  </>;
}
