"use client";

import Link from "next/link";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./SiteExperience.module.css";

type SiteFooterProps = {
  onFeedback: () => void;
  onCookieSettings: () => void;
  variant?: "site" | "app";
};

const links = [
  { href: "/releases", label: "Releases", icon: "new" },
  { href: "/faq", label: "FAQ", icon: "details" },
  { href: "/privacy", label: "Privacy", icon: "privacy" },
  { href: "/terms", label: "Terms", icon: "terms" },
  { href: "/steam-data", label: "Steam Data", icon: "steam-data" },
  { href: "/contact", label: "Contact Us", icon: "contact" }
] as const;

function FooterIcon({ name }: { name: VaultIconName }) {
  return <VaultIcon className={styles.footerIcon} name={name} size={22} />;
}

export function SiteFooter({ onFeedback, onCookieSettings, variant = "site" }: SiteFooterProps) {
  return (
    <footer className={`${styles.footer} ${variant === "app" ? styles.footerApp : ""}`}>
      <div className={styles.footerPanel}>
        <nav aria-label="About, legal and support">
          <ul className={styles.footerLinks}>
            {links.map((link) => (
              <li key={link.href}>
                <Link className={styles.footerLink} href={link.href}>
                  <FooterIcon name={link.icon} />
                  <span>{link.label}</span>
                </Link>
              </li>
            ))}
            <li>
              <button className={styles.footerLink} type="button" onClick={onFeedback}>
                <FooterIcon name="feedback" />
                <span>Feedback</span>
              </button>
            </li>
            <li>
              <button className={styles.footerLink} type="button" onClick={onCookieSettings}>
                <FooterIcon name="cookies" />
                <span>Analytics Settings</span>
              </button>
            </li>
          </ul>
        </nav>
        <nav className={styles.socialNav} aria-label="Follow and support VaultShuffle">
          <a
            className={styles.xLink}
            href="https://x.com/Vault_Shuffle"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow @Vault_Shuffle on X"
            title="Follow @Vault_Shuffle on X"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z" />
            </svg>
          </a>
          <a className={styles.coffeeButton} href="https://buymeacoffee.com/vaultshuffle" target="_blank" rel="noopener noreferrer">
            <span className={styles.coffeeEmoji} aria-hidden="true">☕</span>
            <span>Buy me a coffee</span>
          </a>
        </nav>
        <div className={styles.footerDivider} />
        <p className={styles.footerCopyright}>© 2026 VaultShuffle</p>
      </div>
    </footer>
  );
}
