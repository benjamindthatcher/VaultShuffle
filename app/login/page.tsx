import Image from "next/image";
import styles from "./login.module.css";

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brandRow}>
          <Image src="/assets/brand/vaultshuffle-icon.png" alt="" width={48} height={48} />
          <div className={styles.wordmark} aria-label="Vault Shuffle">
            <span className={styles.word}>Vault</span>
            <span className={styles.accent}>Shuffle</span>
          </div>
        </div>
        <p className={styles.eyebrow}>Steam sign-in</p>
        <h1 className={styles.title}>Sign in to open the vault</h1>
        <p className={styles.copy}>
          The app shell is rebuilt and ready for the deeper auth and data wiring pass. This entry point is set up to take the real Steam flow next.
        </p>
        <a href="/api/auth/steam" className={styles.steamButton}>
          <Image src="/assets/brand/sign-in-steam.png" alt="Sign in through Steam" width={280} height={64} />
        </a>
      </section>
    </main>
  );
}
