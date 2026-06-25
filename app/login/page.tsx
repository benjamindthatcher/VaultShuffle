import Link from "next/link";

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <div className="login-page">
        <main className="login-shell">
          <section className="login-card">
            <Link className="site-brand login-brand" href="/" aria-label="Vault Shuffle home">
              <img src="/assets/vault-shuffle-icon.png" alt="" />
              <span>Vault Shuffle</span>
            </Link>
            <p className="login-kicker">One quick check before the vault opens</p>
            <h1>Sign in with Steam, then get straight to choosing.</h1>
            <p>
              Vault Shuffle uses Steam sign-in to recognise your account. Once you are in, this browser remembers you and
              opens the app directly next time.
            </p>
            {error ? <p className="login-error">{error}</p> : null}
            <a className="steam-login-button" href="/api/auth/steam" aria-label="Sign in through Steam">
              <img src="/assets/signinthroughsteam.png" alt="Sign in through Steam" />
            </a>
            <Link className="look-around-link" href="/app">
              Or look around for now
            </Link>
            <p className="login-note">Steam confirms your SteamID64 through OpenID. Your password stays with Steam.</p>
          </section>

          <section className="login-preview" aria-label="Vault Shuffle preview">
            <div className="mini-window">
              <div className="mini-top">
                <span />
                <span />
                <span />
                <b>Ready after sign-in</b>
              </div>
              <div className="mini-body">
                <div className="mini-rail" />
                <div className="mini-list">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="mini-side" />
              </div>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
