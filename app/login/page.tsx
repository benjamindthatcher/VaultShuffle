import { SiteNav } from "@/components/SiteNav";

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;

  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <SiteNav />
      <div className="login-page">
        <main className="login-shell">
          <section className="login-card">
            <p className="login-kicker">One quick check before the vault opens</p>
            <h1>Sign in with Steam, then get straight to choosing.</h1>
            <p>
              Vault Shuffle uses Steam sign-in to recognise your account. Once you are in, this browser remembers you and
              opens the app directly next time.
            </p>
            {error ? <p className="login-error">{error}</p> : null}
            <div className="login-actions">
              <a className="steam-login-button" href="/api/auth/steam" aria-label="Sign in through Steam">
                <img src="/assets/signinthroughsteam.png" alt="Sign in through Steam" />
              </a>
            </div>
            <p className="login-note">Steam confirms your SteamID64 through OpenID. Your password stays with Steam.</p>
          </section>
        </main>
      </div>
    </>
  );
}
