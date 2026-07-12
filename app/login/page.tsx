import Link from "next/link";
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
  const paths: Record<string, React.ReactNode> = {
    lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    id: <><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="8" cy="11" r="2" /><path d="M13 10h5M13 14h4" /></>,
    browser: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.3 2.8 8.2 7 10 4.2-1.8 7-5.7 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></>,
    steam: <><circle cx="12" cy="12" r="9" /><circle cx="15.8" cy="8.2" r="2.5" /><circle cx="8.3" cy="15.6" r="2.2" /><path d="m10.1 14.4 3.7-4.3M6.2 14.7l2.2 1.1" /></>
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
