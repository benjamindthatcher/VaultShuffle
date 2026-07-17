"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { FeedbackProvider, useFeedback } from "@/components/feedback/FeedbackProvider";
import { SiteFooter } from "@/components/site/SiteFooter";
import styles from "./SiteExperience.module.css";

type Consent = "accepted" | "essential" | null;

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
    const saved = localStorage.getItem("vault-cookie-consent");
    setConsent(saved === "accepted" ? "accepted" : saved === "essential" ? "essential" : null);
    setLoaded(true);
  }, []);

  const chooseConsent = (value: Exclude<Consent, null>) => {
    localStorage.setItem("vault-cookie-consent", value);
    setConsent(value);
    setSettingsOpen(false);
  };

  return <>
    {children}
    {!hideFooter ? <SiteFooter variant={isAppPage ? "app" : "site"} onFeedback={() => openFeedback({ source: "footer" })} onCookieSettings={() => setSettingsOpen(true)} /> : null}
    {loaded && !hideFooter && consent === null ? <aside className={styles.cookieBanner} aria-label="Cookie preferences"><div><strong>Your privacy, your choice</strong><p>VaultShuffle uses optional analytics to understand performance. Essential site functions work without them.</p></div><div><button type="button" onClick={() => chooseConsent("essential")}>Essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow analytics</button></div></aside> : null}
    {settingsOpen ? <div className={styles.consentLayer}><button className={styles.consentBackdrop} type="button" aria-label="Close cookie settings" onClick={() => setSettingsOpen(false)} /><section className={styles.consentDialog} role="dialog" aria-modal="true" aria-labelledby="cookie-title"><button className={styles.close} type="button" onClick={() => setSettingsOpen(false)} aria-label="Close cookie settings">×</button><p className={styles.eyebrow}>Privacy controls</p><h2 id="cookie-title">Cookie Settings</h2><p>Essential storage remembers your session and preferences. Optional analytics help us understand site performance without accessing your Steam library contents.</p><div className={styles.consentChoice}><span><strong>Essential</strong><small>Always active</small></span><b>Required</b></div><div className={styles.consentChoice}><span><strong>Analytics</strong><small>Vercel Web Analytics and Speed Insights</small></span><b>{consent === "accepted" ? "On" : "Off"}</b></div><div className={styles.consentActions}><button type="button" onClick={() => chooseConsent("essential")}>Use essential only</button><button type="button" onClick={() => chooseConsent("accepted")}>Allow analytics</button></div></section></div> : null}
    {consent === "accepted" ? <><Analytics /><SpeedInsights /></> : null}
  </>;
}
