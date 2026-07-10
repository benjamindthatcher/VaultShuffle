import Image from "next/image";
import Link from "next/link";
import styles from "./home.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.brandRow}>
          <Image src="/assets/brand/vaultshuffle-icon.png" alt="" width={56} height={56} className={styles.icon} />
          <div className={styles.wordmark} aria-label="Vault Shuffle">
            <span className={styles.word}>Vault</span>
            <span className={styles.accent}>Shuffle</span>
          </div>
        </div>

        <div className={styles.copy}>
          <p className={styles.eyebrow}>Steam backlog picker</p>
          <h1 className={styles.title}>A cleaner VaultShuffle app is taking shape.</h1>
          <p className={styles.description}>
            This scratch rebuild focuses on the authenticated experience first: Vault, Library, Collections, and Wishlist, all rebuilt with a cleaner mobile-first shell.
          </p>
        </div>

        <div className={styles.actions}>
          <Link href="/app/vault" className={styles.primaryAction}>
            Open the app
          </Link>
          <Link href="/login" className={styles.secondaryAction}>
            Steam sign-in
          </Link>
        </div>
      </section>
    </main>
  );
}
