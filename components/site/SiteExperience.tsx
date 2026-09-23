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
import { blogPageProperties } from "@/lib/blog-analytics";
import { awaitSession, hasSessionProvider } from "@/lib/analytics-session";
import type { SessionPayload } from "@/lib/types";
import styles from "./SiteExperience.module.css";

type AnalyticsChoice = "enabled" | "disabled" | null;
type AnalyticsSession = SessionPayload;
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

/**
 * The session, for anything under the shell that needs to know who is here.
 *
 * SiteFrame already resolves one per page to identify the PostHog user, so the
 * public information pages read it from here rather than asking again. That is
 * the whole reason this is a context and not another fetch: these pages are
 * static, served from the CDN, and almost all of their traffic is anonymous -
 * reading a cookie on the server would make every one of those visits a
 * function invocation to render a nav that only a signed-in visitor sees.
 *
 * `null` means not resolved yet, which is not the same as signed out. Anything
 * reading this must render the signed-out state until it knows better, and must
 * not move the page around when the answer arrives.
 */
const SiteSessionContext = createContext<AnalyticsSession | null>(null);

export function useSiteSession() {
  return useContext(SiteSessionContext);
}

/** Steam sign-in or a public-profile import. Guest mode is neither. */
export function isSignedInAccount(session: AnalyticsSession | null): boolean {
  return Boolean(session?.logged_in) && session?.account_type !== "guest";
}

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

/**
 * The session this needs is the same getSessionPayload() the app shell has
 * already asked for, so on a product page it is taken from there rather than
 * fetched again. On a marketing page nothing announces a shell and this falls
 * back to its own request, exactly as before.
 */
async function loadAnalyticsSession(useAppProvider = true): Promise<AnalyticsSession | null> {
  if (useAppProvider && hasSessionProvider()) {
    const shared = await awaitSession();
    if (shared) return shared;
    // The bootstrap failed or never resolved. Identity is worth one request of
    // its own rather than leaving a signed-in person anonymous for the session.
  }

  const response = await fetch("/api/session", { cache: "no-store" });
  if (!response.ok) return null;
  return await response.json() as AnalyticsSession;
}

async function syncProductAnalyticsIdentity() {
  try {
    const session = await loadAnalyticsSession();
    if (!session) {
      clearProductUserIdentity();
      return;
    }

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
  const [session, setSession] = useState<AnalyticsSession | null>(null);
  const consentBannerRef = useRef<HTMLDivElement>(null);
  const hideFooter = pathname.startsWith("/auth") || pathname.startsWith("/setup/");
  const isAppPage = ["/dashboard", "/vault", "/library", "/collections"].some(
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

  /**
   * One session per page, whatever the analytics setting. It was already being
   * fetched for identity on the default path, so for most visitors this is the
   * same single request it always was; turning analytics off now costs that one
   * request rather than leaving the nav unable to appear.
   */
  useEffect(() => {
    // A product bootstrap can fail before it publishes its session. Retry on
    // the next route instead of leaving every information page in guest mode.
    if (!loaded || session) return;
    let cancelled = false;
    void loadAnalyticsSession(isAppPage)
      .then((resolved) => {
        if (!cancelled) setSession(resolved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAppPage, loaded, pathname, session]);

  useEffect(() => {
    if (!loaded || analyticsChoice !== "enabled") return;
    let cancelled = false;
    const url = window.location.href;
    void enableProductAnalytics().then(() => {
      if (!cancelled) {
        captureProductEvent("$pageview", { $current_url: url, ...blogPageProperties(pathname) });
      }
    });
    return () => { cancelled = true; };
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
  };

  return <>
    <AnalyticsSettingsContext.Provider value={{ openAnalyticsSettings: () => setSettingsOpen(true) }}>
      <SiteSessionContext.Provider value={session}>{children}</SiteSessionContext.Provider>
    </AnalyticsSettingsContext.Provider>
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {loaded && !noticeSeen && !settingsOpen ? <div ref={consentBannerRef} className={styles.consentBanner} role="region" aria-label="Analytics notice"><div className={styles.consentBannerCopy}><strong>About analytics</strong><p>Product analytics and session replay are enabled by default. They can link to your profile when you connect a library. Replay masks input values but may record visible page content. <Link href="/privacy">Privacy Policy</Link></p></div><div className={styles.consentBannerActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Turn analytics off</button><button className={styles.primaryConsent} type="button" onClick={dismissNotice}>Got it</button></div></div> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close analytics settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="analytics-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close analytics settings"><VaultIcon name="close" size={19} /></button><p className={styles.eyebrow}>Privacy controls</p><h2 id="analytics-title">Analytics Settings</h2><p>Product analytics help us understand usage and investigate issues. They are enabled by default. You can turn PostHog analytics and session replay off here.</p><div className={styles.consentChoice}><span><strong>Session and site services</strong><small>Session storage, saved preferences, Vercel Web Analytics and Speed Insights. These are not changed by the PostHog setting.</small></span><b>Always on</b></div><div className={styles.consentChoice}><span><strong>PostHog product analytics</strong><small>Selected usage events, errors and session replay. When you connect a library, analytics can include your VaultShuffle and public Steam profile details. Replay masks input values but may record visible page content.</small></span><b>{analyticsChoice === "disabled" ? "Off" : "On"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseAnalytics("disabled")}>Turn analytics off</button><button className={styles.primaryConsent} type="button" onClick={() => chooseAnalytics("enabled")}>Enable analytics</button></div></section></div> : null}
    <Analytics />
    <SpeedInsights />
  </>;
}
