"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { FeedbackProvider, useFeedback } from "@/components/feedback/FeedbackProvider";
import { SiteFooter } from "@/components/site/SiteFooter";
import styles from "./SiteExperience.module.css";

<<<<<<< Updated upstream
type Consent = "accepted" | "essential" | null;
=======
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
>>>>>>> Stashed changes

export function SiteExperience({ children }: { children: ReactNode }) {
  return <FeedbackProvider><SiteFrame>{children}</SiteFrame></FeedbackProvider>;
}

function SiteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { openFeedback } = useFeedback();
  const [consent, setConsent] = useState<Consent>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
<<<<<<< Updated upstream
  const hideFooter = pathname.startsWith("/login") || pathname.startsWith("/auth");
  const isAppPage = ["/vault", "/library", "/purge", "/collections", "/wishlist"].some(
=======
  const [session, setSession] = useState<AnalyticsSession | null>(null);
  const consentBannerRef = useRef<HTMLDivElement>(null);
  const hideFooter = pathname.startsWith("/auth") || pathname.startsWith("/setup/");
  const isAppPage = ["/dashboard", "/vault", "/library", "/collections"].some(
>>>>>>> Stashed changes
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  useEffect(() => {
    const saved = localStorage.getItem("vault-cookie-consent");
    setConsent(saved === "accepted" ? "accepted" : saved === "essential" ? "essential" : null);
    setLoaded(true);
  }, []);

<<<<<<< Updated upstream
  const chooseConsent = (value: Exclude<Consent, null>) => {
    localStorage.setItem("vault-cookie-consent", value);
    setConsent(value);
=======
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
    if (!loaded) return;
    let cancelled = false;
    void loadAnalyticsSession()
      .then((resolved) => {
        if (!cancelled) setSession(resolved);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loaded]);

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
>>>>>>> Stashed changes
    setSettingsOpen(false);
  };

  return <>
<<<<<<< Updated upstream
    {children}
=======
    <AnalyticsSettingsContext.Provider value={{ openAnalyticsSettings: () => setSettingsOpen(true) }}>
      <SiteSessionContext.Provider value={session}>{children}</SiteSessionContext.Provider>
    </AnalyticsSettingsContext.Provider>
>>>>>>> Stashed changes
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {loaded && !hideFooter && consent === null ? <aside className={styles.cookieBanner} aria-label="Cookie preferences"><div><strong>Your privacy, your choice</strong><p>VaultShuffle uses optional analytics to understand performance. Essential site functions work without them.</p></div><div><button type="button" onClick={() => chooseConsent("essential")}>Essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow analytics</button></div></aside> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close cookie settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="cookie-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close cookie settings">×</button><p className={styles.eyebrow}>Privacy controls</p><h2 id="cookie-title">Cookie Settings</h2><p>Essential storage remembers your session and preferences. Optional analytics help us understand site performance without accessing your Steam library contents.</p><div className={styles.consentChoice}><span><strong>Essential</strong><small>Always active</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>Analytics</strong><small>Vercel Web Analytics and Speed Insights</small></span><b>{consent === "accepted" ? "On" : "Off"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseConsent("essential")}>Use essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow analytics</button></div></section></div> : null}
    {consent === "accepted" ? <><Analytics /><SpeedInsights /></> : null}
  </>;
}
