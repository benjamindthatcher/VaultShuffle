export function SiteNav() {
  return (
    <header className="site-nav">
      <a className="site-brand" href="/" aria-label="Vault Shuffle home">
        <img src="/assets/vault-shuffle-icon.png" alt="" />
        <span>Vault Shuffle</span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="/features">Features</a>
        <a href="/about">About</a>
        <a href="/privacy">Privacy</a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>Vault Shuffle</span>
      <nav aria-label="Footer navigation">
        <a href="/about">About</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
    </footer>
  );
}
