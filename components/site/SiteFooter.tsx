"use client";

import Link from "next/link";
import Image from "next/image";
import styles from "./SiteExperience.module.css";

type SiteFooterProps = {
  onFeedback: () => void;
  onCookieSettings: () => void;
  variant?: "site" | "app";
};

const links = [
  { href: "/privacy", label: "Privacy", icon: "privacy" },
  { href: "/terms", label: "Terms", icon: "terms" },
  { href: "/steam-data", label: "Steam Data", icon: "steam-data" },
  { href: "/contact", label: "Contact Us", icon: "contact" }
] as const;

function FooterIcon({ name }: { name: string }) {
  return <Image className={styles.footerIcon} src={`/assets/vaultshuffle/footer-icons/${name}.svg`} width={22} height={22} alt="" aria-hidden="true" />;
}

export function SiteFooter({ onFeedback, onCookieSettings, variant = "site" }: SiteFooterProps) {
  return (
    <footer className={`${styles.footer} ${variant === "app" ? styles.footerApp : ""}`}>
      <div className={styles.footerPanel}>
        <nav aria-label="Legal and support">
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
                <span>Cookie Settings</span>
              </button>
            </li>
          </ul>
        </nav>
        <div className={styles.footerDivider} />
        <p className={styles.footerCopyright}>© 2026 VaultShuffle</p>
      </div>
    </footer>
  );
}
