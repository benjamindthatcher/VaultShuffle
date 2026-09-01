"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { FeedbackProvider, useFeedback } from "@/components/feedback/FeedbackProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { CooldownProvider } from "@/components/shared/CooldownProvider";
import { SiteFooter } from "@/components/site/SiteFooter";
import {
  captureProductEvent,
  clearProductUserIdentity,
  disableProductAnalytics,
  enableProductAnalytics,
  identifyProductUser,
} from "@/lib/posthog-client";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import styles from "./SiteExperience.module.css";

type AnalyticsChoice = "enabled" | "disabled" | null;
type AnalyticsSession = {
  logged_in: boolean;
  account_type: "guest" | "steam" | "manual";
  identity_verified: boolean;
  user_id: string;
  steam_id: string;
  display_name: string;
  steam_display_name: string;
  avatar_url: string;
};
const CONSENT_STORAGE_KEY = "vault-cookie-consent";
const NOTICE_STORAGE_KEY = "vault-analytics-notice-seen";

/**
 * Opens the analytics dialog from anywhere under the shell.
 *
 * The dialog has no address of its own - it is state on SiteFrame, reachable
 * only through the footer button. That made it impossible for the privacy policy
 * to do the thing a privacy policy has to do: put the control next to the
 * sentence describing it. Same shape as useFeedback, for the same reason.
 */
const AnalyticsSettingsContext = createContext<{ openAnalyticsSettings: () => void } | null>(null);

export function useAnalyticsSettings() {
  const value = useContext(AnalyticsSettingsContext);
  if (!value) throw new Error("useAnalyticsSettings must be used inside SiteExperience.");
  return value;
}

export function SiteExperience({ children }: { children: ReactNode }) {
  return (
    <CooldownProvider>
      <FeedbackProvider><SiteFrame>{children}</SiteFrame></FeedbackProvider>
    </CooldownProvider>
  );
}

async function syncProductAnalyticsIdentity() {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) {
      clearProductUserIdentity();
      return;
    }

    const session = await response.json() as AnalyticsSession;
    if (session.logged_in && session.account_type !== "guest" && session.user_id && session.steam_id) {
      identifyProductUser({
        userId: session.user_id,
        steamId: session.steam_id,
        accountType: session.account_type,
        identityVerified: session.identity_verified,
        displayName: session.display_name,
        steamDisplayName: session.steam_display_name,
        avatarUrl: session.avatar_url,
      });
      return;
    }

    clearProductUserIdentity();
  } catch {
    // Avoid retaining a stale signed-in identity if the session check fails.
    clearProductUserIdentity();
  }
}

function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { openFeedback } = useFeedback();
  const [analyticsChoice, setAnalyticsChoice] = useState<AnalyticsChoice>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [noticeSeen, setNoticeSeen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const consentBannerRef = useRef<HTMLDivElement>(null);
  const hideFooter = pathname.startsWith("/auth") || pathname.startsWith("/setup/");
  const isAppPage = ["/vault", "/library", "/collections"].some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    const saved = localStorage.getItem(CONSENT_STORAGE_KEY);
    // Opt-out: analytics run unless turned off. "essential" is the legacy decline.
    const choice: AnalyticsChoice = saved === "disabled" || saved === "essential" ? "disabled" : "enabled";
    if (saved !== choice) localStorage.setItem(CONSENT_STORAGE_KEY, choice);
    setAnalyticsChoice(choice);
    setNoticeSeen(localStorage.getItem(NOTICE_STORAGE_KEY) === "1");
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || analyticsChoice === null) return;
    if (analyticsChoice === "enabled") {
      void enableProductAnalytics().then(() => syncProductAnalyticsIdentity());
    } else {
      disableProductAnalytics();
    }
  }, [analyticsChoice, loaded]);

  useEffect(() => {
    if (!loaded || analyticsChoice !== "enabled") return;
    void enableProductAnalytics().then(() => {
      captureProductEvent("$pageview", { $current_url: window.location.href });
    });
  }, [analyticsChoice, loaded, pathname]);

  useEffect(() => {
    const banner = consentBannerRef.current;
    const root = document.documentElement;
    if (!banner) {
      root.style.removeProperty("--vault-bottom-notice-offset");
      return;
    }

    const updateOffset = () => {
      root.style.setProperty("--vault-bottom-notice-offset", `${Math.ceil(banner.getBoundingClientRect().height) + 12}px`);
    };
    updateOffset();
    const observer = new ResizeObserver(updateOffset);
    observer.observe(banner);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--vault-bottom-notice-offset");
    };
  }, [loaded, noticeSeen, settingsOpen]);

  const dismissNotice = () => {
    localStorage.setItem(NOTICE_STORAGE_KEY, "1");
    setNoticeSeen(true);
  };

  const chooseAnalytics = (value: Exclude<AnalyticsChoice, null>) => {
    localStorage.setItem(NOTICE_STORAGE_KEY, "1");
    setNoticeSeen(true);
    localStorage.setItem(CONSENT_STORAGE_KEY, value);
    setAnalyticsChoice(value);
    setSettingsOpen(false);
    // A turn-off must be reported before the client stops, or it is never seen.
    trackEvent(ANALYTICS_EVENTS.analyticsConsentChosen, { choice: value, surface: noticeSeen ? "settings" : "banner" });
  };

  return <>
    <AnalyticsSettingsContext.Provider value={{ openAnalyticsSettings: () => setSettingsOpen(true) }}>
      {children}
    </AnalyticsSettingsContext.Provider>
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {loaded && !noticeSeen && !settingsOpen ? <div ref={consentBannerRef} className={styles.consentBanner} role="region" aria-label="Analytics notice"><div className={styles.consentBannerCopy}><strong>VaultShuffle measures how the app gets used</strong><p>Usage analytics and session replay are on. They link to your VaultShuffle profile once you connect a library, and form inputs are masked. <Link href="/privacy">Privacy Policy</Link></p></div><div className={styles.consentBannerActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Turn analytics off</button><button className={styles.primaryConsent} type="button" onClick={dismissNotice}>Got it</button></div></div> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close analytics settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="analytics-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close analytics settings"><VaultIcon name="close" size={19} /></button><p className={styles.eyebrow}>Privacy controls</p><h2 id="analytics-title">Analytics Settings</h2><p>VaultShuffle uses product analytics to understand how the product is used and improve it. They are on by default and you can turn them off at any time.</p><div className={styles.consentChoice}><span><strong>Essential and service performance</strong><small>Session, preferences, Vercel Web Analytics and Speed Insights</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>PostHog product analytics</strong><small>Usage events, heatmaps, error/performance data and session replay. Connected analytics are linked to your internal VaultShuffle profile; form and input values are masked in replay.</small></span><b>{analyticsChoice === "disabled" ? "Off" : "On"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Turn analytics off</button><button className={styles.primaryConsent} type="button" onClick={() => chooseAnalytics("enabled")}>Enable analytics</button></div></section></div> : null}
    <Analytics />
    <SpeedInsights />
  </>;
}
