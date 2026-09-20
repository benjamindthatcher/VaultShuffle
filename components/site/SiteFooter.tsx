"use client";

import Link from "next/link";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./SiteExperience.module.css";

type SiteFooterProps = {
  onFeedback: () => void;
  onCookieSettings: () => void;
  variant?: "site" | "app";
};

type FooterItem =
  | { kind: "link"; href: string; label: string; icon: VaultIconName }
  | { kind: "action"; action: "feedback" | "cookies"; label: string; icon: VaultIconName };

/**
 * Three rows of three, and each row is one kind of destination.
 *
 * The rows are the point. The grid fills row-major, so this nesting *is* the
 * layout: what there is to read, then the documents that say what we do with
 * your data, then the ways to get in touch or change something. A reader
 * scanning a column of nine unrelated words has to read all nine; three groups
 * of three can be skipped by group.
 *
 * Which also means a tenth destination is not an append. It needs a row, and
 * if it does not belong in one of these three then the grid is the wrong shape
 * for it - four rows of three beats three rows of three plus an orphan, which
 * is exactly what a ninth link did to the previous eight-across row.
 */
const FOOTER_ROWS: readonly (readonly FooterItem[])[] = [
  // Read: the pages someone browses to understand the product.
  [
    { kind: "link", href: "/blog", label: "Blog", icon: "narrative" },
    { kind: "link", href: "/faq", label: "FAQ", icon: "details" },
    { kind: "link", href: "/releases", label: "Releases", icon: "new" }
  ],
  // Disclosure: what we collect, what we promise, what Steam gives us.
  [
    { kind: "link", href: "/privacy", label: "Privacy", icon: "privacy" },
    { kind: "link", href: "/terms", label: "Terms", icon: "terms" },
    { kind: "link", href: "/steam-data", label: "Steam Data", icon: "steam-data" }
  ],
  // Act: the three things a reader can actually do from down here.
  [
    { kind: "link", href: "/contact", label: "Contact Us", icon: "contact" },
    { kind: "action", action: "feedback", label: "Feedback", icon: "feedback" },
    { kind: "action", action: "cookies", label: "Analytics Settings", icon: "cookies" }
  ]
];

function FooterIcon({ name }: { name: VaultIconName }) {
  return <VaultIcon className={styles.footerIcon} name={name} size={22} />;
}

export function SiteFooter({ onFeedback, onCookieSettings, variant = "site" }: SiteFooterProps) {
  const handlers = { feedback: onFeedback, cookies: onCookieSettings } as const;

  return (
    <footer className={`${styles.footer} ${variant === "app" ? styles.footerApp : ""}`}>
      <div className={styles.footerPanel}>
        <nav aria-label="About, legal and support">
          <ul className={styles.footerLinks}>
            {FOOTER_ROWS.flat().map((item) => (
              <li key={item.kind === "link" ? item.href : item.action}>
                {item.kind === "link" ? (
                  <Link className={styles.footerLink} href={item.href}>
                    <FooterIcon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                ) : (
                  <button
                    className={styles.footerLink}
                    type="button"
                    onClick={handlers[item.action]}
                  >
                    <FooterIcon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                )}
              </li>
            ))}
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
