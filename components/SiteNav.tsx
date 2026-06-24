import Link from "next/link";

export function SiteNav() {
  return (
    <header className="site-nav">
      <Link className="site-brand" href="/" aria-label="Vault Shuffle home">
        <img src="/assets/vault-shuffle-icon.png" alt="" />
        <span>Vault Shuffle</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/features">Features</Link>
        <Link href="/about">About</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
      <Link className="nav-cta" href="/login">
        Open App
      </Link>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>Vault Shuffle</span>
      <nav aria-label="Footer navigation">
        <Link href="/about">About</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </nav>
    </footer>
  );
}
