import Link from "next/link";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import styles from "./login.module.css";

const features = [
  ["lock", "Your password stays with Steam", "Vault Shuffle never sees or stores your password."],
  ["id", "We only receive your SteamID", "Used to sync your library, wishlist, playtime and game details."],
  ["browser", "Your session is remembered", "This browser can open the app directly next time."],
  ["shield", "Private, secure, transparent", "Your data stays under your control."]
] as const;

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <p className={styles.eyebrow}>One quick check before the vault opens</p>
        <h1 className={styles.title} id="login-title">Sign in with <span>Steam</span></h1>
        <p className={styles.copy}>We use Steam sign-in to recognise your account and keep your games in sync. Here&apos;s exactly what happens.</p>

        <div className={styles.features}>
          {features.map(([icon, title, text]) => (
            <article className={styles.feature} key={title}>
              <span className={styles.featureIcon}><LoginIcon name={icon} /></span>
              <div><h2>{title}</h2><p>{text}</p></div>
            </article>
          ))}
        </div>

        <a href="/api/auth/steam" className={styles.steamButton}>
          <span className={styles.steamIcon}><LoginIcon name="steam" /></span>
          <span className={styles.steamLabel}>Sign in with Steam</span>
          <span className={styles.steamArrow} aria-hidden="true">→</span>
        </a>
        <p className={styles.note}>Secure. Private. Built for players.</p>
        <Link href="/" className={styles.backLink}>← Back to home</Link>
      </section>
    </main>
  );
}

function LoginIcon({ name }: { name: string }) {
  return <SiteGlyph name={name} size={26} />;
}
